// Tests for agent/services/brain/intake-handlers.mjs: what a classified message does. A new mission
// is queued; an answer resumes the mission that asked; a finished mission is never reopened, its
// follow-up is a new mission that carries it; a running mission is never written to from outside; a
// cancel stops work; a respond is answered at once. Every path consumes the intake.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { addressFor, createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import { createIntakeHandlers, filesBlock, stripChatFraming } from '../../../../agent/services/brain/intake-handlers.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

function setup({ running = null } = {}) {
  const store = createEnvelopeStore({ db, clock: () => NOW, defaultProjectId: () => 'general' });
  const calls = { cancels: [], statusUpdates: [], lines: [] };
  const handlers = createIntakeHandlers({
    db, store,
    generateTitle: async (text) => `Title: ${String(text).slice(0, 20)}`,
    memory: { writeMissionLine: async (e) => calls.lines.push(e.id) },
    projects: { get: (id) => (id === 'site' ? { id: 'site' } : undefined), getDefaultId: () => 'general' },
    writeStatusUpdate: async (id, message) => calls.statusUpdates.push([id, message]),
    runner: { activeMissionId: () => running, requestCancel: (id, reason) => calls.cancels.push([id, reason]) },
    addressFor,
  });
  return { store, handlers, calls };
}

const intake = (text, over = {}) => ({
  id: 'i-dashboard-m1', text, source: 'dashboard', attachments: [],
  source_meta: { address: { channel: 'dashboard', thread: 'th-1' }, raw_text: text, sender: 'person@example.com', sender_name: 'Person', channel_msg_id: 'm1' },
  ...over,
});
const mission = (id, status, over = {}) => ({
  id, type: 'M', parent_id: null, status, intent: 'decide', title: `Mission ${id}`, instruction: 'Write the report', accept_criteria: null,
  source_channel: 'dashboard', source_meta: { address: { channel: 'dashboard', thread: 'th-1' } }, children: [], project_id: 'general',
  created_at: '2026-10-17T11:00:00.000Z', started_at: '2026-10-17T11:00:00.000Z', updated_at: '2026-10-17T11:00:00.000Z', iteration: 2, ...over,
});
const intakeDoc = async (i) => { await db.write(`${COLLECTIONS.intake}/${i.id}`, { ...i, status: 'claimed' }); return i; };
const allWork = () => db.query('', COLLECTIONS.work, [], { noOrderBy: true });

test('chat framing is stripped, and shared files become a block the mission carries', () => {
  assert.equal(stripChatFraming('[Current message - respond to this]\nUser: please do it'), 'please do it');
  assert.equal(filesBlock([{ name: 'a.pdf', size: 10, gcsPath: 'files/in/a.pdf' }, {}]), '## Files shared with this request\n- a.pdf (10 bytes): files/in/a.pdf');
  assert.equal(filesBlock([]), '');
});

test('a new mission is queued with what the classifier read, acknowledged, and the intake consumed', async () => {
  const { handlers } = setup();
  const i = await intakeDoc(intake('Please write the quarterly report', { attachments: [{ name: 'q3.xlsx', size: 5, gcsPath: 'files/in/m1/q3.xlsx' }] }));
  const m = await handlers.newMission(i, {
    instruction: 'Write the Q3 report', accept_criteria: 'covers Q3', context_summary: 'Finance asked.', project_id: 'nope', stakes: 'destructive_or_public', job_to_be_done: 'board prep',
  }, { memory: { recalled: 'Q2 was similar' }, conversation: '## Conversation', ackText: 'On it.', sourceText: 'Please write the quarterly report' });
  const saved = await db.read(`${COLLECTIONS.work}/${m.id}`);
  assert.deepEqual([saved.status, saved.instruction, saved.project_id, saved.stakes, saved.delivery_status], ['queued', 'Write the Q3 report', 'general', 'routine', 'internal'],
    'an unknown project goes to the default, an unknown stakes level to routine');
  assert.match(saved.context_summary, /Finance asked\.\n\n## Files shared with this request\n- q3\.xlsx \(5 bytes\): files\/in\/m1\/q3\.xlsx/);
  assert.deepEqual(saved.context, { inbound_files: [{ name: 'q3.xlsx', size: 5, gcsPath: 'files/in/m1/q3.xlsx' }] });
  assert.deepEqual(saved.memory_context, { recalled: 'Q2 was similar' });
  assert.equal(saved.source_meta.sender, 'person@example.com');
  assert.equal(saved.children.length, 1, 'the acknowledgment');
  const ack = (await allWork()).find((w) => w.intent === 'ack');
  assert.deepEqual([ack.output, ack.delivery_status], ['On it.', 'pending']);
  const consumed = await db.read(`${COLLECTIONS.intake}/i-dashboard-m1`);
  assert.deepEqual([consumed.status, consumed.consumed_by], ['consumed', m.id]);
});

test('an answer resumes the mission that asked, and its next delivery starts afresh', async () => {
  const { handlers, store } = setup();
  await store.save(mission('w-q', 'needs_input', { output: 'Which quarter?', delivery_status: 'delivered', delivered_at: '2026-10-17T11:30:00.000Z', delivery_attempts: 1 }));
  const i = await intakeDoc(intake('Q3'));
  await handlers.attach(i, { attach_to: 'w-q', project_id: 'site' }, { conversation: '## Conversation\n[agent] Which quarter?' });
  const m = await store.read('w-q');
  assert.deepEqual([m.status, m.context_forward, m.project_id, m.conversation_context], ['active', 'Q3', 'site', '## Conversation\n[agent] Which quarter?']);
  assert.deepEqual([m.delivery_status, m.delivered_at, m.delivery_attempts], ['internal', null, 0]);
  assert.equal(m.iteration, 3, 'a resume counts an iteration');
  assert.equal((await allWork()).length, 1, 'no new mission');
  assert.equal((await db.read(`${COLLECTIONS.intake}/i-dashboard-m1`)).consumed_by, 'w-q');
});

test('a continue clears a blocker with the person\'s words; a finished mission gets a follow-up, never reopened', async () => {
  const { handlers, store } = setup();
  await store.save(mission('w-b', 'blocked', { blocker: 'No access', blocked_at: '2026-10-17T11:30:00.000Z', _swf_state: 'unblock_attempted' }));
  await handlers.continueMission(await intakeDoc(intake('I shared the drive with you')), { continue_mission: 'w-b', instruction: 'Retry with access' });
  const b = await store.read('w-b');
  assert.equal(b.status, 'active');
  assert.equal(b.blocker, null);
  assert.equal(b._swf_state, null);
  assert.equal(b.context_forward, '[UNBLOCKED] I shared the drive with you\n\n[REVISED INSTRUCTION] Retry with access');

  await store.save(mission('w-done', 'complete', { completed_at: '2026-10-17T11:40:00.000Z', output: 'Report v1 written', project_id: 'site' }));
  const follow = await handlers.continueMission(await intakeDoc(intake('Add the costs section', { id: 'i-dashboard-m2' })), { continue_mission: 'w-done', instruction: 'Add costs' });
  assert.equal((await store.read('w-done')).status, 'complete', 'a finished mission is never reopened');
  const f = await store.read(follow.id);
  assert.equal(f.status, 'queued');
  assert.match(f.context_summary, /This follows mission w-done \(complete\): Mission w-done\. Its outcome so far: Report v1 written/);
  assert.equal(f.project_id, 'site', 'the follow-up stays in the earlier mission\'s project');
});

test('work in flight: a status question gets a status reply, anything else a follow-up mission', async () => {
  const { handlers, store } = setup({ running: 'w-run' });
  await store.save(mission('w-run', 'active', { claimed_by: 'claim-1', claimed_at_ms: NOW }));
  await handlers.attach(await intakeDoc(intake('how is it going?')), { attach_to: 'w-run' });
  const reply = (await allWork()).find((w) => w.intent === 'status_check');
  assert.deepEqual([reply.parent_id, reply.delivery_status], ['w-run', 'pending']);
  assert.match(reply.output, /I'm still working on that: "Mission w-run"\. Status: active/);
  const follow = await handlers.attach(await intakeDoc(intake('also add a chart', { id: 'i-dashboard-m3' })), { attach_to: 'w-run', instruction: 'Add a chart' });
  assert.notEqual(follow.id, 'w-run');
  assert.equal((await store.read('w-run')).context_forward, undefined, 'the running mission is never written to from outside');
});

test('a mission the runner already holds is not resumed under it: the answer becomes a follow-up', async () => {
  const { handlers, store } = setup();
  await store.save(mission('w-q', 'needs_input', { claimed_by: 'claim-x', claimed_at_ms: NOW }));
  const r = await handlers.attach(await intakeDoc(intake('Q3')), { attach_to: 'w-q' });
  assert.notEqual(r.id, 'w-q');
  assert.equal((await store.read('w-q')).status, 'needs_input');
});

test('a target that is not a mission is ignored: the message becomes a new mission', async () => {
  const { handlers, store } = setup();
  await store.save({ ...mission('w-t', 'complete'), type: 'T', parent_id: 'w-c', completed_at: '2026-10-17T11:40:00.000Z' });
  const r = await handlers.continueMission(await intakeDoc(intake('again')), { continue_mission: 'w-t' });
  assert.notEqual(r.id, 'w-t');
});

test('cancel: a running mission is stopped by its runner, any other is cancelled here with its children', async () => {
  const { handlers, store, calls } = setup({ running: 'w-run' });
  await store.save(mission('w-run', 'active'));
  await handlers.cancel(await intakeDoc(intake('stop that')), { cancel_target: 'w-run', reasoning: 'the person asked' });
  assert.deepEqual(calls.cancels, [['w-run', 'the person asked']]);
  assert.equal((await store.read('w-run')).status, 'active', 'the runner stops it at its next decision');

  await store.save(mission('w-q', 'queued', { children: ['w-c'] }));
  await store.save({ ...mission('w-c', 'active'), type: 'C', parent_id: 'w-q', title: 'A checkpoint', accept_criteria: 'kept' });
  await handlers.cancel(await intakeDoc(intake('cancel the other one', { id: 'i-dashboard-m2' })), { cancel_target: 'w-q' });
  const q = await store.read('w-q');
  assert.deepEqual([q.status, q.cancelled_reason], ['cancelled', 'cancel the other one']);
  const c = await store.read('w-c');
  // Fixed defect: the cascade wrote a five-field document over each child, erasing it.
  assert.deepEqual([c.status, c.title, c.accept_criteria, c.cancelled_reason], ['cancelled', 'A checkpoint', 'kept', 'Parent w-q cancelled']);
  assert.deepEqual(calls.statusUpdates, [['w-q', '✅ Cancelled mission: "Mission w-q"']]);

  await store.save(mission('w-old', 'complete', { completed_at: '2026-10-17T11:00:00.000Z' }));
  await handlers.cancel(await intakeDoc(intake('cancel', { id: 'i-dashboard-m3' })), { cancel_target: 'w-old' });
  assert.equal((await store.read('w-old')).status, 'complete', 'finished work is left alone');
  assert.equal((await db.read(`${COLLECTIONS.intake}/i-dashboard-m3`)).status, 'consumed');
});

test('a respond is a mission complete on creation, delivered to the conversation', async () => {
  const { handlers, calls } = setup();
  const m = await handlers.respond(await intakeDoc(intake('hi!')), {}, 'Hello! What can I do for you?', { conversation: '## Conversation' });
  const saved = await db.read(`${COLLECTIONS.work}/${m.id}`);
  assert.deepEqual([saved.status, saved.intent, saved.output, saved.delivery_status], ['complete', 'respond', 'Hello! What can I do for you?', 'pending']);
  assert.deepEqual(saved.delivery_address, { channel: 'dashboard', thread: 'th-1' });
  assert.deepEqual(calls.lines, [m.id]);
  assert.equal((await db.read(`${COLLECTIONS.intake}/i-dashboard-m1`)).consumed_by, m.id);
});
