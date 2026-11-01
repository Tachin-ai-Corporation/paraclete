// Tests for what dev/harness2/cli.mjs added around real-model runs and the off switch: a cycle refuses
// while paused, a real-model run reports and enforces its spend cap and removes its checkouts, its runs
// are measured and its selection summary leaves the held-out tasks out; and recursion.mjs never hands
// a held-out run's prescription to the proposer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../../dev/harness2/cli.mjs';
import { snapshotCandidateConfig, startInProcessFixtureGateway } from '../../../dev/harness2/live-runner.mjs';
import { createModelRunContext } from '../../../dev/harness2/model-runs.mjs';
import { runWithinGenerationRecursion } from '../../../dev/harness2/recursion.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const quiet = { write() {} };

test('evolve, promote and curriculum refuse while the harness is paused; read-only commands do not', async () => {
  const env = { PARACLETE_H2_PAUSED: '1' };
  for (const argv of [['evolve'], ['promote', '--live'], ['curriculum', '--unit', 'unit-organ-motor']]) {
    const res = await runCli(argv, { env, repoRoot: REPO });
    assert.deepEqual([res.ok, res.paused], [false, true], argv.join(' '));
    assert.match(res.reason, /the harness is paused: PARACLETE_H2_PAUSED is set/);
  }
  assert.equal((await runCli(['surface'], { env, repoRoot: REPO })).ok, true);
});

/** A real-model context whose model is the scripted gateway and whose every side is this checkout. */
function fakeContext(limits, record) {
  return () => {
    const ctx = createModelRunContext({
      repoRoot: REPO,
      access: { project: 'your-gcp-project', getAccessToken: async () => 'token' },
      limits,
      sides: { forPatches: () => ({ root: REPO, key: 'k' }), prepareRole: (s, role) => ({ role }), cleanupAll: () => { record.cleanups += 1; } },
      startGateway: async (o) => startInProcessFixtureGateway({
        task: { id: 'any' }, fixture: null, workspaceDir: o.dataRoot, configSnapshot: snapshotCandidateConfig(o.sideRoot, o.role), usageRecords: [],
      }),
      timeoutMs: 60_000,
    });
    record.contexts += 1;
    return ctx;
  };
}

test('a real-model eval measures every run, scores selection on the training tasks only, and cleans up', async () => {
  const record = { cleanups: 0, contexts: 0 };
  const lines = [];
  const res = await runCli(['eval', '--real-model', '--role', 'devops-engineer'], {
    repoRoot: REPO, createModelRunContext: fakeContext({ maxRollouts: 10 }, record), stderr: { write: (l) => lines.push(l) },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.trajectories.map((t) => [t.taskId, t.split, t.measured, t.scripted]),
    [['devops-plan-order', 'train', true, false], ['devops-log-forensics', 'holdout', true, false]]);
  assert.equal(res.summary.count, 1, 'selection sees the training task only');
  assert.equal(res.holdoutSummary.count, 1);
  assert.equal(res.spend.rollouts, 2);
  assert.deepEqual([record.contexts, record.cleanups], [1, 1]);
  assert.match(lines.join(''), /real-model run: every organ answers through the model; at most 10 rollouts/);
  assert.match(lines.join(''), /about 2 model rollouts/);
});

test('a real-model eval with --task runs the named tasks only, and refuses a name the suite has not', async () => {
  const record = { cleanups: 0, contexts: 0 };
  const res = await runCli(['eval', '--real-model', '--task', 'data-revenue-summary', '--trials', '2'], {
    repoRoot: REPO, createModelRunContext: fakeContext({ maxRollouts: 10 }, record), stderr: quiet,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.trajectories.map((t) => [t.taskId, t.trial]), [['data-revenue-summary', 1], ['data-revenue-summary', 2]]);
  const none = await runCli(['eval', '--real-model', '--task', 'no-such-task'], { repoRoot: REPO, createModelRunContext: fakeContext({}, record), stderr: quiet });
  assert.deepEqual([none.ok, none.reason], [false, 'no model-suite task is named no-such-task']);
});

test('a real-model eval whose runs keep failing on infrastructure measures nothing, and says why', async () => {
  const record = { cleanups: 0, contexts: 0 };
  const lines = [];
  const offline = () => {
    const ctx = fakeContext({ maxRollouts: 10 }, record)();
    ctx.startGateway = async () => { throw new TypeError('fetch failed'); };
    return ctx;
  };
  const res = await runCli(['eval', '--real-model', '--role', 'devops-engineer'], {
    repoRoot: REPO, createModelRunContext: offline, stderr: { write: (l) => lines.push(l) }, retry: { attempts: 2, backoffMs: 1 }, sleep: async () => {},
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /^2 of 2 runs failed on infrastructure and were not evaluated \(more than 25%\): fetch failed$/);
  assert.deepEqual(res.notEvaluated.map((r) => [r.taskId, r.attempts]), [['devops-plan-order', 2], ['devops-log-forensics', 2]]);
  assert.deepEqual(res.trajectories, []);
  assert.equal(record.cleanups, 1);
  assert.match(lines.join(''), /devops-plan-order \(trial 1\) failed on infrastructure \(fetch failed\); running it again \(attempt 2 of 2\)/);
});

test('a real-model run whose estimate is over its cap is refused before it spends anything, and cleans up', async (t) => {
  const record = { cleanups: 0, contexts: 0 };
  const res = await runCli(['eval', '--real-model', '--role', 'devops-engineer', '--max-rollouts', '1'], {
    repoRoot: REPO, createModelRunContext: fakeContext({ maxRollouts: 1 }, record), stderr: quiet,
  });
  assert.equal(res.ok, false);
  assert.equal(res.spendCapWouldBeReached, true);
  assert.match(res.reason, /needs about 2 model rollouts, over its cap of 1: name a --role/);
  assert.equal(res.spend.rollouts, 0);
  assert.equal(record.cleanups, 1);
});

test('a promotion sized past the default cap is refused up front, with the way to fit it', async () => {
  const record = { cleanups: 0, contexts: 0 };
  // Every task, three trials, two generations of two steps: far over 120 rollouts.
  const res = await runCli(['promote', '--real-model', '--push-pr', '--dry-run'], {
    repoRoot: REPO, createModelRunContext: fakeContext({}, record), stderr: quiet, cycleLog: false,
  });
  assert.equal(res.spendCapWouldBeReached, true);
  assert.match(res.reason, /over its cap of 120/);
  assert.equal(res.spend.rollouts, 0);
});

test("a held-out run's prescription never reaches the proposer", async () => {
  const specs = [];
  await runWithinGenerationRecursion({
    lens: 'DOM',
    maxSteps: 1,
    parentState: {
      id: 'gen0',
      scores: { capability: 0.5 },
      trajectories: [
        { missionId: 'm-train', taskId: 'a', split: 'train', evalCritique: { improvementPrescription: 'TRAIN-PRESCRIPTION' } },
        { missionId: 'm-hold', taskId: 'b', split: 'holdout', evalCritique: { improvementPrescription: 'HOLDOUT-PRESCRIPTION' } },
      ],
    },
    proposeAndApply: async (spec) => {
      specs.push(spec);
      return { id: 'c1', touchedPaths: [], proposal: { source: 'none' } };
    },
    validateCandidate: () => ({ ok: true, violations: [] }),
    evaluateCandidate: async () => ({ summary: {}, trajectories: [] }),
  });
  const told = specs[0].judgePrescriptions.join(' ');
  assert.match(told, /TRAIN-PRESCRIPTION/);
  assert.doesNotMatch(told, /HOLDOUT-PRESCRIPTION/);
});
