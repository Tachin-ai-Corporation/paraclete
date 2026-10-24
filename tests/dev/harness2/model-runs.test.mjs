// Tests for dev/harness2/model-runs.mjs and the real-model path of live-runner.mjs
// runInProcessBrainRollout: one checkout per side, with only mutable-surface patches, linked to the
// repo's packages and removed without reaching through the link; the product gateway started from a
// side's checkout sends that side's own prompt to the model; token telemetry, the spend cap and the
// rollout estimate; and a whole real-model rollout, with its gateway faked, that seeds the motor's
// workspace, checks it, counts its tokens and marks the run measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SPEND_LIMITS, SpendCapReached, createModelRunContext, createSideRoots, createSpendMeter, estimateRollouts,
  modelAccess, startModelGateway, usageFromLog,
} from '../../../dev/harness2/model-runs.mjs';
import { selectModelTasks } from '../../../dev/harness2/model-suite.mjs';
import { runInProcessBrainRollout, snapshotCandidateConfig, startInProcessFixtureGateway } from '../../../dev/harness2/live-runner.mjs';
import { startTier1Substrate } from '../../../dev/harness2/substrate.mjs';
import { fakeGoogle, geminiText } from '../../agent/gateway/fakes.mjs';
import { loadContracts } from '../../../config/contracts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=h2@example.com', '-c', 'user.name=h2', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A small git repository with a base motor prompt and an installed package directory. */
function repo(t) {
  const root = tmp(t, 'h2-side-repo-');
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prompts', 'motor.md'), '# Motor\n\nBaseline motor prompt.\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'base');
  fs.mkdirSync(path.join(root, 'agent', 'node_modules', 'some-sdk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent', 'node_modules', 'some-sdk', 'index.js'), 'export default 1;\n');
  return root;
}

test('usage lines: an organ turn and the utility model, nothing else', () => {
  assert.deepEqual(usageFromLog('[TELEMETRY] llm_usage mission=w-1 organ=motor input=1200 output=80 cached=300 cache_write=0 duration=900ms'), {
    organ: 'motor', prompt_tokens: 1200, completion_tokens: 80, promptTokenCount: 1200, candidatesTokenCount: 80, cachedContentTokenCount: 300, totalTokenCount: 1280,
  });
  assert.equal(usageFromLog('TELEMETRY utility_usage stage=digest model=gemini-x input=50 output=5 cached=0').totalTokenCount, 55);
  assert.equal(usageFromLog('TELEMETRY utility_usage model=gemini-x input=7 output=3 cached=0').organ, 'utility');
  assert.equal(usageFromLog('[WORK QUEUE] running mission w-1'), null);
});

test('the spend cap stops before the rollout or the tokens that would pass it', () => {
  const meter = createSpendMeter({ maxRollouts: 2, maxTokens: 1000 });
  meter.startRollout();
  meter.addTokens(400);
  meter.startRollout();
  assert.throws(() => meter.startRollout(), (err) => err instanceof SpendCapReached && /cap of 2 model rollouts/.test(err.message));
  const tokens = createSpendMeter({ maxRollouts: 10, maxTokens: 1000 });
  tokens.startRollout();
  tokens.addTokens(1000);
  assert.throws(() => tokens.startRollout(), /cap of 1000 tokens/);
  assert.deepEqual(createSpendMeter({ maxRollouts: 'x', maxTokens: -1 }).summary(), { rollouts: 0, tokens: 0, ...DEFAULT_SPEND_LIMITS });
  assert.equal(estimateRollouts({ tasks: 2, trials: 3, candidates: 4, calibration: true }), 2 * 3 * 6, 'the known-bad change; the A/A check reuses the baselines');
  assert.equal(estimateRollouts({ tasks: 2, trials: 3, candidates: 5, baselines: 2, calibration: true }), 2 * 3 * 8);
});

test('model access: the project from the environment or the instance, else a clear refusal', () => {
  assert.equal(modelAccess({ env: { GOOGLE_CLOUD_PROJECT: 'your-gcp-project' }, projectFromInstance: () => null }).project, 'your-gcp-project');
  assert.equal(modelAccess({ env: {}, projectFromInstance: () => 'your-gcp-project' }).project, 'your-gcp-project');
  assert.throws(() => modelAccess({ env: {}, projectFromInstance: () => null }), /needs a Google Cloud project/);
});

test('a side is HEAD with its patches, shared by equal patches, refused off the surface, removed through its link', (t) => {
  const root = repo(t);
  const sides = createSideRoots({ repoRoot: root, tmpRoot: tmp(t, 'h2-sides-') });
  const base = sides.forPatches({});
  const cand = sides.forPatches({ 'prompts/motor.md': '# Motor\n\nCandidate motor prompt.\n' });
  assert.notEqual(base.root, cand.root);
  assert.equal(sides.forPatches({ 'prompts/motor.md': '# Motor\n\nCandidate motor prompt.\n' }), cand, 'equal patches share a checkout');
  assert.match(fs.readFileSync(path.join(base.root, 'prompts', 'motor.md'), 'utf8'), /Baseline/);
  assert.match(fs.readFileSync(path.join(cand.root, 'prompts', 'motor.md'), 'utf8'), /Candidate/);
  assert.match(fs.readFileSync(path.join(root, 'prompts', 'motor.md'), 'utf8'), /Baseline/, 'the repo itself is untouched');
  assert.ok(fs.existsSync(path.join(cand.root, 'agent', 'node_modules', 'some-sdk', 'index.js')), 'the packages are linked in');
  assert.throws(() => sides.forPatches({ 'agent/gateway/tools.mjs': 'export {};' }), /only on the mutable surface/);

  // Launchers name a POSIX path, so a Windows temp checkout gets none and says why; a Linux one gets them.
  const prepared = sides.prepareRole(cand, 'generic');
  assert.equal(prepared.role, 'generic');
  assert.ok(prepared.problem === null || /plain absolute/.test(prepared.problem), prepared.problem);
  assert.deepEqual(sides.prepareRole(cand, 'generic'), prepared, 'a role is prepared once');

  sides.cleanupAll();
  assert.equal(fs.existsSync(base.root), false);
  assert.equal(fs.existsSync(cand.root), false);
  assert.ok(fs.existsSync(path.join(root, 'agent', 'node_modules', 'some-sdk', 'index.js')), 'removing a checkout never reaches through its link');
  assert.doesNotMatch(git(root, 'worktree', 'list'), /paraclete-h2-side/);
});

test("the product gateway, started from a side's checkout, sends that side's own motor prompt to the model", async (t) => {
  const side = tmp(t, 'h2-gw-side-');
  for (const dir of ['prompts', 'skills', path.join('roles', 'generic')]) {
    fs.cpSync(path.join(REPO, dir), path.join(side, dir), { recursive: true });
  }
  fs.appendFileSync(path.join(side, 'prompts', 'motor.md'), '\nCANDIDATE-MARKER-7731: always read the README first.\n');
  const google = fakeGoogle([geminiText('done')]);
  const created = [];
  const gw = await startModelGateway({
    sideRoot: side,
    role: 'generic',
    contracts: loadContracts(),
    dataRoot: tmp(t, 'h2-gw-data-'),
    db: { read: async () => null },
    project: 'your-gcp-project',
    accessToken: 'fixed-token',
    createClients: (o) => {
      created.push(o);
      return { project: o.project, googleLocation: o.googleLocation, anthropicLocation: null, google, anthropic: null };
    },
  });
  t.after(gw.stop);
  const res = await fetch(`${gw.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'brain/motor', messages: [{ role: 'user', content: 'Do the task.' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(created[0].accessToken, 'fixed-token');
  assert.equal(created[0].project, 'your-gcp-project');
  // The organ prompt reaches the model as the system instruction, or through the explicit cache it is
  // stored in first.
  assert.match(JSON.stringify({ requests: google.requests, caches: google.cacheCreates }), /CANDIDATE-MARKER-7731/);
  const unauthorized = await fetch(`${gw.url}/v1/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401, 'the gateway still needs its token');
});

test("a real-model rollout runs from the side's checkout, seeds and checks the motor's workspace, and counts its tokens", async (t) => {
  const task = selectModelTasks({ role: 'data-engineer', split: 'train' })[0];
  const seen = { patches: [], gateways: [] };
  const sides = {
    forPatches(patches) {
      seen.patches.push(patches);
      return { root: REPO, key: 'k' };
    },
    prepareRole: (side, role) => ({ role, launchers: 0, problem: null }),
    cleanupAll() {},
  };
  const realModel = createModelRunContext({
    repoRoot: REPO,
    access: { project: 'your-gcp-project', getAccessToken: async () => 'rollout-token' },
    sides,
    limits: { maxRollouts: 5 },
    // The scripted gateway stands in for the model here; what is under test is the plumbing around it.
    startGateway: async (o) => {
      seen.gateways.push(o);
      return startInProcessFixtureGateway({
        task, fixture: null, workspaceDir: o.dataRoot, configSnapshot: snapshotCandidateConfig(o.sideRoot, o.role), usageRecords: [],
      });
    },
    timeoutMs: 60_000,
  });
  const substrate = await startTier1Substrate();
  t.after(() => substrate.close());
  const patches = { 'prompts/motor.md': '# Motor\n' };
  const rollout = await runInProcessBrainRollout(task, {
    firestoreUrl: substrate.firestoreUrl, gcsUrl: substrate.gcsUrl, firestore: substrate.firestore, gcs: substrate.gcs,
  }, { repoRoot: REPO, realModel, filePatches: patches });

  assert.deepEqual(seen.patches, [patches], "the rollout ran from the candidate's side");
  assert.equal(seen.gateways[0].sideRoot, REPO);
  assert.equal(seen.gateways[0].project, 'your-gcp-project');
  assert.equal(seen.gateways[0].accessToken, 'rollout-token');
  assert.equal(rollout.measured, true);
  assert.equal(rollout.scripted, false);
  assert.equal(typeof rollout.checkScore, 'number');
  assert.ok(rollout.checkScore < 1, 'nothing solved the task, and its checks say so');
  assert.match(rollout.fixtureVerification.summary, /checks passed/);
  assert.equal(realModel.meter.summary().rollouts, 1);
  assert.ok(realModel.meter.summary().tokens > 0, "the brain's telemetry was counted");
  assert.ok(rollout.usageRecords.length > 0);
  assert.match(rollout.evalCritique.improvementPrescription, /ended with \d+\/\d+ checks passed/);
});
