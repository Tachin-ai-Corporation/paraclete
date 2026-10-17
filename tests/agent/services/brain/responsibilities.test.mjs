// Tests for agent/services/brain/responsibilities.mjs: the scheduler's missions handed to the runner's
// queue, and the control service's "run now" triggers, each claimed once and closed with its outcome.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import { createResponsibilities } from '../../../../agent/services/brain/responsibilities.mjs';
import { eventually } from './harness.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

const daily = (id, over = {}) => ({ id, name: id, schedule: '0 8 * * *', enabled: true, triggerable: true, instruction: `Run the ${id} cycle`, success_criteria: 'The cycle ran to its end', ...over });

function setup(defaults) {
  const store = createEnvelopeStore({ db, clock: () => NOW, defaultProjectId: () => 'general' });
  const resp = createResponsibilities({
    db, store, contracts: loadContracts(), defaults: [{ source: 'generic', responsibilities: defaults }],
    recall: async () => ({ recalled: 'nothing' }), clock: () => NOW,
  });
  resp.scheduler.loadResponsibilities();
  return { store, resp };
}

const trigger = (id, responsibilityId, over = {}) => db.write(`${COLLECTIONS.responsibilityTriggers}/${id}`, {
  responsibility_id: responsibilityId, status: 'pending', bypass_spacing: true, requested_by: 'admin@example.com',
  requested_at: '2026-10-17T11:59:00.000Z', command_id: id, ...over,
});

test('a fired responsibility\'s mission joins the queue; it is never run in the scheduler\'s tick', async () => {
  const { resp } = setup([daily('r-a')]);
  assert.equal((await resp.fire('r-a', { bypassSpacing: true })).ok, true);
  const mission = await eventually(async () => (await db.query('', COLLECTIONS.work, [{ field: 'type', op: 'EQUAL', value: { stringValue: 'M' } }], { noOrderBy: true })).find((w) => w.status === 'queued'));
  assert.equal(mission.memory_context.recalled, 'nothing');
  const hist = await db.query(`${COLLECTIONS.work}/${mission.id}`, 'history', [], { noOrderBy: true });
  assert.deepEqual(hist.map((h) => [h.prev_status, h.new_status, h.agent]).sort(), [[null, 'pending', 'scheduler'], ['pending', 'queued', 'scheduler']]);
});

test('only triggerable responsibilities are offered to the cortex', () => {
  const { resp } = setup([daily('r-a'), daily('r-quiet', { triggerable: false }), daily('r-off', { enabled: false })]);
  assert.deepEqual(resp.triggerable().map((r) => r.id), ['r-a']);
});

test('a trigger is fired once and closed with its outcome; an unknown or refused one says why', async () => {
  const { resp } = setup([daily('r-a'), daily('r-single', { singleton: true })]);
  await trigger('cmd-1', 'r-a');
  await trigger('cmd-2', 'r-nope');
  await trigger('cmd-3', 'r-a', { status: 'fired' });
  const done = await resp.checkTriggers();
  assert.deepEqual(done.sort((a, b) => a.id.localeCompare(b.id)), [{ id: 'cmd-1', status: 'fired' }, { id: 'cmd-2', status: 'error' }]);
  const one = await db.read(`${COLLECTIONS.responsibilityTriggers}/cmd-1`);
  assert.deepEqual([one.status, one.detail, one.fired_at, one.requested_by], ['fired', 'r-a', '2026-10-17T12:00:00.000Z', 'admin@example.com']);
  assert.equal((await db.read(`${COLLECTIONS.responsibilityTriggers}/cmd-2`)).detail, "responsibility 'r-nope' not found");
  assert.deepEqual(await resp.checkTriggers(), [], 'nothing pending is fired again');

  // A singleton with a cycle in progress is skipped, not fired twice.
  await db.write(`${COLLECTIONS.work}/w-run`, { id: 'w-run', type: 'M', status: 'active', source_meta: { responsibility_id: 'r-single' }, created_at: '2026-10-17T11:00:00.000Z' });
  await trigger('cmd-4', 'r-single');
  await resp.checkTriggers();
  const skipped = await db.read(`${COLLECTIONS.responsibilityTriggers}/cmd-4`);
  assert.deepEqual([skipped.status, skipped.detail], ['skipped', 'a cycle is already in progress (w-run)']);
});

test('a trigger someone else claimed between the read and the claim is left to them', async () => {
  const { resp } = setup([daily('r-a')]);
  await trigger('cmd-1', 'r-a');
  const racing = { ...db, readDoc: async (path) => { const doc = await db.readDoc(path); await db.write(path, { ...doc.data, status: 'firing' }); return doc; } };
  const resp2 = createResponsibilities({ db: racing, store: createEnvelopeStore({ db, clock: () => NOW }), contracts: loadContracts(), defaults: [{ source: 'generic', responsibilities: [daily('r-a')] }], recall: async () => ({}), clock: () => NOW });
  resp2.scheduler.loadResponsibilities();
  assert.deepEqual(await resp2.checkTriggers(), []);
  assert.equal((await db.read(`${COLLECTIONS.responsibilityTriggers}/cmd-1`)).status, 'firing');
  assert.ok(resp);
});

test('a responsibility the agent just wrote is found by reading its store first', async () => {
  const { resp } = setup([]);
  await db.write(`${COLLECTIONS.responsibilities}/r-new`, { id: 'r-new', revision: 1, status: 'active', mode: 'own', body: daily('r-new') });
  const r = await resp.fire('r-new', { bypassSpacing: true });
  assert.equal(r.ok, true, JSON.stringify(r));
});
