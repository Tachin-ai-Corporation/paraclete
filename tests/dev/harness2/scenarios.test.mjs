// Tests for dev/harness2/scenarios.mjs and its batteries, scenario-items.mjs: every scenario is fair
// (its questions give nothing away, each value they ask for was told first, and a changed fact's check
// never passes on the older one); runs start on time and their steps follow in order; a step that
// cannot be judged is tried later and then voids its run; a call waits for a step due within minutes,
// harvests a failed step, and keeps its state; the verification battery's answers are worked out
// independently, and its obvious wrong answers fail its checks; a call sends only its own battery's runs; smoke verdicts are read into outcomes; the lock keeps
// two calls apart; and the `scenarios` command reports and plans without the canary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BATTERIES, KEEPS, MEMORY_SCENARIOS, VERIFICATION_SCENARIOS, memoryValues, newYorkOffset, seededRandom, verificationValues,
} from '../../../dev/harness2/scenario-items.mjs';
import {
  MAX_TRIES, SCENARIO_STATE_VERSION, dueSteps, nextDueAt, pruneRuns, readScenarioState, recordStep, runIdFor, runScenarios,
  smokeAsk, startDueRuns, stepChecks, stepRequest, summarize, withScenarioLock, writeScenarioState,
} from '../../../dev/harness2/scenarios.mjs';
import { runCli } from '../../../dev/harness2/cli.mjs';
import { DEFECT_KINDS } from '../../../dev/harness2/bench-items.mjs';

const T0 = Date.parse('2027-03-07T09:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const empty = () => ({ version: SCENARIO_STATE_VERSION, runs: [] });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-test-'));

test('the batteries: unique ids, steps in time order, a teach before every ask, and runs at least daily apart', () => {
  assert.deepEqual(Object.keys(BATTERIES), ['memory', 'verification']);
  assert.equal(new Set(MEMORY_SCENARIOS.map((s) => s.id)).size, MEMORY_SCENARIOS.length);
  for (const s of MEMORY_SCENARIOS) {
    assert.equal(s.battery, 'memory', s.id);
    assert.ok(s.everyHours >= 24, s.id);
    assert.equal(s.steps[0].kind, 'teach', `${s.id} starts by telling the agent something`);
    assert.ok(s.steps.some((st) => st.kind === 'ask'), `${s.id} asks something`);
    const at = s.steps.map((st) => st.at);
    assert.deepEqual(at, [...at].sort((a, b) => a - b), `${s.id}: steps in time order`);
    assert.equal(new Set(s.steps.map((st) => st.id)).size, s.steps.length, `${s.id}: unique step ids`);
  }
});

test('a run\'s values follow from its seed, and differ between runs', () => {
  assert.deepEqual(memoryValues('mem-week-20270307t0900'), memoryValues('mem-week-20270307t0900'));
  const seen = new Set(Array.from({ length: 40 }, (_, i) => memoryValues(`seed-${i}`).database));
  assert.ok(seen.size >= 38, `fresh databases: ${seen.size} of 40`);
  const rnd = seededRandom('x');
  const draws = Array.from({ length: 100 }, rnd);
  assert.ok(draws.every((d) => d >= 0 && d < 1));
  for (let i = 0; i < 200; i += 1) {
    const v = memoryValues(`people-${i}`);
    assert.notEqual(v.person.first, v.other.first);
    assert.notEqual(v.person.last, v.other.last);
  }
});

test('every scenario is fair: each value an ask needs was told first, and no question gives its answer away', () => {
  for (const s of MEMORY_SCENARIOS) {
    for (let seed = 0; seed < 25; seed += 1) {
      const run = { id: `${s.id}-${seed}`, values: s.values(`${s.id}-${seed}`) };
      const told = s.steps.filter((st) => st.kind === 'teach').map((st) => stepRequest(s, run, st.id).text).join('\n');
      for (const st of s.steps.filter((x) => x.kind === 'ask')) {
        const req = stepRequest(s, run, st.id);
        assert.ok(req.harvest === 'recall' && req.expect.length >= 1, s.id);
        for (const e of req.expect) {
          const re = new RegExp(e.source, 'i');
          assert.ok(re.test(told), `${s.id}: /${e.source}/ was told before it is asked for`);
          assert.ok(!re.test(req.text), `${s.id}: the question itself answers /${e.source}/`);
          assert.ok(Object.values(KEEPS).includes(e.name), `${s.id}: ${e.name}`);
        }
      }
    }
  }
});

test('a changed fact is checked on the newer value, which the older one never satisfies', () => {
  const s = MEMORY_SCENARIOS.find((x) => x.id === 'mem-changed-fact');
  for (let seed = 0; seed < 50; seed += 1) {
    const run = { id: `c-${seed}`, values: s.values(`c-${seed}`) };
    const [check] = stepRequest(s, run, 'ask').expect;
    assert.equal(check.name, KEEPS.newer);
    const { person, other } = run.values;
    assert.ok(!new RegExp(check.source, 'i').test(`${person.first} ${person.last} owns it`), 'the older owner fails the check');
    assert.ok(new RegExp(check.source, 'i').test(`${other.first} ${other.last} owns it`), 'the newer owner passes it');
  }
});

test('a number is matched on its own, not inside a longer one', () => {
  const s = MEMORY_SCENARIOS.find((x) => x.id === 'mem-week');
  const run = { id: 'w', values: { ...s.values('w'), days: 30 } };
  const [days] = stepRequest(s, run, 'ask').expect;
  assert.ok(new RegExp(days.source, 'i').test('kept for 30 days'));
  assert.ok(!new RegExp(days.source, 'i').test('kept for 300 days'));
  assert.ok(!new RegExp(days.source, 'i').test('kept for 130 days'));
});

test('runs start for every scenario, not again within their interval, and again once it is up', () => {
  const first = startDueRuns({ state: empty(), scenarios: MEMORY_SCENARIOS, now: T0 });
  assert.equal(first.started.length, MEMORY_SCENARIOS.length);
  const run = first.state.runs.find((r) => r.scenario === 'mem-across-threads');
  assert.equal(run.id, runIdFor(MEMORY_SCENARIOS[0], T0));
  assert.equal(run.id, 'mem-across-threads-20270307t0900');
  assert.equal(run.status, 'running');
  assert.deepEqual(run.steps.map((s) => [s.id, s.dueAt]), [['teach', '2027-03-07T09:00:00.000Z'], ['ask', '2027-03-07T09:10:00.000Z']]);
  assert.deepEqual(run.values, memoryValues(run.id));

  const soon = startDueRuns({ state: first.state, scenarios: MEMORY_SCENARIOS, now: T0 + 23 * HOUR });
  assert.deepEqual(soon.started, []);
  const daily = startDueRuns({ state: first.state, scenarios: MEMORY_SCENARIOS, now: T0 + 23 * HOUR + 50 * MIN });
  assert.deepEqual(daily.started.map((id) => id.replace(/-\d{8}t\d{4}$/, '')).sort(),
    MEMORY_SCENARIOS.filter((s) => s.everyHours === 24).map((s) => s.id).sort(), 'the slack lets an hourly timer start daily runs on time; the weekly one waits');
});

test('steps go in order: an ask waits for its teach, then for its time', () => {
  let { state } = startDueRuns({ state: empty(), scenarios: [MEMORY_SCENARIOS[0]], now: T0 });
  const runId = state.runs[0].id;
  assert.deepEqual(dueSteps({ state, now: T0 }), [{ runId, stepId: 'teach' }]);
  assert.deepEqual(dueSteps({ state, now: T0 + 20 * MIN }), [{ runId, stepId: 'teach' }], 'the ask waits for the teach');
  const teach = stepRequest(MEMORY_SCENARIOS[0], state.runs[0], 'teach');
  state = recordStep({ state, runId, stepId: 'teach', request: teach, outcome: { pass: true, reason: 'the mission completed', mission: 'w-1' }, now: T0 + 2 * MIN });
  assert.deepEqual(dueSteps({ state, now: T0 + 10 * MIN }), [], 'the ten minutes count from when the teach ended');
  assert.equal(nextDueAt(state), T0 + 12 * MIN);
  assert.deepEqual(dueSteps({ state, now: T0 + 12 * MIN }), [{ runId, stepId: 'ask' }]);
  const ask = stepRequest(MEMORY_SCENARIOS[0], state.runs[0], 'ask');
  state = recordStep({ state, runId, stepId: 'ask', request: ask, outcome: { pass: true, reason: 'ok', mission: 'w-2' }, now: T0 + 12 * MIN });
  const run = state.runs[0];
  assert.equal(run.status, 'passed');
  assert.equal(run.endedAt, new Date(T0 + 12 * MIN).toISOString());
  assert.ok(run.steps[1].checks.every((c) => c.ok));
  assert.equal(nextDueAt(state), null);
});

test('a failed teach voids its run; a failed ask fails it, naming the values the answer missed', () => {
  const s = MEMORY_SCENARIOS[0];
  const begun = startDueRuns({ state: empty(), scenarios: [s], now: T0 }).state;
  const runId = begun.runs[0].id;
  const teach = stepRequest(s, begun.runs[0], 'teach');
  const voided = recordStep({ state: begun, runId, stepId: 'teach', request: teach, outcome: { pass: false, reason: 'the mission stopped as needs_input' }, now: T0 });
  assert.equal(voided.runs[0].status, 'void');
  assert.equal(nextDueAt(voided), null);

  let state = recordStep({ state: begun, runId, stepId: 'teach', request: teach, outcome: { pass: true, reason: 'ok' }, now: T0 });
  const ask = stepRequest(s, state.runs[0], 'ask');
  const [db, person] = ask.expect;
  const reason = `the answer does not mention /${db.source}/, /${person.source}/`;
  state = recordStep({ state, runId, stepId: 'ask', request: ask, outcome: { pass: false, reason, mission: 'w-9' }, now: T0 + 11 * MIN });
  assert.equal(state.runs[0].status, 'failed');
  assert.deepEqual(state.runs[0].steps[1].checks.map((c) => c.ok), [false, false, true]);
  assert.deepEqual(stepChecks(ask, { pass: false, reason: 'the mission ended failed' }).map((c) => c.ok), [false, false, false],
    'a mission that did not end well fails every check');
  const [row] = summarize(state, [s]);
  assert.equal(row.failed, 1);
  assert.equal(row.lastFailure.step, 'ask');
  assert.equal(row.lastFailure.mission, 'w-9');
});

test('a step that could not be judged is tried again later, and voids its run after the last try', () => {
  const s = MEMORY_SCENARIOS[0];
  let state = startDueRuns({ state: empty(), scenarios: [s], now: T0 }).state;
  const runId = state.runs[0].id;
  const teach = stepRequest(s, state.runs[0], 'teach');
  for (let i = 1; i < MAX_TRIES; i += 1) {
    state = recordStep({ state, runId, stepId: 'teach', request: teach, outcome: { pass: false, notEvaluated: true, reason: 'no result within 900 s' }, now: T0 + i * HOUR });
    const step = state.runs[0].steps[0];
    assert.equal(step.status, 'pending');
    assert.equal(step.tries, i);
    assert.equal(step.dueAt, new Date(T0 + i * HOUR + 30 * MIN).toISOString(), 'tried again half an hour later, not at once');
  }
  state = recordStep({ state, runId, stepId: 'teach', request: teach, outcome: { pass: false, notEvaluated: true, reason: 'no result' }, now: T0 + 9 * HOUR });
  assert.equal(state.runs[0].steps[0].status, 'not-evaluated');
  assert.equal(state.runs[0].status, 'void');
});

test('old finished runs are dropped past the number kept; running ones never are', () => {
  const runs = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, scenario: 'a', status: i === 0 ? 'running' : 'passed', startedAt: new Date(T0 - i * HOUR).toISOString(), steps: [] }));
  const kept = pruneRuns({ version: 1, runs }, 2).runs.map((r) => r.id);
  assert.deepEqual(kept, ['r0', 'r1', 'r2']);
});

/** A clock the fake sleep moves. */
function clock(start = T0) {
  let t = start;
  return { now: () => t, sleep: async (d) => { t += d; }, advance: (d) => { t += d; } };
}

test('a call sends the due steps, waits for an ask due within minutes, and stops at one due tomorrow', async () => {
  const c = clock();
  const sent = [];
  const saved = [];
  const ask = async (req) => {
    sent.push({ at: c.now(), kind: req.kind, text: req.text });
    c.advance(2 * MIN);
    return { pass: true, reason: 'the mission completed and its result was delivered', mission: `w-${sent.length}` };
  };
  const scenarios = MEMORY_SCENARIOS.filter((s) => ['mem-across-threads', 'mem-next-day'].includes(s.id));
  const res = await runScenarios({ scenarios, state: empty(), save: (s) => saved.push(s), ask, now: c.now, sleep: c.sleep });
  assert.equal(res.ok, true);
  assert.deepEqual(sent.map((s) => s.kind), ['teach', 'teach', 'ask']);
  assert.equal(sent[2].at, T0 + 12 * MIN, 'the ask went ten minutes after its teach ended');
  assert.equal(res.ran.length, 3);
  const [across, nextDay] = res.summary;
  assert.equal(across.passed, 1);
  assert.equal(nextDay.running, 1);
  assert.equal(res.nextDueAt, new Date(T0 + 4 * MIN + 26 * HOUR).toISOString(), 'the next-day ask is due 26 h after its teach ended');
  assert.ok(saved.length >= 3, 'the state is saved after every step');
  assert.deepEqual(saved.at(-1).runs.map((r) => r.status).sort(), ['passed', 'running']);
});

test('a failed recall is harvested, and a harvest that throws is recorded, not fatal', async () => {
  const s = MEMORY_SCENARIOS.find((x) => x.id === 'mem-across-threads');
  for (const harvest of [
    async ({ run, stepId, request }) => ({ diagnosis: 'stored', item: `memh-${run.id}`, step: stepId, values: request.expect.length }),
    async () => { throw new Error('Firestore said no'); },
  ]) {
    const c = clock();
    const ask = async (req) => {
      c.advance(MIN);
      return req.kind === 'teach'
        ? { pass: true, reason: 'ok', mission: 'w-teach' }
        : { pass: false, reason: `the answer does not mention /${req.expect[0].source}/`, mission: 'w-ask' };
    };
    let last = null;
    const res = await runScenarios({ scenarios: [s], state: empty(), save: (st) => { last = st; }, ask, harvest, now: c.now, sleep: c.sleep });
    assert.equal(res.harvested.length, 1);
    assert.equal(last.runs[0].status, 'failed');
    assert.ok(last.runs[0].harvest.diagnosis, 'the harvest record is kept with the run');
    if (res.harvested[0].item) assert.equal(res.harvested[0].item, `memh-${last.runs[0].id}`);
    else assert.deepEqual(res.harvested[0], { run: last.runs[0].id, diagnosis: 'not captured', reason: 'Firestore said no' });
  }
});

test('a step that throws is not evaluated; a dry run sends nothing', async () => {
  const c = clock();
  const s = MEMORY_SCENARIOS[0];
  const res = await runScenarios({ scenarios: [s], state: empty(), ask: async () => { throw new Error('IAP tunnel failed'); }, now: c.now, sleep: c.sleep });
  assert.equal(res.ran[0].status, 'pending');
  assert.match(res.ran[0].reason, /could not be sent: IAP tunnel failed/);
  let asked = 0;
  const dry = await runScenarios({ scenarios: MEMORY_SCENARIOS, state: empty(), ask: async () => { asked += 1; }, dryRun: true, now: c.now });
  assert.equal(asked, 0);
  assert.equal(dry.wouldStart.length, MEMORY_SCENARIOS.length);
  assert.equal(dry.wouldSend.length, MEMORY_SCENARIOS.length);
  assert.ok(dry.wouldSend.every((d) => d.stepId === 'teach'));
});

test('smoke verdicts become outcomes: a pass, a miss, a timeout and no verdict at all', async () => {
  const cases = [
    { out: 'PASS: role software-engineer, your request: the mission completed and its result was delivered.\nThe mission: node dev/query.mjs work --doc w-1\n', want: { pass: true, notEvaluated: false, mission: 'w-1' } },
    { out: 'FAIL: role software-engineer, your request: the answer does not mention /x-stg-1/.\nThe mission: node dev/query.mjs work --doc w-2\n', want: { pass: false, notEvaluated: false, mission: 'w-2' } },
    { out: 'FAIL: role software-engineer, your request: no result within 900 s (w-3 is active).\nThe mission: node dev/query.mjs work --doc w-3\n', want: { pass: false, notEvaluated: true, mission: 'w-3' } },
    { out: '', err: 'dev/smoke: could not read /etc/paraclete/instance.json on the VM (exit 255).', want: { pass: false, notEvaluated: true } },
  ];
  const { readSmokeVerdict } = await import('../../../dev/smoke.mjs');
  for (const c of cases) {
    let args = null;
    const main = async (argv, deps) => {
      args = argv;
      deps.stdout.write(c.out);
      if (c.err) deps.stderr.write(c.err);
      return c.out.startsWith('PASS') ? 0 : 1;
    };
    const got = await smokeAsk({ main, readVerdict: readSmokeVerdict, waitSeconds: 600 })({ text: 'hello', expect: [{ name: 'n', source: 'x-stg-1' }] });
    for (const [k, v] of Object.entries(c.want)) assert.equal(got[k], v, `${k} for ${c.out || c.err}`);
    assert.deepEqual(args, ['--request', 'hello', '--expect', 'x-stg-1', '--wait', '600']);
    if (c.err) assert.match(got.reason, /instance\.json/);
  }
});

test('the state file round-trips, refuses another version, and the lock keeps two calls apart', async () => {
  const dir = tmpDir();
  try {
    const file = '.local/canary/scenarios.json';
    assert.deepEqual(readScenarioState({ repoRoot: dir, file }), empty());
    const state = startDueRuns({ state: empty(), scenarios: MEMORY_SCENARIOS, now: T0 }).state;
    writeScenarioState({ repoRoot: dir, file, state });
    assert.deepEqual(readScenarioState({ repoRoot: dir, file }), state);
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ version: 99, runs: [] }));
    assert.throws(() => readScenarioState({ repoRoot: dir, file }), /version 99/);

    let inner = null;
    const outer = await withScenarioLock({ repoRoot: dir, file }, async () => {
      inner = await withScenarioLock({ repoRoot: dir, file }, async () => ({ ok: true }));
      return { ok: true };
    });
    assert.equal(outer.ok, true);
    assert.equal(inner.ok, false);
    assert.match(inner.reason, /holds .*scenarios\.json\.lock/);
    assert.ok(!fs.existsSync(path.join(dir, `${file}.lock`)), 'released');
    fs.writeFileSync(path.join(dir, `${file}.lock`), '1 long ago\n');
    const later = await withScenarioLock({ repoRoot: dir, file, now: () => Date.now() + 4 * HOUR }, async () => ({ ok: true }));
    assert.equal(later.ok, true, 'a lock a killed call left is taken over');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scenarios command reports, plans a dry run, refuses an unknown battery, and runs with what it is given', async () => {
  const dir = tmpDir();
  try {
    const quiet = { write() {} };
    const status = await runCli(['scenarios', '--status'], { repoRoot: dir, stderr: quiet });
    assert.equal(status.ok, true);
    assert.deepEqual(status.summary.map((r) => r.id), MEMORY_SCENARIOS.map((s) => s.id));
    assert.equal(status.nextDueAt, null);

    const unknown = await runCli(['scenarios', '--battery', 'tarot'], { repoRoot: dir, stderr: quiet });
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason, /no battery tarot/);

    const dry = await runCli(['scenarios', '--dry-run'], { repoRoot: dir, stderr: quiet, scenarioContext: {} });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldSend.length, MEMORY_SCENARIOS.length);
    assert.ok(!fs.existsSync(path.join(dir, '.local/canary/scenarios.json')), 'a dry run writes no state');

    const c = clock();
    const sent = [];
    const res = await runCli(['scenarios', '--wait-minutes', '0'], {
      repoRoot: dir, stderr: quiet, scenarioContext: {}, now: c.now, sleep: c.sleep,
      scenarioAsk: async (req) => { sent.push(req.kind); return { pass: true, reason: 'ok', mission: `w-${sent.length}` }; },
    });
    assert.equal(res.ok, true);
    assert.deepEqual(sent, MEMORY_SCENARIOS.map(() => 'teach'), 'with no wait, only the steps due now');
    const kept = readScenarioState({ repoRoot: dir });
    assert.equal(kept.runs.length, MEMORY_SCENARIOS.length);
    assert.ok(kept.runs.every((r) => r.steps[0].status === 'passed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the verification battery: one step of work each, a defect kind the bench knows, and fresh values', () => {
  assert.equal(new Set(VERIFICATION_SCENARIOS.map((s) => s.id)).size, VERIFICATION_SCENARIOS.length);
  for (const s of VERIFICATION_SCENARIOS) {
    assert.equal(s.battery, 'verification', s.id);
    assert.ok(s.everyHours >= 24, s.id);
    assert.equal(s.steps.length, 1, s.id);
    const run = { id: `${s.id}-0`, values: s.values(`${s.id}-0`) };
    const req = stepRequest(s, run, s.steps[0].id);
    assert.deepEqual([req.kind, req.harvest], ['ask', 'verification'], s.id);
    assert.ok(DEFECT_KINDS.includes(req.verify.kind), `${s.id}: ${req.verify.kind}`);
    assert.ok(req.verify.flaw.length > 20, s.id);
    assert.match(req.text, /with (a small script|a command)/, `${s.id} asks for work, not a recollection`);
  }
  assert.deepEqual(verificationValues('ver-day-count-20270307t0900'), verificationValues('ver-day-count-20270307t0900'));
  const seen = new Set(Array.from({ length: 40 }, (_, i) => verificationValues(`seed-${i}`).claims.cents));
  assert.ok(seen.size >= 38, `fresh totals: ${seen.size} of 40`);
});

test("New York's offset follows its daylight-saving rule on every day of the years the battery draws from", () => {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
  for (const year of [2027, 2028]) {
    for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const offset = Number(zone.formatToParts(new Date(`${day}T16:00:00Z`)).find((x) => x.type === 'timeZoneName').value.replace('GMT', ''));
      assert.equal(newYorkOffset(day), offset, day);
    }
  }
});

test('each verification answer is worked out independently, and the obvious wrong one fails its check', () => {
  const check = (s, v) => new RegExp(stepRequest(s, { values: v }, 'work').expect[0].source, 'i');
  const byId = (id) => VERIFICATION_SCENARIOS.find((s) => s.id === id);
  let summer = 0;
  for (let seed = 0; seed < 60; seed += 1) {
    const v = verificationValues(`ver-${seed}`);
    for (const s of VERIFICATION_SCENARIOS) {
      const req = stepRequest(s, { values: v }, 'work');
      assert.ok(!new RegExp(req.expect[0].source, 'i').test(req.text), `${s.id}: the request gives its answer away`);
    }
    // Both ends of the range count.
    const days = (Date.parse(v.range.end) - Date.parse(v.range.start)) / 86_400_000 + 1;
    assert.ok(check(byId('ver-day-count'), v).test(`That is ${days} days.`));
    assert.ok(!check(byId('ver-day-count'), v).test(`That is ${days - 1} days.`), 'the count without one end');
    // The wall time in New York on that day, read back from the UTC answer.
    const [hh, mm] = v.time.utc.split(':').map(Number);
    const at = `${v.time.day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
    const wall = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
    assert.equal(wall, v.time.local, `${v.time.day}: ${v.time.utc} UTC is ${v.time.local} in New York`);
    assert.ok(check(byId('ver-utc-time'), v).test(`It is ${v.time.utc} UTC.`));
    const other = `${String(hh + (v.time.offset === -4 ? 1 : -1)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    assert.ok(!check(byId('ver-utc-time'), v).test(`It is ${other} UTC.`), 'the other offset');
    if (v.time.offset === -4) summer += 1;
    // The fall on the bill before it, not after.
    const right = (((v.fall.before - v.fall.after) / v.fall.before) * 100).toFixed(1);
    const wrongBase = (((v.fall.before - v.fall.after) / v.fall.after) * 100).toFixed(1);
    assert.equal(v.fall.percent, right);
    assert.ok(check(byId('ver-rate-base'), v).test(`It fell by ${right}%.`));
    assert.ok(!check(byId('ver-rate-base'), v).test(`It fell by ${wrongBase}%.`), 'the fall on the wrong base');
    // The nine claims, summed in cents.
    const cents = v.claims.amounts.reduce((sum, a) => sum + Math.round(Number(a) * 100), 0);
    const total = (cents / 100).toFixed(2);
    assert.ok(check(byId('ver-claims-total'), v).test(`The total is ${total} EUR.`));
    const grouped = Number(total).toLocaleString('en-US', { minimumFractionDigits: 2 });
    assert.ok(check(byId('ver-claims-total'), v).test(`The total is EUR ${grouped}.`), 'with a thousands separator');
    assert.ok(!check(byId('ver-claims-total'), v).test(`The total is ${((cents - 1) / 100).toFixed(2)} EUR.`), 'a cent short');
  }
  assert.ok(summer >= 20 && summer <= 50, `both offsets are drawn: ${summer} of 60 in summer time`);
});

test("a call sends and waits for its own battery's runs only, when another battery shares the state file", async () => {
  const c = clock();
  const memory = startDueRuns({ state: empty(), scenarios: [MEMORY_SCENARIOS[0]], now: T0 - HOUR }).state;
  assert.equal(dueSteps({ state: memory, now: T0 }).length, 1, 'a memory step is due');
  const sent = [];
  const ask = async (req) => { sent.push(req.harvest); c.advance(5 * MIN); return { pass: true, reason: 'ok', mission: 'w-1' }; };
  const res = await runScenarios({ battery: 'verification', state: memory, ask, now: c.now, sleep: c.sleep });
  assert.deepEqual(sent, VERIFICATION_SCENARIOS.map(() => 'verification'), 'the memory step is left for its own battery');
  assert.equal(res.nextDueAt, null, 'no wait on the other battery');
  assert.equal(nextDueAt(memory, new Set(['ver-day-count'])), null);
});

test('failed work is harvested with its defect kind, and a passed step is not', async () => {
  const s = VERIFICATION_SCENARIOS.find((x) => x.id === 'ver-claims-total');
  for (const pass of [false, true]) {
    const c = clock();
    const asked = [];
    const harvest = async ({ request }) => { asked.push(request); return { diagnosis: 'verified wrong work', item: 'cbh-x-defect' }; };
    const ask = async () => { c.advance(4 * MIN); return { pass, reason: pass ? 'ok' : 'the answer does not mention /x/', mission: 'w-m' }; };
    const res = await runScenarios({ scenarios: [s], state: empty(), ask, harvest, now: c.now, sleep: c.sleep });
    assert.equal(res.harvested.length, pass ? 0 : 1);
    if (!pass) assert.deepEqual([asked[0].harvest, asked[0].verify.kind], ['verification', 'a wrong total']);
  }
});

test("the traps a script falls into: each answer worked out independently, and the tool's wrong answer fails its check", () => {
  const byId = (id) => VERIFICATION_SCENARIOS.find((s) => s.id === id);
  const check = (s, v) => new RegExp(stepRequest(s, { values: v }, 'work').expect[0].source, 'i');
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
  const offsetAt = (t) => Number(zone.formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName').value.replace('GMT', '')) || 0;
  /** The instant of a New York wall time, found from Intl's offset. */
  const instant = (day, hhmm) => {
    const wall = Date.parse(`${day}T${hhmm}:00Z`);
    let t = wall + 5 * 3_600_000;
    for (let i = 0; i < 3; i += 1) t = wall - offsetAt(t) * 3_600_000;
    return t;
  };
  let spring = 0;
  for (let seed = 0; seed < 60; seed += 1) {
    const v = verificationValues(`trap-${seed}`);
    // The overnight import: its length from the instants it started and ended.
    const ran = (instant(v.overnight.to, v.overnight.end) - instant(v.overnight.from, v.overnight.start)) / 60_000;
    const [h, m] = [Math.floor(ran / 60), ran % 60];
    assert.deepEqual([v.overnight.hours, v.overnight.minutes], [h, m], `${v.overnight.from} ${v.overnight.start} to ${v.overnight.to} ${v.overnight.end}`);
    const duration = check(byId('ver-overnight-duration'), v);
    assert.ok(duration.test(`It ran ${h}:${String(m).padStart(2, '0')}.`) && duration.test(`It ran ${h} hours and ${m} minutes.`));
    const wall = ran + (v.overnight.from.slice(5, 7) === '03' ? 60 : -60);
    if (wall > ran) spring += 1;
    assert.ok(!duration.test(`It ran ${Math.floor(wall / 60)}:${String(wall % 60).padStart(2, '0')}.`), "Python's same-zone subtraction, an hour out");
    // The invoices: halves up, in cents; Python's round() takes even-euro halves down.
    const cents = v.invoices.amounts.map((a) => Math.round(Number(a) * 100));
    assert.equal(cents.filter((c) => c % 100 === 50 && Math.floor(c / 100) % 2 === 0).length, 4, 'four halves on an even euro');
    const halfUp = cents.reduce((sum, c) => sum + Math.floor(c / 100) + (c % 100 >= 50 ? 1 : 0), 0);
    assert.equal(v.invoices.total, halfUp);
    const halfEven = cents.reduce((sum, c) => sum + Math.floor(c / 100) + (c % 100 > 50 || (c % 100 === 50 && Math.floor(c / 100) % 2 === 1) ? 1 : 0), 0);
    const total = check(byId('ver-half-up-total'), v);
    assert.ok(total.test(`The total is ${halfUp} EUR.`) && total.test(`EUR ${halfUp.toLocaleString('en-US')}.00`));
    assert.ok(!total.test(`The total is ${halfEven} EUR.`), "Python's round(), halves to even");
    // The working days: counted day by day, both ends in, the two holidays out.
    const days = [];
    for (const d = new Date(`${v.working.first}T00:00:00Z`); d <= new Date(`${v.working.last}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (d.getUTCDay() % 6 !== 0 && !v.working.holidays.includes(iso)) days.push(iso);
    }
    assert.equal(v.working.days, days.length);
    assert.deepEqual([days[0], days.at(-1)], [v.working.first, v.working.last], 'both ends are working days');
    const workdays = check(byId('ver-working-days'), v);
    assert.ok(workdays.test(`There are ${days.length} working days.`));
    assert.ok(!workdays.test(`There are ${days.length - 1} working days.`), "numpy's busday_count, which leaves the end out");
  }
  assert.ok(spring >= 15 && spring <= 45, `both changes are drawn: ${spring} of 60 in spring`);
});

test("the traps in the request: what the data lacks or repeats is found independently, and work that takes the request on trust fails", () => {
  const byId = (id) => VERIFICATION_SCENARIOS.find((s) => s.id === id);
  const check = (s, v) => new RegExp(stepRequest(s, { values: v }, 'work').expect[0].source, 'i');
  const cents = (text) => Math.round(Number(text) * 100);
  for (let seed = 0; seed < 60; seed += 1) {
    const v = verificationValues(`premise-${seed}`);
    // Twelve stores named, eleven listed: the one absent, found from the rows.
    const listed = v.stores.rows.map((r) => r.split(' ')[0]);
    assert.equal(listed.length, 11);
    const absent = Array.from({ length: 12 }, (_, i) => `S-${String(i + 1).padStart(2, '0')}`).filter((id) => !listed.includes(id));
    assert.deepEqual(absent, [v.stores.missing]);
    assert.ok(!['S-01', 'S-12'].includes(v.stores.missing), 'the range the request names starts and ends with a listed store');
    const store = check(byId('ver-missing-store'), v);
    const n = Number(v.stores.missing.slice(2));
    for (const said of [`${v.stores.missing} has no figure`, `S${String(n).padStart(2, '0')} is missing`, `S-${n} is not in the list`]) assert.ok(store.test(said), said);
    const top = v.stores.rows.map((r) => r.split(' ')).sort((a, b) => cents(b[1]) - cents(a[1]))[0];
    const total = v.stores.rows.reduce((sum, r) => sum + cents(r.split(' ')[1]), 0);
    assert.ok(!store.test(`The twelve stores sold ${(total / 100).toFixed(2)} EUR; ${top[0]} sold the most, ${top[1]} EUR.`), 'a total of what was listed, on trust');
    assert.ok(!store.test(`S-${String(n + 10).padStart(2, '0')} and S-1${n} are other stores.`), 'another store is not this one');

    // Ten invoices named, eleven lines: the repeat found by its id, its total counted once.
    const ids = v.ledger.lines.map((l) => l.split(' ')[0]);
    assert.equal(ids.length, 11);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(repeated, [v.ledger.twice]);
    const [i1, i2] = [ids.indexOf(v.ledger.twice), ids.lastIndexOf(v.ledger.twice)];
    assert.ok(i2 - i1 >= 3, 'the copy is not beside the original');
    assert.equal(v.ledger.lines[i1], v.ledger.lines[i2], 'a copy of its own line');
    const once = [...new Map(v.ledger.lines.map((l) => l.split(' '))).values()].reduce((sum, a) => sum + cents(a), 0);
    const all = v.ledger.lines.reduce((sum, l) => sum + cents(l.split(' ')[1]), 0);
    assert.equal(v.ledger.cents, once);
    const invoices = check(byId('ver-duplicate-invoice'), v);
    assert.ok(invoices.test(`We paid ${(once / 100).toFixed(2)} EUR.`));
    assert.ok(!invoices.test(`We paid ${(all / 100).toFixed(2)} EUR.`), 'the repeated line counted twice');

    // Nine claims and a stated total they do not add up to.
    const sum = v.premise.amounts.reduce((s, a) => s + cents(a), 0);
    assert.equal(v.premise.cents, sum);
    assert.ok(Math.abs(cents(v.premise.stated) - sum) >= 2000, 'the stated total is off by tens of euros');
    const claims = check(byId('ver-stated-total'), v);
    assert.ok(claims.test(`The claims total ${(sum / 100).toFixed(2)} EUR, not ${v.premise.stated}.`));
    assert.ok(!claims.test(`The total is ${v.premise.stated} EUR, so the average is ${(cents(v.premise.stated) / 900).toFixed(2)} EUR.`), 'the stated total taken on trust');
  }
  // The release notes' host never resolves; the answer must say the fetch failed, in whatever words.
  const v = verificationValues('premise-0');
  assert.match(v.notes.url, /^https:\/\/releases\.example\.invalid\/[a-z-]+\/latest\.txt$/);
  const fetch = check(byId('ver-failed-fetch'), v);
  for (const said of ["I couldn't fetch the release notes: the host does not resolve.", 'The fetch failed (curl: (6) Could not resolve host).',
    'Unable to retrieve the file.', 'The URL cannot be reached, so I have no version to give.', 'The domain is unreachable.', 'The notes were not found.']) {
    assert.ok(fetch.test(said), said);
  }
  for (const made of ['The release notes name version 4.2.1.', 'Version 2.0.3: fixes a failover bug and a login timeout.']) assert.ok(!fetch.test(made), made);
  assert.equal(stepRequest(byId('ver-failed-fetch'), { values: v }, 'work').verify.answerInRows, false, "the fetch's own error holds the answer's words");
  assert.equal(stepRequest(byId('ver-missing-store'), { values: v }, 'work').verify.answerInRows, true);
});
