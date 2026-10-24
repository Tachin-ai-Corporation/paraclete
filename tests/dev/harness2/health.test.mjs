// Tests for dev/harness2/health.mjs and cli.mjs `health`: a cycle's record, the cycle log, each alarm
// the loop raises (and stays quiet when nothing is wrong), the issues kept one per alarm, and a cycle
// that runCli records even when it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALARM_LABEL, CYCLE_LOG, appendCycleRecord, collectHealthInputs, cycleRecord, formatHealthMarkdown, loopHealth,
  readCycleRecords, syncHealthIssues,
} from '../../../dev/harness2/health.mjs';
import { runCli } from '../../../dev/harness2/cli.mjs';

const NOW = new Date('2027-01-21T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A cycle record as cycleRecord writes it, with overrides. */
const cycle = (o = {}) => ({
  at: hoursAgo(2), command: 'curriculum', commit: 'a'.repeat(40), realModel: true, ok: true, paused: false, spendCapReached: false,
  reason: null, spend: { rollouts: 30, tokens: 900_000 },
  attempts: { total: 3, evaluated: 3, accepted: 0, notEvaluated: {}, sources: { vertex: 3 }, fallbackReasons: [] },
  evidence: { ok: false, problems: ['the capability gain 0 is below 0.01'], measured: true, delta: 0, noise: 0.03, trials: { baseline: 3, candidate: 3 }, calibration: null },
  pullRequest: null,
  ...o,
});

const keys = (h) => h.alarms.map((a) => a.key).sort();

test("a cycle's record: what ran, what each proposal did, and the evidence", () => {
  const rec = cycleRecord({
    command: 'curriculum',
    flags: { 'real-model': true, unit: 'unit-organ-motor' },
    commit: 'c'.repeat(40),
    now: NOW,
    result: {
      ok: true,
      spend: { rollouts: 12, tokens: 400 },
      attempts: [
        { evaluated: false, revertReason: 'not_evaluated: the model proposal fell back to the template: no project', proposal: { source: 'fallback', fallbackReason: 'no project' } },
        { evaluated: true, accepted: true, proposal: { source: 'vertex' } },
      ],
      readiness: { evidence: { measured: true, capability: { delta: 0.04, noise: 0.01 }, trials: { baseline: 3, candidate: 3 }, verdict: { ok: true, problems: [] }, calibration: { ok: true, problems: [] } } },
      pullRequest: { prUrl: 'https://github.com/your-org/paraclete/pull/9' },
    },
  });
  assert.deepEqual(rec.attempts, { total: 2, evaluated: 1, accepted: 1, notEvaluated: { not_evaluated: 1 }, sources: { fallback: 1, vertex: 1 }, fallbackReasons: ['no project'] });
  assert.deepEqual([rec.realModel, rec.unit, rec.evidence.ok, rec.evidence.calibration.ok, rec.pullRequest], [true, 'unit-organ-motor', true, true, 'https://github.com/your-org/paraclete/pull/9']);
});

test('the cycle log appends one line per cycle and skips a broken one', (t) => {
  const repoRoot = tmp(t);
  appendCycleRecord(cycle({ command: 'evolve' }), { repoRoot });
  fs.appendFileSync(path.join(repoRoot, CYCLE_LOG), 'not json\n');
  appendCycleRecord(cycle({ command: 'promote' }), { repoRoot });
  assert.deepEqual(readCycleRecords({ repoRoot }).map((c) => c.command), ['evolve', 'promote']);
  assert.deepEqual(readCycleRecords({ repoRoot: tmp(t) }), []);
});

test('a working loop has no alarms, and its numbers', () => {
  const h = loopHealth({ cycles: [cycle(), cycle({ at: hoursAgo(8) })], now: NOW });
  assert.deepEqual([h.ok, h.alarms], [true, []]);
  assert.deepEqual([h.stats.cycles, h.stats.measured_cycles, h.stats.proposals, h.stats.rollouts], [2, 2, 6, 60]);
  assert.match(formatHealthMarkdown(h), /Harness loop health: no alarms/);
});

test('a stopped loop, an unmeasured one, an idle proposer, a capped one, a failed calibration, flat runs', () => {
  assert.deepEqual(keys(loopHealth({ cycles: [cycle({ at: hoursAgo(30) })], now: NOW })), ['stalled']);
  assert.deepEqual(keys(loopHealth({ cycles: [cycle({ realModel: false, evidence: null })], now: NOW })), ['unmeasured']);
  const fallback = { total: 2, evaluated: 0, accepted: 0, notEvaluated: { not_evaluated: 2 }, sources: { fallback: 2 }, fallbackReasons: ['the model returned no proposal'] };
  const idle = loopHealth({ cycles: [cycle({ attempts: fallback }), cycle({ attempts: fallback })], now: NOW });
  assert.deepEqual(keys(idle), ['all-fallback']);
  assert.match(idle.alarms[0].detail.join(' '), /the model returned no proposal/);
  const capped = cycle({ ok: false, spendCapReached: true, reason: 'the run reached its cap of 120 model rollouts (--max-rollouts)' });
  assert.deepEqual(keys(loopHealth({ cycles: [capped, { ...capped, at: hoursAgo(5) }], now: NOW })), ['spend-cap']);
  const failedCal = cycle({ evidence: { ...cycle().evidence, calibration: { ok: false, problems: ['a known-bad change moved capability only -0.01'] } } });
  const cal = loopHealth({ cycles: [failedCal], now: NOW });
  assert.deepEqual(keys(cal), ['calibration-failed']);
  assert.match(cal.alarms[0].detail[0], /known-bad change/);
  const flat = cycle({ evidence: { ...cycle().evidence, noise: 0 }, spend: { rollouts: 30, tokens: 0 } });
  assert.deepEqual(keys(loopHealth({ cycles: [flat, { ...flat, at: hoursAgo(3) }], now: NOW })), ['zero-variance']);
  const saturated = cycle({ evidence: { ...cycle().evidence, noise: 0 } });
  assert.deepEqual(keys(loopHealth({ cycles: [saturated, { ...saturated, at: hoursAgo(3) }], now: NOW })), [], 'a suite every run solves spends tokens: not an alarm');
  assert.deepEqual(keys(loopHealth({ cycles: [], now: NOW })), ['stalled'], 'no cycle recorded at all');
});

test('paused, the loop is not stalled; the pause is a note', () => {
  const h = loopHealth({ cycles: [cycle({ at: hoursAgo(40) })], pause: { paused: true, reason: 'dev/harness2/PAUSED: new judge' }, now: NOW });
  assert.deepEqual(h.alarms, []);
  assert.match(h.notes[0], /paused \(dev\/harness2\/PAUSED: new judge\)/);
});

test('promotions that all claim one gain, merges without evidence, and promotions waiting for a release', () => {
  const pr = (number, title, o = {}) => ({ number, title, state: 'MERGED', headRefName: `harness2/curriculum-unit-${number}`, createdAt: hoursAgo(20 + number), mergedAt: hoursAgo(10 + number), body: 'no evidence here', ...o });
  const pullRequests = [
    pr(3, 'paraclete-h2(SYN): promote unit-organ-motor (ΔS_cap=+0.635)'),
    pr(4, 'paraclete-h2(SYN): promote unit-organ-cerebellum (ΔS_cap=+0.635)'),
    pr(5, 'paraclete-h2(SYN): promote unit-organ-temporal-memory (ΔS_cap=+0.635)'),
    pr(6, 'v2026.10.23.5.1: an unrelated change', { headRefName: 'claude/some-work' }),
  ];
  const release = { latestTag: 'v2027.01.10.1.1', promotionsSinceTag: [{ subject: 'v2027.01.15.1.1: paraclete-h2(DOM): promote x', at: hoursAgo(24 * 5) }] };
  const h = loopHealth({ cycles: [cycle()], pullRequests, release, now: NOW });
  assert.deepEqual(keys(h), ['identical-deltas', 'merged-without-evidence', 'release-stalled']);
  assert.match(h.alarms.find((a) => a.key === 'identical-deltas').detail[0], /#3, #4, #5/);
  assert.doesNotMatch(JSON.stringify(h.alarms), /#6/, 'only harness branches count');
});

/** A fake gh: answers `issue list` from `open`, records every call. */
function fakeGh(open = []) {
  const calls = [];
  return {
    calls,
    exec(args) {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(open);
      return '';
    },
  };
}

test('one issue per alarm: opened when new, commented while it lasts, closed when it clears', () => {
  const gh = fakeGh([{ number: 41, title: 'Harness alarm: stalled' }, { number: 42, title: 'Harness alarm: spend-cap' }]);
  const res = syncHealthIssues({
    alarms: [{ key: 'stalled', summary: 'No harness cycle has run for 30 hours', detail: [] }, { key: 'unmeasured', summary: 'None measured', detail: ['Add --real-model.'] }],
    execGh: gh.exec, now: NOW,
  });
  assert.deepEqual(res, { opened: ['unmeasured'], updated: ['stalled'], closed: [42], dryRun: false });
  const verbs = gh.calls.map((a) => `${a[0]} ${a[1]}`);
  assert.deepEqual(verbs, ['issue list', 'label create', 'issue comment', 'issue create', 'issue close']);
  const create = gh.calls.find((a) => a[1] === 'create' && a[0] === 'issue');
  assert.ok(create.includes(ALARM_LABEL) && create.includes('Harness alarm: unmeasured'));

  const failedRead = fakeGh([{ number: 42, title: 'Harness alarm: spend-cap' }]);
  const kept = syncHealthIssues({ alarms: [], execGh: failedRead.exec, closeCleared: false, now: NOW });
  assert.deepEqual(kept.closed, [], 'an alarm missing because its input failed has not cleared');
  const twice = fakeGh([]);
  const once = syncHealthIssues({ alarms: [{ key: 'stalled', summary: 'a', detail: [] }, { key: 'stalled', summary: 'b', detail: [] }], execGh: twice.exec, now: NOW });
  assert.deepEqual(once.opened, ['stalled'], 'one issue per key');
  assert.equal(twice.calls.filter((a) => a[0] === 'issue' && a[1] === 'create').length, 1);

  const dry = fakeGh([{ number: 42, title: 'Harness alarm: spend-cap' }]);
  const planned = syncHealthIssues({ alarms: [{ key: 'stalled', summary: 's', detail: [] }], execGh: dry.exec, dryRun: true, now: NOW });
  assert.deepEqual(planned, { opened: ['stalled'], updated: [], closed: [42], dryRun: true });
  assert.deepEqual(dry.calls.map((a) => `${a[0]} ${a[1]}`), ['issue list'], 'a dry run only reads');
});

test('the inputs: the log, the harness pull requests, and the promotions since the newest tag', (t) => {
  const repoRoot = tmp(t);
  appendCycleRecord(cycle(), { repoRoot });
  const execGh = () => JSON.stringify([{ number: 7, title: 't', state: 'OPEN', headRefName: 'harness2/x', createdAt: hoursAgo(1), mergedAt: null, body: '' }]);
  const execGit = (args) => {
    if (args[0] === 'tag') return 'v2027.01.10.1.1\nv2027.01.05.1.1\nnot-a-version';
    if (args[0] === 'log') {
      assert.equal(args.at(-1), 'v2027.01.10.1.1..origin/main');
      return 'v2027.01.15.1.1: paraclete-h2(DOM): promote x\t2027-01-15T10:00:00Z\nv2027.01.14.1.1: a person\'s change\t2027-01-14T10:00:00Z';
    }
    return '';
  };
  const inputs = collectHealthInputs({ repoRoot, execGh, execGit, env: {} });
  assert.equal(inputs.cycles.length, 1);
  assert.equal(inputs.pullRequests[0].number, 7);
  assert.deepEqual(inputs.release, { latestTag: 'v2027.01.10.1.1', promotionsSinceTag: [{ subject: 'v2027.01.15.1.1: paraclete-h2(DOM): promote x', at: '2027-01-15T10:00:00Z' }] });
  assert.deepEqual(inputs.problems, []);
  const broken = collectHealthInputs({ repoRoot, execGh: () => { throw new Error('gh: not logged in'); }, execGit, env: {} });
  assert.match(broken.problems[0], /could not list pull requests: gh: not logged in/);
});

test('runCli records a cycle even when it refuses, and `health` reads the record back', async (t) => {
  const repoRoot = tmp(t);
  const refused = await runCli(['evolve', '--real-model'], { repoRoot, env: { PARACLETE_H2_PAUSED: '1' } });
  assert.equal(refused.paused, true);
  const [rec] = readCycleRecords({ repoRoot });
  assert.deepEqual([rec.command, rec.paused, rec.realModel], ['evolve', true, true]);

  const health = await runCli(['health', '--markdown'], {
    repoRoot, env: { PARACLETE_H2_PAUSED: '1' }, execGh: () => '[]', execGit: (args) => (args[0] === 'tag' ? '' : ''),
  });
  assert.equal(health.stats.paused_cycles, 1);
  assert.match(health.report, /refused while paused/);
  assert.match(health.notes[0], /paused/);
});
