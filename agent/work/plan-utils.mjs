// agent/work/plan-utils.mjs: turns a cortex or prefrontal plan (the organs that decide the next
// step and plan checkpoints) into the checkpoint list the executor runs, and keeps the
// missions-never-nest invariant on envelopes. Pure. Deciding what to plan is the organs' job, and
// running the plan the checkpoint executor's. Called by the brain's planning step.

import { toStr } from '../providers/to-str.mjs';

/**
 * Keep the dispatchable tasks of one checkpoint and give each its text as `task`. A task without
 * an `agent` cannot be dispatched and is dropped with a warning; a null entry (model output, or
 * what JSON repair leaves behind) is dropped the same way instead of being dereferenced.
 */
function normalizeTasks(tasks, cpNumber, log) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (!t || typeof t !== 'object' || !t.agent || typeof t.agent !== 'string') {
      log('WARN', `Checkpoint ${cpNumber}: skipping task without agent field`);
      return false;
    }
    return true;
  }).map((t) => ({
    ...t,
    task: toStr(t.task || t.instruction || t.description || ''),
  }));
}

/**
 * Extract the checkpoints array from a cortex or prefrontal decision object.
 *
 * Accepts { checkpoints: [...] }, { plan: { checkpoints: [...] } } or
 * { checkpoint_plan: { checkpoints: [...] } }. A flat array of tasks under any of those keys is
 * wrapped in one checkpoint. Normalizes field names (steps or parts → tasks; title or
 * description → instruction; task text from task, instruction or description), drops tasks that
 * name no agent, and drops checkpoints left with no tasks.
 *
 * @param {object} d - Decision object from the cortex or prefrontal
 * @param {function} [log] - Optional logger (level, message); defaults to a no-op
 * @returns {Array|null} Normalized checkpoints array, or null if none found
 */
export function extractCheckpoints(d, log = () => {}) {
  const raw = d.checkpoints
    || d.plan?.checkpoints
    || d.checkpoint_plan?.checkpoints;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  // A flat array of tasks (no .tasks nesting): one checkpoint holding all of them.
  if (raw[0] && raw[0].agent && !raw[0].tasks) {
    const tasks = normalizeTasks(raw, 1, log);
    return tasks.length > 0 ? [{ instruction: d.instruction || d.goal || 'Execute plan', tasks }] : null;
  }

  return raw.map((entry, i) => {
    const cp = entry && typeof entry === 'object' ? entry : {};
    return {
      instruction: cp.instruction || cp.title || cp.description || `Checkpoint ${i + 1}`,
      accept_criteria: cp.accept_criteria || '',
      tasks: normalizeTasks(Array.isArray(cp.tasks) ? cp.tasks : (cp.steps || cp.parts), i + 1, log),
    };
  }).filter((cp) => cp.tasks.length > 0);
}

/**
 * Missions never nest. The one legitimately parented mission is one a responsibility fires: the
 * request (R) envelope is the mission's parent, and the scheduler stamps the mission with
 * source_meta.responsibility_id. Any other parented mission is a nesting bug and is demoted to a
 * checkpoint (C).
 *
 * Without the responsibility exemption, every routine-fired mission was demoted, and a nightly
 * routine's tree rendered as checkpoints under a checkpoint instead of R→M→C→T. Delivery outside
 * the agent is gated on parent_id separately (only parent-less envelopes are sent out), so an
 * exempted mission still never delivers through the mouth; this is about the type label and the
 * tree shape.
 *
 * Mutates `env` in place.
 *
 * @param {object} env - a work envelope
 * @returns {boolean} true if the envelope was demoted M→C
 */
export function enforceMissionParentInvariant(env) {
  if (env && env.type === 'M' && env.parent_id && !env.source_meta?.responsibility_id) {
    env.type = 'C';
    env.delivery_status = 'internal';
    return true;
  }
  return false;
}
