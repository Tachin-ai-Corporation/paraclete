// dev/harness2/cli.mjs: Command-line entrypoint for Paraclete-H² (validate, eval, evolve, harvest, promote).

import { pathToFileURL } from 'node:url';
import { PARACLETE_SURFACE, rolesForStage, buildSkillScaffold, buildRoleScaffold } from './surface.mjs';
import { validateCandidateWorkspace } from './validate.mjs';
import { runTier1Evaluation, runTier2CanaryEvaluation, selectBenchmarkTasks } from './substrate.mjs';
import { selectLensForTrajectories } from './lenses.mjs';
import { runWithinGenerationRecursion } from './recursion.mjs';
import { CAPABILITY_CREDO, synthesizeCrossLensCandidate } from './selection.mjs';
import { DEFAULT_EVIDENCE_RULES, buildPromotionEvidence } from './evidence.mjs';
import { createLineageLibrary } from './library.mjs';
import {
  evaluatePromotionReadiness,
  formatPromotionReport,
  applyPromotedCandidate,
  pushAndCreatePullRequest,
} from './promote.mjs';
import { DEFAULT_JUDGE_COMMITTEE, JUDGE_DIMENSIONS, parseCommitteeSpec } from './judge.mjs';
import {
  harvestMissionTrajectories,
  loadMissionsFromInput,
  loadMissionsFromFirestore,
  saveHarvestedBenchmarkTasks,
  synthesizeBenchmarkCandidatesFromHarvest,
  expandCurriculumForSaturatedRoles,
} from './harvest.mjs';
import {
  buildGcpLabPlan,
  createDevCanaryRunner,
  createLiveProposeAndApply,
  evaluateLiveTarget,
  inspectGcpLabStatus,
  manageLabFollowMain,
  provisionGcpLab,
  runInProcessBrainRollout,
} from './live-runner.mjs';
import {
  getCurriculumCoverageReport,
  recordCurriculumUnitAttempt,
  selectNextCurriculumUnit,
  synthesizeNextCurriculumEpoch,
} from './curriculum.mjs';
import {
  REPORT_STANDARD_VERSION,
  buildLoopStatusReport,
  formatLoopStatusReportMarkdown,
} from './report.mjs';

export const USAGE = `Usage: node dev/harness2/cli.mjs <subcommand> [options]

Subcommands:
  surface                          Print the Paraclete mutable surface (c1..c7)
  validate [--stage stage1|stage2] Run structural, contract, and prompt budget validation
  eval     [--stage stage1|stage2] [--role <role>] [--live] [--vertex] [--judge-committee [models]] [--include-harvested] [--suite-path <path>]
                                   Run Tier-1 hermetic or live target benchmark evaluation
  judge    [--stage stage1|stage2] [--role <role>] [--judge-committee [models]]
                                   Score target harness rollouts with the Frontier Model Committee (gemini-4-argon + claude-opus-5-5)
  canary   [--agent <vm-name>] [--stage stage1|stage2] [--role <role>]
                                   Run Tier-2 canary evaluation with read-only smoke check
  evolve   [--stage stage1|stage2] [--generations <G>] [--recursion <R>] [--role <role>] [--live] [--vertex] [--judge-committee [models]] [--include-harvested] [--expand-curriculum]
                                   Execute Loop A dual-lens evolutionary harness optimization (Capability-First Credo)
  harvest  [--input <path>] [--project <id>] [--version <ver>] [--min-version <ver>] [--role <role>] [--persist] [--suite-path <path>] [--expand-curriculum]
                                   Filter and distill Loop B trajectories into Loop A benchmarks
  promote  [--stage stage1|stage2] [--live] [--vertex] [--judge-committee [models]] [--apply] [--branch <branch>] [--push-pr] [--dry-run]
                                   Verify candidate readiness, optionally apply patches, push branch, and open PR
  curriculum [--status] [--suggest] [--max-units <n>] [--unit <id>] [--track <track>] [--stage stage1|stage2] [--role <role>] [--organ <organ>] [--generations <G>] [--recursion <R>] [--live] [--vertex] [--judge-committee [models]] [--apply] [--branch <branch>] [--push-pr] [--dry-run] [--state-path <path>]
                                   Step through the Master Curriculum Playbook or synthesize the next curriculum epoch
  report   [--markdown] [--project <id>] [--state-path <path>] [--archive-path <path>] [--suite-path <path>]
                                   Generate the standardized Paraclete-H² Autonomous Loop & GCP Cost Status Report
  scaffold-skill --id <skill-id> [--role <role>] [--name <title>] [--command <cmd>]
                                   Generate a skill package scaffold (skill.json, SKILL.md, <cmd>.mjs; a person commits the command)
  scaffold-role  --id <role-id> [--title <title>] [--summary <text>]
                                   Generate a role package scaffold (role.json, README.md, prompts/, responsibilities.json; a person commits role.json)
  lab-plan [--project <id>] [--zone <zone>] [--org <org-id>] [--billing <account-id>]
                                   Print the two-tier GCP lab (paraclete-h2-lab) provisioning plan
  lab-provision [--project <id>] [--zone <zone>] [--org <org-id>] [--billing <account-id>] [--interval <minutes>] [--dry-run]
                                   Provision the two-tier GCP lab (paraclete-h2-driver + paraclete-h2-canary), follow-main timer included
  lab-status [--project <id>] [--zone <zone>]
                                   Inspect the live status of the two-tier GCP lab VMs and their follow-main timers
  lab-follow-main [--install|--uninstall|--status] [--interval <minutes>] [--project <id>] [--zone <zone>]
                                   Lab only: put on, take off or report (the default) the timer that keeps both lab VMs
                                   and the driver's harness checkout on main's head (every 30 minutes unless --interval)
`;

export function parseCliArgs(argv = []) {
  const [subcommand = 'help', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return { subcommand, flags };
}

/**
 * The proposal record of a cross-lens merge: both lenses' hypotheses, and their shared source. When
 * the sources differ, a refused one wins, so a merge is never more promotable than its parts.
 */
function mergedProposal(invCandidate, domCandidate) {
  const parts = [invCandidate, domCandidate];
  const sources = parts.map((c) => c?.proposal?.source || 'unknown');
  const refused = sources.find((s) => DEFAULT_EVIDENCE_RULES.refusedSources.includes(s));
  return {
    source: refused || (sources[0] === sources[1] ? sources[0] : sources.join('+')),
    hypothesis: parts.map((c) => c?.proposal?.hypothesis || c?.hypothesis).filter(Boolean).join(' + '),
  };
}

/**
 * Run a full Loop A evolutionary cycle across `generations` with `recursionSteps`
 * within-generation steps per lens (`INV` and `DOM`), cross-lens synthesis, and
 * Pareto archive logging.
 *
 * @param {object} [opts]
 * @param {'stage1' | 'stage2'} [opts.stage]
 * @param {string} [opts.role]
 * @param {number} [opts.generations]
 * @param {number} [opts.recursionSteps]
 * @param {number} [opts.trials]  runs of each task per evaluation (default 1)
 * @param {object} [opts.library]
 * @param {Function} [opts.proposeAndApply]
 * @param {Function} [opts.validateCandidate]
 * @param {Function} [opts.evaluateCandidate]
 */
export async function runEvolutionLoop(opts = {}) {
  const stage = opts.stage || 'stage1';
  const generations = Number(opts.generations ?? 1) || 1;
  const recursionSteps = Number(opts.recursionSteps ?? 2) || 2;
  const library = opts.library || createLineageLibrary({ archivePath: opts.archivePath });

  const evaluateCandidate =
    opts.evaluateCandidate ||
    (async (cand) =>
      runTier1Evaluation({
        stage,
        role: opts.role,
        trials: opts.trials,
        runTaskRollout: cand?.runTaskRollout,
      }));

  const validateCandidate =
    opts.validateCandidate ||
    ((cand) =>
      validateCandidateWorkspace({
        touchedPaths: cand.touchedPaths || [],
        stage,
        allowedComponents: cand.allowedComponents,
        runTests: false,
      }));

  const proposeAndApply =
    opts.proposeAndApply ||
    (async (spec, baseState) => ({
      id: `${baseState.id}-${spec.lens.toLowerCase()}-${spec.priorAttemptsSummary.length + 1}`,
      parentId: baseState.id,
      lens: spec.lens,
      stage,
      allowedComponents: spec.allowedComponents,
      touchedPaths: [],
      hypothesis: `${spec.lens} (${spec.escalationMode}) refinement`,
    }));

  const initialEval = await evaluateCandidate({ id: 'gen0-baseline', stage });
  let currentParent = {
    id: 'gen0-baseline',
    parentId: null,
    generation: 0,
    lens: null,
    stage,
    touchedPaths: [],
    hypothesis: 'Baseline harness configuration',
    scores: initialEval.summary,
    trajectories: initialEval.trajectories,
  };

  library.recordCandidate(currentParent);
  const generationSummaries = [];
  // Every step of every lens: its proposal (source, and why a model proposal fell back), whether it
  // was evaluated, and its outcome. The run's output carries it so a skipped or failed proposal shows.
  const attempts = [];

  for (let g = 1; g <= generations; g += 1) {
    const routing = selectLensForTrajectories(currentParent.trajectories);

    const invResult = await runWithinGenerationRecursion({
      lens: 'INV',
      parentState: currentParent,
      maxSteps: recursionSteps,
      stage,
      role: opts.role,
      proposeAndApply,
      validateCandidate,
      evaluateCandidate,
    });

    const domResult = await runWithinGenerationRecursion({
      lens: 'DOM',
      parentState: currentParent,
      maxSteps: recursionSteps,
      stage,
      role: opts.role,
      proposeAndApply,
      validateCandidate,
      evaluateCandidate,
    });

    attempts.push(...[...invResult.history, ...domResult.history].map((a) => ({ generation: g, ...a })));

    const synthesis = await synthesizeCrossLensCandidate({
      parentState: currentParent,
      invResult,
      domResult,
      mergeAndEvaluate: opts.mergeAndEvaluate,
    });

    currentParent = {
      ...synthesis.bestOverall,
      generation: g,
    };

    library.recordCandidate(currentParent);
    const genRecord = library.recordGeneration({
      generation: g,
      stage,
      primaryDiagnosticLens: routing.primaryLens,
      winnerId: currentParent.id,
      synthesized: synthesis.synthesized,
      frontierIds: synthesis.frontier.map((c) => c.id),
      scores: currentParent.scores,
    });
    generationSummaries.push(genRecord);
  }

  return {
    stage,
    roles: rolesForStage(stage),
    generations: generationSummaries,
    attempts,
    winner: currentParent,
  };
}

/**
 * Execute a CLI command programmatically.
 */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const { subcommand, flags } = parseCliArgs(argv);
  const stage = flags.stage || 'stage1';
  // Runs of each task per evaluation (--trials). A run that may open a pull request (--push-pr)
  // defaults to the evidence rules' minimum, since a promotion needs that many on both sides.
  const trials = Math.max(1, Math.floor(Number(flags.trials) || (flags['push-pr'] ? DEFAULT_EVIDENCE_RULES.minTrials : 1)));

  if (subcommand === 'surface') {
    return {
      ok: true,
      surface: PARACLETE_SURFACE,
      roles: rolesForStage(stage),
    };
  }

  if (subcommand === 'validate') {
    const res = validateCandidateWorkspace({
      stage,
      runTests: flags['no-tests'] ? false : true,
      deps,
    });
    return res;
  }

  if (subcommand === 'eval' || subcommand === 'judge') {
    const tasks =
      Array.isArray(deps.tasks) && deps.tasks.length > 0
        ? deps.tasks
        : selectBenchmarkTasks({
            stage,
            role: flags.role,
            includeHarvested: Boolean(flags['include-harvested']),
            suitePath: flags['suite-path'],
          });
    const useFrontierJudge = subcommand === 'judge' || Boolean(flags['judge-committee']) || Boolean(deps.judgeOptions);
    const judgeCommittee =
      typeof flags['judge-committee'] === 'string'
        ? parseCommitteeSpec(flags['judge-committee'])
        : DEFAULT_JUDGE_COMMITTEE;
    const isLive = subcommand === 'judge' || Boolean(flags.live) || useFrontierJudge;
    const evalRes = isLive
      ? await evaluateLiveTarget({
          stage,
          role: flags.role,
          tasks,
          useFrontierJudge,
          judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
          judgeOptions: deps.judgeOptions,
          gatewayUrl: flags['gateway-url'] || deps.gatewayUrl,
          gatewayToken: flags['gateway-token'] || deps.gatewayToken,
          trials,
          deps,
        })
      : await runTier1Evaluation({ stage, role: flags.role, tasks, trials, deps });
    return {
      ok: true,
      credo: CAPABILITY_CREDO.name,
      ...(useFrontierJudge ? { committee: judgeCommittee, dimensions: JUDGE_DIMENSIONS } : {}),
      ...evalRes,
    };
  }

  if (subcommand === 'canary') {
    const tasks = selectBenchmarkTasks({ stage, role: flags.role }).slice(0, 2);
    const canaryRunner = deps.canaryRunner || createDevCanaryRunner({ role: flags.role, runSmoke: deps.runSmoke });
    const canaryRes = await runTier2CanaryEvaluation({
      canaryAgent: flags.agent || 'canary-se-01',
      tasks,
      canaryRunner,
    });
    return { ok: canaryRes.smokePassed, ...canaryRes };
  }

  if (subcommand === 'evolve') {
    const isLive = Boolean(flags.live);
    const useVertex = Boolean(flags.vertex);
    const useFrontierJudge = Boolean(flags['judge-committee']) || Boolean(deps.judgeOptions);
    const judgeCommittee =
      typeof flags['judge-committee'] === 'string'
        ? parseCommitteeSpec(flags['judge-committee'])
        : DEFAULT_JUDGE_COMMITTEE;
    const tasks =
      Array.isArray(deps.tasks) && deps.tasks.length > 0
        ? deps.tasks
        : selectBenchmarkTasks({
            stage,
            role: flags.role,
            includeHarvested: Boolean(flags['include-harvested']),
            suitePath: flags['suite-path'],
          });
    const liveEvaluate = isLive
      ? async (cand) =>
          evaluateLiveTarget({
            stage,
            role: flags.role,
            tasks,
            touchedPaths: cand?.touchedPaths || [],
            runTaskRollout: cand?.runTaskRollout,
            useFrontierJudge,
            judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
            judgeOptions: deps.judgeOptions,
            gatewayUrl: flags['gateway-url'] || deps.gatewayUrl,
            gatewayToken: flags['gateway-token'] || deps.gatewayToken,
            trials,
            deps,
          })
      : undefined;

    const res = await runEvolutionLoop({
      stage,
      role: flags.role,
      trials,
      generations: flags.generations ? Number(flags.generations) : 1,
      recursionSteps: flags.recursion ? Number(flags.recursion) : 2,
      proposeAndApply: isLive
        ? createLiveProposeAndApply({
            stage,
            useWorktree: true,
            useVertex,
            vertexGenerate: deps.vertexGenerate,
            useFrontierJudge,
            judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
            judgeOptions: deps.judgeOptions,
            gatewayUrl: flags['gateway-url'] || deps.gatewayUrl,
            gatewayToken: flags['gateway-token'] || deps.gatewayToken,
            targetMutablePath: flags['target-path'] || deps.targetMutablePath,
          })
        : undefined,
      evaluateCandidate: liveEvaluate,
      mergeAndEvaluate: isLive
        ? async (invCandidate, domCandidate, parentState) => {
            const mergedSnapshots = new Map();
            const roles = new Set(['paraclete-h2', ...rolesForStage(stage)]);
            for (const r of roles) {
              const invSnap = invCandidate?.roleSnapshots?.get(r);
              const domSnap = domCandidate?.roleSnapshots?.get(r);
              if (invSnap && domSnap) {
                mergedSnapshots.set(r, {
                  contracts: invSnap.contracts,
                  cachedOrgans: invSnap.cachedOrgans,
                  organPromptTokens: domSnap.organPromptTokens,
                  organPrompts: domSnap.organPrompts || invSnap.organPrompts,
                });
              } else if (invSnap || domSnap) {
                mergedSnapshots.set(r, invSnap || domSnap);
              }
            }
            const mergedRollout =
              mergedSnapshots.size > 0
                ? async (task, substrateCtx) =>
                    runInProcessBrainRollout(task, substrateCtx, {
                      configSnapshot: mergedSnapshots.get(task.role || 'paraclete-h2'),
                      useFrontierJudge,
                      judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
                      judgeOptions: deps.judgeOptions,
                      gatewayUrl: flags['gateway-url'] || deps.gatewayUrl,
                      gatewayToken: flags['gateway-token'] || deps.gatewayToken,
                    })
                : invCandidate?.runTaskRollout;
            const touchedPaths = [
              ...new Set([...(invCandidate?.touchedPaths || []), ...(domCandidate?.touchedPaths || [])]),
            ];
            const filePatches = {
              ...(invCandidate?.filePatches || {}),
              ...(domCandidate?.filePatches || {}),
            };
            const evalRes = await liveEvaluate({
              touchedPaths,
              runTaskRollout: mergedRollout,
            });
            const proposal = mergedProposal(invCandidate, domCandidate);
            return {
              id: `${parentState?.id || 'cand'}-syn`,
              parentId: parentState?.id || null,
              lens: 'SYN',
              stage,
              hypothesis: proposal.hypothesis,
              proposal,
              touchedPaths,
              filePatches,
              roleSnapshots: mergedSnapshots,
              runTaskRollout: mergedRollout,
              scores: evalRes.summary,
              trajectories: evalRes.trajectories,
            };
          }
        : undefined,
    });
    let curriculumExpansion = null;
    if (flags['expand-curriculum']) {
      curriculumExpansion = expandCurriculumForSaturatedRoles(
        { summary: res.winner?.scores },
        {
          persist: Boolean(flags.persist),
          suitePath: flags['suite-path'],
        },
      );
    }
    return {
      ok: true,
      credo: CAPABILITY_CREDO.name,
      ...(curriculumExpansion ? { curriculumExpansion } : {}),
      ...res,
    };
  }

  if (subcommand === 'harvest') {
    let rawMissions = [];
    if (flags.input) {
      rawMissions = loadMissionsFromInput(flags.input, deps);
    } else if (flags.project || deps.firestoreHost) {
      rawMissions = await loadMissionsFromFirestore({
        projectId: flags.project || deps.projectId,
        firestoreHost: flags['firestore-host'] || deps.firestoreHost,
        limit: flags.limit ? Number(flags.limit) : 100,
        getAccessToken: deps.getAccessToken,
      });
    } else {
      rawMissions = deps.rawMissions || [];
    }
    const harvested = harvestMissionTrajectories(rawMissions, {
      targetVersion: flags.version || null,
      minPlatformVersion: flags['min-version'] || null,
      role: flags.role || null,
    });
    const tasks = synthesizeBenchmarkCandidatesFromHarvest(harvested.accepted);
    let curriculumExpansion = null;
    if (flags['expand-curriculum']) {
      const baseEval = await runTier1Evaluation({ stage, role: flags.role, deps });
      curriculumExpansion = expandCurriculumForSaturatedRoles(baseEval, {
        persist: Boolean(flags.persist || flags['suite-path']),
        suitePath: flags['suite-path'],
      });
      tasks.push(...curriculumExpansion.synthesizedTasks);
    }
    let persistence = null;
    if (flags.persist || flags['suite-path']) {
      persistence = saveHarvestedBenchmarkTasks(tasks, {
        suitePath: flags['suite-path'],
        fs: deps.fs,
      });
    }
    return {
      ok: true,
      harvested,
      synthesizedTasks: tasks,
      ...(curriculumExpansion ? { curriculumExpansion } : {}),
      persistence,
    };
  }

  if (subcommand === 'scaffold-skill') {
    const scaffold = buildSkillScaffold({
      skillId: flags.id || 'custom-skill',
      role: flags.role || null,
      name: flags.name,
      whenToUse: flags['when-to-use'],
      commandName: flags.command,
    });
    return { ok: true, scaffold };
  }

  if (subcommand === 'scaffold-role') {
    const scaffold = buildRoleScaffold({
      roleId: flags.id || 'specialist-role',
      title: flags.title,
      summary: flags.summary,
    });
    return { ok: true, scaffold };
  }

  if (subcommand === 'promote') {
    const useFrontierJudge = Boolean(flags['judge-committee']) || Boolean(deps.judgeOptions);
    const judgeCommittee =
      typeof flags['judge-committee'] === 'string'
        ? parseCommitteeSpec(flags['judge-committee'])
        : DEFAULT_JUDGE_COMMITTEE;
    if (flags.live) {
      const baselineRes = await evaluateLiveTarget({
        stage,
        role: flags.role,
        repoRoot: deps.repoRoot,
        useFrontierJudge,
        judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
        judgeOptions: deps.judgeOptions,
        trials,
        deps,
      });
      const evoRes = await runCli(
        [
          'evolve',
          '--stage',
          stage,
          '--generations',
          String(flags.generations || 2),
          '--recursion',
          String(flags.recursion || 2),
          '--trials',
          String(trials),
          '--live',
          ...(flags.vertex ? ['--vertex'] : []),
          ...(useFrontierJudge
            ? [
                '--judge-committee',
                typeof flags['judge-committee'] === 'string'
                  ? flags['judge-committee']
                  : DEFAULT_JUDGE_COMMITTEE.join(','),
              ]
            : []),
          ...(flags.role ? ['--role', flags.role] : []),
        ],
        deps,
      );
      const readiness = evaluatePromotionReadiness({
        candidate: evoRes.winner,
        baselineScores: baselineRes.summary,
        validationResult: baselineRes.validation,
        evidence: buildPromotionEvidence({ candidate: evoRes.winner, baselineTrajectories: baselineRes.trajectories }),
      });
      let application = null;
      if (flags.apply) {
        application = applyPromotedCandidate({
          candidate: evoRes.winner,
          readiness,
          repoRoot: deps.repoRoot || process.cwd(),
          branch: typeof flags.branch === 'string' ? flags.branch : null,
          runTests: Boolean(flags['run-tests']),
          execGit: deps.execGit,
          validate: deps.validate,
        });
        readiness.application = application;
      }
      let pullRequest = null;
      if (flags['push-pr']) {
        pullRequest = pushAndCreatePullRequest({
          candidate: evoRes.winner,
          readiness,
          application,
          repoRoot: deps.repoRoot || process.cwd(),
          branch: typeof flags.branch === 'string' ? flags.branch : null,
          dryRun: Boolean(flags['dry-run']),
          execGit: deps.execGit,
          execGh: deps.execGh,
        });
        readiness.pullRequest = pullRequest;
      }
      return {
        ok: readiness.ready && (!application || application.applied),
        readiness,
        application,
        pullRequest,
        attempts: evoRes.attempts || [],
        report: formatPromotionReport(readiness),
      };
    }

    const evalRes = await runTier1Evaluation({ stage, role: flags.role, trials, deps });
    const candidate = deps.candidate || {
      id: flags.candidate || 'candidate-head',
      lens: 'SYN',
      stage,
      touchedPaths: [],
      scores: evalRes.summary,
    };
    const readiness = evaluatePromotionReadiness({
      candidate,
      baselineScores: deps.baselineScores || evalRes.summary,
      // Without --live this run measured the baseline only; a candidate brings its own trajectories.
      evidence: buildPromotionEvidence({ candidate, baselineTrajectories: evalRes.trajectories }),
    });
    let application = null;
    if (flags.apply) {
      application = applyPromotedCandidate({
        candidate,
        readiness,
        repoRoot: deps.repoRoot || process.cwd(),
        branch: typeof flags.branch === 'string' ? flags.branch : null,
        runTests: Boolean(flags['run-tests']),
        execGit: deps.execGit,
        validate: deps.validate,
      });
      readiness.application = application;
    }
    let pullRequest = null;
    if (flags['push-pr']) {
      pullRequest = pushAndCreatePullRequest({
        candidate,
        readiness,
        application,
        repoRoot: deps.repoRoot || process.cwd(),
        branch: typeof flags.branch === 'string' ? flags.branch : null,
        dryRun: Boolean(flags['dry-run']),
        execGit: deps.execGit,
        execGh: deps.execGh,
      });
      readiness.pullRequest = pullRequest;
    }
    return {
      ok: readiness.ready && (!application || application.applied),
      readiness,
      application,
      pullRequest,
      report: formatPromotionReport(readiness),
    };
  }

  if (subcommand === 'curriculum') {
    const statePath = typeof flags['state-path'] === 'string' ? flags['state-path'] : undefined;
    if (flags.status) {
      return {
        ok: true,
        credo: CAPABILITY_CREDO.name,
        coverage: getCurriculumCoverageReport({ statePath, fs: deps.fs }),
      };
    }

    if (flags.suggest) {
      const maxUnits = flags['max-units'] ? Number(flags['max-units']) : 8;
      const synthesized = synthesizeNextCurriculumEpoch({
        repoRoot: deps.repoRoot || process.cwd(),
        statePath,
        maxUnits,
        registerInState: true,
        fs: deps.fs,
      });
      const coverage = getCurriculumCoverageReport({ statePath, state: synthesized.state, fs: deps.fs });
      return {
        ok: true,
        credo: CAPABILITY_CREDO.name,
        suggestedEpoch: synthesized.proposal.epoch,
        proposedUnitsCount: synthesized.proposal.proposedUnits.length,
        countsBySource: synthesized.proposal.countsBySource,
        proposalJsonPath: synthesized.proposalJsonPath,
        proposalMdPath: synthesized.proposalMdPath,
        proposal: synthesized.proposal,
        markdown: synthesized.markdown,
        coverage,
      };
    }

    const selection = selectNextCurriculumUnit({
      unitId: typeof flags.unit === 'string' ? flags.unit : undefined,
      track: typeof flags.track === 'string' ? flags.track : undefined,
      stage: typeof flags.stage === 'string' ? flags.stage : undefined,
      role: typeof flags.role === 'string' ? flags.role : undefined,
      organ: typeof flags.organ === 'string' ? flags.organ : undefined,
      statePath,
      fs: deps.fs,
    });
    const unit = selection.unit;
    if (!unit) {
      return { ok: false, error: 'Unknown curriculum unit or track.' };
    }

    const useFrontierJudge = Boolean(flags['judge-committee']) || Boolean(deps.judgeOptions);
    const judgeCommittee =
      typeof flags['judge-committee'] === 'string'
        ? parseCommitteeSpec(flags['judge-committee'])
        : DEFAULT_JUDGE_COMMITTEE;

    const unitDeps = {
      ...deps,
      tasks: [unit.task],
      targetMutablePath: unit.targetMutablePath,
    };

    const baselineRes = flags.live
      ? await evaluateLiveTarget({
          stage: unit.stage,
          role: unit.role,
          tasks: [unit.task],
          repoRoot: deps.repoRoot,
          useFrontierJudge,
          judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
          judgeOptions: deps.judgeOptions,
          trials,
          deps: unitDeps,
        })
      : await runTier1Evaluation({
          stage: unit.stage,
          role: unit.role,
          tasks: [unit.task],
          trials,
          deps: unitDeps,
        });

    const evoRes = await runCli(
      [
        'evolve',
        '--stage',
        unit.stage,
        '--role',
        unit.role,
        '--target-path',
        unit.targetMutablePath,
        '--generations',
        String(flags.generations || 1),
        '--recursion',
        String(flags.recursion || 1),
        '--trials',
        String(trials),
        ...(flags.live ? ['--live'] : []),
        ...(flags.vertex ? ['--vertex'] : []),
        ...(useFrontierJudge
          ? [
              '--judge-committee',
              typeof flags['judge-committee'] === 'string'
                ? flags['judge-committee']
                : DEFAULT_JUDGE_COMMITTEE.join(','),
            ]
          : []),
      ],
      unitDeps,
    );

    const readiness = evaluatePromotionReadiness({
      candidate: evoRes.winner,
      baselineScores: baselineRes.summary,
      validationResult: baselineRes.validation,
      evidence: buildPromotionEvidence({ candidate: evoRes.winner, baselineTrajectories: baselineRes.trajectories }),
    });

    let application = null;
    if (flags.apply) {
      application = applyPromotedCandidate({
        candidate: evoRes.winner,
        readiness,
        repoRoot: deps.repoRoot || process.cwd(),
        branch: typeof flags.branch === 'string' ? flags.branch : `harness2/curriculum-${unit.id}`,
        runTests: Boolean(flags['run-tests']),
        execGit: deps.execGit,
        validate: deps.validate,
      });
      readiness.application = application;
    }

    let pullRequest = null;
    if (flags['push-pr']) {
      pullRequest = pushAndCreatePullRequest({
        candidate: evoRes.winner,
        readiness,
        application,
        repoRoot: deps.repoRoot || process.cwd(),
        branch: typeof flags.branch === 'string' ? flags.branch : `harness2/curriculum-${unit.id}`,
        dryRun: Boolean(flags['dry-run']),
        execGit: deps.execGit,
        execGh: deps.execGh,
      });
      readiness.pullRequest = pullRequest;
    }

    const winnerTrajectories =
      Array.isArray(evoRes.winner?.trajectories) && evoRes.winner.trajectories.length > 0
        ? evoRes.winner.trajectories
        : Array.isArray(baselineRes?.trajectories)
          ? baselineRes.trajectories
          : [];
    const artifactChecksPassed =
      winnerTrajectories.length > 0
        ? winnerTrajectories.every((t) =>
            Boolean(t.fixtureVerification?.passed ?? t.evalCritique?.passed ?? t.missionCompleted ?? t.passed),
          )
        : Number(evoRes.winner?.scores?.reliability ?? baselineRes?.summary?.reliability ?? 0) >= 1;

    recordCurriculumUnitAttempt({
      unitId: unit.id,
      baselineScores: baselineRes.summary,
      winnerScores: evoRes.winner?.scores || baselineRes.summary,
      winnerId: evoRes.winner?.id || null,
      promoted: Boolean(readiness.ready),
      artifactChecksPassed,
      artifactPassRate: artifactChecksPassed ? 1 : 0,
      prUrl: pullRequest?.prUrl || null,
      advanceCursor: flags.unit ? false : true,
      repoRoot: deps.repoRoot || process.cwd(),
      statePath,
      fs: deps.fs,
    });

    const coverage = getCurriculumCoverageReport({ statePath, fs: deps.fs });

    return {
      ok: true,
      credo: CAPABILITY_CREDO.name,
      curriculumUnit: {
        id: unit.id,
        order: unit.order,
        track: unit.track,
        organ: unit.organ,
        role: unit.role,
        skill: unit.skill,
        stage: unit.stage,
        title: unit.title,
        targetMutablePath: unit.targetMutablePath,
        requiredArtifacts: unit.requiredArtifacts,
      },
      baselineScores: baselineRes.summary,
      winnerScores: evoRes.winner?.scores || null,
      winnerId: evoRes.winner?.id || null,
      touchedPaths: evoRes.winner?.touchedPaths || [],
      attempts: evoRes.attempts || [],
      artifactChecksPassed,
      readiness,
      application,
      pullRequest,
      coverage,
    };
  }

  if (subcommand === 'report') {
    const statusReport = buildLoopStatusReport({
      repoRoot: deps.repoRoot || process.cwd(),
      projectId: flags.project || deps.projectId,
      statePath: typeof flags['state-path'] === 'string' ? flags['state-path'] : deps.statePath,
      harvestedSuitePath: typeof flags['suite-path'] === 'string' ? flags['suite-path'] : deps.harvestedSuitePath,
      instances: deps.instances,
      disks: deps.disks,
      missions: deps.missions,
      pullRequests: deps.pullRequests,
      alerts: deps.alerts,
      schedules: deps.schedules,
      billingAccountName: deps.billingAccountName,
      billingEnabled: deps.billingEnabled,
      nowIso: deps.nowIso,
      fs: deps.fs,
    });
    const markdown = formatLoopStatusReportMarkdown(statusReport);
    return {
      ok: true,
      standardVersion: REPORT_STANDARD_VERSION,
      statusReport,
      markdown,
      ...(flags.markdown ? { report: markdown } : {}),
    };
  }

  if (subcommand === 'lab-plan') {
    const plan = buildGcpLabPlan({
      projectId: flags.project,
      zone: flags.zone,
      region: flags.region,
      organizationId: flags.org,
      billingAccount: flags.billing,
    });
    return { ok: true, plan };
  }

  if (subcommand === 'lab-provision') {
    return provisionGcpLab({
      projectId: flags.project,
      zone: flags.zone,
      region: flags.region,
      organizationId: flags.org,
      billingAccount: flags.billing,
      repo: flags.repo,
      commit: flags.commit,
      release: flags.release,
      intervalMinutes: flags.interval,
      dryRun: Boolean(flags['dry-run']),
      execGcloud: deps.execGcloud,
      execGit: deps.execGit,
      onStep: deps.onStep,
      sleep: deps.sleep,
    });
  }

  if (subcommand === 'lab-status') {
    return inspectGcpLabStatus({
      projectId: flags.project,
      zone: flags.zone,
      region: flags.region,
      execGcloud: deps.execGcloud,
    });
  }

  if (subcommand === 'lab-follow-main') {
    const actions = ['install', 'uninstall', 'status'].filter((action) => flags[action]);
    if (actions.length > 1) return { ok: false, error: 'lab-follow-main takes one of --install, --uninstall and --status.' };
    const action = actions[0] || 'status';
    if (flags.interval !== undefined && action !== 'install') return { ok: false, error: '--interval goes with --install.' };
    try {
      return manageLabFollowMain({
        action,
        projectId: flags.project,
        zone: flags.zone,
        region: flags.region,
        intervalMinutes: flags.interval,
        execGcloud: deps.execGcloud,
        sleep: deps.sleep,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: true, usage: USAGE };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli()
    .then((res) => {
      // A proposal that was not evaluated (a template fallback, or no change) shows in the log too.
      for (const a of res.attempts || []) {
        if (a.revertReason?.startsWith('not_evaluated: ')) {
          process.stderr.write(`[WARN] ${a.candidateId || `${a.lens} step ${a.step}`} not evaluated: ${a.revertReason.slice('not_evaluated: '.length)}\n`);
        }
      }
      if (res.usage) {
        process.stdout.write(res.usage);
      } else if (res.report) {
        process.stdout.write(res.report);
      } else {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      }
      if (res.ok === false) process.exitCode = 1;
    })
    .catch((err) => {
      process.stderr.write(`[ERROR] ${err.message}\n`);
      process.exitCode = 1;
    });
}
