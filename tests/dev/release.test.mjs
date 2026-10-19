// Tests for dev/release.mjs and .github/workflows/release.yml. Cutting a release: it refuses unless
// the clone is on a clean main whose head origin has, the head's subject starts with a version newer
// than every version tag and not taken, and every CI check run on the head passed; then it pushes an
// annotated tag (none with --dry-run), and a second run finishes a half-done one or says it is done.
// The notes: a title line and one line per commit since the previous version tag (version order,
// first parent, no merges, oldest first). The check: a tag is a release only when it is a version on
// origin/main. These run against a fake git and gh, and then against real git in scratch repositories
// with a bare one as origin; GitHub is always faked. The workflow is read as text: it checks the tag
// first, tests read-only, and publishes with the notes this script writes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  main, versionTags, previousVersion, releaseNotes, remoteTags, ciVerdict, MAIN, REMOTE,
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
});

/**
 * A clone and GitHub as a script for the fake runner: main at HEAD with SUBJECT, a clean tree,
 * origin at the same commit, the tags given, and CI's check runs.
 */
function clone({
  branch = MAIN, status = '', head = HEAD, subject = SUBJECT, originMain = HEAD, originTags = { 'v2026.10.18.9.4': OLD },
  localTags = { 'v2026.10.18.9.4': OLD }, checkRuns = [passed('Tests', 'Dashboard build')], subjects = ['v2026.10.19.1.1: releases are cut from main'],
  tag = { code: 0 }, push = { code: 0 }, gh,
} = {}) {
  let page = 0;
  return fakeExec(async (program, args) => {
    if (program === 'gh') {
      if (gh) return gh(args);
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
    if (args[0] === 'log' && args.includes('--first-parent')) return { stdout: subjects.map((s) => `${s}\n`).join('') };
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
    assert.deepEqual(notesLog.args, ['log', '--first-parent', '--no-merges', '--reverse', '--format=%s', `${OLD}..${HEAD}`, '--']);
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
    /** The command's runner: real git in the clone (origin read as GitHub's address), gh faked. */
    const exec = fakeExec(async (program, args, opts) => {
      if (program === 'gh') return { stdout: JSON.stringify(passed('Tests', 'Dashboard build')) };
      if (args.join(' ') === `remote get-url ${REMOTE}`) return { stdout: `https://github.com/${REPO}.git\n` };
      return real(program, args, { ...opts, cwd: dir });
    });
    return { dir, origin, git, c, exec, env };
  }

  test('notes: one line per commit since the previous version tag, main only, merges left out, oldest first', async (t) => {
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
      '- v2026.10.17.9.1: after the merge', '',
    ].join('\n'), 'the branch commit and the merge are left out; the newer 10.1 is not the previous tag');
    assert.equal(await notes('v2026.10.17.10.1'), 'Changes in v2026.10.17.10.1 since v2026.10.17.9.1\n\n- v2026.10.17.10.1: ten comes after nine\n');
    assert.equal(await notes('v2026.10.17.1.1'), 'Changes in v2026.10.17.1.1, the first release\n\n- v2026.10.17.1.1: the first commit\n');
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

  test('the publish job publishes the notes this script writes, and a rerun updates them', () => {
    assert.match(publishJob, /run: node dev\/release\.mjs notes "\$TAG" > "\$RUNNER_TEMP\/release-notes\.md"/);
    assert.match(publishJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(publishJob, /gh release create "\$TAG" --repo "\$GITHUB_REPOSITORY" --title "\$TAG" \\\n\s+--notes-file "\$RUNNER_TEMP\/release-notes\.md" --verify-tag/);
    assert.match(publishJob, /gh release edit "\$TAG" .*\\\n\s+--notes-file "\$RUNNER_TEMP\/release-notes\.md" --draft=false --prerelease=false/);
    assert.doesNotMatch(publishJob, /--draft(?!=false)|--prerelease(?!=false)/, 'never a draft or a prerelease');
  });

  test('the tag reaches the scripts through the environment, never spliced into a command', () => {
    const expressions = text.split('\n').filter((line) => line.includes('${{')).map((line) => line.trim());
    assert.deepEqual(expressions, ['TAG: ${{ github.ref_name }}', 'TAG: ${{ github.ref_name }}', 'GH_TOKEN: ${{ github.token }}'],
      'expressions appear only as environment values');
  });
});
