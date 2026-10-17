// agent/services/brain/actions/needs-input.mjs: the needs_input move. The mission stops and asks the
// person a question; their answer, classified as a continue, resumes it. Its mission tree and its
// memory line wait for the real end. Called by the decide loop in envelope-runner.mjs.

/**
 * @param {object} ctx  - { envelope, decision }
 * @param {object} deps - { completeEnvelope }
 * @returns {Promise<{exit: true}>}
 */
export async function handleNeedsInput(ctx, deps) {
  const { envelope, decision } = ctx;
  await deps.completeEnvelope(envelope, {
    status: 'needs_input',
    output: decision.question || decision.message || 'I need more information to proceed.',
    historyDetail: `Needs: ${decision.what_is_needed || 'clarification'}`,
    skipArtifacts: true,
    skipMemory: true,
    skipCleanup: true,
  });
  return { exit: true };
}
