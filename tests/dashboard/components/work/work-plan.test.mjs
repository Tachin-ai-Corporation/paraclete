// Tests for dashboard/components/work/work-plan.js: how approval gates and tasks are ordered into rows
// for a checkpoint attempt, how each gate's state (pending, approved, rejected, or no longer needed)
// and decision details read, and against a real mission written by the agent's checkpoint executor and
// read back through getWork().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptRows, gateRow, gateState } from '../../../../dashboard/components/work/work-plan.js';
import { startDashboard } from '../../harness.mjs';
import { createCheckpointExecutor } from '../../../../agent/work/checkpoint-executor.mjs';
import { createApprovalChecker } from '../../../../agent/work/approvals.mjs';
import { buildSpine } from '../../../../agent/work/checkpoint-spine.mjs';
import { createHistoryWriter } from '../../../../agent/context/history.mjs';
import { resolveApproval } from '../../../../dashboard/lib/server/approvals.mjs';
import { getWork } from '../../../../dashboard/lib/server/work.mjs';

const task = (step, id = `t-${step}`, title = `Task ${step}`) => ({
  id,
  type: 'T',
  step,
  title,
  organ: 'motor',
  status: 'complete',
  outcome: 'complete',
});

const approval = (over = {}) => ({
  id: 'apr-1',
  mission_id: 'w-mission',
  checkpoint_id: 'cp-1',
  checkpoint: 1,
  task: 2,
  title: 'Approve publishing the report',
  description: 'If approved, this runs next: Upload report.md',
  status: 'pending',
  live: true,
  stale_reason: null,
  requested_at: '2027-01-15T09:01:00.000Z',
  resolved_by: null,
  resolved_at: null,
  reason: null,
  acted_on: false,
  ...over,
});

test('gateState and gateRow cover pending, approved, rejected, no longer needed, and planned gates', () => {
  assert.deepEqual(gateState(approval({ status: 'pending', live: true })), {
    state: 'pending',
    label: 'Awaiting approval',
    badge: 'badge-warn',
  });
  assert.deepEqual(gateState(approval({ status: 'approved', live: false })), {
    state: 'approved',
    label: 'Approved',
    badge: 'badge-ok',
  });
  assert.deepEqual(gateState(approval({ status: 'rejected', live: false })), {
    state: 'rejected',
    label: 'Rejected',
    badge: 'badge-danger',
  });
  assert.deepEqual(gateState(approval({ status: 'pending', live: false })), {
    state: 'stale',
    label: 'No longer needed',
    badge: 'badge-neutral',
  });
  assert.deepEqual(gateState(null), {
    state: 'planned',
    label: 'Approval gate',
    badge: 'badge-neutral',
  });

  const pendingRow = gateRow({ approval: approval({ status: 'pending', live: true }) });
  assert.equal(pendingRow.kind, 'gate');
  assert.equal(pendingRow.step, 2);
  assert.equal(pendingRow.state, 'pending');
  assert.equal(pendingRow.resolved_by, null);
  assert.equal(pendingRow.resolved_at, null);
  assert.equal(pendingRow.requested_at, '2027-01-15T09:01:00.000Z');

  const approvedRow = gateRow({
    approval: approval({
      status: 'approved',
      live: false,
      resolved_by: 'member@example.com',
      resolved_at: '2027-01-15T09:02:00.000Z',
      reason: 'Looks good to publish',
      acted_on: true,
    }),
  });
  assert.equal(approvedRow.state, 'approved');
  assert.equal(approvedRow.label, 'Approved');
  assert.equal(approvedRow.resolved_by, 'member@example.com');
  assert.equal(approvedRow.resolved_at, '2027-01-15T09:02:00.000Z');
  assert.equal(approvedRow.reason, 'Looks good to publish');
  assert.equal(approvedRow.acted_on, true);

  const rejectedRow = gateRow({
    approval: approval({
      status: 'rejected',
      live: false,
      resolved_by: 'admin@example.com',
      resolved_at: '2027-01-15T09:03:00.000Z',
      reason: 'Wait for Q4 sign-off',
    }),
  });
  assert.equal(rejectedRow.state, 'rejected');
  assert.equal(rejectedRow.label, 'Rejected');
  assert.equal(rejectedRow.resolved_by, 'admin@example.com');
  assert.equal(rejectedRow.resolved_at, '2027-01-15T09:03:00.000Z');
  assert.equal(rejectedRow.reason, 'Wait for Q4 sign-off');

  const staleRow = gateRow({
    approval: approval({
      status: 'pending',
      live: false,
      stale_reason: 'its mission is cancelled and no longer waiting for it',
    }),
  });
  assert.equal(staleRow.state, 'stale');
  assert.equal(staleRow.label, 'No longer needed');
  assert.equal(staleRow.stale_reason, 'its mission is cancelled and no longer waiting for it');
  assert.equal(staleRow.resolved_by, null);
});

test('attemptRows places an approval gate between Task 1 and Task 3 while keeping each task number', () => {
  const checkpoint = {
    n: 1,
    planned_tasks: [
      { organ: 'temporal-research', text: 'Draft the numbers', gate: false },
      { organ: 'motor', text: 'Ask for approval to publish the report', gate: true },
      { organ: 'motor', text: 'Upload the report', gate: false },
    ],
  };
  const attempt = {
    id: 'cp-1',
    tasks: [task(1, 't-1', 'Draft the numbers'), task(3, 't-3', 'Upload the report')],
  };
  const gates = [
    approval({
      status: 'approved',
      live: false,
      resolved_by: 'member@example.com',
      resolved_at: '2027-01-15T09:05:00.000Z',
    }),
  ];

  const rows = attemptRows(checkpoint, attempt, gates);
  assert.deepEqual(rows.map((r) => [r.kind, r.step]), [
    ['task', 1],
    ['gate', 2],
    ['task', 3],
  ]);
  assert.equal(rows[0].task.step, 1);
  assert.equal(rows[1].state, 'approved');
  assert.equal(rows[1].resolved_by, 'member@example.com');
  assert.equal(rows[1].resolved_at, '2027-01-15T09:05:00.000Z');
  assert.equal(rows[2].task.step, 3);
});

test('attemptRows separates gates across checkpoint attempts and shows planned gates on the current attempt', () => {
  const checkpoint = {
    n: 2,
    planned_tasks: [
      { organ: 'motor', text: 'Prepare release', gate: false },
      { organ: 'motor', text: 'Approve release', gate: true },
    ],
  };
  const attempt1 = { id: 'cp-2-a1', tasks: [task(1, 't-a1')] };
  const attempt2 = { id: 'cp-2-a2', tasks: [task(1, 't-a2')] };
  const gates = [
    approval({
      id: 'apr-a1',
      checkpoint_id: 'cp-2-a1',
      checkpoint: 2,
      task: 2,
      status: 'rejected',
      live: false,
      resolved_by: 'admin@example.com',
      resolved_at: '2027-01-15T09:02:00.000Z',
    }),
  ];

  // Earlier attempt gets only its own gate, not a planned placeholder.
  const earlierRows = attemptRows(checkpoint, attempt1, gates, { isLatest: false });
  assert.deepEqual(earlierRows.map((r) => [r.kind, r.step, r.state || r.task.id]), [
    ['task', 1, 't-a1'],
    ['gate', 2, 'rejected'],
  ]);

  // Latest attempt has run Task 1 and not yet raised its own gate: shows the planned gate at step 2,
  // and does not steal attempt 1's gate.
  const latestRows = attemptRows(checkpoint, attempt2, gates, { isLatest: true });
  assert.deepEqual(latestRows.map((r) => [r.kind, r.step, r.state || r.task.id]), [
    ['task', 1, 't-a2'],
    ['gate', 2, 'planned'],
  ]);
  assert.equal(latestRows[1].title, 'Approve release');
});

test('a mission run through the checkpoint executor and getWork() shows the gate row in its plan', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  let clock = Date.parse('2027-01-15T09:00:00.000Z');
  const now = () => (clock += 1000);
  const history = createHistoryWriter({
    firestoreWrite: (collection, id, data) => runtime.db.write(`${collection}/${id}`, data),
    now,
  });
  const toolLog = (line) => `

---
[TOOL EXECUTION LOG]
${line}
[END TOOL LOG]`;
  const did = (text) => ({ success: true, output: `${text}${toolLog('[TOOL] shell({"cmd":"ls"}) -> ok')}`, durationMs: 500 });
  const pass = () => ({
    success: true,
    output: `Judged.${toolLog(`[TOOL] report_pass(${JSON.stringify({ reasoning: 'met', checks: [] })}) -> {"verdict":"PASS"}`)}`,
  });
  const replies = {
    'temporal-research': [did('Drafted report.md')],
    motor: [did('Uploaded report.md')],
    cerebellum: [pass()],
  };
  let seq = 0;
  const plan = [
    {
      instruction: 'Draft and publish the report',
      accept_criteria: 'The report is published',
      tasks: [
        { agent: 'temporal-research', task: 'Draft report.md' },
        { agent: 'motor', task: 'Approve publishing report.md', step_type: 'approval_gate' },
        { agent: 'motor', task: 'Upload report.md' },
      ],
    },
  ];
  const executor = createCheckpointExecutor({
    db: runtime.db,
    callAgent: async (organ) => replies[organ].shift(),
    writeHistory: (...args) => history.write(...args),
    approvals: { create: (id, record) => runtime.db.write(`approvals/${id}`, record).then(Boolean) },
    generateId: (prefix) => `${prefix}-${String(++seq).padStart(3, '0')}`,
    logger: () => {},
    clock: now,
  });
  const checker = createApprovalChecker({
    db: runtime.db,
    firestoreRead: (collection, id) => runtime.db.read(`${collection}/${id}`),
    firestoreWrite: (collection, id, data) => runtime.db.write(`${collection}/${id}`, data),
    writeHistory: (...args) => history.write(...args),
    recallMemory: async () => null,
    resumeCheckpointPlan: async (env) => {
      const meta = env.source_meta;
      await executor.executeCheckpoints(meta.paused_checkpoints, {
        envelope: env,
        startCpIndex: meta.paused_checkpoint_index,
        startTaskIndex: meta.paused_task_index + 1,
        savedResults: meta.paused_all_results,
      });
    },
    logger: () => {},
    checkEvery: 1,
    clock: now,
  });

  const mission = {
    id: 'w-mission',
    type: 'M',
    parent_id: null,
    status: 'active',
    intent: 'decide',
    title: 'Publish the report',
    instruction: 'Draft and publish the report',
    accept_criteria: 'The report is published',
    output: null,
    error: null,
    children: [],
    source_channel: 'dashboard',
    source_meta: { sender: 'member@example.com', sender_name: 'Mem Ber', address: { channel: 'dashboard', thread: 'th-1' } },
    _cp_spine: buildSpine(plan, { now: new Date(clock).toISOString() }),
    created_at: new Date(clock).toISOString(),
    started_at: new Date(clock).toISOString(),
    updated_at: new Date(clock).toISOString(),
    iteration: 0,
  };
  await runtime.db.write(`work/${mission.id}`, mission);

  // Run until the gate pauses the mission after Task 1.
  const pausedOut = await executor.executeCheckpoints(plan, { envelope: mission });
  assert.equal(pausedOut.paused, true);

  const pausedView = await getWork(runtime, 'w-mission');
  const pausedCp = pausedView.plan[0];
  const pausedRows = attemptRows(pausedCp, pausedCp.attempts[0], pausedView.approvals);
  assert.deepEqual(pausedRows.map((r) => [r.kind, r.step]), [
    ['task', 1],
    ['gate', 2],
  ]);
  assert.equal(pausedRows[1].state, 'pending');
  assert.equal(pausedRows[1].title, 'Approve publishing report.md');

  // Decide the gate and resume: Task 3 runs, and the plan rows are Task 1, Gate 2 (approved), Task 3.
  await resolveApproval(runtime, {
    id: pausedView.waiting.approval_id,
    decision: 'approved',
    reason: 'Ready to share',
    user: { email: 'member@example.com' },
    now: new Date('2027-01-15T09:10:00.000Z'),
  });
  await checker.checkPending();

  const doneView = await getWork(runtime, 'w-mission');
  const doneCp = doneView.plan[0];
  const doneRows = attemptRows(doneCp, doneCp.attempts[0], doneView.approvals);
  assert.deepEqual(doneRows.map((r) => [r.kind, r.step]), [
    ['task', 1],
    ['gate', 2],
    ['task', 3],
  ]);
  assert.equal(doneRows[0].task.step, 1);
  assert.equal(doneRows[1].state, 'approved');
  assert.equal(doneRows[1].resolved_by, 'member@example.com');
  assert.equal(doneRows[1].resolved_at, '2027-01-15T09:10:00.000Z');
  assert.equal(doneRows[1].reason, 'Ready to share');
  assert.equal(doneRows[2].task.step, 3);
});
