// dev/loop/guard.mjs: the check every loop pull request must pass before anything merges it, run by CI
// on the base branch's code (.github/workflows/loop-guard.yml) and again by the loop's merger
// (merger.mjs). A loop pull request is one from a `loop/` branch of this repository; any other passes
// at once. It passes only when, judged afresh from the pull request as GitHub has it:
//
//   - its body names the issue it resolves ("Resolves #<n>."), and that issue is open and labelled `loop`;
//   - no file it changes is the referee's, no existing test is changed or removed, and a change to code
//     adds a test (config.mjs pathRefusal and testRefusal, as the cycle applies them);
//   - its body carries a review block (reviewer.mjs) whose points are the issue's "Done when" as the
//     issue reads now, and whose verdict judgeReview passes; the verdict written into the block counts
//     for nothing;
//   - the files it changes are exactly the ones reviewed, with the reviewed contents (each file's blob,
//     as the block records it), so nothing pushed after the review merges unreviewed;
//   - a change to what the agent reads carries measured evidence that no task got worse
//     (cycle.mjs regressionProblems) and names every file it changes.
//
// A revert pull request (sentinel.mjs, a `loop/revert-` branch) is checked by revertGuard instead: it
// sets every file the loop merge it names touched back to what it was before, and changes nothing else.
//
// It reads; it never merges, comments or changes anything.
//
//   node dev/loop/guard.mjs --pr <n> [--repo <owner/name>] [--json]
//
// Exit codes: 0 passes (or not a loop pull request), 1 fails or cannot read, 2 a usage mistake.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseEvidenceBlock } from '../harness2/evidence.mjs';
import { LOOP_DEFAULTS, isBehaviourPath, pathRefusal, testRefusal } from './config.mjs';
import { regressionProblems } from './cycle.mjs';
import { REVIEW_BLOCK, doneWhen, judgeReview, parseReview } from './reviewer.mjs';
import { isRevertBranch, parseRevertBlock, readReverted, revertGuard } from './sentinel.mjs';

/** GitHub's file statuses, as the name-status letters the loop's rules take. */
const STATUS_LETTER = Object.freeze({ added: 'A', removed: 'D', modified: 'M', changed: 'M', renamed: 'R', copied: 'C' });

/** Whether a head branch is the loop's. */
export function isLoopBranch(name) {
  return String(name || '').startsWith(LOOP_DEFAULTS.branchPrefix);
}

/** The issue a pull request's body says it resolves, or null. */
export function resolvedIssue(body) {
  const m = /\bResolves #(\d+)\b/.exec(String(body || ''));
  return m ? Number(m[1]) : null;
}

/** The review block a pull request's body carries (reviewer.mjs formatReviewMarkdown), or null. */
export function parseReviewBlock(body) {
  const m = new RegExp(`\`\`\`json ${REVIEW_BLOCK}\\s*\\n([\\s\\S]*?)\\n\`\`\``).exec(String(body || ''));
  if (!m) return null;
  try {
    const block = JSON.parse(m[1]);
    return block && typeof block === 'object' ? block : null;
  } catch {
    return null;
  }
}

/** A pull request's files, as GitHub's REST API lists them, as the loop's changes. */
export function changesFromFiles(files) {
  return (files || []).map((f) => ({
    status: STATUS_LETTER[f?.status] || 'M',
    path: String(f?.filename || ''),
    ...(f?.previous_filename ? { oldPath: String(f.previous_filename) } : {}),
    sha: f?.status === 'removed' ? null : String(f?.sha || ''),
  }));
}

/**
 * The verdict on one pull request. Pure.
 *
 * @param {object} p
 * @param {object} p.pr        { headRefName, isCrossRepository, body }
 * @param {object[]} p.files   as GitHub's REST API lists them: { filename, status, sha, previous_filename }
 * @param {object|null} p.issue  { number, title, body, state, labels: [{ name }] }, the issue it names
 * @param {object|null} [p.reverted]  for a revert pull request, the commit it names (sentinel.mjs readReverted)
 * @returns {{ loop: boolean, revert?: boolean, ok: boolean, problems: string[], issue: number|null }}
 */
export function loopGuard({ pr, files, issue, reverted = null }) {
  if (!isLoopBranch(pr?.headRefName) || pr?.isCrossRepository) return { loop: false, ok: true, problems: [], issue: null };
  if (isRevertBranch(pr.headRefName)) {
    const { ok, problems } = revertGuard({ pr, files, reverted });
    return { loop: true, revert: true, ok, problems, issue: null };
  }
  const problems = [];
  const number = resolvedIssue(pr.body);
  if (!number) problems.push('its body names no issue it resolves ("Resolves #<n>.")');
  else if (!issue || issue.number !== number) problems.push(`issue #${number} could not be read`);
  else {
    if (String(issue.state || '').toUpperCase() !== 'OPEN') problems.push(`issue #${number} is not open`);
    if (!(issue.labels || []).some((l) => l?.name === LOOP_DEFAULTS.label)) problems.push(`issue #${number} is not labelled ${LOOP_DEFAULTS.label}`);
  }

  const changes = changesFromFiles(files);
  if (!changes.length) problems.push('it changes no file');
  problems.push(...changes.flatMap((c) => [pathRefusal(c.path, c.status), c.oldPath ? pathRefusal(c.oldPath, 'D') : null]).filter(Boolean));
  const untested = testRefusal(changes);
  if (untested) problems.push(untested);

  const block = parseReviewBlock(pr.body);
  if (!block) {
    problems.push(`its body carries no review block (\`\`\`json ${REVIEW_BLOCK}) that parses`);
  } else {
    const items = Array.isArray(block.items) ? block.items.map(String) : [];
    if (issue && issue.number === number && JSON.stringify(items) !== JSON.stringify(doneWhen(issue))) {
      problems.push(`its review judged points other than issue #${number}'s "Done when" as it reads now`);
    }
    const decision = judgeReview(parseReview(JSON.stringify(block.review || {})), items);
    if (!items.length || !decision.ok) {
      const unmet = decision.unmet.map((u) => `point ${u.n} is not met`).concat(decision.problems);
      problems.push(`its review does not pass: ${unmet.join('; ') || 'it judged no point'}`);
    }
    const reviewed = block.files && typeof block.files === 'object' ? block.files : {};
    const now = new Map(changes.flatMap((c) => [[c.path, c.sha], ...(c.oldPath ? [[c.oldPath, null]] : [])]));
    const differ = [...new Set([...Object.keys(reviewed), ...now.keys()])]
      .filter((p) => !(p in reviewed) || !now.has(p) || (reviewed[p] ?? null) !== now.get(p));
    if (differ.length) problems.push(`it is not the change that was reviewed: ${differ.join(', ')} differ from the reviewed files`);
  }

  if (changes.some((c) => isBehaviourPath(c.path) || (c.oldPath && isBehaviourPath(c.oldPath)))) {
    const evidence = parseEvidenceBlock(pr.body);
    if (!evidence) problems.push("it changes the agent's behaviour and carries no evidence block (```json paraclete-h2-evidence)");
    else {
      problems.push(...regressionProblems(evidence));
      const measured = new Set((evidence.touchedPaths || []).map((p) => String(p).replace(/\\/g, '/')));
      const unmeasured = changes.map((c) => c.path).filter((p) => !measured.has(p));
      if (unmeasured.length) problems.push(`its evidence did not measure ${unmeasured.join(', ')}`);
    }
  }
  return { loop: true, ok: problems.length === 0, problems, issue: number };
}

function defaultExecGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The pull request, its files and the issue it names, as the guard reads them through the GitHub CLI.
 *
 * @param {Function} execGh  (args) => stdout
 * @param {number} number
 * @param {string} repo      owner/name
 * @returns {Promise<{ pr: object, files: object[], issue: object|null, reverted: object|null }>}
 */
export async function readLoopPullRequest(execGh, number, repo) {
  const pr = JSON.parse(execGh(['pr', 'view', String(number), '--repo', repo, '--json', 'number,headRefName,isCrossRepository,body,headRefOid']));
  if (!isLoopBranch(pr.headRefName) || pr.isCrossRepository) return { pr, files: [], issue: null, reverted: null };
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = JSON.parse(execGh(['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`]));
    files.push(...batch);
    if (batch.length < 100) break;
  }
  if (isRevertBranch(pr.headRefName)) {
    const block = parseRevertBlock(pr.body);
    const getJson = (p) => JSON.parse(execGh(['api', '-H', 'Accept: application/vnd.github+json', p]));
    return { pr, files, issue: null, reverted: block ? await readReverted(getJson, repo, block.reverts) : null };
  }
  const n = resolvedIssue(pr.body);
  let issue = null;
  if (n) {
    try {
      issue = JSON.parse(execGh(['issue', 'view', String(n), '--repo', repo, '--json', 'number,title,body,state,labels']));
    } catch {
      issue = null;
    }
  }
  return { pr, files, issue, reverted: null };
}

function parseArgs(argv) {
  const o = { pr: null, repo: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pr') o.pr = Number(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i] || null;
    else if (a === '--json') o.json = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (!Number.isInteger(o.pr) || o.pr <= 0) return { error: '--pr <number> is required' };
  if (!o.repo) return { error: '--repo <owner/name> is required' };
  return o;
}

/**
 * The command line.
 *
 * @param {string[]} argv
 * @param {object} [deps]  { execGh, stdout, stderr }
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { execGh = defaultExecGh, stdout = process.stdout, stderr = process.stderr } = {}) {
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`${opts.error}\nUsage: node dev/loop/guard.mjs --pr <n> --repo <owner/name> [--json]\n`);
    return 2;
  }
  let verdict;
  try {
    verdict = loopGuard(await readLoopPullRequest(execGh, opts.pr, opts.repo));
  } catch (err) {
    stderr.write(`could not read pull request #${opts.pr}: ${String(err.message || err).split('\n')[0]}\n`);
    return 1;
  }
  if (opts.json) stdout.write(`${JSON.stringify({ pr: opts.pr, ...verdict }, null, 2)}\n`);
  else if (!verdict.loop) stdout.write(`#${opts.pr} is not a loop pull request; nothing to check.\n`);
  else if (verdict.ok && verdict.revert) stdout.write(`#${opts.pr} passes the loop guard: it reverts exactly the loop merge it names.\n`);
  else if (verdict.ok) stdout.write(`#${opts.pr} passes the loop guard: its review of #${verdict.issue} passes, for the files it changes.\n`);
  else stdout.write(`#${opts.pr} does not pass the loop guard:\n${verdict.problems.map((p) => `- ${p}`).join('\n')}\n`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
