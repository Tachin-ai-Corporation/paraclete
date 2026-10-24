// Tests for what a review of the real-model harness found: a real-model rollout is isolated (its own
// Firestore, its own instance record for its agent's commands), a mission past its time is cut off and
// says so, a checkout without its role's launchers is not a measurement, a cross-lens merge keeps both
// lenses' changes, a calibration is per role, the cycle command's evolution honours the off switch, a
// pushed promotion returns the checkout to its branch, and a table without leading pipes still counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeLensPatches } from '../../../dev/harness2/cli.mjs';
import { calibrationKey } from '../../../dev/harness2/calibration.mjs';
import { buildPromotionEvidence, judgeEvidence } from '../../../dev/harness2/evidence.mjs';
import { runInProcessBrainRollout, snapshotCandidateConfig, startInProcessFixtureGateway } from '../../../dev/harness2/live-runner.mjs';
import { createModelRunContext } from '../../../dev/harness2/model-runs.mjs';
import { MODEL_SUITE, selectModelTasks } from '../../../dev/harness2/model-suite.mjs';
import { pushAndCreatePullRequest } from '../../../dev/harness2/promote.mjs';
import { startTier1Substrate } from '../../../dev/harness2/substrate.mjs';
import { main as harnessCycle } from '../../../roles/paraclete-h2/skills/harness-evolution/harness-cycle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A real-model context whose model is the scripted gateway and whose sides are this checkout. */
function context({ problem = null, timeoutMs = 60_000, seen = [] } = {}) {
  return createModelRunContext({
    repoRoot: REPO,
    access: { project: 'your-gcp-project', getAccessToken: async () => 'token' },
    sides: { forPatches: () => ({ root: REPO, key: 'k' }), prepareRole: (s, role) => ({ role, problem }), cleanupAll() {}, commit: () => 'c'.repeat(40) },
    startGateway: async (o) => {
      seen.push(o);
      return startInProcessFixtureGateway({
        task: { id: 'any' }, fixture: null, workspaceDir: o.dataRoot, configSnapshot: snapshotCandidateConfig(o.sideRoot, o.role), usageRecords: [],
      });
    },
    timeoutMs,
  });
}

async function substrate(t) {
  const s = await startTier1Substrate();
  t.after(() => s.close());
  return s;
}

const ctxOf = (s) => ({ firestoreUrl: s.firestoreUrl, gcsUrl: s.gcsUrl, firestore: s.firestore, gcs: s.gcs });

test("a real-model rollout keeps its mission in a Firestore of its own, and its agent's commands read a record of their own", async (t) => {
  const s = await substrate(t);
  const seen = [];
  const task = selectModelTasks({ role: 'generic', split: 'train' })[0];
  let record = null;
  const realModel = context({ seen });
  const start = realModel.startGateway;
  realModel.startGateway = async (o) => {
    record = JSON.parse(fs.readFileSync(o.env.PARACLETE_INSTANCE, 'utf8'));
    return start(o);
  };
  const rollout = await runInProcessBrainRollout(task, ctxOf(s), { repoRoot: REPO, realModel });
  assert.equal(rollout.measured, true);
  const shared = await s.firestore.dump?.();
  assert.equal(JSON.stringify(shared || {}).includes('"type":"M"'), false, 'nothing was written to the shared Firestore');
  assert.equal(record.project, 'paraclete-h2-rollout');
  assert.notEqual(record.endpoints.firestore, s.firestore.origin, 'the commands reach the rollout\'s Firestore, not a shared one');
  assert.match(record.data_root.replace(/\\/g, '/'), /paraclete-h2-task-/);
});

test('a mission past its time is cut off before the checks, and the run says it timed out', async (t) => {
  const s = await substrate(t);
  const task = selectModelTasks({ role: 'generic', split: 'train' })[0];
  const rollout = await runInProcessBrainRollout(task, ctxOf(s), { repoRoot: REPO, realModel: context({ timeoutMs: 1 }) });
  assert.equal(rollout.timedOut, true);
  assert.match(rollout.fixtureVerification.summary, /^timed out after 0 s; /);
});

test("a checkout without its role's command launchers is not a measurement", async (t) => {
  const s = await substrate(t);
  const task = selectModelTasks({ role: 'generic', split: 'train' })[0];
  const rollout = await runInProcessBrainRollout(task, ctxOf(s), { repoRoot: REPO, realModel: context({ problem: 'a launcher cannot name C:/x' }) });
  assert.equal(rollout.measured, false);
  assert.equal(rollout.launcherProblem, 'a launcher cannot name C:/x');
});

test("a cross-lens merge keeps the parent's files and each lens's own change", () => {
  const parent = { filePatches: { 'config/contracts.json': 'parent' } };
  const inv = { touchedPaths: ['config/contracts.json'], filePatches: { 'config/contracts.json': 'inv' } };
  const dom = { touchedPaths: ['roles/generic/prompts/motor.md'], filePatches: { 'config/contracts.json': 'parent', 'roles/generic/prompts/motor.md': 'dom' } };
  assert.deepEqual(mergeLensPatches(parent, inv, dom), { 'config/contracts.json': 'inv', 'roles/generic/prompts/motor.md': 'dom' },
    "DOM's copy of the parent's contracts never undoes INV's change");
});

test('a calibration is kept per role and suite version', () => {
  const base = { commit: 'c', taskIds: ['gen-action-items'], trials: 3 };
  assert.notEqual(calibrationKey({ ...base, role: 'legal-advisor' }), calibrationKey({ ...base, role: 'designer' }));
  assert.notEqual(calibrationKey({ ...base, role: 'generic', suiteVersion: 1 }), calibrationKey({ ...base, role: 'generic', suiteVersion: 2 }));
});

test("harness-cycle --action run refuses while the harness is paused", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-run-paused-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  let ran = false;
  const h2 = {
    pause: { pauseState: () => ({ paused: true, source: 'file', reason: 'dev/harness2/PAUSED: judging the judge' }) },
    cli: { runEvolutionLoop: async () => { ran = true; return {}; } },
  };
  let out = '';
  const code = await harnessCycle(['--action', 'run', '--repo', repo, '--json'], { h2, stdout: { write: (x) => { out += x; } }, stderr: { write() {} } });
  assert.equal(code, 1);
  assert.equal(ran, false);
  assert.match(out, /the harness is paused: dev\/harness2\/PAUSED: judging the judge/);
});

test('a pushed promotion returns the checkout to the branch it was on', () => {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
    if (args[0] === 'tag' || args[0] === 'log' || args[0] === 'ls-remote') return '';
    return '';
  };
  const execGh = (args) => (args[1] === 'create' ? 'https://github.com/your-org/paraclete/pull/1' : '');
  const runs = (caps) => caps.map((capability, i) => ({ taskId: 'a', trial: i + 1, measured: true, capability }));
  const built = buildPromotionEvidence({
    candidate: { id: 'cand', lens: 'DOM', touchedPaths: ['prompts/motor.md'], proposal: { source: 'vertex', hypothesis: 'h' } },
    baselineTrajectories: runs([0.4, 0.42, 0.38]), candidateTrajectories: runs([0.9, 0.92, 0.88]),
    calibration: { ok: true, aa: { delta: 0, noise: 0.01 }, knownBad: { delta: -0.5, noise: 0.02, detected: true }, problems: [] },
  });
  const evidence = { ...built, verdict: judgeEvidence(built) };
  assert.equal(evidence.verdict.ok, true, evidence.verdict.problems.join('; '));
  pushAndCreatePullRequest({
    candidate: { id: 'cand', lens: 'DOM', touchedPaths: ['prompts/motor.md'] },
    readiness: { ready: true, candidateId: 'cand', evidence },
    application: { applied: true, appliedPaths: ['prompts/motor.md'], branch: 'harness2/x', returnTo: 'main' },
    repoRoot: REPO, branch: 'harness2/x', execGit, execGh,
  });
  const committed = calls.findIndex((c) => c[0] === 'commit');
  assert.ok(committed >= 0, 'the promotion was committed');
  assert.deepEqual(calls.at(-1), ['checkout', 'main'], 'back on main once the promotion is committed');
});

test('a markdown table without leading pipes, and ordinal dates, still count', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'gen-action-items');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-table-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  task.seed(dir);
  fs.writeFileSync(path.join(dir, 'action-items.md'), [
    'Owner | Action | Due', '--- | --- | ---', 'Rafael | Write the pricing copy | 12th March',
    'Wen | Refresh staging data | 13 March', 'Priya | Send the budget draft | 14th March', 'Sam | Book the venue | 17 March', '',
  ].join('\n'));
  const res = task.verify(dir);
  assert.equal(res.passed, true, res.summary);
});
