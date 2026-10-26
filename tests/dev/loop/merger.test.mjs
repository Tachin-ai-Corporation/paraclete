// Tests for dev/loop/merger.mjs against a fake GitHub: a loop pull request that passes CI and the loop
// guard, is current with main and clean is squash-merged, pinned to its head, and CI is dispatched on
// main; one that cannot pass is closed with the reasons; one that is only waiting, or held by main's CI,
// the day's cap or another merge this run, is left; nothing happens while paused; a dry run changes
// nothing; other pull requests are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closingComment, formatLoopMergeReport, loopMergeBlockers, main, mergeLoopPullRequests } from '../../../dev/loop/merger.mjs';
import { doneWhen, formatReviewMarkdown } from '../../../dev/loop/reviewer.mjs';

const NOW = new Date('2027-01-21T12:00:00Z');
const MAIN_HEAD = '0'.repeat(40);
const ISSUE = { number: 33, title: 'Gates get rows', body: '**Done when:**\n- Each gate has a row.\n', state: 'OPEN', labels: [{ name: 'loop' }] };
const ITEMS = doneWhen(ISSUE);
const PASS = [{ name: 'Tests', status: 'completed', conclusion: 'success' }, { name: 'Loop guard', status: 'completed', conclusion: 'success' }];

/** A loop pull request that passes everything, with `o` over it. */
function loopPr(number, o = {}) {
  const sha = String(number).repeat(40).slice(0, 40);
  const files = [
    { filename: 'dashboard/components/work/WorkPlan.jsx', status: 'modified', sha: 'a'.repeat(40) },
    { filename: 'tests/dashboard/components/work/work-plan.test.mjs', status: 'added', sha: 'b'.repeat(40) },
  ];
  const reviewed = Object.fromEntries(files.map((f) => [f.filename, f.sha]));
  const review = { items: ITEMS.map((_, i) => ({ n: i + 1, met: true, evidence: 'seen' })), resolves: true, problems: [] };
  return {
    number,
    files,
    runs: PASS,
    behindBy: 0,
    view: {
      number, title: `v2027.01.21.${number}.1: Gates get rows`, state: 'OPEN', isDraft: false, isCrossRepository: false, baseRefName: 'main',
      headRefName: `loop/33-gates-get-rows-${number}`, headRefOid: sha, mergeStateStatus: 'CLEAN',
      body: `Resolves #33.\n\n${formatReviewMarkdown(review, ITEMS, reviewed)}\n`,
    },
    ...o,
  };
}

function fakeGitHub({ prs = [], others = [], mainRuns = PASS, merged = [], mainLog = 'v2027.01.20.1.1: before' } = {}) {
  const calls = [];
  const bySha = (sha) => prs.find((p) => p.view.headRefOid === sha);
  const byNumber = (n) => prs.find((p) => String(p.number) === String(n));
  const ok = (out) => ({ code: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' });
  const exec = async (program, args) => {
    calls.push([program, ...args].join(' '));
    if (program === 'git') {
      if (args[0] === 'cat-file') return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return ok(`${MAIN_HEAD}\n`);
      if (args[0] === 'log') return ok(mainLog);
      return ok('');
    }
    const [a, b] = args;
    if (a === 'api') {
      const where = args[args.length - 1];
      if (where.includes('/check-runs')) {
        const sha = where.split('/commits/')[1].split('/')[0];
        const runs = sha === MAIN_HEAD ? mainRuns : bySha(sha).runs;
        return ok({ total_count: runs.length, check_runs: runs });
      }
      if (where.includes('/compare/')) return ok({ behind_by: bySha(where.split('...')[1]).behindBy, merge_base_commit: { sha: MAIN_HEAD } });
      if (where.includes('/files')) return ok(byNumber(where.split('/pulls/')[1].split('/')[0]).files);
    }
    if (a === 'pr' && b === 'list') {
      if (args.includes('merged')) return ok(merged);
      return ok([...prs.map((p) => ({ number: p.number, headRefName: p.view.headRefName, isCrossRepository: false })), ...others]);
    }
    if (a === 'pr' && b === 'view') return ok(byNumber(args[2]).view);
    if (a === 'issue' && b === 'view') return ok(ISSUE);
    return ok('');
  };
  return { exec, calls, did: (verb) => calls.filter((c) => c.startsWith(`gh pr ${verb} `) || (verb === 'workflow' && c.startsWith('gh workflow run'))) };
}

function checkout(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-merger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const run = (t, gh, o = {}) => mergeLoopPullRequests({ exec: gh.exec, repoRoot: checkout(t), env: { GITHUB_REPOSITORY: 'your-org/paraclete' }, now: NOW, ...o });

test('a passing loop pull request is squash-merged at its head with its version, and CI is dispatched on main', async (t) => {
  const gh = fakeGitHub({ prs: [loopPr(5)], others: [{ number: 4, headRefName: 'claude/some-work', isCrossRepository: false }] });
  const r = await run(t, gh);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.merged, [5]);
  const [merge] = gh.did('merge');
  assert.match(merge, /^gh pr merge 5 --repo your-org\/paraclete --squash --subject v2027\.01\.21\.5\.1: Gates get rows --body Merged from #5 at 5{40} by dev\/loop\/merger\.mjs: CI and the loop guard passed, and its reviewer found every point of #33 met\.\n --match-head-commit 5{40}$/);
  assert.equal(gh.did('workflow').length, 1, 'CI is dispatched on main after the merge');
  assert.equal(gh.calls.some((c) => c.includes('pr view 4 ')), false, 'another branch is never read');
  assert.match(formatLoopMergeReport(r), /^#5 merged as v2027\.01\.21\.5\.1: Gates get rows\nLoop merges today: 1\.\nDispatched ci\.yml on main\.\n$/);
});

test('one that cannot pass is closed with its reasons, which the next attempt reads; a dry run only says so', async (t) => {
  const broken = loopPr(6, { files: [loopPr(6).files[0]], view: { ...loopPr(6).view, body: 'Resolves #33.\n' } });
  const gh = fakeGitHub({ prs: [broken] });
  const r = await run(t, gh);
  assert.deepEqual([r.merged, r.closed], [[], [6]]);
  const [close] = gh.did('close');
  assert.match(close, /^gh pr close 6 --repo your-org\/paraclete --comment The loop's merger closed this without merging it:\n\n- the loop guard: /);
  assert.match(close, /- the loop guard: it changes code \(dashboard\/components\/work\/WorkPlan\.jsx\) and adds no test/);
  assert.match(close, /#33 stays open: the loop takes it again from main's head, and its next attempt reads this comment\.$/);

  const dry = fakeGitHub({ prs: [broken] });
  const d = await run(t, dry, { dryRun: true });
  assert.deepEqual(d.closed, [6]);
  assert.equal(dry.did('close').length + dry.did('merge').length + dry.did('workflow').length, 0, 'nothing changes on GitHub');
  assert.match(formatLoopMergeReport(d), /^#6 would close: /);
});

test('conflicting or failing CI is closed; behind main, still running or still computing is left', async (t) => {
  const cases = [
    [{ behindBy: 2 }, 'waiting', /its head lacks 2 commit\(s\) of main's head: the next loop cycle brings it up to date/],
    [{ behindBy: 2, view: { ...loopPr(7).view, mergeStateStatus: 'DIRTY' } }, 'closed', /it conflicts with main/],
    [{ view: { ...loopPr(7).view, mergeStateStatus: 'DIRTY' } }, 'closed', /it conflicts with main/],
    [{ runs: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] }, 'closed', /CI did not pass on 7{12}: Tests \(failure\)/],
    [{ runs: [{ name: 'Tests', status: 'in_progress', conclusion: null }] }, 'waiting', /CI is still running/],
    [{ runs: [] }, 'waiting', /no CI check has run/],
    [{ view: { ...loopPr(7).view, mergeStateStatus: 'UNKNOWN' } }, 'waiting', /GitHub has not worked out yet/],
    [{ view: { ...loopPr(7).view, isDraft: true } }, 'waiting', /it is a draft/],
  ];
  for (const [over, action, reason] of cases) {
    const gh = fakeGitHub({ prs: [loopPr(7, over)] });
    const r = await run(t, gh);
    assert.equal(r.results[0].action, action, JSON.stringify(over).slice(0, 60));
    assert.match(r.results[0].reasons.join(' | '), reason);
    assert.equal(gh.did('merge').length, 0);
  }
});

test("main's CI, the day's cap and one merge per run hold the rest back", async (t) => {
  const failingMain = fakeGitHub({ prs: [loopPr(8)], mainRuns: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] });
  const held = await run(t, failingMain);
  assert.equal(held.hold, `CI did not pass on main's head ${'0'.repeat(12)}: Tests (failure)`);
  assert.deepEqual([held.results[0].action, held.merged], ['waiting', []]);

  const noCi = fakeGitHub({ prs: [loopPr(8)], mainRuns: [] });
  const dispatched = await run(t, noCi);
  assert.equal(dispatched.ciDispatched, true, 'a head with no CI gets it');
  assert.deepEqual(dispatched.merged, []);

  const merged = [1, 2, 3].map((n) => ({ number: n, headRefName: `loop/${n}-x`, mergedAt: '2027-01-21T03:00:00Z' }));
  const capped = await run(t, fakeGitHub({ prs: [loopPr(8)], merged: [...merged, { number: 9, headRefName: 'claude/x', mergedAt: '2027-01-21T04:00:00Z' }] }));
  assert.equal(capped.mergedToday, 3, 'only loop merges count');
  assert.match(capped.results[0].reasons[0], /today's 3 loop merges are done/);

  const two = fakeGitHub({ prs: [loopPr(8), loopPr(9)] });
  const one = await run(t, two);
  assert.deepEqual(one.merged, [8]);
  assert.deepEqual(one.results[1], { number: 9, action: 'waiting', reasons: ['one loop change merges per run, and #8 came first'] });
});

test('a stale version in the title is moved on; nothing happens while paused', async (t) => {
  const gh = fakeGitHub({ prs: [loopPr(5)], mainLog: 'v2027.01.21.9.1: newer than the pull request' });
  const r = await run(t, gh);
  assert.equal(r.results[0].title, 'v2027.01.21.10.1: Gates get rows');
  assert.equal(gh.did('edit').length, 1);

  const paused = fakeGitHub({ prs: [loopPr(5)] });
  const p = await run(t, paused, { env: { GITHUB_REPOSITORY: 'your-org/paraclete', PARACLETE_H2_PAUSED: '1' } });
  assert.equal(p.paused, true);
  assert.equal(paused.calls.length, 0, 'GitHub is not asked');
});

test('the pieces, and the command', async (t) => {
  assert.deepEqual(loopMergeBlockers({ pr: loopPr(5).view, runs: PASS, behindBy: 0, guard: { problems: [] } }), { refusals: [], waits: [] });
  assert.equal(closingComment(['a reason'], null), "The loop's merger closed this without merging it:\n\n- a reason\n\nThe loop takes it again from main's head, and its next attempt reads this comment.");
  const out = { text: '', write(s) { this.text += s; } };
  const gh = fakeGitHub({ prs: [] });
  assert.equal(await main(['--json'], { exec: gh.exec, repoRoot: checkout(t), env: { GITHUB_REPOSITORY: 'your-org/paraclete' }, now: NOW, stdout: out }), 0);
  assert.equal(JSON.parse(out.text).ok, true);
  assert.equal(await main(['--all'], { stdout: out, stderr: { write() {} } }), 2);
});
