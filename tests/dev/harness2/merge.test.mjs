// Tests for dev/harness2/merge.mjs, its `merge` subcommand in dev/harness2/cli.mjs, and
// .github/workflows/harness-merge.yml. The merger squash-merges an open promotion (a `harness2/` or
// `h2/` branch of this repository, against main) only when the harness is not paused (here, in the
// environment, or on origin/main), CI passed on main's head and on the promotion's head, GitHub can
// merge it cleanly and its head contains main's head, its evidence block passes judgeEvidence and
// names every file it changes, and its files are on the mutable surface: none removed, prompt
// additions linted, contracts changed only in tunable keys within their ceilings. It merges at most
// one per run, pinned to the full head commit, with a stale version moved on first, and dispatches CI
// on main after a merge or when main's head has none. A refused promotion gets one comment per set of
// reasons, counted only when the merger posted it; a waiting one none; --dry-run writes nothing. git
// and GitHub are faked: no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../../dev/harness2/cli.mjs';
import { buildPromotionEvidence, formatEvidenceMarkdown } from '../../../dev/harness2/evidence.mjs';
import {
  addedLinesFromPatch, formatMergeReport, isHarnessBranch, mergeBlockers, mergePromotionPullRequests, mergerLogins,
  promotionVersion, refusalMarker, retitle, squashBody,
} from '../../../dev/harness2/merge.mjs';
import { PAUSE_ENV, PAUSE_FILE } from '../../../dev/harness2/pause.mjs';
import { HARNESS_MERGE_JOB } from '../../../dev/release.mjs';
import { readRepoFile } from '../../repo/repo-files.mjs';
import { fakeExec } from '../fakes.mjs';

const REPO = 'your-org/paraclete';
const NOW = new Date('2026-10-23T20:00:00.000Z');
const MAIN_SUBJECTS = ['v2026.10.23.11.1: the newest change on main', 'v2026.10.23.10.1: an older one'];
const TAGS = ['v2026.10.23.10.1', 'nightly'];
const NEXT = 'v2026.10.23.12.1';
const MAIN_HEAD = 'e'.repeat(40);
const OLD_MAIN = 'd'.repeat(40);
const NEW_MAIN = 'f'.repeat(40);
const CONTRACTS = readRepoFile('config/contracts.json');

/** Runs of two tasks, three trials a side, with the capability each scored; real-model runs. */
function runs(scores) {
  return Object.entries(scores).flatMap(([taskId, values]) => values.map((capability, trial) => ({ taskId, trial, capability, measured: true })));
}

/** Evidence as a real-model promotion carries it: measured runs and a passing calibration. */
function evidence(source = 'vertex') {
  return {
    ...buildPromotionEvidence({
      candidate: { id: 'cand', lens: 'INV', touchedPaths: ['prompts/cortex.md'], proposal: { source, hypothesis: 'plan smaller steps' } },
      baselineTrajectories: runs({ a: [0.5, 0.52, 0.48], b: [0.6, 0.61, 0.59] }),
      candidateTrajectories: runs({ a: [0.7, 0.72, 0.68], b: [0.6, 0.62, 0.6] }),
    }),
    measured: true,
    calibration: { ok: true, aa: { delta: 0, noise: 0.01 }, knownBad: { delta: -0.5, noise: 0.02, detected: true }, problems: [] },
  };
}

const PASSING = evidence();
/** A promotion's body, as promote.mjs writes it, with evidence that measured `touchedPaths`. */
const bodyFor = (touchedPaths = PASSING.touchedPaths) =>
  `# Paraclete-H² Candidate Promotion Report (cand)\n\n${formatEvidenceMarkdown({ ...PASSING, touchedPaths })}\n\n## Merging\nSquash.\n`;
const BODY = bodyFor();
const CAPABILITY_LINE = /^- \*\*Capability\*\*: .+$/m.exec(BODY)[0];
const PASSED_RUNS = [
  { name: 'Tests', status: 'completed', conclusion: 'success' },
  { name: 'Dashboard build', status: 'completed', conclusion: 'success' },
];
/** The merger's own job, running on main's head while it works: never CI. */
const MERGER_RUN = { name: HARNESS_MERGE_JOB, status: 'in_progress', conclusion: null };
const PATCH = '@@ -1,2 +1,3 @@\n # Cortex\n+Plan each step so its result can be read back.\n Context.';
const file = (filename, over = {}) => ({ filename, status: 'modified', patch: PATCH, ...over });

/** An open promotion that passes every rule, unless `over` says otherwise. */
function promotion(number, over = {}) {
  return {
    number,
    title: `${NEXT}: paraclete-h2(INV): promote cand-${number} (ΔS_cap=+0.1033, n=3)`,
    body: BODY,
    state: 'OPEN',
    isDraft: false,
    isCrossRepository: false,
    baseRefName: 'main',
    headRefName: `h2/promote-cand-${number}`,
    headRefOid: String(number % 10).repeat(40),
    mergeStateStatus: 'CLEAN',
    changedFiles: (over.files || [0]).length,
    comments: [],
    files: [file('prompts/cortex.md')],
    runs: PASSED_RUNS,
    base: MAIN_HEAD,
    contracts: CONTRACTS,
    ...over,
  };
}

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * A fake checkout and GitHub. Reads answer from main and the pull requests given; writes are
 * recorded and applied (a comment is added as the merger's, a title changes, a merge closes the pull
 * request and moves main to a new head with no CI yet).
 */
function fakeGitHub(prs = [], { subjects = [...MAIN_SUBJECTS], tags = TAGS, mainRuns = [...PASSED_RUNS, MERGER_RUN], mainPaused = null, fail = () => null } = {}) {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const main = { head: MAIN_HEAD, runs: mainRuns };
  const writes = [];
  const exec = fakeExec((program, args) => {
    const failed = fail(program, args);
    if (failed) return failed;
    if (program === 'git') {
      if (args[0] === 'fetch') return { code: 0 };
      if (args[0] === 'rev-parse') return { stdout: `${main.head}\n` };
      if (args[0] === 'cat-file') {
        if (mainPaused === null) return { code: 128, stderr: `fatal: path '${PAUSE_FILE}' does not exist in '${main.head}'\n` };
        return args[1] === '-e' ? { code: 0 } : { stdout: mainPaused };
      }
      if (args[0] === 'log') return { stdout: `${subjects.join('\n')}\n` };
      if (args[0] === 'tag') return { stdout: `${tags.join('\n')}\n` };
      return undefined;
    }
    assert.equal(program, 'gh', `unexpected program ${program}`);
    const [group, verb] = args;
    const pr = byNumber.get(Number(args[2]));
    const byHead = (sha) => [...byNumber.values()].find((p) => p.headRefOid === sha);
    if (group === 'pr' && verb === 'list') {
      const open = [...byNumber.values()].filter((p) => p.state === 'OPEN');
      return { stdout: JSON.stringify(open.map(({ number, headRefName, isCrossRepository }) => ({ number, headRefName, isCrossRepository }))) };
    }
    if (group === 'pr' && verb === 'view') {
      const { files, runs: checks, base, contracts, ...view } = pr;
      return { stdout: JSON.stringify(view) };
    }
    if (group === 'api') {
      const path = args.at(-1);
      const checks = /^repos\/[^/]+\/paraclete\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(path);
      if (checks) {
        const found = checks[1] === main.head ? main.runs : byHead(checks[1]).runs;
        return { stdout: JSON.stringify({ total_count: found.length, check_runs: found }) };
      }
      const files = /^repos\/your-org\/paraclete\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/.exec(path);
      if (files) {
        const page = Number(files[2]);
        return { stdout: JSON.stringify(byNumber.get(Number(files[1])).files.slice((page - 1) * 100, page * 100)) };
      }
      const compare = /^repos\/your-org\/paraclete\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
      if (compare) {
        assert.equal(compare[1], main.head, "compared with main's current head");
        const head = byHead(compare[2]);
        return { stdout: JSON.stringify({ status: head.base === main.head ? 'ahead' : 'diverged', behind_by: head.base === main.head ? 0 : 1, ahead_by: 1, merge_base_commit: { sha: head.base } }) };
      }
      const contents = /^repos\/your-org\/paraclete\/contents\/config\/contracts\.json\?ref=([0-9a-f]{40})$/.exec(path);
      assert.ok(contents, `unexpected API path ${path}`);
      const text = byHead(contents[1])?.contracts ?? CONTRACTS;
      return { stdout: JSON.stringify({ encoding: 'base64', content: base64(text) }) };
    }
    writes.push(args);
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (group === 'pr' && verb === 'comment') pr.comments.push({ author: { login: 'github-actions' }, body: value('--body') });
    if (group === 'pr' && verb === 'edit') pr.title = value('--title');
    if (group === 'pr' && verb === 'merge') {
      pr.state = 'MERGED';
      subjects.unshift(value('--subject'));
      main.head = NEW_MAIN;
      main.runs = [];
    }
    return { code: 0 };
  });
  const gh = () => exec.callsTo('gh').map((c) => c.args);
  return { exec, writes, prs: byNumber, main, gh };
}

/** A checkout with no off switch, or with one holding `pausedText`. */
function checkout(t, pausedText) {
  const root = mkdtempSync(join(tmpdir(), 'h2-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (pausedText !== undefined) {
    mkdirSync(join(root, 'dev', 'harness2'), { recursive: true });
    writeFileSync(join(root, PAUSE_FILE), pausedText);
  }
  return root;
}

function merge(t, github, opts = {}) {
  return mergePromotionPullRequests({ all: true, repoRoot: checkout(t), env: {}, exec: github.exec, now: NOW, ...opts });
}

/** The reason keys a refused result carries. */
const keys = (result) => (result.key ? result.key.split('+') : []);

describe('the pure parts', () => {
  test('only harness2/ and h2/ branches are promotions', () => {
    assert.ok(isHarnessBranch('h2/promote-gen2-winner'));
    assert.ok(isHarnessBranch('harness2/curriculum-c2-cortex'));
    for (const name of ['main', 'feature/h2/x', 'h2', 'harness2', 'claude/h2-fix', '', undefined]) assert.equal(isHarnessBranch(name), false, String(name));
  });

  test('a retitle replaces the leading version and keeps the rest', () => {
    assert.equal(retitle('v2026.10.23.3.1: paraclete-h2(INV): promote x', NEXT), `${NEXT}: paraclete-h2(INV): promote x`);
    assert.equal(retitle('paraclete-h2(INV): promote x', NEXT), `${NEXT}: paraclete-h2(INV): promote x`);
    assert.equal(retitle('v2026.13.01.1.1: a malformed version', NEXT), `${NEXT}: a malformed version`);
  });

  test("a title's version stands only when it is newer than every version on main and every tag", () => {
    const title = `${NEXT}: promote x`;
    assert.deepEqual(promotionVersion({ title, subjects: MAIN_SUBJECTS, tags: TAGS, now: NOW }),
      { version: NEXT, title, retitled: false, previous: NEXT });
    assert.deepEqual(promotionVersion({ title: 'v2026.10.23.11.1: promote x', subjects: MAIN_SUBJECTS, tags: TAGS, now: NOW }),
      { version: NEXT, title: `${NEXT}: promote x`, retitled: true, previous: 'v2026.10.23.11.1' }, 'equal to main is stale');
    assert.equal(promotionVersion({ title, subjects: MAIN_SUBJECTS, tags: [...TAGS, 'v2026.10.23.12.1'], now: NOW }).version,
      'v2026.10.23.13.1', 'a tag counts');
    assert.equal(promotionVersion({ title: 'promote x', subjects: [], tags: [], now: NOW }).version, 'v2026.10.23.1.1', 'no version gets one');
  });

  test('the lines a patch adds, never its context, removals or hunk headers', () => {
    assert.deepEqual(addedLinesFromPatch('@@ -1,3 +1,3 @@\n same\n-gone\n+new one\n++ looks like a header\n\\ No newline at end of file'),
      ['new one', '+ looks like a header']);
    assert.deepEqual(addedLinesFromPatch(undefined), []);
  });

  test("the merger's own logins: the workflow token's, and GITHUB_ACTOR's when set", () => {
    assert.deepEqual([...mergerLogins({})], ['github-actions', 'github-actions[bot]']);
    assert.deepEqual([...mergerLogins({ GITHUB_ACTOR: 'maintainer' })], ['github-actions', 'github-actions[bot]', 'maintainer']);
  });

  test('the blockers: refusals a person must fix, waits that pass by themselves', () => {
    const files = [file('prompts/cortex.md')];
    const ok = { pr: promotion(1), runs: PASSED_RUNS, files, behindBy: 0 };
    const clear = mergeBlockers(ok);
    assert.deepEqual([clear.refusals, clear.waits], [[], []]);
    assert.equal(clear.evidence.candidateId, 'cand', 'the evidence read from the block');
    const refused = (over) => mergeBlockers({ ...ok, ...over }).refusals.map((r) => r.key);

    const pending = mergeBlockers({ ...ok, pr: promotion(1, { mergeStateStatus: 'BLOCKED' }), runs: [{ name: 'Tests', status: 'queued' }] });
    assert.deepEqual(pending.refusals, [], 'a merge state CI will change is not judged while CI runs');
    assert.deepEqual(pending.waits.map((w) => w.key), ['ci-pending']);
    assert.deepEqual(mergeBlockers({ ...ok, runs: [] }).waits.map((w) => w.key), ['ci-pending'], 'no run is no pass');
    assert.deepEqual(mergeBlockers({ ...ok, runs: [...PASSED_RUNS, MERGER_RUN] }).waits, [], "the merger's own run is not CI");
    assert.deepEqual(refused({ pr: promotion(1, { mergeStateStatus: 'DIRTY' }), runs: [{ name: 'Tests', status: 'in_progress' }] }),
      ['not-mergeable-dirty'], 'a conflict is refused whatever CI does');
    assert.deepEqual(refused({ behindBy: 2 }), ['behind-main']);
    assert.deepEqual(refused({ behindBy: undefined }), ['behind-main'], 'not knowing is not current');
    assert.deepEqual(refused({ pr: promotion(1, { changedFiles: 4 }) }), ['files-unlisted']);
    assert.deepEqual(refused({ files: [], pr: promotion(1, { changedFiles: 1 }) }), ['files-unlisted', 'no-change']);
    assert.deepEqual(refused({ files: [file('prompts/cortex.md', { status: 'removed', patch: undefined })] }), ['removes-files']);
    assert.deepEqual(refused({ files: [file('prompts/cortex.md', { patch: undefined })] }), ['no-patch']);
    assert.deepEqual(refused({ files: [file('prompts/cortex.md', { patch: '@@ -1 +1,2 @@\n x\n+Respect the immutable spine.' })] }), ['prompt-lint']);
    assert.deepEqual(refused({ files: [file('prompts/motor.md')] }), ['unmeasured-files']);
  });

  test("a contracts change passes only in tunable keys within their ceilings, judged against the merge base", () => {
    const edited = (change) => { const c = JSON.parse(CONTRACTS); change(c); return `${JSON.stringify(c, null, 2)}\n`; };
    const ok = {
      pr: promotion(1, { body: bodyFor(['config/contracts.json']) }), runs: PASSED_RUNS, files: [file('config/contracts.json')], behindBy: 0,
    };
    assert.deepEqual(mergeBlockers({ ...ok, contracts: { base: CONTRACTS, head: edited((c) => { c.organs.max_steps = 30; }) } }).refusals, []);
    const guard = mergeBlockers({ ...ok, contracts: { base: CONTRACTS, head: edited((c) => { c.brain.transition_guard = 'observe'; }) } }).refusals;
    assert.deepEqual(guard.map((r) => r.key), ['contracts']);
    assert.match(guard[0].text, /contracts\.brain\.transition_guard was modified but is not on the tunable allowlist/);
    const ceiling = mergeBlockers({ ...ok, contracts: { base: CONTRACTS, head: edited((c) => { c.organs.max_steps = 80; }) } }).refusals;
    assert.match(ceiling[0].text, /organs\.max_steps=80 violates bounds \[5, 60\]/);
    assert.match(mergeBlockers({ ...ok, contracts: { base: CONTRACTS, head: '{ not json' } }).refusals[0].text, /at its head is not JSON/);
  });

  test("the squash body keeps the evidence's capability line, or writes one from the block", () => {
    const sha = 'a'.repeat(40);
    assert.equal(squashBody({ number: 7, sha, body: BODY, evidence: PASSING }).split('\n')[0], CAPABILITY_LINE);
    const written = squashBody({ number: 7, sha, body: 'no line here', evidence: PASSING });
    assert.match(written, /^- \*\*Capability\*\*: 0\.55 -> 0\.6533, delta 0\.1033, noise \(SE\) [\d.]+\n\nMerged from #7 at a{40} by dev\/harness2\/merge\.mjs/);
  });
});

describe('merging', () => {
  test('a promotion that passes everything is squash-merged at its full head commit, and CI is dispatched on main', async (t) => {
    const github = fakeGitHub([promotion(7)]);
    const res = await merge(t, github);
    assert.equal(res.ok, true);
    assert.deepEqual(res.merged, [7]);
    assert.equal(res.ciDispatched, true);
    assert.equal(res.hold, null, "CI passed on main's head; the merger's own run there does not count");
    assert.deepEqual(res.results.map(({ number, action, reasons, version }) => ({ number, action, reasons, version })),
      [{ number: 7, action: 'merged', reasons: [], version: NEXT }]);
    const sha = '7'.repeat(40);
    assert.deepEqual(github.writes, [
      ['pr', 'merge', '7', '--repo', REPO, '--squash', '--subject', promotion(7).title,
        '--body', squashBody({ number: 7, sha, body: BODY, evidence: PASSING }), '--match-head-commit', sha],
      ['workflow', 'run', 'ci.yml', '--repo', REPO, '--ref', 'main'],
    ]);
    assert.ok(github.writes[0].at(-1).length === 40, 'a full sha: a short one fails');
    assert.ok(github.writes[0][github.writes[0].indexOf('--body') + 1].startsWith(CAPABILITY_LINE));
    assert.deepEqual(github.exec.callsTo('git').map((c) => c.args), [
      ['remote', 'get-url', 'origin'],
      ['fetch', '--quiet', '--tags', 'origin', 'main'],
      ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
      ['cat-file', '-e', `${MAIN_HEAD}:dev/harness2/PAUSED`],
      ['log', '--format=%s', MAIN_HEAD, '--'],
      ['tag', '--list'],
    ], 'main and the tags are fetched before anything is read from them');
    const apiPaths = github.gh().filter((a) => a[0] === 'api').map((a) => a.at(-1).split('?')[0]);
    assert.deepEqual(apiPaths, [
      `repos/${REPO}/commits/${MAIN_HEAD}/check-runs`,
      `repos/${REPO}/pulls/7/files`,
      `repos/${REPO}/compare/${MAIN_HEAD}...${sha}`,
      `repos/${REPO}/commits/${sha}/check-runs`,
    ]);
    for (const call of github.exec.calls) assert.equal(call.opts.shell, undefined, 'no shell');
  });

  test('paused by the file, the variable, or the file on origin/main: nothing is merged, and the run succeeds', async (t) => {
    const github = fakeGitHub([promotion(7)]);
    const byFile = await mergePromotionPullRequests({ all: true, repoRoot: checkout(t, 'judging the new judge\n'), env: {}, exec: github.exec, now: NOW });
    assert.deepEqual({ ok: byFile.ok, paused: byFile.paused, reason: byFile.reason, results: byFile.results, ciDispatched: byFile.ciDispatched },
      { ok: true, paused: true, reason: 'dev/harness2/PAUSED: judging the new judge', results: [], ciDispatched: false });
    const byEnv = await merge(t, github, { env: { [PAUSE_ENV]: '1' } });
    assert.equal(byEnv.paused, true);
    assert.deepEqual(github.exec.calls, [], 'no git, no gh');
    assert.match(formatMergeReport(byFile), /^Paused \(dev\/harness2\/PAUSED: judging the new judge\): nothing was merged\.$/m);

    const onMain = fakeGitHub([promotion(7)], { mainPaused: 'holding for the new judge\nmore\n' });
    const byMain = await merge(t, onMain);
    assert.deepEqual({ ok: byMain.ok, paused: byMain.paused, reason: byMain.reason, merged: byMain.merged },
      { ok: true, paused: true, reason: 'dev/harness2/PAUSED on origin/main: holding for the new judge', merged: [] });
    assert.deepEqual(onMain.gh(), [], 'a switch committed to main stops the run before GitHub is read');
  });

  test('CI still running or not started: left alone, no comment; CI failed: refused with a comment', async (t) => {
    const github = fakeGitHub([
      promotion(1, { runs: [PASSED_RUNS[0], { name: 'Dashboard build', status: 'in_progress', conclusion: null }] }),
      promotion(2, { runs: [] }),
      promotion(3, { runs: [PASSED_RUNS[0], { name: 'Dashboard build', status: 'completed', conclusion: 'failure' }] }),
    ]);
    const res = await merge(t, github);
    assert.equal(res.ok, true, 'a refusal is the merger working');
    const [running, none, failed] = res.results;
    assert.equal(running.action, 'skipped');
    assert.match(running.reasons[0], /^CI is still running on 111111111111: Dashboard build \(in_progress\)$/);
    assert.equal(none.action, 'skipped');
    assert.match(none.reasons[0], /no CI check has run/);
    assert.equal(failed.action, 'refused');
    assert.deepEqual(failed.reasons, ['CI did not pass on 333333333333: Dashboard build (failure)']);
    assert.equal(failed.comment, 'posted');
    assert.deepEqual(github.writes.map((w) => w.slice(0, 3)), [['pr', 'comment', '3']], 'one comment, no merge, no dispatch');
    const body = github.writes[0][github.writes[0].indexOf('--body') + 1];
    assert.match(body, /CI did not pass on 333333333333/);
    assert.ok(body.includes(refusalMarker('ci-failed')));
  });

  test('not mergeable: a conflict or a block is refused, an unknown state waits', async (t) => {
    const github = fakeGitHub([
      promotion(1, { mergeStateStatus: 'DIRTY' }),
      promotion(2, { mergeStateStatus: 'BLOCKED' }),
      promotion(3, { mergeStateStatus: 'UNKNOWN' }),
    ]);
    const res = await merge(t, github);
    assert.deepEqual(res.results.map((r) => [r.action, r.key ?? null]),
      [['refused', 'not-mergeable-dirty'], ['refused', 'not-mergeable-blocked'], ['skipped', null]]);
    assert.match(res.results[0].reasons[0], /conflicts with main/);
    assert.match(res.results[2].reasons[0], /has not worked out yet/);
    assert.deepEqual(res.merged, []);
    assert.deepEqual(github.writes.map((w) => w.slice(0, 3)), [['pr', 'comment', '1'], ['pr', 'comment', '2']]);
  });

  test("a promotion whose head lacks main's head is refused, though GitHub calls it CLEAN", async (t) => {
    const github = fakeGitHub([promotion(1, { base: OLD_MAIN })]);
    const [result] = (await merge(t, github)).results;
    assert.deepEqual([result.action, result.key], ['refused', 'behind-main']);
    assert.match(result.reasons[0], /^its head lacks 1 commit\(s\) of main's head: its CI and evidence were measured on an older main; a promotion from main's head replaces it$/);
    assert.deepEqual(github.writes.map((w) => w.slice(0, 3)), [['pr', 'comment', '1']]);
  });

  test("nothing merges while CI on main's head failed or runs; a head with no CI gets it dispatched", async (t) => {
    const failing = fakeGitHub([promotion(1), promotion(2, { body: 'no evidence' })], {
      mainRuns: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }, MERGER_RUN],
    });
    const res = await merge(t, failing);
    assert.equal(res.ok, true);
    assert.equal(res.hold, "CI did not pass on main's head eeeeeeeeeeee: Tests (failure)");
    assert.deepEqual(res.results.map((r) => [r.number, r.action, r.reasons[0]]), [
      [1, 'skipped', "CI did not pass on main's head eeeeeeeeeeee: Tests (failure)"],
      [2, 'refused', res.results[1].reasons[0]],
    ]);
    assert.deepEqual(failing.writes.map((w) => w.slice(0, 3)), [['pr', 'comment', '2']], 'refusals are still posted; nothing merges');
    assert.match(formatMergeReport(res), /^Nothing merges this run: CI did not pass on main's head/m);

    const running = fakeGitHub([promotion(1)], { mainRuns: [{ name: 'Tests', status: 'in_progress' }] });
    const held = await merge(t, running);
    assert.match(held.hold, /^CI is still running on main's head/);
    assert.deepEqual([held.merged, running.writes], [[], []]);

    const none = fakeGitHub([promotion(1)], { mainRuns: [MERGER_RUN] });
    const dispatched = await merge(t, none);
    assert.equal(dispatched.hold, "no CI has run on main's head eeeeeeeeeeee yet");
    assert.equal(dispatched.ciDispatched, true);
    assert.deepEqual(none.writes, [['workflow', 'run', 'ci.yml', '--repo', REPO, '--ref', 'main']], 'CI dispatched, nothing merged');
    const dry = fakeGitHub([promotion(1)], { mainRuns: [] });
    assert.equal((await merge(t, dry, { dryRun: true })).ciDispatched, false);
    assert.deepEqual(dry.writes, []);
  });

  test('one promotion merges per run; the next run checks the rest against the new main', async (t) => {
    const github = fakeGitHub([
      promotion(4, { title: 'v2026.10.23.11.1: paraclete-h2(INV): promote cand-4 (ΔS_cap=+0.1033, n=3)' }),
      promotion(5),
    ]);
    const first = await merge(t, github);
    assert.deepEqual(first.results.map((r) => [r.number, r.action, r.version]), [[4, 'merged', NEXT], [5, 'skipped', null]]);
    assert.equal(first.results[0].title, `${NEXT}: paraclete-h2(INV): promote cand-4 (ΔS_cap=+0.1033, n=3)`, 'a stale version moves on');
    assert.equal(first.results[0].retitledFrom, 'v2026.10.23.11.1: paraclete-h2(INV): promote cand-4 (ΔS_cap=+0.1033, n=3)');
    assert.match(first.results[1].reasons[0], /^one promotion merges per run, and #4 came first: the next run checks this one against main as it is then$/);
    assert.deepEqual(github.writes.map((w) => w.slice(0, 3)), [['pr', 'edit', '4'], ['pr', 'merge', '4'], ['workflow', 'run', 'ci.yml']]);
    assert.equal(github.writes[0][github.writes[0].indexOf('--title') + 1], github.writes[1][github.writes[1].indexOf('--subject') + 1]);

    const second = await merge(t, github);
    assert.equal(second.mainHead, NEW_MAIN);
    assert.deepEqual(second.results.map((r) => [r.number, r.action, r.key]), [[5, 'refused', 'behind-main']],
      'measured on the main before #4, so it is not merged on top of it');
  });

  test('no evidence block, or evidence that fails its verdict, is refused', async (t) => {
    const template = evidence('template');
    const github = fakeGitHub([
      promotion(1, { body: 'A promotion with a table but no block.\n\n- **Capability**: 0.5 -> 0.9' }),
      promotion(2, { body: `${formatEvidenceMarkdown(template)}\n` }),
      promotion(3, { body: `\`\`\`json paraclete-h2-evidence\n{ not json\n\`\`\`\n` }),
    ]);
    const res = await merge(t, github);
    assert.deepEqual(res.results.map((r) => r.key), ['no-evidence', 'evidence-failed', 'no-evidence']);
    assert.match(res.results[1].reasons[0], /^its evidence does not pass: the change came from 'template', not a model/);
    assert.deepEqual(res.merged, []);
    assert.equal(github.writes.filter((w) => w[1] === 'merge').length, 0);
  });

  test('the verdict is judged afresh: a block that claims it passed is not believed', async (t) => {
    const claimed = { ...evidence('template'), verdict: { ok: true, problems: [] } };
    const github = fakeGitHub([promotion(1, { body: `\`\`\`json paraclete-h2-evidence\n${JSON.stringify(claimed)}\n\`\`\`\n` })]);
    const [result] = (await merge(t, github)).results;
    assert.equal(result.action, 'refused');
    assert.equal(result.key, 'evidence-failed');
  });

  test('a file the evidence did not measure is refused', async (t) => {
    const github = fakeGitHub([promotion(1, { files: [file('prompts/cortex.md'), file('prompts/motor.md')] })]);
    const [result] = (await merge(t, github)).results;
    assert.deepEqual([result.action, result.key], ['refused', 'unmeasured-files']);
    assert.match(result.reasons[0], /^it changes files its evidence did not measure: prompts\/motor\.md \(the evidence names prompts\/cortex\.md\)$/);
  });

  test('a file off the mutable surface, renamed away from it, or removed is refused', async (t) => {
    const named = (...paths) => ({ body: bodyFor(paths) });
    const github = fakeGitHub([
      promotion(1, { files: [file('prompts/cortex.md'), file('agent/gateway/tools.mjs')], ...named('prompts/cortex.md', 'agent/gateway/tools.mjs') }),
      promotion(2, { files: [file('roles/x/role.json')], ...named('roles/x/role.json') }),
      promotion(3, { files: [file('prompts/motor.md', { previous_filename: 'agent/work/approvals.mjs', status: 'renamed', patch: undefined })], ...named('prompts/motor.md', 'agent/work/approvals.mjs') }),
      promotion(4, { files: [file('skills/files/files-convert.mjs', { status: 'removed', patch: undefined })], ...named('skills/files/files-convert.mjs') }),
      promotion(5, { files: [file('prompts/motor.md', { status: 'removed', patch: undefined })], ...named('prompts/motor.md') }),
    ]);
    const res = await merge(t, github);
    assert.deepEqual(res.results.map(keys), [
      ['off-surface'], ['off-surface'], ['off-surface', 'removes-files'], ['off-surface', 'removes-files'], ['removes-files'],
    ]);
    assert.match(res.results[0].reasons[0], /agent\/gateway\/tools\.mjs: path 'agent\/gateway\/tools\.mjs' is part of the immutable spine/);
    assert.match(res.results[1].reasons[0], /roles\/x\/role\.json.*grants/);
    assert.match(res.results[2].reasons.join('\n'), /renames agent\/work\/approvals\.mjs to prompts\/motor\.md/);
    assert.match(res.results[3].reasons[0], /skill command/);
    assert.match(res.results[4].reasons[0], /^it removed prompts\/motor\.md: a promotion adds or edits files, and removes none$/);
    assert.deepEqual(res.merged, []);
  });

  test('the lines a promotion adds to product prompts are linted, and a file with no diff is refused', async (t) => {
    const github = fakeGitHub([
      promotion(1, { files: [file('prompts/cortex.md', { patch: '@@ -1 +1,2 @@\n # Cortex\n+Never cross the immutable spine.' })] }),
      promotion(2, { files: [file('prompts/cortex.md', { patch: undefined })] }),
    ]);
    const res = await merge(t, github);
    assert.deepEqual(res.results.map((r) => r.key), ['prompt-lint', 'no-patch']);
    assert.match(res.results[0].reasons[0], /prompts\/cortex\.md adds harness vocabulary the agent has no meaning for \(immutable spine\)/);
    assert.match(res.results[1].reasons[0], /GitHub shows no diff for prompts\/cortex\.md/);
  });

  test('a contracts change is read at the merge base and the head, and refused outside the tunable keys', async (t) => {
    const head = (change) => { const c = JSON.parse(CONTRACTS); change(c); return `${JSON.stringify(c, null, 2)}\n`; };
    const contractsPromotion = (number, change) => promotion(number, {
      files: [file('config/contracts.json')], body: bodyFor(['config/contracts.json']), contracts: head(change),
    });
    const guarded = fakeGitHub([contractsPromotion(1, (c) => { c.brain.transition_guard = 'observe'; })]);
    const [refused] = (await merge(t, guarded)).results;
    assert.deepEqual([refused.action, refused.key], ['refused', 'contracts']);
    assert.match(refused.reasons[0], /contracts\.brain\.transition_guard was modified but is not on the tunable allowlist/);
    assert.deepEqual(guarded.gh().filter((a) => a.at(-1).includes('/contents/')).map((a) => a.at(-1)), [
      `repos/${REPO}/contents/config/contracts.json?ref=${MAIN_HEAD}`,
      `repos/${REPO}/contents/config/contracts.json?ref=${'1'.repeat(40)}`,
    ]);

    const tuned = fakeGitHub([contractsPromotion(2, (c) => { c.organs.max_steps = 30; })]);
    assert.deepEqual((await merge(t, tuned)).merged, [2], 'a tunable key within its ceiling merges');
  });

  test("a refusal marker counts only in the merger's own comment", async (t) => {
    const marker = refusalMarker('no-evidence');
    const run = async (comments, env = {}) => {
      const github = fakeGitHub([promotion(1, { body: 'no evidence', comments })]);
      const [result] = (await merge(t, github, { env })).results;
      return [result.comment, github.writes.length];
    };
    assert.deepEqual(await run([{ author: { login: 'someone-else' }, body: marker }]), ['posted', 1], "a third party's marker silences nothing");
    assert.deepEqual(await run([{ author: { login: 'github-actions' }, body: marker }]), ['already posted', 0]);
    assert.deepEqual(await run([{ author: { login: 'github-actions[bot]' }, body: marker }]), ['already posted', 0]);
    assert.deepEqual(await run([{ author: { login: 'maintainer' }, body: marker }], { GITHUB_ACTOR: 'maintainer' }), ['already posted', 0]);
    assert.deepEqual(await run([{ body: marker }]), ['posted', 1], 'a comment with no author is not the merger');
  });

  test('any other pull request is never read further or touched, even one named with --pr', async (t) => {
    const github = fakeGitHub([
      promotion(1, { headRefName: 'feature/better-prompts' }),
      promotion(2, { isCrossRepository: true }),
      promotion(3, { headRefName: 'claude/h2-tweak' }),
    ]);
    const res = await merge(t, github);
    assert.deepEqual(res.results.map((r) => r.action), ['skipped', 'skipped', 'skipped']);
    assert.match(res.results[0].reasons[0], /^not a promotion: its branch feature\/better-prompts is not a promotion's/);
    assert.match(res.results[1].reasons[0], /another repository/);
    assert.deepEqual(github.gh().filter((a) => a[0] === 'pr').map((a) => a.slice(0, 2)), [['pr', 'list']], 'listed, never viewed');
    assert.deepEqual(github.writes, []);

    const named = await merge(t, github, { all: false, pr: 1 });
    assert.deepEqual(named.results.map((r) => [r.number, r.action]), [[1, 'skipped']]);
    assert.deepEqual(github.writes, [], 'viewed, then left alone');
    const against = await merge(t, fakeGitHub([promotion(6, { baseRefName: 'release' })]), { all: false, pr: '6' });
    assert.match(against.results[0].reasons[0], /against release, not main/);
  });

  test('a refusal is commented once, again only when its reasons change', async (t) => {
    const github = fakeGitHub([promotion(1, { body: 'no evidence' })]);
    const first = await merge(t, github);
    assert.equal(first.results[0].comment, 'posted');
    const second = await merge(t, github);
    assert.equal(second.results[0].comment, 'already posted');
    assert.equal(github.writes.length, 1, 'the same reasons are not commented twice');

    github.prs.get(1).runs = [{ name: 'Tests', status: 'completed', conclusion: 'failure' }];
    const third = await merge(t, github);
    assert.equal(third.results[0].key, 'ci-failed+no-evidence');
    assert.equal(third.results[0].comment, 'posted');
    assert.equal(github.writes.length, 2);
    assert.ok(github.prs.get(1).comments[1].body.includes(refusalMarker('ci-failed+no-evidence')));
  });

  test('--dry-run judges as a real run does and changes nothing on GitHub', async (t) => {
    const github = fakeGitHub([
      promotion(1, { body: 'no evidence' }),
      promotion(2, { title: 'v2026.10.22.1.1: paraclete-h2(INV): promote cand-2' }),
      promotion(3),
    ]);
    const res = await merge(t, github, { dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.results.map((r) => [r.number, r.action, r.version, r.comment ?? null]), [
      [1, 'refused', NEXT, 'would post'], [2, 'merged', NEXT, null], [3, 'skipped', null, null],
    ]);
    assert.deepEqual(github.gh().filter((a) => a[1] === 'view').map((a) => a[2]), ['1', '2'], 'after the merge it would make, the rest are not read');
    assert.deepEqual(github.writes, []);
    assert.equal(res.ciDispatched, false);
    assert.deepEqual([...github.prs.values()].map((p) => [p.state, p.comments.length]), [['OPEN', 0], ['OPEN', 0], ['OPEN', 0]]);
    assert.match(formatMergeReport(res), /^#2 would merge as v2026\.10\.23\.12\.1: paraclete-h2\(INV\): promote cand-2 \(retitled from v2026\.10\.22\.1\.1: paraclete-h2\(INV\): promote cand-2\)$/m);
    assert.match(formatMergeReport(res), /^Dry run: nothing was changed on GitHub\.$/m);
  });

  test('a merge GitHub refuses fails the run and ends the merging for it, and CI is not dispatched', async (t) => {
    const github = fakeGitHub([promotion(1), promotion(2)], {
      fail: (program, args) => (program === 'gh' && args[1] === 'merge'
        ? { code: 1, stderr: 'GraphQL: Head branch was modified. Review and try the merge again.\n' } : null),
    });
    const res = await merge(t, github);
    assert.equal(res.ok, false);
    assert.deepEqual(res.results.map((r) => [r.number, r.action]), [[1, 'skipped'], [2, 'skipped']]);
    assert.match(res.results[0].reasons[0], /gh could not merge #1:\nGraphQL: Head branch was modified/);
    assert.match(res.results[1].reasons[0], /^one promotion merges per run, and #1 came first/,
      'a merge reported as failed may still have landed, so no other is tried on the main it read');
    assert.equal(res.ciDispatched, false);
    assert.deepEqual(github.gh().filter((a) => a[1] === 'merge').map((a) => a[2]), ['1'], 'one merge was tried');
    assert.deepEqual(github.writes, []);
  });

  test('a fetch that fails merges nothing', async (t) => {
    const github = fakeGitHub([promotion(1)], {
      fail: (program, args) => (program === 'git' && args[0] === 'fetch' ? { code: 128, stderr: 'fatal: unable to access\n' } : null),
    });
    const res = await merge(t, github);
    assert.equal(res.ok, false);
    assert.match(res.error, /git could not fetch main and the tags from origin:\nfatal: unable to access/);
    assert.deepEqual(github.gh(), []);
  });

  test("the workflow's repository wins over the clone's origin", async (t) => {
    const github = fakeGitHub([]);
    const res = await merge(t, github, { env: { GITHUB_REPOSITORY: 'another-org/paraclete' } });
    assert.equal(res.repo, 'another-org/paraclete');
    assert.deepEqual(github.gh().find((a) => a[0] === 'pr').slice(0, 4), ['pr', 'list', '--repo', 'another-org/paraclete']);
    assert.match(formatMergeReport(res), /^No open promotion pull request\.$/m);
  });
});

describe('the merge subcommand', () => {
  test('--all --json gives the result; without --json a report too; a missing choice is a usage mistake', async (t) => {
    const deps = (github) => ({ exec: github.exec, env: {}, repoRoot: checkout(t), now: NOW });
    const json = await runCli(['merge', '--all', '--json'], deps(fakeGitHub([promotion(7)])));
    assert.equal(json.ok, true);
    assert.deepEqual(json.merged, [7]);
    assert.equal(json.report, undefined);
    const text = await runCli(['merge', '--pr', '7', '--dry-run'], deps(fakeGitHub([promotion(7)])));
    assert.match(text.report, /^#7 would merge as v2026\.10\.23\.12\.1: /m);
    for (const argv of [['merge'], ['merge', '--pr'], ['merge', '--pr', 'x7'], ['merge', '--pr', '7', '--all']]) {
      const res = await runCli(argv, deps(fakeGitHub([])));
      assert.equal(res.ok, false, argv.join(' '));
      assert.match(res.error, /merge takes --pr <number> or --all/);
    }
  });
});

describe('the workflows', () => {
  const text = readRepoFile('.github/workflows/harness-merge.yml');

  test('the merger runs every hour and by hand, never two at once', () => {
    assert.match(text, /^on:\n {2}schedule:\n {4}- cron: '20 \* \* \* \*'\n {2}workflow_dispatch:$/m);
    assert.match(text, /^concurrency:\n {2}group: harness-merge\n {2}cancel-in-progress: false$/m);
  });

  test("its one job's name is the one every CI verdict leaves out", () => {
    const jobs = [...text.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(jobs, [HARNESS_MERGE_JOB], 'dev/release.mjs HARNESS_MERGE_JOB names this job');
    assert.match(text, /^jobs:\n {2}merge:\n {4}name: /m);
  });

  test('its token can merge, comment, dispatch CI and read checks, and nothing more', () => {
    assert.match(text, /^permissions:\n {2}contents: write\n {2}pull-requests: write\n {2}actions: write\n {2}checks: read$/m);
  });

  test("it runs main's merger on main's full history and tags, installing nothing", () => {
    assert.match(text, /actions\/checkout@v4\n {8}with:\n {10}ref: main\n {10}fetch-depth: 0\n {10}fetch-tags: true\n {10}persist-credentials: false\n/);
    assert.match(text, /node-version: '24'/);
    const steps = [...text.matchAll(/run: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(steps, ['node dev/harness2/cli.mjs merge --all --json', 'node dev/loop/merger.mjs --json']);
    assert.match(text, /- name: Merge the loop changes that pass\n {8}if: success\(\) \|\| failure\(\)\n/, "the loop's merger runs even when the harness's failed");
    assert.doesNotMatch(text, /npm (ci|install|run)/);
  });

  test('values reach the merger through the environment only', () => {
    const expressions = text.split('\n').filter((line) => line.includes('${{')).map((line) => line.trim());
    const pair = ['GH_TOKEN: ${{ github.token }}', `${PAUSE_ENV}: \${{ vars.${PAUSE_ENV} }}`];
    assert.deepEqual(expressions, [...pair, ...pair], 'the same two for each merger');
  });

  test('CI can be dispatched, so a merge made with a workflow token still gets CI on main', () => {
    const ci = readRepoFile('.github/workflows/ci.yml');
    assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}workflow_dispatch:$/m);
  });
});
