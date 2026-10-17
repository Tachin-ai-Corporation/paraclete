// Tests for agent/services/brain/waits.mjs: a timed wait resumes when its time comes, to active (the
// one running status the transition table lets a wait move to), and never over a concurrent change.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { canTransition } from '../../../../agent/work/work-transitions.mjs';
import { createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import { createWaits, waitIsOver } from '../../../../agent/services/brain/waits.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

const waiting = (id, resumeAt, over = {}) => ({
  id, type: 'M', parent_id: null, status: 'waiting', intent: 'decide', instruction: 'Deploy', accept_criteria: null, source_channel: 'dashboard',
  source_meta: {}, children: [], created_at: '2026-10-17T11:00:00.000Z', started_at: '2026-10-17T11:00:00.000Z', updated_at: '2026-10-17T11:00:00.000Z',
  iteration: 2, wait_resume_at: resumeAt, resume_instruction: 'Check the deploy is healthy', ...over,
});

test('the decision: a timed wait resumes to active, which the table allows; queued it does not', () => {
  assert.equal(canTransition('waiting', 'active').allowed, true);
  assert.equal(canTransition('waiting', 'queued').allowed, false);
});

test('a wait is over at its resume time, and one without a readable time never is', () => {
  assert.equal(waitIsOver({ wait_resume_at: '2026-10-17T12:00:00.000Z' }, NOW), true);
  assert.equal(waitIsOver({ wait_resume_at: '2026-10-17T12:00:01.000Z' }, NOW), false);
  assert.equal(waitIsOver({ wait_resume_at: null }, NOW), false);
  assert.equal(waitIsOver({ wait_resume_at: 'soon' }, NOW), false);
});

test('only waits that are due resume, with their next step as the mission\'s first input', async () => {
  const store = createEnvelopeStore({ db, clock: () => NOW });
  await store.save(waiting('w-due', '2026-10-17T11:59:00.000Z'));
  await store.save(waiting('w-later', '2026-10-17T12:30:00.000Z'));
  await store.save(waiting('w-untimed', null));
  const resumed = await createWaits({ store, clock: () => NOW }).check();
  assert.deepEqual(resumed, ['w-due']);
  const due = await store.read('w-due');
  assert.equal(due.status, 'active');
  assert.equal(due.context_forward, '[RESUMED AFTER WAIT]\nCheck the deploy is healthy');
  assert.equal(due.wait_resume_at, null);
  assert.equal(due.resume_instruction, null);
  assert.equal(due.iteration, 3, 'a resume counts an iteration');
  assert.equal((await store.read('w-later')).status, 'waiting');
  assert.equal((await store.read('w-untimed')).status, 'waiting', 'the archival sweep ages those out, not this');
  const hist = await db.query(`${COLLECTIONS.work}/w-due`, 'history', [], { noOrderBy: true });
  assert.deepEqual(hist.map((h) => [h.prev_status, h.new_status]), [['waiting', 'active']]);
});

test('a wait cancelled at the same moment stays cancelled', async () => {
  const store = createEnvelopeStore({ db, clock: () => NOW });
  await store.save(waiting('w-1', '2026-10-17T11:59:00.000Z'));
  const racing = {
    ...store,
    update: (id, mutate) => store.update(id, async (doc) => {
      await db.write(`${COLLECTIONS.work}/${id}`, { ...doc, status: 'cancelled', cancelled_at: '2026-10-17T11:59:30.000Z', completed_at: '2026-10-17T11:59:30.000Z' });
      return mutate(doc);
    }),
  };
  assert.deepEqual(await createWaits({ store: racing, clock: () => NOW }).check(), []);
  assert.equal((await store.read('w-1')).status, 'cancelled');
});
