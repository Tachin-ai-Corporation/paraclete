// Tests for agent/services/ears/main.mjs and its unit, paraclete-ears.service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEars, CHAT_READ_SCOPES } from '../../../../agent/services/ears/main.mjs';
import { createServiceRuntime } from '../../../../agent/services/service-runtime.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { fakeDb } from './fake-db.mjs';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');
/** An absolute POSIX path for the instance record, which requires one, on any OS. */
const posixPath = (p) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
const WORKSPACE = { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' };

function fakeRuntime({ workspace = null, db = fakeDb(), fetch } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ears-main-'));
  const logs = [];
  return {
    logs,
    root,
    runtime: {
      service: 'ears',
      contracts: loadContracts(),
      instance: { project: 'your-gcp-project', agent_name: 'Paraclete', role: 'generic', workspace, endpoints: {} },
      log: (...a) => logs.push(a),
      db,
      collections: COLLECTIONS,
      paths: { data: { root } },
      firestoreHost: 'http://127.0.0.1:9',
      fetch: fetch || (async () => { throw new Error('no network in unit tests'); }),
      getAccessToken: async () => 'vm-token',
    },
  };
}

const vertexText = (answer = null) => ({ calls: [], async transform(...args) { this.calls.push(args); return answer; } });
const health = (root) => JSON.parse(readFileSync(join(root, 'services', 'ears', 'health.json'), 'utf8'));

test('importing the service starts nothing', async () => {
  const mod = await import('../../../../agent/services/ears/main.mjs');
  assert.equal(typeof mod.createEars, 'function');
  assert.deepEqual(CHAT_READ_SCOPES.filter((s) => !s.endsWith('.readonly')), [], 'the ears never hold a send scope');
});

test('it wires from a real service runtime; without a Workspace account only the dashboard runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ears-runtime-'));
  const instancePath = join(dir, 'instance.json');
  writeFileSync(instancePath, JSON.stringify({
    project: 'your-gcp-project', region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete', role: 'generic',
    install_root: '/opt/paraclete', data_root: posixPath(join(dir, 'data')), bucket: 'your-gcp-project-paraclete',
  }));
  const runtime = createServiceRuntime({ service: 'ears', instancePath, getAccessToken: async () => 't', fetch: async () => ({ ok: false }), write: () => {} });
  const ears = createEars(runtime, { vertexText: vertexText() });
  assert.equal(ears.tickChat, null);
  assert.equal(ears.chat, null);
  assert.equal(ears.health.gchat.state, 'off');
});

test('a dashboard poll takes a message in and records the poll in the health file', async () => {
  const db = fakeDb({ 'messages/m1': {
    text: 'Draft the plan', timestamp: new Date(NOW), processed: false, sender: 'ana@example.com', sender_name: 'Ana', thread_id: 'th-1', attachments: [],
  } });
  const t = fakeRuntime({ db });
  const ears = createEars(t.runtime, { vertexText: vertexText(), now: () => NOW });
  assert.equal(await ears.tickDashboard(), t.runtime.contracts.ears.firestore_poll_ms);

  const intake = db.get('intake/i-dashboard-m1');
  assert.equal(intake.status, 'pending');
  assert.deepEqual(intake.source_meta.address, { channel: 'dashboard', thread: 'th-1' });
  assert.equal(db.get('messages/m1').processed, true);

  const h = health(t.root);
  assert.equal(h.service, 'ears');
  assert.equal(h.beat_at, '2026-10-17T12:00:00.000Z');
  assert.equal(h.dashboard.last_ok_at, '2026-10-17T12:00:00.000Z');
  assert.equal(h.dashboard.taken_in, 1);
  assert.equal(h.gchat.state, 'off');
});

test('a failed dashboard poll is recorded, not thrown, and the beat still lands', async () => {
  const db = fakeDb();
  db.fail('query');
  const t = fakeRuntime({ db });
  const ears = createEars(t.runtime, { vertexText: vertexText(), now: () => NOW });
  await ears.tickDashboard();
  const h = health(t.root);
  assert.match(h.dashboard.last_error, /fake outage/);
  assert.equal(h.dashboard.last_ok_at, null);
  assert.equal(h.beat_at, '2026-10-17T12:00:00.000Z');
});

test('with a Workspace account, Chat waits for its token, then takes in mentions alongside the dashboard', async () => {
  const long = `@Paraclete open the file_name report\n${'line\n'.repeat(4)}`;
  const chatFetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('/spaces/A/messages') ? { messages: [{
      name: 'spaces/A/messages/1', text: long, createTime: new Date(NOW + 1000).toISOString(),
      sender: { name: 'users/1', displayName: 'Ana' }, thread: { name: 'spaces/A/threads/t1' },
    }] } : {}),
  });
  const db = fakeDb();
  const t = fakeRuntime({ workspace: WORKSPACE, db, fetch: chatFetch });
  let tokenReady = false;
  const vt = vertexText(JSON.stringify({ cleaned: 'repaired', repairs: ['file_name'], confidence: 'high' }));
  const saved = [];
  const ears = createEars(t.runtime, {
    vertexText: vt,
    getChatToken: async () => { if (!tokenReady) throw new Error('invalid_grant'); return 'chat-token'; },
    discoverSpaces: async () => ['spaces/A'],
    resolveAgentUserId: async () => 'users/900',
    chatStore: { load: () => ({ cursors: { 'spaces/A': new Date(NOW).toISOString() }, seen: [], agentUserId: null }), save: (s) => saved.push(s) },
    preprocessPrompt: 'REPAIR',
    now: () => NOW,
  });
  assert.equal(ears.health.gchat.state, 'connecting');

  assert.equal(await ears.tickChat(), 30_000);
  assert.equal(health(t.root).gchat.last_error, 'waiting for the Workspace token');

  tokenReady = true;
  assert.equal(await ears.tickChat(), t.runtime.contracts.ears.gchat_poll_ms);
  await ears.chat.settle();
  const intake = db.get('intake/i-gchat-spaces~A~messages~1');
  assert.equal(intake.text, 'repaired', 'the repair pass ran on the Chat message');
  assert.equal(intake.source, 'gchat');
  assert.deepEqual(intake.source_meta.address, { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t1' });
  assert.equal(vt.calls[0][1], 'REPAIR');
  assert.deepEqual(vt.calls[0][2], { maxTokens: 2000, temperature: 0, disableThinking: true });

  const h = health(t.root);
  assert.equal(h.gchat.state, 'ready');
  assert.equal(h.gchat.taken_in, 1);
  assert.equal(h.gchat.spaces, 1);
  assert.equal(saved.at(-1).cursors['spaces/A'], new Date(NOW + 1000).toISOString());
});

test('start runs every channel loop until stop', async () => {
  const t = fakeRuntime({ workspace: WORKSPACE });
  let chatTicks = 0;
  const ears = createEars(t.runtime, {
    vertexText: vertexText(),
    getChatToken: async () => { chatTicks += 1; throw new Error('not yet'); },
    chatStore: { load: () => ({ cursors: {}, seen: [], agentUserId: null }), save: () => {} },
  });
  const running = ears.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await ears.stop();
  await running;
  assert.ok(chatTicks >= 1, 'the Chat loop ran');
  assert.ok(existsSync(join(t.root, 'services', 'ears', 'health.json')));
  assert.ok(t.logs.some(([, message, fields]) => message === 'ears starting' && fields.channels.length === 2));
});

test('against the local Firestore fake: a dashboard message becomes one intake, even when read twice', async () => {
  const firestore = await startFirestore();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ears-fake-'));
    const instancePath = join(dir, 'instance.json');
    writeFileSync(instancePath, JSON.stringify({
      project: firestore.projectId, region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete', role: 'generic',
      install_root: '/opt/paraclete', data_root: posixPath(join(dir, 'data')),
      bucket: 'your-gcp-project-paraclete', endpoints: { firestore: firestore.origin },
    }));
    const runtime = createServiceRuntime({ service: 'ears', instancePath, getAccessToken: async () => 'vm-token', write: () => {} });
    await runtime.db.write('messages/m1', {
      text: 'Draft the plan', timestamp: new Date(NOW), processed: false, sender: 'ana@example.com', sender_name: 'Ana',
      thread_id: 'th-1', attachments: [],
    });
    const ears = createEars(runtime, { vertexText: vertexText(), now: () => NOW });
    await ears.tickDashboard();
    const intake = await runtime.db.read('intake/i-dashboard-m1');
    assert.equal(intake.status, 'pending');
    assert.equal(intake.source_meta.sender, 'ana@example.com');
    assert.equal((await runtime.db.read('messages/m1')).processed, true);

    // The same message read again (its processed flag lost): the create-only write finds the intake.
    await runtime.db.patch('messages/m1', ['processed'], { processed: { booleanValue: false } });
    await runtime.db.patch('intake/i-dashboard-m1', ['status'], { status: { stringValue: 'claimed' } });
    const restarted = createEars(runtime, { vertexText: vertexText(), now: () => NOW + 600_000 });
    await restarted.tickDashboard();
    assert.equal((await runtime.db.read('intake/i-dashboard-m1')).status, 'claimed');
    assert.equal((await runtime.db.read('messages/m1')).processed, true);
    assert.equal(restarted.health.dashboard.last_error, null);
    assert.ok(firestore.requests.every((r) => r.token === 'vm-token'));
  } finally {
    await firestore.stop();
  }
});

test('the unit follows the services rules', () => {
  const unit = readFileSync(new URL('../../../../agent/services/ears/paraclete-ears.service', import.meta.url), 'utf8');
  for (const line of [
    'User=paraclete', 'ProtectSystem=strict', 'ReadOnlyPaths=/opt/paraclete /etc/paraclete', 'ReadWritePaths=/var/lib/paraclete',
    'PrivateTmp=yes', 'NoNewPrivileges=yes', 'Restart=always', 'ExecStart=/usr/bin/node /opt/paraclete/agent/services/ears/main.mjs',
  ]) assert.ok(unit.split('\n').includes(line), `unit has ${line}`);
});
