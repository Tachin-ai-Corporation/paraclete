// Tests for dashboard/lib/server/files.mjs: downloads streamed from the Cloud Storage fake, with the
// dashboard's own token, and refusals for anything that is not one of the agent's outgoing files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { start as startStorage } from '../../../fakes/gcs-server.mjs';
import {
  attachmentDisposition, checkDownloadPath, downloadFile, isDownloadablePath, outgoingPrefix,
} from '../../../../dashboard/lib/server/files.mjs';
import { route } from '../../../../dashboard/lib/server/http.mjs';
import { outgoingObjectName } from '../../../../agent/storage/file-store.mjs';

/** A dashboard runtime and a bucket fake named as the runtime expects, holding the given objects. */
async function setUp(t, objects = {}, env = {}) {
  const dash = await startDashboard({ env });
  const storage = await startStorage({ bucket: dash.runtime.settings.bucket });
  t.after(async () => {
    await storage.stop();
    await dash.stop();
  });
  for (const [name, { body, type }] of Object.entries(objects)) {
    const response = await fetch(`${storage.origin}/upload/storage/v1/b/${storage.bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': type }, body,
    });
    assert.equal(response.status, 200);
  }
  storage.requests.length = 0;
  return { dash, storage, runtime: dash.runtime };
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('the outgoing prefix comes from the contracts and matches where the agent writes', async (t) => {
  const { runtime } = await setUp(t);
  assert.equal(outgoingPrefix(runtime), 'files/out/');
  const written = outgoingObjectName(runtime.contracts.files.prefix, 'w-123', 'report.docx');
  assert.equal(checkDownloadPath(runtime, written), 'files/out/w-123/report.docx');
});

test('an outgoing file streams back as a download, with its type, size and name', async (t) => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
  const { runtime, storage } = await setUp(t, { 'files/out/w-123/Q3 report.docx': { body: bytes, type: DOCX } });

  const response = await downloadFile(runtime, { path: 'files/out/w-123/Q3 report.docx', storageHost: storage.origin });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), DOCX);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="Q3 report.docx"; filename*=UTF-8\'\'Q3%20report.docx');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  // One call to the bucket, for the media, with the dashboard's own token and the name as one segment.
  assert.deepEqual(storage.requests.map((r) => [r.method, r.path, r.query, r.token]), [
    ['GET', `/storage/v1/b/${storage.bucket}/o/files%2Fout%2Fw-123%2FQ3%20report.docx`, 'alt=media', 'dashboard-token'],
  ]);
});

test('text files are served as UTF-8, and a type the agent has no entry for keeps what the bucket says', async (t) => {
  const { runtime, storage } = await setUp(t, {
    'files/out/w-1/notes.md': { body: '# Notes — café', type: 'text/markdown' },
    'files/out/w-1/data.parquet': { body: 'PAR1', type: 'application/vnd.apache.parquet' },
  });
  const md = await downloadFile(runtime, { path: 'files/out/w-1/notes.md', storageHost: storage.origin });
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await md.text(), '# Notes — café');
  const other = await downloadFile(runtime, { path: 'files/out/w-1/data.parquet', storageHost: storage.origin });
  assert.equal(other.headers.get('content-type'), 'application/vnd.apache.parquet');
});

test('a name outside ASCII is kept exactly in filename*, with a safe plain fallback', () => {
  assert.equal(attachmentDisposition('Résumé "final".pdf'),
    'attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8\'\'R%C3%A9sum%C3%A9%20%22final%22.pdf');
  assert.equal(attachmentDisposition("it's (1).txt"), 'attachment; filename="it\'s (1).txt"; filename*=UTF-8\'\'it%27s%20%281%29.txt');
});

test('anything but an outgoing file is refused before the bucket is called', async (t) => {
  const { runtime, storage } = await setUp(t, { 'files/in/u-1/upload.pdf': { body: 'x', type: 'application/pdf' } });
  const refused = {
    400: ['', null, undefined, 42, 'files/out/../in/u-1/upload.pdf', 'files/out/w-1/../../in/u-1/upload.pdf', 'files/out/./w-1/a.md',
      'files//out/w-1/a.md', 'files/out/w-1/', '/files/out/w-1/a.md', 'files\\out\\w-1\\a.md', 'files/out/w-1/a\nb.md',
      `files/out/w-1/${'a'.repeat(1100)}`],
    403: ['files/in/u-1/upload.pdf', 'files/out/a.md', 'files/outbox/w-1/a.md', 'git/bundles/repo/1.bundle', 'files/out'],
  };
  for (const [status, paths] of Object.entries(refused)) {
    for (const path of paths) {
      assert.equal(isDownloadablePath(runtime, path), false, String(path));
      await assert.rejects(downloadFile(runtime, { path, storageHost: storage.origin }), (err) => err.status === Number(status), String(path));
    }
  }
  assert.deepEqual(storage.requests, []);
});

test('a file that is gone is a 404, and a bucket that fails is a 502 with the details only in the log', async (t) => {
  const { runtime, storage, dash } = await setUp(t);
  await assert.rejects(downloadFile(runtime, { path: 'files/out/w-1/missing.pdf', storageHost: storage.origin }), (err) => err.status === 404);

  const failing = await startDashboard({
    fetch: async () => new Response('{"error":{"code":403,"message":"no access to the bucket"}}', { status: 403 }),
  });
  t.after(failing.stop);
  await assert.rejects(downloadFile(failing.runtime, { path: 'files/out/w-1/a.pdf', storageHost: 'https://storage.example.com' }),
    (err) => err.status === 502 && !/no access/.test(err.message));
  assert.match(failing.lines.find((line) => line.level === 'ERROR').message, /no access to the bucket/);
  assert.deepEqual(dash.lines.filter((line) => line.level === 'ERROR'), []);
});

test('a member may download, through the same route wrapper the API uses', async (t) => {
  const { runtime, storage, dash } = await setUp(t, { 'files/out/w-7/out.csv': { body: 'a,b\n1,2\n', type: 'text/csv' } }, {
    PARACLETE_DEV_USER: 'ada@example.com',
  });
  await dash.seed({ 'users/ada@example.com': { email: 'ada@example.com', role: 'member' } });
  const handler = route(({ request }) => downloadFile(runtime, {
    path: new URL(request.url).searchParams.get('path'), storageHost: storage.origin,
  }), { runtime: () => runtime });

  const ok = await handler(new Request('http://dashboard.example.com/api/files/download?path=files%2Fout%2Fw-7%2Fout.csv'));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'a,b\n1,2\n');
  const refused = await handler(new Request('http://dashboard.example.com/api/files/download?path=files%2Fin%2Fx%2Fy.pdf'));
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /files\/out\//);
});
