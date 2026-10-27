// Tests for dev/loop/baseline.mjs: a real-model evaluation's trajectories carry each check, and the
// summary counts them for training tasks only; when a baseline is due; which training tasks main's head
// fails; how a planned issue names its target; and when a measurement shows the target improved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_SUITE_VERSION } from '../../../dev/harness2/model-suite.mjs';
import { runTier1Evaluation } from '../../../dev/harness2/substrate.mjs';
import {
  BASELINE_PATH, baselineDue, failingTasks, issueTarget, readBaseline, summarizeBaseline, targetProblems, taskPlanKey, writeBaseline,
} from '../../../dev/loop/baseline.mjs';

const TRAIN = { id: 'se-fix-failing-test', role: 'software-engineer', split: 'train', expectedClauses: ['fix it'] };
const HOLDOUT = { id: 'se-implement-from-spec', role: 'software-engineer', split: 'holdout', expectedClauses: ['build it'] };

/** A real-model rollout whose checks came out as given: true passes, false fails. */
const rollout = (checks) => ({
  envelope: { id: 'w', role: 'software-engineer', status: 'completed', checkpoint_spine: [] },
  checkpoints: [],
  tasks: [],
  measured: true,
  checkScore: checks.filter(Boolean).length / checks.length,
  fixtureVerification: { checks: checks.map((ok, i) => ({ name: `check ${i + 1}`, ok, ...(ok ? { detail: 'fine' } : { detail: `missed ${i + 1}` }) })) },
});

test("a real-model run's trajectory carries its checks, and the summary counts them for training tasks only", async () => {
  const outcomes = { [TRAIN.id]: [[true, false], [true, false]], [HOLDOUT.id]: [[false, false], [true, false]] };
  const result = await runTier1Evaluation({ tasks: [TRAIN, HOLDOUT], trials: 2, runTaskRollout: async (task) => rollout(outcomes[task.id].shift()) });
  const run = result.trajectories.find((t) => t.taskId === TRAIN.id);
  assert.deepEqual(run.checks, [{ name: 'check 1', ok: true }, { name: 'check 2', ok: false, detail: 'missed 2' }], 'a passed check carries no detail');

  const summary = summarizeBaseline(result, { commit: 'c'.repeat(40), at: '2027-01-21T12:00:00.000Z' });
  assert.deepEqual([summary.suiteVersion, summary.commit, summary.trials, summary.measured], [MODEL_SUITE_VERSION, 'c'.repeat(40), 2, true]);
  const [train, holdout] = summary.tasks;
  assert.deepEqual(train, {
    id: TRAIN.id, role: 'software-engineer', split: 'train', runs: 2, measuredRuns: 2, score: 0.5,
    checks: [{ name: 'check 1', runs: 2, failed: 0 }, { name: 'check 2', runs: 2, failed: 2, detail: 'missed 2' }],
  });
  assert.deepEqual(holdout, { id: HOLDOUT.id, role: 'software-engineer', split: 'holdout', runs: 2, measuredRuns: 2, score: 0.25 },
    'a held-out task is a score: none of its checks is named');

  const scripted = summarizeBaseline({ trials: 1, trajectories: result.trajectories.map((t) => ({ ...t, measured: false })) }, {});
  assert.equal(scripted.measured, false);
  assert.deepEqual(failingTasks(scripted), [], 'nothing is planned from runs that were not real-model runs');
});

test('the training tasks main fails: a check failing in most measured runs, worst task first, this suite only', () => {
  const task = (id, score, checks, split = 'train') => ({ id, role: 'generic', split, runs: 2, measuredRuns: 2, score, checks });
  const summary = {
    suiteVersion: MODEL_SUITE_VERSION, measured: true,
    tasks: [
      task('b-task', 0.5, [{ name: 'half', runs: 2, failed: 1 }, { name: 'always', runs: 2, failed: 2 }]),
      task('a-task', 0.25, [{ name: 'mostly', runs: 3, failed: 2 }]),
      task('c-task', 1, [{ name: 'fine', runs: 2, failed: 0 }]),
      task('d-task', 0, [{ name: 'held', runs: 2, failed: 2 }], 'holdout'),
    ],
  };
  const failing = failingTasks(summary);
  assert.deepEqual(failing.map((t) => [t.id, t.failing.map((c) => c.name)]), [['a-task', ['mostly']], ['b-task', ['always']]]);
  assert.deepEqual(failingTasks({ ...summary, suiteVersion: MODEL_SUITE_VERSION + 1 }), [], 'another version of the suite');

  const key = taskPlanKey(failing[1]);
  assert.match(key, new RegExp(`^model-b-task-v${MODEL_SUITE_VERSION}-[0-9a-f]{8}$`));
  assert.equal(taskPlanKey({ ...failing[1] }), key, 'the same failure, the same key');
  assert.notEqual(taskPlanKey({ ...failing[1], failing: [{ name: 'half' }] }), key, 'other failing checks, a new key');
});

test('a baseline is due once a day at most, never again on a head already measured', () => {
  const NOW = new Date('2027-01-21T12:00:00Z');
  const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const kept = (h, commit, ok = true) => ({ latest: ok ? { suiteVersion: MODEL_SUITE_VERSION, commit } : null, attempt: { at: hoursAgo(h), commit, ok } });
  assert.equal(baselineDue({ kept: { latest: null, attempt: null }, head: 'a', now: NOW }), true, 'never measured');
  assert.equal(baselineDue({ kept: kept(30, 'a'), head: 'a', now: NOW }), false, 'this head is measured');
  assert.equal(baselineDue({ kept: kept(5, 'a'), head: 'b', now: NOW }), false, 'main moved, but the last was 5 hours ago');
  assert.equal(baselineDue({ kept: kept(25, 'a'), head: 'b', now: NOW }), true);
  assert.equal(baselineDue({ kept: kept(5, 'a', false), head: 'a', now: NOW }), false, 'a failed attempt is not retried at once');
  assert.equal(baselineDue({ kept: kept(25, 'a', false), head: 'a', now: NOW }), true, 'and is, a day later');
});

test('the kept file holds the latest summary and the last attempt; a failed attempt keeps the summary before it', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-baseline-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.deepEqual(readBaseline({ repoRoot }), { latest: null, attempt: null });
  writeBaseline({ repoRoot, kept: readBaseline({ repoRoot }), summary: { commit: 'a' }, attempt: { at: 'x', commit: 'a', ok: true, reason: null } });
  writeBaseline({ repoRoot, kept: readBaseline({ repoRoot }), summary: null, attempt: { at: 'y', commit: 'b', ok: false, reason: 'no project' } });
  assert.deepEqual(readBaseline({ repoRoot }), { latest: { commit: 'a' }, attempt: { at: 'y', commit: 'b', ok: false, reason: 'no project' } });
  assert.ok(fs.existsSync(path.join(repoRoot, BASELINE_PATH)));
});

test("an issue's target, and whether a measurement shows the target task improved", () => {
  assert.equal(issueTarget('Fails.\n\n<!-- loop-plan: model-x-v1-abcd1234 -->\n<!-- loop-target: se-fix-failing-test -->'), 'se-fix-failing-test');
  assert.equal(issueTarget('**Done when:**\n- a\n'), null);
  const evidence = (baseline, candidate) => ({ perTask: [{ taskId: 'se-fix-failing-test', baseline: { n: 3, mean: baseline }, candidate: { n: 3, mean: candidate } }] });
  assert.deepEqual(targetProblems(evidence(0.5, 0.75), 'se-fix-failing-test'), []);
  assert.match(targetProblems(evidence(0.5, 0.5), 'se-fix-failing-test')[0], /did not improve: capability 0\.5 -> 0\.5/);
  assert.match(targetProblems(evidence(0.5, 0.75), 'other-task')[0], /did not run the target task other-task on both sides/);
  assert.match(targetProblems(null, 'se-fix-failing-test')[0], /did not run the target task/);
});
