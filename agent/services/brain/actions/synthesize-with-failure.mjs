// agent/services/brain/actions/synthesize-with-failure.mjs: the synthesize_with_failure move, the
// honest end of work that did not fully succeed. Three states: if the recent work in fact all
// succeeded, it is upgraded to a plain synthesis; on a first real failure the cortex gets one chance to
// resolve it another way; after that the failure is accepted, a mission as blocked with its synthesis
// as the account. Called by the decide loop in envelope-runner.mjs.
//
// A mission never completes here: work that succeeded goes on as a `synthesize` move, through the
// finish gate and the verifier like any other answer. Only the work done after the self-unblock check
// counts as having resolved the failure; a success from before it is the work that failed.

import { isRealTaskFailure, isRealTaskSuccess } from '../../../work/finalization.mjs';
import { toStr } from '../../../providers/to-str.mjs';

const SELF_UNBLOCK_CHECK = [
  '[SELF-UNBLOCK CHECK] Before accepting this failure, check what actually happened.',
  '(a) If the deliverable is in fact COMPLETE and the only "failure" was a checkpoint or milestone verdict (the tasks themselves succeeded), do NOT report a blocker. Deliver the finished result now with "synthesize", noting honestly any milestone that was left unverified.',
  '(b) If it is genuinely incomplete but you can resolve it a different way, use "checkpoint_plan" to try the alternative.',
  '(c) ONLY if this is a genuine outside obstacle you cannot work around, use "blocked" with a concrete description of the obstacle (the thing in your way, not a summary of what you accomplished). Do NOT use synthesize_with_failure.',
].join('\n');

const synthesisOf = (d) => d.synthesis || d.summary || d.content || d.response || d.message || d.instruction || '';

/**
 * @param {object} ctx  - { envelope, decision, priorResults, iteration }
 * @param {object} deps - { completeEnvelope, store, settings, log }
 */
export async function handleSynthesizeWithFailure(ctx, deps) {
  const { envelope, decision, priorResults, iteration } = ctx;
  const { completeEnvelope, store, settings, log } = deps;
  const state = envelope._swf_state || null;

  // Upgrade: did the recent work actually succeed? A milestone verdict judges a checkpoint, not the
  // work, and an inconclusive or timed-out row is not a failure, so neither counts here.
  // Recent work is what ran after the last failed plan's system note, counted in priorResults itself.
  const isDispatch = (r) => r.agent !== 'system' && r.agent !== 'human';
  const dispatches = priorResults.filter(isDispatch);
  const lastFailureNote = priorResults.findLastIndex((r) => r.agent === 'system' && String(r.result || '').includes('[SYSTEM] Checkpoint'));
  const recent = (lastFailureNote >= 0 ? priorResults.slice(lastFailureNote + 1) : priorResults).filter(isDispatch);
  // A synthesis the verifier failed is an answer judged wrong, not stale failure context: it is not
  // upgraded back to the synthesis that was just refused, which would loop until the mission's limit.
  const answerJudged = priorResults.findLastIndex((r) => r.synthesis_verdict === 'FAIL') > priorResults.findLastIndex((r) => r.checkpoint_step);
  if (!answerJudged && recent.some(isRealTaskSuccess) && !recent.some(isRealTaskFailure)) {
    log('INFO', 'synthesize_with_failure: the recent work all succeeded; upgrading to synthesize');
    decision.action = 'synthesize';
    return { nextAction: 'synthesize' };
  }

  if (state === null && iteration < settings.maxIterations - 2) {
    log('INFO', `synthesize_with_failure: one self-unblock attempt for ${envelope.id}`);
    envelope._swf_state = 'awaiting_unblock';
    envelope._failure_synthesis = decision.synthesis || decision.summary || decision.content || decision.failure_summary || decision.message || decision.instruction || null;
    await store.save(envelope);
    return { continue: true, priorResultsAppend: [{ agent: 'system', result: SELF_UNBLOCK_CHECK }] };
  }

  if (state === 'awaiting_unblock') {
    envelope._swf_state = 'unblock_attempted';
    const check = priorResults.findLastIndex((r) => r.agent === 'system' && String(r.result || '').startsWith('[SELF-UNBLOCK CHECK]'));
    const sinceCheck = check >= 0 ? priorResults.slice(check + 1).filter(isDispatch) : [];
    if (sinceCheck.some(isRealTaskSuccess) && !sinceCheck.some(isRealTaskFailure)) {
      log('INFO', 'synthesize_with_failure: the work after the self-unblock check succeeded; synthesizing through the finish gate');
      await store.save(envelope);
      decision.action = 'synthesize';
      return { nextAction: 'synthesize' };
    }
    log('INFO', 'synthesize_with_failure: the self-unblock did not resolve the failure');
  }

  if (envelope.type === 'M') {
    await completeEnvelope(envelope, {
      status: 'blocked',
      output: synthesisOf(decision),
      blocker: decision.failure_summary || decision.synthesis || decision.content || decision.message || decision.instruction || 'Unknown blocker',
      blockerType: decision.blocker_type || 'other',
      priorResults,
      historyDetail: `Blocked (self-unblock exhausted): ${toStr(decision.failure_summary).substring(0, 200)}`,
    });
    return { exit: true };
  }

  await completeEnvelope(envelope, {
    status: 'complete',
    output: synthesisOf(decision),
    priorResults,
    historyDetail: `Synthesized with an acknowledged failure: ${toStr(decision.failure_summary).substring(0, 200)}`,
  });
  return { exit: true };
}
