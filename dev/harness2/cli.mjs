// dev/harness2/cli.mjs: Command-line entrypoint for Paraclete-H² (validate, eval, evolve, harvest, promote).

import { pathToFileURL } from 'node:url';
import { PARACLETE_SURFACE, rolesForStage } from './surface.mjs';
import { validateCandidateWorkspace } from './validate.mjs';
import { runTier1Evaluation, runTier2CanaryEvaluation, selectBenchmarkTasks } from './substrate.mjs';
import { selectLensForTrajectories } from './lenses.mjs';
import { runWithinGenerationRecursion } from './recursion.mjs';
import { synthesizeCrossLensCandidate } from './selection.mjs';
import { createLineageLibrary } from './library.mjs';
import { evaluatePromotionReadiness, formatPromotionReport, applyPromotedCandidate } from './promote.mjs';
import {
  harvestMissionTrajectories,
  loadMissionsFromInput,
  loadMissionsFromFirestore,
  saveHarvestedBenchmarkTasks,
  synthesizeBenchmarkCandidatesFromHarvest,
} from './harvest.mjs';
import {
  buildGcpLabPlan,
  createDevCanaryRunner,
  createLiveProposeAndApply,
  evaluateLiveTarget,
  runInProcessBrainRollout,
} from './live-runner.mjs';

export const USAGE = `Usage: node dev/harness2/cli.mjs <subcommand> [options]

Subcommands:
  surface                          Print the 8-component Paraclete mutable surface (c1..c8)
  validate [--stage stage1|stage2] Run structural, contract, and prompt budget validation
  eval     [--stage stage1|stage2] [--role <role>] [--live] [--vertex] [--include-harvested] [--suite-path <path>]
                                   Run Tier-1 hermetic or live target benchmark evaluation
  canary   [--agent <vm-name>] [--stage stage1|stage2] [--role <role>]
                                   Run Tier-2 canary evaluation with read-only smoke check
  evolve   [--stage stage1|stage2] [--generations <G>] [--recursion <R>] [--role <role>] [--live] [--vertex] [--include-harvested]
                                   Execute Loop A dual-lens evolutionary harness optimization
  harvest  [--input <path>] [--project <id>] [--version <ver>] [--min-version <ver>] [--role <role>] [--persist] [--suite-path <path>]
                                   Filter and distill Loop B trajectories into Loop A benchmarks
  promote  [--stage stage1|stage2] [--live] [--vertex] [--apply] [--branch <branch>]
                                   Verify candidate readiness, optionally apply patches, and print promotion report
  lab-plan [--project <id>] [--zone <zone>]
                                   Print the two-tier GCP lab (paraclete-h2-lab) provisioning plan
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
 * Run a full Loop A evolutionary cycle across `generations` with `recursionSteps`
 * within-generation steps per lens (`INV` and `DOM`), cross-lens synthesis, and
 * Pareto archive logging.
 *
 * @param {object} [opts]
 * @param {'stage1' | 'stage2'} [opts.stage]
 * @param {string} [opts.role]
 * @param {number} [opts.generations]
 * @param {number} [opts.recursionSteps]
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
    winner: currentParent,
  };
}

/**
 * Execute a CLI command programmatically.
 */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const { subcommand, flags } = parseCliArgs(argv);
  const stage = flags.stage || 'stage1';

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

  if (subcommand === 'eval') {
    const tasks = selectBenchmarkTasks({
      stage,
      role: flags.role,
      includeHarvested: Boolean(flags['include-harvested']),
      suitePath: flags['suite-path'],
    });
    const evalRes = flags.live
      ? await evaluateLiveTarget({
          stage,
          role: flags.role,
          tasks,
          gatewayUrl: flags['gateway-url'] || deps.gatewayUrl,
          gatewayToken: flags['gateway-token'] || deps.gatewayToken,
          deps,
        })
      : await runTier1Evaluation({ stage, role: flags.role, tasks, deps });
    return { ok: true, ...evalRes };
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
    const tasks = selectBenchmarkTasks({
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
            gatewayUrl: flags['gateway-url'] || deps.gatewayUrl,
            gatewayToken: flags['gateway-token'] || deps.gatewayToken,
            deps,
          })
      : undefined;

    const res = await runEvolutionLoop({
      stage,
      role: flags.role,
      generations: flags.generations ? Number(flags.generations) : 1,
      recursionSteps: flags.recursion ? Number(flags.recursion) : 2,
      proposeAndApply: isLive
        ? createLiveProposeAndApply({
            stage,
            useWorktree: true,
            useVertex,
            vertexGenerate: deps.vertexGenerate,
            gatewayUrl: flags['gateway-url'] || deps.gatewayUrl,
            gatewayToken: flags['gateway-token'] || deps.gatewayToken,
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
            return {
              id: `${parentState?.id || 'cand'}-syn`,
              parentId: parentState?.id || null,
              lens: 'SYN',
              stage,
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
    return { ok: true, ...res };
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
    let persistence = null;
    if (flags.persist || flags['suite-path']) {
      persistence = saveHarvestedBenchmarkTasks(tasks, {
        suitePath: flags['suite-path'],
        fs: deps.fs,
      });
    }
    return { ok: true, harvested, synthesizedTasks: tasks, persistence };
  }

  if (subcommand === 'promote') {
    if (flags.live) {
      const baselineRes = await evaluateLiveTarget({
        stage,
        role: flags.role,
        repoRoot: deps.repoRoot,
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
          '--live',
          ...(flags.vertex ? ['--vertex'] : []),
          ...(flags.role ? ['--role', flags.role] : []),
        ],
        deps,
      );
      const readiness = evaluatePromotionReadiness({
        candidate: evoRes.winner,
        baselineScores: baselineRes.summary,
        validationResult: baselineRes.validation,
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
      return {
        ok: readiness.ready && (!application || application.applied),
        readiness,
        application,
        report: formatPromotionReport(readiness),
      };
    }

    const evalRes = await runTier1Evaluation({ stage, role: flags.role, deps });
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
    return {
      ok: readiness.ready && (!application || application.applied),
      readiness,
      application,
      report: formatPromotionReport(readiness),
    };
  }

  if (subcommand === 'lab-plan') {
    const plan = buildGcpLabPlan({
      projectId: flags.project,
      zone: flags.zone,
      region: flags.region,
    });
    return { ok: true, plan };
  }

  return { ok: true, usage: USAGE };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli()
    .then((res) => {
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
