// Tests for dashboard/lib/server/files.mjs: a download is a redirect to a signed URL straight to the
// bucket, for the agent's outgoing files and for uploads, and nothing else; a mission's files come from
// its 'out' records in `files`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWithBucket, verifySignedUrl, BUCKET } from './bucket-fakes.mjs';
import {
  attachmentDisposition, checkDownloadPath, deleteObject, downloadRedirect, incomingPrefix, isDownloadablePath,
  listMissionFiles, objectMetadata, outgoingPrefix, servedType,
} from '../../../../dashboard/lib/server/files.mjs';
import { route } from '../../../../dashboard/lib/server/http.mjs';
import { incomingObjectName, outgoingObjectName } from '../../../../agent/storage/file-store.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';

const NOW = new Date('2027-01-15T08:00:00.000Z');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The signed URL a download redirected to, with its query parsed. */
function location(response) {
  assert.equal(response.status, 302);
  const url = response.headers.get('location');
  return { url, query: new URL(url).searchParams, path: new URL(url).pathname };
}

test('the prefixes come from the contracts and match where the agent and the uploads write', async (t) => {
  const { runtime } = await startWithBucket(t);
  assert.equal(outgoingPrefix(runtime), 'files/out/');
  assert.equal(incomingPrefix(runtime), 'files/in/');
  const out = outgoingObjectName(runtime.contracts.files.prefix, 'w-123', 'report.docx');
  assert.equal(checkDownloadPath(runtime, out), 'files/out/w-123/report.docx');
  const upload = incomingObjectName(runtime.contracts.files.prefix, 'u-1800000000000-0a1b2c3d', 'notes.pdf');
  assert.equal(checkDownloadPath(runtime, upload), 'files/in/u-1800000000000-0a1b2c3d/notes.pdf');
});

test("an outgoing file redirects to a signed URL that downloads it under its name and type, valid for the contracts' minutes", async (t) => {
  const { runtime, storage, signs } = await startWithBucket(t, { objects: { 'files/out/w-123/Q3 report.docx': { body: 'PK\u0003\u0004', type: DOCX } } });

  const response = await downloadRedirect(runtime, { path: 'files/out/w-123/Q3 report.docx', now: NOW });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const { url, query, path } = location(response);
  assert.ok(url.startsWith('https://storage.googleapis.com/'));
  assert.equal(path, `/${BUCKET}/files/out/w-123/Q3%20report.docx`);
  assert.equal(query.get('response-content-disposition'), 'attachment; filename="Q3 report.docx"; filename*=UTF-8\'\'Q3%20report.docx');
  assert.equal(query.get('response-content-type'), DOCX);
  assert.equal(query.get('X-Goog-Expires'), String(runtime.contracts.files.signed_url_minutes * 60));
  assert.equal(query.get('X-Goog-Credential'), `${runtime.settings.dashboardAccount}/20270115/auto/storage/goog4_request`);
  assert.equal(query.get('X-Goog-Date'), '20270115T080000Z');
  assert.ok(verifySignedUrl(url), 'the bucket would accept the signature');

  // One metadata read with the dashboard's own token, the name as one segment; the bytes never pass through.
  assert.deepEqual(storage.requests.map((r) => [r.method, r.path, r.query, r.token]), [
    ['GET', `/storage/v1/b/${BUCKET}/o/files%2Fout%2Fw-123%2FQ3%20report.docx`, '', 'dashboard-token'],
  ]);
  assert.equal(signs.length, 1);
  assert.equal(signs[0].init.headers.Authorization, 'Bearer dashboard-token');
});

test('text is served as UTF-8, and a type the agent has no entry for keeps what the bucket says', async (t) => {
  const { runtime } = await startWithBucket(t, {
    objects: {
      'files/out/w-1/notes.md': { body: '# Notes', type: 'text/markdown' },
      'files/out/w-1/data.parquet': { body: 'PAR1', type: 'application/vnd.apache.parquet' },
    },
  });
  assert.equal(location(await downloadRedirect(runtime, { path: 'files/out/w-1/notes.md' })).query.get('response-content-type'), 'text/markdown; charset=utf-8');
  assert.equal(location(await downloadRedirect(runtime, { path: 'files/out/w-1/data.parquet' })).query.get('response-content-type'), 'application/vnd.apache.parquet');
  assert.equal(servedType('a.bin', null), 'application/octet-stream');
});

test('a file someone uploaded downloads too, under its own name', async (t) => {
  const name = 'files/in/u-1800000000000-0a1b2c3d/Résumé.pdf';
  const { runtime } = await startWithBucket(t, { objects: { [name]: { body: '%PDF-1.7', type: 'application/pdf' } } });
  const { url, query, path } = location(await downloadRedirect(runtime, { path: name }));
  assert.equal(path, `/${BUCKET}/files/in/u-1800000000000-0a1b2c3d/R%C3%A9sum%C3%A9.pdf`);
  assert.equal(query.get('response-content-disposition'), 'attachment; filename="R_sum_.pdf"; filename*=UTF-8\'\'R%C3%A9sum%C3%A9.pdf');
  assert.equal(query.get('response-content-type'), 'application/pdf');
  assert.ok(verifySignedUrl(url));
});

test('a name outside ASCII is kept exactly in filename*, with a safe plain fallback', () => {
  assert.equal(attachmentDisposition('Résumé "final".pdf'),
    'attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8\'\'R%C3%A9sum%C3%A9%20%22final%22.pdf');
  assert.equal(attachmentDisposition("it's (1).txt"), 'attachment; filename="it\'s (1).txt"; filename*=UTF-8\'\'it%27s%20%281%29.txt');
});

test('anything but an outgoing or uploaded file is refused before the bucket or IAM is called', async (t) => {
  const { runtime, storage, signs } = await startWithBucket(t, { objects: { 'git/bundles/repo/1.bundle': { body: 'x', type: 'application/octet-stream' } } });
  const refused = {
    400: ['', null, undefined, 42, 'files/out/../in/u-1/upload.pdf', 'files/out/w-1/../../in/u-1/upload.pdf', 'files/out/./w-1/a.md',
      'files//out/w-1/a.md', 'files/out/w-1/', '/files/out/w-1/a.md', 'files\\out\\w-1\\a.md', 'files/out/w-1/a\nb.md',
      `files/out/w-1/${'a'.repeat(1100)}`],
    403: ['files/in/upload.pdf', 'files/out/a.md', 'files/outbox/w-1/a.md', 'files/inbox/u-1/a.md', 'git/bundles/repo/1.bundle', 'files/out', 'files/in'],
  };
  for (const [status, paths] of Object.entries(refused)) {
    for (const path of paths) {
      assert.equal(isDownloadablePath(runtime, path), false, String(path));
      await assert.rejects(downloadRedirect(runtime, { path }), (err) => err.status === Number(status), String(path));
    }
  }
  assert.deepEqual(storage.requests, []);
  assert.deepEqual(signs, []);
});

test('a file that is gone is a 404 and is never signed; a bucket that fails is a 502 with the details only in the log', async (t) => {
  const { runtime, signs } = await startWithBucket(t);
  await assert.rejects(downloadRedirect(runtime, { path: 'files/out/w-1/missing.pdf' }), (err) => err.status === 404);
  assert.deepEqual(signs, []);

  const lines = [];
  const failing = {
    ...runtime,
    fetch: async () => new Response('{"error":{"code":403,"message":"no access to the bucket"}}', { status: 403 }),
    log: (level, message) => lines.push({ level, message }),
  };
  await assert.rejects(downloadRedirect(failing, { path: 'files/out/w-1/a.pdf' }), (err) => err.status === 502 && !/no access/.test(err.message));
  assert.match(lines.find((line) => line.level === 'ERROR').message, /no access to the bucket/);
});

test('object metadata and deletion go through the JSON API with the dashboard token', async (t) => {
  const { runtime, storage } = await startWithBucket(t, { objects: { 'files/in/u-1-0a1b2c3d/a.csv': { body: 'a,b\n', type: 'text/csv' } } });
  const meta = await objectMetadata(runtime, 'files/in/u-1-0a1b2c3d/a.csv');
  assert.deepEqual({ ...meta, md5: typeof meta.md5 }, { name: 'files/in/u-1-0a1b2c3d/a.csv', size: 4, content_type: 'text/csv', md5: 'string' });
  assert.equal(await objectMetadata(runtime, 'files/in/u-1-0a1b2c3d/b.csv'), null);
  assert.equal(await deleteObject(runtime, 'files/in/u-1-0a1b2c3d/a.csv'), true);
  assert.deepEqual(Object.keys(storage.dump()), []);
  assert.equal(await deleteObject(runtime, 'files/in/u-1-0a1b2c3d/a.csv'), true, 'already gone counts as deleted');
  assert.ok(storage.requests.every((r) => r.token === 'dashboard-token'));
});

test('a member may download, through the same route wrapper the API uses: the answer is the redirect', async (t) => {
  const { runtime, dash } = await startWithBucket(t, {
    objects: { 'files/out/w-7/out.csv': { body: 'a,b\n1,2\n', type: 'text/csv' } },
    env: { PARACLETE_DEV_USER: 'ada@example.com' },
  });
  await dash.seed({ 'users/ada@example.com': { email: 'ada@example.com', role: 'member' } });
  const handler = route(({ request }) => downloadRedirect(runtime, { path: new URL(request.url).searchParams.get('path') }), { runtime: () => runtime });

  const ok = await handler(new Request('http://dashboard.example.com/api/files/download?path=files%2Fout%2Fw-7%2Fout.csv'));
  assert.equal(ok.status, 302);
  assert.equal(new URL(ok.headers.get('location')).searchParams.get('response-content-type'), 'text/csv; charset=utf-8');
  const refused = await handler(new Request('http://dashboard.example.com/api/files/download?path=git%2Fbundles%2Fx'));
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /files\/out\/.*files\/in\//);
});

test("a mission's files are its 'out' records, newest first, with their Drive links; nobody else's", async (t) => {
  const { runtime, dash } = await startWithBucket(t);
  const out = (mission, name, at, extra = {}) => ({
    direction: 'out', mission_id: mission, name, size: 1200, content_type: DOCX, gcs_path: `files/out/${mission}/${name}`, sha256: null,
    source: 'file-share', created_at: at, created_by: 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com', drive: null, expires_at: null, ...extra,
  });
  await dash.seed({
    'files/out-w-1-report_docx': out('w-1', 'report.docx', '2027-01-15T08:00:00Z', {
      drive: { file_id: 'drive-file-1', link: 'https://drive.google.com/file/d/drive-file-1/view', folder_id: 'drive-folder-1' },
    }),
    'files/out-w-1-data_xlsx': out('w-1', 'data.xlsx', '2027-01-15T08:05:00.500Z', { source: 'artifact', size: 77, content_type: null }),
    'files/out-w-2-other_md': out('w-2', 'other.md', '2027-01-15T09:00:00Z'),
    // An upload a mission took in is the mission's too, but it is not a file the mission handed back.
    'files/u-1800000000000-0a1b2c3d': {
      direction: 'in', mission_id: 'w-1', name: 'brief.pdf', size: 5, content_type: 'application/pdf',
      gcs_path: 'files/in/u-1800000000000-0a1b2c3d/brief.pdf', source: 'upload', created_at: '2027-01-15T07:00:00Z',
    },
  });

  const { mission_id: missionId, files } = await listMissionFiles(runtime, 'w-1');
  assert.equal(missionId, 'w-1');
  assert.deepEqual(files, [
    {
      id: 'out-w-1-data_xlsx', name: 'data.xlsx', size: 77, content_type: null, created_at: '2027-01-15T08:05:00.500Z', source: 'artifact',
      gcs_path: 'files/out/w-1/data.xlsx', downloadable: true, drive_link: null,
    },
    {
      id: 'out-w-1-report_docx', name: 'report.docx', size: 1200, content_type: DOCX, created_at: '2027-01-15T08:00:00Z', source: 'file-share',
      gcs_path: 'files/out/w-1/report.docx', downloadable: true, drive_link: 'https://drive.google.com/file/d/drive-file-1/view',
    },
  ]);
  assert.deepEqual((await listMissionFiles(runtime, 'w-9')).files, []);
  await assert.rejects(listMissionFiles(runtime, 'w/1'), (err) => err.status === 400);
});

test("a mission's files read through an outage is a 503, never an empty list", async (t) => {
  const { runtime } = await startWithBucket(t);
  const down = { ...runtime, db: { query: async () => { throw new StoreUnavailable('query', 'files', 503, 'unavailable'); } }, log: () => {} };
  await assert.rejects(listMissionFiles(down, 'w-1'), (err) => err.status === 503);
});
