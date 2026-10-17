// agent/work/step-ledger.mjs: the step ledger, the record on a mission envelope (`step_ledger`) of
// which checkpoint tasks already ran, so a resumed plan replays a finished task instead of running it
// a second time. Pure: it returns new ledger data and never writes it; the checkpoint executor saves
// the envelope. Called by the checkpoint executor.
//
// A task is keyed by its place in the plan, not by its wording: the mission, the checkpoint, the
// task's position and organ, and the mission's iteration. A crash and resume within one iteration
// reaches the same keys, so finished work is replayed; a new iteration (a re-plan) reaches new keys,
// so re-planned work runs. Each entry names the task envelope that holds the full output (`ref`), so
// a replay can hand the verifier the real result instead of a stub.

import { createHash } from 'node:crypto';

/**
 * The ledger key of one checkpoint task.
 *
 * @param {string} missionId
 * @param {number} cpNum      - 1-based checkpoint number
 * @param {string} action     - what kind of step; checkpoint tasks use 'cp_task'
 * @param {string} [target]   - the step within the checkpoint, e.g. `${cpIndex}.${taskIndex}.${organ}`
 * @param {number|string} [iteration] - the mission's iteration; 0 or empty leaves it out
 * @returns {string} 16 hex characters
 */
export function deriveStepKey(missionId, cpNum, action, target = '', iteration = '') {
  const part = iteration ? `:${iteration}` : '';
  return createHash('sha256')
    .update(`${missionId}:${cpNum}:${action}:${target}${part}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * The ledger entry for a step that completed, or null. A failed step is not complete: it runs again.
 *
 * @param {object} ledger - the envelope's step_ledger
 * @param {string} key
 * @returns {object|null}
 */
export function completedStep(ledger, key) {
  const entry = ledger?.[key];
  return entry && entry.status === 'complete' ? entry : null;
}

/**
 * Records one step's outcome. Returns a new ledger; the input is not mutated.
 *
 * @param {object} ledger - the current step_ledger (may be undefined)
 * @param {string} key
 * @param {object} outcome
 * @param {boolean} outcome.success
 * @param {string} [outcome.error]
 * @param {number} [outcome.durationMs]
 * @param {number} [outcome.cp]  - the owning checkpoint number, so a failed milestone can clear
 *   exactly its own entries without recomputing hashes
 * @param {string} [outcome.ref] - the task envelope id holding the step's full output
 * @param {string} [now] - ISO timestamp
 * @returns {object}
 */
export function recordStep(ledger, key, outcome, now = '') {
  return {
    ...(ledger || {}),
    [key]: {
      status: outcome.success ? 'complete' : 'failed',
      error: outcome.error || null,
      durationMs: outcome.durationMs || 0,
      timestamp: now,
      ...(outcome.cp != null ? { cp: outcome.cp } : {}),
      ...(outcome.ref ? { ref: outcome.ref } : {}),
    },
  };
}

/**
 * Drops every entry a checkpoint owns. A checkpoint whose milestone failed must run its tasks again
 * on the next attempt; replaying its entries would hand the verifier the same judged-wrong work, and
 * the milestone would fail the same way forever.
 *
 * @param {object} ledger
 * @param {number} cpNum
 * @returns {{ledger: object, cleared: number}}
 */
export function clearCheckpointSteps(ledger, cpNum) {
  const next = {};
  let cleared = 0;
  for (const [key, entry] of Object.entries(ledger || {})) {
    if (entry && entry.cp === cpNum) cleared++;
    else next[key] = entry;
  }
  return { ledger: next, cleared };
}
