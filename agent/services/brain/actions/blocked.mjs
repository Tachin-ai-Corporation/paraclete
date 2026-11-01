// agent/services/brain/actions/blocked.mjs: the blocked move. The mission stops on an outside obstacle
// and hands the problem back to a person, who can continue it once the obstacle is cleared. Two rules
// keep the handback honest: a mission whose tasks all succeeded is not blocked because a milestone
// verdict failed (it is re-routed once to a verified synthesis), and a handback always says what is in
// the way, recovered from the failing task's own report when the cortex said nothing. Called by the
// decide loop in envelope-runner.mjs.

import { articulateBlocker, deliverableStandsDespiteMilestone } from '../../../work/finalization.mjs';
import { extractFailRecommendation } from '../../../organs/cerebellum/verdict.mjs';
import { toStr } from '../../../providers/to-str.mjs';

/**
 * Blocker types that name a real outside obstacle. When the cortex names one, it is trusted; the
 * mislabel guard only catches the default, unnamed case.
 */
export const REAL_BLOCKER_TYPES = Object.freeze(new Set([
  'access', 'permission', 'auth', 'missing-input', 'missing_input',
  'external', 'dependency', 'quota', 'rate-limit', 'rate_limit',
]));

/**
 * @param {object} ctx  - { envelope, decision, priorResults, iteration }
 * @param {object} deps - { completeEnvelope, store, settings, log }
 * @returns {Promise<{exit: true}|{nextAction: 'synthesize'}>}
 */
export async function handleBlocked(ctx, deps) {
  const { envelope, decision, priorResults, iteration } = ctx;
  const { completeEnvelope, store, settings, log } = deps;

  // A checkpoint's failed milestone verdict judges that checkpoint, not the mission's deliverable. A
  // finished mission (a complete two-page document) was once ended as blocked with its own success
  // summary in the blocker field. When no real task failed, a deliverable exists, and the cortex
  // named no real obstacle, re-route once to a verified synthesis, which completes honestly or
  // routes to an acknowledged failure. One-shot and iteration-bounded, so a cortex that truly
  // insists still terminates.
  const declaredReal = REAL_BLOCKER_TYPES.has(String(decision.blocker_type || '').toLowerCase());
  if (envelope.type === 'M'
      && !envelope._blocked_mislabel_averted
      && !declaredReal
      && iteration < settings.maxIterations - 1
      && deliverableStandsDespiteMilestone(priorResults)) {
    envelope._blocked_mislabel_averted = true;
    try { await store.save(envelope); } catch { /* the flag rides the next save */ }
    log('WARN', `[blocked] mislabel averted for ${envelope.id}: no real task failed and a deliverable exists; re-routing to a verified synthesis`);
    log('INFO', `[TELEMETRY] blocked_mislabel_averted mission=${envelope.id} iteration=${iteration}`);
    decision.synthesis = decision.synthesis || decision.blocker || decision.escalation_message
      || decision.blocker_description || decision.content || envelope._failure_synthesis || '';
    decision.action = 'synthesize';
    return { nextAction: 'synthesize' };
  }

  // The handback carries the information. When the cortex named nothing, the failing task's own
  // report usually says exactly what is missing; recover it instead of printing a stock phrase.
  const stated = decision.escalation_message || decision.blocker_description || decision.blocker
    || decision.synthesis || decision.content || decision.response || decision.message
    || decision.instruction || '';
  let output = toStr(stated);
  let blocker = toStr(decision.blocker || '');
  if (!output || !blocker) {
    const evidence = articulateBlocker(priorResults, extractFailRecommendation);
    if (evidence) {
      const where = evidence.step ? ` (step ${evidence.step}${evidence.agent ? `, ${evidence.agent}` : ''})` : '';
      if (!output) output = `Blocked${where}: ${evidence.detail}`;
      if (!blocker) blocker = evidence.detail;
      log('INFO', `[TELEMETRY] blocker_articulated_from_evidence mission=${envelope.id} step=${evidence.step}`);
    }
  }
  // Nothing stated and nothing failed: the stop was decided while planning, before any step ran (a
  // capability the agent lacks, declined up front). Say exactly that, and what was asked, so the
  // person looks at the plan and the agent's capabilities rather than for a failed step.
  if (!output || !blocker) {
    const attempted = (Array.isArray(priorResults) ? priorResults : []).length > 0;
    const asked = String(envelope.instruction || envelope.title || '').trim().slice(0, 300);
    const where = attempted
      ? 'Blocked, and neither the decision nor any failed task recorded why: read the mission history.'
      : 'Blocked before any work was dispatched, and no blocker was stated. Nothing was attempted, so there is no failed step to read: the decision to stop was made while planning.';
    if (!output) output = asked ? `${where}\n\nThe request was: ${asked}` : where;
    if (!blocker) {
      blocker = attempted
        ? 'Unarticulated blocker: no evidence on the envelope'
        : 'Unarticulated blocker: stopped while planning, before any step ran';
    }
    log('WARN', `[blocked] ${envelope.id} ended with no blocker stated (attempted=${attempted})`);
    log('INFO', `[TELEMETRY] blocker_unarticulated mission=${envelope.id} attempted=${attempted}`);
  }

  await completeEnvelope(envelope, {
    status: 'blocked',
    output,
    blocker,
    blockerType: decision.blocker_type || 'other',
    historyDetail: `Blocked: ${blocker.substring(0, 200)}`,
  });
  return { exit: true };
}
