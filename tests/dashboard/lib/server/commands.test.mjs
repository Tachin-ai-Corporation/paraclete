// Tests for dashboard/lib/server/commands.mjs: the dashboard signs every command it writes, and the
// control service's own queue, with the real signature check, runs it. Members may send only views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { startDashboard } from '../../harness.mjs';
import { sendCommand, readCommand, newDocId, VIEW_COMMANDS, ADMIN_COMMANDS } from '../../../../dashboard/lib/server/commands.mjs';
import { createCommandVerifier, paramsDigest } from '../../../../agent/auth/command-signature.mjs';
import { createCommandQueue } from '../../../../agent/services/control/command-queue.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';

const NOW = new Date('2027-01-15T08:00:00.000Z');
const admin = { email: 'admin@example.com', role: 'admin' };
const member = { email: 'member@example.com', role: 'member' };
const SIGNER = 'paraclete-dashboard@your-gcp-project.iam.gserviceaccount.com';

/** IAM and Google's key endpoint, faked with one RSA key. */
function fakeGoogle() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes(':signJwt')) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.parse(init.body).payload).toString('base64url');
      const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
      return { ok: true, status: 200, json: async () => ({ keyId: 'k1', signedJwt: `${header}.${payload}.${signature}` }) };
    }
    return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
  };
  return { fetch, calls };
}

test('ids look like Firestore auto-ids', () => {
  const ids = new Set(Array.from({ length: 50 }, newDocId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{20}$/);
});

test('a command is written pending, signed as the dashboard account, with who asked', async (t) => {
  const google = fakeGoogle();
  const dash = await startDashboard({ fetch: google.fetch });
  t.after(dash.stop);
  const { id } = await sendCommand(dash.runtime, { type: 'restart_service', params: { service: 'brain' }, user: admin, now: NOW });
  const stored = await dash.doc(`commands/${id}`);
  assert.equal(stored.type, 'restart_service');
  assert.deepEqual(stored.params, { service: 'brain' });
  assert.equal(stored.status, 'pending');
  assert.equal(stored.requested_by, 'admin@example.com');
  assert.equal(stored.created_at, NOW.toISOString());
  const claims = JSON.parse(Buffer.from(stored.signature.split('.')[1], 'base64url').toString());
  assert.deepEqual({ iss: claims.iss, cmd: claims.cmd, type: claims.type, by: claims.requested_by, digest: claims.params_sha256 },
    { iss: SIGNER, cmd: id, type: 'restart_service', by: 'admin@example.com', digest: paramsDigest({ service: 'brain' }) });
  const sign = google.calls.find((call) => call.url.includes(':signJwt'));
  assert.equal(sign.url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER)}:signJwt`);
  assert.equal(sign.init.headers.Authorization, 'Bearer dashboard-token');
});

test('the control service runs what the dashboard signed, and refuses the same command edited', async (t) => {
  const google = fakeGoogle();
  const dash = await startDashboard({ fetch: google.fetch });
  t.after(dash.stop);
  const { id: good } = await sendCommand(dash.runtime, { type: 'status', user: member });
  const { id: edited } = await sendCommand(dash.runtime, { type: 'restart_service', params: { service: 'mouth' }, user: admin });
  await dash.runtime.db.patch(`commands/${edited}`, ['params'], dash.encode({ params: { service: 'control' } }), { strict: true });

  const ran = [];
  const queue = createCommandQueue({
    db: dash.runtime.db,
    collections: COLLECTIONS,
    handlers: { status: { run: async () => { ran.push('status'); return { ok: true }; } }, restart_service: { run: async (p) => { ran.push(p.service); return {}; } } },
    verifyCommand: createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch }),
  });
  await queue.tick();
  assert.deepEqual(ran, ['status']);
  assert.equal((await readCommand(dash.runtime, good)).status, 'done');
  const refused = await readCommand(dash.runtime, edited);
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error, 'refused: the params differ from the ones signed');
  assert.equal('signature' in refused, false, 'the signature is never shown');
});

test('views are open to members; changes are admin-only; unknown types and bad params are refused', async (t) => {
  const dash = await startDashboard({ fetch: fakeGoogle().fetch });
  t.after(dash.stop);
  for (const type of VIEW_COMMANDS) await sendCommand(dash.runtime, { type, user: member });
  for (const type of ADMIN_COMMANDS) {
    await assert.rejects(sendCommand(dash.runtime, { type, user: member }), (err) => err.status === 403);
  }
  await assert.rejects(sendCommand(dash.runtime, { type: 'shell', user: admin }), (err) => err.status === 400 && /no 'shell' command/.test(err.message));
  await assert.rejects(sendCommand(dash.runtime, { type: 'status', params: [1], user: admin }), (err) => err.status === 400);
});

test('reading a command refuses a bad id and reports a missing one', async (t) => {
  const dash = await startDashboard({ fetch: fakeGoogle().fetch });
  t.after(dash.stop);
  await assert.rejects(readCommand(dash.runtime, '../users/x'), (err) => err.status === 400);
  await assert.rejects(readCommand(dash.runtime, 'abc123'), (err) => err.status === 404);
});

test('a signing failure writes nothing', async (t) => {
  const dash = await startDashboard({ fetch: async () => ({ ok: false, status: 403, text: async () => 'denied' }) });
  t.after(dash.stop);
  await assert.rejects(sendCommand(dash.runtime, { type: 'status', user: admin }),
    (err) => err.status === 502 && /could not sign the command as paraclete-dashboard@your-gcp-project/.test(err.message));
  assert.ok(dash.lines.some((l) => l.level === 'ERROR' && /signing the command .+ failed \(403\)/.test(l.message)));
  assert.deepEqual(await dash.runtime.db.query('', 'commands', [], { noOrderBy: true, strict: true }), []);
});
