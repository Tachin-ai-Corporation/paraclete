// dashboard/components/work/work-plan.js: how a checkpoint's steps read in a mission's plan: its tasks
// and its approval gates together, in step order, with each task keeping its own number. A task has a
// `work` envelope; an approval gate does not, and is read from the mission's `approvals` records (and,
// before the mission reaches it, from the checkpoint's `planned_tasks`). Pure: no React, no fetching.
// Used by WorkPlan.jsx, and tested in tests/dashboard/components/work/work-plan.test.mjs.

const GATE_BADGE = Object.freeze({
  pending: { state: 'pending', label: 'Awaiting approval', badge: 'badge-warn' },
  approved: { state: 'approved', label: 'Approved', badge: 'badge-ok' },
  rejected: { state: 'rejected', label: 'Rejected', badge: 'badge-danger' },
  stale: { state: 'stale', label: 'No longer needed', badge: 'badge-neutral' },
  planned: { state: 'planned', label: 'Approval gate', badge: 'badge-neutral' },
});

const instant = (value) => Date.parse(value || '') || 0;

/**
 * Which of the four states in the issue (or `planned`, before the mission reaches the gate) an
 * approval gate is in, with its badge label and class.
 *
 * @param {object|null|undefined} approval  from GET /api/work/:id `approvals`
 * @returns {{state: 'pending'|'approved'|'rejected'|'stale'|'planned', label: string, badge: string}}
 */
export function gateState(approval) {
  if (!approval) return GATE_BADGE.planned;
  if (approval.status === 'approved') return GATE_BADGE.approved;
  if (approval.status === 'rejected') return GATE_BADGE.rejected;
  if (approval.status === 'pending') return approval.live === false ? GATE_BADGE.stale : GATE_BADGE.pending;
  return { state: approval.status, label: String(approval.status), badge: 'badge-neutral' };
}

/**
 * One gate row for the plan, from its approval record and/or its planned step. Carries the gate's
 * state, who decided it (`resolved_by`) and when (`resolved_at`, or `requested_at` while pending), any
 * reason given with the decision, or why a pending gate is no longer needed (`stale_reason`).
 *
 * @param {object} o
 * @param {number|null} [o.step]      1-based step number in the checkpoint
 * @param {object|null} [o.approval]  from `approvals`, if the mission has reached the gate
 * @param {object|null} [o.planned]   from `checkpoint.planned_tasks`, if the plan still lists it
 * @returns {object}
 */
export function gateRow({ step = null, approval = null, planned = null } = {}) {
  const { state, label, badge } = gateState(approval);
  const stepNum = step ?? approval?.task ?? planned?.step ?? null;
  const resolved = state === 'approved' || state === 'rejected';
  return {
    kind: 'gate',
    key: approval?.id ? `gate-${approval.id}` : `gate-step-${stepNum ?? 'unknown'}`,
    id: approval?.id || null,
    step: stepNum,
    title: approval?.title || planned?.text || planned?.instruction || 'Approval gate',
    description: approval?.description || '',
    state,
    label,
    badge,
    resolved_by: resolved ? approval.resolved_by || 'someone' : null,
    resolved_at: resolved ? approval.resolved_at || null : null,
    requested_at: approval?.requested_at || null,
    reason: resolved ? approval.reason || null : null,
    stale_reason: state === 'stale' ? approval?.stale_reason || 'its mission moved on' : null,
    acted_on: resolved ? approval.acted_on === true : false,
  };
}

/**
 * The approvals that belong to one checkpoint attempt. Match by `checkpoint_id` first (the attempt's
 * envelope id, which `buildApprovalRecord` stamps on every gate); fall back to the 1-based checkpoint
 * number only on the latest attempt, for an approval record without a `checkpoint_id`. When two
 * approvals share a step in the same attempt, the later request wins.
 */
function approvalsForAttempt(checkpoint, attempt, approvals, isLatest) {
  const byStep = new Map();
  const list = Array.isArray(approvals) ? approvals : [];
  for (const approval of list) {
    if (!approval) continue;
    const matchesAttempt = approval.checkpoint_id
      ? approval.checkpoint_id === attempt?.id
      : isLatest && approval.checkpoint === checkpoint?.n;
    if (!matchesAttempt) continue;
    const step = Number.isInteger(approval.task) ? approval.task : null;
    const prev = byStep.get(step);
    if (!prev || instant(approval.requested_at) >= instant(prev.requested_at)) {
      byStep.set(step, approval);
    }
  }
  return byStep;
}

const byStepThenOrder = (a, b) => {
  const sa = Number.isInteger(a.step) ? a.step : Number.MAX_SAFE_INTEGER;
  const sb = Number.isInteger(b.step) ? b.step : Number.MAX_SAFE_INTEGER;
  return sa - sb || a.order - b.order;
};

/**
 * The rows of one checkpoint attempt, in step order: each task (`{ kind: 'task', step, task }`) and
 * each approval gate (`gateRow(...)`) in its place among the tasks. Each task keeps its own `task.step`
 * number (`Task 1`, `Gate 2`, `Task 3`), never renumbered by position.
 *
 * For the latest attempt (or a checkpoint that has not started an attempt yet), planned gates from
 * `checkpoint.planned_tasks` also appear when the mission already ran a task or raised an approval in
 * the checkpoint, or when the row list is asked to include planned gates. Earlier attempts show only
 * the tasks and gates that actually ran in that attempt.
 *
 * @param {object} checkpoint             one entry of `plan` from GET /api/work/:id
 * @param {object|null} attempt           one entry of `checkpoint.attempts`, or null before any attempt
 * @param {object[]} [approvals]          `approvals` from GET /api/work/:id
 * @param {{isLatest?: boolean}} [options]
 * @returns {Array<object>}
 */
export function attemptRows(checkpoint, attempt, approvals = [], { isLatest = true } = {}) {
  const tasks = Array.isArray(attempt?.tasks) ? attempt.tasks : [];
  const planned = Array.isArray(checkpoint?.planned_tasks)
    ? checkpoint.planned_tasks.map((p, i) => (p && typeof p === 'object' ? { ...p, step: Number.isInteger(p.step) ? p.step : i + 1 } : null)).filter(Boolean)
    : [];
  const plannedByStep = new Map(planned.map((p) => [p.step, p]));
  const gatesByStep = approvalsForAttempt(checkpoint, attempt, approvals, isLatest);

  const items = [];
  let order = 0;
  const taskSteps = new Set();
  for (const task of tasks) {
    if (!task) continue;
    if (Number.isInteger(task.step)) taskSteps.add(task.step);
    items.push({
      order: order++,
      step: Number.isInteger(task.step) ? task.step : null,
      row: { kind: 'task', key: task.id || `task-${order}`, step: task.step ?? null, task },
    });
  }

  const gateSteps = new Set();
  for (const [step, approval] of gatesByStep.entries()) {
    if (Number.isInteger(step)) gateSteps.add(step);
    items.push({
      order: order++,
      step,
      row: gateRow({ step, approval, planned: plannedByStep.get(step) || null }),
    });
  }

  // On the current attempt, a planned gate that has not been reached yet still sits in its step among
  // the tasks that have run (so a checkpoint with Task 1 done and Gate 2 next shows both in order).
  if (isLatest && (tasks.length > 0 || gatesByStep.size > 0)) {
    for (const planStep of planned) {
      if (!planStep?.gate) continue;
      if (gateSteps.has(planStep.step) || taskSteps.has(planStep.step)) continue;
      items.push({
        order: order++,
        step: Number.isInteger(planStep.step) ? planStep.step : null,
        row: gateRow({ step: planStep.step, approval: null, planned: planStep }),
      });
    }
  }

  items.sort(byStepThenOrder);
  return items.map((item) => item.row);
}
