// tests/dev/harness2.test.mjs: Unit tests for the Paraclete-H² continual harness improvement system.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PARACLETE_SURFACE,
  STAGE1_BUILDER_ROLES,
  DEFAULT_ROLES,
  classifySurfacePath,
  isContractKeyTunable,
  rolesForStage,
} from '../../dev/harness2/surface.mjs';
import {
  validateTouchedPaths,
  validateContractsMutation,
  validatePromptBudgets,
  validateCandidateWorkspace,
} from '../../dev/harness2/validate.mjs';
import {
  extractTrajectory,
  scoreTrajectory,
  aggregateTrajectoryScores,
} from '../../dev/harness2/trajectory.mjs';
import {
  selectBenchmarkTasks,
  runTier1Evaluation,
  runTier2CanaryEvaluation,
} from '../../dev/harness2/substrate.mjs';
import {
  MUTATION_LENSES,
  selectLensForTrajectories,
  buildMutationProposalSpec,
} from '../../dev/harness2/lenses.mjs';
import { runWithinGenerationRecursion } from '../../dev/harness2/recursion.mjs';
import {
  isNonRegression,
  dominates,
  computeParetoFrontier,
  synthesizeCrossLensCandidate,
} from '../../dev/harness2/selection.mjs';
import { createLineageLibrary } from '../../dev/harness2/library.mjs';
import { evaluatePromotionReadiness, formatPromotionReport } from '../../dev/harness2/promote.mjs';
import {
  harvestMissionTrajectories,
  loadMissionsFromInput,
  synthesizeBenchmarkCandidatesFromHarvest,
} from '../../dev/harness2/harvest.mjs';
import { parseCliArgs, runCli, runEvolutionLoop } from '../../dev/harness2/cli.mjs';
import {
  buildGcpLabPlan,
  createDevCanaryRunner,
  createIsolatedWorktree,
  getWorktreeTouchedPaths,
  createLiveProposeAndApply,
  evaluateLiveTarget,
} from '../../dev/harness2/live-runner.mjs';
import { STAGE1_FIXTURES, getTaskFixture } from '../../dev/harness2/fixtures.mjs';
import { main as runHarnessCycle } from '../../roles/paraclete-h2/skills/harness-evolution/harness-cycle.mjs';
import { main as runHarnessEval } from '../../roles/paraclete-h2/skills/harness-benchmark/harness-eval.mjs';
import { main as runHarnessPromote } from '../../roles/paraclete-h2/skills/harness-release/harness-promote.mjs';

describe('dev/harness2/surface.mjs', () => {
  it('defines the 8-component Paraclete mutable surface and stage role sets', () => {
    assert.equal(Object.keys(PARACLETE_SURFACE).length, 8);
    assert.equal(STAGE1_BUILDER_ROLES[0], 'paraclete-h2');
    assert.deepEqual(rolesForStage('stage1'), STAGE1_BUILDER_ROLES);
    assert.deepEqual(rolesForStage('stage2'), DEFAULT_ROLES);
  });

  it('allows mutable surface files and rejects immutable spine files', () => {
    assert.equal(classifySurfacePath('config/contracts.json').allowed, true);
    assert.equal(classifySurfacePath('prompts/cortex.md').component, 'c2_base_prompts');
    assert.equal(classifySurfacePath('prompts/cerebellum.md').component, 'c3_cerebellum_verifier');
    assert.equal(classifySurfacePath('skills/memory-consolidate/SKILL.md').component, 'c4_memory_consolidation');
    assert.equal(classifySurfacePath('roles/paraclete-h2/prompts/cortex.md', { stage: 'stage1' }).allowed, true);
    assert.equal(classifySurfacePath('roles/paraclete-h2/skills/harness-evolution/SKILL.md', { stage: 'stage1' }).allowed, true);
    assert.equal(classifySurfacePath('roles/software-engineer/prompts/motor.md', { stage: 'stage1' }).allowed, true);
    assert.equal(classifySurfacePath('roles/data-analyst/prompts/motor.md', { stage: 'stage1' }).allowed, false);
    assert.equal(classifySurfacePath('roles/data-analyst/prompts/motor.md', { stage: 'stage2' }).allowed, true);
    assert.equal(classifySurfacePath('agent/gateway/shell-exec.mjs').component, 'c8_shell_ergonomics');

    // Immutable spine rejections
    assert.equal(classifySurfacePath('agent/services/brain/envelope-runner.mjs').allowed, false);
    assert.equal(classifySurfacePath('agent/work/checkpoint-spine.mjs').allowed, false);
    assert.equal(classifySurfacePath('tests/run.mjs').allowed, false);
    assert.equal(classifySurfacePath('prompts/new-invented-organ.md').allowed, false);
  });

  it('checks tunable contract keys accurately', () => {
    assert.equal(isContractKeyTunable('organs.max_steps'), true);
    assert.equal(isContractKeyTunable('compaction.working_budget_tokens'), true);
    assert.equal(isContractKeyTunable('organs.cortex.someUnknownSetting'), false);
  });
});

describe('dev/harness2/validate.mjs', () => {
  it('validates touched paths against lens component scopes', () => {
    const okInv = validateTouchedPaths(['prompts/motor.md', 'config/contracts.json'], {
      allowedComponents: MUTATION_LENSES.INV.allowedComponents,
    });
    assert.equal(okInv.ok, true);

    const badLensCross = validateTouchedPaths(['roles/software-engineer/prompts/motor.md'], {
      allowedComponents: MUTATION_LENSES.INV.allowedComponents,
    });
    assert.equal(badLensCross.ok, false);
    assert.match(badLensCross.violations[0], /outside allowed lens scope/);
  });

  it('enforces hard bounds on config/contracts.json and rejects untunable key edits', () => {
    const baseline = JSON.parse(readFileSync('config/contracts.json', 'utf8'));
    const valid = structuredClone(baseline);
    valid.organs.max_steps = 28;
    assert.equal(validateContractsMutation(valid, baseline).ok, true);

    const outOfBounds = structuredClone(baseline);
    outOfBounds.organs.max_steps = 999;
    const res1 = validateContractsMutation(outOfBounds, baseline);
    assert.equal(res1.ok, false);
    assert.match(res1.violations[0], /violates bounds/);

    const untunableChanged = structuredClone(baseline);
    untunableChanged.unlistedTopLevelKey = 'forbidden';
    const res2 = validateContractsMutation(untunableChanged, baseline);
    assert.equal(res2.ok, false);
    assert.match(res2.violations[0], /not on the tunable allowlist/);
  });

  it('verifies all assembled (organ, role) prompts stay under the 24,000-character budget', () => {
    const budgetCheck = validatePromptBudgets();
    assert.equal(budgetCheck.ok, true);
    assert.ok(budgetCheck.measurements.length >= 60);
  });
});

describe('dev/harness2/trajectory.mjs', () => {
  it('extracts a ParacleteTrajectory and computes 3D score vectors', () => {
    const traj = extractTrajectory({
      envelope: {
        id: 'm-100',
        role: 'software-engineer',
        platform_version: 'v2026.10.19.3.1',
        status: 'completed',
        duration_ms: 15_000,
        checkpoint_spine: [
          { n: 1, goal: 'diagnose bug', status: 'done', replan_count: 0, result_summary: 'found' },
          { n: 2, goal: 'fix and test', status: 'done', replan_count: 1, replan_lens: 'INV', result_summary: 'fixed' },
        ],
      },
      tasks: [
        { id: 't1', index: 0, checkpoint_n: 1, status: 'completed', tool_records: [{ tool: 'shell', exitCode: 0 }] },
        { id: 't2', index: 1, checkpoint_n: 2, status: 'completed', tool_records: [{ tool: 'shell', exitCode: 1 }, { tool: 'shell', exitCode: 0 }] },
      ],
      usageRecords: [{ promptTokenCount: 10_000, candidatesTokenCount: 2_000, cachedContentTokenCount: 4_000 }],
    });

    assert.equal(traj.missionCompleted, true);
    assert.equal(traj.checkpointCount, 2);
    assert.equal(traj.firstAttemptVerifiedCount, 1);
    assert.equal(traj.replanCount, 1);
    assert.equal(traj.totalToolCalls, 3);
    assert.equal(traj.errorToolCalls, 1);

    const score = scoreTrajectory(traj);
    assert.equal(score.capability, 1);
    assert.ok(score.reliability > 0.5 && score.reliability < 1.0);
    assert.ok(score.efficiency > 0.8);
    assert.ok(score.fitness > 0.7);

    const agg = aggregateTrajectoryScores([traj]);
    assert.equal(agg.count, 1);
    assert.equal(agg.fitness, score.fitness);
  });
});

describe('dev/harness2/lenses.mjs & recursion.mjs & selection.mjs', () => {
  it('routes trajectories with mechanical errors to INV and domain rejections to DOM', () => {
    const invRouting = selectLensForTrajectories([
      { missionId: 'm1', errorToolCalls: 2, evidenceFloorFailureCount: 1, missionCompleted: false, checkpoints: [] },
    ]);
    assert.equal(invRouting.primaryLens, 'INV');

    const domRouting = selectLensForTrajectories([
      { missionId: 'm2', errorToolCalls: 0, adversarialFailureCount: 2, missionCompleted: false, checkpoints: [] },
    ]);
    assert.equal(domRouting.primaryLens, 'DOM');
  });

  it('reverts regressed candidates and escalates on subsequent recursion steps', async () => {
    const parentState = {
      id: 'parent',
      scores: { capability: 0.8, reliability: 0.8, efficiency: 0.7, fitness: 0.785 },
      trajectories: [],
    };
    const seenModes = [];
    let callIdx = 0;

    const result = await runWithinGenerationRecursion({
      lens: 'INV',
      parentState,
      maxSteps: 3,
      proposeAndApply: async (spec) => {
        seenModes.push(spec.escalationMode);
        callIdx += 1;
        return { id: `cand-${callIdx}`, hypothesis: `try-${callIdx}`, touchedPaths: ['prompts/motor.md'] };
      },
      validateCandidate: () => ({ ok: true, violations: [] }),
      evaluateCandidate: async (cand) => {
        if (cand.id === 'cand-1') {
          // Step 1 regresses capability -> should revert!
          return { summary: { capability: 0.7, reliability: 0.9, efficiency: 0.9, fitness: 0.82 }, trajectories: [] };
        }
        if (cand.id === 'cand-2') {
          // Step 2 improves without regression -> accepted!
          return { summary: { capability: 0.85, reliability: 0.85, efficiency: 0.75, fitness: 0.835 }, trajectories: [] };
        }
        // Step 3 does not improve over step 2 -> reverted!
        return { summary: { capability: 0.85, reliability: 0.84, efficiency: 0.72, fitness: 0.82 }, trajectories: [] };
      },
    });

    assert.deepEqual(seenModes, ['initial_targeted_patch', 'refined_root_cause_patch', 'structural_escalation']);
    assert.equal(result.improved, true);
    assert.equal(result.bestCandidate.id, 'cand-2');
    assert.equal(result.history[0].accepted, false);
    assert.equal(result.history[1].accepted, true);
    assert.equal(result.history[2].accepted, false);
  });

  it('computes Pareto frontier and synthesizes orthogonal INV + DOM winners', async () => {
    const p = { id: 'p', scores: { capability: 0.7, reliability: 0.7, efficiency: 0.7, fitness: 0.7 } };
    const inv = { id: 'inv', scores: { capability: 0.75, reliability: 0.85, efficiency: 0.75, fitness: 0.78 } };
    const dom = { id: 'dom', scores: { capability: 0.88, reliability: 0.72, efficiency: 0.70, fitness: 0.805 } };
    const dominated = { id: 'domd', scores: { capability: 0.65, reliability: 0.65, efficiency: 0.65, fitness: 0.65 } };

    assert.equal(dominates(inv, p), true);
    assert.equal(dominates(inv, dom), false);
    const frontier = computeParetoFrontier([p, inv, dom, dominated]);
    assert.deepEqual(frontier.map((c) => c.id), ['dom', 'inv']);

    const syn = await synthesizeCrossLensCandidate({
      parentState: p,
      invResult: { improved: true, bestCandidate: inv },
      domResult: { improved: true, bestCandidate: dom },
      mergeAndEvaluate: async () => ({
        id: 'syn',
        scores: { capability: 0.9, reliability: 0.86, efficiency: 0.76, fitness: 0.867 },
      }),
    });
    assert.equal(syn.synthesized, true);
    assert.equal(syn.bestOverall.id, 'syn');
  });
});

describe('dev/harness2/substrate.mjs, library.mjs, harvest.mjs, promote.mjs, cli.mjs', () => {
  it('runs Tier-1 hermetic evaluation and Tier-2 canary evaluation', async () => {
    const tasks = selectBenchmarkTasks({ stage: 'stage1', role: 'software-engineer' });
    assert.ok(tasks.length >= 2);
    const tier1 = await runTier1Evaluation({ tasks });
    assert.equal(tier1.tier, 'tier1');
    assert.equal(tier1.summary.count, tasks.length);
    assert.equal(tier1.summary.capability, 1);

    const tier2 = await runTier2CanaryEvaluation({
      canaryAgent: 'canary-se-01',
      tasks: tasks.slice(0, 1),
      canaryRunner: async ({ tasks: t }) => ({
        smokePassed: true,
        rollouts: [
          {
            envelope: {
              id: 'canary-m1',
              role: t[0].role,
              status: 'completed',
              duration_ms: 2000,
              checkpoint_spine: [{ n: 1, goal: 'verify', status: 'done', replan_count: 0 }],
            },
          },
        ],
      }),
    });
    assert.equal(tier2.smokePassed, true);
    assert.equal(tier2.summary.capability, 1);
  });

  it('archives lineage, filters stale versions on harvest, and formats promotion reports', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'h2-lib-'));
    try {
      const lib = createLineageLibrary({ archivePath: join(tmp, 'archive.json') });
      lib.recordCandidate({ id: 'g0', parentId: null, generation: 0 });
      lib.recordCandidate({ id: 'g1', parentId: 'g0', generation: 1, lens: 'INV' });
      assert.deepEqual(lib.getLineage('g1').map((c) => c.id), ['g0', 'g1']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    const harvest = harvestMissionTrajectories(
      [
        { envelope: { id: 'old-1', role: 'software-engineer', platform_version: 'v2026.10.18.1.0', status: 'failed' } },
        {
          envelope: {
            id: 'cur-1',
            role: 'software-engineer',
            platform_version: 'v2026.10.19.3.1',
            status: 'completed',
            checkpoint_spine: [{ n: 1, goal: 'ship feature', status: 'done', replan_count: 1, replan_lens: 'DOM' }],
          },
        },
      ],
      { targetVersion: 'v2026.10.19.3.1' },
    );
    assert.equal(harvest.acceptedCount, 1);
    assert.equal(harvest.skippedStaleCount, 1);
    const synthTasks = synthesizeBenchmarkCandidatesFromHarvest(harvest.accepted);
    assert.equal(synthTasks.length, 1);
    assert.equal(synthTasks[0].dominantReplanLens, 'DOM');

    const readiness = evaluatePromotionReadiness({
      candidate: {
        id: 'cand-win',
        lens: 'SYN',
        stage: 'stage1',
        touchedPaths: ['prompts/motor.md'],
        scores: { capability: 0.95, reliability: 0.9, efficiency: 0.8, fitness: 0.91 },
      },
      baselineScores: { capability: 0.9, reliability: 0.88, efficiency: 0.78, fitness: 0.87 },
      validationResult: { ok: true, violations: [] },
    });
    assert.equal(readiness.ready, true);
    assert.match(formatPromotionReport(readiness), /READY FOR PROMOTION/);
  });

  it('supports CLI subcommands and end-to-end runEvolutionLoop', async () => {
    const parsed = parseCliArgs(['evolve', '--stage', 'stage1', '--generations', '1']);
    assert.equal(parsed.subcommand, 'evolve');
    assert.equal(parsed.flags.stage, 'stage1');

    const surf = await runCli(['surface', '--stage', 'stage1']);
    assert.equal(surf.ok, true);
    assert.deepEqual(surf.roles, STAGE1_BUILDER_ROLES);

    const tmp = mkdtempSync(join(tmpdir(), 'h2-evo-'));
    try {
      const evo = await runEvolutionLoop({
        stage: 'stage1',
        generations: 1,
        recursionSteps: 1,
        archivePath: join(tmp, 'archive.json'),
      });
      assert.equal(evo.generations.length, 1);
      assert.ok(evo.winner.scores.fitness > 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports live-runner isolated worktree helpers and paraclete-h2 role commands', async () => {
    const gitCalls = [];
    const wt = createIsolatedWorktree({
      repoRoot: '/repo',
      candidateId: 'cand-01',
      worktreePath: '/tmp/wt-cand-01',
      execGit: (args) => {
        gitCalls.push(args);
        return '';
      },
    });
    assert.equal(wt.branchName, 'h2/cand-01');
    wt.cleanup();
    assert.equal(gitCalls.length, 3);

    const touched = getWorktreeTouchedPaths('/tmp/wt-cand-01', {
      execGit: () => ' M prompts/motor.md\n M roles/paraclete-h2/prompts/cortex.md',
    });
    assert.deepEqual(touched, ['prompts/motor.md', 'roles/paraclete-h2/prompts/cortex.md']);

    const proposer = createLiveProposeAndApply({
      stage: 'stage1',
      applyMutation: async () => ({ touchedPaths: ['roles/paraclete-h2/prompts/cortex.md'] }),
    });
    const proposed = await proposer(
      { lens: 'INV', escalationMode: 'focused', allowedComponents: ['c5_role_overlays'], priorAttemptsSummary: [] },
      { id: 'gen0' },
    );
    assert.equal(proposed.id, 'gen0-inv-1');
    assert.deepEqual(proposed.touchedPaths, ['roles/paraclete-h2/prompts/cortex.md']);

    const liveEval = await evaluateLiveTarget({ stage: 'stage1', role: 'paraclete-h2' });
    assert.equal(liveEval.trajectories.length, 2);
    assert.equal(liveEval.summary.capability, 1);

    const capture = () => {
      let buf = '';
      return {
        stream: { write(chunk) { buf += chunk; } },
        read() { return JSON.parse(buf); },
      };
    };

    const outSurface = capture();
    assert.equal(await runHarnessCycle(['--action', 'surface', '--json'], { stdout: outSurface.stream }), 0);
    assert.equal(outSurface.read().stage1BuilderRoles[0], 'paraclete-h2');

    const outDiagnose = capture();
    assert.equal(await runHarnessCycle(['--action', 'diagnose', '--stage', 'stage1', '--json'], { stdout: outDiagnose.stream }), 0);
    assert.equal(outDiagnose.read().ok, true);

    const outEval = capture();
    assert.equal(await runHarnessEval(['--action', 'evaluate', '--stage', 'stage1', '--role', 'paraclete-h2', '--json'], { stdout: outEval.stream }), 0);
    assert.equal(outEval.read().trajectoryCount, 2);

    const outPromote = capture();
    await runHarnessPromote(['--action', 'verify', '--stage', 'stage1', '--json'], { stdout: outPromote.stream });
    assert.equal(outPromote.read().candidateId, 'candidate-head');
  });

  it('covers all 13 installed roles in Stage 2 benchmark suites', () => {
    const installedRoles = rolesForStage('stage2', { repoRoot: process.cwd() });
    assert.ok(installedRoles.length >= 13);
    for (const role of installedRoles) {
      const tasks = selectBenchmarkTasks({ stage: 'stage2', role });
      assert.ok(tasks.length >= 1, `expected at least 1 benchmark task for installed role '${role}'`);
    }
  });

  it('loads harvested missions from both JSON files and mission subdirectories', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'paraclete-h2-harvest-'));
    try {
      const missionSubdir = join(tmpDir, 'm-dir-1');
      mkdirSync(missionSubdir, { recursive: true });
      writeFileSync(
        join(missionSubdir, 'envelope.json'),
        JSON.stringify({
          id: 'm-dir-1',
          role: 'paraclete-h2',
          platform_version: 'v2026.10.19.1.0',
          status: 'failed',
          checkpoint_spine: [{ n: 1, goal: 'verify spine boundaries', status: 'failed', replan_count: 1 }],
        }),
        'utf8',
      );
      writeFileSync(
        join(missionSubdir, 'tasks.json'),
        JSON.stringify([{ id: 't-1', checkpoint_n: 1, status: 'failed', tool_records: [{ tool: 'shell', exitCode: 1 }] }]),
        'utf8',
      );
      writeFileSync(
        join(tmpDir, 'batch.json'),
        JSON.stringify([
          {
            envelope: {
              id: 'm-file-2',
              role: 'software-engineer',
              platform_version: 'v2026.10.19.1.0',
              status: 'completed',
              checkpoint_spine: [{ n: 1, goal: 'fix unit test', status: 'done', replan_count: 2 }],
            },
          },
        ]),
        'utf8',
      );

      const loaded = loadMissionsFromInput(tmpDir);
      assert.equal(loaded.length, 2);

      const cliHarvest = await runCli(['harvest', '--input', tmpDir, '--version', 'v2026.10.19.1.0']);
      assert.equal(cliHarvest.ok, true);
      assert.equal(cliHarvest.harvested.acceptedCount, 2);
      assert.equal(cliHarvest.synthesizedTasks.length, 2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes Tier-2 canary evaluation via createDevCanaryRunner and cli canary subcommand', async () => {
    const smokeCalls = [];
    const runner = createDevCanaryRunner({
      role: 'paraclete-h2',
      runSmoke: async ({ canaryAgent, role }) => {
        smokeCalls.push({ canaryAgent, role });
        return { pass: true };
      },
    });
    const res = await runCli(['canary', '--agent', 'canary-h2-01', '--role', 'paraclete-h2'], {
      canaryRunner: runner,
    });
    assert.equal(res.ok, true);
    assert.equal(res.smokePassed, true);
    assert.equal(res.canaryAgent, 'canary-h2-01');
    assert.equal(smokeCalls.length, 1);
    assert.deepEqual(smokeCalls[0], { canaryAgent: 'canary-h2-01', role: 'paraclete-h2' });
  });

  it('seeds Stage 1 workspace fixtures that fail before repair and pass after reference solution', () => {
    const taskIds = Object.keys(STAGE1_FIXTURES);
    assert.equal(taskIds.length, 6);
    for (const id of taskIds) {
      const fx = getTaskFixture(id);
      assert.ok(fx, `fixture missing for ${id}`);
      const ws = mkdtempSync(join(tmpdir(), `paraclete-fx-${id}-`));
      try {
        fx.seedWorkspace(ws);
        const before = fx.verifyWorkspace(ws);
        assert.equal(before.passed, false, `expected unseeded/broken fixture ${id} to fail before repair`);
        fx.applyReferenceSolution(ws);
        const after = fx.verifyWorkspace(ws);
        assert.equal(after.passed, true, `expected fixture ${id} to pass after applyReferenceSolution`);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
  });

  it('generates the two-tier GCP lab provisioning plan via buildGcpLabPlan and cli lab-plan', async () => {
    const plan = buildGcpLabPlan({ projectId: 'paraclete-h2-lab', region: 'us-central1' });
    assert.equal(plan.projectId, 'paraclete-h2-lab');
    assert.equal(plan.vms.length, 2);
    assert.equal(plan.vms[0].name, 'paraclete-h2-driver');
    assert.equal(plan.vms[1].name, 'paraclete-h2-canary');

    const cliRes = await runCli(['lab-plan', '--project', 'paraclete-h2-lab']);
    assert.equal(cliRes.ok, true);
    assert.equal(cliRes.plan.vms.length, 2);
  });
});


