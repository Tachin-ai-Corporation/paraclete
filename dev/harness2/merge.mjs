// dev/harness2/merge.mjs: merges the harness's promotion pull requests, and only those whose measured
// evidence passes for the change as it would land on main's head. A promotion pull request is an open
// one against main from a branch of this repository named `harness2/...` or `h2/...` (promote.mjs
// opens them). Every other pull request is left alone.
//
// Nothing is read or merged while the harness is paused (pause.mjs): the off switch in this checkout,
// in the environment, or on origin/main once it is fetched. Nothing is merged while CI on main's head
// failed or is still running; when main's head has no CI at all (a merge made with a workflow's token
// starts no push run), CI is dispatched on it and nothing is merged until it passes. At most one
// promotion is merged per run, so every merge is checked against the main it lands on: the next run
// checks the rest against the new main.
//
// Each promotion, in pull request number order, is squash-merged only when all of these hold:
//   - every CI check run on its head commit finished with success (dev/release.mjs ciVerdict);
//   - GitHub can merge it cleanly (mergeStateStatus CLEAN), and its head contains main's head, so its
//     CI and its evidence were measured on the main it lands on;
//   - its body carries an evidence block (evidence.mjs parseEvidenceBlock) that judgeEvidence passes,
//     judged afresh here, never by the verdict written into the block, and the block's touchedPaths
//     name every file it changes;
//   - every file it adds or changes is on the mutable surface (validate.mjs validateTouchedPaths); it
//     removes and renames none; the lines it adds to product prompts pass promptAdditionProblems; and
//     a change to config/contracts.json touches only tunable keys within their ceilings
//     (validateContractsMutation, against the file at the merge base).
// Its title must start with a version newer than every version on main and every version tag. A
// stale one is moved to the next free version first (promote.mjs nextPromotionVersion) and the title
// edited, so the squashed commit's subject leaves main's head releasable by dev/release.mjs. The merge
// is pinned to the head commit that was checked (--match-head-commit). After a merge it dispatches CI
// on main, and dev/release.mjs releases a head only once CI passed on it.
//
// A promotion that breaks a rule gets one comment saying why, carrying a hidden marker of its reasons,
// and is not commented on again while a comment of the merger's own (github-actions, or GITHUB_ACTOR)
// carries the same marker. One that is only waiting (CI still running, GitHub still computing whether
// it can merge, a draft, main's CI, another merge this run) is left alone. It never merges with
// --admin, and with --dry-run it changes nothing on GitHub (it still fetches main and the tags, so its
// versions are the ones a real run would use).
//
// Run every hour by .github/workflows/harness-merge.yml through its own command line,
// `node dev/harness2/merge.mjs (--pr <n> | --all) [--dry-run] [--json]`: the workflow installs no
// packages, and cli.mjs (`merge`, the same thing) also loads the real-model runs, which need the
// gateway's. It runs git in this checkout and the GitHub CLI (`gh`), through dev-env.mjs's program
// runner. It does not measure anything, open pull requests, or cut releases.

import { pathToFileURL } from 'node:url';
import { isNewer, versionFromText } from '../../agent/release/versions.mjs';
import { githubRepoFromUrl } from '../deploy.mjs';
import { DevError, REPO_ROOT, createExec, failureDetail } from '../dev-env.mjs';
import { MAIN, REMOTE, checkRuns, ciVerdict, versionTags } from '../release.mjs';
import { judgeEvidence, parseEvidenceBlock } from './evidence.mjs';
import { PAUSE_FILE, pauseState } from './pause.mjs';
import { nextPromotionVersion } from './promote.mjs';
import { promptAdditionProblems, validateContractsMutation, validateTouchedPaths } from './validate.mjs';

/** The head branch prefixes of promotion pull requests. Nothing else is ever merged here. */
export const HARNESS_BRANCH_PREFIXES = Object.freeze(['harness2/', 'h2/']);

/** The name in the hidden marker a refusal comment carries. */
export const MERGE_MARKER = 'paraclete-h2-merge';

/** The logins a workflow's token comments as (GitHub's GraphQL and REST names for it). */
export const MERGER_LOGINS = Object.freeze(['github-actions', 'github-actions[bot]']);

/** The workflow dispatched on main after a merge, or when main's head has no CI. */
export const CI_WORKFLOW = 'ci.yml';

/** The one surface file whose changes are checked key by key. */
export const CONTRACTS_PATH = 'config/contracts.json';

const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const LEADING_VERSION_SHAPE = /^v\d{4}\.\d{2}\.\d{2}\.\d+\.\d+(?![.\d])\s*:?\s*/;
const API_JSON = ['-H', 'Accept: application/vnd.github+json'];

/** How many files one page of GitHub's answer holds (its maximum), and how many pages it gives (3,000 files). */
const FILES_PAGE = 100;
const FILES_MAX_PAGES = 30;

/** The open pull requests one listing reads. */
const LIST_LIMIT = 200;

/** What `gh pr view` is asked for. */
const VIEW_FIELDS = [
  'number', 'title', 'body', 'state', 'isDraft', 'isCrossRepository', 'baseRefName', 'headRefName',
  'headRefOid', 'mergeStateStatus', 'changedFiles', 'comments',
].join(',');

/** GitHub's mergeStateStatus while it is still working the answer out. */
const MERGE_STATE_PENDING = 'UNKNOWN';

/** The file statuses GitHub's files API gives a change that adds or edits a file, and no more. */
const EDIT_STATUSES = new Set(['added', 'modified', 'changed']);

export const MERGE_USAGE = 'Usage: node dev/harness2/cli.mjs merge (--pr <n> | --all) [--dry-run] [--json]';

/** Whether a head branch is a promotion's. */
export function isHarnessBranch(name) {
  return HARNESS_BRANCH_PREFIXES.some((prefix) => String(name ?? '').startsWith(prefix));
}

/** The hidden marker of a refusal comment, one per set of reasons. */
export function refusalMarker(key) {
  return `<!-- ${MERGE_MARKER}: ${key} -->`;
}

/** The logins whose comments count as the merger's own: the workflow token's, and GITHUB_ACTOR's. */
export function mergerLogins(env = {}) {
  return new Set([...MERGER_LOGINS, ...(env.GITHUB_ACTOR ? [String(env.GITHUB_ACTOR)] : [])]);
}

/**
 * A title with its leading version replaced by `version`, the rest kept as written. A title with no
 * version gets one in front.
 *
 * @param {string} title
 * @param {string} version
 * @returns {string}
 */
export function retitle(title, version) {
  const rest = String(title ?? '').trim().replace(LEADING_VERSION_SHAPE, '');
  return rest ? `${version}: ${rest}` : version;
}

/**
 * The version and title a promotion merges with. Its own, when its title starts with a version newer
 * than every version on main (its commit subjects) and every version tag; otherwise the next free
 * version, as promote.mjs picks one, in place of the title's.
 *
 * @param {object} p
 * @param {string} p.title
 * @param {Iterable<string>} p.subjects  main's commit subjects
 * @param {Iterable<string>} p.tags      tag names
 * @param {Date} [p.now]
 * @returns {{version: string, title: string, retitled: boolean, previous: string|null}}
 */
export function promotionVersion({ title, subjects, tags, now = new Date() }) {
  const subjectList = [...subjects];
  const tagList = [...tags];
  const current = versionFromText(title);
  const newest = versionTags([...subjectList.map(versionFromText).filter(Boolean), ...tagList])[0] ?? null;
  if (current && (newest === null || isNewer(current, newest))) {
    return { version: current, title: String(title).trim(), retitled: false, previous: current };
  }
  const version = nextPromotionVersion({ subjects: subjectList, tags: tagList, now });
  return { version, title: retitle(title, version), retitled: true, previous: current };
}

/** The lines a file's patch (GitHub's files API `patch`, a unified diff without file headers) adds. */
export function addedLinesFromPatch(patch) {
  return String(patch ?? '').split(/\r?\n/).filter((line) => line.startsWith('+')).map((line) => line.slice(1));
}

/** A JSON text as an object, or why it is not one. */
function parseObject(text, what) {
  try {
    const value = JSON.parse(String(text));
    if (value && typeof value === 'object' && !Array.isArray(value)) return { value };
    return { error: `${what} is not a JSON object` };
  } catch (err) {
    return { error: `${what} is not JSON (${err.message})` };
  }
}

/**
 * What stands between a promotion and its merge. Refusals are rules it breaks, which a person or a
 * new promotion must fix; waits are states GitHub or CI will move on from by themselves. Pure.
 *
 * @param {object}   p
 * @param {object}   p.pr        `gh pr view`'s answer: body, headRefOid, mergeStateStatus, changedFiles
 * @param {object[]} p.runs      the head commit's check runs
 * @param {object[]} p.files     its files as GitHub's REST API lists them (filename, status, patch, previous_filename)
 * @param {number}   p.behindBy  how many of main's commits its head lacks (GitHub's compare, behind_by)
 * @param {{base: string, head: string}|null} [p.contracts]  config/contracts.json's text at the merge
 *                               base and at the head, when the pull request changes it
 * @returns {{refusals: {key: string, text: string}[], waits: {key: string, text: string}[], evidence: object|null}}
 */
export function mergeBlockers({ pr, runs, files, behindBy, contracts = null }) {
  const refusals = [];
  const waits = [];
  const short = String(pr?.headRefOid || '').slice(0, 12);

  const ci = ciVerdict(runs);
  if (ci.failed.length) refusals.push({ key: 'ci-failed', text: `CI did not pass on ${short}: ${ci.failed.join(', ')}` });
  else if (ci.pending.length) waits.push({ key: 'ci-pending', text: `CI is still running on ${short}: ${ci.pending.join(', ')}` });
  else if (!ci.ok) waits.push({ key: 'ci-pending', text: `no CI check has run on ${short} yet` });

  // GitHub's answer on whether it can merge folds in the checks; it is read on its own once CI passed,
  // except a conflict, which no check run changes.
  const state = String(pr?.mergeStateStatus || MERGE_STATE_PENDING).toUpperCase();
  if (state === MERGE_STATE_PENDING) {
    waits.push({ key: 'merge-state-pending', text: 'GitHub has not worked out yet whether it can be merged' });
  } else if (state !== 'CLEAN' && (ci.ok || state === 'DIRTY')) {
    refusals.push({
      key: `not-mergeable-${state.toLowerCase()}`,
      text: state === 'DIRTY'
        ? `it conflicts with ${MAIN} (mergeStateStatus DIRTY): promote again from ${MAIN}'s head`
        : `GitHub cannot merge it cleanly (mergeStateStatus ${state})`,
    });
  }
  // main has no branch protection, so CLEAN does not mean current: the head must contain main's head.
  if (!(behindBy === 0)) {
    refusals.push({
      key: 'behind-main',
      text: `its head lacks ${Number.isInteger(behindBy) ? `${behindBy} commit(s)` : 'commits'} of ${MAIN}'s head: its CI and evidence were measured on an older ${MAIN}; a promotion from ${MAIN}'s head replaces it`,
    });
  }

  const list = Array.isArray(files) ? files : [];
  const changedPaths = [...new Set(list.map((f) => f?.filename).filter((p) => typeof p === 'string' && p))];
  const allPaths = [...new Set(list.flatMap((f) => [f?.filename, f?.previous_filename]).filter((p) => typeof p === 'string' && p))];

  const evidence = parseEvidenceBlock(pr?.body);
  if (!evidence) {
    refusals.push({ key: 'no-evidence', text: 'its body has no evidence block (```json paraclete-h2-evidence) that parses' });
  } else {
    const verdict = judgeEvidence(evidence);
    if (!verdict.ok) refusals.push({ key: 'evidence-failed', text: `its evidence does not pass: ${verdict.problems.join('; ')}` });
    const measured = new Set((Array.isArray(evidence.touchedPaths) ? evidence.touchedPaths : []).map((p) => String(p).replace(/\\/g, '/')));
    const unmeasured = allPaths.filter((p) => !measured.has(p));
    if (unmeasured.length) {
      refusals.push({
        key: 'unmeasured-files',
        text: `it changes files its evidence did not measure: ${unmeasured.join(', ')} (the evidence names ${[...measured].join(', ') || 'none'})`,
      });
    }
  }

  const changed = Number(pr?.changedFiles);
  if (Number.isInteger(changed) && changed > list.length) {
    refusals.push({ key: 'files-unlisted', text: `GitHub lists ${list.length} of its ${changed} changed files, so not every one can be checked` });
  }
  if (allPaths.length === 0) {
    refusals.push({ key: 'no-change', text: 'it changes no file' });
  } else {
    const surface = validateTouchedPaths(allPaths);
    if (!surface.ok) refusals.push({ key: 'off-surface', text: `it changes files off the mutable surface: ${surface.violations.join('; ')}` });
  }
  const gone = list.filter((f) => !EDIT_STATUSES.has(f?.status));
  if (gone.length) {
    refusals.push({
      key: 'removes-files',
      text: `it ${gone.map((f) => (f?.status === 'renamed' ? `renames ${f.previous_filename} to ${f.filename}` : `${f?.status || 'changes'} ${f?.filename}`)).join(', ')}: a promotion adds or edits files, and removes none`,
    });
  }

  const edited = list.filter((f) => EDIT_STATUSES.has(f?.status));
  const unpatched = edited.filter((f) => typeof f.patch !== 'string').map((f) => f.filename);
  if (unpatched.length) {
    refusals.push({ key: 'no-patch', text: `GitHub shows no diff for ${unpatched.join(', ')}, so the lines it adds cannot be checked` });
  }
  const lint = promptAdditionProblems(Object.fromEntries(edited.filter((f) => typeof f.patch === 'string').map((f) => [f.filename, addedLinesFromPatch(f.patch)])));
  if (lint.length) refusals.push({ key: 'prompt-lint', text: `the lines it adds to product prompts: ${lint.join('; ')}` });

  if (contracts) {
    const base = parseObject(contracts.base, `${CONTRACTS_PATH} at the merge base`);
    const head = parseObject(contracts.head, `${CONTRACTS_PATH} at its head`);
    const problems = [base.error, head.error].filter(Boolean);
    if (!problems.length) problems.push(...validateContractsMutation(head.value, base.value).violations);
    if (problems.length) refusals.push({ key: 'contracts', text: `its ${CONTRACTS_PATH} change is refused: ${problems.join('; ')}` });
  }
  return { refusals, waits, evidence };
}

/** The refusal comment: the reasons, and the marker that keeps them from being posted twice. */
export function refusalComment(reasons, key) {
  return [
    'The harness merger did not merge this promotion:',
    '',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    'It checks every open promotion each hour (`.github/workflows/harness-merge.yml`) and comments again only when the reasons change.',
    '',
    refusalMarker(key),
    '',
  ].join('\n');
}

/**
 * The squashed commit's body: the pull request's evidence summary line (its capability line, or one
 * written from the evidence block when the body has none), and where the merge came from.
 */
export function squashBody({ number, sha, body, evidence }) {
  const written = /^- \*\*Capability\*\*: .+$/m.exec(String(body || ''))?.[0];
  const c = evidence?.capability || {};
  const line = written
    || `- **Capability**: ${c.baseline?.mean ?? '?'} -> ${c.candidate?.mean ?? '?'}, delta ${c.delta ?? '?'}, noise (SE) ${c.noise ?? '?'}`;
  return `${line.trimEnd()}\n\nMerged from #${number} at ${sha} by dev/harness2/merge.mjs: CI passed, the evidence passed judgeEvidence, and every changed file is on the mutable surface.\n`;
}

/** Runs gh; refuses with `what` and gh's own words when it fails. */
async function gh(exec, args, what) {
  const result = await exec('gh', args, {});
  if (result.missing) {
    throw new DevError('gh was not found: install the GitHub CLI (https://cli.github.com) and log in with `gh auth login`.');
  }
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

/** Runs git in the checkout; refuses with `what` and git's own words when it fails. */
async function git(exec, repoRoot, args, what) {
  const result = await exec('git', args, { cwd: repoRoot });
  if (result.missing) throw new DevError('git was not found: install git and run this from a clone of the repository.');
  if (result.code !== 0) throw new DevError(`${what}${failureDetail(result)}`);
  return result.stdout;
}

const lines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** The repository: the workflow's own, or this clone's origin on GitHub. */
async function repository(exec, repoRoot, env) {
  if (REPO.test(String(env.GITHUB_REPOSITORY || ''))) return env.GITHUB_REPOSITORY;
  const url = await git(exec, repoRoot, ['remote', 'get-url', REMOTE], `this clone has no remote ${REMOTE}`);
  const repo = githubRepoFromUrl(url.trim());
  if (!repo) throw new DevError(`${REMOTE} is not a GitHub repository; promotions are pull requests on GitHub.`);
  return repo;
}

/**
 * Main as origin has it, fetched fresh: its head commit, whether it holds the off switch, its commit
 * subjects and the tag names (as nextPromotionVersion takes them).
 */
async function readMain(exec, repoRoot) {
  await git(exec, repoRoot, ['fetch', '--quiet', '--tags', REMOTE, MAIN], `git could not fetch ${MAIN} and the tags from ${REMOTE}`);
  const ref = `refs/remotes/${REMOTE}/${MAIN}`;
  const head = (await git(exec, repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], `this clone has no ${REMOTE}/${MAIN}`)).trim();
  if (!COMMIT.test(head)) throw new DevError(`git named ${REMOTE}/${MAIN}'s head as '${head}', which is not a commit`);
  let paused = null;
  const switchOn = await exec('git', ['cat-file', '-e', `${head}:${PAUSE_FILE}`], { cwd: repoRoot });
  if (switchOn.code === 0) {
    const text = await exec('git', ['cat-file', '-p', `${head}:${PAUSE_FILE}`], { cwd: repoRoot });
    const first = text.code === 0 ? String(text.stdout).split(/\r?\n/)[0].trim() : '';
    paused = `${PAUSE_FILE} on ${REMOTE}/${MAIN}${first ? `: ${first}` : ''}`;
  }
  const subjects = lines(await git(exec, repoRoot, ['log', '--format=%s', head, '--'], `git could not list the commits of ${REMOTE}/${MAIN}`));
  const tags = lines(await git(exec, repoRoot, ['tag', '--list'], 'git could not list the tags'));
  return { head, paused, subjects, tags };
}

/** Why main's head holds every merge back, or null when CI passed on it. */
function mainHold(verdict, head) {
  const short = head.slice(0, 12);
  if (verdict.ok) return null;
  if (verdict.failed.length) return `CI did not pass on ${MAIN}'s head ${short}: ${verdict.failed.join(', ')}`;
  if (verdict.pending.length) return `CI is still running on ${MAIN}'s head ${short}: ${verdict.pending.join(', ')}`;
  return `no CI has run on ${MAIN}'s head ${short} yet`;
}

/** Every file of a pull request, every page. */
async function pullRequestFiles(exec, repo, number) {
  const files = [];
  for (let page = 1; page <= FILES_MAX_PAGES; page += 1) {
    const batch = await ghJson(exec, ['api', ...API_JSON, `repos/${repo}/pulls/${number}/files?per_page=${FILES_PAGE}&page=${page}`],
      `the files of #${number}`);
    if (!Array.isArray(batch)) throw new DevError(`GitHub answered the files of #${number} in a form this script cannot read`);
    files.push(...batch);
    if (batch.length < FILES_PAGE) break;
  }
  return files;
}

/** How a head compares with main's head: the commits of main it lacks, and their merge base. */
async function compareWithMain(exec, repo, mainHead, head) {
  const answer = await ghJson(exec, ['api', ...API_JSON, `repos/${repo}/compare/${mainHead}...${head}`], `how ${head.slice(0, 12)} compares with ${MAIN}`);
  const base = answer?.merge_base_commit?.sha;
  if (!Number.isInteger(answer?.behind_by) || !COMMIT.test(String(base || ''))) {
    throw new DevError(`GitHub answered how ${head.slice(0, 12)} compares with ${MAIN} in a form this script cannot read`);
  }
  return { behindBy: answer.behind_by, mergeBase: base };
}

/** A file's text at a commit, through GitHub's contents API. */
async function fileAt(exec, repo, path, sha) {
  const answer = await ghJson(exec, ['api', ...API_JSON, `repos/${repo}/contents/${path}?ref=${sha}`], `${path} at ${sha.slice(0, 12)}`);
  if (answer?.encoding !== 'base64' || typeof answer.content !== 'string') {
    throw new DevError(`GitHub answered ${path} at ${sha.slice(0, 12)} in a form this script cannot read`);
  }
  return Buffer.from(answer.content, 'base64').toString('utf8');
}

/** Why a pull request is not a promotion this merger may touch, or null when it is one. */
function notAPromotion(pr) {
  if (String(pr.state || '').toUpperCase() !== 'OPEN') return `it is ${String(pr.state || 'not open').toLowerCase()}`;
  if (!isHarnessBranch(pr.headRefName)) return `its branch ${pr.headRefName || '(none)'} is not a promotion's (${HARNESS_BRANCH_PREFIXES.join(', ')})`;
  if (pr.isCrossRepository) return 'its branch is in another repository';
  if (pr.baseRefName !== MAIN) return `it is against ${pr.baseRefName || '(no base)'}, not ${MAIN}`;
  return null;
}

/**
 * One pull request, end to end: read it, judge it, and merge, comment or leave it. `run` is what the
 * whole run shares: main's head and subjects, the tags, why main holds merges back, the logins that
 * count as the merger's, and whether a merge was already tried.
 *
 * @returns {Promise<object>} its result entry
 */
async function considerPullRequest({ exec, repo, number, run, now, dryRun }) {
  const entry = { number, action: 'skipped', reasons: [], version: null, title: null };
  const pr = await ghJson(exec, ['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS], `pull request #${number}`);
  entry.title = typeof pr.title === 'string' ? pr.title : null;
  entry.version = versionFromText(pr.title);
  entry.branch = pr.headRefName || null;

  const outside = notAPromotion(pr);
  if (outside) return { ...entry, reasons: [`not a promotion: ${outside}`] };
  if (pr.isDraft) return { ...entry, reasons: ['it is a draft'] };
  const sha = String(pr.headRefOid || '');
  if (!COMMIT.test(sha)) return { ...entry, reasons: ['GitHub gave no full head commit for it'] };
  entry.head = sha;

  const files = await pullRequestFiles(exec, repo, number);
  const { behindBy, mergeBase } = await compareWithMain(exec, repo, run.mainHead, sha);
  // config/contracts.json is checked key by key, against the file at the merge base (main's head, when
  // the head contains it), so only the promotion's own change is judged.
  const contractsFile = files.find((f) => f?.filename === CONTRACTS_PATH && EDIT_STATUSES.has(f.status));
  const contracts = contractsFile
    ? {
      base: contractsFile.status === 'added' ? '{}' : await fileAt(exec, repo, CONTRACTS_PATH, mergeBase),
      head: await fileAt(exec, repo, CONTRACTS_PATH, sha),
    }
    : null;
  const { refusals, waits, evidence } = mergeBlockers({
    pr, runs: await checkRuns({ exec }, repo, sha), files, behindBy, contracts,
  });

  if (refusals.length) {
    const key = [...new Set(refusals.map((r) => r.key))].sort().join('+');
    const marker = refusalMarker(key);
    const comments = Array.isArray(pr.comments) ? pr.comments : [];
    const reasons = refusals.map((r) => r.text);
    const result = { ...entry, action: 'refused', reasons, key };
    const posted = comments.some((c) => run.logins.has(String(c?.author?.login || '')) && String(c?.body || '').includes(marker));
    if (posted) return { ...result, comment: 'already posted' };
    if (dryRun) return { ...result, comment: 'would post' };
    await gh(exec, ['pr', 'comment', String(number), '--repo', repo, '--body', refusalComment(reasons, key)],
      `gh could not comment on #${number}`);
    return { ...result, comment: 'posted' };
  }
  if (waits.length) return { ...entry, reasons: waits.map((w) => w.text) };
  if (run.hold) return { ...entry, reasons: [run.hold] };

  // One attempt per run, whatever its outcome: a merge GitHub reports as failed may still have landed,
  // and the next promotion must be checked against the main it would land on.
  run.attempted = number;
  const plan = promotionVersion({ title: pr.title, subjects: run.subjects, tags: run.tags, now });
  const merged = {
    ...entry,
    action: 'merged',
    version: plan.version,
    title: plan.title,
    ...(plan.retitled ? { retitledFrom: pr.title } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
  if (!dryRun) {
    if (plan.retitled) {
      await gh(exec, ['pr', 'edit', String(number), '--repo', repo, '--title', plan.title], `gh could not retitle #${number}`);
    }
    await gh(exec, ['pr', 'merge', String(number), '--repo', repo, '--squash', '--subject', plan.title,
      '--body', squashBody({ number, sha, body: pr.body, evidence }), '--match-head-commit', sha],
    `gh could not merge #${number}`);
  }
  return merged;
}

/**
 * Merges at most one open promotion that passes every rule (see the header), or the one `pr` names.
 *
 * @param {object}  [o]
 * @param {string|number} [o.pr]   one pull request's number
 * @param {boolean} [o.all]        every open promotion
 * @param {boolean} [o.dryRun]     judge and report; change nothing on GitHub
 * @param {string}  [o.repoRoot]   the checkout the off switch is read from and git runs in
 * @param {object}  [o.env]        the environment (PARACLETE_H2_PAUSED, GITHUB_REPOSITORY, GITHUB_ACTOR)
 * @param {Function} [o.exec]      (program, args, opts) => Promise<{code, stdout, stderr}>, as dev-env.mjs createExec
 * @param {Date}    [o.now]        the clock a new version's date comes from
 * @returns {Promise<object>} { ok, paused, dryRun, repo, mainHead, hold, results, merged, ciDispatched, error? }
 */
export async function mergePromotionPullRequests(o = {}) {
  const { all = false, dryRun = false, repoRoot = REPO_ROOT, env = process.env, now = new Date() } = o;
  const pr = o.pr === undefined || o.pr === null || o.pr === false ? null : String(o.pr);
  const exec = o.exec || createExec({ env });
  const base = {
    ok: true, paused: false, dryRun: Boolean(dryRun), repo: null, mainHead: null, hold: null, results: [], merged: [], ciDispatched: false,
  };

  if ((pr === null) === !all || (pr !== null && !/^[1-9]\d*$/.test(pr))) {
    return { ...base, ok: false, error: `merge takes --pr <number> or --all\n${MERGE_USAGE}` };
  }
  const pause = pauseState({ repoRoot, env });
  if (pause.paused) return { ...base, paused: true, reason: pause.reason };

  const errors = [];
  let repo;
  let run;
  let listed;
  let ciDispatched = false;
  const dispatchCi = () => gh(exec, ['workflow', 'run', CI_WORKFLOW, '--repo', repo, '--ref', MAIN], `gh could not dispatch ${CI_WORKFLOW} on ${MAIN}`);
  try {
    repo = await repository(exec, repoRoot, env);
    const main = await readMain(exec, repoRoot);
    if (main.paused) return { ...base, repo, mainHead: main.head, paused: true, reason: main.paused };
    const mainCi = ciVerdict(await checkRuns({ exec }, repo, main.head));
    run = { mainHead: main.head, subjects: main.subjects, tags: main.tags, hold: mainHold(mainCi, main.head), logins: mergerLogins(env), attempted: null };
    // A head with no CI at all gets it: after a merge made with a workflow's token, no push run starts.
    if (!mainCi.ok && !mainCi.failed.length && !mainCi.pending.length && !dryRun) {
      try {
        await dispatchCi();
        ciDispatched = true;
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (pr !== null) {
      listed = [{ number: Number(pr) }];
    } else {
      const open = await ghJson(exec, ['pr', 'list', '--repo', repo, '--state', 'open', '--base', MAIN,
        '--limit', String(LIST_LIMIT), '--json', 'number,headRefName,isCrossRepository'], 'the open pull requests');
      if (!Array.isArray(open)) throw new DevError('GitHub answered the open pull requests in a form this script cannot read');
      listed = open.filter((p) => Number.isInteger(p?.number)).sort((a, b) => a.number - b.number);
    }
  } catch (err) {
    return { ...base, repo: repo ?? null, mainHead: run?.mainHead ?? null, ciDispatched, ok: false, error: [...errors, err.message].join('\n') };
  }

  const results = [];
  for (const { number, headRefName, isCrossRepository } of listed) {
    // A listed pull request from any other branch is never read further, let alone touched. (The
    // listing holds open pull requests against main only.)
    const outside = pr === null && notAPromotion({ state: 'OPEN', baseRefName: MAIN, headRefName, isCrossRepository });
    if (outside) {
      results.push({ number, action: 'skipped', reasons: [`not a promotion: ${outside}`], version: null, title: null, branch: headRefName || null });
      continue;
    }
    // After a merge was tried, the rest are not read: what they would be judged against has moved.
    if (run.attempted) {
      const why = `one promotion merges per run, and #${run.attempted} came first: the next run checks this one against ${MAIN} as it is then`;
      results.push({ number, action: 'skipped', reasons: [why], version: null, title: null });
      continue;
    }
    try {
      results.push(await considerPullRequest({ exec, repo, number, run, now, dryRun }));
    } catch (err) {
      errors.push(`#${number}: ${err.message}`);
      results.push({ number, action: 'skipped', reasons: [err.message], version: null, title: null, error: true });
    }
  }
  const merged = results.filter((r) => r.action === 'merged').map((r) => r.number);

  if (merged.length && !dryRun) {
    try {
      await dispatchCi();
      ciDispatched = true;
    } catch (err) {
      errors.push(`${err.message}; the next run dispatches it, since ${MAIN}'s new head has no CI`);
    }
  }
  return {
    ...base,
    ok: errors.length === 0,
    repo,
    mainHead: run.mainHead,
    hold: run.hold,
    results,
    merged,
    ciDispatched,
    ...(errors.length ? { error: errors.join('\n') } : {}),
  };
}

/** The run as lines a person reads: why main holds merges, one line per pull request, what it did on main. */
export function formatMergeReport(result) {
  const out = [];
  if (result.paused) out.push(`Paused (${result.reason}): nothing was merged.`);
  if (result.hold) out.push(`Nothing merges this run: ${result.hold}.`);
  for (const r of result.results || []) {
    const what = r.action === 'merged'
      ? `${result.dryRun ? 'would merge' : 'merged'} as ${r.title}${r.retitledFrom ? ` (retitled from ${r.retitledFrom})` : ''}`
      : `${r.action}${r.reasons.length ? `: ${r.reasons.join('; ')}` : ''}${r.comment ? ` (comment ${r.comment})` : ''}`;
    out.push(`#${r.number} ${what}`);
  }
  if (!result.paused && !(result.results || []).length && !result.error) out.push('No open promotion pull request.');
  if (result.ciDispatched) out.push(`Dispatched ${CI_WORKFLOW} on ${MAIN}.`);
  if (result.error) out.push(`Error: ${result.error}`);
  if (result.dryRun) out.push('Dry run: nothing was changed on GitHub.');
  return `${out.join('\n')}\n`;
}

/**
 * The command line, as cli.mjs `merge` takes it.
 *
 * @param {string[]} argv
 * @param {object} [deps]  mergePromotionPullRequests' options, and stdout
 * @returns {Promise<number>} exit code: 0 the run finished, 1 it did not, 2 a usage mistake
 */
export async function main(argv, { stdout = process.stdout, ...deps } = {}) {
  const flags = { pr: null, all: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pr') flags.pr = argv[++i] ?? '';
    else if (a === '--all') flags.all = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--json') flags.json = true;
    else {
      stdout.write(`unknown argument: ${a}\n${MERGE_USAGE}\n`);
      return 2;
    }
  }
  const res = await mergePromotionPullRequests({ ...deps, pr: flags.pr, all: flags.all, dryRun: flags.dryRun });
  stdout.write(flags.json ? `${JSON.stringify(res, null, 2)}\n` : formatMergeReport(res));
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
