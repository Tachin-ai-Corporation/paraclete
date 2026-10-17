// agent/services/brain/actions/wait.mjs: the wait move. The mission pauses for a bounded number of
// minutes (settle time after a deploy, a rate limit's backoff), and the brain resumes it with the
// cortex's `then` as the next step; waits.mjs does the resuming. A top-level mission tells the person
// it is pausing. Called by the decide loop in envelope-runner.mjs.

import { COLLECTIONS } from '../../../storage/collections.mjs';
import { toStr } from '../../../providers/to-str.mjs';
import { addressMeta } from '../envelope-store.mjs';

/**
 * How long to wait: the cortex's minutes, clamped to the contracts' bounds, the default when absent.
 *
 * @param {object} decision
 * @param {{minMinutes: number, maxMinutes: number, defaultMinutes: number}} bounds
 * @returns {number}
 */
export function waitMinutes(decision, { minMinutes, maxMinutes, defaultMinutes }) {
  let minutes = parseInt(decision.minutes ?? decision.wait_minutes ?? decision.duration ?? defaultMinutes, 10);
  if (Number.isNaN(minutes)) minutes = defaultMinutes;
  return Math.min(maxMinutes, Math.max(minMinutes, minutes));
}

/**
 * @param {object} ctx  - { envelope, decision }
 * @param {object} deps - { store, settings, addressFor, clock }
 * @returns {Promise<{exit: true}>}
 */
export async function handleWait(ctx, deps) {
  const { envelope, decision } = ctx;
  const { store, settings, addressFor } = deps;
  const minutes = waitMinutes(decision, settings.wait);
  const reason = toStr(decision.reason || decision.wait_reason || 'Waiting for an outside event');
  const then = toStr(decision.then || decision.wait_then || decision.instruction || 'Continue the mission');
  const resumeAt = new Date(deps.clock() + minutes * 60_000).toISOString();

  await store.setStatus(envelope, 'waiting', `Waiting ${minutes}m (until ${resumeAt.substring(11, 16)}Z): ${reason.substring(0, 200)}`, {
    event: { resumeAt, resumeInstruction: then },
  });

  if (!envelope.parent_id) {
    const id = store.newId('w');
    const at = store.iso();
    await store.firestoreWrite(COLLECTIONS.work, id, {
      id, type: 'T', parent_id: envelope.id, status: 'complete', intent: 'notification',
      title: 'Pausing', instruction: 'Wait notification', accept_criteria: '',
      output: `⏳ Pausing for ${minutes} minute${minutes === 1 ? '' : 's'} — ${reason.substring(0, 200)}. I'll continue automatically after that.`,
      source_channel: envelope.source_channel || 'brain',
      source_meta: { ...addressMeta(envelope.source_meta), notification_type: 'wait' },
      project_id: envelope.project_id || null,
      created_at: at, started_at: at, completed_at: at, updated_at: at,
      children: [], context_summary: null, context_forward: null, error: null, iteration: 0,
      delivery_status: 'pending',
      delivery_address: addressFor(envelope),
    });
  }
  return { exit: true };
}
