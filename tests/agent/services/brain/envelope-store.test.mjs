// Tests for agent/services/brain/envelope-store.mjs, against the Firestore fake through the real
// client: the invariants every save keeps, compare-and-swap updates and the durable claim, status
// changes through the transition table with their history, the brain's checkpoint and task pairs,
// and the Address a reply goes to.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient, StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { addressFor, addressMeta, addressOf, createEnvelopeStore, generateId } from '../../../../agent/services/brain/envelope-store.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let firestore;
let db;
let now;

before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => { firestore.reset(); now = NOW; });

const store = (over = {}) => createEnvelopeStore({ db, clock: () => now, defaultProjectId: () => 'general', claimStaleMs: 600_000, ...over });
const mission = (over = {}) => ({
  id: 'w-1', type: 'M', parent_id: null, status: 'queued', intent: 'decide', instruction: 'Do it', accept_criteria: null,
  source_channel: 'dashboard', source_meta: {}, children: [], created_at: '2026-10-17T11:00:00.000Z', updated_at: '2026-10-17T11:00:00.000Z', iteration: 0,
  ...over,
});
const history = async (id) => (await db.query(`${COLLECTIONS.work}/${id}`, 'history', [], { noOrderBy: true })).map((h) => [h.prev_status, h.new_status]);

test('ids are one plain, time-ordered path segment', () => {
  assert.match(generateId('w', () => 42), /^w-42-[0-9a-f]{8}$/);
  assert.notEqual(generateId(), generateId());
});

test('every save keeps the invariants: missions never nest, every mission has a project', async () => {
  const s = store();
  const nested = mission({ id: 'w-n', parent_id: 'w-other' });
  await s.save(nested);
  const saved = await s.read('w-n');
  assert.equal(saved.type, 'C', 'a nested mission is demoted');
  assert.equal(saved.delivery_status, 'internal');
  await s.save(mission({ id: 'w-r', parent_id: 'w-req', source_meta: { responsibility_id: 'r-x' } }));
  assert.equal((await s.read('w-r')).type, 'M', 'a responsibility\'s mission is the one parented mission');
  assert.equal((await s.read('w-r')).project_id, 'general');
});

test('a compare-and-swap update retries a lost race and never overwrites the winner', async () => {
  const s = store();
  await s.save(mission());
  let calls = 0;
  const result = await s.update('w-1', async (doc) => {
    calls += 1;
    if (calls === 1) await db.write(`${COLLECTIONS.work}/w-1`, { ...doc, context_forward: 'a concurrent answer' });
    return { ...doc, title: 'Renamed' };
  });
  assert.equal(calls, 2, 'the first attempt lost to the concurrent write and read again');
  const saved = await s.read('w-1');
  assert.equal(saved.title, 'Renamed');
  assert.equal(saved.context_forward, 'a concurrent answer', 'the concurrent write survives');
  assert.equal(result.title, 'Renamed');
  assert.equal(await s.update('w-missing', (d) => d), null);
  assert.equal(await s.update('w-1', () => null), null, 'a declined mutation writes nothing');
});

test('the claim is durable and exclusive: two processors never run one mission', async () => {
  const s = store();
  await s.save(mission({ status: 'active' }));
  const [a, b] = await Promise.all([s.claim('w-1'), s.claim('w-1')]);
  assert.equal([a, b].filter(Boolean).length, 1, 'exactly one claim wins');
  const winner = a || b;
  assert.equal((await s.read('w-1')).claimed_by, winner.claimId);
  assert.equal(await s.claim('w-1'), null, 'a live claim is refused');
  now += 600_001;
  assert.ok(await s.claim('w-1'), 'a stale claim is taken over');
});

test('a claim is declined when Firestore cannot say whether someone else holds it', async () => {
  const failing = { ...db, readDoc: async (path) => { throw new StoreUnavailable('read', path, 503, 'down'); } };
  const logs = [];
  const s = createEnvelopeStore({ db: failing, clock: () => now, log: (level, msg) => logs.push(msg) });
  assert.equal(await s.claim('w-1'), null);
  assert.match(logs.join('\n'), /whether another processor holds it is unknown/);
});

test('release clears only this processor\'s claim, and only the claim fields', async () => {
  const s = store();
  await s.save(mission({ status: 'active' }));
  const { claimId } = await s.claim('w-1');
  await s.release('w-1', 'claim-someone-else');
  assert.equal((await s.read('w-1')).claimed_by, claimId);
  await s.release('w-1', claimId);
  const saved = await s.read('w-1');
  assert.equal(saved.claimed_by, null);
  assert.equal(saved.instruction, 'Do it');
  const patch = firestore.requests.filter((r) => r.method === 'PATCH' && r.query?.includes('updateMask')).pop();
  assert.match(patch.query, /claimed_by/);
});

test('status changes go through the transition table and are recorded', async () => {
  const s = store();
  const env = mission({ status: 'awaiting_approval', started_at: '2026-10-17T11:00:00.000Z' });
  await s.save(env);
  assert.equal(await s.setStatus(env, 'complete', 'done', { event: { output: 'ok' } }), true);
  assert.equal(env.status, 'complete');
  assert.equal(env.completed_at, new Date(NOW).toISOString());
  assert.deepEqual((await history('w-1')).sort(), [['active', 'complete'], ['awaiting_approval', 'active']], 'a paused envelope passes through active');
  assert.equal(await s.setStatus(env, 'complete', 'again'), false, 'the same status is a no-op');
  assert.throws(() => s.move(env, 'active'), /illegal envelope transition/, 'a finished envelope is never reopened');
  const observing = store({ transitionGuard: 'observe' });
  const other = mission({ status: 'complete' });
  assert.deepEqual(observing.move(other, 'active'), [['complete', 'active']], 'observe applies it and only logs');
});

test('a checkpoint and task pair is written once per key, addressed like its mission', async () => {
  const s = store();
  const parent = mission({ source_meta: { address: { channel: 'dashboard', thread: 'th-1' }, sender: 'person@example.com', paused_task_index: 3 } });
  await s.save(parent);
  const cp = await s.createCT(parent, {
    checkpointTitle: 'Acknowledge receipt', taskTitle: 'Write acknowledgment', taskOutput: 'On it.', taskIntent: 'ack',
    deliveryStatus: 'pending', deliveryAddress: { channel: 'dashboard', thread: 'th-1' }, ctKey: 'ack-w-1',
  });
  await s.save(parent);
  const again = await s.createCT(parent, { checkpointTitle: 'x', taskTitle: 'y', taskOutput: 'z', ctKey: 'ack-w-1' });
  assert.equal(again, cp, 'the same key returns the pair already written');
  const c = await s.read(cp);
  const t = await s.read(c.children[0]);
  assert.equal(c.source_meta.ct_key, 'ack-w-1');
  assert.equal(c.delivery_status, 'internal');
  assert.equal(t.delivery_status, 'pending');
  assert.deepEqual(t.delivery_address, { channel: 'dashboard', thread: 'th-1' });
  assert.deepEqual(t.source_meta, { address: { channel: 'dashboard', thread: 'th-1' }, sender: 'person@example.com' }, 'never the mission\'s resume state');
  assert.deepEqual(parent.children, [cp]);
});

test('the Address a reply goes to comes from source_meta, through the one Address reader', () => {
  assert.deepEqual(addressOf({ address: { channel: 'dashboard', thread: 'th-1' } }, 'dashboard'), { channel: 'dashboard', thread: 'th-1' });
  assert.deepEqual(addressOf({ address: { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/B' } }, 'gchat'),
    { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/B' });
  assert.deepEqual(addressOf({ spaceName: 'spaces/A', threadName: 't' }, 'gchat'), { channel: 'gchat', space: 'spaces/A', thread: 't' }, 'flat Chat fields still read');
  assert.deepEqual(addressOf(null, 'scheduler'), { channel: 'dashboard', thread: null }, 'no address goes to the dashboard');
  assert.deepEqual(addressOf({ paused_checkpoints: [{ tasks: [[1]] }] }, 'dashboard'), { channel: 'dashboard', thread: null }, 'only the address fields are read');
  assert.deepEqual(addressFor({ source_meta: { address: { channel: 'dashboard', thread: 'th-2' } }, source_channel: 'dashboard' }), { channel: 'dashboard', thread: 'th-2' });
  assert.deepEqual(addressMeta({ address: 1, sender: 2, paused_task_index: 3, effect_scope: 'memory' }), { address: 1, sender: 2 });
});

test('the library adapters address documents by collection and id', async () => {
  const s = store();
  await s.firestoreWrite(COLLECTIONS.responsibilityState, 'r-x', { id: 'r-x', prior_learnings: 'a' });
  assert.equal((await s.firestoreRead(COLLECTIONS.responsibilityState, 'r-x')).prior_learnings, 'a');
  await s.save(mission({ created_at: '2026-10-17T11:00:00.000Z' }));
  assert.equal((await s.firestoreQuery(COLLECTIONS.work, [{ field: 'status', op: 'EQUAL', value: { stringValue: 'queued' } }])).length, 1);
});
