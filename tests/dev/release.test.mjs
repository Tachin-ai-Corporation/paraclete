// Tests for dev/release.mjs and .github/workflows/release.yml. Cutting a release: it refuses unless
// the clone is on a clean main whose head origin has, the head's subject starts with a version newer
// than every version tag and not taken, and every CI check run on the head passed; then it pushes an
// annotated tag (none with --dry-run), and a second run finishes a half-done one or says it is done.
// The notes: a title line and one line per commit since the previous version tag (version order,
// first parent, each merge replaced by the commits it brought in, oldest first). The check: a tag is
// a release only when it is a version on origin/main. Withdrawing one (yank): a prerelease whose notes
// start with the Withdrawn line, once, and nothing else changed. These run against a fake git and gh,
// and then against real git in scratch repositories with a bare one as origin; GitHub is always faked.
// The workflow is read as text: it checks the tag first, tests read-only, and publishes with the notes
// this script writes; its publish step also runs in bash against a fake gh, so a rerun is seen to leave
// a withdrawn release as it is.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  main, versionTags, previousVersion, releaseNotes, remoteTags, ciVerdict, HARNESS_MERGE_JOB, MAIN, REMOTE, WORKFLOW_RERUN_GUARD,
} from '../../dev/release.mjs';
import { createExec } from '../../dev/dev-env.mjs';
import { readRepoFile } from '../repo/repo-files.mjs';
import { devDeps, fakeExec } from './fakes.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const TAG_OBJECT = 'd'.repeat(40);
const VERSION = 'v2026.10.19.1.1';
const SUBJECT = `${VERSION}: releases are cut from main`;
const REPO = 'your-org/paraclete';

const passed = (...names) => ({ total_count: names.length, check_runs: names.map((name) => ({ name, status: 'completed', conclusion: 'success' })) });

describe('the pure parts', () => {
  test('version tags, newest first in version order, once each', () => {
    assert.deepEqual(versionTags(['nightly', 'v2026.10.18.9.1', 'v2026.10.18.10.1', 'v2026.10.18.9.1', 'v2026.13.01.1.1', 'v2026.10.17.1.1']),
      ['v2026.10.18.10.1', 'v2026.10.18.9.1', 'v2026.10.17.1.1']);
  });

  test('the previous version is the newest version tag older than this one, never by name or date', () => {
    const tags = ['v2026.10.18.10.1', 'v2026.10.18.9.1', 'v2026.10.17.1.1', 'nightly', 'v2026.10.19.1.1'];
    assert.equal(previousVersion(tags, 'v2026.10.18.10.1'), 'v2026.10.18.9.1', '10 comes after 9');
    assert.equal(previousVersion(tags, 'v2026.10.18.9.1'), 'v2026.10.17.1.1', 'a newer tag is never the previous one');
    assert.equal(previousVersion(tags, 'v2026.10.20.1.1'), 'v2026.10.19.1.1', 'the version need not be tagged yet');
    assert.equal(previousVersion(tags, 'v2026.10.17.1.1'), null, 'the first release has none');
    assert.equal(previousVersion([], VERSION), null);
  });

  test('a withdrawn tag is never the previous version: the notes reach back past it', () => {
    const tags = ['v2026.10.18.9.1', 'v2026.10.18.10.1', 'v2026.10.18.11.1'];
    assert.equal(previousVersion(tags, 'v2026.10.18.12.1', new Set(['v2026.10.18.11.1'])), 'v2026.10.18.10.1');
    assert.equal(previousVersion(tags, 'v2026.10.18.12.1', new Set(['v2026.10.18.11.1', 'v2026.10.18.10.1'])), 'v2026.10.18.9.1');
    assert.equal(previousVersion(tags, 'v2026.10.18.12.1', new Set(tags)), null, 'all withdrawn: from the first commit');
    assert.equal(previousVersion(tags, 'v2026.10.18.11.1', new Set(['v2026.10.18.11.1'])), 'v2026.10.18.10.1', 'its own withdrawal changes nothing');
  });

  test('the notes: a title line, a blank line, then each subject as written', () => {
    assert.equal(releaseNotes({ version: VERSION, previous: 'v2026.10.18.9.4', subjects: ['v2026.10.18.10.1: one', 'v2026.10.19.1.1: two *as written*'] }),
      'Changes in v2026.10.19.1.1 since v2026.10.18.9.4\n\n- v2026.10.18.10.1: one\n- v2026.10.19.1.1: two *as written*\n');
    assert.equal(releaseNotes({ version: VERSION, previous: null, subjects: ['v2026.10.19.1.1: first'] }),
      'Changes in v2026.10.19.1.1, the first release\n\n- v2026.10.19.1.1: first\n');
    assert.equal(releaseNotes({ version: VERSION, previous: 'v2026.10.18.9.4', subjects: [] }),
      'Changes in v2026.10.19.1.1 since v2026.10.18.9.4\n\nNo commits since v2026.10.18.9.4.\n');
  });

  test("origin's tags: an annotated tag names the commit it points at", () => {
    const tags = remoteTags([
      `${TAG_OBJECT}\trefs/tags/v2026.10.18.9.4`,
      `${OLD}\trefs/tags/v2026.10.18.9.4^{}`,
      `${OTHER}\trefs/tags/nightly`,
      `${HEAD}\trefs/heads/main`,
      'not a line',
      '',
    ].join('\r\n'));
    assert.deepEqual([...tags], [['v2026.10.18.9.4', OLD], ['nightly', OTHER]]);
  });

  test('CI passed only when every check run finished with success, and there was one', () => {
    assert.deepEqual(ciVerdict(passed('Tests', 'Dashboard build').check_runs),
      { ok: true, passed: ['Tests', 'Dashboard build'], pending: [], failed: [] });
    assert.equal(ciVerdict([]).ok, false, 'no run is no evidence');
    const mixed = ciVerdict([
      { name: 'Tests', status: 'completed', conclusion: 'success' },
      { name: 'Dashboard build', status: 'in_progress', conclusion: null },
      { name: 'Lint', status: 'completed', conclusion: 'skipped' },
      { name: 'Docs', status: 'completed', conclusion: 'failure' },
      {},
    ]);
    assert.equal(mixed.ok, false);
    assert.deepEqual(mixed.pending, ['Dashboard build (in_progress)', 'an unnamed check (no status)']);
    assert.deepEqual(mixed.failed, ['Lint (skipped)', 'Docs (failure)']);
  });

  test("the hourly harness merger's own run on main's head is not CI, running or failed", () => {
    for (const status of [{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }]) {
      assert.deepEqual(ciVerdict([...passed('Tests').check_runs, { name: HARNESS_MERGE_JOB, ...status }]),
        { ok: true, passed: ['Tests'], pending: [], failed: [] });
    }
    assert.equal(ciVerdict([{ name: HARNESS_MERGE_JOB, status: 'completed', conclusion: 'success' }]).ok, false, 'alone it is no CI at all');
  });
});

/**
 * A clone and GitHub as a script for the fake runner: main at HEAD with SUBJECT, a clean tree,
 * origin at the same commit, the tags given, and CI's check runs.
 */
function clone({
  branch = MAIN, status = '', head = HEAD, subject = SUBJECT, originMain = HEAD, originTags = { 'v2026.10.18.9.4': OLD },
  localTags = { 'v2026.10.18.9.4': OLD }, checkRuns = [passed('Tests', 'Dashboard build')], subjects = ['v2026.10.19.1.1: releases are cut from main'],
  tag = { code: 0 }, push = { code: 0 }, gh, releases = [],
} = {}) {
  let page = 0;
  return fakeExec(async (program, args) => {
    if (program === 'gh') {
      if (gh) return gh(args);
      if (/\/releases\?/.test(args.at(-1))) return { stdout: JSON.stringify(releases) };
      page += 1;
      return { stdout: JSON.stringify(checkRuns[page - 1] || { total_count: 0, check_runs: [] }) };
    }
    const line = args.join(' ');
    if (line === 'symbolic-ref --quiet --short HEAD') return branch ? { stdout: `${branch}\n` } : { code: 1 };
    if (line === 'status --porcelain') return { stdout: status };
    if (line === 'rev-parse HEAD') return { stdout: `${head}\n` };
    if (line === `log -1 --format=%s ${head}`) return { stdout: `${subject}\n` };
    if (line === `ls-remote ${REMOTE} refs/heads/${MAIN}`) return { stdout: originMain ? `${originMain}\trefs/heads/main\n` : '' };
    if (line === `ls-remote --tags ${REMOTE}`) {
      return { stdout: Object.entries(originTags).map(([name, sha]) => `${TAG_OBJECT}\trefs/tags/${name}\n${sha}\trefs/tags/${name}^{}\n`).join('') };
    }
    if (line === 'tag --list') return { stdout: Object.keys(localTags).map((name) => `${name}\n`).join('') };
    const resolve = /^rev-parse --verify --quiet refs\/tags\/(.+)\^\{commit\}$/.exec(line);
    if (resolve) return localTags[resolve[1]] ? { stdout: `${localTags[resolve[1]]}\n` } : { code: 1 };
    if (args[0] === 'log' && args.includes('--first-parent')) {
      return { stdout: subjects.map((s, i) => `${String(i).padStart(40, '0')}\0${OTHER}\0${s}\n`).join('') };
    }
    if (args[0] === 'tag') return tag;
    if (args[0] === 'push') return push;
    return undefined;
  });
}

/** What a run changed: the tag it made and the push, as argument lists. */
const changes = (exec) => exec.callsTo('git').filter((c) => ['tag', 'push'].includes(c.args[0]) && c.args[1] !== '--list').map((c) => c.args);

describe('cutting a release', () => {
  test('from a clean, pushed main with CI green: an annotated tag at the head, pushed to origin', async () => {
    const exec = clone();
    const deps = devDeps({ exec });
    assert.equal(await main([], deps), 0, deps.stderr.text);
    assert.deepEqual(changes(exec), [
      ['tag', '--annotate', VERSION, '--message', `Release ${VERSION}`, HEAD],
      ['push', REMOTE, `refs/tags/${VERSION}`],
    ]);
    const [gh] = exec.callsTo('gh');
    assert.deepEqual(gh.args, ['api', '-H', 'Accept: application/vnd.github+json',
      `repos/${REPO}/commits/${HEAD}/check-runs?filter=latest&per_page=100&page=1`]);
    for (const call of exec.calls) {
      assert.ok(['git', 'gh'].includes(call.program) && call.args.every((a) => typeof a === 'string') && call.opts.shell === undefined, 'no shell');
    }
    assert.match(deps.stdout.text, /v2026\.10\.19\.1\.1 is newer than v2026\.10\.18\.9\.4, the newest version tag, and not taken\./);
    assert.match(deps.stdout.text, /CI passed on aaaaaaaaaaaa: Tests, Dashboard build\./);
    assert.match(deps.stdout.text, / {2}Changes in v2026\.10\.19\.1\.1 since v2026\.10\.18\.9\.4\n\n {2}- v2026\.10\.19\.1\.1: releases are cut from main\n/);
    assert.ok(deps.stdout.text.includes(`https://github.com/${REPO}/releases/tag/${VERSION}`));
    const notesLog = exec.callsTo('git').find((c) => c.args.includes('--first-parent'));
    assert.deepEqual(notesLog.args, ['log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%s', `${OLD}..${HEAD}`, '--']);
  });

  test('--dry-run checks everything, shows the notes and changes nothing', async () => {
    const exec = clone();
    const deps = devDeps({ exec });
    assert.equal(await main(['--dry-run'], deps), 0, deps.stderr.text);
    assert.deepEqual(changes(exec), []);
    assert.match(deps.stdout.text, /Dry run: would tag v2026\.10\.19\.1\.1 at a{40} and push it to origin\. Nothing was changed\./);
    assert.match(deps.stdout.text, /Changes in v2026\.10\.19\.1\.1 since v2026\.10\.18\.9\.4/);
  });

  test('the first release has no previous tag, and its notes start at the beginning', async () => {
    const exec = clone({ originTags: {}, localTags: {} });
    const deps = devDeps({ exec });
    assert.equal(await main(['--dry-run'], deps), 0, deps.stderr.text);
    assert.match(deps.stdout.text, /v2026\.10\.19\.1\.1 is the first release\./);
    assert.match(deps.stdout.text, /Changes in v2026\.10\.19\.1\.1, the first release/);
    assert.deepEqual(exec.callsTo('git').find((c) => c.args.includes('--first-parent')).args.slice(-2), [HEAD, '--']);
  });

  const refusals = [
    ['not on main', { branch: 'feature/x' }, /Releases are cut from main, and this clone is on feature\/x: git switch main/],
    ['a detached HEAD', { branch: null }, /this clone is on a detached HEAD/],
    ['a dirty tree', { status: ' M dev/release.mjs\n?? scratch.txt\n' }, /not clean; commit, stash or remove these first:\n M dev\/release\.mjs\n\?\? scratch\.txt/],
    ['a head without a version', { subject: 'tidy up' }, /main's head aaaaaaaaaaaa is not a release: its subject does not start with a version \(vYYYY\.MM\.DD\.N\.N: \.\.\.\): tidy up/],
    ['a head not pushed', { originMain: OLD }, /origin has main at bbbbbbbbbbbb, and this clone at aaaaaaaaaaaa: push \(or pull\) first/],
    ['no main on origin', { originMain: null }, /origin has no main branch; push it first/],
    ['a version taken on origin', { originTags: { [VERSION]: OTHER } }, /v2026\.10\.19\.1\.1 is taken: origin has it at cccccccccccc/],
    ['a version taken here', { localTags: { [VERSION]: OTHER } }, /v2026\.10\.19\.1\.1 is taken in this clone, at cccccccccccc\. If that tag was a mistake, delete it \(git tag -d v2026\.10\.19\.1\.1\)/],
    ['a version older than a tag on origin', { originTags: { 'v2026.10.19.2.1': OLD } }, /v2026\.10\.19\.1\.1 is not newer than v2026\.10\.19\.2\.1, the newest version tag/],
    ['a version older than a tag here only', { localTags: { 'v2026.10.20.1.1': OLD } }, /is not newer than v2026\.10\.20\.1\.1/],
    ['CI still running', { checkRuns: [{ total_count: 2, check_runs: [{ name: 'Tests', status: 'completed', conclusion: 'success' }, { name: 'Dashboard build', status: 'queued' }] }] },
      /CI is still running on aaaaaaaaaaaa: Dashboard build \(queued\)\. Run this again when it has passed\./],
    ['CI failed', { checkRuns: [{ total_count: 2, check_runs: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }, { name: 'Dashboard build', status: 'queued' }] }] },
      /CI did not pass on aaaaaaaaaaaa: Tests \(failure\)\. Fix it with a new commit\./],
    ['no CI yet', { checkRuns: [{ total_count: 0, check_runs: [] }] }, /No CI check has run on aaaaaaaaaaaa yet/],
    ['no gh', { gh: () => ({ code: 127, missing: true }) }, /gh was not found: install the GitHub CLI/],
    ['gh refused', { gh: () => ({ code: 1, stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login\n' }) }, /gh could not read the check runs of aaaaaaaaaaaa on your-org\/paraclete:\ngh: To get started/],
  ];
  for (const [what, over, message] of refusals) {
    test(`refuses ${what}, and changes nothing`, async () => {
      const exec = clone(over);
      const deps = devDeps({ exec });
      assert.equal(await main([], deps), 1);
      assert.match(deps.stderr.text, message);
      assert.deepEqual(changes(exec), []);
    });
  }

  test('a clone whose origin is not on GitHub is refused', async () => {
    const base = clone();
    const exec = fakeExec((program, args, opts) => (args.join(' ') === 'remote get-url origin'
      ? { stdout: 'https://git.example.com/team/paraclete.git\n' } : base(program, args, opts)));
    const deps = devDeps({ exec });
    assert.equal(await main([], deps), 1);
    assert.match(deps.stderr.text, /origin is not a GitHub repository/);
  });

  test("CI's check runs are read page by page until GitHub's count is reached", async () => {
    const first = { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => ({ name: `job ${i}`, status: 'completed', conclusion: 'success' })) };
    const second = { total_count: 101, check_runs: [{ name: 'last', status: 'completed', conclusion: 'failure' }] };
    const exec = clone({ checkRuns: [first, second] });
    const deps = devDeps({ exec });
    assert.equal(await main([], deps), 1);
    assert.deepEqual(exec.callsTo('gh').map((c) => c.args.at(-1).split('page=').at(-1)), ['1', '2']);
    assert.match(deps.stderr.text, /CI did not pass on aaaaaaaaaaaa: last \(failure\)/);
  });

  test("a withdrawn tag is skipped for the notes, and the cut says so; GitHub's releases are read page by page", async () => {
    const withdrawnTag = { tag_name: 'v2026.10.18.9.5', prerelease: true, draft: false, body: 'Withdrawn: it broke uploads' };
    const older = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v2026.09.01.${i + 1}.1`, prerelease: false }));
    let listing = 0;
    const exec = clone({
      originTags: { 'v2026.10.18.9.4': OLD, 'v2026.10.18.9.5': OTHER },
      localTags: { 'v2026.10.18.9.4': OLD, 'v2026.10.18.9.5': OTHER },
      gh: (args) => {
        if (!/\/releases\?/.test(args.at(-1))) return { stdout: JSON.stringify(passed('Tests')) };
        listing += 1;
        return { stdout: JSON.stringify(listing === 1 ? older : [withdrawnTag]) };
      },
    });
    const deps = devDeps({ exec });
    assert.equal(await main(['--dry-run'], deps), 0, deps.stderr.text);
    assert.deepEqual(exec.callsTo('gh').filter((c) => /\/releases\?/.test(c.args.at(-1))).map((c) => c.args.at(-1)),
      [`repos/${REPO}/releases?per_page=100&page=1`, `repos/${REPO}/releases?per_page=100&page=2`]);
    assert.match(deps.stdout.text, /v2026\.10\.19\.1\.1 is newer than v2026\.10\.18\.9\.5, the newest version tag, and not taken\./,
      'a withdrawn tag still counts for the order');
    assert.match(deps.stdout.text, /Its notes start after v2026\.10\.18\.9\.4: v2026\.10\.18\.9\.5 was withdrawn\./);
    assert.match(deps.stdout.text, /Changes in v2026\.10\.19\.1\.1 since v2026\.10\.18\.9\.4/);
    assert.equal(exec.callsTo('git').find((c) => c.args.includes('--first-parent')).args[4], `${OLD}..${HEAD}`);
  });

  test('a cut whose release list GitHub refuses changes nothing', async () => {
    const exec = clone({ gh: (args) => (/\/releases\?/.test(args.at(-1)) ? { code: 1, stderr: 'HTTP 502\n' } : { stdout: JSON.stringify(passed('Tests')) }) });
    const deps = devDeps({ exec });
    assert.equal(await main([], deps), 1);
    assert.match(deps.stderr.text, /gh could not list the releases of your-org\/paraclete:\nHTTP 502/);
    assert.deepEqual(changes(exec), []);
  });

  test('a tag already on origin at the head is a release already cut: nothing to do', async () => {
    const exec = clone({ originTags: { 'v2026.10.18.9.4': OLD, [VERSION]: HEAD } });
    const deps = devDeps({ exec });
    assert.equal(await main([], deps), 0, deps.stderr.text);
    assert.deepEqual(changes(exec), []);
    assert.deepEqual(exec.callsTo('gh'), []);
    assert.match(deps.stdout.text, /v2026\.10\.19\.1\.1 is already tagged at this commit on origin; nothing to do\./);
  });

  test('a push that failed leaves the tag here; the next run pushes it without tagging again', async () => {
    let exec = clone({ push: { code: 1, stderr: 'fatal: unable to access remote\n' } });
    let deps = devDeps({ exec });
    assert.equal(await main([], deps), 1);
    assert.match(deps.stderr.text, /git could not push v2026\.10\.19\.1\.1 to origin \(exit 1; its output is above\)\. The tag is in this clone: run this again to push it\./);
    assert.match(deps.stderr.text, /fatal: unable to access remote/, "git's own output reaches you");

    exec = clone({ localTags: { 'v2026.10.18.9.4': OLD, [VERSION]: HEAD } });
    deps = devDeps({ exec });
    assert.equal(await main([], deps), 0, deps.stderr.text);
    assert.deepEqual(changes(exec), [['push', REMOTE, `refs/tags/${VERSION}`]]);
    assert.match(deps.stdout.text, /This clone already has the tag v2026\.10\.19\.1\.1 at this commit; pushing it\./);
  });

  test('usage mistakes exit 2, and --help explains', async () => {
    for (const argv of [['--force'], ['publish', VERSION], ['notes'], ['check', VERSION, 'extra'], ['notes', VERSION, '--dry-run']]) {
      const deps = devDeps({ exec: clone() });
      assert.equal(await main(argv, deps), 2, argv.join(' '));
      assert.match(deps.stderr.text, /Usage: node dev\/release\.mjs/);
    }
    const deps = devDeps({ exec: clone() });
    assert.equal(await main(['--help'], deps), 0);
    assert.match(deps.stdout.text, /notes <tag> {2}print a release's notes/);
    assert.deepEqual(deps.exec.calls, [], '--help runs nothing');
  });
});

const NOTES = 'Changes in v2026.10.19.1.1 since v2026.10.18.9.4\n\n- v2026.10.19.1.1: releases are cut from main\n';
const PAGE = `https://github.com/${REPO}/releases/tag/${VERSION}`;
const REASON = 'it breaks upgrades from v2026.10.18.9.4 (issue 41)';

/**
 * GitHub's release of VERSION as `gh release view` and `gh release edit` see it; an edit changes it,
 * reading the notes from the file it names while that file exists. `release` null: none is published.
 */
function publishedRelease({
  release = { tagName: VERSION, isDraft: false, isPrerelease: false, body: NOTES, url: PAGE }, edit,
  workflow = readRepoFile('.github/workflows/release.yml'),
} = {}) {
  const state = { release: release && { ...release }, edits: [] };
  const exec = fakeExec(async (program, args) => {
    if (program === 'git' && args.join(' ') === `show refs/tags/${VERSION}:.github/workflows/release.yml`) {
      return workflow === null ? { code: 128, stderr: `fatal: invalid object name 'refs/tags/${VERSION}'.\n` } : { stdout: workflow };
    }
    if (program !== 'gh') return undefined;
    if (args.slice(0, 2).join(' ') === 'release view') {
      return state.release ? { stdout: JSON.stringify(state.release) } : { code: 1, stderr: 'release not found\n' };
    }
    if (args.slice(0, 2).join(' ') === 'release edit') {
      if (edit) return edit(args);
      const file = args[args.indexOf('--notes-file') + 1];
      const notes = readFileSync(file, 'utf8');
      state.edits.push({ args, file, notes });
      state.release = { ...state.release, isPrerelease: state.release.isPrerelease || args.includes('--prerelease'), body: notes };
      return { stdout: `${PAGE}\n` };
    }
    return { code: 1, stderr: `unexpected: gh ${args.join(' ')}\n` };
  });
  return { exec, state };
}

describe('withdrawing a release', () => {
  test('yank marks the release a prerelease with the Withdrawn line first in its notes; a second run changes nothing', async () => {
    const { exec, state } = publishedRelease();
    let deps = devDeps({ exec });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 0, deps.stderr.text);
    assert.deepEqual(exec.callsTo('gh').map((c) => c.args.slice(0, -1)), [
      ['release', 'view', VERSION, '--repo', REPO, '--json'],
      ['release', 'edit', VERSION, '--repo', REPO, '--prerelease', '--notes-file'],
    ]);
    assert.equal(exec.callsTo('gh')[0].args.at(-1), 'tagName,isDraft,isPrerelease,body,url');
    const [edit] = state.edits;
    assert.equal(edit.notes, `Withdrawn: ${REASON}\n\n${NOTES}`, 'the notes as they were, under the Withdrawn line');
    assert.equal(existsSync(edit.file), false, 'the notes file is removed');
    assert.equal(state.release.isPrerelease, true);
    assert.match(deps.stdout.text, /Withdrew v2026\.10\.19\.1\.1: GitHub lists it as a prerelease, and its notes start with "Withdrawn: it breaks upgrades/);
    assert.match(deps.stdout.text, /The tag v2026\.10\.19\.1\.1 stays, so that release must be newer than it\./);
    assert.deepEqual(changes(exec), [], 'no tag is made, moved or deleted');
    for (const call of exec.calls) assert.ok(call.args.every((a) => typeof a === 'string') && call.opts.shell === undefined, 'no shell');

    deps = devDeps({ exec });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 0, deps.stderr.text);
    assert.equal(state.edits.length, 1, 'withdrawn already: nothing is edited');
    assert.match(deps.stdout.text, /v2026\.10\.19\.1\.1 is withdrawn already \(it breaks upgrades .*\); nothing changed\./);

    deps = devDeps({ exec });
    assert.equal(await main(['yank', VERSION, '--reason', '  another\n  reason  '], deps), 0, deps.stderr.text);
    assert.equal(state.edits.length, 2);
    assert.equal(state.edits[1].notes, `Withdrawn: another reason\n\n${NOTES}`, 'a new reason replaces the line, on one line, never a second line');
  });

  test("yank says what a rerun of the tag's own release workflow would do: keep it withdrawn, or publish it again", async () => {
    let deps = devDeps({ exec: publishedRelease().exec });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 0, deps.stderr.text);
    assert.match(deps.stdout.text, /v2026\.10\.19\.1\.1's own release workflow leaves a withdrawn release as it is, so a rerun keeps it withdrawn\./);
    assert.match(deps.stdout.text, /An upgrade to it already running finishes, and a dashboard on an older release may still install it within the hour/);
    assert.equal(deps.stderr.text, '');

    const old = readRepoFile('.github/workflows/release.yml').split(WORKFLOW_RERUN_GUARD).join('> /dev/null 2>&1');
    deps = devDeps({ exec: publishedRelease({ workflow: old }).exec });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 0, 'it withdraws all the same');
    assert.match(deps.stderr.text, /warning: v2026\.10\.19\.1\.1 was tagged before the release workflow had its guard for withdrawn releases\. A rerun of its release workflow runs that old workflow, which publishes it again .* Never rerun the release workflow of this tag; if one ran, yank it again\./);

    const { exec, state } = publishedRelease({ workflow: null });
    deps = devDeps({ exec });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 0);
    assert.match(deps.stderr.text, /warning: this clone cannot show v2026\.10\.19\.1\.1's own \.github\/workflows\/release\.yml \(git fetch --tags origin gets the tag\)/);
    deps = devDeps({ exec });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 0);
    assert.equal(state.edits.length, 1);
    assert.match(deps.stderr.text, /warning: this clone cannot show/, 'withdrawn already: the warning still stands');
  });

  test('the guard yank looks for is in the release workflow', () => {
    assert.ok(readRepoFile('.github/workflows/release.yml').includes(WORKFLOW_RERUN_GUARD));
  });

  test('a release marked a prerelease by hand, without the line, gets it', async () => {
    const { exec, state } = publishedRelease({ release: { tagName: VERSION, isDraft: false, isPrerelease: true, body: NOTES, url: PAGE } });
    const deps = devDeps({ exec });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 0, deps.stderr.text);
    assert.equal(state.edits.length, 1);
    assert.ok(state.edits[0].notes.startsWith(`Withdrawn: ${REASON}\n\n`));
  });

  const refusals = [
    ['no published release', { release: null }, /your-org\/paraclete has no published release v2026\.10\.19\.1\.1; there is nothing to withdraw/],
    ['a draft', { release: { tagName: VERSION, isDraft: true, isPrerelease: false, body: '', url: PAGE } }, /is a draft on your-org\/paraclete: it was never published/],
    ['an answer for another tag', { release: { tagName: 'v2026.10.19.2.1', isDraft: false, isPrerelease: false, body: '', url: PAGE } }, /in a form this script cannot read/],
    ['an edit GitHub refuses', { edit: () => ({ code: 1, stderr: 'HTTP 403: Resource not accessible\n' }) },
      /gh could not withdraw the release v2026\.10\.19\.1\.1 of your-org\/paraclete; it is as it was:\nHTTP 403/],
  ];
  for (const [what, over, message] of refusals) {
    test(`yank refuses ${what}, exit 1`, async () => {
      const { exec } = publishedRelease(over);
      const deps = devDeps({ exec });
      assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 1);
      assert.match(deps.stderr.text, message);
    });
  }

  test('yank without gh says how to get it', async () => {
    const deps = devDeps({ exec: fakeExec((program) => (program === 'gh' ? { code: 127, missing: true } : undefined)) });
    assert.equal(await main(['yank', VERSION, '--reason', REASON], deps), 1);
    assert.match(deps.stderr.text, /gh was not found: install the GitHub CLI/);
  });

  test('usage mistakes exit 2 before GitHub is asked', async () => {
    for (const argv of [['yank', VERSION], ['yank', VERSION, '--reason'], ['yank', VERSION, '--reason', ' \n '], ['yank', 'nightly', '--reason', REASON],
      ['yank', VERSION, '--reason', 'x'.repeat(201)], ['notes', VERSION, '--reason', REASON], ['--reason', REASON], ['yank', VERSION, '--reason', REASON, '--dry-run']]) {
      const { exec } = publishedRelease();
      const deps = devDeps({ exec });
      assert.equal(await main(argv, deps), 2, argv.join(' '));
      assert.match(deps.stderr.text, /Usage: node dev\/release\.mjs|not a version|keep it to 200/);
      assert.deepEqual(exec.callsTo('gh'), [], argv.join(' '));
    }
  });
});

describe('notes and check, against real git', () => {
  /**
   * A scratch clone with a bare repository as its origin, and git configured only by the test. Its
   * history on main (first parent): c1 tagged v2026.10.17.1.1 (annotated), c2, a merge of a branch
   * with one commit, c4 tagged v2026.10.17.9.1 (lightweight), c5 tagged v2026.10.17.10.1, plus the
   * tag `nightly` on c5. Only main is pushed.
   */
  function history(t) {
    const scratch = mkdtempSync(join(tmpdir(), 'paraclete-release-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));
    const config = join(scratch, 'gitconfig');
    writeFileSync(config, '[user]\n  name = test\n  email = test@example.com\n[core]\n  autocrlf = false\n[commit]\n  gpgsign = false\n[tag]\n  gpgsign = false\n');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    for (const inherited of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[inherited];
    const dir = join(scratch, 'clone');
    const origin = join(scratch, 'origin.git');
    const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '--quiet', '--bare', '-b', MAIN, origin], { env });
    execFileSync('git', ['init', '--quiet', '-b', MAIN, dir], { env });
    const commit = (subject) => { git('commit', '--quiet', '--allow-empty', '-m', subject, '-m', 'A body line that is not in the notes.'); return git('rev-parse', 'HEAD'); };
    const c = {};
    c.c1 = commit('v2026.10.17.1.1: the first commit');
    git('tag', '--annotate', 'v2026.10.17.1.1', '-m', 'Release v2026.10.17.1.1');
    c.c2 = commit('v2026.10.17.2.1: the second, *as written*');
    git('switch', '--quiet', '-c', 'feature');
    c.f1 = commit('v2026.10.17.3.1: a commit on a branch');
    git('switch', '--quiet', MAIN);
    git('merge', '--quiet', '--no-ff', 'feature', '-m', "Merge branch 'feature'");
    c.c4 = commit('v2026.10.17.9.1: after the merge');
    git('tag', 'v2026.10.17.9.1');
    c.c5 = commit('v2026.10.17.10.1: ten comes after nine');
    git('tag', '--annotate', 'v2026.10.17.10.1', '-m', 'Release v2026.10.17.10.1');
    git('tag', 'nightly');
    git('remote', 'add', REMOTE, origin);
    git('push', '--quiet', REMOTE, MAIN);
    git('fetch', '--quiet', REMOTE);

    const real = createExec({ env });
    /** GitHub's releases, as its API lists them; a test marks one withdrawn by making it a prerelease. */
    const github = { releases: [] };
    /** The command's runner: real git in the clone (origin read as GitHub's address), gh faked. */
    const exec = fakeExec(async (program, args, opts) => {
      if (program === 'gh' && /\/releases\?/.test(args.at(-1))) return { stdout: JSON.stringify(github.releases) };
      if (program === 'gh') return { stdout: JSON.stringify(passed('Tests', 'Dashboard build')) };
      if (args.join(' ') === `remote get-url ${REMOTE}`) return { stdout: `https://github.com/${REPO}.git\n` };
      return real(program, args, { ...opts, cwd: dir });
    });
    return { dir, origin, git, c, exec, env, github };
  }

  test('notes: one line per commit since the previous version tag, a merge as the commits it brought in, oldest first', async (t) => {
    const { exec } = history(t);
    const notes = async (tag) => {
      const deps = devDeps({ exec });
      assert.equal(await main(['notes', tag], deps), 0, deps.stderr.text);
      assert.equal(deps.stderr.text, '');
      return deps.stdout.text;
    };
    assert.equal(await notes('v2026.10.17.9.1'), [
      'Changes in v2026.10.17.9.1 since v2026.10.17.1.1', '',
      '- v2026.10.17.2.1: the second, *as written*',
      '- v2026.10.17.3.1: a commit on a branch',
      '- v2026.10.17.9.1: after the merge', '',
    ].join('\n'), 'the branch commit stands where its merge is, the merge itself is left out; the newer 10.1 is not the previous tag');
    assert.equal(await notes('v2026.10.17.10.1'), 'Changes in v2026.10.17.10.1 since v2026.10.17.9.1\n\n- v2026.10.17.10.1: ten comes after nine\n');
    assert.equal(await notes('v2026.10.17.1.1'), 'Changes in v2026.10.17.1.1, the first release\n\n- v2026.10.17.1.1: the first commit\n');
  });

  test('notes: a withdrawn previous release is skipped, so the notes hold the changes an instance on the one before it receives', async (t) => {
    const { exec, github } = history(t);
    github.releases = [
      { tag_name: 'v2026.10.17.10.1', prerelease: false },
      { tag_name: 'v2026.10.17.9.1', prerelease: true, body: 'Withdrawn: it broke uploads' },
      { tag_name: 'v2026.10.17.1.1', prerelease: false },
    ];
    const deps = devDeps({ exec });
    assert.equal(await main(['notes', 'v2026.10.17.10.1'], deps), 0, deps.stderr.text);
    assert.equal(deps.stdout.text, [
      'Changes in v2026.10.17.10.1 since v2026.10.17.1.1', '',
      '- v2026.10.17.2.1: the second, *as written*',
      '- v2026.10.17.3.1: a commit on a branch',
      '- v2026.10.17.9.1: after the merge',
      '- v2026.10.17.10.1: ten comes after nine', '',
    ].join('\n'));
    assert.deepEqual(exec.callsTo('gh').map((c) => c.args), [['api', '-H', 'Accept: application/vnd.github+json', `repos/${REPO}/releases?per_page=100&page=1`]]);
  });

  test('notes: pull requests merged with merge commits show each commit once, in the order main took them', async (t) => {
    const { git, exec } = history(t);
    const commit = (subject) => git('commit', '--quiet', '--allow-empty', '-m', subject);
    // pr-a opens from c5; main moves on; pr-b builds on pr-a and merges main in; then both are merged.
    git('switch', '--quiet', '-c', 'pr-a');
    commit('v2026.10.17.11.1: promotion a');
    git('switch', '--quiet', MAIN);
    commit('v2026.10.17.12.1: on main while a is open');
    git('switch', '--quiet', '-c', 'pr-b', 'pr-a');
    commit('v2026.10.17.13.1: b builds on a');
    git('merge', '--quiet', '--no-ff', MAIN, '-m', "Merge branch 'main' into pr-b");
    git('switch', '--quiet', MAIN);
    git('merge', '--quiet', '--no-ff', 'pr-a', '-m', 'Merge pull request #1 from example/pr-a');
    git('merge', '--quiet', '--no-ff', 'pr-b', '-m', 'Merge pull request #2 from example/pr-b');
    commit('v2026.10.17.14.1: after both');
    git('tag', 'v2026.10.17.14.1');

    const deps = devDeps({ exec });
    assert.equal(await main(['notes', 'v2026.10.17.14.1'], deps), 0, deps.stderr.text);
    assert.equal(deps.stdout.text, [
      'Changes in v2026.10.17.14.1 since v2026.10.17.10.1', '',
      '- v2026.10.17.12.1: on main while a is open',
      '- v2026.10.17.11.1: promotion a',
      '- v2026.10.17.13.1: b builds on a',
      '- v2026.10.17.14.1: after both', '',
    ].join('\n'), 'no merge subject; a merges in by #1 only; main merged into pr-b is not brought in again');
  });

  test('notes refuses a tag that is not a version (2) or not in the clone (1)', async (t) => {
    const { exec } = history(t);
    let deps = devDeps({ exec });
    assert.equal(await main(['notes', 'nightly'], deps), 2);
    assert.match(deps.stderr.text, /'nightly' is not a version/);
    deps = devDeps({ exec });
    assert.equal(await main(['notes', 'v2026.10.18.1.1'], deps), 1);
    assert.match(deps.stderr.text, /this clone has no tag v2026\.10\.18\.1\.1; fetch the tags first/);
    assert.equal(deps.stdout.text, '', 'nothing reaches the notes file');
  });

  test('check: a version tag on origin/main is a release; any other tag is refused', async (t) => {
    const { exec, git, c } = history(t);
    let deps = devDeps({ exec });
    assert.equal(await main(['check', 'v2026.10.17.9.1'], deps), 0, deps.stderr.text);
    assert.equal(deps.stdout.text, `v2026.10.17.9.1 is commit ${c.c4}, on origin/main: a release.\n`);

    git('tag', 'v2026.10.17.3.1', c.f1);
    git('switch', '--quiet', '-c', 'side', c.c5);
    git('commit', '--quiet', '--allow-empty', '-m', 'v2026.10.18.1.1: never merged');
    const side = git('rev-parse', 'HEAD');
    git('tag', 'v2026.10.18.1.1');
    for (const [tag, message] of [
      ['v2026.10.18.1.1', new RegExp(`v2026\\.10\\.18\\.1\\.1 is commit ${side}, which is not on origin/main: a release is cut from main only`)],
      ['nightly', /'nightly' is not a version \(vYYYY\.MM\.DD\.N\.N\), so it is not a release/],
      ['v2026.10.19.1.1', /this clone has no tag v2026\.10\.19\.1\.1/],
    ]) {
      deps = devDeps({ exec });
      assert.equal(await main(['check', tag], deps), 1, tag);
      assert.match(deps.stderr.text, message);
    }
    deps = devDeps({ exec });
    assert.equal(await main(['check', 'v2026.10.17.3.1'], deps), 0, 'a branch commit merged into main is on main');
  });

  test('a cut against real git: the dry run changes nothing, the cut pushes an annotated tag, a rerun has nothing to do', async (t) => {
    const { exec, git, origin, env } = history(t);
    git('commit', '--quiet', '--allow-empty', '-m', 'v2026.10.18.2.1: ready to release');
    const head = git('rev-parse', 'HEAD');
    git('push', '--quiet', REMOTE, MAIN);
    const originTags = () => execFileSync('git', ['ls-remote', '--tags', origin], { env, encoding: 'utf8' });

    let deps = devDeps({ exec });
    assert.equal(await main(['--dry-run'], deps), 0, deps.stderr.text);
    assert.match(deps.stdout.text, /v2026\.10\.18\.2\.1 is newer than v2026\.10\.17\.10\.1, the newest version tag, and not taken\./);
    assert.match(deps.stdout.text, / {2}Changes in v2026\.10\.18\.2\.1 since v2026\.10\.17\.10\.1\n\n {2}- v2026\.10\.18\.2\.1: ready to release\n/);
    assert.equal(git('tag', '--list', 'v2026.10.18.*'), '');
    assert.equal(originTags(), '');

    deps = devDeps({ exec });
    assert.equal(await main([], deps), 0, deps.stderr.text);
    assert.equal(git('cat-file', '-t', 'v2026.10.18.2.1'), 'tag', 'an annotated tag');
    assert.equal(git('rev-parse', 'v2026.10.18.2.1^{commit}'), head);
    assert.deepEqual([...remoteTags(originTags())], [['v2026.10.18.2.1', head]], 'only the new tag is pushed');
    const [gh] = exec.callsTo('gh');
    assert.ok(gh.args.at(-1).startsWith(`repos/${REPO}/commits/${head}/check-runs?`));

    deps = devDeps({ exec });
    assert.equal(await main([], deps), 0, deps.stderr.text);
    assert.match(deps.stdout.text, /already tagged at this commit on origin; nothing to do/);

    git('commit', '--quiet', '--allow-empty', '-m', 'v2026.10.18.3.1: not pushed yet');
    deps = devDeps({ exec });
    assert.equal(await main(['--dry-run'], deps), 1);
    assert.match(deps.stderr.text, /push \(or pull\) first/);
  });
});

describe('the release workflow', () => {
  const text = readRepoFile('.github/workflows/release.yml');
  const [, testJob = '', publishJob = ''] = text.split(/^ {2}(?:test|publish):$/m);
  const ci = readRepoFile('.github/workflows/ci.yml');

  test('runs on a pushed tag, with a read-only token unless publishing', () => {
    assert.match(text, /^on:\n {2}push:\n {4}tags: \['v\*'\]$/m);
    assert.match(text, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(testJob, /contents: write|GH_TOKEN|github\.token/, 'the tests never hold a token that can write');
    assert.match(publishJob, /needs: test\n/);
    assert.match(publishJob, /permissions:\n {6}contents: write\n/);
    assert.doesNotMatch(publishJob, /npm (ci|install|run setup)/, 'the publish job installs nothing');
  });

  test('both jobs fetch the whole history and tags, and keep no credentials', () => {
    for (const job of [testJob, publishJob]) {
      assert.match(job, /actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0\n {10}persist-credentials: false\n/);
      assert.match(job, /node-version: '24'/);
    }
  });

  test("the tests job checks the tag first, then runs CI's suite and the dashboard build", () => {
    const steps = [...testJob.matchAll(/run: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(steps, ['node dev/release.mjs check "$TAG"', 'npm run setup', 'npm test', 'npm run build:dashboard']);
    for (const command of ['npm run setup', 'npm test', 'npm run build:dashboard']) assert.ok(ci.includes(`run: ${command}`), `CI runs ${command} too`);
  });

  test('the publish job publishes the notes this script writes, and a rerun updates them unless the release was withdrawn', () => {
    assert.match(publishJob, /run: node dev\/release\.mjs notes "\$TAG" > "\$RUNNER_TEMP\/release-notes\.md"/);
    assert.match(publishJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(publishJob, /gh release create "\$TAG" --repo "\$GITHUB_REPOSITORY" --title "\$TAG" \\\n\s+--notes-file "\$RUNNER_TEMP\/release-notes\.md" --verify-tag/);
    assert.match(publishJob, /gh release edit "\$TAG" .*\\\n\s+--notes-file "\$RUNNER_TEMP\/release-notes\.md" --draft=false --prerelease=false/);
    assert.match(publishJob, /gh release view "\$TAG" --repo "\$GITHUB_REPOSITORY" --json isPrerelease --jq \.isPrerelease/);
    assert.doesNotMatch(publishJob, /--draft(?!=false)|--prerelease(?!=false)/, 'it never makes a draft or a prerelease itself');
  });

  /** The publish step's script, as the runner's bash gets it. */
  const publishScript = () => {
    const lines = publishJob.split('\n');
    const at = lines.findIndex((line) => /^ {6}- name: Publish/.test(line));
    const run = lines.findIndex((line, i) => i > at && /^ {8}run: \|$/.test(line));
    const body = [];
    for (const line of lines.slice(run + 1)) {
      if (line.trim() && !line.startsWith(' '.repeat(10))) break;
      body.push(line.slice(10));
    }
    return body.join('\n');
  };
  const BASH = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

  test('the publish step: creates a new release, updates a published one, and leaves a withdrawn one exactly as it is', { skip: !BASH && 'no bash on this machine' }, () => {
    // gh as a shell function: it records each call, and answers `release view` from the fake's state.
    const fakeGh = [
      'gh() {',
      '  printf "%s\\n" "gh $*" >> "$CALLS"',
      '  if [ "$1 $2" = "release view" ]; then',
      '    [ "$STATE" = none ] && return 1',
      '    [ "$STATE" = withdrawn ] && echo true || echo false',
      '  fi',
      '  return 0',
      '}',
    ].join('\n');
    const runAs = (state) => {
      const dir = mkdtempSync(join(tmpdir(), 'paraclete-publish-'));
      try {
        const calls = join(dir, 'calls.txt');
        writeFileSync(calls, '');
        const r = spawnSync('bash', ['-e', '-c', `${fakeGh}\n${publishScript()}`], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, TAG: VERSION, GITHUB_REPOSITORY: REPO, RUNNER_TEMP: '/runner/temp', CALLS: calls, STATE: state },
        });
        assert.equal(r.status, 0, r.stderr);
        return { calls: readFileSync(calls, 'utf8').trim().split('\n').map((line) => line.split(' ').slice(0, 3).join(' ')), out: r.stdout };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    assert.deepEqual(runAs('none').calls, ['gh release view', 'gh release create']);
    assert.deepEqual(runAs('published').calls, ['gh release view', 'gh release edit']);
    const withdrawn = runAs('withdrawn');
    assert.deepEqual(withdrawn.calls, ['gh release view'], 'a rerun never clears the prerelease flag or the Withdrawn line');
    assert.match(withdrawn.out, /v2026\.10\.19\.1\.1 was withdrawn \(a prerelease\): it is left exactly as it is\./);
  });

  test('the tag reaches the scripts through the environment, never spliced into a command', () => {
    const expressions = text.split('\n').filter((line) => line.includes('${{')).map((line) => line.trim());
    assert.deepEqual(expressions, ['TAG: ${{ github.ref_name }}', 'TAG: ${{ github.ref_name }}', 'GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ github.token }}'],
      'expressions appear only as environment values');
  });

  test('the notes step asks GitHub which releases were withdrawn, with the publish job\'s token; the tests never get one', () => {
    assert.match(publishJob, /- name: Write the release notes[^\n]*\n {8}env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node dev\/release\.mjs notes "\$TAG"/);
    assert.doesNotMatch(testJob, /GH_TOKEN/);
  });
});
