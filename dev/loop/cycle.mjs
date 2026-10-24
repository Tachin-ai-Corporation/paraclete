// dev/loop/cycle.mjs: one cycle of the self-improvement loop, as plain code. A cycle takes the oldest
// open GitHub issue labelled `loop` that has no open loop pull request and was not just tried, has a
// proposer (a coding agent: proposer.mjs) change a fresh checkout of main to resolve it, checks the
// change, and opens a pull request a person reviews and merges. Each step is fixed here; the proposer
// only edits files.
//
//   1. refuse while the harness is paused (dev/harness2/PAUSED), or once today's cycles are spent;
//   2. pick the issue;
//   3. check out origin/main on a branch of its own (`loop/<issue>-<slug>`), in a temporary worktree;
//   4. run the proposer on it, within its budget;
//   5. refuse a change that touches the referee (config.mjs), changes or removes an existing test, or
//      fails the suite; a change to the agent's behaviour must also be measured on both sides with
//      real-model runs (dev/harness2 `eval --real-model`) and must not make any task worse;
//   6. commit it under the next free version, push the branch and open the pull request, with the
//      tests' result and any evidence; or, when refused, say why on the issue;
//   7. record the cycle in .local/harness2/cycles.jsonl, which the health check reads.
//
// It never merges, releases or changes an instance. Stage 1 of the loop is supervised: the pull
// request waits for a person. Run by hand or by the driver's timer (timer.mjs):
//
//   node dev/loop/cycle.mjs [--issue <n>] [--repo <owner/name>] [--dry-run] [--json]
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
import { isBehaviourPath, loadLoopSettings, pathRefusal } from './config.mjs';
import { buildBrief, createCommandProposer } from './proposer.mjs';

/** Outcomes after a proposer ran: they count toward the day's cycles. */
const ATTEMPTED = new Set(['proposer-failed', 'no-change', 'refused-paths', 'tests-failed', 'unmeasured', 'regressed', 'ready', 'opened']);

/** Outcomes that leave an issue alone until `retryAfterHours` have passed. */
const FAILED = new Set(['proposer-failed', 'no-change', 'refused-paths', 'tests-failed', 'unmeasured', 'regressed']);

/** Packages a checkout borrows from the repo, never part of a change. */
const LINKED_PACKAGES = Object.freeze(['agent/node_modules', 'dashboard/node_modules']);

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
  return { ok: res.status === 0, summary: res.error ? `${res.error.message}` : summary };
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

function pullRequestBody({ issue, summary, changes, tests, behaviour, measurement, version }) {
  return [
    `Resolves #${issue.number}.`,
    '',
    'Opened by the self-improvement loop (`dev/loop/cycle.mjs`). The loop is supervised: a person reviews and merges this.',
    '',
    '## What the proposer did',
    '',
    summary || '(it gave no summary)',
    '',
    '## Checks',
    '',
    `- **Changed**: ${changes.map((c) => `\`${c.path}\` (${c.status})`).join(', ')}`,
    `- **Tests**: passed (${tests.summary})`,
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
  dryRun = false,
  now = new Date(),
  env = process.env,
  settings = loadLoopSettings({ repoRoot }),
  execGit = defaultExec('git'),
  execGh = defaultExec('gh'),
  proposer,
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
            tests: result.tests?.ok ?? null, behaviour: result.behaviour ?? null, measured: result.measurement?.measured ?? null, dryRun,
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
  const issue = issues.find((i) => (issueNumber ? i.number === issueNumber : true) && !busy(i.number) && !past.recentlyFailed.has(i.number));
  if (!issue) {
    return finish({
      action: 'no-work',
      reason: issueNumber ? `issue #${issueNumber} is not open with the ${settings.label} label, has an open loop pull request, or was tried lately` : `no open ${settings.label} issue is waiting`,
    });
  }
  const branch = `${settings.branchPrefix}${issue.number}-${slugFor(issue.title)}`;
  result = { ...result, issue: issue.number, branch };
  log(`[INFO] loop: issue #${issue.number}: ${issue.title}`);

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
          `The self-improvement loop tried this and stopped (${action}): ${reason}\n\nIt tries again after ${settings.retryAfterHours} hours.`], repoRoot);
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
    const brief = buildBrief({ issue, testCommand: settings.testCommand, budget });
    const proposal = await propose({ issue, worktree, brief, budget });
    if (!proposal.ok) return refuse('proposer-failed', proposal.reason || 'the proposer failed');

    // 5. What it changed, and whether that may be proposed.
    execGit(['add', '--all', '--', '.', ...LINKED_PACKAGES.map((p) => `:!${p}`)], worktree);
    const changes = parseNameStatus(execGit(['diff', '--cached', '--name-status', '-M', base], worktree));
    if (changes.length === 0) return refuse('no-change', proposal.summary ? `the proposer changed nothing: ${proposal.summary.slice(0, 500)}` : 'the proposer changed nothing');
    const refusals = changes.flatMap((c) => [pathRefusal(c.path, c.status), c.oldPath ? pathRefusal(c.oldPath, 'D') : null]).filter(Boolean);
    if (refusals.length) return refuse('refused-paths', refusals.join('; '), { changes });

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

    const fields = { changes, tests, behaviour, measurement, version, subject };
    if (dryRun) return finish({ action: 'ready', reason: 'a dry run: nothing pushed', ...fields });

    // 7. Push, and open the pull request a person merges.
    execGit(['push', '--quiet', '--force-with-lease', '-u', 'origin', branch], worktree);
    const body = pullRequestBody({ issue, summary: proposal.summary, changes, tests, behaviour, measurement, version });
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
  const o = { issue: null, repo: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--issue') o.issue = Number(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i] || null;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (o.issue !== null && !(Number.isInteger(o.issue) && o.issue > 0)) return { error: '--issue takes an issue number' };
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
    stderr.write(`${opts.error}\nUsage: node dev/loop/cycle.mjs [--issue <n>] [--repo <owner/name>] [--dry-run] [--json]\n`);
    return 2;
  }
  try {
    const res = await runCycle({ ...deps, repo: opts.repo || deps.repo, issueNumber: opts.issue, dryRun: opts.dryRun });
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
