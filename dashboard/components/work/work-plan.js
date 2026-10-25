// dashboard/components/work/work-plan.js: how a mission's checkpoint plan places approval gates
// among its tasks, and how each gate row reads. An approval gate is a plan step (step_type:
// approval_gate) with no task envelope, so attempt.tasks skips its step number; its record lives in
// `approvals` (read by GET /api/work/:id through approvalsForMission in lib/server/approvals.mjs).
// Pure: no React, no fetching. Used by WorkPlan.jsx and tested by
// tests/dashboard/components/work/work-plan.test.mjs.

/** Badge label and tone for each state an approval gate can have on the mission page. */
export const GATE_BADGE = Object.freeze({
  pending: Object.freeze({ label: 'Pending', tone: 'warn' }),
  approved: Object.freeze({ label: 'Approved', tone: 'ok' }),
  rejected: Object.freeze({ label: 'Rejected', tone: 'danger' }),
  no_longer_needed: Object.freeze({ label: 'No longer needed', tone: 'neutral' }),
});

/**
 * The state of an approval gate on the mission page:
 *   - 'approved': a person approved it;
 *   - 'rejected': a person rejected it;
 *   - 'no_longer_needed': still pending, and its mission moved on, ended or was cancelled;
 *   - 'pending': waiting for a person's decision.
 *
 * @param {object|null|undefined} approval  an entry from GET /api/work/:id's `approvals`
 * @returns {'pending'|'approved'|'rejected'|'no_longer_needed'}
 */
export function gateState(approval) {
  if (!approval || typeof approval !== 'object') return 'pending';
  if (approval.status === 'approved') return 'approved';
  if (approval.status === 'rejected') return 'rejected';
  if (approval.live === false || Boolean(approval.stale_reason)) return 'no_longer_needed';
  return 'pending';
}

/**
 * One approval gate as a row in the checkpoint plan: its step number in the checkpoint, its title,
 * its state and badge, who decided it and when (or why it is no longer needed), and any reason.
 *
 * @param {object|null|undefined} approval  an entry from GET /api/work/:id's `approvals`
 * @param {{step?: number|null, title?: string, id?: string, state?: string}} [fallback]
 * @returns {object}
 */
export function gateRow(approval, fallback = {}) {
  const a = approval || {};
  const state = approval ? gateState(a) : (fallback.state || 'pending');
  const badge = GATE_BADGE[state] || GATE_BADGE.pending;
  const decided = state === 'approved' || state === 'rejected';
  const rawStep = Number.isInteger(a.task) ? a.task : (Number.isInteger(a.taskIndex) ? a.taskIndex + 1 : fallback.step);
  const step = Number.isInteger(rawStep) && rawStep > 0 ? rawStep : null;
  const resolvedBy = decided ? (a.resolved_by || a.resolvedBy || null) : null;
  const resolvedAt = decided ? (a.resolved_at || a.resolvedAt || null) : null;
  return {
    kind: 'gate',
    id: a.id || fallback.id || `gate-${step ?? 0}`,
    step,
    title: a.title || fallback.title || 'Approval gate',
    description: typeof a.description === 'string' ? a.description : '',
    state,
    badge: { ...badge },
    requested_by: a.requested_by || a.requestedBy || null,
    requested_at: a.requested_at || a.requestedAt || null,
    resolved_by: resolvedBy,
    resolved_at: resolvedAt,
    reason: a.reason || null,
    acted_on: Boolean(a.acted_on ?? a._processed),
    stale_reason: state === 'no_longer_needed' ? (a.stale_reason || 'its mission moved on') : null,
  };
}

/**
 * The rows of one checkpoint attempt, in step order: each task that ran (keeping its own number) and
 * each approval gate the attempt reached, in its place among the tasks.
 *
 * @param {object|null|undefined} attempt    an entry from `entry.attempts`
 * @param {object[]}              [approvals] `approvals` from GET /api/work/:id
 * @param {object|null}           [entry]     the checkpoint entry from `plan`
 * @returns {Array<object>}
 */
export function attemptRows(attempt, approvals = [], entry = null) {
  const tasks = Array.isArray(attempt?.tasks) ? attempt.tasks : [];
  const taskSteps = new Set(tasks.map((t) => t?.step).filter(Number.isInteger));
  const maxTaskStep = taskSteps.size > 0 ? Math.max(...taskSteps) : 0;
  const planned = Array.isArray(entry?.planned_tasks) ? entry.planned_tasks : [];
  const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
  const isLatest = attempts.length === 0 || attempts[attempts.length - 1]?.id === attempt?.id;
  const cpNum = Number.isInteger(entry?.n) ? entry.n : (Number.isInteger(attempt?.checkpoint) ? attempt.checkpoint : null);

  const gateByStep = new Map();
  const findStep = (a) => {
    const direct = Number.isInteger(a.task) ? a.task : (Number.isInteger(a.taskIndex) ? a.taskIndex + 1 : null);
    if (Number.isInteger(direct) && direct > 0) return direct;
    if (attempt?.approval_id && a.id === attempt.approval_id && Number.isInteger(attempt.approval_step) && attempt.approval_step > 0) {
      return attempt.approval_step;
    }
    const byTitle = planned.findIndex((p, i) => p?.gate && p.text && p.text === a.title && !gateByStep.has(i + 1));
    if (byTitle >= 0) return byTitle + 1;
    const anyPlanned = planned.findIndex((p, i) => p?.gate && !taskSteps.has(i + 1) && !gateByStep.has(i + 1));
    if (anyPlanned >= 0) return anyPlanned + 1;
    for (let s = 1; s < maxTaskStep; s++) {
      if (!taskSteps.has(s) && !gateByStep.has(s)) return s;
    }
    if (Number.isInteger(attempt?.approval_step) && attempt.approval_step > 0 && !gateByStep.has(attempt.approval_step)) {
      return attempt.approval_step;
    }
    return null;
  };

  for (const a of Array.isArray(approvals) ? approvals : []) {
    if (!a || typeof a !== 'object') continue;
    const cpId = a.checkpoint_id || a.checkpointId || null;
    const aCp = Number.isInteger(a.checkpoint) ? a.checkpoint : (Number.isInteger(a.checkpointIndex) ? a.checkpointIndex + 1 : null);
    const byApprovalId = Boolean(attempt?.approval_id && a.id === attempt.approval_id);
    const byCpId = Boolean(cpId && attempt?.id && cpId === attempt.id);
    const claimedByOther = attempts.some((other) => other?.id !== attempt?.id && (other?.approval_id === a.id || (cpId && other?.id === cpId)));
    const byCpNum = !cpId && isLatest && !claimedByOther && cpNum !== null && aCp === cpNum;
    if (!byApprovalId && !byCpId && !byCpNum) continue;

    const step = findStep(a);
    const plannedTitle = step && planned[step - 1]?.text ? planned[step - 1].text : '';
    const row = gateRow(a, { step, title: plannedTitle });
    gateByStep.set(row.step ?? row.id, row);
  }

  for (let i = 0; i < planned.length; i++) {
    const step = i + 1;
    if (!planned[i]?.gate || gateByStep.has(step) || taskSteps.has(step)) continue;
    const reached = attempt?.approval_step === step
      || maxTaskStep > step
      || (isLatest && attempt?.outcome === 'awaiting_approval' && gateByStep.size === 0 && step === maxTaskStep + 1);
    if (!reached) continue;
    const state = maxTaskStep > step ? 'approved' : attempt?.outcome === 'awaiting_approval' ? 'pending' : 'no_longer_needed';
    gateByStep.set(step, gateRow(null, {
      id: `gate-${attempt?.id || cpNum || 0}-${step}`,
      step,
      title: planned[i].text || 'Approval gate',
      state,
    }));
  }

  const taskRows = tasks.map((task) => ({
    kind: 'task',
    id: task.id,
    step: Number.isInteger(task.step) ? task.step : null,
    task,
  }));

  return [...taskRows, ...gateByStep.values()].sort((a, b) => (
    (a.step ?? Infinity) - (b.step ?? Infinity) || (a.kind === b.kind ? 0 : a.kind === 'gate' ? -1 : 1)
  ));
}
