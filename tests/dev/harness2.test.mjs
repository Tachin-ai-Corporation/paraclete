// tests/dev/harness2.test.mjs: Unit tests for the Paraclete-H² continual harness improvement system.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
  manageLabFollowMain,
  proposeVertexMutation,
  provisionGcpLab,
} from '../../dev/harness2/live-runner.mjs';
import {
  FOLLOW_MAIN,
  decodeFollowMainRemoteCommand,
  followMainCommandFor,
  followMainInstallScript,
  followMainRemoteCommand,
  followMainScript,
  followMainUninstallScript,
  followMainUnits,
  parseFollowMainOutput,
  parseIntervalMinutes,
} from '../../dev/harness2/lab-updater.mjs';
import { sshArgs } from '../../dev/dev-env.mjs';
import { bash as bashProgram, needsBash } from '../install/harness.mjs';
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
  it('defines the 7-component Paraclete mutable surface and stage role sets', () => {
    assert.deepEqual(Object.keys(PARACLETE_SURFACE), [
      'c1_contracts',
      'c2_base_prompts',
      'c3_cerebellum_verifier',
      'c4_memory_consolidation',
      'c5_role_overlays',
      'c6_skill_playbooks',
      'c7_role_manifests',
    ]);
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
    assert.equal(classifySurfacePath('skills/drive/SKILL.md').component, 'c6_skill_playbooks');
    assert.equal(classifySurfacePath('skills/drive/skill.json').component, 'c6_skill_playbooks');
    assert.equal(classifySurfacePath('skills/memory-consolidate/skill.json').component, 'c4_memory_consolidation');
    assert.equal(classifySurfacePath('roles/security-engineer/skills/iam-audit/SKILL.md', { stage: 'stage2' }).component, 'c6_skill_playbooks');
    assert.equal(classifySurfacePath('roles/security-engineer/responsibilities.json', { stage: 'stage2' }).component, 'c7_role_manifests');
    assert.equal(classifySurfacePath('roles/security-engineer/README.md', { stage: 'stage2' }).component, 'c7_role_manifests');

    // Immutable spine rejections
    assert.equal(classifySurfacePath('agent/services/brain/envelope-runner.mjs').allowed, false);
    assert.equal(classifySurfacePath('agent/work/checkpoint-spine.mjs').allowed, false);
    assert.equal(classifySurfacePath('tests/run.mjs').allowed, false);
    assert.equal(classifySurfacePath('prompts/new-invented-organ.md').allowed, false);
  });

  it('refuses a role.json in every role and stage, since it holds the role\'s grants', () => {
    for (const [relPath, opts] of [
      ['roles/security-engineer/role.json', { stage: 'stage2' }],
      ['roles/security-engineer/role.json', { stage: 'stage2', allowNewRoles: true }],
      ['roles/paraclete-h2/role.json', { stage: 'stage1' }],
      ['roles/finops-analyst/role.json', { stage: 'stage2', allowNewRoles: true }],
    ]) {
      const res = classifySurfacePath(relPath, opts);
      assert.equal(res.allowed, false, relPath);
      assert.equal(res.component, null);
      assert.match(res.reason, /grants \(gcp_roles, resource_roles, apis\)/);
    }
  });

  it('refuses a skill\'s command code, base or role-scoped, while its SKILL.md and skill.json stay on the surface', () => {
    for (const [relPath, opts] of [
      ['skills/drive/drive-get.mjs', {}],
      ['skills/memory-consolidate/core-memory-write.mjs', {}],
      ['roles/security-engineer/skills/iam-audit/iam-scan.mjs', { stage: 'stage2' }],
      ['roles/paraclete-h2/skills/harness-evolution/harness-cycle.mjs', { stage: 'stage1' }],
    ]) {
      const res = classifySurfacePath(relPath, opts);
      assert.equal(res.allowed, false, relPath);
      assert.match(res.reason, /executable code is outside the mutable surface/);
    }
  });

  it('refuses the shell tool\'s files: c8 is gone and the gateway\'s tools are on the immutable spine', () => {
    const shellExec = classifySurfacePath('agent/gateway/shell-exec.mjs');
    assert.equal(shellExec.allowed, false);
    assert.match(shellExec.reason, /outside the Paraclete evolvable surface \(c1\.\.c7\)/);
    const tools = classifySurfacePath('agent/gateway/tools.mjs');
    assert.equal(tools.allowed, false);
    assert.match(tools.reason, /immutable spine/);
  });

  it('names no executable file, no role.json and no wildcard in any component\'s patterns', () => {
    for (const comp of Object.values(PARACLETE_SURFACE)) {
      for (const pattern of comp.patterns) {
        assert.doesNotMatch(pattern, /\.mjs$|role\.json$|\*/, `${comp.id}: ${pattern}`);
      }
    }
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

  it('refuses a candidate that touches a role.json or a skill command, and promotion readiness says so', () => {
    const touchedPaths = [
      'roles/security-engineer/prompts/cortex.md',
      'roles/security-engineer/role.json',
      'skills/drive/drive-put.mjs',
    ];
    const res = validateTouchedPaths(touchedPaths, { stage: 'stage2', allowNewRoles: true });
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 2);
    assert.match(res.violations[0], /^roles\/security-engineer\/role\.json: .*grants/);
    assert.match(res.violations[1], /^skills\/drive\/drive-put\.mjs: .*executable code/);

    const readiness = evaluatePromotionReadiness({
      candidate: {
        id: 'grant-widening',
        stage: 'stage2',
        touchedPaths,
        scores: { capability: 0.99, reliability: 1, efficiency: 0.8, fitness: 0.95 },
      },
      baselineScores: { capability: 0.5, reliability: 0.5, efficiency: 0.5, fitness: 0.5 },
    });
    assert.equal(readiness.ready, false);
    assert.ok(readiness.reasons.some((r) => /role\.json: .*grants/.test(r)));
    assert.ok(readiness.reasons.some((r) => /drive-put\.mjs: .*executable code/.test(r)));
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

  it('scopes each lens to components on the surface and hands the proposer their path patterns', () => {
    const allowed = [...MUTATION_LENSES.INV.allowedComponents, ...MUTATION_LENSES.DOM.allowedComponents];
    assert.deepEqual(allowed.sort(), Object.keys(PARACLETE_SURFACE).sort());
    for (const lens of ['INV', 'DOM']) {
      const spec = buildMutationProposalSpec({ lens });
      for (const detail of spec.allowedSurfaceDetails) {
        assert.deepEqual(detail.paths, PARACLETE_SURFACE[detail.id].patterns);
        assert.ok(detail.paths.length > 0, detail.id);
      }
    }
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
      if (args[0] === 'compute' && args[1] === 'ssh') {
        // The follow-main install step and status probe (lab-updater.mjs); their own tests are below.
        return 'lab-follow-main.installed=changed\nlab-follow-main.timer_enabled=enabled\nlab-follow-main.timer_active=active';
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

    // allowNewRoles admits a brand-new role directory's playbooks, never its role.json (its grants)
    assert.equal(
      validateTouchedPaths(['roles/finops-analyst/README.md'], { stage: 'stage1', allowNewRoles: false }).ok,
      false,
    );
    assert.equal(
      validateTouchedPaths(['roles/finops-analyst/README.md', 'roles/finops-analyst/prompts/cortex.md'], {
        stage: 'stage1',
        allowNewRoles: true,
      }).ok,
      true,
    );
    const newRole = validateTouchedPaths(roleScaffold.touchedPaths, { stage: 'stage1', allowNewRoles: true });
    assert.deepEqual(newRole.violations.map((v) => v.split(':')[0]), ['roles/finops-analyst/role.json']);

    // A scaffolded skill's playbook and manifest are promotable; its command stub is not
    const newSkill = validateTouchedPaths(skillScaffold.touchedPaths, { stage: 'stage2', allowNewRoles: true });
    assert.deepEqual(newSkill.violations.map((v) => v.split(':')[0]), [
      'roles/site-reliability-engineer/skills/log-correlation/log-correlation-cli.mjs',
    ]);
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
        materializeCurriculumArtifacts(wsEvo, unit);

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
        materializeCurriculumArtifacts(ws, dynUnit);
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

    // 3b. A role.json conflict is refused rather than merged with the PR's grants on top
    const roleJsonReject = resolveHarnessMergeConflict({
      relPath: 'roles/security-engineer/role.json',
      baseContent: JSON.stringify({ id: 'security-engineer', gcp_roles: ['roles/iam.securityReviewer'] }),
      headContent: JSON.stringify({ id: 'security-engineer', gcp_roles: ['roles/owner'] }),
    });
    assert.equal(roleJsonReject.resolved, false);
    assert.equal(roleJsonReject.mergedText, undefined);
    assert.match(roleJsonReject.reason, /grants/);

    // 3c. A skill command conflict is refused rather than resolved to the PR's code
    const commandReject = resolveHarnessMergeConflict({
      relPath: 'roles/paraclete-h2/skills/harness-evolution/harness-cycle.mjs',
      baseContent: '// main',
      headContent: '// pr',
      stage: 'stage1',
    });
    assert.equal(commandReject.resolved, false);
    assert.equal(commandReject.mergedText, undefined);
    assert.match(commandReject.reason, /executable code/);

    // 3d. A skill manifest stays on the surface and still merges
    const skillJsonConflict = resolveHarnessMergeConflict({
      relPath: 'skills/drive/skill.json',
      baseContent: JSON.stringify({ id: 'drive', when_to_use: 'base' }),
      headContent: JSON.stringify({ id: 'drive', when_to_use: 'head' }),
    });
    assert.equal(skillJsonConflict.resolved, true);
    assert.equal(skillJsonConflict.component, 'c6_skill_playbooks');
    assert.equal(JSON.parse(skillJsonConflict.mergedText).when_to_use, 'head');

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

  it('runs the scripted in-process gateway answered measure nothing, and the evidence says so', () => {
    const runs = (caps, scripted) => caps.map((capability, i) => ({ taskId: 'task-a', trial: i + 1, capability, scripted }));
    const evidence = buildPromotionEvidence({
      candidate: { ...CANDIDATE, proposal: { source: 'vertex' } },
      baselineTrajectories: runs([0.4, 0.42, 0.38], true),
      candidateTrajectories: runs([0.9, 0.92, 0.88], true),
    });
    assert.equal(evidence.scripted, true);
    const { ok, problems } = judgeEvidence(evidence);
    assert.equal(ok, false);
    assert.equal(problems.length, 1, problems.join(' | '));
    assert.match(problems[0], /scripted in-process gateway, which gives every harness the same answers/);
    assert.match(formatEvidenceMarkdown(evidence), /\*\*Runs per task\*\*: baseline 3, candidate 3 \(scripted in-process gateway\)/);
    // Runs a model answered carry no mark and are judged on their numbers.
    assert.equal(measuredEvidence(CANDIDATE).scripted, false);
  });

  it('in-process, a candidate that changed a prompt scores exactly as the baseline, and every run is marked scripted', async () => {
    const task = getCurriculumUnitById('unit-role-security-engineer').task;
    const overlay = `roles/${task.role}/prompts/cerebellum.md`;
    const judge = { useFrontierJudge: true, judgeOptions: { mode: 'heuristic' } };
    // The candidate's worktree, where createIsolatedWorktree would put it; git itself is faked.
    const wt = join(tmpdir(), 'paraclete-h2-scripted-gen0-dom-1');
    rmSync(wt, { recursive: true, force: true });
    try {
      for (const dir of ['config', 'prompts', join('roles', task.role, 'prompts')]) cpSync(dir, join(wt, dir), { recursive: true });
      const candidate = await createLiveProposeAndApply({
        stage: 'stage2',
        useWorktree: true,
        execGit: () => '',
        ...judge,
        applyMutation: async ({ targetRoot }) => {
          const abs = join(targetRoot, overlay);
          writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n- Quote the evidence for every finding.\n`);
          return { touchedPaths: [overlay], source: 'vertex', hypothesis: 'quote the evidence' };
        },
      })({ lens: 'DOM', escalationMode: 'initial_targeted_patch', allowedComponents: ['c5_role_overlays'], priorAttemptsSummary: [] }, { id: 'scripted-gen0' });
      assert.deepEqual(candidate.touchedPaths, [overlay]);

      const candEval = await runTier1Evaluation({ tasks: [task], runTaskRollout: candidate.runTaskRollout });
      const baseEval = await evaluateLiveTarget({ tasks: [task], role: task.role, ...judge });
      const score = (res) => res.summary.perTrajectory.map((p) => [p.capability, p.scripted]);
      assert.ok(baseEval.summary.capability < 1, 'the judge scored the run, so equal scores mean something');
      assert.deepEqual(score(candEval), score(baseEval));
      assert.deepEqual(score(baseEval).map(([, scripted]) => scripted), [true]);

      const evidence = buildPromotionEvidence({
        candidate: { ...candidate, trajectories: candEval.trajectories },
        baselineTrajectories: baseEval.trajectories,
      });
      assert.equal(evidence.capability.delta, 0);
      assert.match(judgeEvidence(evidence).problems.join(' | '), /scripted in-process gateway/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
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

describe('dev/harness2/lab-updater.mjs and lab-follow-main.sh: the lab VMs follow main (lab only)', () => {
  const DRIVER = { name: 'paraclete-h2-driver', harnessCheckout: FOLLOW_MAIN.harnessCheckout };
  const CANARY = { name: 'paraclete-h2-canary', harnessCheckout: null };
  const REPO = 'your-org/paraclete';
  const OLD = '1'.repeat(40);
  const NEW = '2'.repeat(40);
  const TOKEN = 'lab-secret-token-0000';
  const UPDATER = fileURLToPath(new URL('../../dev/harness2/lab-follow-main.sh', import.meta.url));
  const posix = (path) => path.replace(/\\/g, '/');
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const sandboxes = [];
  after(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  });

  /** Where a real program is, looked up before the shims go first on PATH. */
  const realProgram = (name) => (bashProgram ? spawnSync(bashProgram, ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim() : '');
  const REAL_GIT = realProgram('git');
  const REAL_STAT = realProgram('stat');

  /** Fake VM programs. Each logs to $FAKE_LOG and answers from FAKE_* variables; git runs for real except ls-remote. */
  const SHIMS = {
    git: String.raw`printf 'git %s\n' "$*" >> "$FAKE_LOG"
if [[ "$1" == ls-remote ]]; then
  if [[ -n "$FAKE_MAIN_HEAD" ]]; then printf '%s\trefs/heads/main\n' "$FAKE_MAIN_HEAD"; fi
  exit 0
fi
exec "$REAL_GIT" "$@"`,
    runuser: String.raw`[[ "$1" == -u && "$3" == -- ]] || { echo 'runuser: unexpected arguments' >&2; exit 64; }
printf 'runuser %s\n' "$2" >> "$FAKE_LOG"
shift 3
exec "$@"`,
    getent: String.raw`[[ "$1" == passwd && "$2" == paraclete ]] || exit 2
printf 'paraclete:x:999:999::%s:/usr/sbin/nologin\n' "$FAKE_HOME"`,
    stat: String.raw`if [[ "$1" == -c && "$2" == %U ]]; then printf '%s\n' "$FAKE_OWNER"; exit 0; fi
exec "$REAL_STAT" "$@"`,
    pgrep: String.raw`printf 'pgrep %s\n' "$*" >> "$FAKE_LOG"
if [[ -n "$FAKE_HARNESS_PID" ]]; then printf '%s\n' "$FAKE_HARNESS_PID"; exit 0; fi
exit 1`,
    flock: String.raw`for arg in "$@"; do if [[ -n "$FAKE_LOCKED" && "$arg" == "$FAKE_LOCKED" ]]; then exit 1; fi; done
exit 0`,
    curl: String.raw`printf 'curl %s\n' "$*" >> "$FAKE_LOG"
exit 22`,
    systemctl: String.raw`printf 'systemctl %s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  is-enabled) printf '%s\n' "$FAKE_TIMER_ENABLED" ;;
  is-active)
    unit="$2" quiet=0
    if [[ "$2" == --quiet ]]; then unit="$3" quiet=1; fi
    if [[ "$unit" == *.service ]]; then state="$FAKE_SERVICE_ACTIVE"; else state="$FAKE_TIMER_ACTIVE"; fi
    if (( !quiet )); then printf '%s\n' "$state"; fi
    [[ "$state" == active ]]; exit ;;
  show)
    if [[ "$2" == --property=LastTriggerUSec ]]; then printf '%s\n' "$FAKE_LAST_RUN"; else printf '%s\n' "$FAKE_RESULT"; fi ;;
esac
exit 0`,
    journalctl: String.raw`printf 'journalctl %s\n' "$*" >> "$FAKE_LOG"
printf '%s\n' "$FAKE_LAST_LINE"`,
  };

  /** The VM's install/upgrade.sh: records its arguments and, unless told to fail, installs the commit. */
  const FAKE_UPGRADE = String.raw`#!/usr/bin/env bash
printf 'upgrade %s\n' "$*" >> "$FAKE_LOG"
echo 'paraclete-upgrade: the fake upgrader ran'
if [[ "$FAKE_UPGRADE_STATUS" != 0 ]]; then exit "$FAKE_UPGRADE_STATUS"; fi
printf '{"repo":"%s","commit":"%s"}\n' "$4" "$2" > "$(dirname "$0")/../release.json"
`;

  /** A fake lab VM in a directory: the install root, the data root, /run, /var/log, and the shims. */
  function vmSandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'paraclete-lab-'));
    sandboxes.push(dir);
    const at = (rel = '') => posix(join(dir, rel));
    for (const sub of ['bin', 'opt/paraclete/install', 'var/lib/paraclete/services/brain', 'var/log', 'run', 'home']) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    for (const [name, body] of Object.entries(SHIMS)) {
      writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    }
    writeFileSync(join(dir, 'opt/paraclete/install/upgrade.sh'), FAKE_UPGRADE, { mode: 0o755 });
    writeFileSync(join(dir, 'calls.log'), '');
    const health = join(dir, 'var/lib/paraclete/services/brain/health.json');
    const busyFile = join(dir, 'var/lib/paraclete/lab-follow-main.busy-since');
    const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    const vm = {
      dir,
      at,
      calls,
      release(commit) {
        writeFileSync(join(dir, 'opt/paraclete/release.json'), JSON.stringify({ version: null, ref: commit, commit, repo: REPO }));
      },
      installed: () => JSON.parse(readFileSync(join(dir, 'opt/paraclete/release.json'), 'utf8')).commit,
      mission(id) {
        writeFileSync(health, JSON.stringify({ service: 'brain', runner: { active_mission: id, since: id ? new Date().toISOString() : null, missions_run: 2 } }));
      },
      busySince: () => (existsSync(busyFile) ? readFileSync(busyFile, 'utf8').trim() : null),
      setBusySince(secondsAgo) {
        writeFileSync(busyFile, `${nowSeconds() - secondsAgo}\n`);
      },
      env(extra = {}) {
        return {
          ...process.env,
          PATH: [join(dir, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter),
          MSYS_NO_PATHCONV: '1',
          T_SCRIPT: posix(UPDATER),
          T_ROOT: at(),
          REAL_GIT,
          REAL_STAT,
          FAKE_LOG: at('calls.log'),
          FAKE_HOME: at('home'),
          FAKE_OWNER: 'paraclete',
          FAKE_MAIN_HEAD: '',
          FAKE_HARNESS_PID: '',
          FAKE_LOCKED: '',
          FAKE_UPGRADE_STATUS: '0',
          FAKE_TIMER_ENABLED: 'enabled',
          FAKE_TIMER_ACTIVE: 'active',
          FAKE_SERVICE_ACTIVE: 'inactive',
          FAKE_LAST_RUN: '',
          FAKE_RESULT: 'success',
          FAKE_LAST_LINE: '',
          ...extra,
        };
      },
      /** Sources the updater, points its settings at this directory and runs main with args. */
      run(args = [], extra = {}) {
        const before = calls().length;
        const words = Object.fromEntries(args.map((arg, i) => [`T_ARG_${i}`, arg]));
        const snippet = [
          'source "$T_SCRIPT"',
          'INSTALL_ROOT="$T_ROOT/opt/paraclete"',
          'DATA_ROOT="$T_ROOT/var/lib/paraclete"',
          'LOCK_FILE="$T_ROOT/run/paraclete-lab-follow-main.lock"',
          'BOOTSTRAP_LOCK="$T_ROOT/run/paraclete-bootstrap.lock"',
          'UPGRADE_LOG="$T_ROOT/var/log/paraclete-lab-follow-main-upgrade.log"',
          `main ${args.map((_, i) => `"$T_ARG_${i}"`).join(' ')}`,
        ].join('; ');
        const r = spawnSync(bashProgram, ['-c', snippet, FOLLOW_MAIN.unit], { encoding: 'utf8', env: vm.env({ ...words, ...extra }) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, line: r.stdout.trim(), calls: calls().slice(before) };
      },
      /** Runs a root script (an install or uninstall script) from a file, as the VM's root would. */
      runScript(script, args = [], extra = {}) {
        const before = calls().length;
        const file = join(dir, `payload-${calls().length}-${Math.random().toString(36).slice(2)}.sh`);
        writeFileSync(file, script);
        const r = spawnSync(bashProgram, [posix(file), ...args], { encoding: 'utf8', env: vm.env(extra) });
        rmSync(file, { force: true });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, fields: parseFollowMainOutput(r.stdout), calls: calls().slice(before) };
      },
    };
    return vm;
  }

  function gitIn(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.name=Lab Test', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** One origin for every checkout: main at its second commit. Made once, read only by the runs. */
  let sharedOrigin = null;
  function origin() {
    if (sharedOrigin) return sharedOrigin;
    const dir = mkdtempSync(join(tmpdir(), 'paraclete-lab-origin-'));
    sandboxes.push(dir);
    const path = join(dir, 'origin.git');
    gitIn(dir, 'init', '--quiet', '--bare', '--initial-branch=main', path);
    const work = join(dir, 'work');
    gitIn(dir, 'clone', '--quiet', path, work);
    writeFileSync(join(work, 'README.md'), 'one\n');
    gitIn(work, 'add', 'README.md');
    gitIn(work, 'commit', '--quiet', '-m', 'one');
    const first = gitIn(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'README.md'), 'two\n');
    gitIn(work, 'commit', '--quiet', '-am', 'two');
    gitIn(work, 'push', '--quiet', 'origin', 'HEAD:main');
    sharedOrigin = { path, first, second: gitIn(work, 'rev-parse', 'HEAD') };
    return sharedOrigin;
  }

  /**
   * The driver's harness checkout in a VM sandbox: a clone of the shared origin, one commit behind its
   * main. With a token remote, origin's URL holds a token and git reaches the local origin through
   * url.<origin>.insteadOf, so nothing leaves the machine; unreachable points that at nothing.
   */
  function harnessCheckout(vm, { tokenRemote = false, unreachable = false } = {}) {
    const { path: originPath, first, second } = origin();
    const path = join(vm.dir, 'var/lib/paraclete/harness2-repo');
    gitIn(vm.dir, 'clone', '--quiet', '--branch', 'main', originPath, path);
    gitIn(path, 'reset', '--quiet', '--hard', first);
    if (tokenRemote || unreachable) {
      const url = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
      gitIn(path, 'remote', 'set-url', 'origin', url);
      const target = unreachable ? posix(join(vm.dir, `missing-${TOKEN}`)) : posix(originPath);
      gitIn(path, 'config', `url.${target}.insteadOf`, url);
    }
    return { path: posix(path), first, second, head: () => gitIn(path, 'rev-parse', 'HEAD') };
  }

  it('the timer runs the updater every --interval minutes as root, from a unit directory bootstrap.sh leaves alone', () => {
    const driver = followMainUnits({ intervalMinutes: 45, harnessCheckout: FOLLOW_MAIN.harnessCheckout });
    assert.match(driver.timer, /^OnActiveSec=45min$/m);
    assert.match(driver.timer, /^OnUnitActiveSec=45min$/m);
    assert.match(driver.timer, /^WantedBy=timers\.target$/m);
    assert.match(driver.service, /^Type=oneshot$/m);
    assert.match(driver.service, /^ExecStart=\/usr\/local\/sbin\/paraclete-lab-follow-main --harness-checkout \/var\/lib\/paraclete\/harness2-repo$/m);
    assert.match(driver.service, /^TimeoutStartSec=infinity$/m, 'an upgrade is never cut off halfway');
    assert.doesNotMatch(driver.service, /^User=/m, 'root runs it: upgrade.sh needs root');
    assert.match(driver.service, /lab only|harness lab VM only/);

    const canary = followMainUnits({ harnessCheckout: null });
    assert.match(canary.timer, /^OnActiveSec=30min$/m, 'every 30 minutes by default');
    assert.match(canary.service, /^ExecStart=\/usr\/local\/sbin\/paraclete-lab-follow-main$/m, 'the canary has no harness checkout');

    assert.equal(parseIntervalMinutes(undefined), 30);
    assert.equal(parseIntervalMinutes('15'), 15);
    for (const bad of ['0', '4', '1441', 'abc', '1.5', true, '-5', '']) {
      assert.throws(() => parseIntervalMinutes(bad), /--interval must be/, JSON.stringify(bad));
    }
    assert.throws(() => followMainUnits({ harnessCheckout: 'relative/path' }), /absolute path/);

    // bootstrap.sh stops and removes every /etc/systemd/system/paraclete-*.service it did not ship.
    const install = followMainInstallScript({ harnessCheckout: FOLLOW_MAIN.harnessCheckout });
    assert.equal(FOLLOW_MAIN.unitDir, '/usr/local/lib/systemd/system');
    assert.doesNotMatch(install, /\/etc\/systemd\/system/);
    assert.ok(install.includes(`"$ROOT/usr/local/lib/systemd/system/paraclete-lab-follow-main.service"`));
    assert.ok(install.includes(`"$ROOT/usr/local/sbin/paraclete-lab-follow-main"`));
    assert.ok(install.includes(followMainScript()), 'the install script carries the updater as it is in the repo');
  });

  it('the updater skips a busy agent for 24 hours, guards the checkout, and never prints a remote or a credential', () => {
    const script = followMainScript();
    assert.match(script, /^#!\/usr\/bin\/env bash\n# dev\/harness2\/lab-follow-main\.sh: /, 'a header comment says what it is');
    assert.match(script, /Lab only/);
    // The idle check: the brain's health file and its runner's mission.
    assert.match(script, /\$DATA_ROOT\/services\/brain\/health\.json/);
    assert.match(script, /h\.runner && h\.runner\.active_mission/);
    // The 24-hour override, counted from the first skip.
    assert.match(script, /^BUSY_LIMIT_SECONDS=\$\(\(24 \* 60 \* 60\)\)$/m);
    assert.match(script, /lab-follow-main\.busy-since/);
    assert.match(script, /now - since < BUSY_LIMIT_SECONDS/);
    // The clean-checkout guard, as the checkout's owner, and a fast-forward only.
    assert.match(script, /runuser -u "\$HARNESS_USER" --/);
    assert.match(script, /status --porcelain/);
    assert.match(script, /symbolic-ref --quiet --short HEAD/);
    assert.match(script, /merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/);
    assert.match(script, /merge --ff-only/);
    assert.match(script, /pgrep -f -- "\$HARNESS_PATTERN"/);
    assert.ok(/^HARNESS_PATTERN='([^']*)'$/m.exec(script)[1].includes('dev/harness2'));
    for (const never of [/\breset\b/, /\bstash\b/, /checkout -B/, /\bclean -/, /\bpush\b/]) {
      assert.doesNotMatch(script.replace(/^#.*$/gm, ''), never, `the updater never runs git ${never}`);
    }
    // Main's head and the upgrade.
    assert.match(script, /git ls-remote "https:\/\/github\.com\/\$1" refs\/heads\/main/);
    assert.match(script, /"\$INSTALL_ROOT\/install\/upgrade\.sh" --ref "\$MAIN_HEAD" --repo "\$REPO"/);
    assert.match(script, /^BOOTSTRAP_LOCK=\/run\/paraclete-bootstrap\.lock$/m);
    // No remote URL or git output reaches the journal.
    for (const never of [/remote -v/, /get-url/, /remote\.origin\.url/, /config --get/]) assert.doesNotMatch(script, never);
    assert.match(script, /fetch --quiet --tags origin '\+refs\/heads\/main:refs\/remotes\/origin\/main' > \/dev\/null 2>&1/);
    assert.match(script, /merge --ff-only --quiet refs\/remotes\/origin\/main > \/dev\/null 2>&1/);
    assert.match(script, /GIT_TERMINAL_PROMPT=0/);
  });

  it('parses in bash', { skip: needsBash }, () => {
    const r = spawnSync(bashProgram, ['-n', posix(UPDATER)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const script of [followMainInstallScript({ harnessCheckout: FOLLOW_MAIN.harnessCheckout }), followMainUninstallScript()]) {
      const file = join(mkdtempSync(join(tmpdir(), 'paraclete-lab-parse-')), 'script.sh');
      sandboxes.push(dirname(file));
      writeFileSync(file, script);
      const p = spawnSync(bashProgram, ['-n', posix(file)], { encoding: 'utf8' });
      assert.equal(p.status, 0, p.stderr);
    }
  });

  describe('a run on a fake VM', { skip: needsBash }, () => {
    it('upgrades to main\'s head through upgrade.sh, then finds it current: one line each run', () => {
      const vm = vmSandbox();
      vm.release(OLD);
      vm.mission(null);
      const first = vm.run([], { FAKE_MAIN_HEAD: NEW });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.line.split('\n').length, 1, 'one line per run');
      assert.equal(first.line, `repo=${REPO} installed=${OLD.slice(0, 12)} head=${NEW.slice(0, 12)} agent=idle upgrade=upgraded checkout=none`);
      assert.ok(first.calls.includes(`git ls-remote https://github.com/${REPO} refs/heads/main`));
      assert.deepEqual(first.calls.filter((c) => c.startsWith('upgrade ')), [`upgrade --ref ${NEW} --repo ${REPO}`]);
      assert.equal(vm.installed(), NEW);
      assert.match(readFileSync(join(vm.dir, 'var/log/paraclete-lab-follow-main-upgrade.log'), 'utf8'), /the fake upgrader ran/);

      const second = vm.run([], { FAKE_MAIN_HEAD: NEW });
      assert.equal(second.status, 0);
      assert.match(second.line, /upgrade=current/);
      assert.equal(second.calls.filter((c) => c.startsWith('upgrade ')).length, 0, 'a second run upgrades nothing');
    });

    it('waits while a mission runs, and goes ahead once the first skip is 24 hours old', () => {
      const vm = vmSandbox();
      vm.release(OLD);
      vm.mission('mission-42');
      const skipped = vm.run([], { FAKE_MAIN_HEAD: NEW });
      assert.equal(skipped.status, 0);
      assert.match(skipped.line, /agent=busy:mission-42:waiting-0h upgrade=skipped:agent-busy/);
      assert.equal(skipped.calls.filter((c) => c.startsWith('upgrade ')).length, 0);
      const since = Number(vm.busySince());
      assert.ok(Math.abs(since - nowSeconds()) < 60, 'the first skip is recorded as a time');

      const again = vm.run([], { FAKE_MAIN_HEAD: NEW });
      assert.match(again.line, /upgrade=skipped:agent-busy/);
      assert.equal(Number(vm.busySince()), since, 'a later skip keeps the first one');

      vm.setBusySince(3 * 3600 + 60);
      assert.match(vm.run([], { FAKE_MAIN_HEAD: NEW }).line, /agent=busy:mission-42:waiting-3h upgrade=skipped:agent-busy/);
      assert.equal(vm.installed(), OLD);

      vm.setBusySince(25 * 3600);
      const override = vm.run([], { FAKE_MAIN_HEAD: NEW });
      assert.equal(override.status, 0, override.stderr);
      assert.match(override.line, /agent=busy:mission-42:over-24h upgrade=upgraded/);
      assert.equal(vm.installed(), NEW);
      assert.equal(vm.busySince(), null, 'an override that succeeded starts the next wait afresh');
    });

    it('an idle agent clears the record; a busy agent with nothing to do records nothing', () => {
      const vm = vmSandbox();
      vm.release(NEW);
      vm.mission('mission-7');
      const busyCurrent = vm.run([], { FAKE_MAIN_HEAD: NEW });
      assert.match(busyCurrent.line, /agent=busy:mission-7 upgrade=current/);
      assert.equal(vm.busySince(), null);

      vm.release(OLD);
      vm.setBusySince(3600);
      vm.mission(null);
      const idle = vm.run([], { FAKE_MAIN_HEAD: NEW });
      assert.match(idle.line, /agent=idle upgrade=upgraded/);
      assert.equal(vm.busySince(), null);
    });

    it('a mission id is printed only as safe characters', () => {
      const vm = vmSandbox();
      vm.release(OLD);
      vm.mission('m-1 $(reboot)\nx');
      assert.match(vm.run([], { FAKE_MAIN_HEAD: NEW }).line, /agent=busy:m-1reboot.?x:waiting-0h /);
    });

    it('leaves a running bootstrap alone, stops when another run holds the lock, and reports a failed upgrade', () => {
      const vm = vmSandbox();
      vm.release(OLD);
      vm.mission(null);
      const lock = vm.at('run/paraclete-bootstrap.lock');
      writeFileSync(lock, '');
      const bootstrapping = vm.run([], { FAKE_MAIN_HEAD: NEW, FAKE_LOCKED: lock });
      assert.equal(bootstrapping.status, 0);
      assert.match(bootstrapping.line, /upgrade=skipped:bootstrap-running/);
      assert.equal(vm.installed(), OLD);

      const locked = vm.run([], { FAKE_MAIN_HEAD: NEW, FAKE_LOCKED: '8' });
      assert.equal(locked.status, 0);
      assert.match(locked.line, /upgrade=skipped:another-run checkout=skipped:another-run$/);
      assert.equal(locked.calls.filter((c) => c.startsWith('git ')).length, 0, 'it looks nothing up');

      const failed = vm.run([], { FAKE_MAIN_HEAD: NEW, FAKE_UPGRADE_STATUS: '3' });
      assert.equal(failed.status, 1);
      assert.match(failed.line, /upgrade=failed:exit-3/);
      assert.equal(failed.line.split('\n').length, 1, "the upgrade's output stays in its log");

      const noHead = vm.run([], { FAKE_MAIN_HEAD: '' });
      assert.equal(noHead.status, 1);
      assert.match(noHead.line, /head=none .*upgrade=failed:ls-remote/);
    });

    it('fast-forwards a clean driver checkout of main as the paraclete user, through a token remote it never prints', () => {
      const vm = vmSandbox();
      const checkout = harnessCheckout(vm, { tokenRemote: true });
      vm.release(checkout.second);
      vm.mission(null);
      const r = vm.run(['--harness-checkout', checkout.path], { FAKE_MAIN_HEAD: checkout.second });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.line, new RegExp(`upgrade=current checkout=fast-forwarded:${checkout.first.slice(0, 12)}\\.\\.${checkout.second.slice(0, 12)}$`));
      assert.equal(checkout.head(), checkout.second);
      assert.ok(r.calls.includes('runuser paraclete'), 'git runs as the checkout\'s owner');
      assert.ok(r.calls.includes('pgrep -f -- dev/harness2|harness-(cycle|eval|promote)'));
      assert.ok(!`${r.stdout}${r.stderr}`.includes(TOKEN), 'the token never reaches the output');

      const again = vm.run(['--harness-checkout', checkout.path], { FAKE_MAIN_HEAD: checkout.second });
      assert.match(again.line, /checkout=current$/);
      assert.ok(!again.calls.some((c) => / fetch /.test(c)), 'a current checkout is not fetched');
    });

    it('never touches a dirty checkout, one off main, one with its own commits, or one a harness run is using', () => {
      const cases = [
        ['an edited file', (c) => writeFileSync(join(c.path, 'README.md'), 'local edit\n'), {}, 'skipped:uncommitted-changes'],
        ['an untracked file', (c) => writeFileSync(join(c.path, 'notes.txt'), 'x\n'), {}, 'skipped:uncommitted-changes'],
        ['another branch', (c) => gitIn(c.path, 'checkout', '--quiet', '-b', 'experiment'), {}, 'skipped:not-on-main'],
        ['a local commit', (c) => { writeFileSync(join(c.path, 'local.txt'), 'x\n'); gitIn(c.path, 'add', 'local.txt'); gitIn(c.path, 'commit', '--quiet', '-m', 'local'); }, {}, 'skipped:not-a-fast-forward'],
        ['a harness run', () => {}, { FAKE_HARNESS_PID: '4242' }, 'skipped:harness-running'],
        ['another owner', () => {}, { FAKE_OWNER: 'root' }, 'skipped:not-owned-by-paraclete'],
      ];
      for (const [what, arrange, env, state] of cases) {
        const vm = vmSandbox();
        const checkout = harnessCheckout(vm);
        arrange(checkout);
        const before = checkout.head();
        const dirtyBefore = gitIn(checkout.path, 'status', '--porcelain');
        vm.release(checkout.second);
        vm.mission(null);
        const r = vm.run(['--harness-checkout', checkout.path], { FAKE_MAIN_HEAD: checkout.second, ...env });
        assert.equal(r.status, 0, `${what}: ${r.stderr}`);
        assert.match(r.line, new RegExp(`checkout=${state.replace(/[()|]/g, '\\$&')}$`), what);
        assert.equal(checkout.head(), before, `${what}: HEAD is where it was`);
        assert.equal(gitIn(checkout.path, 'status', '--porcelain'), dirtyBefore, `${what}: the working tree is as it was`);
      }
    });

    it('a fetch that fails is reported by its exit code, without git\'s words', () => {
      const vm = vmSandbox();
      const checkout = harnessCheckout(vm, { unreachable: true });
      vm.release(checkout.second);
      vm.mission(null);
      const r = vm.run(['--harness-checkout', checkout.path], { FAKE_MAIN_HEAD: checkout.second });
      assert.equal(r.status, 1);
      assert.match(r.line, /checkout=failed:fetch-exit-\d+$/);
      assert.ok(!`${r.stdout}${r.stderr}`.includes(TOKEN), 'git\'s error, which names the remote, is not printed');
      assert.equal(checkout.head(), checkout.first);
    });

    it('--status reports the timer, the last run, both commits and the agent, and changes nothing', () => {
      const vm = vmSandbox();
      const checkout = harnessCheckout(vm);
      vm.release(OLD);
      vm.mission('mission-9');
      vm.setBusySince(7200);
      const since = vm.busySince();
      const r = vm.run(['--status', '--harness-checkout', checkout.path], {
        FAKE_MAIN_HEAD: NEW,
        FAKE_LAST_RUN: 'Fri 2026-10-23 10:00:00 UTC',
        FAKE_LAST_LINE: `repo=${REPO} installed=${OLD.slice(0, 12)} head=${NEW.slice(0, 12)} agent=busy:mission-9:waiting-2h upgrade=skipped:agent-busy checkout=current`,
      });
      assert.equal(r.status, 0, r.stderr);
      const fields = parseFollowMainOutput(r.stdout);
      assert.equal(fields.timer_enabled, 'enabled');
      assert.equal(fields.timer_active, 'active');
      assert.equal(fields.service_active, 'inactive');
      assert.equal(fields.last_run, 'Fri 2026-10-23 10:00:00 UTC');
      assert.match(fields.last_line, /upgrade=skipped:agent-busy/);
      assert.equal(fields.repo, REPO);
      assert.equal(fields.installed, OLD);
      assert.equal(fields.head, NEW);
      assert.equal(fields.agent, 'busy:mission-9');
      assert.equal(fields.busy_since, since);
      assert.equal(fields.checkout, checkout.first);
      assert.ok(r.calls.includes('journalctl --identifier=paraclete-lab-follow-main --lines=1 --output=cat --no-pager --quiet'));
      assert.equal(r.calls.filter((c) => c.startsWith('upgrade ') || / fetch /.test(c) || / merge /.test(c)).length, 0);
      assert.equal(vm.installed(), OLD);
      assert.equal(vm.busySince(), since);
      assert.equal(checkout.head(), checkout.first);
    });
  });

  describe('the install and uninstall scripts on a fake VM', { skip: needsBash }, () => {
    it('install writes the updater and units, enables the timer, and a second install changes nothing', () => {
      const vm = vmSandbox();
      const script = followMainInstallScript({ intervalMinutes: 15, harnessCheckout: FOLLOW_MAIN.harnessCheckout, root: vm.at() });
      const first = vm.runScript(script, [], { FAKE_TIMER_ACTIVE: 'inactive' });
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual(first.fields, { installed: 'changed', interval_minutes: '15', timer_enabled: 'enabled', timer_active: 'inactive' });
      const units = followMainUnits({ intervalMinutes: 15, harnessCheckout: FOLLOW_MAIN.harnessCheckout });
      assert.equal(readFileSync(join(vm.dir, 'usr/local/sbin/paraclete-lab-follow-main'), 'utf8'), followMainScript());
      assert.equal(readFileSync(join(vm.dir, 'usr/local/lib/systemd/system/paraclete-lab-follow-main.service'), 'utf8'), units.service);
      assert.equal(readFileSync(join(vm.dir, 'usr/local/lib/systemd/system/paraclete-lab-follow-main.timer'), 'utf8'), units.timer);
      const systemctl = (calls) => calls.filter((c) => c.startsWith('systemctl ') && !/ is-(active|enabled) /.test(c));
      assert.deepEqual(systemctl(first.calls), [
        'systemctl daemon-reload',
        'systemctl enable --quiet paraclete-lab-follow-main.timer',
        'systemctl restart paraclete-lab-follow-main.timer',
      ]);

      const second = vm.runScript(script);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.fields.installed, 'unchanged');
      assert.deepEqual(systemctl(second.calls), ['systemctl enable --quiet paraclete-lab-follow-main.timer'], 'no reload, no restart');

      const longer = vm.runScript(followMainInstallScript({ intervalMinutes: 60, harnessCheckout: FOLLOW_MAIN.harnessCheckout, root: vm.at() }));
      assert.equal(longer.fields.installed, 'changed');
      assert.ok(systemctl(longer.calls).includes('systemctl restart paraclete-lab-follow-main.timer'), 'a new interval takes effect');
      assert.match(readFileSync(join(vm.dir, 'usr/local/lib/systemd/system/paraclete-lab-follow-main.timer'), 'utf8'), /^OnUnitActiveSec=60min$/m);
    });

    it('uninstall removes everything it put there, never stops a run in progress, and is safe twice', () => {
      const vm = vmSandbox();
      vm.runScript(followMainInstallScript({ root: vm.at() }));
      writeFileSync(join(vm.dir, 'var/lib/paraclete/lab-follow-main.busy-since'), '1\n');
      writeFileSync(join(vm.dir, 'var/log/paraclete-lab-follow-main-upgrade.log'), 'log\n');
      const first = vm.runScript(followMainUninstallScript({ root: vm.at() }), [], { FAKE_SERVICE_ACTIVE: 'activating' });
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual(first.fields, { removed: 'yes', service_active: 'activating' });
      for (const rel of [
        'usr/local/sbin/paraclete-lab-follow-main',
        'usr/local/lib/systemd/system/paraclete-lab-follow-main.service',
        'usr/local/lib/systemd/system/paraclete-lab-follow-main.timer',
        'var/lib/paraclete/lab-follow-main.busy-since',
        'var/log/paraclete-lab-follow-main-upgrade.log',
      ]) {
        assert.equal(existsSync(join(vm.dir, rel)), false, rel);
      }
      assert.ok(first.calls.includes('systemctl disable --now --quiet paraclete-lab-follow-main.timer'));
      assert.ok(!first.calls.some((c) => /^systemctl (stop|kill).*\.service/.test(c)), 'a run in progress is left to finish');

      const second = vm.runScript(followMainUninstallScript({ root: vm.at() }));
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.fields.removed, 'no');
      assert.ok(!second.calls.includes('systemctl daemon-reload'));
    });
  });

  describe('lab-follow-main over IAP SSH', () => {
    /** A fake gcloud for the lab: records each call and answers `compute ssh` with answer(vm, decoded). */
    function fakeGcloud(answer) {
      const calls = [];
      const execGcloud = (args, opts) => {
        calls.push({ args, opts });
        if (args[0] === 'compute' && args[1] === 'ssh') {
          const decoded = decodeFollowMainRemoteCommand(args[args.indexOf('--command') + 1]);
          assert.ok(decoded, 'every remote command is one the lab updater built');
          return answer(args[2], decoded);
        }
        return '';
      };
      return { calls, execGcloud };
    }
    const INSTALLED_OUTPUT = 'lab-follow-main.installed=changed\nlab-follow-main.interval_minutes=30\nlab-follow-main.timer_enabled=enabled\nlab-follow-main.timer_active=active';

    it('the remote command is one line of safe characters that carries the script exactly', () => {
      const command = followMainRemoteCommand(followMainScript(), ['--status', '--harness-checkout', FOLLOW_MAIN.harnessCheckout]);
      assert.match(command, /^sudo bash -c "\$\(echo [A-Za-z0-9+/=]+ \| base64 -d \| gunzip\)" paraclete-lab-follow-main --status --harness-checkout \/var\/lib\/paraclete\/harness2-repo < \/dev\/null$/);
      assert.ok(command.length < 16_000, `${command.length} characters stay well inside a Windows command line`);
      assert.deepEqual(decodeFollowMainRemoteCommand(command), {
        script: followMainScript(),
        args: ['--status', '--harness-checkout', FOLLOW_MAIN.harnessCheckout],
      });
      assert.throws(() => followMainRemoteCommand('true', ['$(reboot)']), /unsafe argument/);
    });

    it('the remote command decodes and runs the updater in bash -c, as the VM\'s shell does', { skip: needsBash }, () => {
      const command = followMainRemoteCommand(followMainScript(), ['--help']);
      const r = spawnSync(bashProgram, ['-c', 'eval "${T_COMMAND#sudo }"'], { encoding: 'utf8', env: { ...process.env, T_COMMAND: command } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'Usage: paraclete-lab-follow-main [--harness-checkout <dir>] [--status]\n');
    });

    it('install, uninstall and status each run one command per lab VM, through dev-env.mjs sshArgs', () => {
      const plan = buildGcpLabPlan({ projectId: 'your-gcp-project', zone: 'us-central1-b' });
      assert.deepEqual(plan.vms.map((vm) => [vm.name, vm.harnessCheckout]), [[DRIVER.name, DRIVER.harnessCheckout], [CANARY.name, null]]);
      assert.ok(plan.commands.includes('node dev/harness2/cli.mjs lab-follow-main --install --interval 30 --project your-gcp-project --zone us-central1-b'));

      const expectedCommand = (action, vm, o) => sshArgs({ VM: vm.name, ZONE: 'us-central1-b', PROJECT_ID: 'your-gcp-project' }, followMainCommandFor(action, vm, o));

      const install = fakeGcloud(() => INSTALLED_OUTPUT);
      const installed = manageLabFollowMain({ action: 'install', projectId: 'your-gcp-project', zone: 'us-central1-b', intervalMinutes: '20', execGcloud: install.execGcloud });
      assert.equal(installed.ok, true);
      assert.equal(installed.intervalMinutes, 20);
      assert.deepEqual(install.calls.map((c) => c.args), [
        expectedCommand('install', DRIVER, { intervalMinutes: 20 }),
        expectedCommand('install', CANARY, { intervalMinutes: 20 }),
      ]);
      assert.ok(install.calls.every((c) => c.opts?.interactive === true), 'SSH prompts reach the developer');
      const [driverInstall, canaryInstall] = install.calls.map((c) => decodeFollowMainRemoteCommand(c.args.at(-1)).script);
      assert.equal(driverInstall, followMainInstallScript({ intervalMinutes: 20, harnessCheckout: DRIVER.harnessCheckout }));
      assert.equal(canaryInstall, followMainInstallScript({ intervalMinutes: 20 }));
      assert.match(driverInstall, /^OnUnitActiveSec=20min$/m);
      assert.match(driverInstall, /^ExecStart=\/usr\/local\/sbin\/paraclete-lab-follow-main --harness-checkout \/var\/lib\/paraclete\/harness2-repo$/m);
      assert.match(canaryInstall, /^ExecStart=\/usr\/local\/sbin\/paraclete-lab-follow-main$/m);
      assert.deepEqual(installed.vms.map((vm) => [vm.name, vm.ok, vm.installed, vm.timer]), [
        [DRIVER.name, true, 'changed', 'active'],
        [CANARY.name, true, 'changed', 'active'],
      ]);

      const uninstall = fakeGcloud(() => 'lab-follow-main.removed=yes\nlab-follow-main.service_active=inactive');
      const removed = manageLabFollowMain({ action: 'uninstall', projectId: 'your-gcp-project', zone: 'us-central1-b', execGcloud: uninstall.execGcloud });
      assert.equal(removed.ok, true);
      assert.deepEqual(uninstall.calls.map((c) => c.args), [expectedCommand('uninstall', DRIVER), expectedCommand('uninstall', CANARY)]);
      assert.equal(decodeFollowMainRemoteCommand(uninstall.calls[0].args.at(-1)).script, followMainUninstallScript());
      assert.deepEqual(removed.vms.map((vm) => vm.removed), [true, true]);

      const status = fakeGcloud((name) => [
        'lab-follow-main.timer_enabled=enabled',
        'lab-follow-main.timer_active=active',
        'lab-follow-main.service_active=inactive',
        'lab-follow-main.last_run=Fri 2026-10-23 10:00:00 UTC',
        'lab-follow-main.last_result=success',
        `lab-follow-main.last_line=repo=${REPO} upgrade=current`,
        `lab-follow-main.repo=${REPO}`,
        `lab-follow-main.installed=${name === DRIVER.name ? NEW : OLD}`,
        `lab-follow-main.head=${NEW}`,
        'lab-follow-main.agent=',
        'lab-follow-main.busy_since=',
        ...(name === DRIVER.name ? [`lab-follow-main.checkout=${NEW}`] : []),
      ].join('\n'));
      const reported = manageLabFollowMain({ projectId: 'your-gcp-project', zone: 'us-central1-b', execGcloud: status.execGcloud });
      assert.equal(reported.action, 'status', 'status is the default');
      assert.deepEqual(status.calls.map((c) => c.args), [expectedCommand('status', DRIVER), expectedCommand('status', CANARY)]);
      assert.deepEqual(decodeFollowMainRemoteCommand(status.calls[0].args.at(-1)).args, ['--status', '--harness-checkout', DRIVER.harnessCheckout]);
      assert.deepEqual(decodeFollowMainRemoteCommand(status.calls[1].args.at(-1)).args, ['--status']);
      const [driver, canary] = reported.vms;
      assert.equal(driver.timer, 'active');
      assert.equal(driver.lastRun, 'Fri 2026-10-23 10:00:00 UTC');
      assert.equal(driver.installed, NEW);
      assert.equal(driver.mainHead, NEW);
      assert.equal(driver.onMainHead, true);
      assert.equal(driver.checkout, NEW);
      assert.equal(driver.agent, 'idle');
      assert.equal(canary.onMainHead, false);
      assert.equal('checkout' in canary, false);
    });

    it('installing twice over SSH changes nothing the second time', { skip: needsBash }, () => {
      const vms = { [DRIVER.name]: vmSandbox(), [CANARY.name]: vmSandbox() };
      const gcloud = fakeGcloud((name, decoded) => {
        const vm = vms[name];
        const rooted = decoded.script.replace(/^ROOT=''$/m, `ROOT='${vm.at()}'`);
        assert.notEqual(rooted, decoded.script, 'the fake VM moves the script under its own root');
        return vm.runScript(rooted, decoded.args).stdout;
      });
      const first = manageLabFollowMain({ action: 'install', execGcloud: gcloud.execGcloud });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.deepEqual(first.vms.map((vm) => vm.installed), ['changed', 'changed']);
      const second = manageLabFollowMain({ action: 'install', execGcloud: gcloud.execGcloud });
      assert.equal(second.ok, true);
      assert.deepEqual(second.vms.map((vm) => vm.installed), ['unchanged', 'unchanged']);
      assert.match(readFileSync(join(vms[DRIVER.name].dir, 'usr/local/lib/systemd/system/paraclete-lab-follow-main.service'), 'utf8'), /--harness-checkout/);
      assert.doesNotMatch(readFileSync(join(vms[CANARY.name].dir, 'usr/local/lib/systemd/system/paraclete-lab-follow-main.service'), 'utf8'), /--harness-checkout/);
    });

    it('the CLI takes one action, --interval only with --install, and reports an unreachable VM without its command line', async () => {
      assert.match((await runCli(['lab-follow-main', '--install', '--uninstall'])).error, /one of --install, --uninstall and --status/);
      assert.match((await runCli(['lab-follow-main', '--status', '--interval', '10'])).error, /--interval goes with --install/);
      assert.match((await runCli(['lab-follow-main', '--install', '--interval', '2'], { execGcloud: () => '' })).error, /--interval must be from 5 to 1440/);

      const gcloud = fakeGcloud(() => INSTALLED_OUTPUT);
      const res = await runCli(['lab-follow-main', '--install', '--interval', '45', '--project', 'your-gcp-project'], { execGcloud: gcloud.execGcloud });
      assert.equal(res.ok, true);
      assert.match(decodeFollowMainRemoteCommand(gcloud.calls[0].args.at(-1)).script, /^OnActiveSec=45min$/m);

      const unreachable = await runCli(['lab-follow-main', '--status'], {
        execGcloud: (args) => {
          const err = new Error(`Command failed: gcloud ${args.join(' ')}`);
          err.status = 255;
          throw err;
        },
      });
      assert.equal(unreachable.ok, false);
      assert.equal(unreachable.vms[0].error, 'paraclete-h2-driver: gcloud compute ssh exited with code 255');
      assert.ok(!JSON.stringify(unreachable).includes('base64'), 'the error does not repeat the command');
    });

    it('lab-provision installs the timer on both VMs, retrying a new VM until its SSH answers', () => {
      let sshTries = 0;
      const sleeps = [];
      const provisioned = provisionGcpLab({
        projectId: 'your-gcp-project',
        repo: REPO,
        commit: NEW,
        intervalMinutes: 20,
        sleep: (ms) => sleeps.push(ms),
        execGcloud: (args) => {
          if (args[0] === 'compute' && args[1] === 'ssh') {
            sshTries += 1;
            if (sshTries === 1) {
              const err = new Error('Command failed');
              err.status = 255;
              throw err;
            }
            assert.match(decodeFollowMainRemoteCommand(args.at(-1)).script, /^OnActiveSec=20min$/m);
            return INSTALLED_OUTPUT;
          }
          if (args.includes('describe') || args.includes('list')) return 'exists';
          return 'True';
        },
      });
      assert.equal(provisioned.ok, true, JSON.stringify(provisioned.followMain));
      assert.equal(sshTries, 3, 'the driver answered on its second try, the canary on its first');
      assert.deepEqual(sleeps, [15_000]);
      assert.deepEqual(
        provisioned.stepsExecuted.filter((s) => s.step.startsWith('follow-main:')).map((s) => [s.step, s.status]),
        [['follow-main:paraclete-h2-driver', 'changed'], ['follow-main:paraclete-h2-canary', 'changed']],
      );
      assert.equal(provisioned.plan.followMain.intervalMinutes, 20);

      const unreachable = provisionGcpLab({
        projectId: 'your-gcp-project',
        repo: REPO,
        commit: NEW,
        sshAttempts: 2,
        sleep: () => {},
        execGcloud: (args) => {
          if (args[0] === 'compute' && args[1] === 'ssh') throw Object.assign(new Error('Command failed'), { status: 255 });
          if (args.includes('describe') || args.includes('list')) return 'exists';
          return 'True';
        },
      });
      assert.equal(unreachable.ok, false);
      assert.ok(unreachable.stepsExecuted.some((s) => s.step === 'vm:paraclete-h2-driver' && s.status === 'updated'), 'the VMs stand');
      assert.match(unreachable.followMain[0].error, /paraclete-h2-driver: gcloud compute ssh exited with code 255 \(2 tries\)/);
      assert.equal(unreachable.hint, 'The follow-main timer is not on every VM. Once they answer over SSH: node dev/harness2/cli.mjs lab-follow-main --install --interval 30 --project your-gcp-project --zone us-central1-a');
    });

    it('lab-status shows each running lab VM\'s timer, and none for a stopped one', () => {
      const gcloud = fakeGcloud(() => [
        'lab-follow-main.timer_enabled=enabled',
        'lab-follow-main.timer_active=active',
        `lab-follow-main.installed=${NEW}`,
        `lab-follow-main.head=${NEW}`,
      ].join('\n'));
      const execGcloud = (args, opts) => {
        if (args[0] === 'compute' && args[1] === 'instances' && args[2] === 'list') {
          return JSON.stringify([
            { name: DRIVER.name, status: 'RUNNING', metadata: { items: [] } },
            { name: CANARY.name, status: 'TERMINATED', metadata: { items: [] } },
            { name: 'something-else', status: 'RUNNING', metadata: { items: [] } },
          ]);
        }
        return gcloud.execGcloud(args, opts);
      };
      const status = inspectGcpLabStatus({ projectId: 'your-gcp-project', execGcloud });
      assert.equal(status.vms[0].followMain.timer, 'active');
      assert.equal(status.vms[0].followMain.onMainHead, true);
      assert.equal(status.vms[1].followMain, null);
      assert.equal('followMain' in status.vms[2], false);
      assert.equal(gcloud.calls.length, 1, 'only the running lab VM is asked');
    });
  });
});

