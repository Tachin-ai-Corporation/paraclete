// dev/loop/cycle.mjs: one cycle of the self-improvement loop, as plain code. A cycle takes the oldest
// open GitHub issue labelled `loop` that has no open loop pull request and was not just tried, has a
// proposer (a coding agent: proposer.mjs) change a fresh checkout of main to resolve it, checks the
// change, and opens a pull request, which the loop's merger (merger.mjs) merges once CI and the Loop
// guard pass. Each step is fixed here; the proposer only edits files.
//
//   1. refuse while the harness is paused (dev/harness2/PAUSED), or the loop is (the repository variable
//      PARACLETE_LOOP_PAUSED), or once today's cycles are spent; when CI failed on main because of a loop
//      merge, open its revert and reopen its issue (sentinel.mjs), and change nothing else on a broken main;
//      on a healthy main, release it once the loop's merges since the last release ran healthy on the lab
//      (releaser.mjs, when turned on); bring the loop's open pull requests up to date with main and wait
//      for the merger to merge or close them, and stop when one is still open after `merge.waitMinutes`
//      (one loop change in flight: what is measured now must be measured on the main it lands on); then,
//      when a baseline is due (baseline.mjs, when turned on), measure main's head on the model suite,
//      keep the summary, and stop there;
//   2. pick the issue, and read what its maintainers and earlier attempts said on it and on the loop's
//      closed pull requests for it; give up an issue refused `maxAttempts` times (`loop` becomes
//      `loop-stuck`); when none waits, have the planner (planner.mjs) open one, from a training task the
//      baseline found failing or from the open items;
//   3. check out origin/main on a branch of its own (`loop/<issue>-<slug>`), in a temporary worktree;
//   4. run the proposer on it, within its budget, briefed with the issue and those comments; when the
//      suite fails, run it again on the same checkout with the failing tests, up to `repairRounds`
//      times (the proposer need not choose to run the tests itself: the cycle does, and says what failed);
//   5. refuse a change that touches the referee (config.mjs), changes or removes an existing test,
//      changes code without adding a test, or fails the suite; then commit it, and refuse it unless a
//      reviewer model (reviewer.mjs) finds it meets every point the issue says it is done when; a change
//      to the agent's behaviour must also be measured on both sides with real-model runs
//      (dev/harness2 `eval --real-model`) and must not make any task worse, and one for an issue planned
//      from a failing task must make that task score higher;
//   6. commit it under the next free version, push the branch and open the pull request, with the
//      tests' result and any evidence; or, when refused, say why on the issue, naming the files it
//      changed and the tests that failed, which the next attempt reads;
//   7. record the cycle in .local/harness2/cycles.jsonl, which the health check reads.
//
// It never merges or changes an instance. Run by hand or by the driver's timer (timer.mjs):
//
//   node dev/loop/cycle.mjs [--issue <n> [--retry]] [--repo <owner/name>] [--dry-run] [--json]
//
// `--retry` tries the named issue even when it failed within `retryAfterHours`.
//
// Exit codes: 0 the cycle ran to an outcome (opened, refused, nothing to do, paused), 1 it broke,
// 2 a usage mistake.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_EVIDENCE_RULES, buildPromotionEvidence, formatEvidenceMarkdown } from '../harness2/evidence.mjs';
import { appendCycleRecord, cycleRecord, readCycleRecords } from '../harness2/health.mjs';
import { MODEL_SUITE_VERSION, selectModelTasks } from '../harness2/model-suite.mjs';
import { pauseState } from '../harness2/pause.mjs';
import { ROLLOUT_RETRY } from '../harness2/substrate.mjs';
import { nextPromotionVersion } from '../harness2/promote.mjs';
import { isBehaviourPath, loadLoopSettings, pathRefusal, testRefusal } from './config.mjs';
import { impactedTasks, issueModule, loadModules, moduleProblems } from './modules.mjs';
import { STUCK_LABEL, isCurrentBaseline, planIssue } from './planner.mjs';
import {
  MEASURED_BASE_MARKER, baselineDue, failingTasks, issueTarget, readBaseline, summarizeBaseline, targetProblems, writeBaseline,
} from './baseline.mjs';
import { checkMain, loopPauseReason } from './sentinel.mjs';
import { releaseIfDue } from './releaser.mjs';
import { devContext } from '../dev-env.mjs';
import { buildBrief, buildRepairBrief, createCommandProposer } from './proposer.mjs';
import { buildReviewBrief, createCommandReviewer, doneWhen, formatReviewMarkdown, judgeReview } from './reviewer.mjs';
import { failingTests, failureLines, REPORT_LIMITS, withoutRoots } from './test-report.mjs';

/** Outcomes after a proposer ran: they count toward the day's cycles. */
const ATTEMPTED = new Set(['proposer-failed', 'no-change', 'refused-paths', 'untested', 'tests-failed', 'unreviewed', 'rejected', 'unmeasured', 'regressed', 'unimproved', 'ready', 'opened']);

/** Outcomes that leave an issue alone until `retryAfterHours` have passed. */
const FAILED = new Set(['proposer-failed', 'no-change', 'refused-paths', 'untested', 'tests-failed', 'unreviewed', 'rejected', 'unmeasured', 'regressed', 'unimproved']);

/** Packages a checkout borrows from the repo, never part of a change. */
const LINKED_PACKAGES = Object.freeze(['agent/node_modules', 'dashboard/node_modules']);

/** Whose comments on an issue a proposer is shown: people with a hand in this repository. On a public
 * repository anyone can comment, and a stranger's comment must not steer the proposer. */
const TRUSTED_COMMENTERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** The login this repository's own workflows comment as, the loop's merger among them: only a workflow
 * of this repository can comment as it here. */
const TRUSTED_BOTS = new Set(['github-actions', 'github-actions[bot]']);

/** How many of those comments the brief carries, newest kept, and how much of each: enough for a
 * refusal that lists its most failing tests (test-report.mjs REPORT_LIMITS). */
const NOTE_LIMITS = Object.freeze({ count: 5, chars: 4000 });

const HOUR_MS = 3_600_000;

function defaultExec(file) {
  return (args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A branch-safe slug of an issue title. */
export function slugFor(title) {
  return String(title || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '') || 'change';
}

/** The changes staged in a checkout against `base`: [{ status, path, oldPath? }]. */
export function parseNameStatus(text) {
  return String(text || '').split('\n').filter(Boolean).map((line) => {
    const [code, a, b] = line.split('\t');
    const status = code[0];
    return status === 'R' || status === 'C' ? { status, path: b, oldPath: a } : { status, path: a };
  });
}

/**
 * The tasks a measurement shows worse on the change by more than the evidence rules' task tolerance,
 * before any test of noise: each is run more times on both sides before the change is judged
 * (defaultMeasure). Pure.
 *
 * @param {object|null} evidence  buildPromotionEvidence's result
 * @param {object} [rules]
 * @returns {string[]} task ids
 */
export function worseTasks(evidence, rules = DEFAULT_EVIDENCE_RULES) {
  const r = { ...DEFAULT_EVIDENCE_RULES, ...rules };
  return (evidence?.perTask || [])
    .filter((t) => t.baseline?.n && t.candidate?.n && t.candidate.mean < t.baseline.mean - r.taskTolerance)
    .map((t) => t.taskId);
}

/** The standard error of the difference of two means, from each side's { n, sd }. */
const standardError = (b, c) => Math.sqrt((b.sd ?? 0) ** 2 / b.n + (c.sd ?? 0) ** 2 / c.n);

/**
 * Why the evidence does not measure what it must, if it does not: it was measured on another suite or
 * another version of it, or a task of the active suite (`taskIds`) has no run on one side. Without
 * this, evidence of a few tasks would pass for evidence of all. Pure.
 *
 * @param {object|null} evidence  buildPromotionEvidence's result
 * @param {string[]} [taskIds]    the tasks it must cover; default every active model-suite task
 * @returns {string[]}
 */
export function coverageProblems(evidence, taskIds = selectModelTasks().map((t) => t.id)) {
  if (!evidence) return ['there is no evidence'];
  const problems = [];
  if (evidence.suite?.name !== 'model' || evidence.suite?.version !== MODEL_SUITE_VERSION) {
    const was = evidence.suite ? `${evidence.suite.name} v${evidence.suite.version}` : 'no suite';
    problems.push(`its evidence was measured on ${was}, not the model suite v${MODEL_SUITE_VERSION}`);
  }
  const ran = new Map((evidence.perTask || []).map((t) => [t.taskId, t]));
  const missing = taskIds.filter((id) => !(ran.get(id)?.baseline?.n > 0 && ran.get(id)?.candidate?.n > 0));
  if (missing.length) problems.push(`its evidence has no runs on both sides of ${missing.join(', ')}`);
  return problems;
}

/**
 * Why the measured evidence shows the change made the agent worse, if it does: the runs were not
 * real-model runs, too few, or a task, the held-out tasks or the whole suite lost capability beyond
 * the evidence rules' tolerances and beyond run-to-run noise (`noiseZ` standard errors of the
 * difference), so one unlucky run does not refuse a change. A change need not improve the suite (a fix
 * may not show there); it must not make it worse. Pure.
 *
 * @param {object|null} evidence  buildPromotionEvidence's result
 * @param {object} [rules]
 * @returns {string[]}
 */
export function regressionProblems(evidence, rules = DEFAULT_EVIDENCE_RULES) {
  const r = { ...DEFAULT_EVIDENCE_RULES, ...rules };
  if (!evidence) return ['there is no measurement'];
  const problems = [];
  if (!evidence.measured) problems.push('some runs were not real-model runs of their own side');
  const trials = Math.min(evidence.trials?.baseline ?? 0, evidence.trials?.candidate ?? 0);
  if (trials < r.minTrials) problems.push(`a task ran only ${trials} time(s) on one side; ${r.minTrials} are needed`);
  for (const t of evidence.perTask || []) {
    if (!t.baseline?.n || !t.candidate?.n) continue;
    const drop = t.baseline.mean - t.candidate.mean;
    const se = standardError(t.baseline, t.candidate);
    if (drop > r.taskTolerance && drop > r.noiseZ * se) {
      problems.push(`task ${t.taskId} got worse: capability ${t.baseline.mean} -> ${t.candidate.mean} (${t.baseline.n} and ${t.candidate.n} runs), beyond its noise (${r.noiseZ} x ${Number(se.toFixed(4))})`);
    }
  }
  const h = evidence.holdout;
  if (h?.baseline?.n && h?.candidate?.n) {
    const drop = h.baseline.mean - h.candidate.mean;
    const se = standardError(h.baseline, h.candidate);
    if (drop > r.holdoutTolerance && drop > r.noiseZ * se) {
      problems.push(`the held-out tasks got worse: capability ${h.baseline.mean} -> ${h.candidate.mean}, beyond their noise (${r.noiseZ} x ${Number(se.toFixed(4))})`);
    }
  }
  const delta = evidence.capability?.delta ?? 0;
  const noise = evidence.capability?.noise ?? 0;
  if (delta < -r.minGain && delta < -r.noiseZ * noise) problems.push(`the suite's capability fell by ${-delta}, beyond its noise (${noise})`);
  return problems;
}

/** Links the repo's installed packages into a checkout, so its tests and commands run. */
function linkPackages(repoRoot, root) {
  const links = [];
  for (const rel of LINKED_PACKAGES) {
    const target = path.join(repoRoot, rel);
    const link = path.join(root, rel);
    if (fs.existsSync(target) && !fs.existsSync(link)) {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      links.push(link);
    }
  }
  return links;
}

/** Removes a checkout, its links first, so removing it never reaches into the repo's packages. */
function removeCheckout({ repoRoot, root, links, execGit }) {
  for (const link of links) {
    try {
      fs.unlinkSync(link);
    } catch {
      try {
        fs.rmdirSync(link);
      } catch {
        // already gone
      }
    }
  }
  try {
    execGit(['worktree', 'remove', '--force', root], repoRoot);
  } catch {
    // removed below
  }
  fs.rmSync(root, { recursive: true, force: true });
  try {
    execGit(['worktree', 'prune'], repoRoot);
  } catch {
    // nothing to prune
  }
}

/** The suite, in the checkout: its exit code decides, its summary lines go in the pull request. */
function defaultRunTests({ worktree, settings }) {
  const [cmd, ...args] = settings.testCommand;
  // A suite started under a test runner reports to it instead of exiting with its result.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(cmd, args, {
    cwd: worktree,
    encoding: 'utf8',
    timeout: settings.testTimeoutMinutes * 60_000,
    shell: process.platform === 'win32',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const summary = out.split('\n').filter((l) => /^ℹ (tests|pass|fail|skipped) /.test(l)).join(', ') || out.trim().split('\n').slice(-3).join(' ');
  let real = worktree;
  try {
    real = fs.realpathSync(worktree);
  } catch {
    // the checkout's own path is used as it is
  }
  const failures = failingTests(withoutRoots(out, [worktree, real]));
  return { ok: res.status === 0, summary: res.error ? `${res.error.message}` : summary, failures };
}

/**
 * The comments the proposer is shown: its maintainers', on the issue (which include the loop's own
 * refusals of earlier attempts) and on the loop's closed pull requests for it (a reviewer's reasons for
 * closing one), oldest first and the newest few only. Pure.
 *
 * @param {object[]} comments  as `gh issue view --json comments` gives them; one from a pull request
 *                             carries `on` ('#40')
 * @returns {{ at: string, author: string, body: string, on: string|null }[]}
 */
export function trustedNotes(comments) {
  return (comments || [])
    .filter((c) => (TRUSTED_COMMENTERS.has(String(c.authorAssociation || '').toUpperCase()) || TRUSTED_BOTS.has(String(c.author?.login || '')))
      && String(c.body || '').trim())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-NOTE_LIMITS.count)
    .map((c) => ({ at: c.createdAt, author: c.author?.login || 'unknown', body: String(c.body || '').trim().slice(0, NOTE_LIMITS.chars), on: c.on || null }));
}

/**
 * The comments and reviews on the loop's earlier pull requests for one issue, shaped as issue comments
 * with `on` naming the pull request. Pure.
 *
 * @param {object[]} pullRequests  as `gh pr list --json number,headRefName,comments,reviews` gives them
 * @param {string} prefix          the issue's branch prefix: `loop/<issue>-`
 * @returns {object[]}
 */
/** A lane's module id as a branch name may hold it: organ:cerebellum is organ-cerebellum. */
export function laneSlug(lane) {
  return String(lane || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

/**
 * The branch a cycle works on: `<prefix><issue>-<slug>` for the global loop, and
 * `<prefix>m/<lane>/<issue>-<slug>` in a lane, so each lane's pull requests can be told apart.
 */
export function branchFor({ prefix, issue, lane = null }) {
  return `${prefix}${lane ? `m/${laneSlug(lane)}/` : ''}${issue.number}-${slugFor(issue.title)}`;
}

/**
 * Where a loop branch belongs: its issue, and its lane's slug ('' for the global loop's). Null for
 * any other branch, a revert's among them.
 *
 * @returns {{ issue: number, lane: string }|null}
 */
export function branchOwner(name, prefix) {
  const rest = String(name || '').startsWith(prefix) ? String(name).slice(prefix.length) : null;
  const m = rest === null ? null : /^(?:m\/([a-z0-9-]+)\/)?(\d+)-/.exec(rest);
  return m ? { issue: Number(m[2]), lane: m[1] || '' } : null;
}

/**
 * The comments and reviews on the loop's earlier pull requests: for one issue (`issueNumber`, in any
 * lane), or every one on a branch under `prefix`.
 */
export function pullRequestComments(pullRequests, prefix, issueNumber = null) {
  return (pullRequests || [])
    .filter((p) => (issueNumber === null ? String(p.headRefName || '').startsWith(prefix) : branchOwner(p.headRefName, prefix)?.issue === issueNumber))
    .flatMap((p) => [
      ...(p.comments || []),
      ...(p.reviews || []).map((r) => ({ ...r, createdAt: r.submittedAt || r.createdAt })),
    ].map((c) => ({ ...c, on: `#${p.number}` })));
}

/** A refusal, as the comment it leaves on the issue: why, what the attempt changed, what failed, and
 * what its reviewer found unmet. */
export function refusalComment({ action, reason, changes, tests, review, retryAfterHours }) {
  return [
    `The self-improvement loop tried this and stopped (${action}): ${reason}`,
    ...(changes?.length ? ['', `It changed: ${changes.map((c) => `\`${c.path}\` (${c.status})`).join(', ')}.`] : []),
    ...(tests?.failures?.length ? ['', 'Failing tests:', ...failureLines(tests.failures)] : []),
    ...(review?.review ? ['', "The reviewer's verdict:", formatReviewMarkdown(review.review, review.items)] : []),
    '',
    `It tries again after ${retryAfterHours} hours.`,
  ].join('\n');
}

/**
 * Both sides of a measurement, through `evalOn(side, args)` (side 'baseline' or 'candidate'; args those
 * of dev/harness2 `eval --real-model`): every task the change reaches (modules.mjs impactedTasks: a
 * role's files reach only that role's tasks) `measure.trials` times (a target task
 * `measure.targetTrials` times), then more runs of each task that looks worse, and the evidence.
 * defaultMeasure runs it on two clones.
 *
 * The sides take turns, task by task, the first side alternating: a measurement takes hours, and the
 * model's latency and quota drift over them, so one side run wholly before the other met different
 * conditions. Each task's call may run each rollout again on an infrastructure error
 * (dev/harness2/substrate.mjs ROLLOUT_RETRY), and its cap leaves room for that. A run still not
 * evaluated is left out, and the share of those is judged over the whole side, not one task's call:
 * one call holds only a few runs, so one bad run would be past the share there.
 *
 * @param {object} o  { evalOn, issue, changedPaths, settings, taskIds, log }
 * @returns {Promise<{ measured: boolean, evidence?: object, reason: string|null }>}
 */
export async function measureSides({ evalOn, issue, changedPaths, settings, taskIds = impactedTasks(changedPaths), log = () => {} }) {
  if (!taskIds.length) return { measured: false, reason: 'no model-suite task runs what it changes (a role without tasks of its own)' };
  const target = issueTarget(issue.body);
  const runsOf = (id) => (id === target ? Math.max(settings.measure.trials, settings.measure.targetTrials || 0) : settings.measure.trials);
  const planned = taskIds.reduce((n, id) => n + runsOf(id), 0);
  if (planned > settings.measure.maxRollouts) {
    return { measured: false, reason: `a side needs ${planned} runs, over measure.maxRollouts (${settings.measure.maxRollouts})` };
  }
  const evalTask = (side, ids, trials) => evalOn(side, [
    'eval', '--real-model', '--task', ids.join(','), '--trials', String(trials), '--max-rollouts', String(trials * ids.length * ROLLOUT_RETRY.attempts),
  ]);
  const runs = { baseline: [], candidate: [] };
  const skipped = { baseline: [], candidate: [] };
  const cannot = (side, why) => (side === 'baseline' ? `main's head could not be measured: ${why}` : `the change could not be measured: ${why}`);
  for (const [i, id] of taskIds.entries()) {
    for (const side of i % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const res = await evalTask(side, [id], runsOf(id));
      // A call too few of whose runs ran is still kept: the side as a whole is judged below.
      if (!res.ok && !res.incomplete) return { measured: false, reason: cannot(side, res.reason || 'no result') };
      runs[side].push(...(res.trajectories || []));
      skipped[side].push(...(res.notEvaluated || []));
    }
  }
  for (const side of ['baseline', 'candidate']) {
    if (skipped[side].length > planned * ROLLOUT_RETRY.maxNotEvaluatedShare) {
      const why = `${skipped[side].length} of ${planned} runs failed on infrastructure and were not evaluated: ${skipped[side][0].reason}`;
      return { measured: false, reason: cannot(side, why) };
    }
  }
  const baseline = { trajectories: runs.baseline };
  const candidate = { trajectories: runs.candidate };
  const judged = (b, c) => buildPromotionEvidence({
    candidate: { id: `loop-${issue.number}`, lens: 'LOOP', touchedPaths: changedPaths, proposal: { source: 'coding-agent', hypothesis: issue.title } },
    baselineTrajectories: b,
    candidateTrajectories: c,
    suite: { name: 'model', version: MODEL_SUITE_VERSION },
  });
  let evidence = judged(baseline.trajectories, candidate.trajectories);
  // A task that looks worse runs more times on both sides before the change is judged on it: one
  // unlucky run in three is no regression.
  const confirm = Math.max(0, (settings.measure.confirmTrials || 0) - settings.measure.trials);
  const recheck = confirm ? worseTasks(evidence).filter((id) => runsOf(id) < settings.measure.confirmTrials) : [];
  if (recheck.length) {
    log(`[INFO] loop: ${recheck.join(', ')} looked worse; running each ${confirm} more time(s) on both sides`);
    const moreBase = await evalTask('baseline', recheck, confirm);
    if (!moreBase.ok) return { measured: false, reason: `main's head could not be measured again on ${recheck.join(', ')}: ${moreBase.reason || 'no result'}` };
    const moreCand = await evalTask('candidate', recheck, confirm);
    if (!moreCand.ok) return { measured: false, reason: `the change could not be measured again on ${recheck.join(', ')}: ${moreCand.reason || 'no result'}` };
    const later = (runs) => runs.map((t) => ({ ...t, trial: t.trial + runsOf(t.taskId) }));
    evidence = judged([...baseline.trajectories, ...later(moreBase.trajectories)], [...candidate.trajectories, ...later(moreCand.trajectories)]);
  }
  return { measured: Boolean(evidence.measured), evidence, reason: evidence.measured ? null : 'some runs were not real-model runs' };
}

/**
 * The measurement of a behaviour change: the model suite run on main's head and on the change, with
 * real-model runs (dev/harness2 `eval --real-model`), as promotion evidence. For an issue planned from a
 * failing task, that task runs `measure.targetTrials` times on each side, so whether it improved beyond
 * noise can be told; a task that looks worse runs `measure.confirmTrials` times on each side before the
 * change is judged on it (extra runs also weigh in the suite's mean).
 */
async function defaultMeasure({ repoRoot, base, candidateRoot, changedPaths, issue, settings, execGit, log }) {
  const sides = [];
  try {
    // Both sides are measured in clones of their own, never in worktrees of this repo: a measured run
    // is an agent running model-chosen commands for hours, and through a worktree's shared .git it
    // could reach this repo, or the cycle's own checkout (one lost its registration that way).
    const baseSide = isolatedCheckout({ repoRoot, commit: base, execGit, prefix: 'paraclete-loop-base-' });
    sides.push(baseSide);
    const candidateSide = isolatedCheckout({ repoRoot, commit: execGit(['rev-parse', 'HEAD'], candidateRoot), execGit, prefix: 'paraclete-loop-measure-' });
    sides.push(candidateSide);
    const { runCli } = await import('../harness2/cli.mjs');
    const stderr = { write: (line) => log(String(line).trimEnd()) };
    return await measureSides({
      evalOn: (side, args) => runCli(args, { repoRoot: side === 'baseline' ? baseSide.root : candidateSide.root, stderr }),
      issue, changedPaths, settings, log,
    });
  } catch (err) {
    return { measured: false, reason: err.message };
  } finally {
    for (const side of sides) removeIsolated(side);
  }
}

/**
 * The evaluation a baseline is: every task `baseline.trials` times, then every training task that
 * failed a check run again until it has `baseline.confirmTrials` runs, through `evalOn(args)` (the args
 * of dev/harness2 `eval --real-model`). A check that failed once in two runs is half of them, which
 * is enough to plan an issue from (failingTasks), and two of the three tasks the loop had targeted were
 * such chance failures, each costing a measurement of hours; with the extra runs, a check must fail
 * in half of six. Returns runCli's result, the extra runs numbered after the first ones.
 *
 * @param {object} o  { evalOn, settings, log }
 * @returns {Promise<object>}
 */
export async function runBaselineEval({ evalOn, settings, log = () => {} }) {
  const { trials, maxRollouts, confirmTrials = 0 } = settings.baseline;
  const ran = await evalOn(['eval', '--real-model', '--trials', String(trials), '--max-rollouts', String(maxRollouts)]);
  const more = Math.max(0, confirmTrials - trials);
  if (!ran?.ok || !more) return ran;
  const suspects = failingTasks(summarizeBaseline(ran)).map((t) => t.id);
  if (!suspects.length) return ran;
  log(`[INFO] loop: ${suspects.join(', ')} failed a check; running each ${more} more time(s) before planning from it`);
  const again = await evalOn([
    'eval', '--real-model', '--task', suspects.join(','), '--trials', String(more), '--max-rollouts', String(more * suspects.length * ROLLOUT_RETRY.attempts),
  ]);
  if (!again?.ok) return { ok: false, reason: `the failing tasks' extra runs: ${again?.reason || 'no result'}` };
  return {
    ...ran,
    trajectories: [...ran.trajectories, ...again.trajectories.map((t) => ({ ...t, trial: t.trial + trials }))],
    notEvaluated: [...(ran.notEvaluated || []), ...(again.notEvaluated || [])],
  };
}

/**
 * A baseline: runBaselineEval on main's head, in a clone of its own, as defaultMeasure runs each side.
 */
async function defaultBaseline({ repoRoot, head, settings, execGit, log }) {
  let side = null;
  try {
    side = isolatedCheckout({ repoRoot, commit: head, execGit, prefix: 'paraclete-loop-baseline-' });
    const { runCli } = await import('../harness2/cli.mjs');
    const stderr = { write: (line) => log(String(line).trimEnd()) };
    return await runBaselineEval({ evalOn: (args) => runCli(args, { repoRoot: side.root, stderr }), settings, log });
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    if (side) removeIsolated(side);
  }
}

/** The temporary checkouts a cycle and a measured run make, by the prefix of their directory's name. */
const CHECKOUT_PREFIXES = Object.freeze(['paraclete-loop-', 'paraclete-h2-side-', 'paraclete-h2-src-']);

/**
 * Removes the repo's registered worktrees a killed cycle left behind (temporary checkouts named with
 * CHECKOUT_PREFIXES), links first, and prunes. Any error leaves the rest as it was.
 */
export function clearStaleCheckouts({ repoRoot, execGit, log = () => {} }) {
  let listing = '';
  try {
    listing = execGit(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return [];
  }
  const stale = listing.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim())
    .filter((p) => CHECKOUT_PREFIXES.some((prefix) => path.basename(p).startsWith(prefix)));
  for (const root of stale) {
    log(`[INFO] loop: removing ${root}, left by a cycle that did not finish`);
    const links = LINKED_PACKAGES.map((rel) => path.join(root, rel)).filter((l) => {
      try {
        return fs.lstatSync(l).isSymbolicLink();
      } catch {
        return false;
      }
    });
    removeCheckout({ repoRoot, root, links, execGit });
  }
  return stale;
}

/**
 * The loop's open pull requests (from `branchPrefix` branches, reverts among them), settled before a
 * cycle measures anything. Each is brought up to date with main (main merged into it, as the user this
 * runs as, so its CI and the Loop guard run again: the merger waits for that rather than close it; one
 * current already, or in conflict, which the merger closes, is left as it is). Then the cycle waits for
 * the merger to merge or close them, looking every `merge.pollMinutes` for at most `merge.waitMinutes`.
 * A change measured while one is open would be measured against a main its merge moves, and the guard
 * refuses such a change once it does (its loop-measured-base). A state that cannot be read counts as
 * open. A dry run updates nothing and waits for nothing.
 *
 * @param {object} o  { repoRoot, repo, settings, execGh, dryRun, sleep, log }
 * @returns {Promise<{ open: number[] }>} the loop's pull requests still open when the wait ran out
 */
export async function settleLoopPullRequests({ repoRoot, repo, settings, execGh, dryRun = false, sleep, lane = null, log = () => {} }) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const listed = JSON.parse(execGh(['pr', 'list', ...repoArgs, '--state', 'open', '--json', 'number,headRefName,title', '--limit', '200'], repoRoot) || '[]');
  // A lane waits for its own pull requests and for reverts: another lane's change reaches other files,
  // and the Loop guard refuses one whose measurement main's merges made stale. The global loop, whose
  // changes are not scoped, waits for every loop pull request.
  const waitsFor = (name) => {
    if (!String(name || '').startsWith(settings.branchPrefix)) return false;
    if (!lane) return true;
    const owner = branchOwner(name, settings.branchPrefix);
    return !owner || owner.lane === laneSlug(lane);
  };
  let open = listed.filter((p) => waitsFor(p.headRefName)).map((p) => p.number);
  if (!open.length) return { open };
  if (dryRun) {
    log(`[INFO] loop: a dry run: ${open.map((n) => `#${n}`).join(', ')} would be brought up to date and waited for`);
    return { open: [] };
  }
  for (const n of open) {
    try {
      execGh(['api', '-X', 'PUT', `repos/${repo || '{owner}/{repo}'}/pulls/${n}/update-branch`], repoRoot);
      log(`[INFO] loop: brought #${n} up to date with main`);
    } catch {
      // current already, or in conflict
    }
  }
  const stillOpen = (n) => {
    try {
      const { state } = JSON.parse(execGh(['pr', 'view', String(n), ...repoArgs, '--json', 'state'], repoRoot) || '{}');
      return !state || state === 'OPEN';
    } catch {
      return true;
    }
  };
  const polls = Math.max(1, Math.ceil(settings.merge.waitMinutes / settings.merge.pollMinutes));
  for (let i = 0; ; i += 1) {
    open = open.filter(stillOpen);
    if (!open.length || i >= polls) break;
    if (i === 0) log(`[INFO] loop: waiting up to ${settings.merge.waitMinutes} minutes for ${open.map((n) => `#${n}`).join(', ')} to be merged or closed`);
    await sleep(settings.merge.pollMinutes * 60_000);
  }
  return { open };
}

/**
 * A checkout of `commit` that shares nothing git writes with the repo: a clone that borrows the repo's
 * objects (`--shared`), detached at the commit, with the repo's packages linked in. Whatever runs in it,
 * or in worktrees made from it, cannot reach the repo's refs, index or worktrees.
 *
 * @returns {{ root: string, links: string[] }}
 */
export function isolatedCheckout({ repoRoot, commit, execGit, prefix }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execGit(['clone', '--quiet', '--shared', '--no-checkout', repoRoot, root], repoRoot);
  execGit(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], root);
  return { root, links: linkPackages(repoRoot, root) };
}

/** Removes an isolated checkout, its links first, so removing it never reaches into the repo's packages. */
function removeIsolated({ root, links }) {
  for (const link of links) {
    try {
      fs.unlinkSync(link);
    } catch {
      try {
        fs.rmdirSync(link);
      } catch {
        // already gone
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * The review of a committed change: the reviewer's verdict on every point the issue says it is done
 * when, the decision on it, and a refusal when the review altered the checkout. A reviewer that cannot
 * start or answer leaves the change unreviewed.
 *
 * @returns {Promise<{ items: string[], review: object|null, ok: boolean, unmet: object[], problems: string[], reason: string|null }>}
 */
async function reviewChange({ issue, changes, tests, summary, base, worktree, settings, reviewer, execGit }) {
  const items = doneWhen(issue);
  let diff;
  try {
    diff = execGit(['diff', base, 'HEAD'], worktree);
  } catch {
    diff = '(the diff could not be read: read the changed files)';
  }
  const brief = buildReviewBrief({ issue, items, changes, diff, tests, summary, maxDiffChars: settings.reviewer.maxDiffChars });
  // What git sees in the checkout before the review (the linked packages, where .gitignore does not
  // cover a link) is not the review's doing; anything it sees after, beyond that, is.
  const before = new Set(execGit(['status', '--porcelain'], worktree).split('\n').filter(Boolean));
  let run;
  try {
    run = await (reviewer || createCommandReviewer(settings.reviewer))({ worktree, brief, items });
  } catch (err) {
    run = { review: null, reason: err.message };
  }
  const touched = execGit(['status', '--porcelain'], worktree).split('\n').filter((l) => l && !before.has(l));
  if (touched.length) return { items, review: null, ok: false, unmet: [], problems: [], reason: `the review changed the checkout (${touched.length} path(s))` };
  if (!run.review) return { items, review: null, ok: false, unmet: [], problems: [], reason: run.reason || 'the reviewer gave no verdict' };
  // What was reviewed: each changed path's blob at the committed change, so a merger can tell the change
  // it merges is this one (guard.mjs).
  const files = Object.fromEntries(changes.flatMap((c) => [
    [c.path, c.status === 'D' ? null : execGit(['rev-parse', `HEAD:${c.path}`], worktree)],
    ...(c.oldPath ? [[c.oldPath, null]] : []),
  ]));
  return { items, review: run.review, files, reason: null, ...judgeReview(run.review, items) };
}

/** The day's cycles that ran a proposer, the issues tried and failed lately, and each issue's refused
 * attempts, from the cycle log. */
function pastCycles(records, now, retryAfterHours, lane = null) {
  const day = now.toISOString().slice(0, 10);
  // A dry run spends nothing a person would count, and refuses nothing for good. Each lane counts its
  // own cycles: one lane's busy day does not spend another's.
  const loop = records.filter((c) => c.command === 'loop' && c.loop && !c.loop.dryRun && (c.loop.lane ?? null) === lane);
  const attempts = new Map();
  for (const c of loop.filter((r) => FAILED.has(r.loop.action))) attempts.set(c.loop.issue, (attempts.get(c.loop.issue) || 0) + 1);
  return {
    attempts,
    today: loop.filter((c) => String(c.at).slice(0, 10) === day && ATTEMPTED.has(c.loop.action)).length,
    recentlyFailed: new Set(loop
      .filter((c) => FAILED.has(c.loop.action) && now.getTime() - Date.parse(c.at) < retryAfterHours * HOUR_MS)
      .map((c) => c.loop.issue)),
  };
}

function pullRequestBody({ issue, summary, changes, tests, review, behaviour, measurement, version, base }) {
  return [
    `Resolves #${issue.number}.`,
    '',
    'Opened by the self-improvement loop (`dev/loop/cycle.mjs`), after its checks and its reviewer passed the change. It waits to be merged.',
    '',
    '## What the proposer did',
    '',
    summary || '(it gave no summary)',
    '',
    '## Checks',
    '',
    `- **Changed**: ${changes.map((c) => `\`${c.path}\` (${c.status})`).join(', ')}`,
    `- **Tests**: passed (${tests.summary})`,
    '- **Review**: every point the issue says the change is done when was found met (`dev/loop/reviewer.mjs`):',
    '',
    formatReviewMarkdown(review.review, review.items, review.files),
    '',
    `- **Behaviour**: ${behaviour ? 'changed, so measured on both sides with real-model runs; no task, the held-out tasks nor the suite got worse' : 'not changed (nothing the running agent reads)'}`,
    ...(measurement?.evidence ? ['', formatEvidenceMarkdown(measurement.evidence), '', `<!-- ${MEASURED_BASE_MARKER}: ${base} -->`] : []),
    '',
    '## Merging',
    `Squash and merge, keeping the title, so \`${version}\` becomes main's head.`,
  ].join('\n');
}

/**
 * One cycle. Every dependency can be passed in; tests pass git against a local origin, a fake gh, a
 * fake proposer, a fake test run and a fake measurement.
 *
 * @param {object} [o]
 * @returns {Promise<object>} { action, reason, issue, branch, pullRequest, ... }
 */
export async function runCycle({
  repoRoot = process.cwd(),
  repo,
  issueNumber = null,
  retry = false,
  lane = null,
  dryRun = false,
  now = new Date(),
  env = process.env,
  settings = loadLoopSettings({ repoRoot }),
  execGit = defaultExec('git'),
  execGh = defaultExec('gh'),
  proposer,
  reviewer,
  planner,
  release = (o) => releaseIfDue(o),
  baseline = defaultBaseline,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  runTests = defaultRunTests,
  measure = defaultMeasure,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const records = readCycleRecords({ repoRoot });
  let result = { action: 'no-work', reason: null, issue: null, branch: null, pullRequest: null };
  let base = null;
  const finish = (fields) => {
    result = { ...result, ...fields };
    {
      try {
        appendCycleRecord({
          ...cycleRecord({
            command: 'loop',
            flags: { 'real-model': Boolean(result.measurement?.measured), unit: result.issue ? `#${result.issue}` : null },
            commit: base,
            // When the cycle ended, never before it started: a measured cycle runs for hours, and the
            // retry wait and the day's count are reckoned from its record.
            now: new Date(Math.max(clock(), now.getTime())),
            result: {
              ok: !FAILED.has(result.action) && !['capped', 'baseline-failed'].includes(result.action),
              paused: result.action === 'paused',
              reason: result.reason,
              readiness: result.measurement?.evidence ? { evidence: result.measurement.evidence } : null,
              pullRequest: result.pullRequest ? { prUrl: result.pullRequest } : null,
            },
          }),
          loop: {
            ...(lane ? { lane } : {}),
            issue: result.issue, action: result.action, branch: result.branch, changed: (result.changes || []).map((c) => c.path),
            tests: result.tests?.ok ?? null, repairs: result.repairs ?? 0, reviewed: result.review ? Boolean(result.review.ok) : null,
            ...(result.planned ? { planned: true } : {}),
            ...(result.released ? { released: result.released } : {}),
            ...(result.baseline ? { baseline: result.baseline } : {}),
            behaviour: result.behaviour ?? null, measured: result.measurement?.measured ?? null, dryRun,
            ...(result.tests?.failures?.length
              ? { failures: result.tests.failures.slice(0, REPORT_LIMITS.failures).map(({ file, line, name }) => ({ file, line, name })) }
              : {}),
          },
        }, { repoRoot });
      } catch (err) {
        log(`[WARN] could not record the cycle: ${err.message}`);
      }
    }
    return result;
  };

  // 1. The off switch.
  const pause = pauseState({ repoRoot, env });
  if (pause.paused) return finish({ action: 'paused', reason: `the harness is paused: ${pause.reason}` });
  const loopPause = loopPauseReason({ repoRoot, repo, execGh });
  if (loopPause) return finish({ action: 'paused', reason: `the loop is paused: ${loopPause}` });

  // A lane is a module of dev/loop/modules.json with a lane: it takes only the issues that name it.
  if (lane) {
    let known = null;
    try {
      known = loadModules({ files: execGit(['ls-files'], repoRoot).split(/\r?\n/).filter(Boolean) }).find((m) => m.id === lane) || null;
    } catch (err) {
      log(`[WARN] could not read the modules: ${err.message}`);
    }
    if (!known?.lane) return finish({ action: 'no-work', reason: `${lane} is not a module with a lane in dev/loop/modules.json` });
  }

  // What a cycle killed mid-way (by its unit's timeout, say) left: its checkouts, still registered, one
  // holding its branch, which would stop the next cycle on that issue. No other cycle runs now.
  clearStaleCheckouts({ repoRoot, execGit, log });

  // A loop merge that broke main is reverted first, and nothing new is built on a broken main.
  // The global cycle opens the revert; a lane only reads main's state, so two cycles never revert one
  // merge, and stops on a broken main as the global cycle does.
  let health;
  try {
    health = checkMain({ repoRoot, repo, settings, execGit, execGh, now, dryRun: dryRun || Boolean(lane), log, removeCheckout });
  } catch (err) {
    health = { state: 'unknown', reason: err.message };
    log(`[WARN] could not read main's CI: ${err.message}`);
  }
  if (lane && health.state === 'reverting') {
    return finish({ action: 'main-broken', reason: `${String(health.reason).replace(/: a dry run reverts nothing$/, '')}; the global cycle reverts it` });
  }
  if (health.state === 'reverting') return finish({ action: 'reverting', reason: health.reason, pullRequest: health.pullRequest || null });
  if (health.state === 'broken') return finish({ action: 'main-broken', reason: health.reason });

  // The loop's merges reach instances in a release, cut once they ran healthy on the lab: by the global
  // cycle, once, never by each lane.
  if (!lane) try {
    const out = { write: (text) => log(String(text).trimEnd()) };
    const released = await release({ settings, ctx: devContext({ stdout: out, stderr: out }), now, dryRun });
    if (released.action === 'released') {
      log(`[INFO] loop: released ${released.version}`);
      result = { ...result, released: released.version };
    } else {
      log(`[INFO] loop: no release: ${released.reason}`);
    }
  } catch (err) {
    log(`[WARN] the release step broke: ${err.message}`);
  }

  // One loop change in flight: nothing is measured while an earlier one waits to be merged.
  const { open } = await settleLoopPullRequests({ repoRoot, repo, settings, execGh, dryRun, sleep, lane, log });
  if (open.length) {
    const named = open.map((n) => `#${n}`).join(', ');
    return finish({
      action: 'waiting',
      reason: `${named} still ${open.length === 1 ? 'waits' : 'wait'} to be merged or closed after ${settings.merge.waitMinutes} minutes: a change measured now would be measured against a main ${open.length === 1 ? 'its' : 'their'} merge moves`,
    });
  }

  // The agent's own measured weak spots: main's head on the model suite, at most once a day and only
  // after main moved, so the planner can turn a task it fails into an issue. A cycle that measures
  // stops there: a baseline takes hours, and an attempt measured after it could outrun the unit.
  if (settings.baseline.enabled && !lane) {
    let head = null;
    try {
      execGit(['fetch', '--quiet', 'origin', 'main'], repoRoot);
      head = execGit(['rev-parse', 'origin/main'], repoRoot);
    } catch (err) {
      log(`[WARN] could not read main's head for a baseline: ${err.message}`);
    }
    const kept = readBaseline({ repoRoot });
    if (head && baselineDue({ kept, head, now, everyHours: settings.baseline.everyHours })) {
      if (dryRun) {
        log(`[INFO] loop: a dry run: main's head ${head.slice(0, 12)} would be measured on the model suite`);
      } else {
        log(`[INFO] loop: measuring main's head ${head.slice(0, 12)} on the model suite (a baseline)`);
        const ran = await baseline({ repoRoot, head, settings, execGit, log });
        const summary = ran?.ok ? summarizeBaseline(ran, { commit: head, at: now.toISOString() }) : null;
        const reason = !ran?.ok ? `main's head could not be measured: ${ran?.reason || ran?.error || 'no result'}`
          : !summary.measured ? 'some runs of the baseline were not real-model runs' : null;
        writeBaseline({ repoRoot, kept, summary: reason ? null : summary, attempt: { at: now.toISOString(), commit: head, ok: !reason, reason } });
        if (reason) return finish({ action: 'baseline-failed', reason, baseline: { commit: head } });
        const failing = failingTasks(summary).map((t) => t.id);
        return finish({
          action: 'baselined',
          reason: `measured main's head on ${summary.tasks.length} tasks; training tasks failing a check: ${failing.join(', ') || 'none'}`,
          baseline: { commit: head, tasks: summary.tasks.length, failing },
        });
      }
    }
  }

  // The day's cap holds back new attempts, which spend model time. The revert and the release above keep
  // limits of their own (maxRevertsPerDay, release.minHoursBetween), so a spent day stops neither.
  const past = pastCycles(records, now, settings.retryAfterHours, lane);
  if (past.today >= settings.maxCyclesPerDay) {
    return finish({ action: 'capped', reason: `today's ${settings.maxCyclesPerDay} cycles are spent` });
  }

  // 2. The issue: the oldest open one with the label, no open loop pull request, not tried lately.
  const issues = JSON.parse(execGh(['issue', 'list', ...repoArgs, '--label', settings.label, '--state', 'open',
    '--json', 'number,title,body,url,createdAt', '--limit', '100'], repoRoot) || '[]')
    // A lane's issues name its module; the global loop's name none.
    .filter((i) => (issueModule(i.body) || null) === lane)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const openPrs = JSON.parse(execGh(['pr', 'list', ...repoArgs, '--state', 'open', '--json', 'number,headRefName,title', '--limit', '200'], repoRoot) || '[]');
  const busy = (n) => openPrs.some((p) => branchOwner(p.headRefName, settings.branchPrefix)?.issue === n);
  const waiting = (n) => !past.recentlyFailed.has(n) || (retry && n === issueNumber);
  // An issue refused maxAttempts times is given up: what the loop cannot do stops holding it.
  const stuck = issues.filter((i) => (past.attempts.get(i.number) || 0) >= settings.maxAttempts);
  for (const s of stuck) {
    log(`[INFO] loop: giving up #${s.number} after ${past.attempts.get(s.number)} refused attempts`);
    if (dryRun) continue;
    try {
      try {
        execGh(['label', 'create', STUCK_LABEL, ...repoArgs, '--description', 'The self-improvement loop gave this up', '--color', 'B60205'], repoRoot);
      } catch {
        // it exists
      }
      execGh(['issue', 'edit', String(s.number), ...repoArgs, '--remove-label', settings.label, '--add-label', STUCK_LABEL], repoRoot);
      execGh(['issue', 'comment', String(s.number), ...repoArgs, '--body',
        `The self-improvement loop gave this up after ${past.attempts.get(s.number)} refused attempts: it is labelled \`${STUCK_LABEL}\` now, and the loop no longer takes it. Label it \`${settings.label}\` again to have the loop try it anew.`], repoRoot);
    } catch (err) {
      log(`[WARN] could not give up #${s.number}: ${err.message}`);
    }
  }
  // An issue planned from a failing task is resolved once a baseline that still describes main shows
  // that task passing there (a change merged meanwhile fixed it): it is closed, not attempted again.
  const resolved = [];
  const targeted = issues.filter((i) => issueTarget(i.body));
  if (targeted.length) {
    const summary = readBaseline({ repoRoot }).latest;
    if (isCurrentBaseline({ repoRoot, summary, execGit }).current) {
      const failing = new Set(failingTasks(summary).map((t) => t.id));
      const measuredIds = new Set((summary.tasks || []).filter((t) => t.measuredRuns > 0).map((t) => t.id));
      for (const i of targeted) {
        const target = issueTarget(i.body);
        if (failing.has(target) || !measuredIds.has(target)) continue;
        resolved.push(i.number);
        log(`[INFO] loop: #${i.number}'s target ${target} passes on main in the baseline of ${summary.commit.slice(0, 12)}: closing it`);
        if (dryRun) continue;
        try {
          execGh(['issue', 'close', String(i.number), ...repoArgs, '--reason', 'completed', '--comment',
            `The self-improvement loop closed this: the baseline of main at \`${summary.commit.slice(0, 12)}\` (${String(summary.at || '').slice(0, 10)}) shows \`${target}\` passing its checks, so a change merged since resolved it.`], repoRoot);
        } catch (err) {
          log(`[WARN] could not close #${i.number}: ${err.message}`);
        }
      }
    }
  }
  const takeable = (i) => (issueNumber ? i.number === issueNumber : true) && !busy(i.number) && waiting(i.number) && !stuck.includes(i)
    && !resolved.includes(i.number);
  let issue = issues.find(takeable);
  let planned = false;
  let planReason = null;
  // No issue waits: the planner opens one, from a task the baseline found failing or from the open
  // items, and this cycle takes it.
  if (!issue && !issueNumber && !lane && (settings.planner.command || settings.baseline.enabled)) {
    let res;
    try {
      res = await planIssue({ repoRoot, repo, settings, execGh, execGit, planner, dryRun, log });
    } catch (err) {
      res = { issue: null, reason: `the planner broke: ${err.message}` };
    }
    if (res.issue) {
      issue = res.issue;
      planned = true;
    } else {
      planReason = res.reason;
      log(`[INFO] loop: nothing planned: ${res.reason}`);
    }
  }
  if (!issue) {
    return finish({
      action: 'no-work',
      reason: issueNumber
        ? `issue #${issueNumber} is not open with the ${settings.label} label${lane ? ` for ${lane}` : ''}, has an open loop pull request, or was tried lately`
        : `no open ${settings.label} issue ${lane ? `for ${lane} ` : ''}is waiting${planReason ? `, and the planner planned none: ${planReason}` : ''}`,
    });
  }
  result = { ...result, planned };
  const branch = branchFor({ prefix: settings.branchPrefix, issue, lane });
  result = { ...result, issue: issue.number, branch };
  log(`[INFO] loop: issue #${issue.number}: ${issue.title}`);
  const comments = [];
  try {
    comments.push(...(JSON.parse(execGh(['issue', 'view', String(issue.number), ...repoArgs, '--json', 'comments'], repoRoot) || '{}').comments || []));
  } catch (err) {
    log(`[WARN] could not read the comments on #${issue.number}: ${err.message}`);
  }
  try {
    const closed = JSON.parse(execGh(['pr', 'list', ...repoArgs, '--state', 'closed', '--json', 'number,headRefName,comments,reviews', '--limit', '100'], repoRoot) || '[]');
    comments.push(...pullRequestComments(closed, settings.branchPrefix, issue.number));
  } catch (err) {
    log(`[WARN] could not read the loop's earlier pull requests for #${issue.number}: ${err.message}`);
  }
  const notes = trustedNotes(comments);

  // 3. A fresh checkout of main's head, on the cycle's branch.
  execGit(['fetch', '--quiet', '--tags', 'origin', 'main'], repoRoot);
  base = execGit(['rev-parse', 'origin/main'], repoRoot);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'paraclete-loop-'));
  execGit(['worktree', 'add', '--quiet', '-B', branch, worktree, base], repoRoot);
  const links = linkPackages(repoRoot, worktree);
  const refuse = (action, reason, fields = {}) => {
    if (!dryRun) {
      try {
        execGh(['issue', 'comment', String(issue.number), ...repoArgs, '--body',
          refusalComment({ action, reason, changes: fields.changes, tests: fields.tests, review: fields.review, retryAfterHours: settings.retryAfterHours })], repoRoot);
      } catch (err) {
        log(`[WARN] could not comment on #${issue.number}: ${err.message}`);
      }
    }
    return finish({ action, reason, ...fields });
  };

  try {
    // 4. The proposer changes the checkout.
    const budget = settings.proposer;
    const propose = proposer || createCommandProposer(settings.proposer);
    const brief = buildBrief({ issue, notes, testCommand: settings.testCommand, budget });
    let proposal = await propose({ issue, worktree, brief, budget });
    if (!proposal.ok) return refuse('proposer-failed', proposal.reason || 'the proposer failed');

    // 5. What it changed, and whether that may be proposed; and the suite, with repair rounds.
    let changes;
    let tests;
    let repairs = 0;
    for (;;) {
      // The linked packages never count as a change. git refuses a pathspec naming an ignored path, even
      // to exclude it, so they are taken back out of the index after staging, ignored or not.
      execGit(['add', '--all', '--', '.'], worktree);
      execGit(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...LINKED_PACKAGES], worktree);
      changes = parseNameStatus(execGit(['diff', '--cached', '--name-status', '-M', base], worktree));
      if (changes.length === 0) return refuse('no-change', proposal.summary ? `the proposer changed nothing: ${proposal.summary.slice(0, 500)}` : 'the proposer changed nothing', { repairs });
      const refusals = changes.flatMap((c) => [pathRefusal(c.path, c.status), c.oldPath ? pathRefusal(c.oldPath, 'D') : null]).filter(Boolean);
      if (refusals.length) return refuse('refused-paths', refusals.join('; '), { changes, repairs });
      const untested = testRefusal(changes);
      if (untested) return refuse('untested', untested, { changes, repairs });
      // An issue that names its module allows changes to that module's files only (modules.mjs).
      const moduleId = issueModule(issue.body);
      if (moduleId) {
        const files = [...execGit(['ls-files'], worktree).split('\n').filter(Boolean), ...changes.map((c) => c.path)];
        const outside = moduleProblems(changes, moduleId, loadModules({ files }));
        if (outside.length) return refuse('out-of-module', outside.join('; '), { changes, repairs });
      }

      tests = await runTests({ worktree, settings });
      if (tests.ok || repairs >= settings.repairRounds) break;
      repairs += 1;
      log(`[INFO] loop: the suite failed (${tests.summary}); repair round ${repairs} of ${settings.repairRounds}`);
      const repair = await propose({
        issue, worktree, brief: buildRepairBrief({ brief, tests, round: repairs, rounds: settings.repairRounds }), budget,
      });
      if (!repair.ok) return refuse('proposer-failed', `${repair.reason || 'the proposer failed'} (in repair round ${repairs})`, { changes, tests, repairs });
      if (repair.summary) proposal = { ...proposal, summary: repair.summary };
    }
    if (!tests.ok) {
      const after = repairs ? ` after ${repairs} repair round${repairs === 1 ? '' : 's'}` : '';
      return refuse('tests-failed', `the suite failed${after}: ${tests.summary}`, { changes, tests, repairs });
    }

    // 6. Commit under the next free version (main's, the tags', and the open pull requests' titles).
    const subjects = [...execGit(['log', '--format=%s', 'origin/main'], repoRoot).split('\n'), ...openPrs.map((p) => p.title)];
    const tags = execGit(['tag', '--list'], repoRoot).split('\n').filter(Boolean);
    const version = nextPromotionVersion({ subjects, tags, now });
    const title = String(issue.title).replace(/^v\d{4}\.\d{2}\.\d{2}\.\d+\.\d+:\s*/, '');
    const subject = `${version}: ${title}`;
    execGit(['-c', 'user.name=Paraclete loop', '-c', 'user.email=loop@example.com', 'commit', '--quiet', '-m', subject, '-m',
      `Proposed by the self-improvement loop for #${issue.number}.`], worktree);

    // The reviewer judges the committed change against every point the issue says it is done when;
    // code decides on its verdict. It reads the checkout and must leave it as it was.
    const review = await reviewChange({ issue, changes, tests, summary: proposal.summary, base, worktree, settings, reviewer, execGit });
    if (!review.review) return refuse('unreviewed', `the change could not be reviewed: ${review.reason}`, { changes, tests, review });
    if (!review.ok) {
      const unmet = review.unmet.map((u) => `point ${u.n} is not met`).concat(review.problems).join('; ');
      return refuse('rejected', `its reviewer found it does not resolve the issue: ${unmet}`, { changes, tests, review });
    }

    // A change to what the agent reads is measured on both sides, and must not make it worse.
    const behaviour = changes.some((c) => isBehaviourPath(c.path) || (c.oldPath && isBehaviourPath(c.oldPath)));
    let measurement = null;
    if (behaviour) {
      measurement = await measure({
        repoRoot, base, candidateRoot: worktree, changedPaths: changes.map((c) => c.path), issue, settings, execGit, log,
      });
      if (!measurement.measured) return refuse('unmeasured', `it changes the agent's behaviour and could not be measured: ${measurement.reason}`, { changes, tests, behaviour, measurement });
      const uncovered = coverageProblems(measurement.evidence, impactedTasks(changes.flatMap((c) => [c.path, c.oldPath].filter(Boolean))));
      if (uncovered.length) return refuse('unmeasured', `it changes the agent's behaviour and was not measured on the tasks it reaches: ${uncovered.join('; ')}`, { changes, tests, behaviour, measurement });
      const worse = regressionProblems(measurement.evidence);
      if (worse.length) return refuse('regressed', worse.join('; '), { changes, tests, behaviour, measurement });
    }
    // An issue planned from a task main's head fails is resolved only by a change that makes the agent
    // pass more of it: one that changes nothing the agent reads cannot.
    const target = issueTarget(issue.body);
    if (target) {
      const missed = behaviour ? targetProblems(measurement.evidence, target) : [`it changes nothing the agent reads, so it cannot improve the target task ${target}`];
      if (missed.length) return refuse('unimproved', missed.join('; '), { changes, tests, behaviour, measurement });
    }

    const fields = { changes, tests, repairs, review, behaviour, measurement, version, subject };
    if (dryRun) return finish({ action: 'ready', reason: 'a dry run: nothing pushed', ...fields });

    // 7. Push, and open the pull request a person merges.
    execGit(['push', '--quiet', '--force-with-lease', '-u', 'origin', branch], worktree);
    const body = pullRequestBody({ issue, summary: proposal.summary, changes, tests, review, behaviour, measurement, version, base });
    const url = execGh(['pr', 'create', ...repoArgs, '--base', 'main', '--head', branch, '--title', subject, '--body', body, '--label', settings.label], worktree);
    return finish({ action: 'opened', pullRequest: String(url).trim().split('\n').pop(), ...fields });
  } finally {
    removeCheckout({ repoRoot, root: worktree, links, execGit });
    try {
      execGit(['branch', '-D', branch], repoRoot);
    } catch {
      // the branch lives on origin now, or never was made
    }
  }
}

function parseArgs(argv) {
  const o = { issue: null, retry: false, repo: null, lane: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--issue') o.issue = Number(argv[++i]);
    else if (a === '--retry') o.retry = true;
    else if (a === '--repo') o.repo = argv[++i] || null;
    else if (a === '--lane') o.lane = argv[++i] || null;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (o.issue !== null && !(Number.isInteger(o.issue) && o.issue > 0)) return { error: '--issue takes an issue number' };
  if (o.retry && o.issue === null) return { error: '--retry needs --issue: it retries one named issue' };
  return o;
}

/**
 * The command line.
 *
 * @param {string[]} argv
 * @param {object} [deps]  runCycle's dependencies, and stdout / stderr
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`${opts.error}\nUsage: node dev/loop/cycle.mjs [--lane <module>] [--issue <n> [--retry]] [--repo <owner/name>] [--dry-run] [--json]\n`);
    return 2;
  }
  try {
    const res = await runCycle({ ...deps, repo: opts.repo || deps.repo, issueNumber: opts.issue, retry: opts.retry, lane: opts.lane, dryRun: opts.dryRun });
    const shown = { ...res, measurement: res.measurement ? { measured: res.measurement.measured, reason: res.measurement.reason } : null };
    stdout.write(opts.json ? `${JSON.stringify(shown, null, 2)}\n`
      : `loop: ${res.action}${res.issue ? ` #${res.issue}` : ''}${res.pullRequest ? ` -> ${res.pullRequest}` : ''}${res.reason ? `: ${res.reason}` : ''}\n`);
    return 0;
  } catch (err) {
    stderr.write(`[ERROR] the loop cycle broke: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
