// Tests for agent/services/brain/actions/synthesize-with-failure.mjs: the honest end of work that did
// not fully succeed, in its three states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSynthesizeWithFailure } from '../../../../../agent/services/brain/actions/synthesize-with-failure.mjs';

function mockDeps() {
  const calls = { completions: [], saves: 0 };
  return {
    calls,
    deps: {
      settings: { maxIterations: 50 },
      log: () => {},
      store: { save: async () => { calls.saves += 1; } },
      completeEnvelope: async (env, opts) => { calls.completions.push(opts); return { ok: true }; },
    },
  };
}

test('recent work that all succeeded is upgraded to a plain synthesis', async () => {
  const { deps } = mockDeps();
  const c = { envelope: { id: 'm-1', type: 'M' }, decision: { synthesis: 'x' }, priorResults: [{ agent: 'motor', success: true }], iteration: 2 };
  assert.deepEqual(await handleSynthesizeWithFailure(c, deps), { nextAction: 'synthesize' });
});

test('recent work is what ran after the last failed plan\'s note, counted in the results themselves', async () => {
  const { deps } = mockDeps();
  // Fixed defect: the note's index in all results was applied to the list of dispatches only, so the
  // window could start in the wrong place.
  const priorResults = [
    { agent: 'motor', success: false, result: 'first try failed' },
    { agent: 'system', result: '[SYSTEM] Checkpoint failed (attempt 1/3).' },
    { agent: 'human', result: 'try the other folder' },
    { agent: 'motor', success: true, result: 'second try worked' },
  ];
  const c = { envelope: { id: 'm-1', type: 'M' }, decision: {}, priorResults, iteration: 4 };
  assert.deepEqual(await handleSynthesizeWithFailure(c, deps), { nextAction: 'synthesize' });
  const failedLast = { envelope: { id: 'm-1', type: 'M' }, decision: {}, priorResults: priorResults.slice(0, 2), iteration: 4 };
  assert.ok((await handleSynthesizeWithFailure(failedLast, deps)).continue, 'the latest plan failed: no upgrade');
});

test('a first real failure gets one self-unblock check; work that succeeds after it goes on to a verified synthesis', async () => {
  const { deps, calls } = mockDeps();
  const env = { id: 'm-1', type: 'M' };
  const failed = { agent: 'motor', success: false };
  const first = await handleSynthesizeWithFailure({ envelope: env, decision: { synthesis: 'Could not reach the API.' }, priorResults: [failed], iteration: 2 }, deps);
  const note = first.priorResultsAppend[0];
  assert.match(note.result, /^\[SELF-UNBLOCK CHECK\]/);
  assert.equal(env._swf_state, 'awaiting_unblock');
  assert.equal(env._failure_synthesis, 'Could not reach the API.');
  assert.equal(calls.saves, 1);
  const decision = { action: 'synthesize_with_failure', synthesis: 'Worked around it.' };
  const second = await handleSynthesizeWithFailure({ envelope: env, decision, priorResults: [failed, note, { agent: 'motor', success: true }], iteration: 5 }, deps);
  assert.deepEqual(second, { nextAction: 'synthesize' }, 'through the finish gate and the verifier, like any answer');
  assert.equal(decision.action, 'synthesize');
  assert.deepEqual(calls.completions, [], 'never completed here');
  assert.equal(env._swf_state, 'unblock_attempted');
});

test('a success from before the self-unblock check does not complete the mission (it skipped verification)', async () => {
  const { deps, calls } = mockDeps();
  const env = { id: 'm-1', type: 'M', _swf_state: 'awaiting_unblock' };
  const note = { agent: 'system', result: '[SELF-UNBLOCK CHECK] Before accepting this failure, check what actually happened.' };
  const priorResults = [{ agent: 'motor', success: true, result: 'step 1 worked' }, { agent: 'motor', success: false, result: 'step 2 failed' }, note,
    { agent: 'motor', success: false, result: 'the other way failed too' }];
  await handleSynthesizeWithFailure({ envelope: env, decision: { synthesis: 'Half done.', failure_summary: 'step 2 cannot run' }, priorResults, iteration: 6 }, deps);
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.completions[0].status, 'blocked', 'the earlier success no longer passes the whole run as complete');
  const nothingAfter = { envelope: { id: 'm-2', type: 'M', _swf_state: 'awaiting_unblock' }, decision: {}, priorResults: priorResults.slice(0, 3), iteration: 6 };
  await handleSynthesizeWithFailure(nothingAfter, deps);
  assert.equal(calls.completions[1].status, 'blocked', 'nothing tried after the check is nothing resolved');
});

test('a failure that stays a failure ends the mission as blocked, its synthesis the account', async () => {
  const { deps, calls } = mockDeps();
  const env = { id: 'm-1', type: 'M', _swf_state: 'awaiting_unblock' };
  await handleSynthesizeWithFailure({ envelope: env, decision: { synthesis: 'The API is down.', failure_summary: 'API 503 on every call' }, priorResults: [{ agent: 'motor', success: false }], iteration: 6 }, deps);
  assert.deepEqual([calls.completions[0].status, calls.completions[0].blocker, calls.completions[0].output], ['blocked', 'API 503 on every call', 'The API is down.']);
});

test('after the verifier failed a synthesis, the work\'s success does not send it back to the same synthesis', async () => {
  const { deps } = mockDeps();
  const priorResults = [
    { agent: 'motor', checkpoint_step: '1.1', success: true, result: 'report written' },
    { agent: 'cerebellum', synthesis_verdict: 'FAIL', result: '[VERIFICATION FAILED] over-claims the reconciliation' },
  ];
  const res = await handleSynthesizeWithFailure({ envelope: { id: 'm-1', type: 'M' }, decision: { synthesis: 'Report written; reconciliation not verified.' }, priorResults, iteration: 4 }, deps);
  assert.match(res.priorResultsAppend[0].result, /SELF-UNBLOCK CHECK/, 'not upgraded: that loop ran until the mission\'s limit');
  const replanned = [...priorResults, { agent: 'motor', checkpoint_step: '2.1', success: true, result: 'reconciled' }];
  assert.deepEqual(await handleSynthesizeWithFailure({ envelope: { id: 'm-2', type: 'M' }, decision: {}, priorResults: replanned, iteration: 6 }, deps),
    { nextAction: 'synthesize' }, 'new work after the judgment counts again');
});
