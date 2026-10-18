// Tests for agent/services/brain/approval-replies.mjs: "approve" and "reject" in chat, recognized
// before any model classifies the message, resolving only the pending approvals of the reply's own
// conversation, and patching only the resolution fields. In Google Chat, only a sender the ears matched
// to a dashboard user may approve, and a reply stays inside its own space.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { addressFor, createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import {
  chatScopedApprovals, chooseTargets, createApprovalReplies, listApprovals, NOT_AUTHORIZED_REPLY, parseApprovalReply,
} from '../../../../agent/services/brain/approval-replies.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

test('an approval reply is read from the person\'s own line', () => {
  assert.deepEqual(parseApprovalReply('approve'), { decision: 'approved', userText: 'approve', numbers: [], all: false });
  assert.deepEqual(parseApprovalReply('approve 2 and 3'), { decision: 'approved', userText: 'approve 2 and 3', numbers: [2, 3], all: false });
  assert.equal(parseApprovalReply('approve all').all, true);
  assert.equal(parseApprovalReply('[Earlier]\nSomeone: hi\nUser: lgtm').decision, 'approved');
  assert.equal(parseApprovalReply('reject, the copy is wrong').decision, 'rejected');
  assert.equal(parseApprovalReply('no').decision, 'rejected');
  assert.equal(parseApprovalReply('now please write the report'), null);
  assert.equal(parseApprovalReply('Could you approve it?'), null, 'the reply must start with the decision');
});

test('which approvals a reply resolves', () => {
  const pending = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(chooseTargets([{ id: 'a' }], parseApprovalReply('yes')), [{ id: 'a' }]);
  assert.deepEqual(chooseTargets(pending, parseApprovalReply('approve all')), pending);
  assert.equal(chooseTargets(pending, parseApprovalReply('reject all')), null, '"all" approves only');
  assert.deepEqual(chooseTargets(pending, parseApprovalReply('approve 3')), [{ id: 'c' }]);
  assert.equal(chooseTargets(pending, parseApprovalReply('approve')), null);
  assert.equal(listApprovals([{ title: 'Deploy' }, { envelopeId: 'w-2' }]), '1. **Deploy**\n2. **w-2**');
});

async function seed(approvals) {
  const store = createEnvelopeStore({ db, clock: () => NOW });
  for (const [id, { missionStatus, ...a }] of Object.entries(approvals)) {
    await db.write(`${COLLECTIONS.approvals}/${id}`, {
      checkpointId: 'c', checkpointIndex: 0, taskIndex: 1, description: 'If approved, this runs next: deploy', projectName: '', project_id: '',
      source_channel: 'dashboard', requestedBy: 'person@example.com', status: 'pending', _processed: false, ...a,
    });
    await store.save({
      id: a.envelopeId, type: 'M', parent_id: null, status: missionStatus || 'awaiting_approval', intent: 'decide', instruction: 'x', accept_criteria: null,
      source_channel: 'dashboard', source_meta: {}, created_at: '2026-10-17T11:00:00.000Z', updated_at: '2026-10-17T11:00:00.000Z', iteration: 1,
    });
  }
  let checks = 0;
  const handler = createApprovalReplies({ db, store, approvals: { checkPending: async () => { checks += 1; } }, addressFor });
  return { store, handler, checks: () => checks };
}

const intake = (text, thread = 'th-1') => ({
  id: 'i-dashboard-m9', text, source: 'dashboard',
  source_meta: { address: { channel: 'dashboard', thread }, raw_text: text, sender: 'person@example.com' },
});

test('a plain message, or a "yes" with nothing pending, is not an approval reply', async () => {
  const { handler } = await seed({});
  assert.equal(await handler.handle(intake('write the report')), null);
  assert.equal(await handler.handle(intake('yes')), null);
});

test('one pending approval in the conversation: resolved by its fields only, a receipt, then acted on at once', async () => {
  const { handler, checks } = await seed({ 'apr-1': { envelopeId: 'w-1', title: 'Deploy to production', source_thread: 'th-1', requestedAt: '2026-10-17T11:50:00.000Z' } });
  await db.write(`${COLLECTIONS.intake}/i-dashboard-m9`, { status: 'claimed', text: 'approve' });
  assert.equal(await handler.handle(intake('approve')), 'approved');
  const a = await db.read(`${COLLECTIONS.approvals}/apr-1`);
  assert.deepEqual([a.status, a.resolvedBy, a._processed, a.title], ['approved', 'person@example.com', false, 'Deploy to production'],
    'only the resolution fields change; _processed stays for the poller');
  const patch = firestore.requests.find((r) => r.method === 'PATCH' && r.path.includes('/approvals/apr-1') && r.query.includes('updateMask'));
  assert.match(patch.query, /updateMask\.fieldPaths=status/);
  assert.match(patch.query, /resolvedBy/);
  assert.doesNotMatch(patch.query, /_processed/);
  const receipt = (await db.query('', COLLECTIONS.work, [{ field: 'intent', op: 'EQUAL', value: { stringValue: 'notification' } }], { noOrderBy: true }))[0];
  assert.deepEqual([receipt.type, receipt.parent_id, receipt.delivery_status, receipt.output], ['T', 'w-1', 'pending', '✅ Approved: Deploy to production. Resuming work.']);
  assert.deepEqual(receipt.delivery_address, { channel: 'dashboard', thread: 'th-1' });
  const i = await db.read(`${COLLECTIONS.intake}/i-dashboard-m9`);
  assert.deepEqual([i.status, i.resolution, i.approval_ids], ['resolved_approval', 'approved', ['apr-1']]);
  assert.equal(checks(), 1, 'the poller ran at once');
});

test('a reply resolves only its own conversation\'s gates', async () => {
  const { handler } = await seed({
    'apr-mine': { envelopeId: 'w-1', title: 'Mine', source_thread: 'th-1', requestedAt: '2026-10-17T11:00:00.000Z' },
    'apr-theirs': { envelopeId: 'w-2', title: 'Theirs', source_thread: 'th-2', requestedAt: '2026-10-17T11:01:00.000Z' },
  });
  assert.equal(await handler.handle(intake('approve all')), 'approved');
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-mine`)).status, 'approved');
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-theirs`)).status, 'pending', 'someone else\'s gate is never swept up');
});

test('several pending and no number: the person is asked which, and nothing is resolved', async () => {
  const { handler, checks } = await seed({
    'apr-b': { envelopeId: 'w-2', title: 'Second', source_thread: 'th-1', requestedAt: '2026-10-17T11:02:00.000Z' },
    'apr-a': { envelopeId: 'w-1', title: 'First', source_thread: 'th-1', requestedAt: '2026-10-17T11:01:00.000Z' },
  });
  assert.equal(await handler.handle(intake('approve')), 'disambiguation');
  const ask = (await db.query('', COLLECTIONS.work, [{ field: 'type', op: 'EQUAL', value: { stringValue: 'R' } }], { noOrderBy: true }))[0];
  assert.match(ask.output, /You have 2 pending approvals:\n\n1\. \*\*First\*\*\n2\. \*\*Second\*\*/);
  assert.equal(ask.parent_id, null);
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-a`)).status, 'pending');
  assert.equal(checks(), 0);
  assert.equal(await handler.handle(intake('approve 2')), 'approved');
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-b`)).status, 'approved', 'numbered oldest first');
});

test('a rejection carries its reason; a gate whose mission moved on is not offered', async () => {
  const { handler } = await seed({
    'apr-1': { envelopeId: 'w-1', title: 'Deploy', source_thread: 'th-1', requestedAt: '2026-10-17T11:00:00.000Z' },
    'apr-old': { envelopeId: 'w-gone', title: 'Old', source_thread: 'th-1', requestedAt: '2026-10-17T10:00:00.000Z', missionStatus: 'cancelled' },
  });
  assert.equal(await handler.handle(intake('reject: the copy still has the old prices')), 'rejected');
  const a = await db.read(`${COLLECTIONS.approvals}/apr-1`);
  assert.deepEqual([a.status, a.reason], ['rejected', 'reject: the copy still has the old prices']);
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-old`)).status, 'pending');
});

test('approvals that cannot be read leave the message to the classifier', async () => {
  const store = createEnvelopeStore({ db, clock: () => NOW });
  const failing = { ...db, query: async () => { throw new Error('unavailable'); } };
  const handler = createApprovalReplies({ db: failing, store, approvals: { checkPending: async () => {} }, addressFor });
  assert.equal(await handler.handle(intake('approve')), null);
});

// Chat: the dashboard's users list is the authority, and a reply stays inside its own space.
const SPACE = { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t1' };

async function seedChat(gates, users = { 'ana@example.com': 'member' }) {
  const store = createEnvelopeStore({ db, clock: () => NOW });
  for (const [email, role] of Object.entries(users)) await db.write(`${COLLECTIONS.users}/${email}`, { email, role });
  for (const [id, { address, ...a }] of Object.entries(gates)) {
    await db.write(`${COLLECTIONS.approvals}/${id}`, {
      checkpointId: 'c', checkpointIndex: 0, taskIndex: 1, description: 'If approved, this runs next: send it', projectName: '', project_id: '',
      source_channel: address.channel, source_thread: address.thread || '', requestedBy: 'users/1', requestedAt: '2026-10-17T11:00:00.000Z',
      status: 'pending', _processed: false, ...a,
    });
    await store.save({
      id: a.envelopeId, type: 'M', parent_id: null, status: 'awaiting_approval', intent: 'decide', instruction: 'x', accept_criteria: null,
      source_channel: address.channel, source_meta: { address }, created_at: '2026-10-17T11:00:00.000Z', updated_at: '2026-10-17T11:00:00.000Z', iteration: 1,
    });
  }
  let checks = 0;
  const handler = createApprovalReplies({ db, store, approvals: { checkPending: async () => { checks += 1; } }, addressFor });
  return { handler, checks: () => checks };
}

const chatIntake = (text, { address = SPACE, email = 'ana@example.com', sender = 'users/1' } = {}) => ({
  id: 'i-gchat-m9', text, source: 'gchat',
  source_meta: { address, raw_text: text, sender, sender_name: email || '', ...(email ? { sender_email: email } : {}) },
});

test('in Chat, a dashboard user approves the gate raised in the same space, and is recorded by email', async () => {
  const { handler, checks } = await seedChat({ 'apr-1': { envelopeId: 'w-1', title: 'Send the summary', address: SPACE } });
  await db.write(`${COLLECTIONS.intake}/i-gchat-m9`, { status: 'claimed', text: 'approve' });
  assert.equal(await handler.handle(chatIntake('approve')), 'approved');
  const a = await db.read(`${COLLECTIONS.approvals}/apr-1`);
  assert.deepEqual([a.status, a.resolvedBy], ['approved', 'ana@example.com']);
  const receipt = (await db.query('', COLLECTIONS.work, [{ field: 'intent', op: 'EQUAL', value: { stringValue: 'notification' } }], { noOrderBy: true }))[0];
  assert.deepEqual(receipt.delivery_address, SPACE, 'the receipt goes back to the Chat thread');
  assert.equal(checks(), 1);
});

test('in Chat, a sender who is not a known dashboard user is told how to approve, and nothing is resolved', async () => {
  const { handler, checks } = await seedChat({ 'apr-1': { envelopeId: 'w-1', title: 'Send the summary', address: SPACE } }, { 'old@example.com': 'guest' });
  await db.write(`${COLLECTIONS.intake}/i-gchat-m9`, { status: 'claimed', text: 'yes' });
  for (const intake of [
    chatIntake('yes', { email: null, sender: 'users/7' }),
    chatIntake('yes', { email: 'cy@example.com' }),
    chatIntake('yes', { email: 'old@example.com' }),
  ]) {
    assert.equal(await handler.handle(intake), 'not_authorized');
  }
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-1`)).status, 'pending');
  assert.equal(checks(), 0);
  const told = await db.query('', COLLECTIONS.work, [{ field: 'type', op: 'EQUAL', value: { stringValue: 'R' } }], { noOrderBy: true });
  assert.equal(told[0].output, NOT_AUTHORIZED_REPLY);
  assert.deepEqual(told[0].delivery_address, SPACE);
  const i = await db.read(`${COLLECTIONS.intake}/i-gchat-m9`);
  assert.deepEqual([i.status, i.resolution], ['resolved_approval', 'not_authorized']);
});

test('a Chat reply never reaches a gate raised in the dashboard or in another space, even the only one', async () => {
  const { handler } = await seedChat({
    'apr-dash': { envelopeId: 'w-1', title: 'Dashboard gate', address: { channel: 'dashboard', thread: 'th-1' } },
  });
  assert.equal(await handler.handle(chatIntake('approve')), null, 'nothing pending here: an ordinary message');
  const other = await seedChat({ 'apr-b': { envelopeId: 'w-2', title: 'Other space', address: { channel: 'gchat', space: 'spaces/B', thread: 'spaces/B/threads/x' } } });
  assert.equal(await other.handler.handle(chatIntake('approve')), null);
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-dash`)).status, 'pending');
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-b`)).status, 'pending');
  assert.deepEqual(chatScopedApprovals([{ id: 'x', _address: null }], SPACE), [], 'a gate whose mission could not be read is left out');
});

test('in a direct message, the gate raised there is approved; in a space, its own thread comes first', async () => {
  const DM = { channel: 'gchat', space: 'spaces/D' };
  const { handler } = await seedChat({
    'apr-dm': { envelopeId: 'w-1', title: 'From the direct message', address: DM },
    'apr-t1': { envelopeId: 'w-2', title: 'Thread one', address: SPACE },
    'apr-t2': { envelopeId: 'w-3', title: 'Thread two', address: { ...SPACE, thread: 'spaces/A/threads/t2' } },
  });
  assert.equal(await handler.handle(chatIntake('approve', { address: DM })), 'approved');
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-dm`)).status, 'approved');
  assert.equal(await handler.handle(chatIntake('approve')), 'approved');
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-t1`)).status, 'approved');
  assert.equal((await db.read(`${COLLECTIONS.approvals}/apr-t2`)).status, 'pending', 'the other thread\'s gate waits');
});
