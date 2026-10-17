// agent/work/work-transitions.mjs: the work envelope state machine: which status changes are legal,
// and a reducer that applies one and stamps the fields every change must carry. Pure: no Firestore,
// no clock, no logging; this decides and the caller writes. The record shapes live in
// work-schema.mjs. Called by the brain wherever an envelope's status changes.
//
// Without one table, which moves are legal is implicit in every place that assigns a status, each
// enforcing whatever its author remembered, and "can a complete envelope go back to active?" has
// no answer short of reading all of them. This is the answer, in one place to ask and one place to
// change.

import { ENVELOPE_STATUSES, TERMINAL_STATUSES } from './work-schema.mjs';

// Re-exported so a caller reasoning about the machine imports one module.
export { ENVELOPE_STATUSES, TERMINAL_STATUSES };

/**
 * The legal moves, keyed by current status.
 *
 * Read a row as "from here, these are the only places work can go". A status absent from every
 * row's target list is unreachable; a status whose row is empty is terminal.
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  // ---- Before execution ----
  // `pending` is the intake state; `planned` and `queued` are the two ways work waits its turn
  // (structure decided vs. structure pending).
  pending: ['planned', 'queued', 'active', 'cancelled'],
  planned: ['queued', 'active', 'cancelled'],
  queued: ['active', 'cancelled'],

  // ---- Executing ----
  // Every pause and every ending is reachable from `active`, and nothing else reaches them: work
  // must be running to stop running.
  active: [
    'waiting', 'awaiting_approval', 'needs_input', 'needs_review',
    'blocked', 'complete', 'failed', 'timed_out', 'cancelled',
  ],

  // ---- Paused: each resumes to active, or ages out ----
  // The brain owns the clock, so a timed wait resumes deterministically.
  waiting: ['active', 'timed_out', 'cancelled'],
  // An approval is the only pause that can end in `rejected`: a person said no.
  awaiting_approval: ['active', 'rejected', 'timed_out', 'cancelled'],
  needs_input: ['active', 'timed_out', 'cancelled'],
  needs_review: ['active', 'complete', 'rejected', 'cancelled'],

  // A blocker is a condition, not a verdict. Blocked work can be attempted again when the
  // condition changes; it is not required to fail.
  blocked: ['active', 'failed', 'cancelled'],

  // ---- Terminal ----
  // Archival is the only move left. Reopening a finished envelope would make its recorded outcome
  // describe work it did not produce.
  complete: ['archived'],
  failed: ['archived'],
  rejected: ['archived'],
  timed_out: ['archived'],
  cancelled: ['archived'],
  archived: [],
});

/** Statuses in which an envelope is actively consuming the brain. */
export const RUNNING_STATUSES = Object.freeze(['active']);

/** Statuses in which an envelope is paused and resumable. */
export const PAUSED_STATUSES = Object.freeze([
  'waiting', 'awaiting_approval', 'needs_input', 'needs_review', 'blocked',
]);

/** Fields a transition is required to supply, by target status. */
export const TRANSITION_REQUIREMENTS = Object.freeze({
  complete: ['completed_at'],
  failed: ['completed_at', 'error'],
  blocked: ['blocked_at', 'blocker'],
  cancelled: ['cancelled_at'],
  waiting: ['wait_resume_at'],
  rejected: ['completed_at'],
  timed_out: ['completed_at'],
});

/**
 * Is this move legal, and if not, why not.
 *
 * @param {string} from
 * @param {string} to
 * @returns {{ allowed: boolean, reason: string }}
 */
export function canTransition(from, to) {
  if (!ENVELOPE_STATUSES.includes(from)) {
    return { allowed: false, reason: `'${from}' is not a declared status` };
  }
  if (!ENVELOPE_STATUSES.includes(to)) {
    return { allowed: false, reason: `'${to}' is not a declared status` };
  }
  if (from === to) {
    // Idempotent re-writes are common (a retry re-asserting `active`) and are not a state change,
    // so they are permitted but reported as a no-op.
    return { allowed: true, reason: 'no-op' };
  }
  const targets = LEGAL_TRANSITIONS[from] || [];
  if (!targets.includes(to)) {
    return {
      allowed: false,
      reason: TERMINAL_STATUSES.includes(from) && from !== 'archived'
        ? `'${from}' is terminal: reopening it would make its recorded outcome describe work it did not produce`
        : `'${from}' → '${to}' is not a legal move (legal: ${targets.join(', ') || 'none'})`,
    };
  }
  return { allowed: true, reason: 'legal' };
}

/**
 * Apply a transition, returning a new envelope. Never mutates its input.
 *
 * The reducer owns the derived fields that every caller would otherwise set by hand and
 * occasionally forget: `started_at` on first activation, `completed_at` on every ending,
 * `iteration` on re-entry. A complete envelope without `completed_at` fails the work schema;
 * deriving it here means no caller can produce one.
 *
 * A transition that cannot supply a field TRANSITION_REQUIREMENTS declares for its target is
 * refused. The reducer fills a default where one is honest (an error message, a blocker), but a
 * wait's resume time has no honest default: a wait without one has nothing to end it.
 *
 * @param {object} envelope
 * @param {{ to: string, at: string, output?: string, error?: string,
 *           blocker?: string, blockerType?: string, reason?: string,
 *           resumeAt?: string, resumeInstruction?: string }} event
 * @returns {{ ok: boolean, envelope: object, changed: boolean, reason: string }}
 */
export function applyTransition(envelope, event) {
  const from = envelope?.status;
  const to = event?.to;
  const at = event?.at;

  if (!at) {
    return { ok: false, envelope, changed: false, reason: 'a transition must carry its timestamp' };
  }

  const verdict = canTransition(from, to);
  if (!verdict.allowed) {
    return { ok: false, envelope, changed: false, reason: verdict.reason };
  }
  if (verdict.reason === 'no-op') {
    return { ok: true, envelope, changed: false, reason: 'no-op' };
  }

  const next = { ...envelope, status: to, updated_at: at };

  // First activation stamps the start; later ones count as iterations. The distinction matters
  // because the iteration count is a health metric, and a resumed wait is not a fresh attempt.
  if (to === 'active') {
    if (!next.started_at) next.started_at = at;
    else if (PAUSED_STATUSES.includes(from)) next.iteration = (next.iteration || 0) + 1;
    // Re-entering execution clears the pause reason so a stale blocker cannot outlive the
    // condition that caused it.
    next.blocker = null;
    next.blocker_type = null;
    next.blocked_at = null;
    next.wait_resume_at = null;
    next.resume_instruction = null;
  }

  if (TERMINAL_STATUSES.includes(to) && to !== 'archived') {
    next.completed_at = at;
  }
  if (to === 'complete' && event.output !== undefined) next.output = event.output;
  if (to === 'failed' || to === 'timed_out') next.error = event.error || envelope.error || `envelope ${to}`;
  if (to === 'blocked') {
    next.blocked_at = at;
    next.blocker = event.blocker || envelope.blocker || 'unspecified blocker';
    next.blocker_type = event.blockerType || envelope.blocker_type || null;
  }
  if (to === 'cancelled') {
    next.cancelled_at = at;
    next.cancelled_reason = event.reason || envelope.cancelled_reason || null;
  }
  if (to === 'waiting') {
    next.wait_resume_at = event.resumeAt || envelope.wait_resume_at || null;
    next.resume_instruction = event.resumeInstruction || envelope.resume_instruction || null;
  }

  const missing = (TRANSITION_REQUIREMENTS[to] || []).filter((field) => next[field] == null);
  if (missing.length > 0) {
    return {
      ok: false,
      envelope,
      changed: false,
      reason: `'${to}' requires ${missing.join(', ')}${to === 'waiting' ? ' (pass resumeAt: a wait must say when it ends)' : ''}`,
    };
  }

  return { ok: true, envelope: next, changed: true, reason: 'applied' };
}

/** Every status reachable from `from` in any number of legal moves. */
export function reachableFrom(from) {
  const seen = new Set();
  const queue = [from];
  while (queue.length) {
    const s = queue.shift();
    for (const t of LEGAL_TRANSITIONS[s] || []) {
      if (!seen.has(t)) { seen.add(t); queue.push(t); }
    }
  }
  return [...seen];
}

/** True when no further move is possible. */
export function isTerminal(status) {
  return (LEGAL_TRANSITIONS[status] || []).length === 0;
}
