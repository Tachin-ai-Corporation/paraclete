// dev/harness2/cli.mjs: Command-line entrypoint for Paraclete-H² (validate, eval, evolve, harvest, promote,
// merge).
//
// `--real-model` (eval, judge, evolve, promote, curriculum) runs every organ through the real model from
// each side's own files (model-runs.mjs), on the model suite's tasks (model-suite.mjs), within a spend
// cap (`--max-rollouts`, `--max-tokens`). Only such runs are promotion evidence, and a promotion's
// evidence also carries a passing calibration (calibration.mjs). While the harness is paused
// (pause.mjs), evolve, promote and curriculum refuse to start. Every such cycle, refused or not, is
// recorded in .local/harness2/cycles.jsonl, which `health` (health.mjs) reads with the repository's
// pull requests and tags to raise an alarm for each way the loop has been seen to fail quietly.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PARACLETE_SURFACE, rolesForStage, buildSkillScaffold, buildRoleScaffold } from './surface.mjs';
import { validateCandidateWorkspace } from './validate.mjs';
import { runTier1Evaluation, runTier2CanaryEvaluation, selectBenchmarkTasks } from './substrate.mjs';
import { selectLensForTrajectories } from './lenses.mjs';
import { runWithinGenerationRecursion } from './recursion.mjs';
import { CAPABILITY_CREDO, synthesizeCrossLensCandidate } from './selection.mjs';
import { DEFAULT_EVIDENCE_RULES, buildPromotionEvidence, judgeEvidence } from './evidence.mjs';
import { calibrateMeasurement } from './calibration.mjs';
import { SpendCapReached, createModelRunContext, estimateRollouts } from './model-runs.mjs';
import { MODEL_SUITE_VERSION, selectModelTasks } from './model-suite.mjs';
import { pauseState } from './pause.mjs';
import {
  appendCycleRecord, collectHealthInputs, cycleRecord, formatHealthMarkdown, loopHealth, syncHealthIssues,
} from './health.mjs';
import { createLineageLibrary } from './library.mjs';
import {
  evaluatePromotionReadiness,
  formatPromotionReport,
  applyPromotedCandidate,
  pushAndCreatePullRequest,
} from './promote.mjs';
import { formatMergeReport, mergePromotionPullRequests } from './merge.mjs';
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
import { LAB_CANARY } from './lab-canary.mjs';
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
  eval     [--stage stage1|stage2] [--role <role>] [--live] [--real-model] [--vertex] [--judge-committee [models]] [--include-harvested] [--suite-path <path>]
                                   Run Tier-1 hermetic or live target benchmark evaluation
  judge    [--stage stage1|stage2] [--role <role>] [--judge-committee [models]]
                                   Score target harness rollouts with the Frontier Model Committee (gemini-4-argon + claude-opus-5-5)
  canary   [--agent <vm-name>] [--project <id>] [--canary-project <id>] [--region <region>] [--zone <zone>] [--stage stage1|stage2] [--role <role>]
                                   Run Tier-2 canary evaluation with read-only smoke check, against the lab's canary
                                   (paraclete-h2-canary in the canary's project) unless --agent names another VM.
                                   No smoke test is wired to a VM from the command line yet, so on its own it fails and
                                   says so; check the canary with node dev/smoke.mjs from the driver's checkout
  evolve   [--stage stage1|stage2] [--generations <G>] [--recursion <R>] [--role <role>] [--live] [--real-model] [--vertex] [--judge-committee [models]] [--include-harvested] [--expand-curriculum]
                                   Execute Loop A dual-lens evolutionary harness optimization (Capability-First Credo)
  harvest  [--input <path>] [--project <id>] [--version <ver>] [--min-version <ver>] [--role <role>] [--persist] [--suite-path <path>] [--expand-curriculum]
                                   Filter and distill Loop B trajectories into Loop A benchmarks
  promote  [--stage stage1|stage2] [--live] [--real-model] [--vertex] [--judge-committee [models]] [--apply] [--branch <branch>] [--push-pr] [--dry-run]
                                   Verify candidate readiness, optionally apply patches, push branch, and open PR
  merge    (--pr <n> | --all) [--dry-run] [--json]
                                   Squash-merge open promotion PRs (harness2/, h2/) whose CI, evidence and files pass; comment once on the others
  curriculum [--status] [--suggest] [--max-units <n>] [--unit <id>] [--track <track>] [--stage stage1|stage2] [--role <role>] [--organ <organ>] [--generations <G>] [--recursion <R>] [--live] [--real-model] [--vertex] [--judge-committee [models]] [--apply] [--branch <branch>] [--push-pr] [--dry-run] [--state-path <path>]
                                   Step through the Master Curriculum Playbook or synthesize the next curriculum epoch
  report   [--markdown] [--project <id>] [--state-path <path>] [--archive-path <path>] [--suite-path <path>]
                                   Generate the standardized Paraclete-H² Autonomous Loop & GCP Cost Status Report
  scaffold-skill --id <skill-id> [--role <role>] [--name <title>] [--command <cmd>]
                                   Generate a skill package scaffold (skill.json, SKILL.md, <cmd>.mjs; a person commits the command)
  scaffold-role  --id <role-id> [--title <title>] [--summary <text>]
                                   Generate a role package scaffold (role.json, README.md, prompts/, responsibilities.json; a person commits role.json)
  lab-plan [--project <id>] [--canary-project <id>] [--region <region>] [--zone <zone>] [--org <org-id>] [--billing <account-id>]
                                   Print the two-tier GCP lab provisioning plan: paraclete-h2-driver in the lab's project
                                   (paraclete-h2-lab unless --project), paraclete-h2-canary in its own (<lab project>-canary
                                   unless --canary-project, which a lab project id longer than 23 characters needs).
                                   --zone alone sets the region it is in; --region alone, its -a zone; default us-central1-a
  lab-provision [--project <id>] [--canary-project <id>] [--region <region>] [--zone <zone>] [--org <org-id>] [--billing <account-id>] [--interval <minutes>] [--dry-run]
                                   Provision both projects and VMs, the driver's access to the canary and its .local/instance.env,
                                   and the follow-main timer. A canary left in the lab's own project is reported, never deleted.
                                   Stops before any change when a project has no billing and no --billing is given, or already
                                   holds another paraclete
  lab-status [--project <id>] [--canary-project <id>] [--region <region>] [--zone <zone>]
                                   Inspect the live status of the lab VMs in both projects and their follow-main timers,
                                   and flag a canary left in the lab's own project
  lab-follow-main [--install|--uninstall|--status] [--interval <minutes>] [--project <id>] [--canary-project <id>] [--region <region>] [--zone <zone>]
                                   Lab only: put on, take off or report (the default) the timer that keeps both lab VMs
                                   and the driver's harness checkout on main's head (every 30 minutes unless --interval)

Real-model runs (eval, judge, evolve, promote, curriculum):
  --real-model                     Every organ answers through the real model, from each side's own files,
                                   on the model suite's tasks; the only runs a promotion accepts
  --task <id>[,<id>...]            eval: only these model-suite tasks
  --max-rollouts <n>               Stop the run before it passes n model rollouts (default 120)
  --max-tokens <n>                 Stop the run before it passes n tokens (default 30000000)
  --recalibrate                    Calibrate again even when today's calibration for this commit is kept

The off switch: while dev/harness2/PAUSED exists (or PARACLETE_H2_PAUSED is set), evolve, promote and
curriculum refuse to start.

Loop health:
  health   [--days <n>] [--repo <owner/name>] [--open-issues] [--dry-run] [--markdown]
                                   The loop's alarms and numbers, from the cycle log, the harness pull
                                   requests and the tags; --open-issues keeps one GitHub issue per alarm
`;

/** The lab's coordinates from the flags: both projects and the zone (live-runner.mjs buildGcpLabPlan). */
function labOptions(flags) {
  return {
    projectId: flags.project,
    canaryProjectId: flags['canary-project'],
    zone: flags.zone,
    region: flags.region,
  };
}

/** The lab's plan for these flags, or the usage mistake that stops it (a canary project that cannot be worked out). */
function labPlanFor(flags, extra = {}) {
  try {
    return { plan: buildGcpLabPlan({ ...labOptions(flags), ...extra }) };
  } catch (err) {
    return { error: err.message };
  }
}

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
 * The files a cross-lens merge runs with: the parent's patches, then each lens's own changes (its
 * touchedPaths). A lens's patches also carry its copy of the parent's files, so merging them whole
 * would let one lens's copy of a parent file undo the other lens's change to it.
 *
 * @param {object} parent
 * @param {object} inv
 * @param {object} dom
 * @returns {object} repo path -> text
 */
export function mergeLensPatches(parent, inv, dom) {
  const own = (cand) => Object.fromEntries((cand?.touchedPaths || [])
    .filter((rel) => cand?.filePatches && rel in cand.filePatches)
    .map((rel) => [rel, cand.filePatches[rel]]));
  return { ...(parent?.filePatches || {}), ...own(inv), ...own(dom) };
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
    // The baseline's own runs: a promotion's calibration compares them with its separate baseline
    // run, a free A/A check (calibration.mjs).
    baseline: { scores: initialEval.summary, trajectories: initialEval.trajectories },
    winner: currentParent,
  };
}

/** The commands that run a harness cycle, which the off switch stops. */
const CYCLE_COMMANDS = new Set(['evolve', 'promote', 'curriculum']);

/** The commands `--real-model` applies to. */
const REAL_MODEL_COMMANDS = new Set(['eval', 'judge', 'evolve', 'promote', 'curriculum']);

function note(deps, line) {
  (deps.stderr || process.stderr).write(`${line}\n`);
}

function headCommit(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Execute a CLI command programmatically. A cycle command refuses while the harness is paused. With
 * `--real-model` (and no real-model context in `deps` yet, as a nested call has) it makes the run's
 * context, reports the spend cap, and removes the run's checkouts when it ends; a run that reaches its
 * cap stops and says so.
 *
 * @param {string[]} [argv]
 * @param {object} [deps]
 */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const { subcommand, flags } = parseCliArgs(argv);
  const repoRoot = deps.repoRoot || process.cwd();
  const readOnly = subcommand === 'curriculum' && (flags.status || flags.suggest);
  // A cycle the developer or the driver started is recorded once; the calls it makes are not.
  const record = CYCLE_COMMANDS.has(subcommand) && !readOnly && !deps.inCycle && deps.cycleLog !== false;
  const result = await runCycle(argv, record ? { ...deps, inCycle: true } : deps, { subcommand, flags, repoRoot, readOnly });
  if (record) {
    try {
      appendCycleRecord(cycleRecord({ command: subcommand, flags, result, commit: headCommit(repoRoot) }), { repoRoot, path: deps.cycleLogPath });
    } catch (err) {
      note(deps, `[WARN] could not record the cycle: ${err.message}`);
    }
  }
  return result;
}

async function runCycle(argv, deps, { subcommand, flags, repoRoot, readOnly }) {
  if (CYCLE_COMMANDS.has(subcommand) && !readOnly) {
    const pause = pauseState({ repoRoot, env: deps.env || process.env });
    if (pause.paused) return { ok: false, paused: true, reason: `the harness is paused: ${pause.reason}` };
  }
  if (deps.realModel || !flags['real-model'] || !REAL_MODEL_COMMANDS.has(subcommand) || readOnly) {
    return runCliCommand(argv, deps);
  }
  const limits = { maxRollouts: flags['max-rollouts'], maxTokens: flags['max-tokens'] };
  const realModel = (deps.createModelRunContext || createModelRunContext)({ repoRoot, limits });
  const cap = realModel.meter.summary();
  note(deps, `[INFO] real-model run: every organ answers through the model; at most ${cap.maxRollouts} rollouts and ${cap.maxTokens} tokens`);
  try {
    const res = await runCliCommand(argv, { ...deps, realModel });
    return { ...res, spend: realModel.meter.summary() };
  } catch (err) {
    if (err instanceof SpendCapReached) {
      return { ok: false, spendCapReached: true, reason: err.message, spend: realModel.meter.summary() };
    }
    throw err;
  } finally {
    realModel.cleanup();
  }
}

/**
 * A promotion's evidence. A real-model run is calibrated (calibration.mjs) only when the evidence
 * would pass without it: calibration costs runs, and evidence that fails anyway needs none. The A/A
 * check reuses the evolution's own baseline runs (`evoRes.baseline`), so only the known-bad change
 * runs again.
 */
async function promotionEvidence({ candidate, baselineRes, evoRes, realModel, tasks, trials, stage, role, flags, deps, judge }) {
  const suite = realModel ? { name: 'model', version: MODEL_SUITE_VERSION } : null;
  const first = buildPromotionEvidence({ candidate, baselineTrajectories: baselineRes.trajectories, suite });
  if (!realModel) return first;
  if (!judgeEvidence(first, { ...DEFAULT_EVIDENCE_RULES, requireCalibration: false }).ok) return first;
  const repoRoot = deps.repoRoot || process.cwd();
  const commit = realModel.sides.commit ? realModel.sides.commit() : headCommit(repoRoot);
  const evaluate = (filePatches) => evaluateLiveTarget({ stage, role, tasks, trials, realModel, filePatches, repoRoot: deps.repoRoot, deps, ...judge });
  note(deps, `[INFO] the evidence would pass: calibrating the measurement on ${commit.slice(0, 12)} (a known-bad change, ${tasks.length} task(s) x ${trials})`);
  const calibration = await calibrateMeasurement({
    evaluate: async (filePatches) => (Object.keys(filePatches).length === 0 && evoRes?.baseline?.trajectories?.length
      ? { trajectories: evoRes.baseline.trajectories }
      : evaluate(filePatches)),
    baselineTrajectories: baselineRes.trajectories,
    commit,
    role: role || null,
    suiteVersion: MODEL_SUITE_VERSION,
    taskIds: tasks.map((t) => t.id),
    trials,
    repoRoot,
    refresh: Boolean(flags.recalibrate),
  });
  return buildPromotionEvidence({ candidate, baselineTrajectories: baselineRes.trajectories, suite, calibration });
}

/**
 * Whether a real-model run fits its cap, said before it spends anything: a run that cannot finish
 * within it would only reach the cap hours in and promote nothing. Null when it fits (or for a nested
 * call, whose caller already asked).
 */
function overCap(deps, realModel, estimate) {
  if (!realModel || deps.capChecked) return null;
  const { maxRollouts } = realModel.meter.summary();
  note(deps, `[INFO] about ${estimate} model rollouts at most; the cap is ${maxRollouts}`);
  if (estimate <= maxRollouts) return null;
  return {
    ok: false,
    spendCapWouldBeReached: true,
    estimate,
    reason: `this run needs about ${estimate} model rollouts, over its cap of ${maxRollouts}: name a --role, or use fewer --trials, --generations or --recursion, or raise --max-rollouts`,
  };
}

async function runCliCommand(argv, deps) {
  const { subcommand, flags } = parseCliArgs(argv);
  const stage = flags.stage || 'stage1';
  // A real-model run's context, made once by runCli and shared by nested calls.
  const realModel = deps.realModel || null;
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
        : realModel
          ? selectModelTasks({ role: flags.role, ids: typeof flags.task === 'string' ? flags.task.split(',') : undefined })
          : selectBenchmarkTasks({
            stage,
            role: flags.role,
            includeHarvested: Boolean(flags['include-harvested']),
            suitePath: flags['suite-path'],
          });
    if (realModel && typeof flags.task === 'string' && !tasks.length) return { ok: false, reason: `no model-suite task is named ${flags.task}` };
    const useFrontierJudge = subcommand === 'judge' || Boolean(flags['judge-committee']) || Boolean(deps.judgeOptions);
    const judgeCommittee =
      typeof flags['judge-committee'] === 'string'
        ? parseCommitteeSpec(flags['judge-committee'])
        : DEFAULT_JUDGE_COMMITTEE;
    const isLive = subcommand === 'judge' || Boolean(flags.live) || useFrontierJudge || Boolean(realModel);
    const refused = overCap(deps, realModel, estimateRollouts({ tasks: tasks.length, trials, candidates: 0 }));
    if (refused) return refused;
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
          realModel,
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
    const lab = labPlanFor(flags);
    if (lab.error) return { ok: false, error: lab.error };
    const canaryVm = lab.plan.vms.find((vm) => vm.name === LAB_CANARY.vm);
    const target = { projectId: canaryVm.projectId, zone: lab.plan.zone };
    if (!deps.canaryRunner && typeof deps.runSmoke !== 'function') {
      // Nothing here reaches a VM yet: a result without a smoke test would be made up.
      return {
        ok: false,
        ran: false,
        canaryAgent: flags.agent || canaryVm.name,
        canaryProject: target.projectId,
        zone: target.zone,
        error: "canary ran nothing: no smoke test is wired to a VM here, so there is no result. Check the canary from the driver's harness checkout, whose .local/instance.env names it: node dev/smoke.mjs",
      };
    }
    const tasks = selectBenchmarkTasks({ stage, role: flags.role }).slice(0, 2);
    const canaryRunner = deps.canaryRunner || createDevCanaryRunner({ role: flags.role, ...target, runSmoke: deps.runSmoke });
    const canaryRes = await runTier2CanaryEvaluation({
      canaryAgent: flags.agent || canaryVm.name,
      tasks,
      canaryRunner,
    });
    return { ok: canaryRes.smokePassed, canaryProject: target.projectId, zone: target.zone, ...canaryRes };
  }

  if (subcommand === 'evolve') {
    const isLive = Boolean(flags.live) || Boolean(realModel);
    const useVertex = Boolean(flags.vertex);
    const useFrontierJudge = Boolean(flags['judge-committee']) || Boolean(deps.judgeOptions);
    const judgeCommittee =
      typeof flags['judge-committee'] === 'string'
        ? parseCommitteeSpec(flags['judge-committee'])
        : DEFAULT_JUDGE_COMMITTEE;
    const tasks =
      Array.isArray(deps.tasks) && deps.tasks.length > 0
        ? deps.tasks
        : realModel
          ? selectModelTasks({ role: flags.role })
          : selectBenchmarkTasks({
              stage,
              role: flags.role,
              includeHarvested: Boolean(flags['include-harvested']),
              suitePath: flags['suite-path'],
            });
    if (realModel) {
      const generations = Number(flags.generations) || 1;
      const recursion = Number(flags.recursion) || 2;
      const refused = overCap(deps, realModel, estimateRollouts({ tasks: tasks.length, trials, candidates: generations * (2 * recursion + 1) }));
      if (refused) return refused;
    }
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
            realModel,
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
            realModel,
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
            const mergedPatches = mergeLensPatches(parentState, invCandidate, domCandidate);
            const mergedRollout = realModel
              ? async (task, substrateCtx) =>
                  runInProcessBrainRollout(task, substrateCtx, {
                    realModel,
                    filePatches: mergedPatches,
                    useFrontierJudge,
                    judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
                    judgeOptions: deps.judgeOptions,
                  })
              : mergedSnapshots.size > 0
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
            const filePatches = mergedPatches;
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
    if (flags.live || realModel) {
      const promoteTasks = realModel
        ? (Array.isArray(deps.tasks) && deps.tasks.length ? deps.tasks : selectModelTasks({ role: flags.role }))
        : undefined;
      if (realModel) {
        const generations = Number(flags.generations) || 2;
        const recursion = Number(flags.recursion) || 2;
        const refused = overCap(deps, realModel, estimateRollouts({
          tasks: promoteTasks.length, trials, candidates: generations * (2 * recursion + 1), baselines: 2, calibration: true,
        }));
        if (refused) return refused;
      }
      const promoteDeps = promoteTasks ? { ...deps, tasks: promoteTasks, capChecked: true } : deps;
      const baselineRes = await evaluateLiveTarget({
        stage,
        role: flags.role,
        repoRoot: deps.repoRoot,
        ...(promoteTasks ? { tasks: promoteTasks } : {}),
        useFrontierJudge,
        judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
        judgeOptions: deps.judgeOptions,
        trials,
        realModel,
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
        promoteDeps,
      );
      if (evoRes.paused) return evoRes;
      const readiness = evaluatePromotionReadiness({
        candidate: evoRes.winner,
        baselineScores: baselineRes.summary,
        validationResult: baselineRes.validation,
        evidence: await promotionEvidence({
          candidate: evoRes.winner, baselineRes, evoRes, realModel, tasks: promoteTasks || [], trials, stage, role: flags.role, flags, deps,
          judge: { useFrontierJudge, judgeCommittee: useFrontierJudge ? judgeCommittee : undefined, judgeOptions: deps.judgeOptions },
        }),
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

  if (subcommand === 'merge') {
    const res = await mergePromotionPullRequests({
      pr: flags.pr,
      all: Boolean(flags.all),
      dryRun: Boolean(flags['dry-run']),
      repoRoot: deps.repoRoot,
      env: deps.env,
      exec: deps.exec,
      now: deps.now,
    });
    return flags.json ? res : { ...res, report: formatMergeReport(res) };
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

    // A real-model unit is measured on the model suite's tasks for its role: the unit's own task is
    // written for the scripted gateway and has no checks a real mission can be held to.
    const unitTasks = realModel ? selectModelTasks({ role: unit.role }) : [unit.task];
    const unitDeps = {
      ...deps,
      tasks: unitTasks,
      targetMutablePath: unit.targetMutablePath,
      ...(realModel ? { capChecked: true } : {}),
    };
    if (realModel) {
      const generations = Number(flags.generations) || 1;
      const recursion = Number(flags.recursion) || 1;
      note(deps, `[INFO] curriculum unit ${unit.id} (${unit.role}) on ${unitTasks.length} task(s)`);
      const refused = overCap(deps, realModel, estimateRollouts({
        tasks: unitTasks.length, trials, candidates: generations * (2 * recursion + 1), baselines: 2, calibration: true,
      }));
      if (refused) return refused;
    }

    const baselineRes = flags.live || realModel
      ? await evaluateLiveTarget({
          stage: unit.stage,
          role: unit.role,
          tasks: unitTasks,
          repoRoot: deps.repoRoot,
          useFrontierJudge,
          judgeCommittee: useFrontierJudge ? judgeCommittee : undefined,
          judgeOptions: deps.judgeOptions,
          trials,
          realModel,
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

    if (evoRes.paused) return evoRes;
    const readiness = evaluatePromotionReadiness({
      candidate: evoRes.winner,
      baselineScores: baselineRes.summary,
      validationResult: baselineRes.validation,
      evidence: await promotionEvidence({
        candidate: evoRes.winner, baselineRes, evoRes, realModel, tasks: unitTasks, trials, stage: unit.stage, role: unit.role, flags, deps,
        judge: { useFrontierJudge, judgeCommittee: useFrontierJudge ? judgeCommittee : undefined, judgeOptions: deps.judgeOptions },
      }),
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

  if (subcommand === 'health') {
    const repoRoot = deps.repoRoot || process.cwd();
    const repo = typeof flags.repo === 'string' ? flags.repo : undefined;
    const inputs = collectHealthInputs({ repoRoot, repo, execGh: deps.execGh, execGit: deps.execGit, cyclePath: deps.cycleLogPath, env: deps.env });
    const health = loopHealth({ ...inputs, now: deps.now || new Date(), rules: flags.days ? { days: Number(flags.days) } : {} });
    const issues = flags['open-issues']
      ? syncHealthIssues({
          alarms: health.alarms, repoRoot, repo, execGh: deps.execGh, dryRun: Boolean(flags['dry-run']),
          closeCleared: inputs.problems.length === 0, now: deps.now || new Date(),
        })
      : null;
    const markdown = formatHealthMarkdown(health);
    return {
      ok: health.ok && inputs.problems.length === 0,
      ...health,
      problems: inputs.problems,
      ...(issues ? { issues } : {}),
      markdown,
      ...(flags.markdown ? { report: markdown } : {}),
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
    const lab = labPlanFor(flags, { organizationId: flags.org, billingAccount: flags.billing });
    return lab.error ? { ok: false, error: lab.error } : { ok: true, plan: lab.plan };
  }

  if (subcommand === 'lab-provision') {
    const lab = labPlanFor(flags, { intervalMinutes: flags.interval });
    if (lab.error) return { ok: false, error: lab.error };
    return provisionGcpLab({
      ...labOptions(flags),
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
    const lab = labPlanFor(flags);
    if (lab.error) return { ok: false, error: lab.error };
    return inspectGcpLabStatus({ ...labOptions(flags), execGcloud: deps.execGcloud });
  }

  if (subcommand === 'lab-follow-main') {
    const actions = ['install', 'uninstall', 'status'].filter((action) => flags[action]);
    if (actions.length > 1) return { ok: false, error: 'lab-follow-main takes one of --install, --uninstall and --status.' };
    const action = actions[0] || 'status';
    if (flags.interval !== undefined && action !== 'install') return { ok: false, error: '--interval goes with --install.' };
    try {
      return manageLabFollowMain({
        action,
        ...labOptions(flags),
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
