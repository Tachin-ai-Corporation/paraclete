// Tests for dashboard/lib/server/uploads.mjs: an upload starts with a signed PUT URL for exactly one
// object and type, the bytes go to the bucket (here, the Cloud Storage fake, as the browser's PUT
// would leave them), and completing it writes the 'in' record in the shape the agent reads. Then a
// message may carry it, once, and only its uploader's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWithBucket, verifySignedUrl, BUCKET } from './bucket-fakes.mjs';
import {
  MAX_ATTACHMENTS, UPLOAD_ID, checkUploadId, claimUploads, completeUpload, maxUploadBytes, newUploadId, startUpload, uploadContentType,
} from '../../../../dashboard/lib/server/uploads.mjs';
import { route } from '../../../../dashboard/lib/server/http.mjs';
import { incomingObjectName } from '../../../../agent/storage/file-store.mjs';

const NOW = new Date('2027-01-15T08:00:00.000Z');
const ADA = { email: 'ada@example.com', role: 'member' };
const ZOE = { email: 'zoe@example.com', role: 'admin' };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Starts an upload and leaves its bytes in the bucket, as the browser does with the signed URL. */
async function uploaded(env, user, name, body, { type = '', now = NOW } = {}) {
  const started = await startUpload(env.runtime, { user, name, size: Buffer.byteLength(body), content_type: type, now });
  await env.put(started.gcs_path, body, started.headers['Content-Type']);
  return started;
}

test('upload ids are u-<ms>-<8 hex>, and checked', () => {
  const id = newUploadId(NOW);
  assert.ok(id.startsWith(`u-${NOW.getTime()}-`));
  assert.match(id, UPLOAD_ID);
  assert.notEqual(newUploadId(NOW), id);
  assert.equal(checkUploadId(id), id);
  for (const bad of ['', 'u-1-ABCDEF12', 'u-1-0a1b2c3', 'x-1-0a1b2c3d', 'u-1-0a1b2c3d/..', null]) {
    assert.throws(() => checkUploadId(bad), (err) => err.status === 400, String(bad));
  }
});

test("an upload's type is the agent's own for its extension, else the browser's, lowercase and without parameters", () => {
  assert.equal(uploadContentType('Sales.XLSX', 'application/vnd.ms-excel'), XLSX);
  assert.equal(uploadContentType('notes.csv', ''), 'text/csv');
  assert.equal(uploadContentType('photo.heic', 'Image/HEIC; foo=bar'), 'image/heic');
  assert.equal(uploadContentType('blob', 'not a type'), 'application/octet-stream');
  assert.equal(uploadContentType('blob', undefined), 'application/octet-stream');
});

test('starting an upload answers a signed PUT URL for files/in/<id>/<sanitized name> with the exact type to send, and writes nothing', async (t) => {
  const env = await startWithBucket(t);
  const { runtime, dash, signs } = env;
  const started = await startUpload(runtime, { user: ADA, name: 'C:\\Users\\ada\\Q3 sales.xlsx', size: 2048, content_type: '', now: NOW });

  assert.match(started.upload_id, UPLOAD_ID);
  assert.ok(started.upload_id.startsWith(`u-${NOW.getTime()}-`));
  assert.equal(started.name, 'Q3 sales.xlsx');
  assert.equal(started.size, 2048);
  assert.equal(started.gcs_path, incomingObjectName(runtime.contracts.files.prefix, started.upload_id, 'Q3 sales.xlsx'));
  assert.equal(started.gcs_path, `files/in/${started.upload_id}/Q3 sales.xlsx`);
  assert.deepEqual(started.headers, { 'Content-Type': XLSX });
  assert.equal(started.expires_at, new Date(NOW.getTime() + runtime.contracts.files.signed_url_minutes * 60_000).toISOString());

  const url = new URL(started.url);
  assert.equal(url.pathname, `/${BUCKET}/files/in/${started.upload_id}/Q3%20sales.xlsx`);
  assert.equal(url.searchParams.get('X-Goog-SignedHeaders'), 'content-type;host');
  assert.ok(verifySignedUrl(started.url, { method: 'PUT', headers: { 'content-type': XLSX } }), 'the bucket accepts the PUT with that type');
  assert.equal(verifySignedUrl(started.url, { method: 'PUT', headers: { 'content-type': 'text/html' } }), false, 'and refuses any other type');
  assert.equal(verifySignedUrl(started.url, { method: 'GET' }), false, 'and any other method');
  assert.equal(signs.length, 1);

  assert.deepEqual(dash.firestore.dump(), {});
});

test('the size limit is the contracts\' files.max_upload_mb; empty files and nonsense sizes are refused', async (t) => {
  const { runtime, signs } = await startWithBucket(t);
  const max = maxUploadBytes(runtime);
  assert.equal(max, runtime.contracts.files.max_upload_mb * 1024 * 1024);
  await startUpload(runtime, { user: ADA, name: 'big.bin', size: max });
  await assert.rejects(startUpload(runtime, { user: ADA, name: 'huge.mov', size: max + 1 }),
    (err) => err.status === 413 && err.message.includes(`${runtime.contracts.files.max_upload_mb} MB`) && err.message.includes('huge.mov'));
  await assert.rejects(startUpload(runtime, { user: ADA, name: 'empty.txt', size: 0 }), (err) => err.status === 400 && /empty/.test(err.message));
  for (const size of [-1, 1.5, '12', null, undefined, Number.NaN]) {
    await assert.rejects(startUpload(runtime, { user: ADA, name: 'a.txt', size }), (err) => err.status === 400, String(size));
  }
  for (const name of ['', '   ', null, 42]) {
    await assert.rejects(startUpload(runtime, { user: ADA, name, size: 10 }), (err) => err.status === 400, String(name));
  }
  assert.equal(signs.length, 1, 'only the upload within the limit was signed');
});

test("completing an upload checks the bucket and writes the 'in' record the agent reads", async (t) => {
  const env = await startWithBucket(t);
  const { runtime, dash, storage } = env;
  const body = 'PK\u0003\u0004 spreadsheet';
  const started = await uploaded(env, ADA, 'Q3 sales.xlsx', body);
  storage.requests.length = 0;

  const done = new Date(NOW.getTime() + 5000);
  const attachment = await completeUpload(runtime, { user: ADA, id: started.upload_id, gcs_path: started.gcs_path, now: done });
  assert.deepEqual(attachment, { name: 'Q3 sales.xlsx', size: Buffer.byteLength(body), gcsPath: started.gcs_path });

  const days = runtime.contracts.files.inbox_retention_days;
  assert.deepEqual(await dash.doc(`files/${started.upload_id}`), {
    direction: 'in',
    mission_id: null,
    name: 'Q3 sales.xlsx',
    size: Buffer.byteLength(body),
    content_type: XLSX,
    gcs_path: started.gcs_path,
    sha256: null,
    source: 'upload',
    created_at: done.toISOString(),
    created_by: 'ada@example.com',
    drive: null,
    expires_at: new Date(done.getTime() + days * 86_400_000).toISOString(),
    message_id: null,
  });
  // One metadata read of exactly that object, with the dashboard's token.
  assert.deepEqual(storage.requests.map((r) => [r.method, r.path, r.token]), [
    ['GET', `/storage/v1/b/${BUCKET}/o/${encodeURIComponent(started.gcs_path)}`, 'dashboard-token'],
  ]);

  // Completing again (a retried request) answers the same; someone else cannot claim it.
  assert.deepEqual(await completeUpload(runtime, { user: ADA, id: started.upload_id, gcs_path: started.gcs_path }), attachment);
  await assert.rejects(completeUpload(runtime, { user: ZOE, id: started.upload_id, gcs_path: started.gcs_path }), (err) => err.status === 409);
});

test('an upload whose bytes never arrived, or the wrong path, is not completed', async (t) => {
  const env = await startWithBucket(t);
  const { runtime, dash } = env;
  const started = await startUpload(runtime, { user: ADA, name: 'a.pdf', size: 10, now: NOW });
  await assert.rejects(completeUpload(runtime, { user: ADA, id: started.upload_id, gcs_path: started.gcs_path }),
    (err) => err.status === 409 && /did not finish/.test(err.message));

  await env.put(started.gcs_path, '%PDF-1.7 x', 'application/pdf');
  const other = `files/in/${newUploadId(NOW)}/a.pdf`;
  for (const gcsPath of [undefined, '', other, `files/in/${started.upload_id}/`, `files/in/${started.upload_id}/x/a.pdf`,
    `files/out/${started.upload_id}/a.pdf`, `files/in/${started.upload_id}/ a.pdf`]) {
    await assert.rejects(completeUpload(runtime, { user: ADA, id: started.upload_id, gcs_path: gcsPath }), (err) => err.status === 400, String(gcsPath));
  }
  await assert.rejects(completeUpload(runtime, { user: ADA, id: 'u-1', gcs_path: started.gcs_path }), (err) => err.status === 400);
  assert.deepEqual(dash.firestore.dump(), {});
});

test('a file that turned out larger than the limit is deleted from the bucket and refused', async (t) => {
  const env = await startWithBucket(t);
  const runtime = { ...env.runtime, contracts: { ...env.runtime.contracts, files: { ...env.runtime.contracts.files, max_upload_mb: 0.00001 } } };
  const started = await startUpload(runtime, { user: ADA, name: 'small.txt', size: 5, now: NOW });
  await env.put(started.gcs_path, 'far more than the ten bytes it said', 'text/plain');
  await assert.rejects(completeUpload(runtime, { user: ADA, id: started.upload_id, gcs_path: started.gcs_path }), (err) => err.status === 413);
  assert.deepEqual(Object.keys(env.storage.dump()), []);
  assert.deepEqual(env.dash.firestore.dump(), {});
});

test("a message may carry only its sender's completed uploads, each once", async (t) => {
  const env = await startWithBucket(t);
  const { runtime, dash } = env;
  const mine = await uploaded(env, ADA, 'brief.pdf', '%PDF brief');
  const second = await uploaded(env, ADA, 'data.csv', 'a,b\n');
  const zoes = await uploaded(env, ZOE, 'zoe.txt', 'private');
  const unfinished = await startUpload(runtime, { user: ADA, name: 'later.txt', size: 3 });
  for (const [user, s] of [[ADA, mine], [ADA, second], [ZOE, zoes]]) {
    await completeUpload(runtime, { user, id: s.upload_id, gcs_path: s.gcs_path });
  }

  const claim = await claimUploads(runtime, { user: ADA, attachments: [{ gcsPath: mine.gcs_path, name: 'renamed.exe', size: 1 }, { gcsPath: second.gcs_path }], messageId: 'm1' });
  // The attachments come from the records, not from what the browser said.
  assert.deepEqual(claim.attachments, [
    { name: 'brief.pdf', size: 10, gcsPath: mine.gcs_path },
    { name: 'data.csv', size: 4, gcsPath: second.gcs_path },
  ]);
  assert.deepEqual(claim.writes.map((w) => [w.path, w.data.message_id, typeof w.precondition.updateTime]),
    [[`files/${mine.upload_id}`, 'm1', 'string'], [`files/${second.upload_id}`, 'm1', 'string']]);
  assert.deepEqual(await claimUploads(runtime, { user: ADA, attachments: undefined, messageId: 'm1' }), { attachments: [], writes: [] });

  const refusals = [
    [{ attachments: 'files/in/x' }, 400],
    [{ attachments: [{ name: 'a.pdf' }] }, 400],
    [{ attachments: [{ gcsPath: mine.gcs_path }, { gcsPath: mine.gcs_path }] }, 400],
    [{ attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ gcsPath: `files/in/u-1-0000000${i % 10}/a` })) }, 400],
    [{ attachments: [{ gcsPath: 'files/out/w-1/report.docx' }] }, 400],
    [{ attachments: [{ gcsPath: unfinished.gcs_path }] }, 400],
    [{ attachments: [{ gcsPath: `files/in/${mine.upload_id}/other.pdf` }] }, 400],
    [{ attachments: [{ gcsPath: zoes.gcs_path }] }, 403],
  ];
  for (const [input, status] of refusals) {
    await assert.rejects(claimUploads(runtime, { user: ADA, messageId: 'm2', ...input }), (err) => err.status === status, JSON.stringify(input).slice(0, 120));
  }

  // Once a message carried it, or a mission took it in, it is used.
  await dash.seed({ [`files/${second.upload_id}`]: { ...(await dash.doc(`files/${second.upload_id}`)), message_id: 'm0' } });
  await assert.rejects(claimUploads(runtime, { user: ADA, attachments: [{ gcsPath: second.gcs_path }], messageId: 'm3' }), (err) => err.status === 409);
  await dash.seed({ [`files/${mine.upload_id}`]: { ...(await dash.doc(`files/${mine.upload_id}`)), mission_id: 'w-1' } });
  await assert.rejects(claimUploads(runtime, { user: ADA, attachments: [{ gcsPath: mine.gcs_path }], messageId: 'm3' }), (err) => err.status === 409);
});

test('an upload past its inbox retention cannot be sent', async (t) => {
  const env = await startWithBucket(t);
  const started = await uploaded(env, ADA, 'old.pdf', '%PDF');
  await completeUpload(env.runtime, { user: ADA, id: started.upload_id, gcs_path: started.gcs_path, now: NOW });
  const later = new Date(NOW.getTime() + (env.runtime.contracts.files.inbox_retention_days + 1) * 86_400_000);
  await assert.rejects(claimUploads(env.runtime, { user: ADA, attachments: [{ gcsPath: started.gcs_path }], messageId: 'm1', now: later }),
    (err) => err.status === 410);
});

test('the upload routes take any dashboard user, through the route wrapper', async (t) => {
  const env = await startWithBucket(t, { env: { PARACLETE_DEV_USER: 'ada@example.com' } });
  const { runtime, dash } = env;
  await dash.seed({ 'users/ada@example.com': { email: 'ada@example.com', role: 'member' } });
  const start = route(async ({ request, user }) => startUpload(runtime, { user, ...(await request.json()) }), { runtime: () => runtime });
  const complete = route(async ({ request, params, user }) => completeUpload(runtime, { user, id: params.id, ...(await request.json()) }), { runtime: () => runtime });
  const post = (body) => new Request('http://dashboard.example.com/api/files/uploads', { method: 'POST', body: JSON.stringify(body) });

  const started = await (await start(post({ name: 'notes.md', size: 7, content_type: 'text/markdown' }))).json();
  assert.match(started.upload_id, UPLOAD_ID);
  await env.put(started.gcs_path, '# Notes', started.headers['Content-Type']);
  const response = await complete(post({ gcs_path: started.gcs_path }), { params: Promise.resolve({ id: started.upload_id }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: 'notes.md', size: 7, gcsPath: started.gcs_path });
  assert.equal((await dash.doc(`files/${started.upload_id}`)).created_by, 'ada@example.com');
});
