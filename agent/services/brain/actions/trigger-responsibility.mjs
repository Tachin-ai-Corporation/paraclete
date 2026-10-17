// agent/services/brain/actions/trigger-responsibility.mjs: the trigger_responsibility move. When a
// person asks the agent to run one of its scheduled responsibilities now, the cortex names it and this
// starts it through the scheduler (its own mission, in the background), then steers the cortex to a
// brief confirmation. Only responsibilities marked triggerable may be run this way, and one turn fires
// at most once. Called by the decide loop in envelope-runner.mjs.

/**
 * @param {object} ctx  - { envelope, decision, iteration }
 * @param {object} deps - { responsibilities: { triggerable(), fire(id, opts) }, log }
 */
export async function handleTriggerResponsibility(ctx, deps) {
  const { envelope, decision, iteration } = ctx;
  const { responsibilities, log } = deps;
  const id = decision.responsibilityId || decision.responsibility_id || decision.id;
  const triggerable = responsibilities?.triggerable() || [];
  const match = triggerable.find((r) => r.id === id);
  const guard = { forbidden: 'trigger_responsibility', fallback: 'synthesize', injectedAt: iteration };

  if (!id || !match) {
    const list = triggerable.map((r) => r.id).join(', ') || 'none';
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] trigger_responsibility needs a "responsibilityId" from the triggerable set: ${list}. If the request is not one of these scheduled cycles, do NOT use trigger_responsibility: plan the work with checkpoint_plan instead.`,
      }],
    };
  }

  if (envelope._responsibility_triggered) {
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] '${envelope._responsibility_triggered}' was already started this turn. Respond to the person now with "synthesize": a brief confirmation. Do NOT trigger it again.`,
      }],
      activeGuard: guard,
    };
  }

  const r = await responsibilities.fire(id, { bypassSpacing: true, source: 'agent' });
  envelope._responsibility_triggered = id;
  if (!r || !r.ok) {
    const hint = r?.skipped ? ' (a cycle may already be running; it finishes on its own).' : '.';
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] Could not start '${match.name}': ${r?.error || 'unknown error'}${hint} Explain this to the person with "synthesize"; do NOT retry the trigger.`,
      }],
      activeGuard: guard,
    };
  }

  log('INFO', `[TELEMETRY] responsibility_triggered id=${id} source=agent mission=${envelope.id}`);
  return {
    continue: true,
    priorResultsAppend: [{
      agent: 'system',
      success: true,
      result: `[SYSTEM] '${match.name}' has been started and runs in the background; it completes on its own. Respond to the person with "synthesize": a brief confirmation that it started. Do NOT plan the cycle's steps yourself.`,
    }],
    activeGuard: guard,
  };
}
