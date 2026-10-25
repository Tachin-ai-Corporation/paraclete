// dev/loop/cycle.mjs: one cycle of the self-improvement loop, as plain code. A cycle takes the oldest
// open GitHub issue labelled `loop` that has no open loop pull request and was not just tried, has a
// proposer (a coding agent: proposer.mjs) change a fresh checkout of main to resolve it, checks the
// change, and opens a pull request a person reviews and merges. Each step is fixed here; the proposer
// only edits files.
//
//   1. refuse while the harness is paused (dev/harness2/PAUSED), or once today's cycles are spent;
//   2. pick the issue, and read what its maintainers and earlier attempts said on it and on the loop's
//      closed pull requests for it;
//   3. check out origin/main on a branch of its own (`loop/<issue>-<slug>`), in a temporary worktree;
//   4. run the proposer on it, within its budget, briefed with the issue and those comments;
//   5. refuse a change that touches the referee (config.mjs), changes or removes an existing test,
//      changes code without adding a test, or fails the suite; then commit it, and refuse it unless a
//      reviewer model (reviewer.mjs) finds it meets every point the issue says it is done when; a change
//      to the agent's behaviour must also be measured on both sides with real-model runs
//      (dev/harness2 `eval --real-model`) and must not make any task worse;
//   6. commit it under the next free version, push the branch and open the pull request, with the
//      tests' result and any evidence; or, when refused, say why on the issue, naming the files it
//      changed and the tests that failed, which the next attempt reads;
//   7. record the cycle in .local/harness2/cycles.jsonl, which the health check reads.
//
// It never merges, releases or changes an instance. Stage 1 of the loop is supervised: the pull
// request waits for a person. Run by hand or by the driver's timer (timer.mjs):
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
import { MODEL_SUITE_VERSION } from '../harness2/model-suite.mjs';
import { pauseState } from '../harness2/pause.mjs';
import { nextPromotionVersion } from '../harness2/promote.mjs';
import { isBehaviourPath, loadLoopSettings, pathRefusal, testRefusal } from './config.mjs';
import { buildBrief, createCommandProposer } from './proposer.mjs';
import { buildReviewBrief, createCommandReviewer, doneWhen, formatReviewMarkdown, judgeReview } from './reviewer.mjs';
import { failingTests, failureLines, REPORT_LIMITS, withoutRoots } from './test-report.mjs';

/** Outcomes after a proposer ran: they count toward the day's cycles. */
const ATTEMPTED = new Set(['proposer-failed', 'no-change', 'refused-paths', 'untested', 'tests-failed', 'unreviewed', 'rejected', 'unmeasured', 'regressed', 'ready', 'opened']);

/** Outcomes that leave an issue alone until `retryAfterHours` have passed. */
const FAILED = new Set(['proposer-failed', 'no-change', 'refused-paths', 'untested', 'tests-failed', 'unreviewed', 'rejected', 'unmeasured', 'regressed']);

/** Packages a checkout borrows from the repo, never part of a change. */
const LINKED_PACKAGES = Object.freeze(['agent/node_modules', 'dashboard/node_modules']);

/** Whose comments on an issue a proposer is shown: people with a hand in this repository. On a public
 * repository anyone can comment, and a stranger's comment must not steer the proposer. */
const TRUSTED_COMMENTERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

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
 * Why the measured evidence shows the change made the agent worse, if it does: the runs were not
 * real-model runs, too few, or a task, the held-out tasks or the whole suite lost capability beyond
 * the evidence rules' tolerances. A change need not improve the suite (a fix may not show there);
 * it must not make it worse. Pure.
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
    if (t.baseline?.n && t.candidate?.n && t.candidate.mean < t.baseline.mean - r.taskTolerance) {
      problems.push(`task ${t.taskId} got worse: capability ${t.baseline.mean} -> ${t.candidate.mean}`);
    }
  }
  const h = evidence.holdout;
  if (h?.baseline?.n && h?.candidate?.n && h.candidate.mean < h.baseline.mean - r.holdoutTolerance) {
    problems.push(`the held-out tasks got worse: capability ${h.baseline.mean} -> ${h.candidate.mean}`);
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
    .filter((c) => TRUSTED_COMMENTERS.has(String(c.authorAssociation || '').toUpperCase()) && String(c.body || '').trim())
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
export function pullRequestComments(pullRequests, prefix) {
  return (pullRequests || [])
    .filter((p) => String(p.headRefName || '').startsWith(prefix))
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
 * The measurement of a behaviour change: the model suite run on main's head and on the change, with
 * real-model runs (dev/harness2 `eval --real-model`), as promotion evidence.
 */
async function defaultMeasure({ repoRoot, base, candidateRoot, changedPaths, issue, settings, execGit, log }) {
  const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paraclete-loop-base-'));
  execGit(['worktree', 'add', '--detach', '--quiet', baseRoot, base], repoRoot);
  const links = linkPackages(repoRoot, baseRoot);
  try {
    const { runCli } = await import('../harness2/cli.mjs');
    const args = ['eval', '--real-model', '--trials', String(settings.measure.trials), '--max-rollouts', String(settings.measure.maxRollouts)];
    const stderr = { write: (line) => log(String(line).trimEnd()) };
    const baseline = await runCli(args, { repoRoot: baseRoot, stderr });
    if (!baseline.ok) return { measured: false, reason: `main's head could not be measured: ${baseline.reason || 'no result'}` };
    const candidate = await runCli(args, { repoRoot: candidateRoot, stderr });
    if (!candidate.ok) return { measured: false, reason: `the change could not be measured: ${candidate.reason || 'no result'}` };
    const evidence = buildPromotionEvidence({
      candidate: { id: `loop-${issue.number}`, lens: 'LOOP', touchedPaths: changedPaths, proposal: { source: 'coding-agent', hypothesis: issue.title } },
      baselineTrajectories: baseline.trajectories,
      candidateTrajectories: candidate.trajectories,
      suite: { name: 'model', version: MODEL_SUITE_VERSION },
    });
    return { measured: Boolean(evidence.measured), evidence, reason: evidence.measured ? null : 'some runs were not real-model runs' };
  } catch (err) {
    return { measured: false, reason: err.message };
  } finally {
    removeCheckout({ repoRoot, root: baseRoot, links, execGit });
  }
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
  return { items, review: run.review, reason: null, ...judgeReview(run.review, items) };
}

/** The day's cycles that ran a proposer, and the issues tried and failed lately, from the cycle log. */
function pastCycles(records, now, retryAfterHours) {
  const day = now.toISOString().slice(0, 10);
  // A dry run spends nothing a person would count, and refuses nothing for good.
  const loop = records.filter((c) => c.command === 'loop' && c.loop && !c.loop.dryRun);
  return {
    today: loop.filter((c) => String(c.at).slice(0, 10) === day && ATTEMPTED.has(c.loop.action)).length,
    recentlyFailed: new Set(loop
      .filter((c) => FAILED.has(c.loop.action) && now.getTime() - Date.parse(c.at) < retryAfterHours * HOUR_MS)
      .map((c) => c.loop.issue)),
  };
}

function pullRequestBody({ issue, summary, changes, tests, review, behaviour, measurement, version }) {
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
    formatReviewMarkdown(review.review, review.items),
    '',
    `- **Behaviour**: ${behaviour ? 'changed, so measured on both sides with real-model runs; no task, the held-out tasks nor the suite got worse' : 'not changed (nothing the running agent reads)'}`,
    ...(measurement?.evidence ? ['', formatEvidenceMarkdown(measurement.evidence)] : []),
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
  dryRun = false,
  now = new Date(),
  env = process.env,
  settings = loadLoopSettings({ repoRoot }),
  execGit = defaultExec('git'),
  execGh = defaultExec('gh'),
  proposer,
  reviewer,
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
            now,
            result: {
              ok: !FAILED.has(result.action) && result.action !== 'capped',
              paused: result.action === 'paused',
              reason: result.reason,
              readiness: result.measurement?.evidence ? { evidence: result.measurement.evidence } : null,
              pullRequest: result.pullRequest ? { prUrl: result.pullRequest } : null,
            },
          }),
          loop: {
            issue: result.issue, action: result.action, branch: result.branch, changed: (result.changes || []).map((c) => c.path),
            tests: result.tests?.ok ?? null, reviewed: result.review ? Boolean(result.review.ok) : null,
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

  // 1. The off switch, and the day's cap.
  const pause = pauseState({ repoRoot, env });
  if (pause.paused) return finish({ action: 'paused', reason: `the harness is paused: ${pause.reason}` });
  const past = pastCycles(records, now, settings.retryAfterHours);
  if (past.today >= settings.maxCyclesPerDay) {
    return finish({ action: 'capped', reason: `today's ${settings.maxCyclesPerDay} cycles are spent` });
  }

  // 2. The issue: the oldest open one with the label, no open loop pull request, not tried lately.
  const issues = JSON.parse(execGh(['issue', 'list', ...repoArgs, '--label', settings.label, '--state', 'open',
    '--json', 'number,title,body,url,createdAt', '--limit', '100'], repoRoot) || '[]')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const openPrs = JSON.parse(execGh(['pr', 'list', ...repoArgs, '--state', 'open', '--json', 'number,headRefName,title', '--limit', '200'], repoRoot) || '[]');
  const busy = (n) => openPrs.some((p) => String(p.headRefName || '').startsWith(`${settings.branchPrefix}${n}-`));
  const waiting = (n) => !past.recentlyFailed.has(n) || (retry && n === issueNumber);
  const issue = issues.find((i) => (issueNumber ? i.number === issueNumber : true) && !busy(i.number) && waiting(i.number));
  if (!issue) {
    return finish({
      action: 'no-work',
      reason: issueNumber ? `issue #${issueNumber} is not open with the ${settings.label} label, has an open loop pull request, or was tried lately` : `no open ${settings.label} issue is waiting`,
    });
  }
  const branch = `${settings.branchPrefix}${issue.number}-${slugFor(issue.title)}`;
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
    comments.push(...pullRequestComments(closed, `${settings.branchPrefix}${issue.number}-`));
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
    const proposal = await propose({ issue, worktree, brief, budget });
    if (!proposal.ok) return refuse('proposer-failed', proposal.reason || 'the proposer failed');

    // 5. What it changed, and whether that may be proposed.
    // The linked packages never count as a change. git refuses a pathspec naming an ignored path, even
    // to exclude it, so they are taken back out of the index after staging, ignored or not.
    execGit(['add', '--all', '--', '.'], worktree);
    execGit(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...LINKED_PACKAGES], worktree);
    const changes = parseNameStatus(execGit(['diff', '--cached', '--name-status', '-M', base], worktree));
    if (changes.length === 0) return refuse('no-change', proposal.summary ? `the proposer changed nothing: ${proposal.summary.slice(0, 500)}` : 'the proposer changed nothing');
    const refusals = changes.flatMap((c) => [pathRefusal(c.path, c.status), c.oldPath ? pathRefusal(c.oldPath, 'D') : null]).filter(Boolean);
    if (refusals.length) return refuse('refused-paths', refusals.join('; '), { changes });
    const untested = testRefusal(changes);
    if (untested) return refuse('untested', untested, { changes });

    const tests = await runTests({ worktree, settings });
    if (!tests.ok) return refuse('tests-failed', `the suite failed: ${tests.summary}`, { changes, tests });

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
      const worse = regressionProblems(measurement.evidence);
      if (worse.length) return refuse('regressed', worse.join('; '), { changes, tests, behaviour, measurement });
    }

    const fields = { changes, tests, review, behaviour, measurement, version, subject };
    if (dryRun) return finish({ action: 'ready', reason: 'a dry run: nothing pushed', ...fields });

    // 7. Push, and open the pull request a person merges.
    execGit(['push', '--quiet', '--force-with-lease', '-u', 'origin', branch], worktree);
    const body = pullRequestBody({ issue, summary: proposal.summary, changes, tests, review, behaviour, measurement, version });
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
  const o = { issue: null, retry: false, repo: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--issue') o.issue = Number(argv[++i]);
    else if (a === '--retry') o.retry = true;
    else if (a === '--repo') o.repo = argv[++i] || null;
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
    stderr.write(`${opts.error}\nUsage: node dev/loop/cycle.mjs [--issue <n> [--retry]] [--repo <owner/name>] [--dry-run] [--json]\n`);
    return 2;
  }
  try {
    const res = await runCycle({ ...deps, repo: opts.repo || deps.repo, issueNumber: opts.issue, retry: opts.retry, dryRun: opts.dryRun });
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
