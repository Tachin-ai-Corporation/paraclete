// Tests for agent/services/mouth/main.mjs and its unit, paraclete-mouth.service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMouth, CHAT_SEND_SCOPES } from '../../../../agent/services/mouth/main.mjs';
import { createServiceRuntime } from '../../../../agent/services/service-runtime.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { fakeDb } from '../ears/fake-db.mjs';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');
/** An absolute POSIX path for the instance record, which requires one, on any OS. */
const posixPath = (p) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
const WORKSPACE = { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' };

function fakeRuntime({ workspace = null, db = fakeDb() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mouth-main-'));
  const logs = [];
  return {
    logs,
    root,
    runtime: {
      service: 'mouth',
      contracts: loadContracts(),
      instance: { project: 'your-gcp-project', agent_name: 'Paraclete', role: 'generic', workspace, endpoints: {} },
      log: (...a) => logs.push(a),
      db,
      collections: COLLECTIONS,
      paths: { data: { root } },
      firestoreHost: 'http://127.0.0.1:9',
      fetch: async () => { throw new Error('no network in unit tests'); },
      getAccessToken: async () => 'vm-token',
    },
  };
}

function recorder() {
  const sent = [];
  return { sent, deliver: async (addr, text, opts) => { sent.push({ addr, text, token: opts.token }); return true; } };
}

const vertexText = (answers = []) => ({ calls: [], async transform(...args) { this.calls.push(args); return answers.shift() ?? null; } });
const health = (root) => JSON.parse(readFileSync(join(root, 'services', 'mouth', 'health.json'), 'utf8'));

const envelope = (over = {}) => ({
  id: 'w-1', type: 'M', status: 'complete', intent: 'respond', output: 'Three invoices are overdue.', instruction: 'Which invoices are overdue?',
  created_at: '2026-10-17T11:59:00.000Z', delivery_status: 'pending', delivery_address: { channel: 'dashboard', thread: 'th-1' },
  source_channel: 'dashboard', source_meta: { address: { channel: 'dashboard', thread: 'th-1' }, sender: 'ana@example.com' }, ...over,
});

test('importing the service starts nothing; the mouth alone holds the send scope', async () => {
  const mod = await import('../../../../agent/services/mouth/main.mjs');
  assert.equal(typeof mod.createMouth, 'function');
  assert.ok(CHAT_SEND_SCOPES.includes('https://www.googleapis.com/auth/chat.messages'));
});

test('it wires from a real service runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mouth-runtime-'));
  const instancePath = join(dir, 'instance.json');
  writeFileSync(instancePath, JSON.stringify({
    project: 'your-gcp-project', region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete', role: 'generic',
    install_root: '/opt/paraclete', data_root: '/var/lib/paraclete', bucket: 'your-gcp-project-paraclete', workspace: WORKSPACE,
  }));
  const runtime = createServiceRuntime({ service: 'mouth', instancePath, getAccessToken: async () => 't', fetch: async () => ({ ok: false }), write: () => {} });
  const mouth = createMouth(runtime, { vertexText: vertexText() });
  assert.deepEqual(mouth.health.channels, ['dashboard', 'gchat']);
});

test('a poll voices and delivers a pending envelope, then records it in the health file', async () => {
  const db = fakeDb({ 'work/w-1': envelope() });
  const t = fakeRuntime({ db });
  const out = recorder();
  const vt = vertexText([JSON.stringify({ action: 'deliver', text: 'I checked: three invoices are overdue.' })]);
  const mouth = createMouth(t.runtime, { vertexText: vt, deliver: out.deliver, now: () => NOW });
  assert.equal(await mouth.tick(), 5_000);

  assert.deepEqual(out.sent, [{ addr: { channel: 'dashboard', thread: 'th-1' }, text: 'I checked: three invoices are overdue.', token: 'vm-token' }]);
  assert.match(vt.calls[0][1], /You are the voice of an AI agent named Paraclete\./, 'the installed voice prompt, with the agent name');
  assert.deepEqual(vt.calls[0][2], { maxTokens: 2000, temperature: 0.1, disableThinking: true });
  assert.equal(db.get('work/w-1').delivery_status, 'delivered');
  assert.equal(db.get('threads/th-1/turns/d-w-1').text, 'I checked: three invoices are overdue.');

  const h = health(t.root);
  assert.equal(h.service, 'mouth');
  assert.equal(h.delivered, 1);
  assert.equal(h.last_delivery_at, '2026-10-17T12:00:00.000Z');
  assert.equal(h.last_ok_at, '2026-10-17T12:00:00.000Z');
  assert.deepEqual(h.channels, ['dashboard']);
});

test('a failed queue read is recorded in the health file, not thrown', async () => {
  const db = fakeDb();
  db.fail('query');
  const t = fakeRuntime({ db });
  const mouth = createMouth(t.runtime, { vertexText: vertexText(), deliver: recorder().deliver, now: () => NOW });
  await mouth.tick();
  const h = health(t.root);
  assert.match(h.last_error, /fake outage/);
  assert.match(h.status_notes_error, /fake outage/);
  assert.equal(h.last_ok_at, null);
  assert.equal(h.beat_at, '2026-10-17T12:00:00.000Z');
});

test('Chat goes out with the Workspace token; without an account a Chat delivery fails for good', async () => {
  const chatEnv = envelope({ delivery_address: { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t' }, source_channel: 'gchat' });
  const withChat = fakeRuntime({ workspace: WORKSPACE, db: fakeDb({ 'work/w-1': chatEnv }) });
  const out = recorder();
  await createMouth(withChat.runtime, { vertexText: vertexText(), deliver: out.deliver, getChatToken: async () => 'chat-token', now: () => NOW }).tick();
  assert.equal(out.sent[0].token, 'chat-token');

  const db = fakeDb({ 'work/w-1': chatEnv });
  await createMouth(fakeRuntime({ db }).runtime, { vertexText: vertexText(), deliver: recorder().deliver, now: () => NOW }).tick();
  assert.equal(db.get('work/w-1').delivery_status, 'failed');
  assert.match(db.get('work/w-1').delivery_error, /Google Chat is not set up/);
});

test('start polls until stop', async () => {
  const t = fakeRuntime();
  const mouth = createMouth(t.runtime, { vertexText: vertexText(), deliver: recorder().deliver });
  const running = mouth.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mouth.stop();
  await running;
  assert.ok(existsSync(join(t.root, 'services', 'mouth', 'health.json')));
  assert.ok(t.logs.some(([, message]) => message === 'mouth heartbeat'));
});

test('against the local Firestore fake: a delivery writes the dashboard message in its exact shape', async () => {
  const firestore = await startFirestore();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mouth-fake-'));
    const instancePath = join(dir, 'instance.json');
    writeFileSync(instancePath, JSON.stringify({
      project: firestore.projectId, region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete', role: 'generic',
      install_root: '/opt/paraclete', data_root: posixPath(join(dir, 'data')),
      bucket: 'your-gcp-project-paraclete', endpoints: { firestore: firestore.origin },
    }));
    const runtime = createServiceRuntime({ service: 'mouth', instancePath, getAccessToken: async () => 'vm-token', write: () => {} });
    await runtime.db.write('work/w-1', envelope({
      context: { attachments_export: [{ name: 'report.pdf', size: 1234, gcsPath: 'files/out/w-1/report.pdf', contentType: 'application/pdf' }] },
    }));
    const mouth = createMouth(runtime, { vertexText: vertexText([JSON.stringify({ action: 'deliver', text: 'Three invoices are overdue; the report is attached.' })]), now: () => NOW });
    await mouth.tick();

    const messages = Object.entries(firestore.dump()).filter(([path]) => path.startsWith('messages/'));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0][1].fields, {
      text: { stringValue: 'Three invoices are overdue; the report is attached.' },
      sender: { stringValue: 'agent' },
      timestamp: { timestampValue: '2026-10-17T12:00:00.000Z' },
      processed: { booleanValue: true },
      sender_name: { stringValue: 'Paraclete' },
      thread_id: { stringValue: 'th-1' },
      attachments: { arrayValue: { values: [{ mapValue: { fields: {
        name: { stringValue: 'report.pdf' }, size: { integerValue: '1234' }, gcsPath: { stringValue: 'files/out/w-1/report.pdf' },
      } } }] } },
    });
    const env = await runtime.db.read('work/w-1');
    assert.equal(env.delivery_status, 'delivered');
    assert.equal(env.delivered_channel, 'dashboard');
    assert.equal((await runtime.db.read('threads/th-1/turns/d-w-1')).role, 'agent');
    assert.equal(mouth.health.last_error, null);
  } finally {
    await firestore.stop();
  }
});

test('the unit follows the services rules', () => {
  const unit = readFileSync(new URL('../../../../agent/services/mouth/paraclete-mouth.service', import.meta.url), 'utf8');
  for (const line of [
    'User=paraclete', 'ProtectSystem=strict', 'ReadOnlyPaths=/opt/paraclete /etc/paraclete', 'ReadWritePaths=/var/lib/paraclete',
    'PrivateTmp=yes', 'NoNewPrivileges=yes', 'Restart=always', 'ExecStart=/usr/bin/node /opt/paraclete/agent/services/mouth/main.mjs',
  ]) assert.ok(unit.split('\n').includes(line), `unit has ${line}`);
});
