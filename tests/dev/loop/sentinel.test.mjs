// Tests for dev/loop/sentinel.mjs: a loop merge recognised by the merger's squash message (a revert's
// never is); the failed checks that count; the revert pull request's body and block; revertGuard (the
// reverted commit's files set back exactly, nothing else, never the referee); the reverted commit read
// through GitHub; checkMain against a real repository with a local origin and a fake gh (healthy,
// pending, broken by a person, broken by a loop merge: the revert pushed and opened, the issue reopened,
// the loop paused at the day's second revert, nothing done twice or in a dry run); the loop's pause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOOP_DEFAULTS } from '../../../dev/loop/config.mjs';
import { loopSquashBody, revertSquashBody } from '../../../dev/loop/merger.mjs';
import {
  checkMain, failedChecks, isRevertBranch, loopMergeOf, loopPauseReason, parseRevertBlock, readReverted, revertBody, revertGuard,
} from '../../../dev/loop/sentinel.mjs';
import { HARNESS_MERGE_JOB } from '../../../dev/release.mjs';

const SHA = 'a'.repeat(40);
const MERGE_MESSAGE = `v2026.10.26.6.1: drive_check names a shared drive\n\n${loopSquashBody({ number: 54, sha: 'b'.repeat(40), issue: 52 })}`;

test('a loop merge is known by its squash message; a revert, a person and a harness merge are not', () => {
  assert.deepEqual(loopMergeOf(MERGE_MESSAGE), { pr: 54, head: 'b'.repeat(40), issue: 52 });
  assert.equal(loopMergeOf(revertSquashBody({ number: 60, sha: SHA, block: { reverts: SHA, pr: 54 } })), null, 'a revert is never reverted');
  assert.equal(loopMergeOf('v2026.10.26.5.1: a person changed this'), null);
  assert.equal(isRevertBranch('loop/revert-aaaaaaaaaaaa'), true);
  assert.equal(isRevertBranch('loop/52-x'), false);
});

test("failed checks: those that finished with a failure or timed out; running, cancelled and the merge job's left out", () => {
  assert.deepEqual(failedChecks([
    { name: 'Tests', status: 'completed', conclusion: 'failure' },
    { name: 'Dashboard build', status: 'completed', conclusion: 'timed_out' },
    { name: 'Loop guard', status: 'completed', conclusion: 'cancelled' },
    { name: 'Promotion evidence', status: 'in_progress', conclusion: null },
    { name: HARNESS_MERGE_JOB, status: 'completed', conclusion: 'failure' },
  ]), ['Tests', 'Dashboard build']);
});

test("a revert's body carries what it reverts, and its block reads back", () => {
  const body = revertBody({ sha: SHA, pr: 54, issue: 52, failed: ['Tests'] });
  assert.match(body, /^Reverts #54 \(a{40}\): CI failed on main once the loop merged it \(Tests\)\./);
  assert.match(body, /#52, which it resolved, is reopened/);
  assert.deepEqual(parseRevertBlock(body), { reverts: SHA, pr: 54, issue: 52 });
  assert.equal(parseRevertBlock('```json paraclete-loop-revert\n{"reverts": "nope"}\n```'), null);
  assert.equal(parseRevertBlock('nothing'), null);
});

const REVERTED = {
  message: MERGE_MESSAGE,
  files: [
    { filename: 'agent/services/control/drive-check.mjs', status: 'modified' },
    { filename: 'tests/agent/services/control/drive-check-shared-root.test.mjs', status: 'added' },
    { filename: 'docs/new-name.md', status: 'renamed', previous_filename: 'docs/old-name.md' },
  ],
  before: { 'agent/services/control/drive-check.mjs': 'c'.repeat(40), 'docs/old-name.md': 'd'.repeat(40) },
};
const exact = [
  { filename: 'agent/services/control/drive-check.mjs', status: 'modified', sha: 'c'.repeat(40) },
  { filename: 'tests/agent/services/control/drive-check-shared-root.test.mjs', status: 'removed', sha: 'e'.repeat(40) },
  { filename: 'docs/old-name.md', status: 'renamed', previous_filename: 'docs/new-name.md', sha: 'd'.repeat(40) },
];
const revertPr = (o = {}) => ({ headRefName: `loop/revert-${SHA.slice(0, 12)}`, body: revertBody({ sha: SHA, pr: 54, issue: 52, failed: ['Tests'] }), ...o });

test('a revert passes only when it sets exactly the reverted files back, and the commit is a loop merge', () => {
  assert.deepEqual(revertGuard({ pr: revertPr(), files: exact, reverted: REVERTED }), { ok: true, problems: [], block: { reverts: SHA, pr: 54, issue: 52 } });
  const problems = (o) => revertGuard({ pr: revertPr(o.pr), files: o.files || exact, reverted: o.reverted === undefined ? REVERTED : o.reverted }).problems.join(' | ');
  assert.match(problems({ pr: { body: 'Reverts it.' } }), /carries no revert block/);
  assert.match(problems({ pr: { headRefName: 'loop/revert-bbbbbbbbbbbb' } }), /its branch is not loop\/revert-aaaaaaaaaaaa/);
  assert.match(problems({ reverted: null }), /could not be read/);
  assert.match(problems({ reverted: { ...REVERTED, message: 'v1: a person did this' } }), /is not a loop merge/);
  assert.match(problems({ pr: { body: revertBody({ sha: SHA, pr: 53, issue: 52, failed: ['Tests'] }) } }), /merged #54, not #53/);
  assert.match(problems({ files: [{ ...exact[0], sha: 'f'.repeat(40) }, exact[1], exact[2]] }), /drive-check\.mjs$/, 'a file not set back to what it was');
  assert.match(problems({ files: [...exact, { filename: 'agent/work/other.mjs', status: 'modified', sha: '1'.repeat(40) }] }), /agent\/work\/other\.mjs/, 'a file the merge never touched');
  assert.match(problems({ files: [exact[0], { ...exact[1], status: 'modified' }, exact[2]] }), /drive-check-shared-root\.test\.mjs/, 'a file the merge added stays');
  const referee = { ...REVERTED, files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }], before: { '.github/workflows/ci.yml': '2'.repeat(40) } };
  assert.match(problems({ reverted: referee, files: [{ filename: '.github/workflows/ci.yml', status: 'modified', sha: '2'.repeat(40) }] }), /judges changes or runs the loop/);
});

test('the reverted commit is read through GitHub: its message, its files, and their blobs before it', async () => {
  const answers = {
    [`repos/r/commits/${SHA}`]: { commit: { message: MERGE_MESSAGE }, parents: [{ sha: 'p'.repeat(40) }], files: REVERTED.files },
    [`repos/r/contents/agent/services/control/drive-check.mjs?ref=${'p'.repeat(40)}`]: { sha: 'c'.repeat(40) },
    [`repos/r/contents/docs/old-name.md?ref=${'p'.repeat(40)}`]: { sha: 'd'.repeat(40) },
  };
  const getJson = async (p) => {
    if (!(p in answers)) throw new Error('HTTP 404');
    return answers[p];
  };
  const read = await readReverted(getJson, 'r', SHA);
  assert.equal(read.message, MERGE_MESSAGE);
  assert.deepEqual(read.before, {
    'agent/services/control/drive-check.mjs': 'c'.repeat(40),
    'tests/agent/services/control/drive-check-shared-root.test.mjs': null,
    'docs/new-name.md': null,
    'docs/old-name.md': 'd'.repeat(40),
  });
  assert.equal(await readReverted(() => { throw new Error('HTTP 404'); }, 'r', SHA), null);
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository on main with a bare origin, whose head is a loop merge of #54 for #52. */
function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-sentinel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  git(work, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(work, 'docs', 'guide.md'), '# Guide\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'v2026.10.25.1.1: init');
  fs.writeFileSync(path.join(work, 'docs', 'guide.md'), '# Guide, broken\n');
  fs.writeFileSync(path.join(work, 'docs', 'added.md'), 'new\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', MERGE_MESSAGE);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '--quiet', '-u', 'origin', 'main');
  return { work, origin, head: git(work, 'rev-parse', 'HEAD') };
}

/** A fake gh: main's check runs, the pull requests to list, and every call it got. */
function fakeGh({ runs = [], prs = [] } = {}) {
  const calls = [];
  return {
    calls,
    exec(args) {
      calls.push(args);
      if (args[0] === 'api' && args[1].includes('/check-runs')) return JSON.stringify({ check_runs: runs });
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/your-org/paraclete/pull/60';
      return '';
    },
  };
}

const FAILED = [{ name: 'Tests', status: 'completed', conclusion: 'failure' }];
const NOW = new Date('2026-10-26T15:00:00Z');
const removeCheckout = ({ repoRoot, root, execGit }) => {
  execGit(['worktree', 'remove', '--force', root], repoRoot);
};
const check = (r, gh, o = {}) => checkMain({
  repoRoot: r.work, repo: 'your-org/paraclete', settings: LOOP_DEFAULTS, execGit: (args, cwd) => git(cwd, ...args), execGh: gh.exec,
  now: NOW, removeCheckout, ...o,
});

test("main's health: passing or no CI is healthy, running is pending, broken by a person is left to a person", (t) => {
  const r = repo(t);
  assert.equal(check(r, fakeGh()).state, 'healthy');
  assert.equal(check(r, fakeGh({ runs: [{ name: 'Tests', status: 'completed', conclusion: 'success' }] })).state, 'healthy');
  assert.equal(check(r, fakeGh({ runs: [{ name: 'Tests', status: 'in_progress', conclusion: null }] })).state, 'pending');
  git(r.work, 'commit', '--quiet', '--allow-empty', '-m', 'v2026.10.26.9.1: a person');
  git(r.work, 'push', '--quiet', 'origin', 'main');
  const broken = check(r, fakeGh({ runs: FAILED }));
  assert.equal(broken.state, 'broken');
  assert.match(broken.reason, /which is not a loop merge: a person mends it/);
});

test('a loop merge that broke main is reverted on its own branch, opened as a loop pull request, and its issue reopened', (t) => {
  const r = repo(t);
  const gh = fakeGh({ runs: FAILED });
  const res = check(r, gh);
  assert.deepEqual([res.state, res.pullRequest, res.paused], ['reverting', 'https://github.com/your-org/paraclete/pull/60', false]);
  const branch = `loop/revert-${r.head.slice(0, 12)}`;
  assert.equal(git(r.origin, 'show', `${branch}:docs/guide.md`), '# Guide', 'the file is as it was before the merge');
  assert.throws(() => git(r.origin, 'show', `${branch}:docs/added.md`), 'the file the merge added is gone');
  assert.match(git(r.origin, 'log', '-1', '--format=%s', branch), /^v2026\.10\.26\.7\.1: revert #54, which broke CI on main$/, 'the next free version after the merge it reverts');
  const create = gh.calls.find((a) => a[1] === 'create');
  assert.deepEqual([create[create.indexOf('--head') + 1], create[create.indexOf('--label') + 1]], [branch, 'loop']);
  assert.deepEqual(parseRevertBlock(create[create.indexOf('--body') + 1]), { reverts: r.head, pr: 54, issue: 52 });
  const reopen = gh.calls.find((a) => a[0] === 'issue' && a[1] === 'reopen');
  assert.equal(reopen[2], '52');
  assert.match(reopen[reopen.indexOf('--comment') + 1], /broke CI on main \(Tests\), so https:\/\/github\.com\/your-org\/paraclete\/pull\/60 reverts it/);
  assert.equal(gh.calls.some((a) => a[0] === 'variable'), false, 'one revert does not pause the loop');
  assert.doesNotMatch(git(r.work, 'worktree', 'list'), /paraclete-loop-revert-/, 'its checkout is removed');
});

test('a revert already open is not opened again; the day\'s second revert pauses the loop; a dry run does nothing', (t) => {
  const r = repo(t);
  const open = fakeGh({ runs: FAILED, prs: [{ number: 60, headRefName: `loop/revert-${r.head.slice(0, 12)}`, createdAt: '2026-10-26T14:00:00Z', title: 't', url: 'u60' }] });
  assert.deepEqual(check(r, open), { state: 'reverting', reason: `#60 reverts ${r.head.slice(0, 12)}`, pullRequest: 'u60' });
  assert.equal(open.calls.some((a) => a[1] === 'create'), false);

  const r2 = repo(t);
  const second = fakeGh({ runs: FAILED, prs: [{ number: 58, headRefName: 'loop/revert-ffffffffffff', createdAt: '2026-10-26T09:00:00Z', title: 't', url: 'u58' }] });
  assert.equal(check(r2, second).paused, true);
  const set = second.calls.find((a) => a[0] === 'variable');
  assert.deepEqual(set.slice(0, 3), ['variable', 'set', 'PARACLETE_LOOP_PAUSED']);
  assert.match(set[set.indexOf('--body') + 1], /^2 loop merges reverted within a day/);

  const r3 = repo(t);
  const dry = fakeGh({ runs: FAILED });
  assert.match(check(r3, dry, { dryRun: true }).reason, /a dry run reverts nothing/);
  assert.equal(dry.calls.some((a) => a[1] === 'create' || a[1] === 'reopen'), false);
});

test('a loop merge that cannot be reverted leaves main broken, so nothing is built on it', (t) => {
  const r = repo(t);
  const gh = fakeGh({ runs: FAILED });
  const res = check(r, gh, { execGit: (args, cwd) => {
    if (args.includes('revert')) throw new Error('error: could not revert: a conflict');
    return git(cwd, ...args);
  } });
  assert.equal(res.state, 'broken');
  assert.match(res.reason, /the loop's merge of #54, and it could not be reverted: error: could not revert: a conflict$/);
  assert.equal(gh.calls.some((a) => a[1] === 'create'), false);
  assert.doesNotMatch(git(r.work, 'worktree', 'list'), /paraclete-loop-revert-/, 'its checkout is removed');
});

test("the loop's pause: its repository variable, unless unset or 0", () => {
  const gh = (value) => (args) => {
    if (value instanceof Error) throw value;
    assert.deepEqual(args, ['variable', 'get', 'PARACLETE_LOOP_PAUSED', '--repo', 'your-org/paraclete']);
    return value;
  };
  assert.equal(loopPauseReason({ repo: 'your-org/paraclete', execGh: gh('2 loop merges reverted within a day\n') }), 'PARACLETE_LOOP_PAUSED: 2 loop merges reverted within a day');
  assert.equal(loopPauseReason({ repo: 'your-org/paraclete', execGh: gh('0') }), null);
  assert.equal(loopPauseReason({ repo: 'your-org/paraclete', execGh: gh(new Error('variable PARACLETE_LOOP_PAUSED was not found')) }), null);
});
