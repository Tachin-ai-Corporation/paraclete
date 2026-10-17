// agent/work/checkpoint-spine.mjs: the pinned checkpoint skeleton of a mission. Builds it from a
// plan, records each checkpoint's verdict, re-plans one checkpoint without disturbing the others,
// and says when the mission may finalize. Pure: no I/O, no clock, no randomness; the caller supplies
// `now`. Running checkpoints is the checkpoint executor's job. Called by the checkpoint executor and
// by the brain's planning and finalize steps.
//
// A mission's checkpoint outcomes are stable; its task lists are not. Across retries the outcomes
// hold (gather inputs, create and fill, file) while task wording and criteria churn on every
// failure. When a failure re-derived the whole plan, one run re-ran a checkpoint that had passed
// seconds earlier, then blocked after more than a million input tokens.
//
// The spine pins what is stable so a failure re-plans only what failed. Completed checkpoints keep
// their verdict; the failed one gets new tasks; untouched ones keep the tasks they were given.
// Criteria are pinned too, with one refinement allowed. There is evidence both ways: a mission
// passed only after a criterion was reworded (so allow one), and another reworded four times
// without converging (so cap it).

/**
 * A checkpoint is complete when its milestone passed verification, or when the executor skipped it
 * because none of its tasks were left to run.
 */
const isComplete = (s) => Boolean(s) && s.status === 'complete';

/**
 * Complete, and so verified. A milestone that fails verification halts the mission: nothing proceeds
 * past it, so the executor never records a checkpoint complete over a milestone it could not
 * confirm.
 *
 * @param {object} entry - one spine entry
 * @returns {boolean}
 */
export const isVerified = (entry) => isComplete(entry);

/**
 * Build the spine from a freshly structured plan.
 *
 * @param {Array<{instruction?: string, accept_criteria?: string, tasks?: Array}>} checkpoints
 * @param {Object} [opts]
 * @param {string} [opts.now] - ISO timestamp, supplied by the caller
 * @returns {Array<Object>} spine entries, 1-indexed by `n`
 */
export function buildSpine(checkpoints, opts = {}) {
  const now = opts.now || '';
  return (checkpoints || []).map((cp, i) => ({
    n: i + 1,
    outcome: cp.instruction || `Checkpoint ${i + 1}`,
    accept_criteria: cp.accept_criteria || '',
    tasks: Array.isArray(cp.tasks) ? cp.tasks : [],
    status: 'pending',
    criteria_revisions: 0,
    created_at: now,
  }));
}

/**
 * Index (0-based) of the first checkpoint not yet complete, or -1 when the whole spine is done.
 * Checkpoints run in order, so this doubles as the executor's `startCpIndex`: completed work is
 * skipped by starting past it, which is why no separate skip mechanism is needed.
 *
 * @param {Array} spine
 * @returns {number}
 */
export function firstIncompleteIndex(spine) {
  if (!Array.isArray(spine)) return -1;
  return spine.findIndex((s) => !isComplete(s));
}

/**
 * Record a checkpoint's verdict. Called by the executor, which is the only thing that knows
 * whether a milestone actually passed.
 *
 * When the executor skips a checkpoint because every one of its tasks already completed (a
 * resumed mission), it must still mark the checkpoint complete here, every time. Otherwise
 * firstIncompleteIndex keeps returning the finished checkpoint, and a later re-plan restarts the
 * mission from it, re-running finished work in a loop. A skip is honest: a failed task or
 * milestone clears the step ledger so its tasks re-run, and only succeeded tasks are skipped.
 *
 * @param {Array} spine
 * @param {number} index - 0-based
 * @param {'complete'|'failed'} status
 * @param {Object} [opts]
 * @param {string} [opts.now]
 * @returns {Array} new spine (input not mutated)
 */
export function markCheckpoint(spine, index, status, opts = {}) {
  if (!Array.isArray(spine) || index < 0 || index >= spine.length) return spine || [];
  const now = opts.now || '';
  return spine.map((s, i) => (i === index
    ? { ...s, status, [status === 'complete' ? 'completed_at' : 'failed_at']: now }
    : s));
}

/**
 * Apply a scoped re-plan: swap in new tasks for one checkpoint, leaving every other checkpoint,
 * and every completed verdict, untouched.
 *
 * Criteria are pinned by default. A refinement is allowed only while
 * `criteria_revisions < maxCriteriaRevisions`; past that the pinned criteria stand and
 * `revisionRefused` is set, so the caller can log it rather than silently letting the target
 * drift a fifth time.
 *
 * @param {Array} spine
 * @param {number} index - 0-based checkpoint being re-planned
 * @param {Array} newTasks
 * @param {Object} [opts]
 * @param {string} [opts.newCriteria] - proposed replacement criteria (optional)
 * @param {number} [opts.maxCriteriaRevisions=1] - default; callers pass the contracts value
 * @param {boolean} [opts.pinCriteria=true]
 * @param {string} [opts.now]
 * @returns {{spine: Array, criteriaChanged: boolean, revisionRefused: boolean}}
 */
export function applyReplan(spine, index, newTasks, opts = {}) {
  const maxRev = opts.maxCriteriaRevisions ?? 1;
  const pin = opts.pinCriteria !== false;
  const now = opts.now || '';
  if (!Array.isArray(spine) || index < 0 || index >= spine.length) {
    return { spine: spine || [], criteriaChanged: false, revisionRefused: false };
  }

  const target = spine[index];
  const proposed = (opts.newCriteria || '').trim();
  const differs = proposed && proposed !== (target.accept_criteria || '').trim();
  let criteriaChanged = false;
  let revisionRefused = false;
  let criteria = target.accept_criteria;
  let revisions = target.criteria_revisions || 0;

  if (differs) {
    if (!pin) {
      criteria = proposed; criteriaChanged = true;      // pinning off: always accept
    } else if (revisions < maxRev) {
      criteria = proposed; criteriaChanged = true; revisions += 1;
    } else {
      revisionRefused = true;                            // hold the pinned wording
    }
  }

  const next = spine.map((s, i) => (i === index
    ? {
      ...s,
      tasks: Array.isArray(newTasks) && newTasks.length > 0 ? newTasks : s.tasks,
      accept_criteria: criteria,
      criteria_revisions: revisions,
      status: 'pending',                                 // re-planned, so runnable again
      replanned_at: now,
    }
    : s));
  return { spine: next, criteriaChanged, revisionRefused };
}

/**
 * Turn the spine back into what the executor consumes.
 *
 * @param {Array} spine
 * @returns {{checkpoints: Array, startCpIndex: number, allComplete: boolean}}
 */
export function rebuildFromSpine(spine) {
  const s = Array.isArray(spine) ? spine : [];
  const checkpoints = s.map((e) => ({
    instruction: e.outcome,
    accept_criteria: e.accept_criteria,
    tasks: Array.isArray(e.tasks) ? e.tasks : [],
  }));
  const idx = firstIncompleteIndex(s);
  return {
    checkpoints,
    startCpIndex: idx < 0 ? s.length : idx,
    allComplete: s.length > 0 && idx < 0,
  };
}

/**
 * The finalize gate: a mission with a pinned spine must not be reported complete while its
 * deliverable checkpoint is unmet. The last spine entry is the deliverable (a delivery mission
 * ends with "report the staging URL"); if it is not complete, a plain synthesize would claim
 * success the work never reached. That is how a four-checkpoint delivery once ended `complete`
 * with three checkpoints pending and an empty deliverable.
 *
 * Returns null when finalize is allowed (no spine, or the terminal checkpoint is complete; a
 * mission may legitimately finish early). Otherwise returns the unmet checkpoints, so the caller
 * can escalate honestly (needs_input, or a synthesis that owns the failure) naming exactly what is
 * outstanding.
 *
 * @param {Array} spine
 * @returns {null | {unmet: Array<{n:number, outcome:string, status:string}>, terminal: {n:number, outcome:string}}}
 */
export function finalizeBlockedBySpine(spine) {
  const s = Array.isArray(spine) ? spine : [];
  if (s.length === 0) return null;                 // no spine: an answer-only mission, no gate
  const last = s[s.length - 1];
  if (isComplete(last)) return null;               // deliverable checkpoint done: finalize allowed
  const unmet = s.filter((e) => !isComplete(e))
    .map((e) => ({ n: e.n, outcome: e.outcome || `Checkpoint ${e.n}`, status: e.status || 'pending' }));
  return { unmet, terminal: { n: last.n, outcome: last.outcome || `Checkpoint ${last.n}` } };
}

/**
 * Whether every checkpoint has passed, in this decide loop, with nothing new from a person since:
 * the one state in which a new plan can only re-shape verified work. A decide loop's prior results
 * start empty and a resumed mission's first entry is the person's answer, so: checkpoint results
 * present (`checkpoint_step`) and no `human` entry after the last one. A spine that passed before
 * the mission paused for input does not count, because the answer may ask for more, so that
 * mission stays plannable.
 *
 * @param {Array} spine
 * @param {Array} priorResults - this decide loop's results, oldest first
 * @returns {boolean}
 */
export function passedThisRun(spine, priorResults) {
  if (!Array.isArray(spine) || spine.length === 0 || !spine.every(isVerified)) return false;
  let lastWork = -1;
  let lastHuman = -1;
  (Array.isArray(priorResults) ? priorResults : []).forEach((r, i) => {
    if (r && r.checkpoint_step) lastWork = i;
    if (r && r.agent === 'human') lastHuman = i;
  });
  return lastWork >= 0 && lastHuman < lastWork;
}

/**
 * One-line shape for logs and telemetry, e.g. "3cp done=1 failed=1 pending=1".
 *
 * @param {Array} spine
 * @returns {string}
 */
export function spineSummary(spine) {
  const s = Array.isArray(spine) ? spine : [];
  if (s.length === 0) return 'none';
  const done = s.filter(isComplete).length;
  const failed = s.filter((x) => x && x.status === 'failed').length;
  return `${s.length}cp done=${done} failed=${failed} pending=${s.length - done - failed}`;
}
