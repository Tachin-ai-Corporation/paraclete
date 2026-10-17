// Tests for agent/services/brain/intake.mjs: each pending intake is claimed, its turn ledgered, checked
// for an approval reply, classified with its conversation and what is in flight, and routed. A
// respond may ground its draft on one read the brain offers; a failure puts the intake back, then
// fails it for good.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { createVertexText } from '../../../../agent/providers/vertex-text.mjs';
import { createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import { createGatewayClient } from '../../../../agent/services/brain/gateway-client.mjs';
import { brainSettings } from '../../../../agent/services/brain/settings.mjs';
import { createIntake, MAX_INTAKE_ATTEMPTS, RESPOND_READS } from '../../../../agent/services/brain/intake.mjs';
import { startFakeGateway } from './fake-gateway.mjs';
import { writeIntake } from './harness.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const settings = brainSettings(loadContracts());
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

const vertexText = createVertexText({ projectId: 'your-gcp-project', fetch: async () => { throw new Error('no network'); }, getAccessToken: async () => 't', logger: () => {} });

async function setup({ classify, compose = 'Grounded.', approval = null, ack = 'On it.' } = {}) {
  const gw = await startFakeGateway({
    respond: (turn) => {
      if (turn.user.includes('"mode":"classify"')) {
        if (classify instanceof Error) return { status: 500, error: classify.message };
        return typeof classify === 'function' ? classify(turn) : JSON.stringify(classify);
      }
      if (turn.user.includes('"mode":"respond_compose"')) return JSON.stringify({ reasoning: 'r', response: compose });
      return '';
    },
  });
  const store = createEnvelopeStore({ db, clock: () => NOW, defaultProjectId: () => 'general' });
  const calls = { handlers: [], recalls: [], acks: 0, approvals: 0 };
  const route = (name) => async (...args) => { calls.handlers.push([name, args]); };
  const intake = createIntake({
    db, store,
    gateway: createGatewayClient({ url: gw.url, token: gw.token }),
    enforceSchema: (raw, mode) => vertexText.enforceSchema(raw, mode),
    notifier: {
      extractCurrentMessage: (t) => t,
      generateAck: async () => { calls.acks += 1; return ack; },
    },
    memory: { recall: async (q, c) => { calls.recalls.push(c); return { recalled: calls.recalls.length === 1 ? 'ambient' : 'enriched' }; } },
    memoryFiles: { workingMemory: () => '', deepTruths: () => '' },
    handlers: { newMission: route('newMission'), attach: route('attach'), continueMission: route('continueMission'), cancel: route('cancel'), respond: route('respond') },
    approvalReplies: { handle: async () => { calls.approvals += 1; return approval; } },
    capabilityMap: () => '## motor\n- Shell',
    settings,
    clock: () => NOW,
  });
  return { gw, store, intake, calls, stop: () => gw.stop() };
}

test('only reads of the agent\'s own work can ground a respond', () => {
  assert.deepEqual(Object.keys(RESPOND_READS), ['recent_work']);
  assert.deepEqual(settings.respondReads, ['recent_work']);
});

test('a message is claimed, ledgered, classified with what is in flight, and routed to a new mission', async () => {
  const t = await setup({ classify: { classification: 'new_mission', reasoning: 'work', instruction: 'Write the report' } });
  try {
    await db.write(`${COLLECTIONS.work}/w-live`, { id: 'w-live', type: 'M', parent_id: null, status: 'blocked', instruction: 'Sync the calendar', blocker: 'no access', created_at: '2026-10-17T11:00:00.000Z' });
    await writeIntake(db, { text: 'Please write the report' });
    assert.equal(await t.intake.poll(), 1);
    const [name, [intake, decision, opts]] = t.calls.handlers[0];
    assert.equal(name, 'newMission');
    assert.equal(decision.instruction, 'Write the report');
    assert.equal(opts.ackText, 'On it.');
    assert.equal(intake._thread_key, 'th-1');
    assert.deepEqual(opts.memory, { recalled: 'ambient\n\n---\n\nenriched' }, 'mission-bound work gets a second, sharper recall');
    const classify = t.gw.turns[0];
    assert.match(classify.user, /"active_envelopes":\[\{"id":"w-live"[^\]]*"status":"blocked","blocker":"no access"/);
    assert.match(classify.user, /"respond_reads_available":\[\{"id":"recent_work"/);
    const turn = await db.read(`${COLLECTIONS.threads}/th-1/turns/m1`);
    assert.deepEqual([turn.role, turn.name, turn.text], ['user', 'Person', 'Please write the report']);
    assert.equal(t.calls.approvals, 1, 'checked for an approval reply first');
    assert.equal((await db.read(`${COLLECTIONS.intake}/i-dashboard-m1`)).status, 'claimed', 'the handler consumes it');
  } finally {
    await t.stop();
  }
});

test('an approval reply never reaches the classifier', async () => {
  const t = await setup({ approval: 'approved' });
  try {
    await writeIntake(db, { text: 'approve' });
    await t.intake.poll();
    assert.equal(t.gw.turns.length, 0);
    assert.equal(t.calls.handlers.length, 0);
  } finally {
    await t.stop();
  }
});

test('a Chat message brings its conversation with it', async () => {
  const t = await setup({ classify: { classification: 'attach', reasoning: 'follow-up', attach_to: 'w-1' } });
  try {
    await writeIntake(db, {
      id: 'i-gchat-spaces~A~messages~1', text: 'and the second one', source: 'gchat', thread: 'spaces/A/threads/T',
      extra: { conversation_ctx: JSON.stringify({ block: '## Conversation\n[agent] Two drafts are ready.', last_agent_text: 'Two drafts are ready.', cue_text: 'drafts' }) },
    });
    await t.intake.poll();
    assert.match(t.gw.turns[0].user, /"conversation_context":"## Conversation\\n\[agent\] Two drafts are ready\."/);
    assert.match(t.gw.turns[0].user, /"last_agent_reply":"Two drafts are ready\."/);
    assert.equal(t.calls.handlers[0][0], 'attach');
    assert.equal(t.calls.handlers[0][1][2].conversation, '## Conversation\n[agent] Two drafts are ready.');
  } finally {
    await t.stop();
  }
});

test('a respond grounded on its read is answered; a read the brain does not offer makes it a mission', async () => {
  const t = await setup({
    classify: (turn) => JSON.stringify(turn.user.includes('"inbound":{"text":"what did you do')
      ? { classification: 'respond', reasoning: 'r', response: 'Draft', reads: ['recent_work'] }
      : { classification: 'respond', reasoning: 'r', response: 'Draft', reads: ['agent_roster'] }),
    compose: 'This week I wrote two reports.',
  });
  try {
    await writeIntake(db, { text: 'what did you do this week?' });
    await t.intake.poll();
    assert.deepEqual(t.calls.handlers.map((h) => [h[0], h[1][2]]), [['respond', 'This week I wrote two reports.']]);
    assert.equal(t.calls.acks, 0, 'a respond needs no acknowledgment');
    assert.match(t.gw.turns[1].user, /\[TOOL RESULT: recent_work\]\\n## Recent Work/);

    await writeIntake(db, { id: 'i-dashboard-m2', text: 'who else works here?', at: '2026-10-17T12:01:00.000Z' });
    await t.intake.poll();
    assert.equal(t.calls.handlers[1][0], 'newMission', 'never sent ungrounded');
    assert.equal(t.calls.handlers[1][1][2].ackText, 'On it.');
  } finally {
    await t.stop();
  }
});

test('an intake that keeps failing is put back, then failed for good with the reason', async () => {
  const t = await setup({ classify: new Error('both models failed') });
  try {
    await writeIntake(db, { text: 'Please write the report' });
    for (let i = 1; i < MAX_INTAKE_ATTEMPTS; i++) {
      await t.intake.poll();
      const intake = await db.read(`${COLLECTIONS.intake}/i-dashboard-m1`);
      assert.deepEqual([intake.status, intake.retry_count], ['pending', i]);
    }
    await t.intake.poll();
    const failed = await db.read(`${COLLECTIONS.intake}/i-dashboard-m1`);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Failed 3 times: classification failed: "HTTP 500"/);
    assert.equal(await t.intake.poll(), 0);
  } finally {
    await t.stop();
  }
});

test('an intake a gone process had claimed goes back to pending, counted as an attempt', async () => {
  const t = await setup({ classify: { classification: 'new_mission', reasoning: 'r' } });
  try {
    await writeIntake(db, { text: 'x', extra: { status: 'claimed' } });
    await writeIntake(db, { id: 'i-dashboard-m2', text: 'y', extra: { status: 'consumed' } });
    await t.intake.recover();
    const back = await db.read(`${COLLECTIONS.intake}/i-dashboard-m1`);
    assert.deepEqual([back.status, back.retry_count], ['pending', 1]);
    assert.equal((await db.read(`${COLLECTIONS.intake}/i-dashboard-m2`)).status, 'consumed');
  } finally {
    await t.stop();
  }
});

test('the agent\'s own intakes get no acknowledgment', async () => {
  const t = await setup({ classify: { classification: 'new_mission', reasoning: 'r', instruction: 'x' } });
  try {
    await writeIntake(db, { text: 'internal note', source: 'system' });
    await t.intake.poll();
    assert.equal(t.calls.acks, 0);
    assert.equal(t.calls.handlers[0][1][2].ackText, null);
  } finally {
    await t.stop();
  }
});
