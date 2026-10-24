// Tests for dev/loop/cycle.mjs: one loop cycle against a real git repository with a local bare origin,
// a fake gh, a fake proposer, a fake test run and a fake measurement. It opens a pull request for a
// checked change and pushes its branch; it refuses, with a comment on the issue, a change that touches
// the referee or an existing test, fails the suite, or changes the agent's behaviour unmeasured or for
// the worse; it does nothing while paused, past the day's cap, for an issue already in a loop pull
// request or tried lately; a dry run pushes nothing; every cycle is recorded and its checkout removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOOP_DEFAULTS } from '../../../dev/loop/config.mjs';
import { main, parseNameStatus, regressionProblems, runCycle, slugFor } from '../../../dev/loop/cycle.mjs';
import { buildPromotionEvidence } from '../../../dev/harness2/evidence.mjs';
import { CYCLE_LOG, readCycleRecords } from '../../../dev/harness2/health.mjs';

const NOW = new Date('2027-01-21T12:00:00Z');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository on main with a bare origin, holding a doc, agent code, a test, a workflow and a manifest. */
function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  fs.mkdirSync(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  const files = {
    '.gitignore': '.local/\nnode_modules/\n',
    'docs/guide.md': '# Guide\n',
    'agent/work/thing.mjs': 'export const thing = 1;\n',
    'tests/agent/thing.test.mjs': "import { test } from 'node:test';\ntest('thing', () => {});\n",
    '.github/workflows/ci.yml': 'name: CI\n',
    'package.json': '{ "name": "x" }\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  }
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'init');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '--quiet', '-u', 'origin', 'main');
  return { work, origin };
}

/** A fake gh: the issues and open pull requests to list, and every call it got. */
function fakeGh({ issues = [], prs = [] } = {}) {
  const calls = [];
  return {
    calls,
    exec(args) {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/your-org/paraclete/pull/99';
      return '';
    },
  };
}

const ISSUE = { number: 7, title: 'The guide explains the loop', body: 'Add a section.', url: 'u', createdAt: '2027-01-20T10:00:00Z' };

/** A proposer that writes `files` into the checkout, and says so. */
const writes = (files, { ok = true } = {}) => async ({ worktree }) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(worktree, rel)), { recursive: true });
    fs.writeFileSync(path.join(worktree, rel), text);
  }
  return { ok, summary: 'Added the section.', exitCode: ok ? 0 : 1, timedOut: false, reason: ok ? null : 'the proposer exited 1' };
};

const passing = async () => ({ ok: true, summary: 'ℹ tests 10, ℹ pass 10, ℹ fail 0' });
const runs = (caps, split = 'train') => caps.map((capability, i) => ({ taskId: `t-${split}`, split, trial: i + 1, capability, measured: true }));
const evidence = (cand) => buildPromotionEvidence({
  candidate: { id: 'loop-7', lens: 'LOOP', touchedPaths: ['agent/work/thing.mjs'], proposal: { source: 'coding-agent' } },
  baselineTrajectories: runs([0.8, 0.8, 0.8]), candidateTrajectories: runs(cand),
});

function cycle(t, r, o = {}) {
  const gh = o.gh || fakeGh({ issues: [ISSUE] });
  return {
    gh,
    run: () => runCycle({
      repoRoot: r.work, now: NOW, env: {}, settings: { ...LOOP_DEFAULTS, ...(o.settings || {}) },
      execGh: gh.exec, proposer: o.proposer || writes({ 'docs/guide.md': '# Guide\n\nThe loop.\n' }), runTests: o.runTests || passing,
      measure: o.measure || (async () => { throw new Error('measured a change that does not touch behaviour'); }),
      dryRun: Boolean(o.dryRun), log: () => {},
    }),
  };
}

const originHas = (r, branch) => {
  try {
    git(r.origin, 'rev-parse', '--verify', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

test('a checked change: committed under the next version, pushed, and opened as a pull request', async (t) => {
  const r = repo(t);
  const c = cycle(t, r);
  const res = await c.run();
  assert.equal(res.action, 'opened', res.reason);
  assert.equal(res.branch, 'loop/7-the-guide-explains-the-loop');
  assert.equal(res.pullRequest, 'https://github.com/your-org/paraclete/pull/99');
  assert.equal(res.behaviour, false);
  assert.ok(originHas(r, res.branch));
  assert.equal(git(r.origin, 'log', '-1', '--format=%s', res.branch), 'v2027.01.21.1.1: The guide explains the loop');
  const create = c.gh.calls.find((a) => a[0] === 'pr' && a[1] === 'create');
  assert.deepEqual(create.slice(2, 6), ['--base', 'main', '--head', res.branch]);
  const body = create[create.indexOf('--body') + 1];
  assert.match(body, /^Resolves #7\./);
  assert.match(body, /\*\*Tests\*\*: passed \(ℹ tests 10/);
  assert.match(body, /Added the section\./);
  assert.doesNotMatch(git(r.work, 'worktree', 'list'), /paraclete-loop-/, 'its checkout is removed');
  assert.doesNotMatch(git(r.work, 'branch', '--list'), /loop\//, 'its local branch is removed');
  const [rec] = readCycleRecords({ repoRoot: r.work });
  assert.deepEqual([rec.command, rec.loop.action, rec.loop.issue, rec.loop.changed, rec.pullRequest], ['loop', 'opened', 7, ['docs/guide.md'], 'https://github.com/your-org/paraclete/pull/99']);
});

test('a change to the referee or to an existing test is refused whole, with a comment on the issue', async (t) => {
  for (const [files, reason] of [
    [{ '.github/workflows/ci.yml': 'name: changed\n' }, /\.github\/workflows\/ci\.yml judges changes or runs the loop/],
    [{ 'package.json': '{ "name": "y" }\n' }, /package\.json judges changes/],
    [{ 'tests/agent/thing.test.mjs': '// emptied\n' }, /existing test: a proposal may add tests, never change or remove one/],
    [{ 'dev/loop/cycle.mjs': '// rewritten\n' }, /dev\/loop\/cycle\.mjs judges changes or runs the loop/],
  ]) {
    const r = repo(t);
    const c = cycle(t, r, { proposer: writes({ 'docs/guide.md': '# Guide\n\nok\n', ...files }) });
    const res = await c.run();
    assert.equal(res.action, 'refused-paths', JSON.stringify(files));
    assert.match(res.reason, reason);
    assert.equal(originHas(r, res.branch), false, 'nothing is pushed');
    const comment = c.gh.calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    assert.match(comment[comment.indexOf('--body') + 1], /stopped \(refused-paths\)/);
  }
});

test('a new test is welcome; a failing suite is refused', async (t) => {
  const r = repo(t);
  const added = await cycle(t, r, { proposer: writes({ 'tests/agent/new.test.mjs': '// new\n', 'docs/guide.md': '# G\n' }) }).run();
  assert.equal(added.action, 'opened', added.reason);
  const r2 = repo(t);
  const failing = await cycle(t, r2, { runTests: async () => ({ ok: false, summary: 'ℹ fail 2' }) }).run();
  assert.deepEqual([failing.action, failing.reason], ['tests-failed', 'the suite failed: ℹ fail 2']);
});

test("a change to the agent's behaviour is measured, and refused when unmeasured or worse", async (t) => {
  const behaviour = writes({ 'agent/work/thing.mjs': 'export const thing = 2;\n' });
  const seen = [];
  const r = repo(t);
  const ok = await cycle(t, r, {
    proposer: behaviour,
    measure: async (m) => {
      seen.push({ ...m, head: git(m.candidateRoot, 'log', '-1', '--format=%s') });
      return { measured: true, evidence: evidence([0.8, 0.82, 0.8]) };
    },
  }).run();
  assert.equal(ok.action, 'opened', ok.reason);
  assert.equal(ok.behaviour, true);
  assert.deepEqual(seen[0].changedPaths, ['agent/work/thing.mjs']);
  assert.equal(seen[0].base, git(r.work, 'rev-parse', 'origin/main'), 'measured against the head it branched from');
  assert.equal(seen[0].head, 'v2027.01.21.1.1: The guide explains the loop', 'the candidate is committed before it is measured');

  const r2 = repo(t);
  const unmeasured = await cycle(t, r2, { proposer: behaviour, measure: async () => ({ measured: false, reason: 'no Google Cloud project' }) }).run();
  assert.deepEqual([unmeasured.action, unmeasured.reason], ['unmeasured', "it changes the agent's behaviour and could not be measured: no Google Cloud project"]);

  const r3 = repo(t);
  const worse = await cycle(t, r3, { proposer: behaviour, measure: async () => ({ measured: true, evidence: evidence([0.5, 0.52, 0.5]) }) }).run();
  assert.equal(worse.action, 'regressed');
  assert.match(worse.reason, /task t-train got worse: capability 0\.8 -> 0\.5067/);
  assert.equal(originHas(r3, worse.branch), false);
});

test('nothing to do: paused, the day spent, no issue, an issue already in a pull request, or tried lately', async (t) => {
  const r = repo(t);
  const gh = fakeGh({ issues: [ISSUE] });
  const paused = await runCycle({ repoRoot: r.work, now: NOW, env: { PARACLETE_H2_PAUSED: '1' }, settings: LOOP_DEFAULTS, execGh: gh.exec, log: () => {} });
  assert.equal(paused.action, 'paused');
  assert.equal(gh.calls.length, 0, 'GitHub is not asked');

  const log = path.join(r.work, CYCLE_LOG);
  const record = (action, issue, at = NOW.toISOString()) => fs.appendFileSync(log, `${JSON.stringify({ command: 'loop', at, loop: { issue, action } })}\n`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  for (let i = 0; i < LOOP_DEFAULTS.maxCyclesPerDay; i += 1) record('opened', 100 + i);
  assert.equal((await cycle(t, r).run()).action, 'capped');

  const r2 = repo(t);
  assert.equal((await cycle(t, r2, { gh: fakeGh({ issues: [] }) }).run()).action, 'no-work');
  const inPr = await cycle(t, r2, { gh: fakeGh({ issues: [ISSUE], prs: [{ number: 5, headRefName: 'loop/7-earlier-try', title: 't' }] }) }).run();
  assert.equal(inPr.action, 'no-work');

  const r3 = repo(t);
  fs.mkdirSync(path.dirname(path.join(r3.work, CYCLE_LOG)), { recursive: true });
  fs.appendFileSync(path.join(r3.work, CYCLE_LOG), `${JSON.stringify({ command: 'loop', at: new Date(NOW.getTime() - 3_600_000).toISOString(), loop: { issue: 7, action: 'tests-failed' } })}\n`);
  assert.equal((await cycle(t, r3).run()).action, 'no-work', 'tried an hour ago');
  fs.writeFileSync(path.join(r3.work, CYCLE_LOG), `${JSON.stringify({ command: 'loop', at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString(), loop: { issue: 7, action: 'tests-failed' } })}\n`);
  assert.equal((await cycle(t, r3).run()).action, 'opened', 'tried a day ago: tried again');
});

test('a proposer that fails or changes nothing is refused; a dry run pushes and opens nothing', async (t) => {
  const r = repo(t);
  const failed = await cycle(t, r, { proposer: writes({}, { ok: false }) }).run();
  assert.deepEqual([failed.action, failed.reason], ['proposer-failed', 'the proposer exited 1']);
  const r2 = repo(t);
  const none = await cycle(t, r2, { proposer: writes({}) }).run();
  assert.equal(none.action, 'no-change');
  assert.match(none.reason, /changed nothing: Added the section/);

  const r3 = repo(t);
  const c = cycle(t, r3, { dryRun: true });
  const dry = await c.run();
  assert.equal(dry.action, 'ready');
  assert.equal(originHas(r3, dry.branch), false);
  assert.equal(c.gh.calls.some((a) => a[1] === 'create' || a[1] === 'comment'), false);
  assert.equal(readCycleRecords({ repoRoot: r3.work })[0].loop.dryRun, true);
});

test('the pieces: name-status, slugs, and what counts as worse', () => {
  assert.deepEqual(parseNameStatus('M\ta.md\nR100\told.md\tnew.md\nA\tt.test.mjs\n'), [
    { status: 'M', path: 'a.md' }, { status: 'R', path: 'new.md', oldPath: 'old.md' }, { status: 'A', path: 't.test.mjs' },
  ]);
  assert.equal(slugFor('Fix: the cortex   loops on "done"!'), 'fix-the-cortex-loops-on-done');
  assert.equal(slugFor('The mission page shows an approval gate as its own row'), 'the-mission-page-shows-an-approval-gate', 'no hyphen left at the cut');
  assert.deepEqual(regressionProblems(evidence([0.8, 0.8, 0.81])), [], 'no gain needed, no loss allowed');
  assert.match(regressionProblems(null)[0], /no measurement/);
  assert.match(regressionProblems({ ...evidence([0.8, 0.8, 0.8]), measured: false }).join(' '), /not real-model runs/);
});

test('the command prints the outcome and exits 0 for any outcome, 2 for a usage mistake', async (t) => {
  const r = repo(t);
  let out = '';
  const code = await main(['--json'], {
    repoRoot: r.work, now: NOW, env: { PARACLETE_H2_PAUSED: '1' }, settings: LOOP_DEFAULTS, execGh: () => '[]', log: () => {},
    stdout: { write: (s) => { out += s; } }, stderr: { write() {} },
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).action, 'paused');
  assert.equal(await main(['--issue', 'x'], { stdout: { write() {} }, stderr: { write() {} } }), 2);
});
