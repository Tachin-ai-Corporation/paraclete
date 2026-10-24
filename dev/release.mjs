#!/usr/bin/env node
// dev/release.mjs: cuts a release of this repo, and writes a release's notes. A release is a version
// tag on main (agent/release/versions.mjs defines versions), published as a GitHub release by
// .github/workflows/release.yml once the tag's tests pass; instances offer it as an update from then on.
//
// Cutting one (no command): from main's head, on a maintainer's machine with git and the GitHub CLI
// (`gh`, logged in). It refuses unless the tree is clean, main's head is the commit origin has, every
// CI check run on that commit finished with success, the head commit's subject starts with a version,
// and that version is newer than every version tag here and on origin and not taken. Then it makes an
// annotated tag at the head and pushes it to origin, which starts the workflow. `--dry-run` checks
// everything and shows the notes, and tags nothing. Running it again after a failed push pushes the
// tag it made; after a finished one it says so.
//
// `notes <tag>` prints a release's notes: a title line, then one line per commit since the previous
// version tag (the newest one older than this tag that was not withdrawn, in version order, never git's
// date order; GitHub is asked which were), each the commit's subject as written, oldest first. It follows main's own line of commits (first parent), and
// a merge commit there stands for the commits it brought in, never for itself: a pull request merged
// without squashing still shows its changes. `check <tag>` refuses a tag that is not a version or
// whose commit is not on origin/main. The workflow runs both. Nothing here is installed on an instance.
//
// `yank <tag> --reason "<why>"` withdraws a published release (agent/release/versions.mjs says what
// that is): `gh release edit` marks it a prerelease and puts `Withdrawn: <why>` first in its notes, so
// dashboards that check for withdrawn releases start no new upgrade to it. A second run with the same
// reason changes nothing. The tag stays, so every later release must still be newer than it. It warns
// when the tag's own release workflow lacks WORKFLOW_RERUN_GUARD: a rerun of that one publishes the
// release again.
//
// dev/release-check.mjs checks a release on a dev instance before cutting it, with the parts exported
// here: checkCandidate, showNotes and pushReleaseTag.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WITHDRAWAL_REASON_MAX_CHARS, compareVersions, isVersion, versionFromText, withdrawalReason, withdrawnFromGitHub, withdrawnNotes,
} from '../agent/release/versions.mjs';
import { githubRepoFromUrl } from './deploy.mjs';
import { DevError, devContext, failureDetail, isMain, preview, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/release.mjs [--dry-run]
       node dev/release.mjs notes <tag>
       node dev/release.mjs check <tag>
       node dev/release.mjs yank <tag> --reason "<why>"
Cuts a release from main's head: the tree is clean, origin has the commit, CI passed on it, and the
version its subject starts with is newer than every version tag. Then it pushes an annotated tag, and
.github/workflows/release.yml tests the tag again and publishes the GitHub release.
  --dry-run    check everything and show the tag and its notes; change nothing
  notes <tag>  print a release's notes: one line per commit since the previous version tag that
               was not withdrawn
  check <tag>  refuse a tag that is not a version, or whose commit is not on origin/main
  yank <tag>   withdraw a published release: GitHub marks it a prerelease, its notes start with
               "Withdrawn: <why>", and dashboards start no new upgrade to it. The tag stays.
  --reason     why it is withdrawn, one line (yank only, and required there)`;

/** The branch releases are cut from, and the remote they are pushed to. */
export const MAIN = 'main';
export const REMOTE = 'origin';

const COMMIT = /^[0-9a-f]{40}$/;
const COMMANDS = new Set(['notes', 'check', 'yank']);

/** How many check runs one page of GitHub's answer holds (its maximum), and how many pages to read. */
const CHECK_RUNS_PAGE = 100;
const CHECK_RUNS_MAX_PAGES = 10;

/** How many releases one page of GitHub's answer holds (its maximum), and how many pages to read. */
const RELEASES_PAGE = 100;
const RELEASES_MAX_PAGES = 10;

function parseArgs(argv) {
  const opts = { command: 'cut', tag: null, dryRun: false, reason: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--reason') {
      if (i + 1 >= argv.length) throw new DevError(`--reason needs a value\n${USAGE}`, 2);
      opts.reason = argv[i += 1];
    } else if (arg.startsWith('-')) throw new DevError(`Unknown option: ${arg}\n${USAGE}`, 2);
    else positional.push(arg);
  }
  if (opts.help) return opts;
  if (positional.length) {
    const [command, tag, ...rest] = positional;
    if (!COMMANDS.has(command)) throw new DevError(`Unknown command: ${command}\n${USAGE}`, 2);
    if (!tag || rest.length) throw new DevError(`${command} takes exactly one tag\n${USAGE}`, 2);
    opts.command = command;
    opts.tag = tag;
  }
  if (opts.dryRun && opts.command !== 'cut') throw new DevError(`--dry-run is for cutting a release\n${USAGE}`, 2);
  if (opts.reason !== null && opts.command !== 'yank') throw new DevError(`--reason is for yank\n${USAGE}`, 2);
  if (opts.command === 'yank') opts.reason = withdrawalLine(opts.reason);
  return opts;
}

/** A withdrawal's reason as one line; refuses (exit 2) none, or one too long for a line. */
function withdrawalLine(reason) {
  const line = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!line) throw new DevError(`yank needs --reason "<why>": the line every dashboard shows for the release\n${USAGE}`, 2);
  if (line.length > WITHDRAWAL_REASON_MAX_CHARS) {
    throw new DevError(`--reason is ${line.length} characters; keep it to ${WITHDRAWAL_REASON_MAX_CHARS}, one line. `
      + 'The details belong in an issue the line can name.', 2);
  }
  return line;
}

/**
 * The version tags among some tag names, once each, newest first.
 *
 * @param {Iterable<string>} names
 * @returns {string[]}
 */
export function versionTags(names) {
  return [...new Set([...names].filter(isVersion))].sort((a, b) => compareVersions(b, a));
}

/**
 * The previous version tag of a release: the newest version tag older than `version` that was not
 * withdrawn, or null for the first release. Version order, so a tag made later for an older version
 * changes nothing. A withdrawn release is skipped because no instance moves to it: one on the release
 * before it moves straight to this one, so this one's notes list the withdrawn one's changes too.
 *
 * @param {Iterable<string>} tags
 * @param {string} version
 * @param {Set<string>} [withdrawn] the withdrawn version tags (withdrawnTags)
 * @returns {string|null}
 */
export function previousVersion(tags, version, withdrawn = new Set()) {
  return versionTags(tags).find((tag) => compareVersions(tag, version) < 0 && !withdrawn.has(tag)) ?? null;
}

/**
 * A release's notes: the title line, a blank line, then one line per commit subject, as given.
 *
 * @param {object}      o
 * @param {string}      o.version
 * @param {string|null} o.previous  the previous version tag, null for the first release
 * @param {string[]}    o.subjects  the commits' subjects, oldest first
 * @returns {string}
 */
export function releaseNotes({ version, previous, subjects }) {
  const title = previous ? `Changes in ${version} since ${previous}` : `Changes in ${version}, the first release`;
  const body = subjects.length ? subjects.map((subject) => `- ${subject}`).join('\n') : `No commits since ${previous}.`;
  return `${title}\n\n${body}\n`;
}

/**
 * The tags in `git ls-remote --tags` output, each with the commit it names: an annotated tag's peeled
 * `^{}` line gives its commit, a lightweight tag's own line is one.
 *
 * @param {string} output `<sha>\t<refname>` lines
 * @returns {Map<string, string>} tag name -> commit
 */
export function remoteTags(output) {
  const tags = new Map();
  const peeled = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !COMMIT.test(sha) || !ref?.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) peeled.set(name.slice(0, -3), sha);
    else tags.set(name, sha);
  }
  for (const [name, sha] of peeled) tags.set(name, sha);
  return tags;
}

/**
 * What GitHub's check runs say about a commit. It passed only when there is at least one run and
 * every run finished with success; a run still queued or in progress, or one that finished any other
 * way (failure, cancelled, skipped, timed out...), holds the release back.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string|null}>} runs
 * @returns {{ok: boolean, passed: string[], pending: string[], failed: string[]}}
 */
export function ciVerdict(runs) {
  const passed = [];
  const pending = [];
  const failed = [];
  for (const run of runs) {
    const name = typeof run?.name === 'string' && run.name ? run.name : 'an unnamed check';
    if (run?.status !== 'completed') pending.push(`${name} (${run?.status || 'no status'})`);
    else if (run.conclusion !== 'success') failed.push(`${name} (${run.conclusion || 'no conclusion'})`);
    else passed.push(name);
  }
  return { ok: passed.length > 0 && pending.length === 0 && failed.length === 0, passed, pending, failed };
}

/** Runs git in this clone; refuses with `what` and git's own words when it fails. */
async function gitOut(ctx, args, what) {
  const result = await ctx.git(args);
  if (result.missing) throw new DevError('git was not found: install git and run this from your clone.');
  if (result.code !== 0) throw new DevError(`${what}${failureDetail(result)}`);
  return result.stdout.trim();
}

/** Tag names in this clone. */
async function localTags(ctx) {
  return (await gitOut(ctx, ['tag', '--list'], 'git could not list the tags')).split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
}

/** The commit a ref names in this clone, or null. */
async function commitOf(ctx, ref) {
  const result = await ctx.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = result.code === 0 ? result.stdout.trim() : '';
  return COMMIT.test(sha) ? sha : null;
}

/** Non-empty lines, each without its trailing whitespace. */
const lines = (text) => text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);

/**
 * The subjects of the commits after `from` up to `to`, oldest first. It walks main's own line (first
 * parent). A merge commit on it is replaced by the commits it brought in, the ones its later parents
 * reach and its first parent (and `from`) do not, no merges among them, in their own order. So the
 * merge itself never appears, and no commit appears twice.
 */
async function subjectsBetween(ctx, from, to) {
  const range = from ? `${from}..${to}` : to;
  const mainLine = await gitOut(ctx, ['log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%s', range, '--'],
    `git could not list the commits of ${range}`);
  const subjects = [];
  for (const entry of lines(mainLine)) {
    const [sha, parentList = '', subject = ''] = entry.split('\0');
    const [first, ...merged] = parentList.split(' ').filter(Boolean);
    if (merged.length === 0) {
      subjects.push(subject.trimEnd());
      continue;
    }
    const brought = await gitOut(ctx,
      ['log', '--no-merges', '--reverse', '--topo-order', '--format=%s', ...merged, `^${first}`, ...(from ? [`^${from}`] : []), '--'],
      `git could not list the commits merged by ${sha}`);
    subjects.push(...lines(brought));
  }
  return subjects.filter(Boolean);
}

/** Runs the GitHub CLI; refuses, saying how to get it, when it is not installed. */
async function ghRun(ctx, args) {
  const result = await ctx.exec('gh', args, {});
  if (result.missing) {
    throw new DevError('gh was not found: install the GitHub CLI (https://cli.github.com) and log in with `gh auth login`.');
  }
  return result;
}

/** The commit's check runs on GitHub, every page, through the GitHub CLI. */
async function checkRuns(ctx, repo, sha) {
  const runs = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
    const path = `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=${CHECK_RUNS_PAGE}&page=${page}`;
    const result = await ghRun(ctx, ['api', '-H', 'Accept: application/vnd.github+json', path]);
    if (result.code !== 0) throw new DevError(`gh could not read the check runs of ${sha.slice(0, 12)} on ${repo}${failureDetail(result)}`);
    let body;
    try { body = JSON.parse(result.stdout); } catch { body = null; }
    if (!body || !Array.isArray(body.check_runs)) throw new DevError(`GitHub answered the check runs of ${sha.slice(0, 12)} in a form this script cannot read`);
    runs.push(...body.check_runs);
    const total = Number.isInteger(body.total_count) ? body.total_count : runs.length;
    if (body.check_runs.length === 0 || runs.length >= total) return runs;
  }
  return runs;
}

/**
 * The repository's withdrawn version tags: the releases GitHub lists as prereleases
 * (agent/release/versions.mjs withdrawnFromGitHub), every page, through the GitHub CLI.
 *
 * @param {object} ctx
 * @param {string} repo owner/name
 * @returns {Promise<Set<string>>}
 */
export async function withdrawnTags(ctx, repo) {
  const withdrawn = new Set();
  for (let page = 1; page <= RELEASES_MAX_PAGES; page += 1) {
    const result = await ghRun(ctx, ['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/releases?per_page=${RELEASES_PAGE}&page=${page}`]);
    if (result.code !== 0) throw new DevError(`gh could not list the releases of ${repo}${failureDetail(result)}`);
    let body;
    try { body = JSON.parse(result.stdout); } catch { body = null; }
    if (!Array.isArray(body)) throw new DevError(`GitHub answered the releases of ${repo} in a form this script cannot read`);
    for (const { version } of withdrawnFromGitHub(body)) withdrawn.add(version);
    if (body.length < RELEASES_PAGE) break;
  }
  return withdrawn;
}

/** This clone's origin as owner/name on GitHub; refuses when it is not on GitHub. */
async function originRepo(ctx) {
  const repo = githubRepoFromUrl(await gitOut(ctx, ['remote', 'get-url', REMOTE], `this clone has no remote ${REMOTE}`));
  if (!repo) throw new DevError(`${REMOTE} is not a GitHub repository; releases are published on GitHub.`);
  return repo;
}

/**
 * `notes <tag>`: the notes, alone on stdout, for the workflow to publish. They start after the
 * previous version tag that was not withdrawn, so GitHub is asked which were (the workflow's token).
 */
async function printNotes(ctx, tag) {
  if (!isVersion(tag)) throw new DevError(`'${tag}' is not a version (vYYYY.MM.DD.N.N), so it is not a release`, 2);
  if (!await commitOf(ctx, `refs/tags/${tag}`)) throw new DevError(`this clone has no tag ${tag}; fetch the tags first: git fetch --tags ${REMOTE}`);
  const previous = previousVersion(await localTags(ctx), tag, await withdrawnTags(ctx, await originRepo(ctx)));
  const subjects = await subjectsBetween(ctx, previous && `refs/tags/${previous}`, `refs/tags/${tag}`);
  ctx.stdout.write(releaseNotes({ version: tag, previous, subjects }));
  return 0;
}

/** `check <tag>`: whether a pushed tag is a release: a version, at a commit on origin/main. */
async function checkTag(ctx, tag) {
  if (!isVersion(tag)) throw new DevError(`'${tag}' is not a version (vYYYY.MM.DD.N.N), so it is not a release`);
  const commit = await commitOf(ctx, `refs/tags/${tag}`);
  if (!commit) throw new DevError(`this clone has no tag ${tag}; fetch the tags first: git fetch --tags ${REMOTE}`);
  const mainRef = `refs/remotes/${REMOTE}/${MAIN}`;
  if (!await commitOf(ctx, mainRef)) throw new DevError(`this clone has no ${REMOTE}/${MAIN}; fetch it first: git fetch ${REMOTE} ${MAIN}`);
  const onMain = await ctx.git(['merge-base', '--is-ancestor', commit, mainRef]);
  if (onMain.code === 1) throw new DevError(`${tag} is commit ${commit}, which is not on ${REMOTE}/${MAIN}: a release is cut from ${MAIN} only`);
  if (onMain.code !== 0) throw new DevError(`git could not tell whether ${commit} is on ${REMOTE}/${MAIN}${failureDetail(onMain)}`);
  ctx.out(`${tag} is commit ${commit}, on ${REMOTE}/${MAIN}: a release.`);
  return 0;
}

/**
 * Shows the notes a release of `candidate` would carry. Best effort: a previous tag whose commit this
 * clone lacks only skips them.
 *
 * @param {object} ctx       from devContext()
 * @param {object} candidate checkCandidate()
 */
export async function showNotes(ctx, { version, previous, previousCommit, head }) {
  try {
    const subjects = await subjectsBetween(ctx, previousCommit, head);
    ctx.out(`Its notes:\n\n${releaseNotes({ version, previous, subjects }).trimEnd().replace(/^(?=.)/gm, '  ')}\n`);
  } catch (err) {
    ctx.warn(`warning: the notes cannot be shown here (${err.message.split('\n')[0]}); the workflow writes them from the tag.`);
  }
}

/**
 * Whether main's head can be released, checked the way a cut checks it, each finding printed as it is
 * made: this clone is on `main` with a clean tree, origin has `main` at the same commit, the head's
 * subject starts with a version, that version is newer than every version tag here and on origin and
 * not taken, and every CI check run on the head passed. Throws DevError, saying what to do, when it
 * cannot be released. Changes nothing.
 *
 * When origin already has the version's tag at the head, it is released: the answer has `released`
 * true, and nothing after the tags (CI) was read.
 *
 * @param {object} ctx from devContext()
 * @returns {Promise<{head: string, subject: string, version: string, repo: string, url: string,
 *   released: boolean, tagged: boolean, previous: string|null, previousCommit: string|null}>}
 *   `url` is the release's page on GitHub; `tagged` says this clone has the tag at the head already
 *   (a push that failed); `previous` is the previous version tag and `previousCommit` its commit
 */
export async function checkCandidate(ctx) {
  const branch = await ctx.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.missing) throw new DevError('git was not found: install git and run this from your clone.');
  const on = branch.code === 0 ? branch.stdout.trim() : '';
  if (on !== MAIN) throw new DevError(`Releases are cut from ${MAIN}, and this clone is on ${on || 'a detached HEAD'}: git switch ${MAIN}`);
  const status = await ctx.git(['status', '--porcelain']);
  if (status.code !== 0) throw new DevError(`git status failed${failureDetail(status)}`);
  const changes = status.stdout.split(/\r?\n/).filter((line) => line.trim());
  if (changes.length) throw new DevError(`The working tree is not clean; commit, stash or remove these first:\n${changes.join('\n')}`);

  const head = await gitOut(ctx, ['rev-parse', 'HEAD'], `git could not read ${MAIN}'s head`);
  const subject = await gitOut(ctx, ['log', '-1', '--format=%s', head], `git could not read ${head}`);
  const version = versionFromText(subject);
  if (!version) {
    throw new DevError(`${MAIN}'s head ${head.slice(0, 12)} is not a release: its subject does not start with a version `
      + `(vYYYY.MM.DD.N.N: ...): ${preview(subject)}`);
  }
  const repo = await originRepo(ctx);
  ctx.out(`${MAIN} is at ${head}: ${subject}`);

  const remoteMain = (await gitOut(ctx, ['ls-remote', REMOTE, `refs/heads/${MAIN}`], `git could not read ${REMOTE}`)).split(/\s+/)[0];
  if (remoteMain !== head) {
    throw new DevError(COMMIT.test(remoteMain || '')
      ? `${REMOTE} has ${MAIN} at ${remoteMain.slice(0, 12)}, and this clone at ${head.slice(0, 12)}: push (or pull) first, so the release is a commit everyone has.`
      : `${REMOTE} has no ${MAIN} branch; push it first.`);
  }

  const remote = remoteTags(await gitOut(ctx, ['ls-remote', '--tags', REMOTE], `git could not list ${REMOTE}'s tags`));
  const local = await localTags(ctx);
  const url = `https://github.com/${repo}/releases/tag/${version}`;
  const candidate = { head, subject, version, repo, url, released: false, tagged: false, previous: null, previousCommit: null };
  if (remote.has(version)) {
    if (remote.get(version) !== head) {
      throw new DevError(`${version} is taken: ${REMOTE} has it at ${remote.get(version).slice(0, 12)}. Commit with a newer version first.`);
    }
    return { ...candidate, released: true };
  }
  let tagged = false;
  if (local.includes(version)) {
    const at = await commitOf(ctx, `refs/tags/${version}`);
    if (at !== head) {
      throw new DevError(`${version} is taken in this clone, at ${at ? at.slice(0, 12) : 'something that is not a commit'}. `
        + `If that tag was a mistake, delete it (git tag -d ${version}) and run this again.`);
    }
    tagged = true;
  }
  const allTags = [...remote.keys(), ...local];
  const newest = versionTags(allTags).find((tag) => tag !== version) ?? null;
  if (newest && compareVersions(version, newest) <= 0) {
    throw new DevError(`${version} is not newer than ${newest}, the newest version tag. A release must be: commit with a newer version first.`);
  }
  ctx.out(newest ? `${version} is newer than ${newest}, the newest version tag, and not taken.` : `${version} is the first release.`);

  const verdict = ciVerdict(await checkRuns(ctx, repo, head));
  if (!verdict.ok) {
    if (verdict.failed.length) throw new DevError(`CI did not pass on ${head.slice(0, 12)}: ${verdict.failed.join(', ')}. Fix it with a new commit.`);
    if (verdict.pending.length) throw new DevError(`CI is still running on ${head.slice(0, 12)}: ${verdict.pending.join(', ')}. Run this again when it has passed.`);
    throw new DevError(`No CI check has run on ${head.slice(0, 12)} yet. Run this again when CI has passed.`);
  }
  ctx.out(`CI passed on ${head.slice(0, 12)}: ${verdict.passed.join(', ')}.`);

  const withdrawn = await withdrawnTags(ctx, repo);
  const previous = previousVersion(allTags, version, withdrawn);
  const skipped = versionTags(allTags).filter((tag) => withdrawn.has(tag) && compareVersions(tag, version) < 0
    && (!previous || compareVersions(tag, previous) > 0));
  if (skipped.length) ctx.out(`Its notes start after ${previous || 'the first commit'}: ${skipped.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} withdrawn.`);
  const previousCommit = previous ? (remote.get(previous) || await commitOf(ctx, `refs/tags/${previous}`)) : null;
  return { ...candidate, tagged, previous, previousCommit };
}

/**
 * Releases a candidate checkCandidate() passed: an annotated tag of its version at its head, with
 * `message`, pushed to origin, which starts the release workflow. A tag this clone already has at the
 * head (`tagged`: a push that failed) is pushed as it is, with the message it was made with.
 *
 * @param {object} ctx
 * @param {object} candidate     checkCandidate()
 * @param {object} o
 * @param {string} o.message     the annotated tag's message
 * @param {string} [o.again]     what to do after a failed push, for its message
 */
export async function pushReleaseTag(ctx, { version, head, repo, url, tagged }, { message, again = 'run this again to push it' }) {
  if (tagged) ctx.out(`This clone already has the tag ${version} at this commit; pushing it.`);
  else await gitOut(ctx, ['tag', '--annotate', version, '--message', message, head], `git could not make the tag ${version}`);
  const pushed = await ctx.git(['push', REMOTE, `refs/tags/${version}`], { onStderr: (chunk) => ctx.stderr.write(chunk), collect: false });
  if (pushed.code !== 0) {
    throw new DevError(`git could not push ${version} to ${REMOTE} (exit ${pushed.code}; its output is above). `
      + `The tag is in this clone: ${again}.`);
  }
  ctx.out(`Pushed ${version}. .github/workflows/release.yml now tests it and publishes the release:`);
  ctx.out(`  https://github.com/${repo}/actions`);
  ctx.out(`  ${url}`);
}

/** Cutting a release from main's head. */
async function cutRelease(ctx, { dryRun }) {
  const candidate = await checkCandidate(ctx);
  const { version, head, url } = candidate;
  if (candidate.released) {
    ctx.out(`${version} is already tagged at this commit on ${REMOTE}; nothing to do. The release: ${url}`);
    return 0;
  }
  await showNotes(ctx, candidate);
  if (dryRun) {
    ctx.out(`Dry run: would tag ${version} at ${head} and push it to ${REMOTE}. Nothing was changed.`);
    return 0;
  }
  await pushReleaseTag(ctx, candidate, { message: `Release ${version}` });
  return 0;
}

/** The fields `yank` reads of a release, from `gh release view --json`. */
const RELEASE_FIELDS = 'tagName,isDraft,isPrerelease,body,url';

/** `yank <tag> --reason <why>`: withdraws a published release, or says it is withdrawn already. */
async function yankRelease(ctx, tag, reason) {
  if (!isVersion(tag)) throw new DevError(`'${tag}' is not a version (vYYYY.MM.DD.N.N), so it is not a release`, 2);
  const repo = await originRepo(ctx);
  const viewed = await ghRun(ctx, ['release', 'view', tag, '--repo', repo, '--json', RELEASE_FIELDS]);
  if (viewed.code !== 0) {
    if (/release not found/i.test(viewed.stderr || '')) {
      throw new DevError(`${repo} has no published release ${tag}; there is nothing to withdraw. A tag whose workflow is still running is published first.`);
    }
    throw new DevError(`gh could not read the release ${tag} of ${repo}${failureDetail(viewed)}`);
  }
  let release = null;
  try { release = JSON.parse(viewed.stdout); } catch { /* reported below */ }
  if (!release || release.tagName !== tag) throw new DevError(`GitHub answered the release ${tag} of ${repo} in a form this script cannot read`);
  if (release.isDraft) throw new DevError(`${tag} is a draft on ${repo}: it was never published, and no dashboard offers it; there is nothing to withdraw`);
  const page = typeof release.url === 'string' ? release.url : `https://github.com/${repo}/releases/tag/${tag}`;
  if (release.isPrerelease && withdrawalReason(release.body) === reason) {
    ctx.out(`${tag} is withdrawn already (${reason}); nothing changed. ${page}`);
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'paraclete-yank-'));
    try {
      const notesFile = join(dir, 'notes.md');
      writeFileSync(notesFile, withdrawnNotes(release.body, reason));
      const edited = await ghRun(ctx, ['release', 'edit', tag, '--repo', repo, '--prerelease', '--notes-file', notesFile]);
      if (edited.code !== 0) throw new DevError(`gh could not withdraw the release ${tag} of ${repo}; it is as it was${failureDetail(edited)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    ctx.out(`Withdrew ${tag}: GitHub lists it as a prerelease, and its notes start with "Withdrawn: ${reason}". ${page}`);
  }
  ctx.out('A dashboard that checks for withdrawn releases stops offering it at its next look at GitHub, and starts no new '
    + 'upgrade to it: each start asks GitHub first. An upgrade to it already running finishes, and a dashboard on an older '
    + 'release may still install it within the hour it keeps GitHub\'s list. An instance on it moves on to the next newer '
    + 'release as usual: cut one with the fix.');
  ctx.out(`The tag ${tag} stays, so that release must be newer than it.`);
  await warnUnguardedWorkflow(ctx, tag);
  return 0;
}

/**
 * The text that marks a release workflow whose rerun leaves a withdrawn release as it is: the publish
 * step asks whether the release is a prerelease before it edits it. A test keeps it in
 * .github/workflows/release.yml.
 */
export const WORKFLOW_RERUN_GUARD = '--json isPrerelease --jq .isPrerelease';

/**
 * Warns when the tag's own release workflow, the one a rerun runs, lacks WORKFLOW_RERUN_GUARD: a rerun
 * would edit the release with --prerelease=false and fresh notes, and so publish it again.
 */
async function warnUnguardedWorkflow(ctx, tag) {
  const path = '.github/workflows/release.yml';
  const shown = await ctx.git(['show', `refs/tags/${tag}:${path}`]);
  if (shown.code !== 0) {
    ctx.warn(`warning: this clone cannot show ${tag}'s own ${path} (git fetch --tags ${REMOTE} gets the tag), so it is not known `
      + 'whether a rerun of its release workflow keeps it withdrawn. Never rerun that workflow.');
  } else if (!shown.stdout.includes(WORKFLOW_RERUN_GUARD)) {
    ctx.warn(`warning: ${tag} was tagged before the release workflow had its guard for withdrawn releases. A rerun of its `
      + 'release workflow runs that old workflow, which publishes it again (no prerelease flag, notes without the Withdrawn '
      + 'line). Never rerun the release workflow of this tag; if one ran, yank it again.');
  } else {
    ctx.out(`${tag}'s own release workflow leaves a withdrawn release as it is, so a rerun keeps it withdrawn.`);
  }
}

/**
 * @param {string[]} argv
 * @param {object}   [deps] see devContext() in dev-env.mjs; `exec` runs git and gh
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const ctx = devContext(deps);
  return runCommand('release', ctx, async () => {
    const opts = parseArgs(argv);
    if (opts.help) { ctx.out(USAGE); return 0; }
    if (opts.command === 'notes') return printNotes(ctx, opts.tag);
    if (opts.command === 'check') return checkTag(ctx, opts.tag);
    if (opts.command === 'yank') return yankRelease(ctx, opts.tag, opts.reason);
    return cutRelease(ctx, { dryRun: opts.dryRun });
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
