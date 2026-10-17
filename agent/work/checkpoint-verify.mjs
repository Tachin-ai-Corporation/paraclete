// agent/work/checkpoint-verify.mjs: the milestone verification of one checkpoint by the cerebellum
// (the organ that verifies each checkpoint against its acceptance criteria). Builds the verifier's
// prompts, asks, retries a non-answer, re-verifies on the complete evidence when the first look was
// partial, tries to overturn a pass when the stakes call for it, and grades the result: met, met
// with a caveat, or not met. It changes no envelope and no spine; the checkpoint executor applies the
// result. Called by the checkpoint executor once per checkpoint, after the checkpoint's tasks ran.
//
// Verification happens at checkpoint boundaries. Each task is judged by the organ that ran it; the
// cerebellum makes one judgment per checkpoint: did the combined work meet the milestone?
//
// Only report_pass and report_fail are verdicts. A verifier that returns anything else (an empty
// reply, a turn that only read files, a probe request) has not judged the work: it is asked again,
// then once more with a reduced prompt, and if it still has no verdict the milestone fails closed as
// inconclusive. The probe loop is not serviced: no prompt here offers request_probe and nothing
// reads probes back.
//
// A pass must rest on the evidence, not on a view of it:
//   - the first look uses compact evidence (each task's result row, clipped to the prompt budget),
//     because a prompt that carries every full output gets refused by the model; when that view was
//     knowingly partial (a row cut, the block clipped, a large tool result replaced by its digest),
//     a PASS is re-verified on the complete evidence before it stands, and so is a FAIL;
//   - a pass that could not be re-verified stands only as met with a caveat, and says so;
//   - at consequential stakes or above (or for load-bearing work) a separate call tries to overturn
//     the pass; an attack that lands fails the milestone, and one that does not complete leaves the
//     pass standing only as met with a caveat, never as a clean pass.

import { toStr } from '../providers/to-str.mjs';
import { smartTruncate } from '../providers/vertex-text.mjs';
import { storedResultRefs, expandToolResults } from '../context/tool-record.mjs';
import {
  extractVerdict, extractFailSummary, extractFailRecommendation, extractPassCaveat,
  isMissingEvidenceFail, stakesAtLeast,
} from './verdict.mjs';
import { packToolEvidence } from './result-packet.mjs';
import { isMilestoneVerdict } from './finalization.mjs';

/** Verification budgets. Defaults; callers pass the contracts values (brain.*). */
export const VERIFY_DEFAULTS = Object.freeze({
  ctxVerifyInput: 60000, // default; callers pass the contracts value (brain.ctx_verify_input)
  ctxVerifyPrior: 16000, // default; callers pass the contracts value (brain.ctx_verify_prior)
  verifyPromptMaxChars: 12000, // default; callers pass the contracts value (brain.verify_prompt_max_chars)
  verifyFullEvidenceMaxChars: 80000, // default; callers pass the contracts value (brain.verify_full_evidence_max_chars)
  attackStakesMin: 'consequential', // default; callers pass the contracts value (brain.attack_duty_stakes_min)
});

// The verify prompt's fixed text, reserved out of the prompt budget.
const BOILERPLATE = 1200;

// The reduced prompt's evidence slice.
const REDUCED_EVIDENCE_CHARS = 6000;

/** The caveats this module adds to a pass it could not fully confirm. Shown to the person. */
export const CAVEATS = Object.freeze({
  attackInconclusive: "The adversarial check this milestone's stakes call for did not complete, so the pass was not tested against the strongest objections.",
  fullUnconfirmed: 'This milestone passed on a partial view of the evidence, and the re-check on the complete evidence returned no verdict.',
});

const NO_RECOMMENDATION = 'No recommendation available';

/**
 * The verdict in a cerebellum reply: 'PASS', 'FAIL', or null for anything that is not a verdict
 * (including a probe request, which nothing services).
 *
 * @param {string} output
 * @returns {'PASS'|'FAIL'|null}
 */
export function readVerdict(output) {
  const v = extractVerdict(output);
  return v === 'PASS' || v === 'FAIL' ? v : null;
}

const merge = (defaults, given) => {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(given || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
};

const rowLine = (step, agent, text) => `- [${step}] ${agent}: ${toStr(text)}`;

const diag = (v, promptText) => `chars=${String(v?.output || '').length} finishReason=${v?.finishReason || 'unknown'} `
  + `promptChars=${String(promptText || '').length} error=${String(v?.error || 'none').slice(0, 120)}`;

/**
 * Verifies one checkpoint's milestone.
 *
 * @param {object} p
 * @param {Function} p.callAgent - async (organ, payload) => { success, output, error, finishReason? };
 *   called with 'cerebellum' and { instruction, _missionId }. A throw counts as no verdict.
 * @param {string} p.missionId
 * @param {number} p.cpNum - 1-based checkpoint number
 * @param {string} p.instruction - the checkpoint's instruction
 * @param {string} p.acceptCriteria - the milestone
 * @param {Array}  p.rows - this checkpoint's task rows ({ step, agent, result }); `result` is compact
 * @param {Array}  [p.fullOutputs] - [{ step, agent, output }]: the untruncated output of each task row
 * @param {Array}  [p.priorRows] - rows from earlier checkpoints: evidence already established
 * @param {string} [p.stakes='routine'] - the mission's stakes
 * @param {boolean} [p.loadBearing] - the work is load-bearing (the cortex's brief says so)
 * @param {Function} [p.readToolResult] - async (ref) => full stored tool result | null; lets the
 *   complete-evidence re-check put stored results back in place of their digests
 * @param {object} [p.settings] - see VERIFY_DEFAULTS
 * @param {Function} [p.log] - (level, msg)
 * @returns {Promise<{
 *   verdict: 'met'|'met_with_caveat'|'not_met', passed: boolean, inconclusive: boolean,
 *   needsReview: boolean, caveats: string[], summary: string, recommendation: string,
 *   row: object|null, trail: string[]
 * }>} `row` is the `${cpNum}.verify` result row to add to the checkpoint's results (null for a clean
 *   pass); `trail` lists the calls made and what each returned, e.g. ['first:PASS', 'full:FAIL']
 */
export async function verifyMilestone(p) {
  const {
    callAgent, missionId, cpNum, instruction = '', acceptCriteria = '',
    rows = [], fullOutputs = [], priorRows = [], stakes = 'routine', loadBearing = false,
    readToolResult = null, log = () => {},
  } = p;
  const s = merge(VERIFY_DEFAULTS, p.settings);
  const tag = `CP${cpNum}`;
  const trail = [];

  const ask = async (stage, prompt) => {
    let reply;
    try {
      reply = (await callAgent('cerebellum', { instruction: prompt, _missionId: missionId })) || {};
    } catch (e) {
      reply = { success: false, output: null, error: e.message };
    }
    trail.push(`${stage}:${readVerdict(reply.output) || 'none'}`);
    return reply;
  };

  // ---- Budgets ----
  // The whole verify prompt stays under verifyPromptMaxChars: past roughly that size Gemini starts
  // refusing it with a malformed function call. Instruction and criteria take bounded slices, earlier
  // evidence takes a slice only when there is some, and the evidence under test gets the rest.
  const maxPrompt = s.verifyPromptMaxChars;
  const instrText = smartTruncate(toStr(instruction) || `Checkpoint ${cpNum}`, Math.min(1500, Math.floor(maxPrompt * 0.2)));
  const critText = smartTruncate(toStr(acceptCriteria), Math.min(2500, Math.floor(maxPrompt * 0.32)));
  const compact = rows.map((r) => rowLine(r.step, r.agent, r.result)).join('\n');
  const complete = fullOutputs.length > 0
    ? fullOutputs.map((o) => rowLine(o.step, o.agent, o.output)).join('\n')
    : compact;
  // Evidence banked from earlier checkpoints, including results carried across a re-plan. Without it
  // the verifier judged criteria a re-plan carried forward with no sight of the work that met them,
  // and failed "the folder ids are identified" one round after its own verdict had quoted them.
  const prior = priorRows
    .filter((r) => r && r.step != null && !isMilestoneVerdict(r))
    .map((r) => rowLine(r.step, r.agent, r.result))
    .join('\n');
  const remaining = Math.max(1000, maxPrompt - BOILERPLATE - instrText.length - critText.length);
  // No prior evidence, no reservation: a first checkpoint once had its own evidence capped for a
  // reservation it never used, cutting out the command the verifier then said never ran.
  const priorBudget = prior ? Math.min(s.ctxVerifyPrior, Math.floor(remaining * 0.35)) : 0;
  const evidenceBudget = Math.min(s.ctxVerifyInput, remaining - priorBudget);
  log('INFO', `[checkpoint-verify] ${tag}: verifying the milestone (evidence<=${evidenceBudget} prior<=${priorBudget} cap=${maxPrompt} compact=${compact.length} complete=${complete.length})`);

  const firstPrompt = [
    'Verify that this CHECKPOINT MILESTONE has been achieved. Judge the checkpoint as a',
    'whole against its acceptance criteria — a holistic judgment, not a per-step check.',
    'Read the verification SKILL.md before rendering your verdict.',
    // Ordering, not brevity: a verifier that saves the tool call for the end of a long write-up
    // loses the whole judgment when its output budget runs out first.
    'Call report_pass or report_fail AS SOON AS you have reached your judgment. Do not',
    'save the tool call for the end of a long write-up: if your output budget runs out',
    'first, the verdict you reached is lost and the milestone fails for no reason.',
    '',
    '## Checkpoint',
    instrText,
    '',
    '## Acceptance Criteria (the milestone)',
    critText,
    '',
    ...(prior ? [
      '## Previously Established (earlier checkpoints — already-verified evidence)',
      'These findings are ALREADY ESTABLISHED. A criterion satisfied here is satisfied,',
      "even if the current checkpoint's tasks do not repeat the work. Judge only what",
      'remains. Never fail a criterion for absent evidence when the evidence is below.',
      smartTruncate(prior, priorBudget),
      '',
    ] : []),
    '## Combined Task Outputs',
    smartTruncate(compact || '(no output)', evidenceBudget),
  ].join('\n');

  // ---- First look, with one retry and one reduced prompt for a non-answer ----
  let answer = await ask('first', firstPrompt);
  let verdict = readVerdict(answer.output);
  let reducedUsed = false;
  if (!verdict) {
    // A MALFORMED_FUNCTION_CALL is the provider refusing this exact prompt, deterministically: the
    // identical retry is a wasted call, so go straight to the differently shaped one.
    if (/MALFORMED_FUNCTION_CALL/i.test(String(answer.finishReason || ''))) {
      log('WARN', `[checkpoint-verify] ${tag}: no verdict, and the refusal is deterministic; skipping the identical retry (${diag(answer, firstPrompt)})`);
    } else {
      log('WARN', `[checkpoint-verify] ${tag}: no verdict; retrying once (${diag(answer, firstPrompt)})`);
      answer = await ask('retry', firstPrompt);
      verdict = readVerdict(answer.output);
    }
    if (!verdict) {
      // A second miss on the same prompt means the prompt is the problem. MALFORMED_FUNCTION_CALL
      // says it was too big; MAX_TOKENS says the verifier spent its output budget reasoning before
      // it called a verdict tool. Either way, less to read leaves room for the verdict.
      const budgetExhausted = /MAX_TOKENS/i.test(String(answer.finishReason || ''));
      const reducedPrompt = [
        'Verify this checkpoint against its acceptance criteria. Call report_pass or',
        'report_fail exactly once. Be brief — one sentence of reasoning per criterion.',
        '',
        '## Acceptance Criteria',
        smartTruncate(toStr(acceptCriteria), 2000),
        '',
        '## Evidence',
        smartTruncate(compact || '(no output)', REDUCED_EVIDENCE_CHARS),
      ].join('\n');
      reducedUsed = true;
      answer = await ask('reduced', reducedPrompt);
      verdict = readVerdict(answer.output);
      if (verdict) {
        log('INFO', `[checkpoint-verify] ${tag}: the reduced prompt produced ${verdict}; ${budgetExhausted
          ? "the verifier's output budget ran out before it called a verdict tool, not a problem with the work"
          : 'the full prompt was the problem, not the work'}`);
      } else {
        log('WARN', `[checkpoint-verify] ${tag}: the reduced prompt also returned no verdict (${diag(answer, reducedPrompt)})`);
      }
    }
  }

  // ---- Re-verification on the complete evidence ----
  // The first look was partial when a task's row was cut, the evidence block was clipped to the
  // budget, or a large tool result was replaced by its digest. A verdict reached on a partial view
  // is re-derived on the complete evidence before it stands. A FAIL saying "I could not see it" is
  // re-derived the same way: it asks for evidence, it does not judge the work.
  const caveats = [];
  const rowCut = fullOutputs.some((o) => {
    const row = rows.find((r) => r.step === o.step);
    return Boolean(row) && toStr(row.result).length < toStr(o.output).length;
  });
  const clipped = compact.length > (reducedUsed ? REDUCED_EVIDENCE_CHARS : evidenceBudget);
  const digested = storedResultRefs(complete).length > 0;
  const partialView = rowCut || clipped || digested;
  const missingEvidence = verdict === 'FAIL' && isMissingEvidenceFail(extractFailSummary(answer.output));
  let reverified = false;
  let fullEvidence = '';
  if (verdict && (partialView || missingEvidence)) {
    const trigger = missingEvidence ? 'missing-evidence' : [rowCut && 'row-cut', clipped && 'clipped', digested && 'digested'].filter(Boolean).join('+');
    log('WARN', `[checkpoint-verify] ${tag}: re-verifying a ${verdict} on the complete evidence (trigger=${trigger}, compact=${compact.length} complete=${complete.length} budget=${evidenceBudget})`);
    // The re-check prompt is lean (criteria and evidence only), so it can spend nearly the whole
    // prompt budget on evidence, under the configured ceiling.
    const fullBudget = Math.min(s.verifyFullEvidenceMaxChars, Math.max(3000, maxPrompt - critText.length - BOILERPLATE));
    // A digest is a finding aid; the stored result is the proof. Put stored results back in place of
    // their digests as far as each task's share of the budget allows, and keep every tool's result
    // (shape-aware packing), not a head and tail clip that drops the middle where a command's output
    // sits.
    const share = Math.floor(fullBudget / Math.max(1, fullOutputs.length));
    const expanded = await Promise.all(fullOutputs.map(async (o) => ({
      ...o,
      output: await expandToolResults(toStr(o.output), { read: readToolResult, budget: share }),
    })));
    fullEvidence = expanded.length > 0
      ? packToolEvidence(expanded, fullBudget)
      : smartTruncate(complete || '(no output)', fullBudget);
    const fullPrompt = [
      'Verify this checkpoint against its acceptance criteria. Call report_pass or',
      'report_fail exactly once, as soon as you reach your judgement.',
      '',
      'Your previous verdict was reached on a truncated view. The COMPLETE evidence is',
      "below — every tool call's result is included. Judge the work on it. Do NOT fail a",
      'criterion for missing evidence again — if something is genuinely absent from the',
      'work, say which criterion and what is missing from the ARTIFACT, not from this text.',
      '',
      '## Acceptance Criteria',
      critText,
      '',
      '## Complete Evidence',
      fullEvidence || '(no output)',
    ].join('\n');
    const re = await ask('full', fullPrompt);
    const reVerdict = readVerdict(re.output);
    if (reVerdict) {
      log('INFO', `[checkpoint-verify] ${tag}: the complete-evidence re-check returned ${reVerdict}`);
      answer = re;
      verdict = reVerdict;
      reverified = true;
    } else {
      log('WARN', `[checkpoint-verify] ${tag}: the complete-evidence re-check returned no verdict (${diag(re, fullPrompt)})`);
      if (verdict === 'PASS') caveats.push(CAVEATS.fullUnconfirmed);
    }
  }

  // ---- Adversarial pass: only over a PASS, and only when the stakes call for it ----
  // An attack exists to stop a false pass, so a FAIL never needs one. It is its own call, so the
  // whole output budget goes to attacking instead of competing with the verdict inside one reply.
  if (verdict === 'PASS' && (stakesAtLeast(stakes, s.attackStakesMin) || loadBearing)) {
    const evidence = reverified
      ? fullEvidence
      : smartTruncate(compact || '(no output)', Math.max(1000, maxPrompt - BOILERPLATE - critText.length));
    const attackPrompt = [
      `You already judged this checkpoint a PASS. Now try to overturn it (stakes: ${stakes}${loadBearing ? ', load-bearing' : ''}).`,
      'Run three attacks and record each one:',
      '  1. The strongest objection a domain expert would raise.',
      '  2. A flip test — what would have to be true for this to be wrong?',
      '  3. A boundary probe — the edge case most likely to be unhandled.',
      '',
      'If any attack lands, call report_fail with that attack as the recommendation. If',
      'all three fail to land, call report_pass. Register the verdict as soon as you reach it.',
      'Do NOT pass merely because the earlier verdict passed — re-derive from the evidence.',
      '',
      '## Acceptance Criteria (the milestone)',
      critText,
      '',
      '## Evidence',
      evidence,
    ].join('\n');
    const attack = await ask('attack', attackPrompt);
    const attackVerdict = readVerdict(attack.output);
    if (attackVerdict === 'FAIL' && !isMissingEvidenceFail(extractFailSummary(attack.output))) {
      log('WARN', `[checkpoint-verify] ${tag}: the adversarial pass overturned the PASS; an attack landed`);
      answer = attack;
      verdict = 'FAIL';
    } else if (attackVerdict === 'PASS') {
      log('INFO', `[checkpoint-verify] ${tag}: the adversarial pass upheld the PASS`);
    } else {
      // No verdict, or a FAIL that only says the evidence was out of view: the attack did not land,
      // and it did not complete either. The pass stands, but not as a clean pass.
      log('WARN', `[checkpoint-verify] ${tag}: the adversarial pass was inconclusive (${diag(attack, attackPrompt)}); the PASS stands with a caveat`);
      caveats.push(CAVEATS.attackInconclusive);
    }
  }

  // ---- Grade ----
  const step = `${cpNum}.verify`;
  if (verdict === 'FAIL') {
    const summary = extractFailSummary(answer.output) || 'Checkpoint acceptance criteria not met';
    const rec = extractFailRecommendation(answer.output);
    const recommendation = rec && rec !== NO_RECOMMENDATION ? rec : '';
    // Still unseen after being handed the complete evidence: the milestone does not pass, but the
    // work was not judged wrong, and finalization must be able to tell the two apart.
    const inconclusive = isMissingEvidenceFail(summary);
    log('WARN', `[checkpoint-verify] ${tag}: ${inconclusive ? 'INCONCLUSIVE, the verifier still could not see the evidence' : 'FAIL'}: ${summary.slice(0, 200)}`);
    return {
      verdict: 'not_met', passed: false, inconclusive, needsReview: inconclusive, caveats: [], summary, recommendation, trail,
      row: inconclusive
        ? {
          step, agent: 'cerebellum', success: false, inconclusive: true,
          result: `[CHECKPOINT VERIFICATION INCONCLUSIVE] The verifier could not see enough evidence to judge this milestone: ${summary}. The work was NOT judged wrong. Treat the tasks' own reported outcomes as the best available account, and say plainly which parts remain unverified.`,
        }
        : {
          step, agent: 'cerebellum', success: false,
          result: `[CHECKPOINT VERIFICATION FAILED] ${summary}${recommendation ? `\nRecommendation: ${recommendation}` : ''}`,
        },
    };
  }

  if (verdict === 'PASS') {
    // The graded verdict: a PASS may carry the verifier's own caveat (the intent is met; a listed
    // criterion is partly met in a way that does not defeat the deliverable), plus any this module
    // added. A caveat is surfaced, never swallowed.
    const own = extractPassCaveat(answer.output);
    const all = [...(own ? [own] : []), ...caveats];
    if (all.length === 0) {
      log('INFO', `[checkpoint-verify] ${tag}: PASS`);
      return { verdict: 'met', passed: true, inconclusive: false, needsReview: false, caveats: [], summary: '', recommendation: '', row: null, trail };
    }
    log('INFO', `[checkpoint-verify] ${tag}: PASS with caveat: ${all.join(' ').slice(0, 200)}`);
    return {
      verdict: 'met_with_caveat', passed: true, inconclusive: false, needsReview: false, caveats: all, summary: '', recommendation: '', trail,
      row: { step, agent: 'cerebellum', success: true, result: `[MILESTONE MET — WITH CAVEAT] ${all.join(' ')}` },
    };
  }

  // No terminal verdict: fail closed. A milestone never passes unverified, but a verifier that
  // returned nothing has not judged the work wrong, so the row is inconclusive, not failed work.
  log('WARN', `[checkpoint-verify] ${tag}: no terminal verdict; failing closed`);
  return {
    verdict: 'not_met', passed: false, inconclusive: true, needsReview: true, caveats: [],
    summary: 'No terminal PASS/FAIL verdict was returned', recommendation: '', trail,
    row: {
      step, agent: 'cerebellum', success: false, inconclusive: true,
      result: '[CHECKPOINT VERIFICATION INCONCLUSIVE] No terminal PASS/FAIL verdict was returned, so this milestone is unverified and does not pass. The work was NOT judged wrong.',
    },
  };
}
