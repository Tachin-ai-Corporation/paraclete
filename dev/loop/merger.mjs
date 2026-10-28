// dev/loop/merger.mjs: merges the self-improvement loop's pull requests, with no person in between, and
// only those that pass every check on the main they land on. A loop pull request is an open one against
// main from a `loop/` branch of this repository (cycle.mjs opens them); every other is left alone.
//
// Nothing is merged while the harness is paused (dev/harness2/pause.mjs: the off switch here, in the
// environment, or on origin/main), while CI on main's head failed or runs (when main's head has no CI,
// a merge made with a workflow's token having started none, CI is dispatched on it), or once
// `merge.maxPerDay` loop pull requests merged today (UTC). At most one is merged per run, so each is
// checked against the main it lands on.
//
// Each, in number order, is squash-merged, pinned to the head commit checked, only when all hold:
//   - every CI check run on its head finished with success (dev/release.mjs ciVerdict), which includes
//     the Loop guard workflow;
//   - the loop guard passes here too (guard.mjs: the issue, the referee and test rules, the review
//     re-judged against the issue as it reads now and bound to the files it changes, the evidence of a
//     behaviour change);
//   - GitHub can merge it cleanly and its head contains main's head, so CI ran on what lands (one main
//     moved past waits: the next loop cycle merges main into it, and CI and the guard run again);
// Its title keeps its version when that is newer than main's and every tag's, else takes the next free
// one (dev/harness2/merge.mjs promotionVersion), so main's head stays releasable. After the merge it
// closes the issue the pull request resolved: GitHub applies no closing keyword ("Resolves #n") to a
// merge made with a workflow's token, and an issue left open would be taken again.
//
// A loop pull request that breaks a rule (CI failed, a conflict with main, the guard) is closed with a
// comment saying why: the loop never updates a
// pull request it opened, so closing it frees its issue for the next cycle, whose proposer reads that
// comment (cycle.mjs trustedNotes). One that is only waiting (CI running, GitHub still working out
// whether it can merge, a draft, main's CI, the day's cap, another merge this run) is left alone. A
// revert pull request (sentinel.mjs) comes first, and neither a failing main (what it mends) nor the
// day's cap holds it back. With
// --dry-run it changes nothing on GitHub.
//
//   node dev/loop/merger.mjs [--dry-run] [--json]
//
// Run each hour by .github/workflows/harness-merge.yml, after the harness's own merger. It runs git in
// this checkout and the GitHub CLI; it measures nothing and opens nothing.

import { pathToFileURL } from 'node:url';
import { githubRepoFromUrl } from '../deploy.mjs';
import { DevError, REPO_ROOT, createExec, failureDetail } from '../dev-env.mjs';
import { promotionVersion } from '../harness2/merge.mjs';
import { PAUSE_FILE, pauseState } from '../harness2/pause.mjs';
import { MAIN, REMOTE, checkRuns, ciVerdict } from '../release.mjs';
import { LOOP_DEFAULTS } from './config.mjs';
import { measuredBase } from './baseline.mjs';
import { isLoopBranch, loopGuard, resolvedIssue } from './guard.mjs';
import { isRevertBranch, parseRevertBlock, readReverted } from './sentinel.mjs';

/** The workflow dispatched on main after a merge, or when main's head has no CI. */
const CI_WORKFLOW = 'ci.yml';

const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const API_JSON = ['-H', 'Accept: application/vnd.github+json'];
const VIEW_FIELDS = 'number,title,body,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,mergeStateStatus';

/**
 * What stands between a loop pull request and its merge. Refusals close it; waits leave it. Pure.
 *
 * @param {object} p
 * @param {object} p.pr        `gh pr view`'s answer
 * @param {object[]} p.runs    its head commit's check runs
 * @param {number} p.behindBy  how many of main's commits its head lacks
 * @param {object} p.guard     guard.mjs loopGuard's verdict
 * @returns {{ refusals: string[], waits: string[] }}
 */
export function loopMergeBlockers({ pr, runs, behindBy, guard }) {
  const refusals = [];
  const waits = [];
  const short = String(pr?.headRefOid || '').slice(0, 12);
  if (pr?.isDraft) waits.push('it is a draft');
  const ci = ciVerdict(runs || []);
  if (ci.failed.length) refusals.push(`CI did not pass on ${short}: ${ci.failed.join(', ')}`);
  else if (ci.pending.length) waits.push(`CI is still running on ${short}: ${ci.pending.join(', ')}`);
  else if (!ci.ok) waits.push(`no CI check has run on ${short} yet`);
  const state = String(pr?.mergeStateStatus || 'UNKNOWN').toUpperCase();
  if (state === 'UNKNOWN') waits.push('GitHub has not worked out yet whether it can be merged');
  else if (state === 'DIRTY') refusals.push(`it conflicts with ${MAIN}`);
  else if (state !== 'CLEAN' && ci.ok) refusals.push(`GitHub cannot merge it cleanly (mergeStateStatus ${state})`);
  // Behind main is not a fault of the change: the next loop cycle merges main into it (cycle.mjs), and
  // its CI and the guard run again on what would land. A conflict is DIRTY, and closes it above.
  if (!(behindBy === 0) && state !== 'DIRTY') waits.push(`its head lacks ${Number.isInteger(behindBy) ? `${behindBy} commit(s)` : 'commits'} of ${MAIN}'s head: the next loop cycle brings it up to date`);
  refusals.push(...(guard?.problems || []).map((p) => `the loop guard: ${p}`));
  return { refusals, waits };
}

/** The comment a closed loop pull request gets. */
export function closingComment(reasons, issue) {
  return [
    "The loop's merger closed this without merging it:",
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    `${issue ? `#${issue} stays open: the` : 'The'} loop takes it again from ${MAIN}'s head, and its next attempt reads this comment.`,
  ].join('\n');
}

/** A revert's squashed commit body: what it reverts. It is never a loop merge's (sentinel.mjs loopMergeOf). */
export function revertSquashBody({ number, sha, block }) {
  return `Reverted ${block?.reverts || 'a loop merge'} (#${block?.pr ?? '?'}) through #${number} at ${sha}, merged by dev/loop/merger.mjs: CI had failed on main after that merge.\n`;
}

/** The squashed commit's body: where the merge came from and what passed. */
export function loopSquashBody({ number, sha, issue }) {
  return `Merged from #${number} at ${sha} by dev/loop/merger.mjs: CI and the loop guard passed, and its reviewer found every point of #${issue} met.\n`;
}

async function gh(exec, args, what) {
  const result = await exec('gh', args, {});
  if (result.missing) throw new DevError('gh was not found: install the GitHub CLI (https://cli.github.com) and log in with `gh auth login`.');
  if (result.code !== 0) throw new DevError(`${what}${failureDetail(result)}`);
  return result.stdout;
}

async function ghJson(exec, args, what) {
  const out = await gh(exec, args, `gh could not read ${what}`);
  try {
    return JSON.parse(out);
  } catch {
    throw new DevError(`GitHub answered ${what} in a form this script cannot read`);
  }
}

async function git(exec, repoRoot, args, what) {
  const result = await exec('git', args, { cwd: repoRoot });
  if (result.missing) throw new DevError('git was not found: install git and run this from a clone of the repository.');
  if (result.code !== 0) throw new DevError(`${what}${failureDetail(result)}`);
  return result.stdout;
}

const lines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** The pull request, its files and the issue it names, as the guard reads them. */
async function readForGuard(exec, repo, number) {
  const pr = await ghJson(exec, ['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS], `pull request #${number}`);
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await ghJson(exec, ['api', ...API_JSON, `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`], `the files of #${number}`);
    if (!Array.isArray(batch)) throw new DevError(`GitHub answered the files of #${number} in a form this script cannot read`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  if (isRevertBranch(pr.headRefName)) {
    const block = parseRevertBlock(pr.body);
    const getJson = (p) => ghJson(exec, ['api', ...API_JSON, p], p);
    return { pr, files, issue: null, reverted: block ? await readReverted(getJson, repo, block.reverts) : null };
  }
  const n = resolvedIssue(pr.body);
  const issue = n
    ? await ghJson(exec, ['issue', 'view', String(n), '--repo', repo, '--json', 'number,title,body,state,labels'], `issue #${n}`).catch(() => null)
    : null;
  // What main changed since the commit a measured change was measured against, for the guard.
  const base = measuredBase(pr.body);
  const cmp = base
    ? await ghJson(exec, ['api', ...API_JSON, `repos/${repo}/compare/${base}...${MAIN}`], `what ${MAIN} changed since ${base.slice(0, 12)}`).catch(() => null)
    : null;
  return { pr, files, issue, reverted: null, mainChanged: Array.isArray(cmp?.files) ? cmp.files.map((f) => f.filename) : null };
}

/**
 * Merges at most one loop pull request that passes every check (see the header), and closes those that
 * cannot pass.
 *
 * @param {object} [o]
 * @param {boolean} [o.dryRun]   judge and report; change nothing on GitHub
 * @param {string} [o.repoRoot]  the checkout git runs in and the off switch is read from
 * @param {object} [o.env]       PARACLETE_H2_PAUSED, GITHUB_REPOSITORY
 * @param {Function} [o.exec]    (program, args, opts) => Promise<{code, stdout, stderr}>
 * @param {Date} [o.now]
 * @param {number} [o.maxPerDay]
 * @returns {Promise<object>} { ok, paused, dryRun, repo, mainHead, hold, mergedToday, results, merged, closed, ciDispatched, error? }
 */
export async function mergeLoopPullRequests(o = {}) {
  const { dryRun = false, repoRoot = REPO_ROOT, env = process.env, now = new Date(), maxPerDay = LOOP_DEFAULTS.merge.maxPerDay } = o;
  const exec = o.exec || createExec({ env });
  const result = {
    ok: true, paused: false, dryRun: Boolean(dryRun), repo: null, mainHead: null, hold: null, mergedToday: 0, results: [], merged: [], closed: [], ciDispatched: false,
  };
  const pause = pauseState({ repoRoot, env });
  if (pause.paused) return { ...result, paused: true, reason: pause.reason };

  const errors = [];
  let repo;
  let listed;
  try {
    repo = REPO.test(String(env.GITHUB_REPOSITORY || '')) ? env.GITHUB_REPOSITORY
      : githubRepoFromUrl((await git(exec, repoRoot, ['remote', 'get-url', REMOTE], `this clone has no remote ${REMOTE}`)).trim());
    if (!repo) throw new DevError(`${REMOTE} is not a GitHub repository`);
    result.repo = repo;
    await git(exec, repoRoot, ['fetch', '--quiet', '--tags', REMOTE, MAIN], `git could not fetch ${MAIN} and the tags from ${REMOTE}`);
    const head = (await git(exec, repoRoot, ['rev-parse', '--verify', `refs/remotes/${REMOTE}/${MAIN}^{commit}`], `this clone has no ${REMOTE}/${MAIN}`)).trim();
    if (!COMMIT.test(head)) throw new DevError(`git named ${REMOTE}/${MAIN}'s head as '${head}', which is not a commit`);
    result.mainHead = head;
    if ((await exec('git', ['cat-file', '-e', `${head}:${PAUSE_FILE}`], { cwd: repoRoot })).code === 0) {
      return { ...result, paused: true, reason: `${PAUSE_FILE} on ${REMOTE}/${MAIN}` };
    }
    result.subjects = lines(await git(exec, repoRoot, ['log', '--format=%s', head, '--'], `git could not list the commits of ${REMOTE}/${MAIN}`));
    result.tags = lines(await git(exec, repoRoot, ['tag', '--list'], 'git could not list the tags'));
    const mainCi = ciVerdict(await checkRuns({ exec }, repo, head));
    if (!mainCi.ok) {
      result.hold = mainCi.failed.length ? `CI did not pass on ${MAIN}'s head ${head.slice(0, 12)}: ${mainCi.failed.join(', ')}`
        : mainCi.pending.length ? `CI is still running on ${MAIN}'s head ${head.slice(0, 12)}` : `no CI has run on ${MAIN}'s head ${head.slice(0, 12)} yet`;
      if (!mainCi.failed.length && !mainCi.pending.length && !dryRun) {
        await gh(exec, ['workflow', 'run', CI_WORKFLOW, '--repo', repo, '--ref', MAIN], `gh could not dispatch ${CI_WORKFLOW} on ${MAIN}`);
        result.ciDispatched = true;
      }
    }
    const day = now.toISOString().slice(0, 10);
    const mergedLately = await ghJson(exec, ['pr', 'list', '--repo', repo, '--state', 'merged', '--base', MAIN, '--search', `merged:>=${day}`,
      '--limit', '100', '--json', 'number,headRefName,mergedAt'], 'the pull requests merged today');
    result.mergedToday = mergedLately.filter((p) => isLoopBranch(p.headRefName) && String(p.mergedAt || '').slice(0, 10) >= day).length;
    const open = await ghJson(exec, ['pr', 'list', '--repo', repo, '--state', 'open', '--base', MAIN, '--limit', '200',
      '--json', 'number,headRefName,isCrossRepository'], 'the open pull requests');
    listed = open.filter((p) => isLoopBranch(p.headRefName) && !p.isCrossRepository)
      .sort((a, b) => Number(isRevertBranch(b.headRefName)) - Number(isRevertBranch(a.headRefName)) || a.number - b.number);
  } catch (err) {
    return { ...result, ok: false, error: err.message };
  }

  let attempted = null;
  for (const { number } of listed) {
    if (attempted) {
      result.results.push({ number, action: 'waiting', reasons: [`one loop change merges per run, and #${attempted} came first`] });
      continue;
    }
    try {
      const { pr, files, issue, reverted, mainChanged } = await readForGuard(exec, repo, number);
      const sha = String(pr.headRefOid || '');
      const runs = await checkRuns({ exec }, repo, sha);
      const compare = await ghJson(exec, ['api', ...API_JSON, `repos/${repo}/compare/${result.mainHead}...${sha}`], `how #${number} compares with ${MAIN}`);
      const guard = loopGuard({ pr, files, issue, reverted, mainChanged });
      const { refusals, waits } = loopMergeBlockers({ pr, runs, behindBy: compare?.behind_by, guard });
      if (refusals.length) {
        if (!dryRun) {
          await gh(exec, ['pr', 'close', String(number), '--repo', repo, '--comment', closingComment(refusals, guard.issue)], `gh could not close #${number}`);
        }
        result.results.push({ number, action: 'closed', reasons: refusals });
        result.closed.push(number);
        continue;
      }
      const hold = waits.length ? waits
        : guard.revert ? []
          : result.hold ? [result.hold] : result.mergedToday >= maxPerDay ? [`today's ${maxPerDay} loop merges are done`] : [];
      if (hold.length) {
        result.results.push({ number, action: 'waiting', reasons: hold });
        continue;
      }
      attempted = number;
      const plan = promotionVersion({ title: pr.title, subjects: result.subjects, tags: result.tags, now });
      if (!dryRun) {
        if (plan.retitled) await gh(exec, ['pr', 'edit', String(number), '--repo', repo, '--title', plan.title], `gh could not retitle #${number}`);
        await gh(exec, ['pr', 'merge', String(number), '--repo', repo, '--squash', '--subject', plan.title,
          '--body', guard.revert ? revertSquashBody({ number, sha, block: parseRevertBlock(pr.body) }) : loopSquashBody({ number, sha, issue: guard.issue }),
          '--match-head-commit', sha], `gh could not merge #${number}`);
      }
      if (!dryRun && guard.issue) {
        try {
          await gh(exec, ['issue', 'close', String(guard.issue), '--repo', repo, '--reason', 'completed', '--comment',
            `Resolved by #${number}, merged by the loop's merger (dev/loop/merger.mjs).`], `gh could not close #${guard.issue}`);
        } catch (err) {
          errors.push(`#${number} merged, but ${err.message}`);
        }
      }
      result.mergedToday += 1;
      result.merged.push(number);
      result.results.push({ number, action: 'merged', title: plan.title, ...(plan.retitled ? { retitledFrom: pr.title } : {}) });
    } catch (err) {
      errors.push(`#${number}: ${err.message}`);
      result.results.push({ number, action: 'waiting', reasons: [err.message], error: true });
    }
  }
  if (result.merged.length && !dryRun) {
    try {
      await gh(exec, ['workflow', 'run', CI_WORKFLOW, '--repo', repo, '--ref', MAIN], `gh could not dispatch ${CI_WORKFLOW} on ${MAIN}`);
      result.ciDispatched = true;
    } catch (err) {
      errors.push(`${err.message}; the next run dispatches it`);
    }
  }
  const { subjects: _s, tags: _t, ...shown } = result;
  return { ...shown, ok: errors.length === 0, ...(errors.length ? { error: errors.join('\n') } : {}) };
}

/** The run as lines a person reads. */
export function formatLoopMergeReport(r) {
  const out = [];
  if (r.paused) out.push(`Paused (${r.reason}): nothing was merged.`);
  if (r.hold) out.push(`Nothing merges this run: ${r.hold}.`);
  for (const x of r.results || []) {
    out.push(`#${x.number} ${x.action === 'merged' ? `${r.dryRun ? 'would merge' : 'merged'} as ${x.title}` : `${r.dryRun && x.action === 'closed' ? 'would close' : x.action}: ${x.reasons.join('; ')}`}`);
  }
  if (!r.paused && !(r.results || []).length && !r.error) out.push('No open loop pull request.');
  out.push(`Loop merges today: ${r.mergedToday}.`);
  if (r.ciDispatched) out.push(`Dispatched ${CI_WORKFLOW} on ${MAIN}.`);
  if (r.error) out.push(`Error: ${r.error}`);
  if (r.dryRun) out.push('Dry run: nothing was changed on GitHub.');
  return `${out.join('\n')}\n`;
}

/**
 * The command line.
 *
 * @param {string[]} argv
 * @param {object} [deps]  mergeLoopPullRequests' options, and stdout
 * @returns {Promise<number>} exit code: 0 the run finished, 1 it could not, 2 a usage mistake
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const unknown = argv.filter((a) => a !== '--dry-run' && a !== '--json');
  if (unknown.length) {
    (deps.stderr || process.stderr).write(`unknown argument: ${unknown[0]}\nUsage: node dev/loop/merger.mjs [--dry-run] [--json]\n`);
    return 2;
  }
  const r = await mergeLoopPullRequests({ ...deps, dryRun: argv.includes('--dry-run') });
  stdout.write(argv.includes('--json') ? `${JSON.stringify(r, null, 2)}\n` : formatLoopMergeReport(r));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
