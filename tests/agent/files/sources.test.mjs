// Tests for agent/files/sources.mjs: what a source is, and fetching each kind into an inbox: chat
// uploads and Cloud Storage objects (against the Cloud Storage fake), links (a fake fetch), git
// repositories (a fake runner) and Drive files (a fake Drive client).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { start as startStorage } from '../../fakes/gcs-server.mjs';
import { DriveError, FOLDER_MIME, GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import {
  classifySource, createFetcher, isGitUrl, nameFromDisposition, nameFromUrl, redactUrl, SourceError,
} from '../../../agent/files/sources.mjs';
import { fakeRunner, officeBytes, PDF_BYTES, scratch } from './helpers.mjs';

const BUCKET = 'your-gcp-project-paraclete';
const dir = scratch('sources-test-');
let storage;
before(async () => { storage = await startStorage({ bucket: BUCKET }); });
after(async () => { await storage.stop(); dir.cleanup(); });

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MB = 1024 * 1024;

async function put(name, bytes, contentType = 'application/octet-stream') {
  const res = await fetch(`${storage.origin}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': contentType }, body: bytes,
  });
  assert.equal(res.status, 200);
}

function fetcher(overrides = {}) {
  return createFetcher({
    bucket: BUCKET, prefix: 'files/', maxBytes: 1 * MB, uploadMaxBytes: 2 * MB, timeoutSeconds: 5,
    getAccessToken: async () => 'tok', fetch: globalThis.fetch, storageHost: storage.origin, runner: fakeRunner(), ...overrides,
  });
}

test('sources are recognized: uploads, gs:// objects, links, git repositories, Drive', () => {
  const o = { bucket: BUCKET, prefix: 'files/' };
  assert.deepEqual(classifySource('files/in/u-1760000000000-1a2b3c4d/q3.xlsx', o), { kind: 'upload', bucket: BUCKET, object: 'files/in/u-1760000000000-1a2b3c4d/q3.xlsx' });
  assert.deepEqual(classifySource(`gs://${BUCKET}/files/in/u-1-aaaaaaaa/a.pdf`, o).kind, 'upload');
  assert.deepEqual(classifySource('u-1760000000000-1a2b3c4d', o), { kind: 'upload', bucket: BUCKET, uploadId: 'u-1760000000000-1a2b3c4d' });
  assert.deepEqual(classifySource('gs://other-bucket/data/x.csv', o), { kind: 'gcs', bucket: 'other-bucket', object: 'data/x.csv' });
  assert.deepEqual(classifySource(`gs://${BUCKET}/files/out/w-1/r.md`, o).kind, 'gcs');
  assert.equal(classifySource('https://example.com/report.pdf', o).kind, 'http');
  assert.equal(classifySource('https://github.com/your-org/paraclete', o).kind, 'git');
  assert.equal(classifySource('https://example.com/team/repo.git', o).kind, 'git');
  assert.equal(classifySource('git@example.com:team/repo.git', o).kind, 'git');
  assert.deepEqual(classifySource('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit', o), { kind: 'drive', fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345' });
  assert.equal(classifySource('1AbCdEfGhIjKlMnOpQrStUvWxYz012345', o).kind, 'drive');
  assert.equal(classifySource('https://github.com/your-org/paraclete', { ...o, kind: 'http' }).kind, 'http', '--kind overrides the guess');
  assert.throws(() => classifySource('report.pdf', o), (err) => err instanceof SourceError && /not a source file-get knows/.test(err.message));
  assert.throws(() => classifySource('https://example.com/x', { ...o, kind: 'gcs' }), /not a gcs source/);
  assert.throws(() => classifySource('', o), /empty/);
});

test('names come from Content-Disposition, else the URL; credentials in a URL are never shown', () => {
  assert.equal(nameFromDisposition('attachment; filename="Q3 report.pdf"'), 'Q3 report.pdf');
  assert.equal(nameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.docx; filename=\"resume.docx\""), 'résumé.docx');
  assert.equal(nameFromDisposition('inline'), null);
  assert.equal(nameFromUrl('https://example.com/a/b/Annual%20Plan.xlsx?x=1'), 'Annual Plan.xlsx');
  assert.equal(nameFromUrl('https://example.com/'), null);
  assert.equal(redactUrl('https://user:secret@example.com/x.git'), 'https://example.com/x.git');
  assert.equal(isGitUrl('https://github.com/your-org/paraclete/blob/main/README.md'), false);
});

test('a chat upload and a gs:// object land in the inbox with their checksum and type', async () => {
  const inbox = join(dir.root, 'm1', 'inbox');
  await put('files/in/u-1760000000000-1a2b3c4d/Q3 report.pdf', PDF_BYTES, 'application/pdf');
  const record = await fetcher().fetchInto('files/in/u-1760000000000-1a2b3c4d/Q3 report.pdf', inbox);
  assert.deepEqual(record, {
    path: join(inbox, 'Q3 report.pdf'), name: 'Q3 report.pdf', type: 'pdf', size: PDF_BYTES.length, sha256: sha(PDF_BYTES),
    source: `gs://${BUCKET}/files/in/u-1760000000000-1a2b3c4d/Q3 report.pdf`,
  });
  assert.deepEqual(readFileSync(record.path), PDF_BYTES);
  assert.equal(storage.requests.at(-1).token, 'tok');

  const byId = await fetcher().fetchInto('u-1760000000000-1a2b3c4d', inbox);
  assert.equal(byId.path, record.path, 'the same bytes under the same name are reused');
  assert.deepEqual(readdirSync(inbox), ['Q3 report.pdf']);

  await put('data/sheet.xlsx', officeBytes('xlsx'));
  const other = await fetcher().fetchInto(`gs://${BUCKET}/data/sheet.xlsx`, inbox, { name: 'renamed.xlsx' });
  assert.deepEqual([other.name, other.type], ['renamed.xlsx', 'xlsx']);
});

test('Cloud Storage failures say what to do; objects over the cap are refused before download', async () => {
  const inbox = join(dir.root, 'm2', 'inbox');
  await assert.rejects(fetcher().fetchInto(`gs://${BUCKET}/nope.pdf`, inbox), /gs:\/\/your-gcp-project-paraclete\/nope\.pdf does not exist/);
  await assert.rejects(fetcher().fetchInto('u-1-deadbeef', inbox), /there is no upload u-1-deadbeef/);
  await put('big.bin', Buffer.alloc(1.5 * MB));
  await assert.rejects(fetcher().fetchInto(`gs://${BUCKET}/big.bin`, inbox), /is 2 MB, more than the 1 MB file-get downloads/);
  const denied = async () => new Response('{}', { status: 403 });
  await assert.rejects(fetcher({ fetch: denied }).fetchInto('gs://other/x.pdf', inbox), /may not read gs:\/\/other\/x\.pdf: its service account needs the Storage Object Viewer role/);
  assert.equal(existsSync(inbox) ? readdirSync(inbox).length : 0, 0, 'nothing left behind');
});

test('a link is fetched with redirects followed, named from the server, capped while streaming', async () => {
  const inbox = join(dir.root, 'm3', 'inbox');
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('report')) {
      const res = new Response(PDF_BYTES, { status: 200, headers: { 'content-disposition': 'attachment; filename="Board pack.pdf"' } });
      return res;
    }
    if (url.includes('export')) {
      const res = new Response('a,b\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } });
      Object.defineProperty(res, 'url', { value: 'https://cdn.example.com/files/download' });
      return res;
    }
    if (url.includes('huge')) return new Response('x', { status: 200, headers: { 'content-length': String(5 * MB) } });
    if (url.includes('stream')) {
      return new Response(new ReadableStream({ start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(512 * 1024)); c.close(); } }), { status: 200 });
    }
    return new Response('gone', { status: 404 });
  };
  const f = fetcher({ fetch: fakeFetch });
  const pdf = await f.fetchInto('https://user:pw@example.com/report?id=7', inbox);
  assert.deepEqual([pdf.name, pdf.type, pdf.source], ['Board pack.pdf', 'pdf', 'https://example.com/report?id=7']);
  assert.equal(calls[0].init.redirect, 'follow');
  const csv = await f.fetchInto('https://example.com/export', inbox);
  assert.deepEqual([csv.name, csv.type, csv.final_url], ['download.csv', 'csv', 'https://cdn.example.com/files/download']);

  await assert.rejects(f.fetchInto('https://example.com/huge.zip', inbox), /is 5 MB, more than the 1 MB file-get downloads \(files.fetch_max_mb\)/);
  await assert.rejects(f.fetchInto('https://example.com/stream.bin', inbox), /larger than 1 MB/);
  await assert.rejects(f.fetchInto('https://example.com/missing.pdf', inbox), /HTTP 404 for https:\/\/example\.com\/missing\.pdf/);
  await assert.rejects(f.fetchInto('http://metadata.google.internal/computeMetadata/v1/', inbox), /metadata server/);
  assert.deepEqual(readdirSync(inbox).sort(), ['Board pack.pdf', 'download.csv'], 'no partial files');

  const changed = fetcher({ fetch: async () => new Response('a,b\n3,4\n', { status: 200, headers: { 'content-disposition': 'attachment; filename=download.csv' } }) });
  const second = await changed.fetchInto('https://example.com/export', inbox);
  assert.equal(second.name, 'download-2.csv', 'different bytes under a taken name get a new name');
});

test('a git repository is cloned shallow; a token reaches git only through its environment', async () => {
  const inbox = dir.dir('m4/inbox');
  const runner = fakeRunner({
    git: (args) => (args[0] === 'clone' ? (args.at(-2).includes('broken') ? { code: 128, stderr: `fatal: repository '${args.at(-2)}' not found` } : {}) : { stdout: 'abc123\n' }),
  });
  const f = fetcher({ runner });
  const repo = await f.fetchInto('https://github.com/your-org/paraclete', inbox, { branch: 'v1' });
  assert.deepEqual(repo, { path: join(inbox, 'paraclete'), name: 'paraclete', type: 'git-repo', size: null, sha256: null, source: 'https://github.com/your-org/paraclete', commit: 'abc123' });
  const clone = runner.calls[0];
  assert.deepEqual(clone.args, ['clone', '--depth', '1', '--branch', 'v1', '--', 'https://github.com/your-org/paraclete', join(inbox, 'paraclete')]);
  assert.equal(clone.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(clone.opts.env.PARACLETE_GIT_TOKEN, undefined);

  await f.fetchInto('https://example.com/team/private.git', inbox, { gitToken: 'tkn-secret' });
  const env = runner.calls.at(-2).opts.env;
  assert.equal(env.PARACLETE_GIT_TOKEN, 'tkn-secret');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.ok(!runner.calls.at(-2).args.join(' ').includes('tkn-secret'), 'never on the command line');

  await assert.rejects(f.fetchInto('https://x:pw@example.com/broken.git', inbox), (err) => /cloning https:\/\/example\.com\/broken\.git failed/.test(err.message) && !err.message.includes('pw@') && /--token-secret/.test(err.message));
  await assert.rejects(f.fetchInto('https://example.com/a.pdf', inbox, { branch: 'main' }), /--branch applies to a git repository/);
});

test('a Drive file: Google files exported (docx, xlsx, pptx by default), stored files downloaded, folders refused', async () => {
  const inbox = join(dir.root, 'm5', 'inbox');
  const files = {
    docid0000000000000000000: { id: 'docid0000000000000000000', name: 'Plan', mimeType: GOOGLE_TYPES.document, webViewLink: 'https://docs.google.com/document/d/docid0000000000000000000/edit' },
    folder000000000000000000: { id: 'folder000000000000000000', name: 'Team', mimeType: FOLDER_MIME },
    pdfid0000000000000000000: { id: 'pdfid0000000000000000000', name: 'scan.pdf', mimeType: 'application/pdf', size: PDF_BYTES.length },
  };
  const exports = [];
  const drive = {
    getMeta: async (id) => {
      if (!files[id]) throw new DriveError('File nope was not found, or is not shared with paraclete-agent@your-gcp-project.iam.gserviceaccount.com.', { kind: 'not_found' });
      return files[id];
    },
    export: async (id, mime) => { exports.push(mime); return officeBytes('docx'); },
    download: async (id) => ({ bytes: PDF_BYTES, name: files[id].name, mimeType: 'application/pdf' }),
  };
  const f = fetcher({ drive });
  const doc = await f.fetchInto('https://docs.google.com/document/d/docid0000000000000000000/edit', inbox);
  assert.deepEqual([doc.name, doc.type, doc.source], ['Plan.docx', 'docx', 'https://docs.google.com/document/d/docid0000000000000000000/edit']);
  assert.equal(exports[0], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await f.fetchInto('docid0000000000000000000', inbox, { exportFormat: 'pdf' });
  assert.equal(exports[1], 'application/pdf');
  await assert.rejects(f.fetchInto('docid0000000000000000000', inbox, { exportFormat: 'xlsx' }), /exports as docx, pdf, md, txt, not xlsx/);

  const pdf = await f.fetchInto('pdfid0000000000000000000', inbox);
  assert.deepEqual([pdf.name, pdf.type], ['scan.pdf', 'pdf']);
  await assert.rejects(f.fetchInto('pdfid0000000000000000000', inbox, { exportFormat: 'pdf' }), /--export applies to Google Docs/);
  await assert.rejects(f.fetchInto('folder000000000000000000', inbox), /is a Drive folder: list it with `drive-find --folder folder000000000000000000`/);
  await assert.rejects(f.fetchInto('missing00000000000000000', inbox), (err) => err instanceof SourceError && /not shared with paraclete-agent@/.test(err.message));
  await assert.rejects(fetcher().fetchInto('docid0000000000000000000', inbox), /Drive is not reachable/);
});
