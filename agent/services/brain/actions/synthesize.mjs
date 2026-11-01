// agent/services/brain/actions/synthesize.mjs: the synthesize move, the cortex's proposal that the
// mission is done. Before a mission completes: an unresolved real failure refuses the synthesis; a
// pinned checkpoint spine whose deliverable checkpoint is not complete refuses it too (nothing is
// reported complete that the work never reached); the answer is composed answer first, with its
// assumptions in their epistemic bins; and the cerebellum (the organ that verifies) checks the
// synthesis against the acceptance criteria, with an attack duty at consequential stakes. A FAIL
// steers to an honest synthesize_with_failure; a pass with a caveat completes with the caveat shown.
// The missing-evidence re-check belongs to the checkpoint executor and is not repeated here. Called
// by the decide loop in envelope-runner.mjs.

import { extractFailSummary, extractPassCaveat, extractVerdict, stakesAtLeast } from '../../../organs/cerebellum/verdict.mjs';
import { finalizeBlockedBySpine } from '../../../work/checkpoint-spine.mjs';
import { renderCaveatSection } from '../../../work/finalization.mjs';
import { renderResources } from '../../../work/resource-ledger.mjs';
import { smartTruncate } from '../../../providers/vertex-text.mjs';
import { toStr } from '../../../providers/to-str.mjs';

/**
 * The three epistemic bins, and what to do with anything else. A claim whose status the cortex left
 * out once rendered as "[undefined]" on every claim of a report: a labelling defect that erased the
 * distinction between an observation and an inference. An unlabelled claim falls to `assumed`, the
 * most cautious bin: a claim not shown to be checked has not been shown to be checked.
 */
const EPISTEMIC_BINS = ['assumed', 'inferred', 'verified'];

/**
 * @param {*} status
 * @returns {'assumed'|'inferred'|'verified'}
 */
export function epistemicBin(status) {
  const s = String(status ?? '').trim().toLowerCase();
  return EPISTEMIC_BINS.includes(s) ? s : 'assumed';
}

/**
 * The deliverable, answer first: the answer, then the reasoning, then the risk and the assumptions,
 * least certain first. Without an `answer` the synthesis is used as written.
 *
 * @param {object} decision
 * @param {string} synthesis
 * @returns {string}
 */
export function composeAnswerFirst(decision, synthesis) {
  if (!decision.answer) return synthesis;
  const lines = [String(decision.answer).trim()];
  if (synthesis) lines.push('', '— Reasoning —', String(synthesis).trim());
  const assumptions = (Array.isArray(decision.assumptions) ? decision.assumptions : [])
    .filter((a) => a && String(a.claim ?? '').trim())
    .map((a) => ({ ...a, status: epistemicBin(a.status) }));
  const order = { assumed: 0, inferred: 1, verified: 2 };
  const sorted = [...assumptions].sort((a, b) => order[a.status] - order[b.status]);
  if (decision.risk || sorted.length > 0) {
    lines.push('', '— Risk & assumptions —');
    if (decision.risk) lines.push(String(decision.risk).trim());
    for (const a of sorted) lines.push(`• [${a.status}] ${String(a.claim).trim()}${a.note ? ` — ${a.note}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Whether the synthesis may skip verification: only a short answer to a mission without real
 * acceptance criteria. Criteria the person or the planner wrote are always checked.
 *
 * @param {object} envelope - with `output` already set to the synthesis
 * @param {number} minChars - brain.synth_verify_min_chars
 * @returns {boolean}
 */
export function isSynthExempt(envelope, minChars) {
  if (envelope.accept_criteria && String(envelope.accept_criteria).length > 20) return false;
  return String(envelope.output || '').length < minChars;
}

/**
 * The work the checkpoints already verified, as the verifier's established evidence: each passed
 * task's summary, within a budget.
 */
function establishedEvidence(priorResults, budget) {
  const rows = (priorResults || []).filter((r) => r && r.checkpoint_step && r.success === true && !String(r.checkpoint_step).endsWith('.verify'));
  if (rows.length === 0) return '';
  const text = rows.map((r) => `- ${r.checkpoint_step} (${r.agent}): ${toStr(r.summary || r.result).substring(0, 1500)}`).join('\n');
  return smartTruncate(text, budget);
}

/**
 * @param {object} ctx  - { envelope, decision, priorResults, iteration }
 * @param {object} deps - { completeEnvelope, store, callAgent, settings, log }
 */
export async function handleSynthesize(ctx, deps) {
  const { envelope, decision, priorResults, iteration } = ctx;
  const { completeEnvelope, store, callAgent, settings, log } = deps;
  const lastTurn = iteration >= settings.maxIterations - 1;

  // An unresolved real failure blocks a plain synthesis. Inconclusive and timed-out rows are not
  // judgements that the work is wrong (the verifier could not see the evidence, or the outcome is
  // unknown): counting them once turned three correctly edited documents into a blocked mission.
  const lastSuccess = priorResults.map((r, i) => (r.success === true ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const unresolved = priorResults.some((r, i) => r.success === false && !r.timedOut && !r.inconclusive && i > lastSuccess);
  if (unresolved && !lastTurn) {
    log('WARN', `[synthesize] refused for ${envelope.id}: unresolved failures in the results (iteration ${iteration})`);
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: '[SYSTEM] Synthesize refused: there are unresolved failures in prior_results. Either (1) re-plan to investigate and fix the failure, or (2) use "synthesize_with_failure" with the failure stated plainly. A plain "synthesize" is not allowed over a failed task.',
      }],
      activeGuard: { forbidden: 'synthesize', fallback: 'checkpoint_plan', injectedAt: iteration },
    };
  }

  // The finalize gate: with a pinned spine, the last checkpoint is the deliverable. While it is not
  // complete there is no result to report, so the mission escalates instead of claiming success;
  // on the last turn it ends as needs_input rather than let a false completion out.
  const gate = finalizeBlockedBySpine(envelope._cp_spine);
  if (gate) {
    const unmet = gate.unmet.map((u) => `CP${u.n} (${u.status}): ${u.outcome}`).join('; ');
    log('WARN', `[synthesize] completion refused for ${envelope.id}: the deliverable checkpoint is unmet (${unmet})`);
    log('INFO', `[TELEMETRY] finalize_blocked_spine mission=${envelope.id} unmet=${gate.unmet.length} terminal_cp=${gate.terminal.n} iter=${iteration}`);
    if (!lastTurn) {
      return {
        continue: true,
        activeGuard: { forbidden: 'synthesize', fallback: 'needs_input', injectedAt: iteration },
        priorResultsAppend: [{
          agent: 'system',
          result: `[SYSTEM] Cannot synthesize COMPLETE: the deliverable checkpoint "${gate.terminal.outcome}" is not done (unmet: ${unmet}). There is no result to report. Either (1) re-plan to finish the outstanding checkpoint(s), or (2) if an input or an access is missing, use "needs_input" to ask the person for exactly what is needed. Do NOT report this mission complete.`,
        }],
      };
    }
    await completeEnvelope(envelope, {
      status: 'needs_input',
      output: `I could not complete this mission. The deliverable checkpoint "${gate.terminal.outcome}" did not finish (unmet: ${unmet}). I've stopped rather than report a result I don't have. How would you like me to proceed?`,
      historyDetail: 'Completion refused: the deliverable checkpoint is unmet',
      skipArtifacts: true, skipMemory: true, skipCleanup: true,
    });
    return { exit: true };
  }

  // `summary` is included because vertex-text's raw-text fallback emits { action, summary }.
  const raw = decision.synthesis || decision.summary || decision.content || decision.response || decision.message || decision.instruction || '';
  let output = composeAnswerFirst(decision, toStr(raw));

  await store.createCT(envelope, {
    checkpointTitle: 'Formulate response',
    taskTitle: 'Synthesize answer',
    taskOutput: output,
    taskIntent: 'synthesize',
    deliveryStatus: 'internal',
    ctKey: `synth-${envelope.id}-${iteration}`,
  });
  envelope.output = output;

  let caveat = '';
  if (!isSynthExempt(envelope, settings.synthVerifyMinChars)) {
    const stakes = envelope.stakes || 'routine';
    const established = establishedEvidence(priorResults, settings.verify?.ctxVerifyPrior || 16000);
    const known = renderResources(envelope.context?.resources, { limit: settings.resourceLedger?.recallLimit ?? 40 });
    try {
      const verification = await callAgent('cerebellum', {
        instruction: [
          'Verify that this mission synthesis meets the acceptance criteria. It is what the person',
          'will read: judge whether it claims more than the work established and whether it keeps',
          'its honest caveats. Read the verification SKILL.md before rendering your verdict, and call',
          'report_pass or report_fail as soon as you reach your judgment.',
          '',
          '## Acceptance Criteria',
          envelope.accept_criteria || 'Complete the requested task successfully',
          '',
          '## Mission Synthesis',
          output || '(empty)',
          ...(established ? [
            '',
            '## Previously Established (checkpoints that passed verification)',
            established,
          ] : []),
          ...(known ? ['', known] : []),
          ...(stakesAtLeast(stakes, settings.attackStakesMin) ? [
            '',
            `## Attack Duty (stakes: ${stakes})`,
            'Before any PASS, run three attacks and record them in your checks:',
            '1. The strongest domain-expert objection.',
            '2. A flip test: invert the softest input; does the conclusion survive?',
            '3. A boundary probe: find where the claim stops being true; confirm this case is inside.',
            'A winning attack is a FAIL with the attack as the recommendation.',
          ] : []),
        ].join('\n'),
        _missionId: envelope.id,
      });
      const verdict = extractVerdict(verification?.output);
      if (verdict === 'FAIL') {
        const summary = extractFailSummary(verification.output);
        log('WARN', `[synthesize] the cerebellum failed the synthesis of ${envelope.id}: ${summary}`);
        // The work already cleared its checkpoints, so a FAIL here is about the answer (an
        // over-claim, a missing caveat), not the work: steer to an honest synthesize_with_failure,
        // never to re-running verified work.
        return {
          continue: true,
          activeGuard: { forbidden: 'synthesize', fallback: 'synthesize_with_failure', injectedAt: iteration, context: { verification_fail: summary } },
          priorResultsAppend: [{
            agent: 'cerebellum',
            synthesis_verdict: 'FAIL',
            result: `[VERIFICATION FAILED] ${summary}\n[SYSTEM] The work reached its checkpoints: this is a defect in the ANSWER, not the work. Do NOT redo the work. Correct any over-claim, keep the honest caveat, and return "synthesize_with_failure" stating plainly what was and was not achieved.`,
          }],
        };
      }
      if (verdict === null) {
        log('WARN', `[synthesize] the cerebellum rendered no verdict on ${envelope.id}`);
        envelope.needs_review = true;
        envelope.review_reason = 'The verifier did not render a verdict on the synthesis';
      } else {
        caveat = extractPassCaveat(verification.output) || '';
      }
    } catch (e) {
      log('WARN', `[synthesize] verification failed to run: ${e.message}`);
      envelope.needs_review = true;
      envelope.review_reason = `The synthesis could not be verified: ${e.message}`;
    }
  }

  // A pass with a caveat is shown with its caveat, together with any the checkpoints passed with: a
  // functional but imperfect deliverable reads "done, with a note", never a silent pass.
  const section = renderCaveatSection([
    ...(Array.isArray(envelope._milestone_caveats) ? envelope._milestone_caveats : []),
    ...(caveat ? [caveat] : []),
  ]);
  if (section) {
    output = `${output}${section}`;
    log('INFO', `[TELEMETRY] completion_caveat mission=${envelope.id}`);
  }

  await completeEnvelope(envelope, { status: 'complete', output, priorResults, historyDetail: 'Synthesized response' });
  return { exit: true };
}
