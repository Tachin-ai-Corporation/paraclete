// dev/harness2/scenarios.mjs: the canary's scenario runner (docs/plan/MODULAR_LOOPS.md, 2.6 and phase
// 5). It drives the instance that `.local/instance.env` names (on the lab's driver: the lab's canary,
// which runs main's head) through the scripted scenarios of scenario-items.mjs, over hours or days, and
// keeps what each run did in a state file beside the checkout. Lab only: nothing here is in
// install/manifest.txt.
//
// Each call starts a run of every scenario whose last run started `everyHours` ago, then sends every
// step that is due. A step is a dashboard message in a thread of its own, sent and followed by
// dev/smoke.mjs (`--request`, with `--expect` for each value an `ask` step's answer must name), so a
// step passes exactly when a smoke request would: the mission finished, its result was delivered, and
// the answer names every value. A step that could not be judged (no result in time, the canary out of
// reach) is tried again at the next call, up to MAX_TRIES times. When the next step is due within
// `waitMinutes`, the call waits for it, so a ten-minute gap needs no second call.
//
// A run ends `passed`, `failed` (an `ask` step failed: the agent did not know what it was told) or
// `void` (a `teach` step failed, or a step could not be judged, so the run tested nothing). When an
// `ask` step that names a `harvest` fails, `harvest` is called with it: for `recall`, scenario-harvest.mjs
// reads the canary's memory and, when the forgotten values are in it, writes a memory bench item; for
// `verification`, verification-harvest.mjs reads the mission and, when a checkpoint passed the wrong
// work, writes a cerebellum bench item. Several batteries may share one state file: a call sends and
// waits for its own battery's runs only.
//
// It judges and records; it changes nothing on the canary beyond the messages it sends, and it never
// reads or answers anything the agent asks back (a step that needs a person fails). Called by
// `node dev/harness2/cli.mjs scenarios`.

import fs from 'node:fs';
import path from 'node:path';
import { BATTERIES } from './scenario-items.mjs';

export const SCENARIO_STATE_PATH = '.local/canary/scenarios.json';
export const SCENARIO_STATE_VERSION = 1;
/** How often a step that could not be judged is tried before its run counts as void. */
export const MAX_TRIES = 3;
/** The runs kept per scenario: the oldest finished ones are dropped past this. */
export const KEPT_RUNS = 30;
/**
 * A new run starts this long before `everyHours` is up, so a timer that fires every hour on the hour
 * does not slip an hour a day.
 */
const START_SLACK_MS = 15 * 60_000;
/** A step that could not be judged is tried again this much later: past `waitMinutes`, so at the next call. */
const RETRY_AFTER_MS = 30 * 60_000;
const MINUTE = 60_000;

const iso = (ms) => new Date(ms).toISOString();
const ms = (stamp) => Date.parse(stamp);

/** The state file's contents, or an empty state when there is none yet. */
export function readScenarioState({ repoRoot = process.cwd(), file = SCENARIO_STATE_PATH, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const full = path.resolve(repoRoot, file);
  let parsed = null;
  try {
    parsed = JSON.parse(readFile(full));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error(`${file} is not a scenario state file: ${err.message}`);
  }
  if (!parsed) return { version: SCENARIO_STATE_VERSION, runs: [] };
  if (parsed.version !== SCENARIO_STATE_VERSION || !Array.isArray(parsed.runs)) {
    throw new Error(`${file} is version ${parsed.version}; this runner reads version ${SCENARIO_STATE_VERSION}`);
  }
  return parsed;
}

/** Writes the state through a temporary file, so a killed call never leaves half of one. */
export function writeScenarioState({ repoRoot = process.cwd(), file = SCENARIO_STATE_PATH, state }) {
  const full = path.resolve(repoRoot, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, full);
}

/** A lock older than this belongs to a call that was killed: a call waits at most minutes, and sends a few steps. */
const STALE_LOCK_MS = 3 * 60 * MINUTE;

/**
 * Runs `body` holding the state file's lock, so a call started by hand and one a timer started never
 * send the same step twice. A lock left by a killed call is taken over once it is STALE_LOCK_MS old.
 *
 * @returns {Promise<object>} body's result, or {ok: false, reason} while another call holds the lock
 */
export async function withScenarioLock({ repoRoot = process.cwd(), file = SCENARIO_STATE_PATH, now = Date.now }, body) {
  const lock = `${path.resolve(repoRoot, file)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const take = () => fs.writeFileSync(lock, `${process.pid} ${iso(now())}\n`, { flag: 'wx' });
  try {
    take();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const age = now() - fs.statSync(lock).mtimeMs;
    if (age < STALE_LOCK_MS) return { ok: false, reason: `another scenarios call holds ${path.relative(repoRoot, lock)} (since ${Math.round(age / MINUTE)} min ago)` };
    fs.rmSync(lock, { force: true });
    take();
  }
  try {
    return await body();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** A run's id: the scenario's, and the minute it started (UTC). Pure. */
export function runIdFor(scenario, at) {
  const stamp = iso(at).slice(0, 16).replace(/[-:]/g, '').toLowerCase();
  return `${scenario.id}-${stamp}`;
}

/** The first step of a run still to send, or null when every step is done. Pure. */
export function nextStep(run) {
  return run.steps.find((s) => s.status === 'pending') || null;
}

/**
 * Starts a run of each scenario whose newest run started at least `everyHours` ago (less the slack).
 * Pure: returns the new state and the ids it started.
 */
export function startDueRuns({ state, scenarios, now }) {
  const runs = [...state.runs];
  const started = [];
  for (const scenario of scenarios) {
    const newest = runs.filter((r) => r.scenario === scenario.id).sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
    if (newest && now - ms(newest.startedAt) < scenario.everyHours * 60 * MINUTE - START_SLACK_MS) continue;
    const id = runIdFor(scenario, now);
    if (runs.some((r) => r.id === id)) continue;
    runs.push({
      id,
      scenario: scenario.id,
      battery: scenario.battery,
      startedAt: iso(now),
      values: scenario.values(id),
      status: 'running',
      steps: scenario.steps.map((s) => ({ id: s.id, kind: s.kind, at: s.at, dueAt: iso(now + s.at * MINUTE), status: 'pending', tries: 0 })),
    });
    started.push(id);
  }
  return { state: { ...state, runs }, started };
}

/** The steps due now, oldest first: each running run's next step whose time has come. Pure. */
export function dueSteps({ state, now, scenarioIds = null }) {
  return state.runs
    .filter((r) => r.status === 'running' && (!scenarioIds || scenarioIds.has(r.scenario)))
    .map((r) => ({ run: r, step: nextStep(r) }))
    .filter(({ step }) => step && ms(step.dueAt) <= now)
    .sort((a, b) => ms(a.step.dueAt) - ms(b.step.dueAt))
    .map(({ run, step }) => ({ runId: run.id, stepId: step.id }));
}

/** When the next step of any running run (of `scenarioIds`' scenarios, when given) falls due (ms), or null. Pure. */
export function nextDueAt(state, scenarioIds = null) {
  const times = state.runs.filter((r) => r.status === 'running' && (!scenarioIds || scenarioIds.has(r.scenario)))
    .map(nextStep).filter(Boolean).map((s) => ms(s.dueAt));
  return times.length ? Math.min(...times) : null;
}

/** What a step sends and what its answer must name, from the scenario and the run's values. Pure. */
export function stepRequest(scenario, run, stepId) {
  const def = scenario.steps.find((s) => s.id === stepId);
  if (!def) throw new Error(`${scenario.id} has no step ${stepId}`);
  return {
    kind: def.kind,
    harvest: def.harvest || null,
    text: def.text(run.values),
    expect: def.kind === 'ask' ? def.expect(run.values) : [],
    ...(def.verify ? { verify: { kind: def.verify.kind, flaw: def.verify.flaw(run.values), answerInRows: def.verify.answerInRows !== false } } : {}),
  };
}

/**
 * The checks of an `ask` step, from the smoke verdict: a check fails when the verdict names its value
 * as missing, and every check fails when the mission itself did not end well. Pure.
 */
export function stepChecks(request, outcome) {
  if (request.kind !== 'ask') return [];
  const missing = /^the answer does not mention /.test(outcome.reason || '');
  return request.expect.map((e) => ({
    name: e.name,
    source: e.source,
    ok: outcome.pass || (missing && !String(outcome.reason).includes(`/${e.source}/`)),
  }));
}

/**
 * Records a step's outcome. Pure: returns the new state.
 *
 * @param {object} o
 * @param {object} o.outcome {pass, reason, mission?, notEvaluated?}
 */
export function recordStep({ state, runId, stepId, request, outcome, now, maxTries = MAX_TRIES }) {
  const runs = state.runs.map((run) => {
    if (run.id !== runId) return run;
    const done = run.steps.find((s) => s.id === stepId);
    let steps = run.steps.map((s) => {
      if (s.id !== stepId) return s;
      const tries = s.tries + 1;
      const base = { ...s, tries, ranAt: iso(now), reason: String(outcome.reason || '').slice(0, 400), mission: outcome.mission || null };
      // Tried again later, not at once: the mission the first try started may still be running, and
      // the same question sent twice is a different test.
      if (outcome.notEvaluated) {
        return tries >= maxTries ? { ...base, status: 'not-evaluated' } : { ...base, status: 'pending', dueAt: iso(now + RETRY_AFTER_MS) };
      }
      return { ...base, status: outcome.pass ? 'passed' : 'failed', ...(request.kind === 'ask' ? { checks: stepChecks(request, outcome) } : {}) };
    });
    const step = steps.find((s) => s.id === stepId);
    // The gaps between steps count from when a step ended, so a teach that took six minutes still
    // leaves its ask the full ten.
    if (step.status === 'passed') {
      steps = steps.map((s) => (s.status === 'pending' && s.at > done.at
        ? { ...s, dueAt: iso(Math.max(ms(s.dueAt), now + (s.at - done.at) * MINUTE)) } : s));
    }
    let status = run.status;
    if (step.status === 'not-evaluated') status = 'void';
    else if (step.status === 'failed') status = step.kind === 'teach' ? 'void' : 'failed';
    else if (!steps.some((s) => s.status === 'pending')) status = 'passed';
    return { ...run, steps, status, ...(status !== 'running' ? { endedAt: iso(now) } : {}) };
  });
  return { ...state, runs };
}

/** Drops the oldest finished runs of each scenario past `kept`. Pure. */
export function pruneRuns(state, kept = KEPT_RUNS) {
  const byScenario = new Map();
  for (const r of state.runs) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) || []), r]);
  const drop = new Set();
  for (const runs of byScenario.values()) {
    const finished = runs.filter((r) => r.status !== 'running').sort((a, b) => ms(b.startedAt) - ms(a.startedAt));
    for (const r of finished.slice(kept)) drop.add(r.id);
  }
  return { ...state, runs: state.runs.filter((r) => !drop.has(r.id)) };
}

/** Each scenario's record: its runs by outcome, and its newest failure. Pure. */
export function summarize(state, scenarios) {
  return scenarios.map((s) => {
    const runs = state.runs.filter((r) => r.scenario === s.id);
    const count = (status) => runs.filter((r) => r.status === status).length;
    const failed = runs.filter((r) => r.status === 'failed').sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
    const failedStep = failed?.steps.find((st) => st.status === 'failed');
    return {
      id: s.id,
      about: s.about,
      runs: runs.length,
      passed: count('passed'),
      failed: count('failed'),
      void: count('void'),
      running: count('running'),
      ...(failed ? {
        lastFailure: {
          run: failed.id,
          step: failedStep?.id,
          reason: failedStep?.reason,
          mission: failedStep?.mission,
          ...(failed.harvest ? { harvest: failed.harvest } : {}),
        },
      } : {}),
    };
  });
}

/**
 * Asks through dev/smoke.mjs, in this process: `--request` with an `--expect` for each value, and its
 * verdict read back from what it printed. A run with no verdict (the canary out of reach, the ears
 * dropping the message) and a verdict of no result in time are not evaluated.
 *
 * @param {object} [o]
 * @param {Function} [o.main] dev/smoke.mjs main, for tests
 * @param {Function} [o.readVerdict] dev/smoke.mjs readSmokeVerdict, for tests
 * @param {number} [o.waitSeconds]
 * @param {object} [o.deps] passed to smoke's main (see devContext in dev/dev-env.mjs)
 * @returns {Function} async ({text, expect}) => {pass, reason, mission, notEvaluated}
 */
export function smokeAsk({ main = null, readVerdict = null, waitSeconds = 900, deps = {} } = {}) {
  return async ({ text, expect }) => {
    const smoke = (main && readVerdict) ? { main, readSmokeVerdict: readVerdict } : await import('../smoke.mjs');
    let out = '';
    let err = '';
    const args = ['--request', text, ...expect.flatMap((e) => ['--expect', e.source]), '--wait', String(waitSeconds)];
    await smoke.main(args, {
      ...deps,
      stdout: { write: (chunk) => { out += String(chunk); return true; } },
      stderr: { write: (chunk) => { err += String(chunk); return true; } },
    });
    const verdict = smoke.readSmokeVerdict(out);
    if (!verdict) {
      const why = err.replace(/\s+/g, ' ').trim().slice(-300) || 'smoke gave no verdict';
      return { pass: false, notEvaluated: true, reason: why };
    }
    return {
      pass: verdict.pass,
      reason: verdict.reason,
      mission: verdict.mission,
      notEvaluated: !verdict.pass && /^no result within /.test(verdict.reason),
    };
  };
}

/**
 * One call of the runner: start the runs that are due, send the steps that are due, harvest a failed
 * step that names a harvest, and wait for a step due within `waitMinutes`.
 *
 * @param {object} o
 * @param {object} o.state       from readScenarioState
 * @param {Function} o.save      (state) => void, called after every change
 * @param {Function} o.ask       async (request) => outcome; smokeAsk() on the canary
 * @param {Function} [o.harvest] async ({run, stepId, request, outcome}) => a harvest record, for a failed step whose request.harvest names one
 * @returns {Promise<object>} what ran, what was harvested, each scenario's record, and when the next step is due
 */
export async function runScenarios({
  battery = 'memory', scenarios = BATTERIES[battery], state, save = () => {}, ask, harvest = null,
  now = Date.now, sleep = (t) => new Promise((resolve) => { setTimeout(resolve, t); }), waitMinutes = 15, dryRun = false, log = () => {},
}) {
  if (!scenarios) return { ok: false, reason: `there is no battery ${battery}; name one of ${Object.keys(BATTERIES).join(', ')}` };
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  // Only this battery's runs are sent and waited for: another battery may share the state file.
  const own = new Set(byId.keys());
  const begun = startDueRuns({ state, scenarios, now: now() });
  if (dryRun) {
    const due = dueSteps({ state: begun.state, now: now(), scenarioIds: own });
    const next = nextDueAt(begun.state, own);
    return { ok: true, dryRun: true, battery, wouldStart: begun.started, wouldSend: due, nextDueAt: next === null ? null : iso(next) };
  }
  let current = begun.state;
  if (begun.started.length) {
    log(`[INFO] scenarios: started ${begun.started.join(', ')}`);
    save(current);
  }
  const ran = [];
  const harvested = [];
  for (;;) {
    for (const { runId, stepId } of dueSteps({ state: current, now: now(), scenarioIds: own })) {
      const run = current.runs.find((r) => r.id === runId);
      const scenario = byId.get(run.scenario);
      if (!scenario) continue;
      const request = stepRequest(scenario, run, stepId);
      log(`[INFO] scenarios: ${runId} ${stepId}: sending`);
      let outcome;
      try {
        outcome = await ask(request);
      } catch (err) {
        outcome = { pass: false, notEvaluated: true, reason: `the step could not be sent: ${err.message}` };
      }
      current = recordStep({ state: current, runId, stepId, request, outcome, now: now() });
      save(current);
      const after = current.runs.find((r) => r.id === runId);
      const step = after.steps.find((s) => s.id === stepId);
      ran.push({ run: runId, step: stepId, status: step.status, reason: step.reason, mission: step.mission });
      log(`[INFO] scenarios: ${runId} ${stepId}: ${step.status}${step.reason ? ` (${step.reason})` : ''}`);
      if (step.status === 'failed' && request.harvest && harvest) {
        let record;
        try {
          record = await harvest({ run: after, stepId, request, outcome });
        } catch (err) {
          record = { diagnosis: 'not captured', reason: err.message };
        }
        current = { ...current, runs: current.runs.map((r) => (r.id === runId ? { ...r, harvest: record } : r)) };
        save(current);
        harvested.push({ run: runId, ...record });
        log(`[INFO] scenarios: ${runId}: ${record.diagnosis}${record.item ? `, bench item ${record.item}` : ''}`);
      }
    }
    const next = nextDueAt(current, own);
    if (next === null || next - now() > waitMinutes * MINUTE) break;
    await sleep(Math.max(0, next - now()));
  }
  current = pruneRuns(current);
  save(current);
  const next = nextDueAt(current, own);
  return { ok: true, battery, started: begun.started, ran, harvested, summary: summarize(current, scenarios), nextDueAt: next === null ? null : iso(next) };
}
