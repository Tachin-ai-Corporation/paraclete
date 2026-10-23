// tests/dev/harness2.test.mjs: Unit tests for the Paraclete-H² continual harness improvement system.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  buildSkillScaffold,
  buildRoleScaffold,
} from '../../dev/harness2/surface.mjs';
import {
  validateTouchedPaths,
  validateContractsMutation,
  validatePromptBudgets,
  validateCandidateWorkspace,
  addedLinesFromDiff,
  promptAdditionProblems,
} from '../../dev/harness2/validate.mjs';
import {
  DEFAULT_EVIDENCE_RULES,
  EVIDENCE_SCHEMA,
  buildPromotionEvidence,
  formatEvidenceMarkdown,
  judgeEvidence,
  parseEvidenceBlock,
} from '../../dev/harness2/evidence.mjs';
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
  CAPABILITY_CREDO,
  isNonRegression,
  compareCapabilityFirst,
  isBetterUnderCapabilityCredo,
  dominates,
  computeParetoFrontier,
  synthesizeCrossLensCandidate,
} from '../../dev/harness2/selection.mjs';
import {
  DEFAULT_JUDGE_COMMITTEE,
  JUDGE_DIMENSIONS,
  parseCommitteeSpec,
  registerJudgeAdapter,
  buildJudgePacket,
  combineHardGateWithCommitteeScore,
  evaluateWithFrontierCommittee,
  judgePairwiseWithCommittee,
} from '../../dev/harness2/judge.mjs';
import { createLineageLibrary } from '../../dev/harness2/library.mjs';
import {
  evaluatePromotionReadiness,
  formatPromotionReport,
  applyPromotedCandidate,
  pushAndCreatePullRequest,
  mergeContractsJson,
  mergePromptMarkdown,
  resolveHarnessMergeConflict,
  nextPromotionVersion,
  promotionMergeNote,
} from '../../dev/harness2/promote.mjs';
import { isNewer, versionFromText } from '../../agent/release/versions.mjs';
import {
  harvestMissionTrajectories,
  loadMissionsFromInput,
  loadMissionsFromFirestore,
  saveHarvestedBenchmarkTasks,
  loadPersistedBenchmarkTasks,
  synthesizeBenchmarkCandidatesFromHarvest,
  expandCurriculumForSaturatedRoles,
} from '../../dev/harness2/harvest.mjs';
import { parseCliArgs, runCli, runEvolutionLoop } from '../../dev/harness2/cli.mjs';
import {
  buildGcpLabPlan,
  createDevCanaryRunner,
  createIsolatedWorktree,
  getWorktreeTouchedPaths,
  createLiveProposeAndApply,
  evaluateLiveTarget,
  inspectGcpLabStatus,
  proposeVertexMutation,
  provisionGcpLab,
} from '../../dev/harness2/live-runner.mjs';
import { buildProposalPrompt, createVertexProposalGenerator } from '../../dev/harness2/proposer.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { STAGE1_FIXTURES, STAGE2_FIXTURES, ALL_FIXTURES, getTaskFixture } from '../../dev/harness2/fixtures.mjs';
import {
  CURRICULUM_TRACKS,
  MASTER_CURRICULUM_UNITS,
  getAllCurriculumUnits,
  getCurriculumUnitById,
  materializeCurriculumArtifacts,
  verifyUnitArtifacts,
  selectNextCurriculumUnit,
  recordCurriculumUnitAttempt,
  getCurriculumCoverageReport,
  scanCurriculumCoverageGaps,
  synthesizeNextCurriculumEpoch,
  formatCurriculumProposalMarkdown,
} from '../../dev/harness2/curriculum.mjs';
import {
  REPORT_STANDARD_VERSION,
  computeGcpCostEstimate,
  buildLoopStatusReport,
  formatLoopStatusReportMarkdown,
} from '../../dev/harness2/report.mjs';
import { start as startFirestoreFake } from '../fakes/firestore-server.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { main as runHarnessCycle } from '../../roles/paraclete-h2/skills/harness-evolution/harness-cycle.mjs';
import { main as runHarnessEval } from '../../roles/paraclete-h2/skills/harness-benchmark/harness-eval.mjs';
import { main as runHarnessPromote } from '../../roles/paraclete-h2/skills/harness-release/harness-promote.mjs';

/**
 * Evidence that passes its verdict: three real runs of one task on each side, the candidate clearly
 * better, and the change proposed by a model. Options make it fail one rule at a time.
 */
function measuredEvidence(candidate, { source = 'vertex', base = [0.4, 0.42, 0.38], cand = [0.9, 0.92, 0.88], taskId = 'task-a' } = {}) {
  const runs = (caps) => caps.map((capability, i) => ({ taskId, trial: i + 1, synthetic: false, capability, missionId: `m-${taskId}-${i}` }));
  return buildPromotionEvidence({
    candidate: { ...candidate, proposal: { source, hypothesis: 'a measured change' } },
    baselineTrajectories: runs(base),
    candidateTrajectories: runs(cand),
  });
}

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

  it('Step 1: materializes promoted candidate filePatches via applyPromotedCandidate and rolls back on failure', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'paraclete-promote-apply-'));
    try {
      const targetRel = 'roles/paraclete-h2/prompts/cortex.md';
      mkdirSync(join(tmpRepo, 'roles', 'paraclete-h2', 'prompts'), { recursive: true });
      writeFileSync(join(tmpRepo, targetRel), '# Original Cortex Overlay\n', 'utf8');

      const gitCalls = [];
      const mockExecGit = (args) => {
        gitCalls.push(args);
        return '';
      };

      const candidate = {
        id: 'cand-win-1',
        lens: 'DOM',
        stage: 'stage1',
        touchedPaths: [targetRel],
        filePatches: {
          [targetRel]: '# Promoted Cortex Overlay\nConcise rule.\n',
        },
        scores: { capability: 1, reliability: 1, efficiency: 0.85, composite: 0.96 },
      };

      const readiness = evaluatePromotionReadiness({
        candidate,
        baselineScores: { capability: 1, reliability: 1, efficiency: 0.72, composite: 0.92 },
      });
      assert.equal(readiness.ready, true);

      const applied = applyPromotedCandidate({
        candidate,
        readiness,
        repoRoot: tmpRepo,
        branch: 'h2/promote-cand-win-1',
        execGit: mockExecGit,
        validate: () => ({ ok: true }),
      });

      assert.equal(applied.applied, true);
      assert.equal(applied.branch, 'h2/promote-cand-win-1');
      assert.deepEqual(applied.appliedPaths, [targetRel]);
      assert.equal(readFileSync(join(tmpRepo, targetRel), 'utf8'), '# Promoted Cortex Overlay\nConcise rule.\n');
      assert.deepEqual(gitCalls[0], ['checkout', '-B', 'h2/promote-cand-win-1']);

      // Verify automatic rollback when post-apply validation fails
      const badCandidate = {
        ...candidate,
        filePatches: {
          [targetRel]: '# Corrupted Overlay\n',
        },
      };
      const rolledBack = applyPromotedCandidate({
        candidate: badCandidate,
        readiness,
        repoRoot: tmpRepo,
        validate: () => ({ ok: false, violations: ['simulated validation failure'] }),
      });
      assert.equal(rolledBack.applied, false);
      assert.ok(rolledBack.reason.includes('Post-apply validation failed'));
      assert.equal(readFileSync(join(tmpRepo, targetRel), 'utf8'), '# Promoted Cortex Overlay\nConcise rule.\n');

      // Also test CLI promote --apply
      const cliRes = await runCli(['promote', '--stage', 'stage1', '--apply', '--branch', 'h2/cli-promote'], {
        repoRoot: tmpRepo,
        candidate,
        baselineScores: { capability: 1, reliability: 1, efficiency: 0.72, composite: 0.92 },
        execGit: mockExecGit,
        validate: () => ({ ok: true }),
      });
      assert.equal(cliRes.ok, true);
      assert.equal(cliRes.application.applied, true);
      assert.ok(cliRes.report.includes('## Applied Promotion'));
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('Step 2: seeds all 10 Stage 2 specialist workspace fixtures and passes Stage 2 live evaluation', async () => {
    const stage2Ids = Object.keys(STAGE2_FIXTURES);
    assert.equal(stage2Ids.length, 10);
    assert.equal(Object.keys(ALL_FIXTURES).length, 16);

    for (const id of stage2Ids) {
      const fx = getTaskFixture(id);
      assert.ok(fx, `Stage 2 fixture missing for ${id}`);
      const ws = mkdtempSync(join(tmpdir(), `paraclete-fx2-${id}-`));
      try {
        fx.seedWorkspace(ws);
        const before = fx.verifyWorkspace(ws);
        assert.equal(before.passed, false, `expected broken Stage 2 fixture ${id} to fail before repair`);
        fx.applyReferenceSolution(ws);
        const after = fx.verifyWorkspace(ws);
        assert.equal(after.passed, true, `expected Stage 2 fixture ${id} to pass after applyReferenceSolution`);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }

    const stage2Tasks = selectBenchmarkTasks({ stage: 'stage2' });
    assert.equal(stage2Tasks.length, 16);
    const stage2Sample = stage2Tasks.filter((t) =>
      ['gen-01-grounded-synthesis', 'da-01-cohort-variance', 'sec-01-iam-least-privilege'].includes(t.id),
    );
    const stage2Live = await evaluateLiveTarget({ stage: 'stage2', tasks: stage2Sample });
    assert.equal(stage2Live.trajectories.length, 3);
    assert.equal(stage2Live.summary.capability, 1);
    assert.equal(stage2Live.summary.reliability, 1);
  });

  it('Step 3: ingests live Firestore trajectories and persists harvested benchmark tasks for selectBenchmarkTasks', async () => {
    const fakeFs = await startFirestoreFake({ projectId: 'paraclete-h2-harvest-test' });
    const tmpDir = mkdtempSync(join(tmpdir(), 'paraclete-harvest-suite-'));
    const suitePath = join(tmpDir, 'harvested-suite.json');
    try {
      const db = createClient({
        projectId: 'paraclete-h2-harvest-test',
        firestoreHost: fakeFs.origin,
        getAccessToken: async () => 'fake-token',
        logger: () => {},
      });
      const missionId = 'm-fs-live-01';
      await db.write(`${COLLECTIONS.work}/${missionId}`, {
        id: missionId,
        role: 'software-engineer',
        platform_version: 'v2026.10.19.2.0',
        status: 'failed',
        instruction: 'Fix flaky pagination boundary when offset equals total count',
        checkpoint_spine: [
          {
            n: 1,
            goal: 'Verify offset boundary condition in paginator',
            status: 'failed',
            replan_count: 2,
          },
        ],
      });

      const harvestRes = await runCli(
        [
          'harvest',
          '--project',
          'paraclete-h2-harvest-test',
          '--version',
          'v2026.10.19.2.0',
          '--persist',
          '--suite-path',
          suitePath,
        ],
        {
          firestoreHost: fakeFs.origin,
          getAccessToken: async () => 'fake-token',
        },
      );

      assert.equal(harvestRes.ok, true);
      assert.equal(harvestRes.harvested.acceptedCount, 1);
      assert.equal(harvestRes.synthesizedTasks.length, 1);
      assert.equal(harvestRes.persistence.count, 1);

      const persisted = loadPersistedBenchmarkTasks({ suitePath });
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].sourceMissionId, missionId);

      const mergedTasks = selectBenchmarkTasks({
        stage: 'stage1',
        includeHarvested: true,
        suitePath,
      });
      assert.equal(mergedTasks.length, 7);
      assert.ok(mergedTasks.some((t) => t.sourceMissionId === missionId));
    } finally {
      await fakeFs.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Step 4: proposes candidate mutations via proposeVertexMutation (--vertex) with clean offline fallback', async () => {
    const tmpTarget = mkdtempSync(join(tmpdir(), 'paraclete-vertex-mut-'));
    try {
      const overlayRel = 'roles/paraclete-h2/prompts/cortex.md';
      mkdirSync(join(tmpTarget, 'roles', 'paraclete-h2', 'prompts'), { recursive: true });
      writeFileSync(join(tmpTarget, overlayRel), '# Baseline Overlay\n', 'utf8');

      // 1. Vertex generator returns structured JSON patch
      const vertexRes = await proposeVertexMutation({
        spec: {
          lens: 'DOM',
          escalationMode: 'refine',
          feedbackPrompt: 'Tighten cortex overlay.',
        },
        baseState: { id: 'gen0', generation: 0 },
        targetRoot: tmpTarget,
        vertexGenerate: async () =>
          '```json\n' +
          JSON.stringify({
            hypothesis: 'Vertex tightened cortex overlay prompt',
            patches: {
              [overlayRel]: '# Vertex Mutated Overlay\nEnforce strict lens attribution.\n',
            },
          }) +
          '\n```',
      });

      assert.equal(vertexRes.source, 'vertex');
      assert.deepEqual(vertexRes.touchedPaths, [overlayRel]);
      assert.equal(vertexRes.hypothesis, 'Vertex tightened cortex overlay prompt');
      assert.ok(readFileSync(join(tmpTarget, overlayRel), 'utf8').includes('Vertex Mutated Overlay'));

      // 2. Offline / throwing generator falls back cleanly to applyDefaultCandidateMutation
      const fallbackRes = await proposeVertexMutation({
        spec: {
          lens: 'DOM',
          escalationMode: 'pivot',
          priorAttemptsSummary: [{ step: 1 }],
        },
        baseState: { id: 'gen0', generation: 0 },
        targetRoot: tmpTarget,
        vertexGenerate: async () => {
          throw new Error('offline in hermetic test');
        },
      });
      assert.equal(fallbackRes.source, 'fallback');
      assert.deepEqual(fallbackRes.touchedPaths, [overlayRel]);

      // 3. Run evolve --live --vertex with injected vertexGenerate
      const evoVertex = await runCli(
        [
          'evolve',
          '--stage',
          'stage1',
          '--role',
          'paraclete-h2',
          '--generations',
          '1',
          '--recursion',
          '1',
          '--live',
          '--vertex',
        ],
        {
          vertexGenerate: async (_prompt, spec) => {
            if (spec.lens === 'DOM') {
              return JSON.stringify({
                hypothesis: 'Vertex DOM concise overlay',
                patches: {
                  [overlayRel]: '# Role Overlay: Paraclete-H² (`cortex`)\nConcise Vertex overlay.\n',
                },
              });
            }
            throw new Error('use default INV mutation');
          },
        },
      );
      assert.equal(evoVertex.ok, true);
      assert.equal(evoVertex.winner.scores.capability, 1);
    } finally {
      rmSync(tmpTarget, { recursive: true, force: true });
    }
  });

  it('Step 5: provisions and inspects the two-tier GCP lab via provisionGcpLab, inspectGcpLabStatus, and CLI', async () => {
    const gcloudCalls = [];
    const mockExecGcloud = (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'projects' && args[1] === 'describe') {
        throw new Error('not found');
      }
      if (args[0] === 'billing' && args[1] === 'projects' && args[2] === 'describe') {
        return 'False';
      }
      if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'describe') {
        throw new Error('not found');
      }
      if (args[0] === 'firestore' && args[1] === 'databases' && args[2] === 'describe') {
        throw new Error('not found');
      }
      if (args[0] === 'storage' && args[1] === 'buckets' && args[2] === 'describe') {
        throw new Error('not found');
      }
      if (args[0] === 'compute' && args[1] === 'networks' && args[2] === 'describe') {
        return 'default';
      }
      if (args[0] === 'compute' && args[1] === 'firewall-rules' && args[2] === 'describe') {
        throw new Error('not found');
      }
      if (args[0] === 'compute' && args[1] === 'instances' && args[2] === 'describe') {
        throw new Error('not found');
      }
      if (args[0] === 'compute' && args[1] === 'instances' && args[2] === 'list') {
        return JSON.stringify([
          {
            name: 'paraclete-h2-driver',
            status: 'RUNNING',
            machineType: 'zones/us-central1-a/machineTypes/e2-standard-8',
            zone: 'zones/us-central1-a',
            metadata: {
              items: [
                { key: 'paraclete-role', value: 'paraclete-h2' },
                { key: 'paraclete-agent-name', value: 'Paraclete-H2-Driver' },
              ],
            },
            networkInterfaces: [{ networkIP: '10.128.0.10' }],
          },
          {
            name: 'paraclete-h2-canary',
            status: 'RUNNING',
            machineType: 'zones/us-central1-a/machineTypes/e2-standard-4',
            zone: 'zones/us-central1-a',
            metadata: {
              items: [
                { key: 'paraclete-role', value: 'software-engineer' },
                { key: 'paraclete-agent-name', value: 'Paraclete-H2-Canary' },
              ],
            },
            networkInterfaces: [{ networkIP: '10.128.0.11' }],
          },
        ]);
      }
      return 'ok';
    };

    const dryRunRes = await runCli(
      ['lab-provision', '--project', 'paraclete-h2-lab', '--org', '100000000001', '--billing', '000000-000000-000000', '--dry-run'],
      { execGcloud: mockExecGcloud },
    );
    assert.equal(dryRunRes.ok, true);
    assert.equal(dryRunRes.dryRun, true);
    assert.equal(gcloudCalls.length, 0);

    const provRes = provisionGcpLab({
      projectId: 'paraclete-h2-lab',
      organizationId: '100000000001',
      billingAccount: '000000-000000-000000',
      commit: '0123456789abcdef0123456789abcdef01234567',
      execGcloud: mockExecGcloud,
    });
    assert.equal(provRes.ok, true);
    assert.equal(provRes.dryRun, false);
    assert.ok(provRes.stepsExecuted.some((s) => s.step === 'project' && s.status === 'created'));
    assert.ok(provRes.stepsExecuted.some((s) => s.step === 'billing' && s.status === 'linked'));
    assert.ok(provRes.stepsExecuted.some((s) => s.step === 'vm:paraclete-h2-driver' && s.status === 'created'));
    assert.ok(provRes.stepsExecuted.some((s) => s.step === 'vm:paraclete-h2-canary' && s.status === 'created'));

    const statusRes = await runCli(['lab-status', '--project', 'paraclete-h2-lab'], {
      execGcloud: mockExecGcloud,
    });
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.vms.length, 2);
    assert.equal(statusRes.vms[0].name, 'paraclete-h2-driver');
    assert.equal(statusRes.vms[0].role, 'paraclete-h2');
    assert.equal(statusRes.vms[1].name, 'paraclete-h2-canary');
    assert.equal(statusRes.vms[1].role, 'software-engineer');
  });

  it('Frontier Model Committee Judge (gemini-4-argon + claude-opus-5-5) and Capability-First Credo', async () => {
    // 1. Default committee includes gemini-4-argon and claude-opus-5-5, and supports custom adapters
    assert.deepEqual(DEFAULT_JUDGE_COMMITTEE, [
      'vertex-google/gemini-4-argon',
      'vertex-anthropic/claude-opus-5-5',
    ]);
    assert.equal(Object.keys(JUDGE_DIMENSIONS).length, 5);
    assert.deepEqual(
      parseCommitteeSpec('vertex-google/gemini-4-argon, vertex-anthropic/claude-opus-5-5, custom-provider/frontier-x').map(
        (m) => m.model,
      ),
      ['vertex-google/gemini-4-argon', 'vertex-anthropic/claude-opus-5-5', 'custom-provider/frontier-x'],
    );

    // 2. Hard-gate combination: broken deterministic fixture caps rubricScore at <= 0.35 even if LLM gives 1.0
    assert.ok(
      combineHardGateWithCommitteeScore({ committeeScore: 1.0, fixtureVerification: { passed: false } }).rubricScore <=
        0.35,
    );
    assert.equal(
      combineHardGateWithCommitteeScore({ committeeScore: 1.0, fixtureVerification: { passed: true } }).rubricScore,
      1.0,
    );

    // 3. Build blind judge packet and run multi-model committee (Google + Anthropic + custom extensible adapter)
    const ws = mkdtempSync(join(tmpdir(), 'paraclete-judge-ws-'));
    try {
      writeFileSync(join(ws, 'paginator.mjs'), 'export function paginate(items) { return items; }\n', 'utf8');
      const packet = buildJudgePacket({
        task: {
          id: 'se-01-pagination-off-by-one',
          role: 'software-engineer',
          instruction: 'Diagnose and fix the off-by-one boundary defect in paginator.mjs and verify with node --test.',
          expectedClauses: ['fix boundary defect', 'run node --test and cite passing output'],
        },
        envelope: {
          status: 'completed',
          checkpoint_spine: [
            {
              n: 1,
              goal: 'fix boundary defect and run node --test',
              status: 'done',
              result_summary: 'Fixed boundary defect in paginator.mjs and ran node --test (0 failures).',
            },
          ],
        },
        tasks: [
          {
            id: 't1',
            checkpoint_n: 1,
            status: 'completed',
            tool_records: [{ tool: 'shell', command: 'node --test', exitCode: 0, stdout: 'pass 2 / fail 0' }],
          },
        ],
        workspaceDir: ws,
        fixtureVerification: { passed: true, summary: 'All paginator tests pass' },
      });

      assert.equal(packet.taskSpec.taskId, 'se-01-pagination-off-by-one');
      assert.equal(Object.keys(packet.workspaceArtifacts).length, 1);

      const seenRequests = [];
      const mockFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        seenRequests.push({ url, body });
        if (url.includes('gemini-4-argon')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            clauseScore: 0.96,
                            craftScore: 0.92,
                            groundingScore: 0.95,
                            rigorScore: 0.90,
                            clarityScore: 0.94,
                            passed: true,
                            diagnosticLensHint: 'DOM',
                            failureReasons: [],
                            improvementPrescription: 'Keep test citation concise',
                          }),
                        },
                      ],
                    },
                  },
                ],
              }),
          };
        }
        if (url.includes('claude-opus-5-5')) {
          // Verify claude-opus-5-5 omits temperature per contracts.json / anthropic-step.mjs
          assert.equal('temperature' in body, false);
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      clauseScore: 0.92,
                      craftScore: 0.88,
                      groundingScore: 0.91,
                      rigorScore: 0.86,
                      clarityScore: 0.90,
                      passed: true,
                      diagnosticLensHint: 'DOM',
                      failureReasons: [],
                      improvementPrescription: 'Add edge-case assertion for empty array',
                    }),
                  },
                ],
              }),
          };
        }
        throw new Error(`unexpected URL: ${url}`);
      };

      // Also test extensibility via registerJudgeAdapter
      registerJudgeAdapter('ext-frontier', async ({ member }) => ({
        clauseScore: 0.94,
        craftScore: 0.90,
        groundingScore: 0.93,
        rigorScore: 0.88,
        clarityScore: 0.92,
        passed: true,
        diagnosticLensHint: 'DOM',
        failureReasons: [],
        improvementPrescription: `Verified by ${member.model}`,
      }));

      const committeeCritique = await evaluateWithFrontierCommittee(packet, {
        committee: [
          'vertex-google/gemini-4-argon',
          'vertex-anthropic/claude-opus-5-5',
          'ext-frontier/model-next',
        ],
        projectId: 'paraclete-h2-lab',
        getAccessToken: async () => 'fake-token',
        fetch: mockFetch,
      });

      assert.equal(seenRequests.length, 2);
      assert.equal(committeeCritique.committeeModels.length, 3);
      assert.equal(committeeCritique.passed, true);
      assert.ok(committeeCritique.committeeScore > 0.88 && committeeCritique.committeeScore <= 1.0);
      assert.ok(committeeCritique.rubricScore > 0.9);
      assert.equal(committeeCritique.diagnosticLensHint, 'DOM');
      assert.ok(committeeCritique.improvementPrescription.includes('Keep test citation concise'));
      assert.ok(committeeCritique.agreement.maxDisagreement < 0.06);

      // Pairwise comparison across the committee
      const pairwise = await judgePairwiseWithCommittee(
        { task: { id: 'se-01-pagination-off-by-one' }, packetA: packet, packetB: packet },
        {
          committee: ['vertex-google/gemini-4-argon', 'vertex-anthropic/claude-opus-5-5'],
          projectId: 'paraclete-h2-lab',
          getAccessToken: async () => 'fake-token',
          fetch: mockFetch,
        },
      );
      assert.equal(pairwise.winner, 'TIE');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }

    // 4. Capability-First Credo: capability strictly overrides efficiency and scalar fitness
    assert.equal(CAPABILITY_CREDO.priorityOrder[0], 'capability');
    const highCapLowEff = {
      id: 'high-cap',
      scores: { capability: 0.95, reliability: 0.85, efficiency: 0.50, fitness: 0.80 },
    };
    const lowCapHighEff = {
      id: 'low-cap-high-eff',
      scores: { capability: 0.91, reliability: 0.95, efficiency: 0.99, fitness: 0.94 },
    };
    // Even though lowCapHighEff has higher fitness (0.94 vs 0.80) and efficiency (0.99 vs 0.50),
    // highCapLowEff MUST win under Capability-First Credo!
    assert.equal(compareCapabilityFirst(highCapLowEff, lowCapHighEff) < 0, true);
    assert.equal(
      isBetterUnderCapabilityCredo(highCapLowEff.scores, lowCapHighEff.scores),
      true,
    );
    assert.equal(
      isBetterUnderCapabilityCredo(lowCapHighEff.scores, highCapLowEff.scores),
      false,
    );

    const orderedFrontier = computeParetoFrontier([lowCapHighEff, highCapLowEff]);
    assert.equal(orderedFrontier[0].id, 'high-cap');

    // 5. CLI `judge` subcommand and `evolve --live --judge-committee`
    const cliJudge = await runCli(['judge', '--stage', 'stage1', '--role', 'paraclete-h2']);
    assert.equal(cliJudge.ok, true);
    assert.equal(cliJudge.credo, 'CAPABILITY_FIRST');
    assert.deepEqual(cliJudge.committee, DEFAULT_JUDGE_COMMITTEE);
    assert.ok(cliJudge.summary.capability > 0.85);
  });

  it('Autonomous Primary-Repo Loop: Skill/Role Scaffolding, Curriculum Expansion, and GitHub PR Creation', async () => {
    // 1. Skill & Role Scaffolding + allowNewRoles surface classification
    const skillScaffold = buildSkillScaffold({
      skillId: 'log-correlation',
      role: 'site-reliability-engineer',
      name: 'Log Correlation',
    });
    assert.equal(skillScaffold.baseDir, 'roles/site-reliability-engineer/skills/log-correlation');
    assert.ok(skillScaffold.filePatches['roles/site-reliability-engineer/skills/log-correlation/skill.json']);
    assert.ok(skillScaffold.filePatches['roles/site-reliability-engineer/skills/log-correlation/SKILL.md']);
    assert.ok(skillScaffold.filePatches['roles/site-reliability-engineer/skills/log-correlation/log-correlation-cli.mjs']);

    const roleScaffold = buildRoleScaffold({
      roleId: 'finops-analyst',
      title: 'FinOps Analyst',
    });
    assert.equal(roleScaffold.roleDir, 'roles/finops-analyst');
    assert.ok(roleScaffold.filePatches['roles/finops-analyst/role.json']);
    assert.ok(roleScaffold.filePatches['roles/finops-analyst/README.md']);
    assert.ok(roleScaffold.filePatches['roles/finops-analyst/prompts/cortex.md']);

    // Verify allowNewRoles allows scaffolding a brand-new role directory
    assert.equal(
      validateTouchedPaths(['roles/finops-analyst/role.json'], { stage: 'stage1', allowNewRoles: false }).ok,
      false,
    );
    assert.equal(
      validateTouchedPaths(['roles/finops-analyst/role.json', 'roles/finops-analyst/README.md'], {
        stage: 'stage1',
        allowNewRoles: true,
      }).ok,
      true,
    );
    assert.equal(
      classifySurfacePath('roles/finops-analyst/README.md', { stage: 'stage2', allowNewRoles: true }).allowed,
      true,
    );

    // 2. Progressive Curriculum Expansion for saturated roles (S_cap >= 0.98)
    const tmpDir = mkdtempSync(join(tmpdir(), 'paraclete-curriculum-'));
    try {
      const suitePath = join(tmpDir, 'harvested-tasks.json');
      const expansion = expandCurriculumForSaturatedRoles(
        {
          summary: {
            byRole: {
              'software-engineer': { capability: 0.99, reliability: 1.0, efficiency: 0.85 },
              'data-analyst': { capability: 0.85, reliability: 0.9, efficiency: 0.8 },
            },
          },
        },
        { persist: true, suitePath },
      );
      assert.deepEqual(expansion.saturatedRoles, ['software-engineer']);
      assert.equal(expansion.synthesizedTasks.length, 1);
      assert.equal(expansion.synthesizedTasks[0].role, 'software-engineer');
      assert.equal(expansion.persistence.count, 1);

      // Re-running with same tier does not duplicate the task
      const secondExpansion = expandCurriculumForSaturatedRoles(
        {
          summary: {
            byRole: {
              'software-engineer': { capability: 0.99, reliability: 1.0, efficiency: 0.85 },
            },
          },
        },
        { persist: true, suitePath },
      );
      assert.equal(secondExpansion.synthesizedTasks.length, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // 3. Automated GitHub Branch Push & PR Creation (dryRun + injected execGit / execGh)
    const readiness = evaluatePromotionReadiness({
      candidate: {
        id: 'gen3-winner',
        lens: 'DOM',
        stage: 'stage2',
        touchedPaths: ['roles/software-engineer/prompts/cortex.md'],
        scores: { capability: 0.96, reliability: 0.95, efficiency: 0.84, fitness: 0.935 },
      },
      baselineScores: { capability: 0.90, reliability: 0.92, efficiency: 0.80, fitness: 0.888 },
      evidence: measuredEvidence({ id: 'gen3-winner', lens: 'DOM', touchedPaths: ['roles/software-engineer/prompts/cortex.md'] }),
    });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.evidence.verdict.ok, true, readiness.evidence.verdict.problems.join('; '));

    const gitCalls = [];
    const ghCalls = [];
    const prRes = pushAndCreatePullRequest({
      candidate: {
        id: 'gen3-winner',
        lens: 'DOM',
        stage: 'stage2',
        touchedPaths: ['roles/software-engineer/prompts/cortex.md'],
        scores: { capability: 0.96, reliability: 0.95, efficiency: 0.84, fitness: 0.935 },
      },
      readiness,
      branch: 'h2/promote-gen3-winner',
      execGit: (args) => {
        gitCalls.push(args);
        if (args[0] === 'status') return ' M roles/software-engineer/prompts/cortex.md\n';
        return 'ok';
      },
      execGh: (args) => {
        ghCalls.push(args);
        return 'https://github.com/org/paraclete/pull/42\n';
      },
    });
    assert.equal(prRes.created, true);
    assert.equal(prRes.prUrl, 'https://github.com/org/paraclete/pull/42');
    assert.ok(gitCalls.some((c) => c[0] === 'commit'));
    assert.ok(gitCalls.some((c) => c[0] === 'push'));
    assert.equal(ghCalls.length, 1);

    // 4. Verify CLI `scaffold-skill` and `scaffold-role`
    const cliSkill = await runCli(['scaffold-skill', '--id', 'trace-analyzer', '--role', 'software-engineer']);
    assert.equal(cliSkill.ok, true);
    assert.equal(cliSkill.scaffold.baseDir, 'roles/software-engineer/skills/trace-analyzer');

    const cliRole = await runCli(['scaffold-role', '--id', 'qa-lead', '--title', 'QA Lead']);
    assert.equal(cliRole.ok, true);
    assert.equal(cliRole.scaffold.roleDir, 'roles/qa-lead');
  });

  it('Master Curriculum Playbook: 24 units across 6 organs, 7 engineering roles, 11 specialist roles + artifact verification + stateful progression', async () => {
    // 1. Verify 24 curriculum units cover all 3 tracks, all 6 organs, and all 18 roles
    assert.equal(Object.keys(CURRICULUM_TRACKS).length, 3);
    assert.equal(MASTER_CURRICULUM_UNITS.length, 24);

    const organsCovered = new Set(
      MASTER_CURRICULUM_UNITS.filter((u) => u.track === 'organs').map((u) => u.organ),
    );
    assert.deepEqual(
      [...organsCovered].sort(),
      ['cerebellum', 'cortex', 'motor', 'prefrontal', 'temporal-memory', 'temporal-research'],
    );

    const rolesCovered = new Set(MASTER_CURRICULUM_UNITS.map((u) => u.role));
    for (const r of rolesForStage('stage2', { repoRoot: process.cwd() })) {
      assert.equal(rolesCovered.has(r), true, `Expected curriculum to cover installed role ${r}`);
    }

    // 2. Verify artifact materialization and verification for unmaterialized vs materialized across all 24 units
    const tmpRoot = mkdtempSync(join(tmpdir(), 'paraclete-curriculum-units-'));
    try {
      for (const unit of MASTER_CURRICULUM_UNITS) {
        const wsBase = join(tmpRoot, `${unit.id}-base`);
        const wsEvo = join(tmpRoot, `${unit.id}-evo`);
        const fixture = getTaskFixture(unit.task.id);
        fixture.seedWorkspace(wsBase);
        fixture.seedWorkspace(wsEvo);
        fixture.applyReferenceSolution(wsEvo);
        materializeCurriculumArtifacts(wsEvo, unit, { evolved: true });

        const verifyBase = verifyUnitArtifacts(wsBase, unit);
        const verifyEvo = verifyUnitArtifacts(wsEvo, unit);
        assert.equal(
          verifyBase.passed,
          false,
          `Expected unmaterialized workspace to fail artifact verification for ${unit.id}`,
        );
        assert.equal(
          verifyEvo.passed,
          true,
          `Expected materialized workspace to pass artifact verification for ${unit.id}`,
        );
      }

      // 3. Verify stateful cursor progression and coverage report
      const statePath = join(tmpRoot, 'curriculum-state.json');
      const firstSel = selectNextCurriculumUnit({ statePath });
      assert.equal(firstSel.unit.id, 'unit-organ-cortex');

      recordCurriculumUnitAttempt({
        unitId: firstSel.unit.id,
        baselineScores: { capability: 0.72, reliability: 0.9, efficiency: 0.8, fitness: 0.79 },
        winnerScores: { capability: 0.96, reliability: 0.95, efficiency: 0.85, fitness: 0.94 },
        promoted: true,
        artifactChecksPassed: true,
        prUrl: 'https://github.com/halstonblase/paraclete/pull/2',
        statePath,
      });

      const nextSel = selectNextCurriculumUnit({ statePath });
      assert.equal(nextSel.unit.id, 'unit-organ-prefrontal');

      const cov = getCurriculumCoverageReport({ statePath });
      assert.equal(cov.totalUnits, 24);
      assert.equal(cov.completedUnits, 1);
      assert.equal(cov.nextUnitId, 'unit-organ-prefrontal');

      // 4. Verify CLI `curriculum --status` and `curriculum --unit <id>`
      const cliStatus = await runCli(['curriculum', '--status', '--state-path', statePath]);
      assert.equal(cliStatus.ok, true);
      assert.equal(cliStatus.coverage.completedUnits, 1);

      const cliExec = await runCli([
        'curriculum',
        '--unit',
        'unit-role-software-engineer',
        '--state-path',
        statePath,
      ]);
      assert.equal(cliExec.ok, true);
      assert.equal(cliExec.curriculumUnit.id, 'unit-role-software-engineer');
      assert.equal(cliExec.curriculumUnit.role, 'software-engineer');
      assert.ok(cliExec.winnerScores.capability >= cliExec.baselineScores.capability);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('Next-Epoch Curriculum Synthesizer: scanCurriculumCoverageGaps, synthesizeNextCurriculumEpoch, automatic epoch rollover, and cli --suggest', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'paraclete-curriculum-suggest-'));
    try {
      const statePath = join(tmpRoot, 'curriculum-state.json');
      const proposalJsonPath = join(tmpRoot, 'proposed-curriculum.json');
      const proposalMdPath = join(tmpRoot, 'CURRICULUM_PROPOSAL.md');
      const harvestedSuitePath = join(tmpRoot, 'harvested-tasks.json');

      // Seed a harvested Loop B production failure trajectory
      writeFileSync(
        harvestedSuitePath,
        JSON.stringify(
          [
            {
              id: 'prod-loopb-timeout-401',
              role: 'devops-engineer',
              organFocus: 'cerebellum',
              skillFocus: 'systemd-ops',
              failureMode: 'tool_timeout_unverified_service',
              goal: 'Guard against unverified systemd restart exit status in prod-loopb-timeout-401.',
              expectedClauses: ['diagnose prod-loopb-timeout-401', 'verify service status'],
            },
          ],
          null,
          2,
        ),
        'utf8',
      );

      // Step through all 24 Epoch 1 units:
      // - 1st unit ('unit-organ-cortex') evaluated without promotion (triggers remediation signal)
      // - remaining 23 units promoted with high capability >= 0.98 (triggers tier_escalation signal)
      for (let i = 0; i < MASTER_CURRICULUM_UNITS.length; i += 1) {
        const u = MASTER_CURRICULUM_UNITS[i];
        const isLast = i === MASTER_CURRICULUM_UNITS.length - 1;
        recordCurriculumUnitAttempt(
          {
            unitId: u.id,
            baselineScores: { capability: 0.82, reliability: 0.9, efficiency: 0.8, fitness: 0.83 },
            winnerScores:
              i === 0
                ? { capability: 0.84, reliability: 0.88, efficiency: 0.8, fitness: 0.84 }
                : { capability: 0.985, reliability: 0.97, efficiency: 0.89, fitness: 0.97 },
            promoted: i !== 0,
            artifactPassRate: i === 0 ? 0.5 : 1,
            statePath,
            proposalJsonPath,
            proposalMdPath,
            harvestedSuitePath,
            autoSuggest: isLast,
          },
          {
            statePath,
            proposalJsonPath,
            proposalMdPath,
            harvestedSuitePath,
          },
        );
      }

      // Because the 24th unit completed all pending Epoch 1 units, automatic epoch rollover
      // should have synthesized Epoch 2 and queued new pending units!
      const postRolloverReport = getCurriculumCoverageReport({ statePath });
      assert.equal(postRolloverReport.epoch, 2);
      assert.equal(postRolloverReport.baselineUnitsCount, 24);
      assert.ok(postRolloverReport.dynamicUnitsCount > 0, 'Expected synthesized Epoch 2 dynamic units');
      assert.equal(postRolloverReport.completedUnits, 24);
      assert.equal(postRolloverReport.pendingUnits, postRolloverReport.dynamicUnitsCount);
      assert.equal(postRolloverReport.proposalsCount, 1);
      assert.ok(postRolloverReport.nextUnitId.startsWith('unit-epoch2-'));

      // Verify every synthesized unit has a valid mutable path and materializes + passes artifact verification
      const allUnits = getAllCurriculumUnits({ state: { dynamicUnits: JSON.parse(readFileSync(proposalJsonPath, 'utf8')).proposedUnits } });
      const epoch2Units = allUnits.filter((u) => u.epoch === 2);
      assert.ok(epoch2Units.length >= 4);
      const sourcesPresent = new Set(epoch2Units.map((u) => u.source));
      assert.ok(sourcesPresent.has('coverage_gap'), 'Expected coverage_gap units in Epoch 2');
      assert.ok(sourcesPresent.has('remediation'), 'Expected remediation unit for unit-organ-cortex in Epoch 2');
      assert.ok(sourcesPresent.has('harvested_failure'), 'Expected harvested_failure unit in Epoch 2');

      for (const dynUnit of epoch2Units) {
        const pathCheck = classifySurfacePath(dynUnit.targetMutablePath, { stage: 'stage2', allowNewRoles: true });
        assert.equal(pathCheck.allowed, true, `Dynamic unit ${dynUnit.id} targetMutablePath ${dynUnit.targetMutablePath} must be mutable`);
        const ws = join(tmpRoot, `ws-${dynUnit.id}`);
        materializeCurriculumArtifacts(ws, dynUnit, { evolved: true });
        const verified = verifyUnitArtifacts(ws, dynUnit);
        assert.equal(verified.passed, true, `Dynamic unit ${dynUnit.id} artifacts failed verification: ${JSON.stringify(verified)}`);
      }

      // Verify on-demand CLI `curriculum --suggest --max-units 6`
      const suggestCli = await runCli([
        'curriculum',
        '--suggest',
        '--max-units',
        '6',
        '--state-path',
        statePath,
      ]);
      assert.equal(suggestCli.ok, true);
      assert.equal(suggestCli.suggestedEpoch, 3);
      assert.equal(suggestCli.proposedUnitsCount, 6);
      assert.ok(suggestCli.markdown.includes('# Paraclete-H² Autonomous Curriculum Proposal — Epoch 3'));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('Standardized Loop & GCP Cost Status Report (report.mjs, cli report, and harness-cycle --action report)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'paraclete-h2-report-'));
    try {
      const statePath = join(tmpRoot, 'curriculum-state.json');
      const suitePath = join(tmpRoot, 'harvested-suite.json');

      recordCurriculumUnitAttempt({
        unitId: 'unit-organ-cortex',
        baselineScores: { capability: 0.85, reliability: 0.9, efficiency: 0.8, fitness: 0.86 },
        winnerScores: { capability: 1.0, reliability: 1.0, efficiency: 0.92, fitness: 0.985 },
        promoted: true,
        artifactPassRate: 1.0,
        statePath,
      });

      const costEst = computeGcpCostEstimate({
        billingAccountName: 'billingAccounts/000000-000000-000000',
        billingEnabled: true,
        nowIso: '2026-10-21T13:30:00Z',
        instances: [
          {
            name: 'paraclete-h2-driver',
            machineType: 'zones/us-central1-a/machineTypes/e2-standard-8',
            status: 'RUNNING',
            creationTimestamp: '2026-10-20T01:00:00Z',
            networkInterfaces: [{ accessConfigs: [{ natIP: '198.51.100.10' }] }],
          },
          {
            name: 'paraclete-h2-canary',
            machineType: 'zones/us-central1-a/machineTypes/e2-standard-4',
            status: 'RUNNING',
            creationTimestamp: '2026-10-20T01:00:00Z',
            networkInterfaces: [{ accessConfigs: [{ natIP: '198.51.100.11' }] }],
          },
        ],
        disks: [
          { name: 'paraclete-h2-driver', sizeGb: 100, type: 'pd-ssd' },
          { name: 'paraclete-h2-canary', sizeGb: 50, type: 'pd-balanced' },
        ],
        missions: [
          {
            missionId: 'w-100',
            responsibility: 'r-harness-closed-loop',
            calls: 44,
            input: 10_000_000,
            cached: 8_000_000,
            output: 80_000,
            status: 'COMPLETE',
          },
          {
            missionId: 'w-101',
            responsibility: 'r-failure-harvest',
            calls: 96,
            input: 10_000_000,
            cached: 8_000_000,
            output: 170_000,
            status: 'COMPLETE',
          },
        ],
      });

      assert.equal(costEst.vertexAi.cacheHitRate, 0.8);
      assert.ok(costEst.vertexAi.cacheSavingsUsd > 20, 'Expected substantial context cache savings');
      assert.ok(costEst.infrastructure.dailyUsd > 10 && costEst.infrastructure.dailyUsd < 12);
      assert.ok(costEst.totals.accruedToDateUsd > 30);

      const statusReport = buildLoopStatusReport({
        projectId: 'example-h2-lab',
        statePath,
        harvestedSuitePath: suitePath,
        nowIso: '2026-10-21T13:30:00Z',
        instances: [
          {
            name: 'paraclete-h2-driver',
            machineType: 'zones/us-central1-a/machineTypes/e2-standard-8',
            status: 'RUNNING',
            creationTimestamp: '2026-10-20T01:00:00Z',
          },
        ],
        disks: [{ name: 'paraclete-h2-driver', sizeGb: 100, type: 'pd-ssd' }],
        missions: [
          {
            timestamp: '2026-10-21T04:00:00Z',
            responsibility: 'r-harness-closed-loop',
            missionId: 'w-100',
            calls: 44,
            input: 10_000_000,
            cached: 8_000_000,
            output: 80_000,
            status: 'COMPLETE',
          },
        ],
      });

      assert.equal(statusReport.standardVersion, REPORT_STANDARD_VERSION);
      assert.equal(statusReport.curriculum.completedUnits, 1);
      assert.equal(statusReport.curriculum.promotedUnits, 1);

      const md = formatLoopStatusReportMarkdown(statusReport);
      assert.ok(md.includes('# Paraclete-H² Autonomous Loop & GCP Cost Status Report'));
      assert.ok(md.includes('## 1. Executive Summary Scorecard'));
      assert.ok(md.includes('## 2. Master Curriculum Progress & Epoch Summary'));
      assert.ok(md.includes('## 3. Loop A & Loop B Automation Cadence & Recent Executions'));
      assert.ok(md.includes('## 4. GCP Infrastructure & Vertex AI Cost Analysis'));
      assert.ok(md.includes('## 5. Operational Alerts, Self-Healing Diagnostics & Pull Requests'));

      const cliRes = await runCli(['report', '--markdown', '--state-path', statePath]);
      assert.equal(cliRes.ok, true);
      assert.ok(cliRes.report.includes('Paraclete-H² Autonomous Loop & GCP Cost Status Report'));

      let cycleOut = '';
      const exitCode = await runHarnessCycle(
        ['--action', 'report', '--state-path', statePath, '--json'],
        {
          stdout: {
            write(chunk) {
              cycleOut += chunk;
            },
          },
        },
      );
      assert.equal(exitCode, 0);
      const parsedCycle = JSON.parse(cycleOut);
      assert.equal(parsedCycle.ok, true);
      assert.equal(parsedCycle.standardVersion, REPORT_STANDARD_VERSION);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('PR Conflict Resolution & Existing-Branch Update Fallback: mergeContractsJson, mergePromptMarkdown, resolveHarnessMergeConflict, and pushAndCreatePullRequest', () => {
    // 1. 3-way merge of config/contracts.json (PR #2 vs PR #3 divergence from ancestor)
    const ancestorContracts = {
      vertex: { gemini_explicit_cache: true, models: { cortex: 'gemini-3.1-pro' } },
      organs: { max_steps: 22 },
      brain: { result_preview_chars: 2550, evidence_floor: true },
    };
    const mainContracts = {
      vertex: { gemini_explicit_cache: true, models: { cortex: 'gemini-3.1-pro' } },
      organs: { max_steps: 16 },
      brain: { result_preview_chars: 1650, evidence_floor: true },
    };
    const prContracts = {
      vertex: { gemini_explicit_cache: true, models: { cortex: 'gemini-3.1-pro' } },
      organs: { max_steps: 21 },
      brain: { result_preview_chars: 2400, evidence_floor: true },
    };

    const mergedContracts = mergeContractsJson(mainContracts, prContracts, ancestorContracts);
    assert.equal(mergedContracts.mergedObject.organs.max_steps, 19);
    assert.equal(mergedContracts.mergedObject.brain.result_preview_chars, 2050);
    assert.equal(mergedContracts.mergedObject.brain.evidence_floor, true);
    assert.deepEqual(mergedContracts.reconciledKeys, ['organs.max_steps', 'brain.result_preview_chars']);

    // 2. Markdown prompt overlay conflict resolution deduplicates clauses and preserves sections
    const baseMd = [
      '# Role Overlay: Paraclete-H² (`cortex`)',
      '',
      '- Verify Pareto dominance on capability, reliability, and efficiency before promotion.',
      'Never mutate immutable spine modules. Enforce Tier-1 validation before rollout.',
    ].join('\n');
    const headMd = [
      '# Role Overlay: Paraclete-H² (`cortex`)',
      '',
      '- Verify Pareto dominance on capability, reliability, and efficiency before promotion.',
      '- Keep all assembled organ prompts within the 24,000-character budget.',
      'Never mutate immutable spine modules. Enforce Tier-1 validation before rollout.',
      '',
      '## Capability-First Artifact Protocol',
      '- Verify every required output artifact on disk before reporting checkpoint completion.',
    ].join('\n');

    const mdConflict = resolveHarnessMergeConflict({
      relPath: 'roles/paraclete-h2/prompts/cortex.md',
      baseContent: baseMd,
      headContent: headMd,
    });
    assert.equal(mdConflict.resolved, true);
    assert.ok(mdConflict.mergedText.includes('Keep all assembled organ prompts within the 24,000-character budget.'));
    assert.ok(mdConflict.mergedText.includes('## Capability-First Artifact Protocol'));

    // 3. Immutable spine paths are strictly rejected by resolveHarnessMergeConflict
    const spineReject = resolveHarnessMergeConflict({
      relPath: 'agent/services/brain/runner.mjs',
      baseContent: '// main',
      headContent: '// pr',
    });
    assert.equal(spineReject.resolved, false);
    assert.ok(spineReject.reason.includes('immutable or disallowed path'));

    // 4. pushAndCreatePullRequest falls back to --force-with-lease and gh pr edit when updating an existing branch/PR
    const readiness = evaluatePromotionReadiness({
      candidate: {
        id: 'unit-organ-motor-syn',
        lens: 'SYN',
        stage: 'stage1',
        touchedPaths: ['roles/software-engineer/prompts/motor.md'],
        scores: { capability: 0.995, reliability: 1.0, efficiency: 0.77, fitness: 0.96 },
      },
      baselineScores: { capability: 0.36, reliability: 0.5, efficiency: 0.75, fitness: 0.45 },
      evidence: measuredEvidence({ id: 'unit-organ-motor-syn', lens: 'SYN', touchedPaths: ['roles/software-engineer/prompts/motor.md'] }),
    });
    const seenGit = [];
    const seenGh = [];
    const updateRes = pushAndCreatePullRequest({
      candidate: {
        id: 'unit-organ-motor-syn',
        lens: 'SYN',
        stage: 'stage1',
        touchedPaths: ['roles/software-engineer/prompts/motor.md'],
        scores: { capability: 0.995, reliability: 1.0, efficiency: 0.77, fitness: 0.96 },
      },
      readiness,
      branch: 'harness2/curriculum-unit-organ-motor',
      execGit: (args) => {
        seenGit.push(args);
        if (args[0] === 'push' && args[1] === '-u') {
          throw new Error('non-fast-forward');
        }
        return 'ok';
      },
      execGh: (args) => {
        seenGh.push(args);
        if (args[0] === 'pr' && args[1] === 'create') {
          throw new Error('a pull request for branch already exists');
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return 'https://github.com/org/paraclete/pull/3';
        }
        return 'ok';
      },
    });
    assert.equal(updateRes.pushed, true);
    assert.equal(updateRes.created, false);
    assert.equal(updateRes.updated, true);
    assert.equal(updateRes.prUrl, 'https://github.com/org/paraclete/pull/3');
    assert.ok(seenGit.some((c) => c[0] === 'push' && c.includes('--force-with-lease')));
    assert.ok(seenGh.some((c) => c[0] === 'pr' && c[1] === 'edit'));
  });
});

describe('dev/harness2/promote.mjs: versioned promotions', () => {
  const NOW = new Date('2026-10-22T23:30:00Z');
  const CANDIDATE = {
    id: 'unit-organ-motor',
    lens: 'SYN',
    stage: 'stage1',
    touchedPaths: ['roles/software-engineer/prompts/motor.md'],
    scores: { capability: 0.995, reliability: 1.0, efficiency: 0.77, fitness: 0.96 },
  };
  const readiness = () =>
    evaluatePromotionReadiness({
      candidate: CANDIDATE,
      baselineScores: { capability: 0.36, reliability: 0.5, efficiency: 0.75, fitness: 0.45 },
      evidence: measuredEvidence(CANDIDATE),
    });

  it('the next version counts on from the newest version on the base branch or tagged', () => {
    assert.equal(nextPromotionVersion({ now: NOW }), 'v2026.10.22.1.1');
    // A day after the newest version starts at 1; the UTC date decides the day.
    assert.equal(nextPromotionVersion({ subjects: ['v2026.10.19.3.1: hardening'], tags: ['v2026.10.19.3.1'], now: NOW }), 'v2026.10.22.1.1');
    // The newest version's own day counts on, whatever the subindex; merge subjects are ignored.
    assert.equal(
      nextPromotionVersion({ subjects: ['Merge pull request #8 from a/b', 'v2026.10.22.2.3: x', 'v2026.10.21.9.1: y'], now: NOW }),
      'v2026.10.22.3.1',
    );
    // A tag newer than every subject counts; a tag that is not a version does not.
    assert.equal(nextPromotionVersion({ subjects: ['v2026.10.22.2.3: x'], tags: ['v2026.10.22.5.1', 'nightly'], now: NOW }), 'v2026.10.22.6.1');
    // A clock behind the newest version still yields a newer one.
    assert.equal(nextPromotionVersion({ subjects: ['v2026.10.23.4.2: later'], now: NOW }), 'v2026.10.23.5.1');
    // Months and days keep two digits.
    assert.equal(nextPromotionVersion({ now: new Date('2027-01-05T00:00:00Z') }), 'v2027.01.05.1.1');
  });

  it('fetches main and the tags, then commits and titles the pull request with a version newer than any there', () => {
    const gitCalls = [];
    const ghCalls = [];
    const res = pushAndCreatePullRequest({
      candidate: CANDIDATE,
      readiness: readiness(),
      branch: 'harness2/curriculum-unit-organ-motor',
      now: NOW,
      execGit: (args) => {
        gitCalls.push(args);
        if (args[0] === 'log') {
          assert.equal(args.at(-1), 'origin/main');
          return 'Merge pull request #8 from a/b\nv2026.10.22.1.1: make promotions releasable\nv2026.10.19.3.1: hardening';
        }
        if (args[0] === 'tag') return 'v2026.10.19.1.1\nv2026.10.19.3.1';
        return '';
      },
      execGh: (args) => {
        ghCalls.push(args);
        return 'https://github.com/example/paraclete/pull/9\n';
      },
    });
    assert.equal(res.pushed, true);
    assert.equal(res.version, 'v2026.10.22.2.1');
    assert.equal(res.title, 'v2026.10.22.2.1: paraclete-h2(SYN): promote unit-organ-motor (ΔS_cap=+0.5, n=3)', 'the measured gain and runs');
    assert.equal(versionFromText(res.title), res.version, 'dev/release.mjs reads the version from the subject');
    assert.ok(isNewer(res.version, 'v2026.10.22.1.1'));

    const order = gitCalls.map((c) => c[0]);
    assert.ok(order.indexOf('fetch') < order.indexOf('log'), 'versions are read after the fetch');
    assert.deepEqual(gitCalls.find((c) => c[0] === 'fetch'), ['fetch', '--quiet', '--tags', 'origin', 'main']);
    assert.deepEqual(gitCalls.find((c) => c[0] === 'commit'), ['commit', '--allow-empty', '-m', res.title]);

    const create = ghCalls.find((c) => c[1] === 'create');
    assert.equal(create[create.indexOf('--title') + 1], res.title);
    const body = create[create.indexOf('--body') + 1];
    assert.ok(body.includes('Squash and merge'));
    assert.ok(body.includes(promotionMergeNote(res.version)));
    const block = parseEvidenceBlock(body);
    assert.equal(block.schema, EVIDENCE_SCHEMA, 'the body carries the evidence block a merger can check');
    assert.equal(block.verdict.ok, true);
    assert.deepEqual(block.trials, { baseline: 3, candidate: 3 });
  });

  it('an updated pull request gets the fresh version in its title', () => {
    const ghCalls = [];
    const res = pushAndCreatePullRequest({
      candidate: CANDIDATE,
      readiness: readiness(),
      branch: 'harness2/curriculum-unit-organ-motor',
      now: NOW,
      execGit: (args) => (args[0] === 'log' ? 'v2026.10.22.3.1: another promotion' : ''),
      execGh: (args) => {
        ghCalls.push(args);
        if (args[1] === 'create') throw new Error('a pull request for branch already exists');
        return 'https://github.com/example/paraclete/pull/9';
      },
    });
    assert.equal(res.updated, true);
    assert.equal(res.version, 'v2026.10.22.4.1');
    const edit = ghCalls.find((c) => c[1] === 'edit');
    assert.equal(edit[edit.indexOf('--title') + 1], res.title);
  });

  it('a failed fetch stops the promotion before anything is committed', () => {
    const gitCalls = [];
    const res = pushAndCreatePullRequest({
      candidate: CANDIDATE,
      readiness: readiness(),
      now: NOW,
      execGit: (args) => {
        gitCalls.push(args);
        if (args[0] === 'fetch') throw new Error('could not read from remote repository');
        return '';
      },
      execGh: () => assert.fail('no pull request without a fetch'),
    });
    assert.equal(res.pushed, false);
    assert.equal(res.version, null);
    assert.match(res.reason, /could not read from remote/);
    assert.deepEqual(gitCalls.map((c) => c[0]), ['diff', 'fetch'], 'the lint reads the diff, then the fetch fails');
  });

  it('a dry run reads the versions of a real clone without fetching, from HEAD when there is no remote', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'h2-version-'));
    const gitConfig = join(scratch, 'gitconfig');
    writeFileSync(gitConfig, '[user]\n  name = test\n  email = test@example.com\n[commit]\n  gpgsign = false\n[tag]\n  gpgsign = false\n');
    const repo = join(scratch, 'repo');
    mkdirSync(repo);
    const calls = [];
    const git = (args) => {
      calls.push(args);
      return execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' },
      }).trim();
    };
    try {
      git(['init', '--quiet']);
      git(['commit', '--allow-empty', '-m', 'v2026.10.21.2.1: an older change']);
      git(['tag', 'v2026.10.21.2.1']);
      git(['commit', '--allow-empty', '-m', 'v2026.10.22.1.1: make promotions releasable']);
      calls.length = 0;

      const res = pushAndCreatePullRequest({
        candidate: CANDIDATE,
        readiness: readiness(),
        dryRun: true,
        now: NOW,
        execGit: git,
        execGh: () => assert.fail('a dry run opens no pull request'),
      });
      assert.equal(res.dryRun, true);
      assert.equal(res.version, 'v2026.10.22.2.1');
      assert.ok(res.title.startsWith('v2026.10.22.2.1: paraclete-h2(SYN): promote unit-organ-motor'));
      assert.ok(!calls.some((c) => ['fetch', 'checkout', 'commit', 'push'].includes(c[0])));
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('dev/harness2/evidence.mjs: a promotion carries measured evidence', () => {
  const CANDIDATE = { id: 'cand-1', lens: 'DOM', touchedPaths: ['roles/qa-engineer/prompts/cerebellum.md'] };

  it('a model-proposed change, measured three times on each side and clearly better, passes', () => {
    const evidence = measuredEvidence(CANDIDATE);
    assert.equal(evidence.schema, EVIDENCE_SCHEMA);
    assert.deepEqual(evidence.trials, { baseline: 3, candidate: 3 });
    assert.equal(evidence.capability.delta, 0.5);
    assert.ok(evidence.capability.noise > 0 && evidence.capability.noise < 0.05);
    assert.deepEqual(evidence.perTask.map((t) => [t.taskId, t.baseline.n, t.candidate.n]), [['task-a', 3, 3]]);
    assert.deepEqual(judgeEvidence(evidence), { ok: true, problems: [] });
  });

  it('each rule refuses on its own, naming why', () => {
    const problems = (evidence) => judgeEvidence(evidence).problems.join(' | ');
    assert.match(problems(measuredEvidence(CANDIDATE, { source: 'fallback' })), /came from 'fallback', not a model/);
    assert.match(problems(measuredEvidence(CANDIDATE, { source: 'template' })), /came from 'template'/);
    const unsourced = buildPromotionEvidence({ candidate: CANDIDATE, baselineTrajectories: [], candidateTrajectories: [] });
    assert.match(problems(unsourced), /came from 'unknown'/);
    assert.match(problems(unsourced), /no task was run/);
    assert.match(problems(measuredEvidence(CANDIDATE, { base: [0.4, 0.4], cand: [0.9, 0.9] })), /ran only 2 time\(s\)/);
    assert.match(problems(measuredEvidence(CANDIDATE, { base: [0.4, 0.4, 0.4], cand: [0.405, 0.405, 0.405] })), /below 0\.01/);
    assert.match(problems(measuredEvidence(CANDIDATE, { base: [0.2, 0.6, 0.4], cand: [0.3, 0.7, 0.5] })), /within run-to-run noise/);
    assert.equal(judgeEvidence(null).problems[0], 'no measured evidence');
    assert.match(judgeEvidence({ schema: 'other/9' }).problems[0], /is not paraclete-h2-evidence\/1/);

    // A task that got worse fails the promotion even when the average went up.
    const runs = (taskId, caps) => caps.map((capability, i) => ({ taskId, trial: i + 1, capability }));
    const mixed = buildPromotionEvidence({
      candidate: { ...CANDIDATE, proposal: { source: 'vertex' } },
      baselineTrajectories: [...runs('a', [0.2, 0.2, 0.2]), ...runs('b', [0.9, 0.9, 0.9])],
      candidateTrajectories: [...runs('a', [0.9, 0.9, 0.9]), ...runs('b', [0.7, 0.7, 0.7])],
    });
    assert.match(problems(mixed), /task b got worse: capability 0\.9 -> 0\.7/);

    // A task measured on one side only cannot be compared.
    const oneSided = buildPromotionEvidence({
      candidate: { ...CANDIDATE, proposal: { source: 'vertex' } },
      baselineTrajectories: runs('a', [0.2, 0.2, 0.2]),
      candidateTrajectories: [...runs('a', [0.9, 0.9, 0.9]), ...runs('new', [1, 1, 1])],
    });
    assert.match(problems(oneSided), /tasks run on one side only: new/);
  });

  it('the synthetic dry run measures nothing, however many trials ran', async () => {
    const tasks = selectBenchmarkTasks({ stage: 'stage1' }).slice(0, 2);
    const res = await runTier1Evaluation({ tasks, trials: 3 });
    assert.equal(res.trials, 3);
    assert.equal(res.trajectories.length, tasks.length * 3);
    assert.deepEqual([...new Set(res.trajectories.map((t) => t.trial))], [1, 2, 3]);
    assert.ok(res.trajectories.every((t) => t.synthetic === true && tasks.some((k) => k.id === t.taskId)));
    assert.ok(res.summary.perTrajectory.every((p) => p.taskId && p.synthetic === true));
    const evidence = buildPromotionEvidence({
      candidate: { ...CANDIDATE, proposal: { source: 'vertex' }, trajectories: res.trajectories },
      baselineTrajectories: res.trajectories,
    });
    assert.match(judgeEvidence(evidence).problems.join(' | '), /synthetic dry run/);
  });

  it('the report shows the evidence and carries a block that reads back; without evidence it says so', () => {
    const evidence = measuredEvidence(CANDIDATE);
    const md = formatEvidenceMarkdown(evidence);
    assert.match(md, /## Measured Evidence/);
    assert.match(md, /\| `task-a` \| 0\.4 ± 0\.02 \(n=3\) \| 0\.9 ± 0\.02 \(n=3\) \| 0\.5 \|/);
    assert.match(md, /\*\*Verdict\*\*: measured gain/);
    assert.deepEqual(parseEvidenceBlock(md), { ...evidence, verdict: { ok: true, problems: [] } });
    assert.equal(parseEvidenceBlock('no block here'), null);
    assert.equal(parseEvidenceBlock('```json paraclete-h2-evidence\n{ not json\n```'), null);

    const readiness = evaluatePromotionReadiness({
      candidate: { ...CANDIDATE, scores: { capability: 0.9, reliability: 1, efficiency: 0.8, fitness: 0.9 } },
      baselineScores: { capability: 0.4, reliability: 1, efficiency: 0.8, fitness: 0.6 },
    });
    assert.equal(readiness.evidence, null);
    assert.match(formatPromotionReport(readiness), /- None: this candidate was not measured against the baseline/);
  });

  it('a live candidate records whether a model or the template proposed it', async () => {
    const spec = { lens: 'DOM', escalationMode: 'focused', allowedComponents: ['c5_role_overlays'], priorAttemptsSummary: [] };
    const fromModel = await createLiveProposeAndApply({
      applyMutation: async () => ({ touchedPaths: [], source: 'vertex', hypothesis: 'tighten the verifier' }),
    })(spec, { id: 'gen0' });
    assert.deepEqual(fromModel.proposal, { source: 'vertex', hypothesis: 'tighten the verifier' });
    const fromHook = await createLiveProposeAndApply({ applyMutation: async () => ({ touchedPaths: [] }) })(spec, { id: 'gen0' });
    assert.equal(fromHook.proposal.source, 'custom');
    const none = await createLiveProposeAndApply({})(spec, { id: 'gen0' });
    assert.equal(none.proposal.source, 'none');
    assert.equal(DEFAULT_EVIDENCE_RULES.refusedSources.includes('none'), true);
  });
});

describe('dev/harness2/proposer.mjs: model proposals, why they fall back, and what is not evaluated', () => {
  const OVERLAY = 'roles/paraclete-h2/prompts/cortex.md';
  const domSpec = () => ({
    ...buildMutationProposalSpec({ lens: 'DOM', stage: 'stage1', role: 'paraclete-h2' }),
    targetMutablePath: OVERLAY,
  });
  const invSpec = () => buildMutationProposalSpec({ lens: 'INV', stage: 'stage1' });
  const noFallback = async () => ({ touchedPaths: [] });

  /** A workspace holding a role overlay (CRLF, as a Windows checkout has it) and a small contracts file. */
  function workspace() {
    const root = mkdtempSync(join(tmpdir(), 'h2-proposer-'));
    mkdirSync(join(root, 'roles', 'paraclete-h2', 'prompts'), { recursive: true });
    writeFileSync(join(root, OVERLAY), '# Overlay\r\n- Check the work.\r\n', 'utf8');
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'contracts.json'), '{\n  "organs": {\n    "max_steps": 25\n  }\n}\n', 'utf8');
    return root;
  }

  it('a generator that returns edits gives a vertex proposal, written into the workspace', async () => {
    const root = workspace();
    try {
      let seen = '';
      const res = await proposeVertexMutation({
        spec: domSpec(),
        baseState: { id: 'gen0' },
        targetRoot: root,
        fallback: () => assert.fail('no fallback'),
        vertexGenerate: async (prompt) => {
          seen = prompt;
          return '```json\n' + JSON.stringify({
            hypothesis: 'Quote the evidence for each check',
            edits: [{ path: OVERLAY, find: '- Check the work.', replace: '- Check the work.\n- Quote the evidence for each check.' }],
          }) + '\n```';
        },
      });
      assert.deepEqual(res, { touchedPaths: [OVERLAY], hypothesis: 'Quote the evidence for each check', source: 'vertex' });
      assert.equal(readFileSync(join(root, OVERLAY), 'utf8'), '# Overlay\r\n- Check the work.\r\n- Quote the evidence for each check.\r\n');
      // The request carries the lens, its rules, and the current text of the file it may change.
      assert.match(seen, /## Lens: DOM, Domain-Specific Role & Skill Craft Lens/);
      assert.match(seen, /Escalation: initial_targeted_patch/);
      assert.match(seen, /===== BEGIN roles\/paraclete-h2\/prompts\/cortex\.md =====\n# Overlay\n- Check the work\.\n===== END/);
      assert.match(seen, /c5_role_overlays: .*\(roles\/<role>\/prompts\/<organ>\.md\)/);

      // A full-file patch, the older answer form, works too.
      const patched = await proposeVertexMutation({
        spec: domSpec(),
        baseState: { id: 'gen0' },
        targetRoot: root,
        fallback: () => assert.fail('no fallback'),
        vertexGenerate: async () => ({ hypothesis: 'rewrite', patches: { [OVERLAY]: '# Overlay\n- New rule.\n' } }),
      });
      assert.equal(patched.source, 'vertex');
      assert.equal(readFileSync(join(root, OVERLAY), 'utf8'), '# Overlay\r\n- New rule.\r\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('INV is shown the contracts and may tune them, but never leave them invalid', async () => {
    const root = workspace();
    try {
      const { prompt, shownPaths } = buildProposalPrompt({ spec: invSpec(), targetRoot: root });
      assert.deepEqual(shownPaths, ['config/contracts.json'], 'the INV files this workspace has; not the role overlay');
      assert.match(prompt, /In config\/contracts\.json change only these keys: .*organs\.max_steps.*Bounds: .*organs\.max_steps 5\.\.60/);
      const res = await proposeVertexMutation({
        spec: invSpec(),
        baseState: { id: 'gen0' },
        targetRoot: root,
        fallback: noFallback,
        vertexGenerate: async () => ({ hypothesis: 'fewer steps', edits: [{ path: 'config/contracts.json', find: '"max_steps": 25', replace: '"max_steps": 22' }] }),
      });
      assert.equal(res.source, 'vertex');
      assert.equal(JSON.parse(readFileSync(join(root, 'config', 'contracts.json'), 'utf8')).organs.max_steps, 22);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a failing generator, or an unusable answer, falls back and says why, writing none of the answer', async () => {
    const root = workspace();
    const overlayBefore = readFileSync(join(root, OVERLAY), 'utf8');
    const fallbackFor = async (answer) =>
      proposeVertexMutation({
        spec: domSpec(),
        baseState: { id: 'gen0' },
        targetRoot: root,
        fallback: noFallback,
        vertexGenerate: typeof answer === 'function' ? answer : async () => answer,
      });
    try {
      const failed = await fallbackFor(async () => { throw new Error('callVertex HTTP 403: permission denied'); });
      assert.deepEqual(failed, {
        touchedPaths: [],
        hypothesis: 'DOM (initial_targeted_patch) live candidate',
        source: 'fallback',
        fallbackReason: 'callVertex HTTP 403: permission denied',
      });
      assert.match((await fallbackFor('I would tighten the overlay.')).fallbackReason, /not a JSON object: I would tighten/);
      assert.equal((await fallbackFor('{"hypothesis":"nothing to do","edits":[]}')).fallbackReason, 'the model proposed no change');
      assert.match((await fallbackFor({ edits: [{ path: OVERLAY, find: '- Not there.', replace: 'x' }] })).fallbackReason, /edit 1: its "find" text is not in roles\/paraclete-h2\/prompts\/cortex\.md/);
      assert.match((await fallbackFor({ edits: [{ path: 'config/contracts.json', find: '25', replace: '25,' }] })).fallbackReason, /leaves config\/contracts\.json invalid JSON/);
      // One bad part refuses the whole answer: the good edit before it is not written.
      const mixed = await fallbackFor({
        edits: [{ path: OVERLAY, find: '- Check the work.', replace: '- Changed.' }],
        patches: { 'agent/work/approvals.mjs': 'export {};\n' },
      });
      assert.match(mixed.fallbackReason, /patch agent\/work\/approvals\.mjs: .*immutable spine/);
      assert.equal(readFileSync(join(root, OVERLAY), 'utf8'), overlayBefore);
      assert.throws(() => readFileSync(join(root, 'agent', 'work', 'approvals.mjs')));

      // With no generator and no project, the reason names what is missing.
      const saved = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'PARACLETE_INSTANCE'].map((k) => [k, process.env[k]]);
      delete process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.GCLOUD_PROJECT;
      process.env.PARACLETE_INSTANCE = join(root, 'no-instance.json');
      try {
        assert.throws(() => createVertexProposalGenerator(), /no Google Cloud project for the model proposer/);
        const none = await proposeVertexMutation({ spec: domSpec(), baseState: { id: 'gen0' }, targetRoot: root, fallback: noFallback });
        assert.match(none.fallbackReason, /no Google Cloud project/);
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the default generator asks the strong Gemini model through the utility client, and reports its error', async () => {
    const model = loadContracts().vertex.models.strong.replace('vertex-google/', '');
    const calls = [];
    const generate = createVertexProposalGenerator({
      projectId: 'your-gcp-project',
      getAccessToken: async () => 'test-token',
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: '{"edits":[]}' }] } }] }) };
      },
    });
    assert.equal(await generate('THE REQUEST'), '{"edits":[]}');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`/projects/your-gcp-project/locations/global/publishers/google/models/${model}:generateContent$`));
    assert.equal(calls[0].auth, 'Bearer test-token');
    assert.match(calls[0].body.contents[0].parts[0].text, /THE REQUEST/);

    const refused = createVertexProposalGenerator({
      projectId: 'your-gcp-project',
      getAccessToken: async () => 'test-token',
      fetch: async () => ({ ok: false, status: 429, text: async () => 'Resource exhausted' }),
    });
    await assert.rejects(refused('x'), new RegExp(`${model} returned no proposal: callVertex HTTP 429: Resource exhausted`));
  });

  it('a template or no-change proposal is recorded but never validated or evaluated', async () => {
    const parentState = { id: 'parent', scores: { capability: 0.5, reliability: 1, efficiency: 0.5, fitness: 0.5 }, trajectories: [] };
    const proposals = [
      { proposal: { source: 'fallback', hypothesis: 'h1', fallbackReason: 'callVertex HTTP 403' }, touchedPaths: [OVERLAY] },
      { proposal: { source: 'template', hypothesis: 'h2' }, touchedPaths: [OVERLAY] },
      { proposal: { source: 'vertex', hypothesis: 'h3' }, touchedPaths: [] },
      { proposal: { source: 'vertex', hypothesis: 'h4' }, touchedPaths: [OVERLAY] },
    ];
    const evaluated = [];
    const res = await runWithinGenerationRecursion({
      lens: 'DOM',
      parentState,
      maxSteps: proposals.length,
      proposeAndApply: async (spec) => ({ id: `cand-${spec.priorAttemptsSummary.length + 1}`, ...proposals[spec.priorAttemptsSummary.length] }),
      validateCandidate: (cand) => {
        assert.equal(cand.id, 'cand-4', 'only the model proposal that changed something is validated');
        return { ok: true, violations: [] };
      },
      evaluateCandidate: async (cand) => {
        evaluated.push(cand.id);
        return { summary: { capability: 0.6, reliability: 1, efficiency: 0.5, fitness: 0.6 }, trajectories: [] };
      },
    });
    assert.deepEqual(evaluated, ['cand-4']);
    assert.deepEqual(res.history.map((h) => [h.candidateId, h.evaluated, h.revertReason]), [
      ['cand-1', false, 'not_evaluated: the model proposal fell back to the template: callVertex HTTP 403'],
      ['cand-2', false, "not_evaluated: a 'template' change is never promoted"],
      ['cand-3', false, 'not_evaluated: the proposal changed nothing'],
      ['cand-4', true, null],
    ]);
    assert.equal(res.bestCandidate.id, 'cand-4');
  });

  it('a live run whose model never answers evaluates only the baseline, and its output says why', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'h2-proposer-evo-'));
    try {
      let evaluations = 0;
      const evo = await runEvolutionLoop({
        stage: 'stage1',
        generations: 1,
        recursionSteps: 2,
        archivePath: join(tmp, 'archive.json'),
        proposeAndApply: createLiveProposeAndApply({
          repoRoot: tmp,
          stage: 'stage1',
          useVertex: true,
          vertexGenerate: async () => { throw new Error('callVertex failed: fetch failed'); },
        }),
        validateCandidate: () => assert.fail('a fallback is not validated'),
        evaluateCandidate: async () => {
          evaluations += 1;
          return { summary: { capability: 0.5, reliability: 1, efficiency: 0.5, fitness: 0.5 }, trajectories: [] };
        },
      });
      assert.equal(evaluations, 1, 'the baseline only');
      assert.equal(evo.winner.id, 'gen0-baseline');
      assert.deepEqual(evo.attempts.map((a) => [a.generation, a.lens, a.step, a.evaluated]), [[1, 'INV', 1, false], [1, 'INV', 2, false], [1, 'DOM', 1, false], [1, 'DOM', 2, false]]);
      for (const a of evo.attempts) {
        assert.equal(a.proposal.source, 'fallback');
        assert.equal(a.proposal.fallbackReason, 'callVertex failed: fetch failed');
        assert.match(a.revertReason, /^not_evaluated: the model proposal fell back to the template: callVertex failed/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('dev/harness2/validate.mjs: the lint on text a promotion adds to product prompts', () => {
  const DIFF = [
    'diff --git a/prompts/temporal-memory.md b/prompts/temporal-memory.md',
    '--- a/prompts/temporal-memory.md',
    '+++ b/prompts/temporal-memory.md',
    '@@ -87,0 +88,3 @@',
    '+## Artifact Protocol',
    '+- Verify every required output artifact on disk before reporting completion.',
    '+- Preserve immutable spine boundaries.',
    'diff --git a/roles/qa-engineer/prompts/cortex.md b/roles/qa-engineer/prompts/cortex.md',
    '--- a/roles/qa-engineer/prompts/cortex.md',
    '+++ b/roles/qa-engineer/prompts/cortex.md',
    '@@ -10,0 +11,3 @@',
    '+## Artifact Protocol',
    '+- Verify every required output artifact on disk before reporting completion.',
    '+- Preserve immutable spine boundaries.',
    'diff --git a/roles/paraclete-h2/prompts/cortex.md b/roles/paraclete-h2/prompts/cortex.md',
    '--- a/roles/paraclete-h2/prompts/cortex.md',
    '+++ b/roles/paraclete-h2/prompts/cortex.md',
    '@@ -3,0 +4,1 @@',
    '+Never mutate immutable spine modules; enforce Tier-1 validation.',
  ].join('\n');

  it('reads the added lines per file from a diff', () => {
    const added = addedLinesFromDiff(DIFF);
    assert.deepEqual(Object.keys(added), ['prompts/temporal-memory.md', 'roles/qa-engineer/prompts/cortex.md', 'roles/paraclete-h2/prompts/cortex.md']);
    assert.equal(added['prompts/temporal-memory.md'].length, 3);
    assert.deepEqual(addedLinesFromDiff(''), {});
  });

  it('refuses harness vocabulary and one block pasted into several prompts, but not in the harness role', () => {
    const problems = promptAdditionProblems(addedLinesFromDiff(DIFF));
    assert.equal(problems.filter((p) => /harness vocabulary/.test(p)).length, 2, 'base and qa prompts; paraclete-h2 is the harness');
    assert.ok(problems.some((p) => /prompts\/temporal-memory\.md adds harness vocabulary .*immutable spine/i.test(p)));
    assert.ok(problems.some((p) => /the same added block appears in prompts\/temporal-memory\.md, roles\/qa-engineer\/prompts\/cortex\.md/.test(p)));
    // A change written for one prompt, and one-line additions, pass.
    assert.deepEqual(promptAdditionProblems({
      'roles/qa-engineer/prompts/cerebellum.md': ['- A flaky test is reported as flaky, never as passing.', '- Quote the failing assertion.'],
      'prompts/motor.md': ['- Quote the failing assertion.'],
      'skills/files/SKILL.md': ['Mention the Tier-1 gate here, outside a prompt.'],
    }), []);
  });

  it('the pull request gate refuses without evidence, with failing evidence, or with a failing lint, before any git write', () => {
    const candidate = { id: 'cand-1', lens: 'DOM', stage: 'stage2', touchedPaths: ['prompts/temporal-memory.md'], scores: { capability: 0.9, reliability: 1, efficiency: 0.8, fitness: 0.9 } };
    const baselineScores = { capability: 0.4, reliability: 1, efficiency: 0.8, fitness: 0.6 };
    const attempt = (evidence, diff = '') => {
      const calls = [];
      const res = pushAndCreatePullRequest({
        candidate,
        readiness: evaluatePromotionReadiness({ candidate, baselineScores, evidence }),
        execGit: (args) => { calls.push(args[0]); return args[0] === 'diff' ? diff : ''; },
        execGh: () => assert.fail('no pull request'),
      });
      assert.ok(!calls.some((c) => ['fetch', 'checkout', 'add', 'commit', 'push'].includes(c)), calls.join(' '));
      return res;
    };
    assert.match(attempt(undefined).reason, /^Not promoted: no measured evidence/);
    assert.match(attempt(measuredEvidence(candidate, { source: 'fallback' })).reason, /^Not promoted: the change came from 'fallback'/);
    assert.match(attempt(measuredEvidence(candidate), DIFF).reason, /^Not promoted: .*harness vocabulary/);
  });
});

