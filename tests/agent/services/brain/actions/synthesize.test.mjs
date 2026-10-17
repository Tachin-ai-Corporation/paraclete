// Tests for agent/services/brain/actions/synthesize.mjs: the answer-first deliverable and its
// epistemic bins, the gates before a mission may complete (an unresolved failure, an unmet
// deliverable checkpoint), and the cerebellum's check of the synthesis: a FAIL steers to an honest
// failure, no verdict asks for review, a pass with a caveat shows it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeAnswerFirst, epistemicBin, handleSynthesize, isSynthExempt,
} from '../../../../../agent/services/brain/actions/synthesize.mjs';
import { verdict } from '../fake-gateway.mjs';

const SETTINGS = { maxIterations: 50, synthVerifyMinChars: 400, attackStakesMin: 'consequential', executor: { ctxVerifyPrior: 16000 }, resourceLedger: { recallLimit: 40 } };

function mockDeps({ cerebellum = () => verdict(true) } = {}) {
  const calls = { completions: [], cts: [], cerebellum: [] };
  const deps = {
    settings: SETTINGS,
    log: () => {},
    store: { createCT: async (env, opts) => { calls.cts.push(opts); return 'c-1'; } },
    completeEnvelope: async (env, opts) => { calls.completions.push(opts); env.status = opts.status; return { ok: true }; },
    callAgent: async (organ, payload) => { calls.cerebellum.push(payload); return { success: true, output: cerebellum(payload) }; },
  };
  return { deps, calls };
}

const envelope = (over = {}) => ({ id: 'm-1', instruction: 'Write the report', accept_criteria: 'The report covers revenue and costs for Q3', ...over });
const ctx = (env, decision, priorResults = [], iteration = 3) => ({ envelope: env, decision, priorResults, iteration });

describe('epistemicBin: an unlabelled claim is not a labelled one', () => {
  it('passes the three real bins through unchanged', () => {
    for (const b of ['verified', 'inferred', 'assumed']) assert.equal(epistemicBin(b), b);
  });
  it('falls back to the most cautious bin, never to undefined', () => {
    for (const bad of [undefined, null, '', '   ', 'confirmed', 'true', 42, {}, []]) assert.equal(epistemicBin(bad), 'assumed');
  });
  it('is tolerant of case and padding, since it labels a model\'s output', () => {
    assert.equal(epistemicBin('Verified'), 'verified');
    assert.equal(epistemicBin('  INFERRED '), 'inferred');
  });
});

describe('composeAnswerFirst', () => {
  it('leads with the answer, then the reasoning, then risk and assumptions, least certain first', () => {
    const out = composeAnswerFirst({
      answer: 'Revenue rose 8%.',
      risk: 'Q3 numbers are preliminary.',
      assumptions: [{ claim: 'Totals reconcile', status: 'verified' }, { claim: 'FX held', status: 'nonsense' }, { claim: '', status: 'verified' }],
    }, 'Summed the ledger.');
    assert.equal(out, 'Revenue rose 8%.\n\n— Reasoning —\nSummed the ledger.\n\n— Risk & assumptions —\nQ3 numbers are preliminary.\n• [assumed] FX held\n• [verified] Totals reconcile');
    assert.doesNotMatch(out, /undefined/);
  });
  it('without an answer the synthesis stands as written', () => {
    assert.equal(composeAnswerFirst({}, 'Done.'), 'Done.');
  });
});

describe('isSynthExempt', () => {
  it('only a short answer to work without real criteria skips verification', () => {
    assert.equal(isSynthExempt({ output: 'Hi.' }, 400), true);
    assert.equal(isSynthExempt({ output: 'Hi.', accept_criteria: 'a real, stated acceptance criterion' }, 400), false);
    assert.equal(isSynthExempt({ output: 'x'.repeat(500) }, 400), false);
  });
});

describe('handleSynthesize', () => {
  it('completes a verified synthesis, answer first, with the synthesis recorded under the mission', async () => {
    const { deps, calls } = mockDeps();
    const res = await handleSynthesize(ctx(envelope(), { action: 'synthesize', synthesis: 'Summed it.', answer: 'Q3 revenue: $1.2M.' }), deps);
    assert.deepEqual(res, { exit: true });
    assert.equal(calls.completions[0].status, 'complete');
    assert.match(calls.completions[0].output, /^Q3 revenue: \$1\.2M\.\n\n— Reasoning —\nSummed it\./);
    assert.equal(calls.cts[0].ctKey, 'synth-m-1-3');
    assert.match(calls.cerebellum[0].instruction, /## Acceptance Criteria\nThe report covers revenue/);
    assert.doesNotMatch(calls.cerebellum[0].instruction, /request_probe|Probe/, 'there is no probe');
  });

  it('an unresolved real failure refuses the synthesis; inconclusive and timed-out rows do not', async () => {
    const { deps, calls } = mockDeps();
    const refused = await handleSynthesize(ctx(envelope(), { synthesis: 'Done' }, [
      { agent: 'motor', success: true }, { agent: 'motor', success: false, result: 'failed' },
    ]), deps);
    assert.match(refused.priorResultsAppend[0].result, /Synthesize refused/);
    assert.deepEqual([refused.activeGuard.forbidden, refused.activeGuard.fallback], ['synthesize', 'checkpoint_plan']);
    // Three correctly edited documents, one milestone the verifier could not see: not a failure.
    const done = await handleSynthesize(ctx(envelope(), { synthesis: 'Done' }, [
      { agent: 'motor', success: true }, { agent: 'cerebellum', success: false, inconclusive: true }, { agent: 'motor', success: false, timedOut: true },
    ]), deps);
    assert.deepEqual(done, { exit: true });
    assert.equal(calls.completions.length, 1);
  });

  it('nothing is reported complete while the deliverable checkpoint is unmet; on the last turn it asks instead', async () => {
    const spine = [{ n: 1, outcome: 'Draft', status: 'complete' }, { n: 2, outcome: 'Publish the page', status: 'failed' }];
    const { deps, calls } = mockDeps();
    const res = await handleSynthesize(ctx(envelope({ _cp_spine: spine }), { synthesis: 'Published!' }), deps);
    assert.match(res.priorResultsAppend[0].result, /Cannot synthesize COMPLETE: the deliverable checkpoint "Publish the page" is not done \(unmet: CP2 \(failed\)/);
    assert.equal(res.activeGuard.fallback, 'needs_input');
    assert.equal(calls.completions.length, 0);
    await handleSynthesize(ctx(envelope({ _cp_spine: spine }), { synthesis: 'Published!' }, [], 49), deps);
    assert.equal(calls.completions[0].status, 'needs_input');
    assert.match(calls.completions[0].output, /did not finish/);
  });

  it('a FAIL on the synthesis is a defect in the answer: it steers to an honest failure, never to redoing the work', async () => {
    const { deps, calls } = mockDeps({ cerebellum: () => verdict(false, { reasoning: 'claims costs were reconciled; nothing shows it' }) });
    const res = await handleSynthesize(ctx(envelope(), { synthesis: 'All reconciled.' }), deps);
    assert.equal(calls.completions.length, 0);
    assert.deepEqual([res.activeGuard.forbidden, res.activeGuard.fallback], ['synthesize', 'synthesize_with_failure']);
    assert.match(res.priorResultsAppend[0].result, /^\[VERIFICATION FAILED\][\s\S]*Do NOT redo the work/);
    assert.equal(res.priorResultsAppend[0].synthesis_verdict, 'FAIL', 'marked, so the honest-failure path is not upgraded back');
  });

  it('no verdict completes the mission marked for review', async () => {
    const env = envelope();
    const { deps, calls } = mockDeps({ cerebellum: () => 'I looked at it.' });
    await handleSynthesize(ctx(env, { synthesis: 'Done.' }), deps);
    assert.equal(calls.completions[0].status, 'complete');
    assert.equal(env.needs_review, true);
  });

  it('a pass with a caveat completes with the caveat shown, together with the checkpoints\' caveats', async () => {
    const { deps, calls } = mockDeps({ cerebellum: () => verdict(true, { caveat: 'Costs for September are estimates.' }) });
    await handleSynthesize(ctx(envelope({ _milestone_caveats: ['CP1: two rows resolve at runtime.'] }), { synthesis: 'Report written.' }), deps);
    assert.match(calls.completions[0].output, /Report written\.\n\n— Caveats \(noted, non-blocking\) —\n• CP1: two rows resolve at runtime\.\n• Costs for September are estimates\./);
  });

  it('the verifier sees the established evidence, the known ids, and at consequential stakes an attack duty', async () => {
    const { deps, calls } = mockDeps();
    const env = envelope({ stakes: 'consequential', context: { resources: { 'doc:report': { kind: 'doc', name: 'Report', id: '1RePoRt000000000000000000000' } } } });
    await handleSynthesize(ctx(env, { synthesis: 'Done.' }, [
      { agent: 'motor', checkpoint_step: '1.1', success: true, summary: 'Wrote the Q3 sheet', result: 'long' },
      { agent: 'cerebellum', checkpoint_step: '1.verify', success: true, result: 'PASS' },
    ]), deps);
    const instruction = calls.cerebellum[0].instruction;
    assert.match(instruction, /## Previously Established[^\n]*\n- 1\.1 \(motor\): Wrote the Q3 sheet/);
    assert.doesNotMatch(instruction, /1\.verify/);
    assert.match(instruction, /## Known Resources[\s\S]*1RePoRt000000000000000000000/);
    assert.match(instruction, /## Attack Duty \(stakes: consequential\)/);
    const routine = mockDeps();
    await handleSynthesize(ctx(envelope(), { synthesis: 'Done.' }), routine.deps);
    assert.doesNotMatch(routine.calls.cerebellum[0].instruction, /Attack Duty/);
  });

  it('a short answer with no criteria completes without a verification call', async () => {
    const { deps, calls } = mockDeps();
    await handleSynthesize(ctx({ id: 'm-2', instruction: 'Say hi' }, { synthesis: 'Hi!' }), deps);
    assert.equal(calls.cerebellum.length, 0);
    assert.equal(calls.completions[0].output, 'Hi!');
  });
});
