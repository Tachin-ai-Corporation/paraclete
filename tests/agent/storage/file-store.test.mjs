// Tests for agent/storage/file-store.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  contentTypeFor,
  createFileStore,
  incomingObjectName,
  isCredentialPath,
  outgoingObjectName,
  sanitizeFileName,
  ShareRefused,
} from '../../../agent/storage/file-store.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'file-store-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function file(relativePath, content = 'data') {
  const path = join(scratch, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Fakes the Cloud Storage upload endpoint; `fail` names the objects whose upload is refused. */
function fakeBucket({ fail = [] } = {}) {
  const uploads = [];
  const fetch = async (url, init) => {
    const name = new URL(url).searchParams.get('name');
    if (fail.some((f) => name.endsWith(f))) {
      return { ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) };
    }
    uploads.push({ url, name, init });
    return { ok: true, status: 200, json: async () => ({ name }), text: async () => '' };
  };
  return { fetch, uploads };
}

function store(bucket, extra = {}) {
  const logs = [];
  const files = createFileStore({
    bucket: 'your-gcp-project-paraclete',
    fetch: bucket.fetch,
    getAccessToken: async () => 'tok',
    logger: (level, msg) => logs.push(`${level} ${msg}`),
    ...extra,
  });
  return { files, logs };
}

test('outgoing and incoming files have fixed layouts under the prefix', () => {
  assert.equal(outgoingObjectName('files/', 'w-1', 'report.docx'), 'files/out/w-1/report.docx');
  assert.equal(incomingObjectName('files/', 'u-7', 'scan.pdf'), 'files/in/u-7/scan.pdf');
  assert.equal(outgoingObjectName('files', 'w-1', 'a.md'), 'files/out/w-1/a.md', 'a missing trailing slash is added');
  assert.equal(outgoingObjectName('', 'w-1', 'a.md'), 'out/w-1/a.md');
});

test('ids become one plain segment and are required', () => {
  assert.equal(outgoingObjectName('files/', '../w 1', 'a.md'), 'files/out/___w_1/a.md');
  assert.throws(() => outgoingObjectName('files/', '', 'a.md'), /missionId is required/);
  assert.throws(() => incomingObjectName('files/', undefined, 'a.md'), /uploadId is required/);
});

test('file names lose directories and control characters, and are never empty or dot names', () => {
  assert.equal(sanitizeFileName('/tmp/x/report.md'), 'report.md');
  assert.equal(sanitizeFileName('C:\\work\\report.md'), 'report.md');
  assert.equal(sanitizeFileName('bad\u0000na\u001fme.txt'), 'badname.txt');
  assert.equal(sanitizeFileName('  spaced name.pdf  '), 'spaced name.pdf');
  assert.equal(sanitizeFileName(''), 'file');
  assert.equal(sanitizeFileName('..'), 'file');
  assert.equal(sanitizeFileName('dir/'), 'file');
  const long = sanitizeFileName(`${'n'.repeat(300)}.xlsx`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.xlsx'), 'the extension survives truncation');
});

test('content types follow the extension, case-insensitively', () => {
  assert.equal(contentTypeFor('a.DOCX'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(contentTypeFor('chart.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('no-extension'), 'application/octet-stream');
});

test('createFileStore needs a bucket', () => {
  assert.throws(() => createFileStore({}), /bucket is required/);
});

test('uploads a mission file to its download path with its content type', async () => {
  const bucket = fakeBucket();
  const { files } = store(bucket);
  const path = file('out/report.docx', 'docx bytes');
  const results = await files.uploadOutgoing('w-1', [path]);
  assert.deepEqual(results, [{
    name: 'report.docx',
    size: 10,
    gcsPath: 'files/out/w-1/report.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sha256: createHash('sha256').update('docx bytes').digest('hex'),
  }]);
  const [upload] = bucket.uploads;
  assert.match(upload.url, /^https:\/\/storage\.googleapis\.com\/upload\/storage\/v1\/b\/your-gcp-project-paraclete\/o\?uploadType=media&name=/);
  assert.equal(upload.init.headers.Authorization, 'Bearer tok');
  assert.equal(upload.init.headers['Content-Type'], results[0].contentType);
  assert.equal(String(upload.init.body), 'docx bytes');
  assert.ok(upload.init.signal instanceof AbortSignal);
});

test('skips missing files, directories, oversized files and credentials, and uploads the rest', async () => {
  const bucket = fakeBucket();
  const { files, logs } = store(bucket, { maxBytes: 5 });
  file('a-directory/inside.txt');
  const results = await files.uploadOutgoing('w-2', [
    join(scratch, 'nope.txt'),
    join(scratch, 'a-directory'),
    file('big.txt', 'more than five bytes'),
    file('keys/agent.json', 'k'),
    file('svc-key.json', 'k'),
    file('server.pem', 'k'),
    file('.env', 'k'),
    file('app-credentials.json', 'k'),
    file('ok.csv', 'a,b'),
  ]);
  assert.deepEqual(results.map((r) => r.name), ['ok.csv']);
  assert.equal(bucket.uploads.length, 1);
  const log = logs.join('\n');
  assert.match(log, /missing/);
  assert.match(log, /skipping directory/);
  assert.match(log, /exceeds 5 bytes/);
  assert.equal(log.match(/denied credential path/g).length, 5);
});

test('two files with the same name in one call get distinct download names', async () => {
  const bucket = fakeBucket();
  const { files } = store(bucket);
  const results = await files.uploadOutgoing('w-3', [file('a/report.md'), file('b/report.md'), file('c/report.md')]);
  assert.deepEqual(results.map((r) => r.gcsPath), [
    'files/out/w-3/report.md', 'files/out/w-3/report-2.md', 'files/out/w-3/report-3.md',
  ]);
});

test('a failed upload is logged and the remaining files still go', async () => {
  const bucket = fakeBucket({ fail: ['first.md'] });
  const { files, logs } = store(bucket);
  const results = await files.uploadOutgoing('w-4', [file('first.md'), file('second.md')]);
  assert.deepEqual(results.map((r) => r.name), ['second.md']);
  assert.match(logs.join('\n'), /failed .*first\.md: HTTP 403: forbidden/);
});

test('without a token nothing is uploaded and nothing throws', async () => {
  const bucket = fakeBucket();
  const { files, logs } = store(bucket, { getAccessToken: async () => { throw new Error('no metadata server'); } });
  assert.deepEqual(await files.uploadOutgoing('w-5', [file('x.md')]), []);
  assert.equal(bucket.uploads.length, 0);
  assert.match(logs.join('\n'), /auth failure: no metadata server/);
});

test('a mission id is required', async () => {
  const { files } = store(fakeBucket());
  await assert.rejects(files.uploadOutgoing('', [file('y.md')]), /missionId is required/);
});

test('credentials and the instance configuration are recognized on the resolved path', () => {
  for (const path of ['/etc/paraclete/instance.json', '/etc/paraclete/gateway-token', '/var/lib/x/.gateway-token', '/home/a/.ssh/id_ed25519',
    '/w/keys/k.json', '/w/svc-key.json', '/w/server.pem', '/w/tls.key', '/home/a/.git-credentials', '/home/a/.netrc', '/w/.env', '/w/.env.local',
    '/w/app-credentials.json', 'C:\\w\\.ssh\\id_rsa']) {
    assert.equal(isCredentialPath(path), true, path);
  }
  for (const path of ['/w/report.pdf', '/w/keynote.pptx', '/w/environment.md', '/etc/hosts']) assert.equal(isCredentialPath(path), false, path);
});

test('uploadOne shares one file under its own name or the one given, with its checksum', async () => {
  const bucket = fakeBucket();
  const { files } = store(bucket);
  const path = file('one/draft v2.md', '# Draft');
  const result = await files.uploadOne('w-6', path, { name: 'Q3 report.md' });
  assert.deepEqual(result, {
    name: 'Q3 report.md', size: 7, gcsPath: 'files/out/w-6/Q3 report.md', contentType: 'text/markdown',
    sha256: createHash('sha256').update('# Draft').digest('hex'),
  });
  assert.equal(new URL(bucket.uploads[0].url).searchParams.get('name'), 'files/out/w-6/Q3 report.md');
  assert.equal((await files.uploadOne('w-6', path)).name, 'draft v2.md');
});

test('uploadOne refuses, with the reason, a file that may not go', async () => {
  const bucket = fakeBucket();
  const { files } = store(bucket, { maxBytes: 5 });
  const refused = (re) => (err) => err instanceof ShareRefused && re.test(err.message);
  await assert.rejects(files.uploadOne('w-7', join(scratch, 'absent.md')), refused(/does not exist/));
  await assert.rejects(files.uploadOne('w-7', file('k/.env', 'A=1')), refused(/credential or the instance's own configuration/));
  await assert.rejects(files.uploadOne('w-7', join(scratch, 'k')), refused(/is a directory/));
  await assert.rejects(files.uploadOne('w-7', file('k/big.txt', 'more than five')), refused(/big\.txt is 14 bytes, more than the 5 bytes a shared file may be \(files.max_mb\)/));
  await assert.rejects(store(fakeBucket({ fail: ['ok.md'] })).files.uploadOne('w-7', file('k/ok.md', 'ok')), /HTTP 403: forbidden/);
  assert.equal(bucket.uploads.length, 0);
});
