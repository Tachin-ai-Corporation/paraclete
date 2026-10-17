// agent/services/brain/actions/status-update.mjs: the status_update move. Writes a short progress note
// under the mission for the mouth to deliver, then decides again. The note is recorded in the turn's
// results, so the next decision knows it was sent and does not send it twice. Called by the decide
// loop in envelope-runner.mjs.

/**
 * @param {object} ctx  - { envelope, decision }
 * @param {object} deps - { writeStatusUpdate, log }
 * @returns {Promise<{continue: true, priorResultsAppend: Array}>}
 */
export async function handleStatusUpdate(ctx, deps) {
  const { envelope, decision } = ctx;
  const message = decision.message || 'Working on it...';
  await deps.writeStatusUpdate(envelope.id, message);
  deps.log('INFO', `status update sent for ${envelope.id}`);
  return {
    continue: true,
    priorResultsAppend: [{ agent: 'system', success: true, result: `[SYSTEM] Status update sent to the person: "${String(message).substring(0, 200)}". Do not send it again; choose the next move.` }],
  };
}
