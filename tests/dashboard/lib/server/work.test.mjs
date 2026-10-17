// Tests for dashboard/lib/server/work.mjs, against the Firestore fake. The list tests seed envelopes in
// the shapes the brain writes. The detail tests let the agent's own checkpoint executor, approvals
// poller, history writer and archival sweep write a mission (agent/work/, agent/context/history.mjs),
// so the plan, the verdicts and the history are read back from exactly what the agent stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { createCheckpointExecutor } from '../../../../agent/work/checkpoint-executor.mjs';
import { createApprovalChecker } from '../../../../agent/work/approvals.mjs';
import { createArchivalSweeper } from '../../../../agent/work/archival.mjs';
import { buildSpine } from '../../../../agent/work/checkpoint-spine.mjs';
import { createHistoryWriter } from '../../../../agent/context/history.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { resolveApproval } from '../../../../dashboard/lib/server/approvals.mjs';
import {
  checkpointVerdict, getWork, listWork, outcomeOf, requesterOf,
} from '../../../../dashboard/lib/server/work.mjs';

const MEMBER = { email: 'member@example.com', role: 'member' };
const at = (minute, second = 0) => `2027-01-15T08:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;

/** An envelope in the shape the brain writes, with only what a test needs to say. */
const envelope = (id, over = {}) => ({
  id,
  type: 'M',
  parent_id: null,
  status: 'complete',
  intent: 'decide',
  title: `Mission ${id}`,
  instruction: `Do ${id}`,
  accept_criteria: null,
  output: null,
  error: null,
  children: [],
  source_channel: 'dashboard',
  source_meta: { sender: 'member@example.com', sender_name: 'Mem Ber', address: { channel: 'dashboard', thread: 'th-1' } },
  created_at: at(0),
  updated_at: at(0),
  iteration: 0,
  ...over,
});

const ids = (list) => list.missions.map((m) => m.id);

test('the work list shows missions only, newest first, in views by what they ended as', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  await dash.seed({
    'work/m-run': envelope('m-run', { status: 'active', created_at: at(10) }),
    'work/m-queued': envelope('m-queued', { status: 'queued', created_at: at(9) }),
    'work/m-ask': envelope('m-ask', { status: 'needs_input', output: 'Which quarter should the report cover?', created_at: at(8) }),
    'work/m-gate': envelope('m-gate', { status: 'awaiting_approval', created_at: at(7) }),
    'work/m-timer': envelope('m-timer', { status: 'waiting', wait_resume_at: at(40), created_at: at(6) }),
    'work/m-blocked': envelope('m-blocked', { status: 'blocked', blocker: 'No access to the shared drive', created_at: at(5) }),
    'work/m-done': envelope('m-done', { status: 'complete', completed_at: at(20), created_at: at(4) }),
    'work/m-archived-done': envelope('m-archived-done', { status: 'archived', archived_reason: 'delivered', created_at: at(3) }),
    'work/m-failed': envelope('m-failed', { status: 'failed', error: 'The upload failed', created_at: at(2) }),
    'work/m-archived-failed': envelope('m-archived-failed', { status: 'archived', archived_reason: 'stale_failed', created_at: at(1) }),
    'work/m-unanswered': envelope('m-unanswered', { status: 'archived', archived_reason: 'unanswered', created_at: at(0, 30) }),
    'work/m-reply': envelope('m-reply', { intent: 'respond', title: 'Chat reply: hello', created_at: at(11) }),
    'work/m-sched': envelope('m-sched', {
      parent_id: 'r-1', created_at: at(0), source_channel: 'scheduler',
      source_meta: { responsibility_id: 'nightly-digest', responsibility_name: 'Nightly digest' },
    }),
    'work/r-1': envelope('r-1', { type: 'R', created_at: at(0) }),
    'work/c-1': envelope('c-1', { type: 'C', parent_id: 'm-run', status: 'active', created_at: at(10, 5) }),
    'work/t-1': envelope('t-1', { type: 'T', parent_id: 'c-1', status: 'active', created_at: at(10, 6) }),
  });

  const all = await listWork(runtime);
  assert.deepEqual(ids(all), ['m-run', 'm-queued', 'm-ask', 'm-gate', 'm-timer', 'm-blocked', 'm-done', 'm-archived-done', 'm-failed', 'm-archived-failed', 'm-unanswered', 'm-sched']);
  assert.deepEqual(all.counts, { active: 2, waiting: 4 });
  assert.equal(all.next, null);

  assert.deepEqual(ids(await listWork(runtime, { view: 'active' })), ['m-run', 'm-queued']);
  const waiting = await listWork(runtime, { view: 'waiting' });
  assert.deepEqual(ids(waiting), ['m-ask', 'm-gate', 'm-timer', 'm-blocked']);
  const byId = Object.fromEntries(waiting.missions.map((m) => [m.id, m]));
  assert.equal(byId['m-ask'].waiting_for, 'Which quarter should the report cover?');
  assert.equal(byId['m-blocked'].waiting_for, 'No access to the shared drive');
  assert.equal(byId['m-timer'].wait_resume_at, at(40));

  const done = await listWork(runtime, { view: 'done' });
  assert.deepEqual(ids(done), ['m-done', 'm-archived-done', 'm-sched']);
  assert.deepEqual(done.missions.map((m) => [m.outcome, m.archived]), [['complete', false], ['complete', true], ['complete', false]]);
  const failed = await listWork(runtime, { view: 'failed' });
  assert.deepEqual(ids(failed), ['m-failed', 'm-archived-failed', 'm-unanswered']);
  assert.deepEqual(failed.missions.map((m) => m.outcome), ['failed', 'failed', 'unanswered']);
  assert.equal(failed.missions[0].error, 'The upload failed');

  // Quick replies are missions, but only shown on request.
  assert.equal(ids(await listWork(runtime, { replies: true }))[0], 'm-reply');

  // Who asked: a person, or the responsibility that fired it.
  assert.deepEqual(all.missions[0].requested_by, { kind: 'person', id: 'member@example.com', name: 'Mem Ber' });
  assert.deepEqual(all.missions.at(-1).requested_by, { kind: 'schedule', name: 'Nightly digest' });

  await assert.rejects(listWork(runtime, { view: 'everything' }), (err) => err.status === 400);
  await assert.rejects(listWork(runtime, { before: 'not-a-cursor' }), (err) => err.status === 400);
});

test('paging through the missions never skips or repeats one, even when several share a millisecond', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  // 620 missions, three to a millisecond; every hundredth (from the 8th) failed.
  const base = Date.parse('2027-01-01T00:00:00.000Z');
  const all = Array.from({ length: 620 }, (_, i) => envelope(`m-${String(i).padStart(4, '0')}`, {
    created_at: new Date(base + Math.floor(i / 3) * 1000).toISOString(),
    status: i % 100 === 7 ? 'failed' : 'complete',
  }));
  for (let i = 0; i < all.length; i += 400) {
    await runtime.db.commit(all.slice(i, i + 400).map((env) => ({ path: `work/${env.id}`, data: env })));
  }
  const expected = [...all]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : -1))
    .map((env) => env.id);

  const seen = [];
  let before;
  for (let calls = 0; calls < 40; calls++) {
    const page = await listWork(runtime, { before, limit: 47 });
    seen.push(...ids(page));
    before = page.next;
    if (!before) break;
  }
  assert.equal(before, null);
  assert.deepEqual(seen, expected);

  // A sparse view scans a bounded number of pages per call, and carries on where it stopped.
  const first = await listWork(runtime, { view: 'failed' });
  assert.deepEqual(ids(first), ['m-0607', 'm-0507', 'm-0407', 'm-0307', 'm-0207']);
  assert.ok(first.next);
  const second = await listWork(runtime, { view: 'failed', before: first.next });
  assert.deepEqual(ids(second), ['m-0107', 'm-0007']);
  assert.equal(second.next, null);
});

// ---- A mission written by the agent's own code ----

const toolLog = (...lines) => `\n\n---\n[TOOL EXECUTION LOG]\n${lines.join('\n')}\n[END TOOL LOG]`;
const did = (text) => ({ success: true, output: `${text}${toolLog('[TOOL] shell({"cmd":"ls"}) → ok')}`, durationMs: 1200 });
const pass = (caveat) => ({
  success: true,
  output: `Judged.${toolLog(`[TOOL] report_pass(${JSON.stringify({ reasoning: 'met', checks: [], ...(caveat ? { caveat } : {}) })}) → {"verdict":"PASS"}`)}`,
});
const fail = (evidence) => ({
  success: true,
  output: `Judged.${toolLog(`[TOOL] report_fail(${JSON.stringify({ reasoning: evidence, checks: [{ criterion: 'The report is on the shared drive', pass: false, evidence }], recommendation: 'Upload it again.' })}) → {"verdict":"FAIL"}`)}`,
});

const PLAN = [
  {
    instruction: 'Gather the regional numbers',
    accept_criteria: 'Every region has a number',
    tasks: [
      { agent: 'temporal-research', task: 'Find the regional numbers' },
      { agent: 'motor', task: 'Write numbers.csv' },
    ],
  },
  {
    instruction: 'Publish the report',
    accept_criteria: 'The report is on the shared drive',
    tasks: [
      { agent: 'motor', task: 'Ask for approval to publish the report', step_type: 'approval_gate' },
      { agent: 'motor', task: 'Upload report.md to the shared drive' },
    ],
  },
];

/** The brain's pieces that write a mission, wired to the dashboard's runtime (the same fake). */
async function agentWorld(t) {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  let clock = Date.parse('2027-01-15T09:00:00.000Z');
  const now = () => (clock += 1000);
  const history = createHistoryWriter({ firestoreWrite: (collection, id, data) => runtime.db.write(`${collection}/${id}`, data), now });
  const replies = { 'temporal-research': [did('North 12, South 9')], motor: [did('Wrote numbers.csv'), did('Uploaded report.md')], cerebellum: [pass('South is an estimate'), fail('The upload is not in the shared drive listing.')] };
  let n = 0;
  const executor = createCheckpointExecutor({
    db: runtime.db,
    callAgent: async (organ) => replies[organ].shift(),
    writeHistory: (...args) => history.write(...args),
    approvals: { create: (id, record) => runtime.db.write(`approvals/${id}`, record).then(Boolean) },
    generateId: (prefix) => `${prefix}-${String(++n).padStart(3, '0')}`,
    logger: () => {},
    clock: now,
  });
  const checker = createApprovalChecker({
    db: runtime.db,
    firestoreRead: (collection, id) => runtime.db.read(`${collection}/${id}`),
    firestoreWrite: (collection, id, data) => runtime.db.write(`${collection}/${id}`, data),
    writeHistory: (...args) => history.write(...args),
    recallMemory: async () => null,
    // What the brain does with an approval: continue the plan at the task after the gate.
    resumeCheckpointPlan: async (env) => {
      const meta = env.source_meta;
      await executor.executeCheckpoints(meta.paused_checkpoints, {
        envelope: env, startCpIndex: meta.paused_checkpoint_index, startTaskIndex: meta.paused_task_index + 1, savedResults: meta.paused_all_results,
      });
    },
    logger: () => {},
    checkEvery: 1,
    clock: now,
  });
  const mission = envelope('w-mission', {
    status: 'active',
    title: 'Quarterly regional report',
    instruction: 'Write the quarterly regional report and publish it',
    source_text: 'Please write the quarterly regional report and put it on the shared drive.',
    accept_criteria: 'The report covers every region and is on the shared drive',
    _cp_spine: buildSpine(PLAN, { now: new Date(clock).toISOString() }),
    created_at: new Date(clock).toISOString(),
    started_at: new Date(clock).toISOString(),
    updated_at: new Date(clock).toISOString(),
  });
  await runtime.db.write(`work/${mission.id}`, mission);
  await history.write(mission.id, null, 'active', 'brain', 'Created from a dashboard message');
  return { dash, runtime, executor, checker, mission };
}

test("a mission's detail: the plan with each checkpoint's verdict, its tasks, messages, gate and history", async (t) => {
  const { dash, runtime, executor, checker, mission } = await agentWorld(t);
  const out = await executor.executeCheckpoints(PLAN, { envelope: mission });
  assert.equal(out.paused, true);

  const paused = await getWork(runtime, 'w-mission');
  assert.equal(paused.envelope.status, 'awaiting_approval');
  assert.equal(paused.envelope.request, 'Please write the quarterly regional report and put it on the shared drive.');
  assert.equal(paused.envelope.settled, false);
  assert.deepEqual(paused.envelope.milestone_caveats, ['CP1: South is an estimate']);
  assert.equal(paused.parent, null);

  // The plan: checkpoint 1 passed with the verifier's caveat; checkpoint 2 paused at its gate.
  assert.deepEqual(paused.plan.map((cp) => [cp.n, cp.total, cp.spine_status, cp.attempts.length]), [[1, 2, 'complete', 1], [2, 2, 'pending', 1]]);
  const [cp1, cp2] = paused.plan;
  assert.equal(cp1.outcome, 'Gather the regional numbers');
  assert.equal(cp1.accept_criteria, 'Every region has a number');
  assert.equal(cp1.attempts[0].verdict.verdict, 'met_with_caveat');
  assert.deepEqual(cp1.attempts[0].verdict.caveats, ['South is an estimate']);
  assert.equal(cp1.attempts[0].verdict.summary, 'South is an estimate');
  assert.deepEqual(cp1.attempts[0].tasks.map((task) => [task.step, task.organ, task.status]), [[1, 'temporal-research', 'complete'], [2, 'motor', 'complete']]);
  assert.match(cp1.attempts[0].tasks[0].output.text, /^North 12, South 9/);
  assert.equal(cp1.attempts[0].tasks[0].output.clipped, false);
  assert.equal(cp2.attempts[0].status, 'awaiting_approval');
  assert.equal(cp2.attempts[0].verdict.verdict, 'pending');
  assert.deepEqual(cp2.attempts[0].tasks, []);
  assert.deepEqual(cp2.planned_tasks.map((task) => task.gate), [true, false]);

  // What it waits for, and the gate itself.
  assert.equal(paused.waiting.kind, 'approval');
  assert.equal(paused.waiting.approval.id, paused.waiting.approval_id);
  assert.equal(paused.waiting.approval.live, true);
  assert.equal(paused.approvals.length, 1);
  assert.match(paused.approvals[0].description, /Upload report\.md to the shared drive/);

  // The approval request the agent wrote for the person to read.
  assert.deepEqual(paused.messages.map((m) => [m.kind, m.delivery_status]), [['approval_gate', 'pending']]);
  assert.match(paused.messages[0].text.text, /Approval needed/);

  // The mission's own history, oldest first.
  assert.deepEqual(paused.history.map((h) => [h.from, h.to]), [[null, 'active'], ['active', 'awaiting_approval']]);
  assert.equal(paused.history[1].by, 'brain');

  // Approved from the dashboard; the agent resumes and the verifier fails the second milestone.
  await resolveApproval(runtime, { id: paused.waiting.approval_id, decision: 'approved', user: MEMBER });
  await checker.checkPending();
  const resumed = await getWork(runtime, 'w-mission');
  assert.equal(resumed.waiting, null);
  assert.equal(resumed.approvals[0].status, 'approved');
  assert.equal(resumed.approvals[0].resolved_by, 'member@example.com');
  const cp2Done = resumed.plan[1];
  assert.equal(cp2Done.spine_status, 'failed');
  assert.equal(cp2Done.attempts[0].status, 'failed');
  assert.equal(cp2Done.attempts[0].verdict.verdict, 'not_met');
  assert.match(cp2Done.attempts[0].verdict.summary, /The upload is not in the shared drive listing\./);
  assert.deepEqual(cp2Done.attempts[0].tasks.map((task) => [task.step, task.status]), [[2, 'complete']]);
  assert.deepEqual(resumed.history.map((h) => h.to), ['active', 'awaiting_approval', 'active']);

  // A checkpoint on its own page: its verdict, its tasks, its mission.
  const cpPage = await getWork(runtime, cp2Done.attempts[0].id);
  assert.equal(cpPage.envelope.type, 'C');
  assert.equal(cpPage.verdict.verdict, 'not_met');
  assert.deepEqual(cpPage.parent, { id: 'w-mission', type: 'M', title: 'Quarterly regional report', status: 'active', outcome: 'active' });
  assert.deepEqual(cpPage.children.map((c) => c.step), [2]);
  assert.equal(cpPage.plan, null);
  assert.deepEqual(cpPage.history.map((h) => h.to), ['active', 'awaiting_approval', 'active', 'failed']);

  // A task on its own page carries its whole output.
  const taskPage = await getWork(runtime, cp1.attempts[0].tasks[0].id);
  assert.equal(taskPage.envelope.organ, 'temporal-research');
  assert.match(taskPage.envelope.output.text, /\[TOOL EXECUTION LOG\]/);
  assert.equal(taskPage.parent.id, cp1.attempts[0].id);

  // The archival sweep archives finished checkpoints and tasks; what they ended as still reads.
  const archival = createArchivalSweeper({
    firestoreWrite: (collection, id, data) => runtime.db.write(`${collection}/${id}`, data),
    firestoreRead: (collection, id) => runtime.db.read(`${collection}/${id}`),
    firestoreQuery: (collection, filters, opts) => runtime.db.query('', collection, filters, opts),
    logger: () => {},
  });
  await archival.sweep();
  const archived = await getWork(runtime, 'w-mission');
  assert.equal(archived.plan[0].attempts[0].status, 'archived');
  assert.equal(archived.plan[0].attempts[0].outcome, 'complete');
  assert.equal(archived.plan[0].attempts[0].verdict.verdict, 'met_with_caveat');
  assert.deepEqual(archived.plan[0].attempts[0].tasks.map((task) => task.outcome), ['complete', 'complete']);
  assert.ok(await dash.doc(`work/${cp1.attempts[0].id}`));
});

test('verdicts read back from what the checkpoint executor records', () => {
  const mission = { _milestone_caveats: ['CP2: The totals were rounded.', 'CP3: x'] };
  const cp = (n, over) => ({ type: 'C', source_meta: { checkpoint: n }, ...over });
  assert.deepEqual(checkpointVerdict(cp(1, { status: 'complete', output: 'Checkpoint complete: 2 tasks' }), mission), { verdict: 'met', summary: '', caveats: [] });
  assert.deepEqual(checkpointVerdict(cp(2, { status: 'complete', output: 'Checkpoint complete: 2 tasks' }), mission).caveats, ['The totals were rounded.']);
  assert.equal(checkpointVerdict(cp(1, { status: 'complete', output: 'Skipped: no tasks left to run' }), mission).verdict, 'skipped');
  assert.equal(checkpointVerdict(cp(1, { status: 'failed', output: 'Checkpoint failed at task 1/2' }), mission).verdict, 'not_judged');
  assert.equal(checkpointVerdict(cp(1, {
    status: 'failed', needs_review: true, output: 'Checkpoint failed: milestone verification not passed (2/2 tasks ran)',
    _cp_digest: '[CHECKPOINT 1 DIGEST — x]\nStep 1.verify (cerebellum): FAILED — [CHECKPOINT VERIFICATION INCONCLUSIVE] No terminal PASS/FAIL verdict was returned',
  }), mission).verdict, 'inconclusive');
  assert.equal(checkpointVerdict(cp(1, { status: 'archived', archived_reason: 'stale_failed', output: 'Checkpoint failed: milestone verification not passed (1/1 tasks ran)' }), mission).verdict, 'not_met');
  assert.equal(checkpointVerdict(cp(1, { status: 'active' }), mission).verdict, 'pending');
  assert.equal(checkpointVerdict(cp(1, { status: 'cancelled' }), mission).verdict, 'none');
});

test('outcomes and requesters', () => {
  assert.equal(outcomeOf({ status: 'archived', archived_reason: 'child_complete' }), 'complete');
  assert.equal(outcomeOf({ status: 'archived', archived_reason: 'something new' }), 'archived');
  assert.equal(outcomeOf({ status: 'blocked' }), 'blocked');
  assert.equal(requesterOf({ source_meta: { sender: 'agent' } }), null);
  assert.equal(requesterOf({}), null);
});

test('an unknown envelope is a 404, a malformed id a 400, and an outage a 503', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  await assert.rejects(getWork(dash.runtime, 'w-nothing'), (err) => err.status === 404);
  await assert.rejects(getWork(dash.runtime, 'work/../users'), (err) => err.status === 400);
  const failing = {
    collections: { work: 'work', approvals: 'approvals' },
    log: () => {},
    db: {
      async read() { throw new StoreUnavailable('read', 'work/w-1', 500, 'down'); },
      async query() { throw new StoreUnavailable('query', 'work', 500, 'down'); },
    },
  };
  await assert.rejects(getWork(failing, 'w-1'), (err) => err.status === 503);
  await assert.rejects(listWork(failing), (err) => err.status === 503);
});
