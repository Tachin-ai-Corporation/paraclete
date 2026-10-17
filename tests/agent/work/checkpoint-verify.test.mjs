// Tests for agent/work/checkpoint-verify.mjs. The pathologies prevented: a milestone passed on a
// view of the evidence that had been cut or compacted, and a pass stood clean when the adversarial
// check its stakes called for never completed; on the other side, a single empty reply or a request
// for evidence failed finished work, and a verifier that "could not see" the work condemned it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMilestone, readVerdict, CAVEATS, VERIFY_DEFAULTS } from '../../../agent/work/checkpoint-verify.mjs';
import { smartTruncate } from '../../../agent/providers/vertex-text.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const REF = `${COLLECTIONS.toolResults}/tr-1`;

// ── Canned cerebellum replies, in the gateway's tool-log shape ─────────

const toolLog = (...lines) => `\n\n---\n[TOOL EXECUTION LOG]\n${lines.join('\n')}\n[END TOOL LOG]`;
const pass = (caveat) => ({
  success: true,
  output: `Judged.${toolLog(`[TOOL] report_pass(${JSON.stringify({ reasoning: 'criteria met', checks: [{ criterion: 'c', pass: true, evidence: 'e' }], ...(caveat ? { caveat } : {}) })}) → {"verdict":"PASS"}`)}`,
});
const fail = (evidence, recommendation = 'Write the missing section.') => ({
  success: true,
  output: `Judged.${toolLog(`[TOOL] report_fail(${JSON.stringify({ reasoning: evidence, checks: [{ criterion: 'The report covers every region', pass: false, evidence }], recommendation })}) → {"verdict":"FAIL"}`)}`,
});
const UNSEEN = 'the section for the second region is not fully visible in the provided transcript';
const empty = (finishReason = 'STOP') => ({ success: true, output: '', finishReason });
const probe = () => ({
  success: true,
  output: `I need more.${toolLog('[TOOL] request_probe({"probes":[{"claim":"a","instruction":"b"}],"reasoning":"r"}) → {"status":"probes_requested"}')}`,
});

/** A cerebellum that answers from a script, recording every prompt. */
function verifier(replies) {
  const prompts = [];
  const callAgent = async (organ, payload) => {
    prompts.push({ organ, ...payload });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next || empty();
  };
  return { callAgent, prompts };
}

const ROWS = [{ step: '1.1', agent: 'motor', result: 'Wrote report.md covering all four regions.', success: true }];
const FULL = [{ step: '1.1', agent: 'motor', output: 'Wrote report.md covering all four regions.' }];

const base = (callAgent, over = {}) => ({
  callAgent,
  missionId: 'w-m1',
  cpNum: 1,
  instruction: 'Write the regional report',
  acceptCriteria: 'report.md exists and covers every region',
  rows: ROWS,
  fullOutputs: FULL,
  ...over,
});

describe('readVerdict', () => {
  it('only report_pass and report_fail are verdicts; a probe request is not', () => {
    assert.equal(readVerdict(pass().output), 'PASS');
    assert.equal(readVerdict(fail('x').output), 'FAIL');
    assert.equal(readVerdict(probe().output), null);
    assert.equal(readVerdict(''), null);
  });
});

describe('the first look', () => {
  it('a clean pass on a complete view is met, in one call, with no row', async () => {
    const v = verifier([pass()]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.verdict, 'met');
    assert.equal(r.passed, true);
    assert.equal(r.row, null);
    assert.deepEqual(r.trail, ['first:PASS']);
    assert.equal(v.prompts[0].organ, 'cerebellum');
    assert.equal(v.prompts[0]._missionId, 'w-m1');
  });

  it("the verifier's own caveat makes the pass met with a caveat, surfaced in the row", async () => {
    const v = verifier([pass('Two folder ids resolve at runtime.')]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.verdict, 'met_with_caveat');
    assert.deepEqual(r.caveats, ['Two folder ids resolve at runtime.']);
    assert.equal(r.row.step, '1.verify');
    assert.equal(r.row.success, true);
    assert.match(r.row.result, /^\[MILESTONE MET — WITH CAVEAT\] Two folder ids resolve at runtime\./);
  });

  it('a substantive FAIL is not met, with the summary and recommendation in the row', async () => {
    const v = verifier([fail('the west region is missing')]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.verdict, 'not_met');
    assert.equal(r.inconclusive, false);
    assert.match(r.row.result, /^\[CHECKPOINT VERIFICATION FAILED\] - The report covers every region: the west region is missing\nRecommendation: Write the missing section\./);
    assert.deepEqual(r.trail, ['first:FAIL'], 'a FAIL on a complete view is not re-derived');
  });

  it('never offers the probe tool', async () => {
    const v = verifier([pass()]);
    await verifyMilestone(base(v.callAgent));
    assert.doesNotMatch(v.prompts[0].instruction, /request_probe|probe/i);
  });

  it('carries earlier evidence, but not earlier verdict rows', async () => {
    const v = verifier([pass()]);
    await verifyMilestone(base(v.callAgent, {
      priorRows: [
        { step: '0.1', agent: 'motor', result: 'Found folder id FOLDER-ABC' },
        { step: '0.verify', agent: 'cerebellum', result: '[MILESTONE MET — WITH CAVEAT] old note' },
      ],
    }));
    assert.match(v.prompts[0].instruction, /## Previously Established[\s\S]*FOLDER-ABC/);
    assert.doesNotMatch(v.prompts[0].instruction, /old note/);
  });

  it('with no earlier evidence there is no reservation for it', async () => {
    const v = verifier([pass()]);
    await verifyMilestone(base(v.callAgent));
    assert.doesNotMatch(v.prompts[0].instruction, /Previously Established/);
  });

  it('keeps the prompt inside the configured cap', async () => {
    const big = 'x'.repeat(40000);
    const v = verifier([pass(), pass()]);
    await verifyMilestone(base(v.callAgent, {
      rows: [{ step: '1.1', agent: 'motor', result: big }],
      fullOutputs: [{ step: '1.1', agent: 'motor', output: big }],
      priorRows: [{ step: '0.1', agent: 'motor', result: big }],
    }));
    for (const p of v.prompts) assert.ok(p.instruction.length <= VERIFY_DEFAULTS.verifyPromptMaxChars, `${p.instruction.length} chars`);
  });
});

describe('a non-answer is asked again, then fails closed', () => {
  it('an empty reply is retried once, then a reduced prompt is tried', async () => {
    const v = verifier([empty(), empty(), pass()]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.verdict, 'met');
    assert.deepEqual(r.trail, ['first:none', 'retry:none', 'reduced:PASS']);
    assert.match(v.prompts[2].instruction, /Be brief — one sentence of reasoning per criterion/);
  });

  it('a deterministic refusal skips the identical retry', async () => {
    const v = verifier([empty('MALFORMED_FUNCTION_CALL'), pass()]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.deepEqual(r.trail, ['first:none', 'reduced:PASS']);
  });

  it('a probe request is not a verdict: nothing services it, so the verifier is asked again', async () => {
    const v = verifier([probe(), pass()]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.verdict, 'met');
    assert.deepEqual(r.trail, ['first:none', 'retry:PASS']);
  });

  it('a dispatch that throws counts as no verdict', async () => {
    const v = verifier([new Error('gateway unreachable'), pass()]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.deepEqual(r.trail, ['first:none', 'retry:PASS']);
  });

  it('three non-answers fail the milestone closed, as inconclusive and flagged for review', async () => {
    const v = verifier([empty(), empty(), empty()]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.verdict, 'not_met');
    assert.equal(r.passed, false);
    assert.equal(r.inconclusive, true);
    assert.equal(r.needsReview, true);
    assert.equal(r.row.inconclusive, true);
    assert.match(r.row.result, /^\[CHECKPOINT VERIFICATION INCONCLUSIVE\] No terminal PASS\/FAIL verdict/);
  });
});

describe('a FAIL for evidence the verifier could not see', () => {
  it('is re-derived on the complete evidence, and that verdict stands', async () => {
    const v = verifier([fail(UNSEEN), pass()]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.verdict, 'met');
    assert.deepEqual(r.trail, ['first:FAIL', 'full:PASS']);
    assert.match(v.prompts[1].instruction, /## Complete Evidence/);
  });

  it('still unseen on the complete evidence: not met, inconclusive, the work not judged wrong', async () => {
    const v = verifier([fail(UNSEEN), fail(UNSEEN)]);
    const r = await verifyMilestone(base(v.callAgent));
    assert.equal(r.passed, false);
    assert.equal(r.inconclusive, true);
    assert.equal(r.needsReview, true);
    assert.match(r.row.result, /^\[CHECKPOINT VERIFICATION INCONCLUSIVE\][\s\S]*The work was NOT judged wrong/);
  });
});

// The defect fixed while porting: a checkpoint could pass on compacted evidence.
describe('a verdict reached on a partial view is re-derived on the complete evidence', () => {
  const MIDDLE = 'MIDDLE-SECTION-WEST-REGION';
  const long = `${'head line\n'.repeat(80)}${MIDDLE}\n${'tail line\n'.repeat(80)}`;
  const cutRows = [{ step: '1.1', agent: 'motor', result: smartTruncate(long, 500), success: true }];
  const fullOut = [{ step: '1.1', agent: 'motor', output: long }];

  it('a PASS on a cut row is re-verified, and a FAIL on the complete evidence wins', async () => {
    const v = verifier([pass(), fail('the west region table is empty')]);
    const r = await verifyMilestone(base(v.callAgent, { rows: cutRows, fullOutputs: fullOut }));
    assert.doesNotMatch(v.prompts[0].instruction, new RegExp(MIDDLE), 'the first look really was partial');
    assert.match(v.prompts[1].instruction, new RegExp(MIDDLE), 'the re-check sees the cut middle');
    assert.deepEqual(r.trail, ['first:PASS', 'full:FAIL']);
    assert.equal(r.verdict, 'not_met');
    assert.equal(r.passed, false);
  });

  it('a PASS confirmed on the complete evidence stands as a clean pass', async () => {
    const v = verifier([pass(), pass()]);
    const r = await verifyMilestone(base(v.callAgent, { rows: cutRows, fullOutputs: fullOut }));
    assert.equal(r.verdict, 'met');
    assert.deepEqual(r.caveats, []);
  });

  it('a PASS the complete-evidence re-check could not confirm stands only as met with a caveat', async () => {
    const v = verifier([pass(), empty()]);
    const r = await verifyMilestone(base(v.callAgent, { rows: cutRows, fullOutputs: fullOut }));
    assert.equal(r.verdict, 'met_with_caveat');
    assert.deepEqual(r.caveats, [CAVEATS.fullUnconfirmed]);
    assert.match(r.row.result, /partial view of the evidence/);
  });

  it('an evidence block clipped to the prompt budget counts as partial', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ step: `1.${i + 1}`, agent: 'motor', result: `row ${i} `.repeat(400), success: true }));
    const full = rows.map((r) => ({ step: r.step, agent: r.agent, output: r.result }));
    const v = verifier([pass(), pass()]);
    const r = await verifyMilestone(base(v.callAgent, { rows, fullOutputs: full }));
    assert.deepEqual(r.trail, ['first:PASS', 'full:PASS']);
  });

  it('a tool result replaced by its digest counts as partial, and the re-check restores the stored result', async () => {
    const stored = `FULL-STORED-RESULT ${'r'.repeat(200)}`;
    const out = `Read the sheet back.${toolLog(`[TOOL] runCommand({"command":"sheet-read"}) → [digest of ${stored.length} chars — full result: ${REF}]\na short digest of the sheet`)}`;
    const v = verifier([pass(), pass()]);
    const reads = [];
    const r = await verifyMilestone(base(v.callAgent, {
      rows: [{ step: '1.1', agent: 'motor', result: out, success: true }],
      fullOutputs: [{ step: '1.1', agent: 'motor', output: out }],
      readToolResult: async (ref) => { reads.push(ref); return ref === REF ? stored : null; },
    }));
    assert.deepEqual(r.trail, ['first:PASS', 'full:PASS']);
    assert.deepEqual(reads, [REF]);
    assert.match(v.prompts[1].instruction, /FULL-STORED-RESULT/);
  });
});

// The defect fixed while porting: a checkpoint could pass with an inconclusive adversarial check.
describe('the adversarial pass', () => {
  const highStakes = { stakes: 'consequential' };

  it('runs only when the stakes call for it, or the work is load-bearing', async () => {
    const routine = verifier([pass()]);
    assert.deepEqual((await verifyMilestone(base(routine.callAgent))).trail, ['first:PASS']);
    const bearing = verifier([pass(), pass()]);
    assert.deepEqual((await verifyMilestone(base(bearing.callAgent, { loadBearing: true }))).trail, ['first:PASS', 'attack:PASS']);
    assert.match(bearing.prompts[1].instruction, /Now try to overturn it \(stakes: routine, load-bearing\)/);
  });

  it('an attack that does not land upholds a clean pass', async () => {
    const v = verifier([pass(), pass()]);
    const r = await verifyMilestone(base(v.callAgent, highStakes));
    assert.equal(r.verdict, 'met');
    assert.deepEqual(r.trail, ['first:PASS', 'attack:PASS']);
  });

  it('an attack that lands overturns the pass', async () => {
    const v = verifier([pass(), fail('the totals double-count the east region')]);
    const r = await verifyMilestone(base(v.callAgent, highStakes));
    assert.equal(r.verdict, 'not_met');
    assert.match(r.row.result, /double-count the east region/);
  });

  it('an attack that returns no verdict leaves the pass standing only as met with a caveat', async () => {
    const v = verifier([pass(), empty()]);
    const r = await verifyMilestone(base(v.callAgent, highStakes));
    assert.equal(r.verdict, 'met_with_caveat');
    assert.equal(r.passed, true);
    assert.deepEqual(r.caveats, [CAVEATS.attackInconclusive]);
    assert.match(r.row.result, /^\[MILESTONE MET — WITH CAVEAT\] The adversarial check/);
  });

  it('an attack whose dispatch throws is inconclusive the same way', async () => {
    const v = verifier([pass(), new Error('timeout')]);
    const r = await verifyMilestone(base(v.callAgent, highStakes));
    assert.equal(r.verdict, 'met_with_caveat');
  });

  it('an attack that only says the evidence was out of view did not land: met with a caveat', async () => {
    const v = verifier([pass(), fail(UNSEEN)]);
    const r = await verifyMilestone(base(v.callAgent, highStakes));
    assert.equal(r.verdict, 'met_with_caveat');
    assert.deepEqual(r.caveats, [CAVEATS.attackInconclusive]);
  });

  it("keeps the verifier's own caveat alongside the adversarial one", async () => {
    const v = verifier([pass('One field resolves at runtime.'), empty()]);
    const r = await verifyMilestone(base(v.callAgent, highStakes));
    assert.deepEqual(r.caveats, ['One field resolves at runtime.', CAVEATS.attackInconclusive]);
  });
});
