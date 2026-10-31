// dev/loop/sentinel.mjs: what undoes a loop merge that broke main. The merger merges a loop pull request
// only once its CI passed on what would land, so a broken main is rare; when it happens, nothing else
// merges (the merger holds while CI on main's head fails), and no cycle should build on it. At the start
// of each cycle, as the user the cycle runs as (so its pull request gets CI and the Loop guard):
//
//   - when CI on main's head finished with a failure and that head is a loop merge (merger.mjs's squash
//     message), it opens a revert pull request from `loop/revert-<sha>`: `git revert` of that commit,
//     labelled `loop`, its body carrying the commit and the pull request it reverts; and reopens the
//     issue that merge resolved, saying why, so the loop takes it again;
//   - when that is the loop's `maxRevertsPerDay`-th revert in a day, it also pauses the loop's cycles:
//     the repository variable PARACLETE_LOOP_PAUSED (the merger still merges the revert);
//   - when main's head is broken by anything else, it reverts nothing, and the cycle runs no change on it.
//
// revertGuard is what the Loop guard (guard.mjs) and the merger check a revert pull request against: it
// sets every file the reverted commit touched back to what it was before that commit, and changes
// nothing else. Called by cycle.mjs, guard.mjs and merger.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextPromotionVersion } from '../harness2/promote.mjs';
import { HARNESS_MERGE_JOB } from '../release.mjs';
import { pathRefusal } from './config.mjs';

/** The head branch prefix of a revert pull request: `loop/revert-<12 hex of the reverted commit>`. */
export const REVERT_PREFIX = 'loop/revert-';

/** The fenced block a revert pull request carries what it reverts in. */
export const REVERT_BLOCK = 'paraclete-loop-revert';

/** The repository variable that pauses the loop's cycles (not its merger). */
export const LOOP_PAUSE_VARIABLE = 'PARACLETE_LOOP_PAUSED';

const DAY_MS = 86_400_000;

/** Whether a head branch is a revert pull request's. */
export function isRevertBranch(name) {
  return String(name || '').startsWith(REVERT_PREFIX);
}

/** The loop merge a commit message records (merger.mjs loopSquashBody): its pull request and issue, or null. */
export function loopMergeOf(message) {
  const m = /Merged from #(\d+) at ([0-9a-f]{40}) by dev\/loop\/merger\.mjs\b[^\n]*?every point of #(\d+) met/.exec(String(message || ''));
  return m ? { pr: Number(m[1]), head: m[2], issue: Number(m[3]) } : null;
}

/** The checks that finished with a failure (not those still running or cancelled), the merge job's left out. */
export function failedChecks(runs) {
  return (runs || [])
    .filter((r) => r?.name !== HARNESS_MERGE_JOB && r?.status === 'completed' && ['failure', 'timed_out'].includes(r.conclusion))
    .map((r) => r.name);
}

/** A revert pull request's body. */
export function revertBody({ sha, pr, issue, failed }) {
  return [
    `Reverts #${pr} (${sha}): CI failed on main once the loop merged it (${failed.join(', ')}).`,
    '',
    `#${issue}, which it resolved, is reopened, and the loop takes it again from main as it is after this.`,
    '',
    'Opened by the self-improvement loop (`dev/loop/sentinel.mjs`). The Loop guard checks that it sets every file the reverted commit touched back to what it was before, and changes nothing else.',
    '',
    `\`\`\`json ${REVERT_BLOCK}`,
    JSON.stringify({ reverts: sha, pr, issue }),
    '```',
  ].join('\n');
}

/** The revert block a pull request's body carries, or null. */
export function parseRevertBlock(body) {
  const m = new RegExp(`\`\`\`json ${REVERT_BLOCK}\\s*\\n([\\s\\S]*?)\\n\`\`\``).exec(String(body || ''));
  if (!m) return null;
  try {
    const block = JSON.parse(m[1]);
    return /^[0-9a-f]{40}$/.test(String(block?.reverts || '')) ? block : null;
  } catch {
    return null;
  }
}

/**
 * Whether a revert pull request does exactly what it says. Pure.
 *
 * @param {object} p
 * @param {object} p.pr        { headRefName, body }
 * @param {object[]} p.files   its files as GitHub's REST API lists them: { filename, status, sha }
 * @param {object|null} p.reverted  the commit it names: { message, files: [{ filename, status,
 *                             previous_filename }], before: { path: blob before the commit, or null } }
 * @returns {{ ok: boolean, problems: string[], block: object|null }}
 */
export function revertGuard({ pr, files, reverted }) {
  const problems = [];
  const block = parseRevertBlock(pr?.body);
  if (!block) return { ok: false, problems: [`its body carries no revert block (\`\`\`json ${REVERT_BLOCK})`], block: null };
  if (pr.headRefName !== `${REVERT_PREFIX}${block.reverts.slice(0, 12)}`) problems.push(`its branch is not ${REVERT_PREFIX}${block.reverts.slice(0, 12)}, the commit it names`);
  if (!reverted) return { ok: false, problems: [...problems, `the commit it reverts, ${block.reverts.slice(0, 12)}, could not be read`], block };
  const merge = loopMergeOf(reverted.message);
  if (!merge) problems.push(`${block.reverts.slice(0, 12)} is not a loop merge: only the loop's own merges are reverted this way`);
  else if (merge.pr !== block.pr) problems.push(`${block.reverts.slice(0, 12)} merged #${merge.pr}, not #${block.pr}`);
  const expected = new Map();
  for (const f of reverted.files || []) {
    expected.set(f.filename, reverted.before?.[f.filename] ?? null);
    if (f.previous_filename) expected.set(f.previous_filename, reverted.before?.[f.previous_filename] ?? null);
  }
  const now = new Map((files || []).map((f) => [f.filename, f.status === 'removed' ? null : f.sha]));
  for (const f of files || []) if (f.previous_filename && !now.has(f.previous_filename)) now.set(f.previous_filename, null);
  const differ = [...new Set([...expected.keys(), ...now.keys()])].filter((p) => !expected.has(p) || !now.has(p) || expected.get(p) !== now.get(p));
  if (differ.length) problems.push(`it does not set exactly the reverted commit's files back to what they were before it: ${differ.join(', ')}`);
  problems.push(...[...now.keys()].map((p) => pathRefusal(p, 'A')).filter(Boolean));
  return { ok: problems.length === 0, problems, block };
}

/**
 * The commit a revert names, as revertGuard reads it, through GitHub: its message, its files, and each
 * file's blob in its parent (null when the commit added the file).
 *
 * @param {Function} getJson  (api path) => parsed JSON, or a promise of it; throwing (or rejecting) when
 *                           GitHub answers 404 or fails
 * @param {string} repo
 * @param {string} sha
 * @returns {Promise<object|null>}
 */
export async function readReverted(getJson, repo, sha) {
  let commit;
  try {
    commit = await getJson(`repos/${repo}/commits/${sha}`);
  } catch {
    return null;
  }
  const parent = commit?.parents?.[0]?.sha;
  const files = (commit?.files || []).map((f) => ({ filename: f.filename, status: f.status, previous_filename: f.previous_filename }));
  const before = {};
  for (const p of files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean)) {
    try {
      before[p] = parent ? (await getJson(`repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${parent}`))?.sha ?? null : null;
    } catch {
      before[p] = null;
    }
  }
  return { message: commit?.commit?.message || '', files, before };
}

/**
 * Main's health, and the revert of a loop merge that broke it. Run by cycle.mjs at its start.
 *
 * @param {object} o  { repoRoot, repo, settings, execGit, execGh, now, dryRun, log, removeCheckout }
 * @returns {{ state: 'healthy'|'pending'|'broken'|'reverting', reason: string|null, pullRequest?: string, paused?: boolean }}
 */
export function checkMain({ repoRoot, repo, settings, execGit, execGh, now = new Date(), dryRun = false, log = () => {}, removeCheckout }) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const apiRepo = repo || '{owner}/{repo}';
  execGit(['fetch', '--quiet', '--tags', 'origin', 'main'], repoRoot);
  const head = execGit(['rev-parse', 'origin/main'], repoRoot);
  const runs = JSON.parse(execGh(['api', `repos/${apiRepo}/commits/${head}/check-runs?filter=latest&per_page=100`], repoRoot) || '{}').check_runs || [];
  const failed = failedChecks(runs);
  if (!failed.length) {
    const pending = runs.some((r) => r?.name !== HARNESS_MERGE_JOB && r?.status !== 'completed');
    return { state: pending ? 'pending' : 'healthy', reason: null };
  }
  const merge = loopMergeOf(execGit(['log', '-1', '--format=%B', head], repoRoot));
  if (!merge) return { state: 'broken', reason: `CI failed on main's head ${head.slice(0, 12)} (${failed.join(', ')}), which is not a loop merge: a person mends it` };

  const branch = `${REVERT_PREFIX}${head.slice(0, 12)}`;
  const prs = JSON.parse(execGh(['pr', 'list', ...repoArgs, '--state', 'all', '--json', 'number,headRefName,createdAt,title,url', '--limit', '200'], repoRoot) || '[]');
  const existing = prs.find((p) => p.headRefName === branch);
  if (existing) return { state: 'reverting', reason: `#${existing.number} reverts ${head.slice(0, 12)}`, pullRequest: existing.url };
  const lately = prs.filter((p) => isRevertBranch(p.headRefName) && now.getTime() - Date.parse(p.createdAt) < DAY_MS).length + 1;
  const pause = lately >= settings.maxRevertsPerDay;
  const reason = `CI failed on main's head ${head.slice(0, 12)} (${failed.join(', ')}), the loop's merge of #${merge.pr}`;
  if (dryRun) return { state: 'reverting', reason: `${reason}: a dry run reverts nothing`, paused: pause };

  const subjects = [...execGit(['log', '--format=%s', 'origin/main'], repoRoot).split('\n'), ...prs.map((p) => p.title)];
  const tags = execGit(['tag', '--list'], repoRoot).split('\n').filter(Boolean);
  const subject = `${nextPromotionVersion({ subjects, tags, now })}: revert #${merge.pr}, which broke CI on main`;
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'paraclete-loop-revert-'));
  const who = ['-c', 'user.name=Paraclete loop', '-c', 'user.email=loop@example.com'];
  let url;
  try {
    execGit(['worktree', 'add', '--quiet', '-B', branch, worktree, head], repoRoot);
    execGit([...who, 'revert', '--no-edit', head], worktree);
    execGit([...who, 'commit', '--amend', '--quiet', '-m', subject, '-m', `Reverts ${head} (#${merge.pr}): ${failed.join(', ')} failed on main.`], worktree);
    execGit(['push', '--quiet', '--force-with-lease', '-u', 'origin', branch], worktree);
    url = String(execGh(['pr', 'create', ...repoArgs, '--base', 'main', '--head', branch, '--title', subject,
      '--body', revertBody({ sha: head, pr: merge.pr, issue: merge.issue, failed }), '--label', settings.label], worktree)).trim().split('\n').pop();
  } catch (err) {
    // A revert that cannot be made (a conflict, say) leaves main broken: nothing is built on it.
    return { state: 'broken', reason: `${reason}, and it could not be reverted: ${String(err.message || err).split('\n')[0]}` };
  } finally {
    removeCheckout({ repoRoot, root: worktree, links: [], execGit });
    try {
      execGit(['branch', '-D', branch], repoRoot);
    } catch {
      // it lives on origin now, or never was made
    }
  }
  log(`[INFO] loop: ${reason}; opened ${url} to revert it`);
  try {
    execGh(['issue', 'reopen', String(merge.issue), ...repoArgs, '--comment',
      `The loop's merge of #${merge.pr} broke CI on main (${failed.join(', ')}), so ${url} reverts it, and this is open again: the loop takes it again once main is mended.`], repoRoot);
  } catch (err) {
    log(`[WARN] could not reopen #${merge.issue}: ${err.message}`);
  }
  if (pause) {
    try {
      setLoopPause({ repoRoot, repo, execGh,
        value: `${lately} loop merges reverted within a day (the latest ${url}): the loop's cycles stop until a person deletes this variable` });
      log(`[INFO] loop: paused: ${lately} reverts within a day`);
    } catch (err) {
      log(`[WARN] could not pause the loop: ${err.message}`);
    }
  }
  return { state: 'reverting', reason, pullRequest: url, paused: pause };
}

// The pause variable is read and set through GitHub's REST API, never `gh variable`: that command is
// newer than the gh some drivers install (Debian's 2.23 has none), and a pause that cannot be read must
// not read as "not paused".

/** The REST path of the repository's Actions variables, or of one of them. */
function variablesPath(repo, name) {
  return `repos/${repo || '{owner}/{repo}'}/actions/variables${name ? `/${name}` : ''}`;
}

/** Whether a gh failure is GitHub answering 404: for a variable, that it is not set. */
function notFound(err) {
  return /\bHTTP 404\b/.test(`${err?.message || ''}\n${err?.stderr || ''}`);
}

/** Sets the loop's pause variable to value: updated when it is set, created when it is not. */
export function setLoopPause({ repoRoot, repo, execGh, value }) {
  const fields = ['-f', `name=${LOOP_PAUSE_VARIABLE}`, '-f', `value=${value}`];
  try {
    execGh(['api', '-X', 'PATCH', variablesPath(repo, LOOP_PAUSE_VARIABLE), ...fields], repoRoot);
  } catch (err) {
    if (!notFound(err)) throw err;
    execGh(['api', '-X', 'POST', variablesPath(repo), ...fields], repoRoot);
  }
}

/**
 * Why the loop's cycles are paused by its repository variable, or null when it is not set, empty or 0.
 * A variable that cannot be read (no access, GitHub down) counts as paused, saying so: an off switch
 * that fails open is no off switch.
 */
export function loopPauseReason({ repoRoot, repo, execGh }) {
  let value;
  try {
    value = String(execGh(['api', variablesPath(repo, LOOP_PAUSE_VARIABLE), '--jq', '.value'], repoRoot) || '').trim();
  } catch (err) {
    if (notFound(err)) return null;
    const why = String(err?.message || err).split('\n').map((l) => l.trim()).filter(Boolean).pop();
    return `${LOOP_PAUSE_VARIABLE} could not be read, so the loop counts as paused: ${why}`;
  }
  return value && value !== '0' ? `${LOOP_PAUSE_VARIABLE}: ${value}` : null;
}
