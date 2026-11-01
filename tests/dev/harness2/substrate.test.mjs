// Tests for dev/harness2/substrate.mjs runTier1Evaluation's handling of a rollout that throws: an
// infrastructure error (the network, a git command making a side) runs the rollout again, and one that
// keeps failing is not evaluated rather than ending the run; a run with too many of those is
// incomplete; any other error is a failed run of the side; a spend cap still stops the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLLOUT_RETRY, isInfrastructureError, runTier1Evaluation } from '../../../dev/harness2/substrate.mjs';

const TASKS = [{ id: 'a', split: 'train' }, { id: 'b', split: 'holdout' }];
const passed = () => ({ measured: true, checkScore: 1, fixtureVerification: { checks: [{ name: 'it works', ok: true }] } });
const withCode = (code) => Object.assign(new Error(`connect ${code} 127.0.0.1:443`), { code });

/** runTier1Evaluation with a scripted rollout: `plan(taskId, call)` returns a rollout or throws. */
async function evaluate(plan, opts = {}) {
  const calls = [];
  const slept = [];
  const lines = [];
  const res = await runTier1Evaluation({
    tasks: TASKS,
    trials: 1,
    runTaskRollout: async (task) => {
      calls.push(task.id);
      return plan(task.id, calls.filter((id) => id === task.id).length);
    },
    sleep: async (ms) => { slept.push(ms); },
    log: (line) => lines.push(line),
    ...opts,
  });
  return { res, calls, slept, lines };
}

test('what counts as an infrastructure error: the network, by code, message or cause, and a failed git command', () => {
  assert.equal(isInfrastructureError(new TypeError('fetch failed')), true);
  assert.equal(isInfrastructureError(withCode('ECONNRESET')), true);
  assert.equal(isInfrastructureError(Object.assign(new TypeError('fetch failed'), { cause: withCode('UND_ERR_SOCKET') })), true);
  assert.equal(isInfrastructureError(new Error('outer', { cause: withCode('EAI_AGAIN') })), true, 'found through the cause');
  assert.equal(isInfrastructureError(new Error('socket hang up')), true);
  assert.equal(isInfrastructureError(new Error('Command failed: git worktree add --detach /tmp/x abc')), true);
  assert.equal(isInfrastructureError(new TypeError('brain.parts is undefined')), false, "the side's own code");
  assert.equal(isInfrastructureError(new Error('CANDIDATE-BRAIN-BROKEN')), false);
  assert.equal(isInfrastructureError(null), false);
  assert.equal(ROLLOUT_RETRY.attempts, 3);
});

test('a rollout that fails on infrastructure runs again, with a growing wait, and counts once it succeeds', async () => {
  const { res, calls, slept, lines } = await evaluate((id, call) => {
    if (id === 'a' && call < 3) throw new TypeError('fetch failed');
    return passed();
  }, { retry: { backoffMs: 10 } });
  assert.deepEqual(calls, ['a', 'a', 'a', 'b']);
  assert.deepEqual(slept, [10, 20]);
  assert.deepEqual(res.trajectories.map((t) => [t.taskId, t.checkScore]), [['a', 1], ['b', 1]]);
  assert.deepEqual(res.notEvaluated, []);
  assert.equal(res.incomplete, undefined);
  assert.match(lines[0], /^\[WARN\] a \(trial 1\) failed on infrastructure \(fetch failed\); running it again \(attempt 2 of 3\)$/);
});

test('a rollout that keeps failing on infrastructure is not evaluated; too many such runs make the run incomplete', async () => {
  const one = await evaluate((id) => {
    if (id === 'a') throw withCode('ETIMEDOUT');
    return passed();
  }, { retry: { maxNotEvaluatedShare: 0.5 } });
  assert.deepEqual(one.calls, ['a', 'a', 'a', 'b']);
  assert.deepEqual(one.res.trajectories.map((t) => t.taskId), ['b'], 'left out of the results, which go on');
  assert.deepEqual(one.res.notEvaluated, [{ taskId: 'a', trial: 1, attempts: 3, reason: 'connect ETIMEDOUT 127.0.0.1:443' }]);
  assert.equal(one.res.incomplete, undefined, 'one run in two is within a 50% share');

  const all = await evaluate((id) => {
    if (id === 'a') throw withCode('ETIMEDOUT');
    return passed();
  });
  assert.equal(all.res.incomplete, '1 of 2 runs failed on infrastructure and were not evaluated (more than 25%): connect ETIMEDOUT 127.0.0.1:443');
});

test("any other error is a failed run of the side: measured in a real-model run, capability 0, its check says what threw", async () => {
  const run = (failedRunsMeasured) => evaluate((id) => {
    if (id === 'a') throw new TypeError("Cannot read properties of undefined (reading 'tick')");
    return passed();
  }, { failedRunsMeasured });
  const real = await run(true);
  assert.deepEqual(real.calls, ['a', 'b'], 'not run again');
  const a = real.res.trajectories.find((t) => t.taskId === 'a');
  assert.deepEqual([a.measured, a.checkScore, a.split], [true, 0, 'train']);
  assert.deepEqual(a.checks, [{ name: 'the rollout ran', ok: false, detail: "Cannot read properties of undefined (reading 'tick')" }]);
  assert.match(real.lines[0], /a \(trial 1\) failed: Cannot read properties.*; it counts as a failed run/);
  const scripted = await run(false);
  assert.equal(scripted.res.trajectories.find((t) => t.taskId === 'a').measured, false, 'outside a real-model run it measures nothing');
});

test('a run that reaches its spend cap still stops', async () => {
  const cap = Object.assign(new Error('the run reached its cap of 1 model rollouts (--max-rollouts)'), { name: 'SpendCapReached' });
  await assert.rejects(evaluate((id) => {
    if (id === 'b') throw cap;
    return passed();
  }), /reached its cap/);
});
