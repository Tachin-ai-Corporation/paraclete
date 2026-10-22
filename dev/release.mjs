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
// version tag (the newest one older than this tag, in version order, never git's date order), each the
// commit's subject as written, oldest first. It follows main's own line of commits (first parent), and
// a merge commit there stands for the commits it brought in, never for itself: a pull request merged
// without squashing still shows its changes. `check <tag>` refuses a tag that is not a version or
// whose commit is not on origin/main. The workflow runs both. Nothing here is installed on an instance.

import { compareVersions, isVersion, versionFromText } from '../agent/release/versions.mjs';
import { githubRepoFromUrl } from './deploy.mjs';
import { DevError, devContext, failureDetail, isMain, preview, runCommand } from './dev-env.mjs';

const USAGE = `Usage: node dev/release.mjs [--dry-run]
       node dev/release.mjs notes <tag>
       node dev/release.mjs check <tag>
Cuts a release from main's head: the tree is clean, origin has the commit, CI passed on it, and the
version its subject starts with is newer than every version tag. Then it pushes an annotated tag, and
.github/workflows/release.yml tests the tag again and publishes the GitHub release.
  --dry-run    check everything and show the tag and its notes; change nothing
  notes <tag>  print a release's notes: one line per commit since the previous version tag
  check <tag>  refuse a tag that is not a version, or whose commit is not on origin/main`;

/** The branch releases are cut from, and the remote they are pushed to. */
export const MAIN = 'main';
export const REMOTE = 'origin';

const COMMIT = /^[0-9a-f]{40}$/;
const COMMANDS = new Set(['notes', 'check']);

/** How many check runs one page of GitHub's answer holds (its maximum), and how many pages to read. */
const CHECK_RUNS_PAGE = 100;
const CHECK_RUNS_MAX_PAGES = 10;

function parseArgs(argv) {
  const opts = { command: 'cut', tag: null, dryRun: false, help: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('-')) throw new DevError(`Unknown option: ${arg}\n${USAGE}`, 2);
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
  return opts;
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
 * The previous version tag of a release: the newest version tag older than `version`, or null for the
 * first release. Version order, so a tag made later for an older version changes nothing.
 *
 * @param {Iterable<string>} tags
 * @param {string} version
 * @returns {string|null}
 */
export function previousVersion(tags, version) {
  return versionTags(tags).find((tag) => compareVersions(tag, version) < 0) ?? null;
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

/** The commit's check runs on GitHub, every page, through the GitHub CLI. */
async function checkRuns(ctx, repo, sha) {
  const runs = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
    const path = `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=${CHECK_RUNS_PAGE}&page=${page}`;
    const result = await ctx.exec('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], {});
    if (result.missing) {
      throw new DevError('gh was not found: install the GitHub CLI (https://cli.github.com) and log in with `gh auth login`.');
    }
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

/** `notes <tag>`: the notes, alone on stdout, for the workflow to publish. */
async function printNotes(ctx, tag) {
  if (!isVersion(tag)) throw new DevError(`'${tag}' is not a version (vYYYY.MM.DD.N.N), so it is not a release`, 2);
  if (!await commitOf(ctx, `refs/tags/${tag}`)) throw new DevError(`this clone has no tag ${tag}; fetch the tags first: git fetch --tags ${REMOTE}`);
  const previous = previousVersion(await localTags(ctx), tag);
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

/** The notes the cut shows. Best effort: a previous tag whose commit this clone lacks only skips them. */
async function notesPreview(ctx, { version, previous, previousCommit, head }) {
  try {
    const subjects = await subjectsBetween(ctx, previousCommit, head);
    ctx.out(`Its notes:\n\n${releaseNotes({ version, previous, subjects }).trimEnd().replace(/^(?=.)/gm, '  ')}\n`);
  } catch (err) {
    ctx.warn(`warning: the notes cannot be shown here (${err.message.split('\n')[0]}); the workflow writes them from the tag.`);
  }
}

/** Cutting a release from main's head. */
async function cutRelease(ctx, { dryRun }) {
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
  const repo = githubRepoFromUrl(await gitOut(ctx, ['remote', 'get-url', REMOTE], `this clone has no remote ${REMOTE}`));
  if (!repo) throw new DevError(`${REMOTE} is not a GitHub repository; releases are published on GitHub.`);
  ctx.out(`${MAIN} is at ${head}: ${subject}`);

  const remoteMain = (await gitOut(ctx, ['ls-remote', REMOTE, `refs/heads/${MAIN}`], `git could not read ${REMOTE}`)).split(/\s+/)[0];
  if (remoteMain !== head) {
    throw new DevError(COMMIT.test(remoteMain || '')
      ? `${REMOTE} has ${MAIN} at ${remoteMain.slice(0, 12)}, and this clone at ${head.slice(0, 12)}: push (or pull) first, so the release is a commit everyone has.`
      : `${REMOTE} has no ${MAIN} branch; push it first.`);
  }

  const remote = remoteTags(await gitOut(ctx, ['ls-remote', '--tags', REMOTE], `git could not list ${REMOTE}'s tags`));
  const local = await localTags(ctx);
  const releases = `https://github.com/${repo}/releases/tag/${version}`;
  if (remote.has(version)) {
    if (remote.get(version) !== head) {
      throw new DevError(`${version} is taken: ${REMOTE} has it at ${remote.get(version).slice(0, 12)}. Commit with a newer version first.`);
    }
    ctx.out(`${version} is already tagged at this commit on ${REMOTE}; nothing to do. The release: ${releases}`);
    return 0;
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

  const previous = previousVersion(allTags, version);
  const previousCommit = previous ? (remote.get(previous) || await commitOf(ctx, `refs/tags/${previous}`)) : null;
  await notesPreview(ctx, { version, previous, previousCommit, head });

  if (dryRun) {
    ctx.out(`Dry run: would tag ${version} at ${head} and push it to ${REMOTE}. Nothing was changed.`);
    return 0;
  }
  if (tagged) ctx.out(`This clone already has the tag ${version} at this commit; pushing it.`);
  else await gitOut(ctx, ['tag', '--annotate', version, '--message', `Release ${version}`, head], `git could not make the tag ${version}`);
  const pushed = await ctx.git(['push', REMOTE, `refs/tags/${version}`], { onStderr: (chunk) => ctx.stderr.write(chunk), collect: false });
  if (pushed.code !== 0) {
    throw new DevError(`git could not push ${version} to ${REMOTE} (exit ${pushed.code}; its output is above). `
      + 'The tag is in this clone: run this again to push it.');
  }
  ctx.out(`Pushed ${version}. .github/workflows/release.yml now tests it and publishes the release:`);
  ctx.out(`  https://github.com/${repo}/actions`);
  ctx.out(`  ${releases}`);
  return 0;
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
    return cutRelease(ctx, { dryRun: opts.dryRun });
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
