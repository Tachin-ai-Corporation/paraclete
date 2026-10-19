// agent/work/scheduler.mjs: fires the agent's responsibilities. Cron responsibilities fire when their
// next slot arrives, matched in the responsibility's own IANA `timezone` (default UTC); event
// responsibilities fire from fireEvent (on_complete and on_failure, which the brain raises when a
// mission ends; on_deploy is accepted but nothing raises it); and fireById runs one on
// demand. Each firing creates a responsibility (R) envelope and its mission (M) and hands the mission
// to the brain. What the responsibilities are is decided by responsibility-store.mjs: the installed
// defaults with the agent's own store applied, re-read every refresh so a change is live without a
// restart. Used by the brain. cronNextFire() and its helpers are exported as pure functions.

import { COLLECTIONS } from '../storage/collections.mjs';
import {
  collectDefaults, mergeResponsibilities, storeSignature, describeProvenance, DEFAULT_POLICY,
} from './responsibility-store.mjs';

// A responsibility cycle "in progress", for the singleton guard, is a mission that is executing or
// about to. Everything else, terminal or not (archived, timed_out, blocked, ...), does not block. An
// in-progress allowlist rather than a terminal denylist is fail-safe: an unrecognized status never
// wedges the guard. A denylist once missed `archived`, so a fresh fire was refused against history.
const RESP_IN_PROGRESS = ['active', 'queued', 'pending', 'waiting'];

// How far ahead cronNextFire looks for the next slot. It was 48 hours, shorter than a week, so every
// weekly responsibility re-armed to null after its first fire or skip and the tick loop skipped a
// null next-fire forever: a weekly responsibility fired once after a restart and then never again.
// Eight days covers weekly with a day of margin; a longer cadence (monthly) that starts outside the
// horizon is armed by the tick loop's re-arm as it comes into range.
const NEXT_FIRE_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

// How often the tick loop retries arming a null next-fire. Far below the horizon, so any slot is
// armed at least (horizon - interval) before it is due, while a cron that never matches (February
// 31st, the idiom for event-only) rescans at most hourly.
const REARM_INTERVAL_MS = 60 * 60 * 1000;

const TICK_INTERVAL_MS = 60_000;
const DEFAULT_MIN_SPACING_MINUTES = 15; // default; a responsibility sets its own min_spacing_minutes

/**
 * Whether a responsibility fires. `enabled` defaults to true (responsibility-schema.mjs), and a record
 * that leaves it out fires: from its clock, from an event, and when run now, the same everywhere.
 */
const isEnabled = (r) => r?.enabled !== false;
const STORE_WARN_INTERVAL_MS = 15 * 60_000;

// ---- Cron expression helpers (pure functions) ----

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const zoneFormatters = new Map(); // IANA zone -> Intl.DateTimeFormat (construction is the slow part)

/**
 * The wall-clock fields a cron expression is matched against, read in `timeZone`. UTC (the default)
 * uses the Date's UTC getters directly. Any other IANA zone goes through Intl, so a daylight-saving
 * change moves the UTC instant and leaves the declared local time where it was. An unknown zone
 * throws a RangeError rather than guessing.
 *
 * @param {Date} date
 * @param {string} [timeZone='UTC']
 * @returns {{min:number, hour:number, dom:number, mon:number, dow:number}} dow 0 = Sunday
 */
function wallClock(date, timeZone) {
  if (!timeZone || timeZone === 'UTC') {
    return {
      min: date.getUTCMinutes(), hour: date.getUTCHours(), dom: date.getUTCDate(),
      mon: date.getUTCMonth() + 1, dow: date.getUTCDay(),
    };
  }
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    zoneFormatters.set(timeZone, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return { min: +p.minute, hour: +p.hour, dom: +p.day, mon: +p.month, dow: WEEKDAY[p.weekday] };
}

/**
 * Whether a five-field cron expression (minute hour day-of-month month day-of-week) matches a Date,
 * read in `timeZone`.
 *
 * @param {string} expression
 * @param {Date} date
 * @param {string} [timeZone='UTC'] - IANA zone the expression is written in
 * @returns {boolean}
 */
export function cronMatch(expression, date, timeZone) {
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = expression.trim().split(/\s+/);
  const { min, hour, dom, mon, dow } = wallClock(date, timeZone);

  return fieldMatches(minExpr, min, 0, 59)
    && fieldMatches(hourExpr, hour, 0, 23)
    && fieldMatches(domExpr, dom, 1, 31)
    && fieldMatches(monExpr, mon, 1, 12)
    && fieldMatches(dowExpr, dow, 0, 6);
}

/**
 * Whether one cron field matches a value. Supports * (any), *\/N (step), lists (1,5,10) and
 * ranges (1-5). responsibility-store.mjs checkCron refuses every other form at write time.
 *
 * @param {string} expr
 * @param {number} value
 * @param {number} _rangeMin - unused, kept so call sites read as the field's range
 * @param {number} _rangeMax - unused, kept so call sites read as the field's range
 * @returns {boolean}
 */
export function fieldMatches(expr, value, _rangeMin, _rangeMax) {
  if (expr === '*') return true;
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10);
    return value % step === 0;
  }
  for (const part of expr.split(',')) {
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

/**
 * The next fire time of a cron expression, scanning forward minute by minute from the minute after
 * `from`, at most eight days ahead.
 *
 * @param {string} expression
 * @param {string} [timeZone='UTC'] - IANA zone the expression is written in
 * @param {Date} [from=new Date()]
 * @returns {Date|null} the next matching minute, or null if none within the horizon
 */
export function cronNextFire(expression, timeZone, from = new Date()) {
  const check = new Date(from);
  check.setUTCSeconds(0, 0);
  check.setUTCMinutes(check.getUTCMinutes() + 1);
  while (check.getTime() - from.getTime() < NEXT_FIRE_HORIZON_MS) {
    if (cronMatch(expression, check, timeZone)) return check;
    check.setUTCMinutes(check.getUTCMinutes() + 1);
  }
  return null; // none within the horizon: the tick loop re-arms (see REARM_INTERVAL_MS)
}

/**
 * The query that finds an in-progress cycle of one responsibility. It filters on the mission type
 * and the in-progress statuses in Firestore, not afterwards: every envelope a firing creates (the
 * R, the M, and each checkpoint and task) carries the responsibility id, and a query on the id alone
 * returns the oldest documents first, up to its limit. For a responsibility that has fired a few
 * hundred times, that page held only finished history, so the guard never saw the running cycle
 * and never blocked.
 *
 * @param {string} id - responsibility id
 * @returns {Array<{field: string, op: string, value: object}>}
 */
function inProgressCycleFilters(id) {
  return [
    { field: 'source_meta.responsibility_id', op: 'EQUAL', value: { stringValue: id } },
    { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
    { field: 'status', op: 'IN', value: { arrayValue: { values: RESP_IN_PROGRESS.map((s) => ({ stringValue: s })) } } },
  ];
}

/**
 * Creates the responsibility scheduler.
 *
 * @param {object}   deps
 * @param {Function} deps.processEnvelope     async (envelope, memory) => void; the brain's mission entry
 * @param {Function} deps.generateId          (prefix) => string
 * @param {Function} deps.writeHistory        async (envelopeId, prevStatus, newStatus, actor, detail) => void
 * @param {Function} deps.recallMemory        async (query, ctx) => memory
 * @param {Function} deps.firestoreWrite      async (collection, docId, data) => result
 * @param {Function} [deps.firestoreRead]     async (collection, docId) => data; reads the learnings overlay
 * @param {Function} [deps.firestoreQuery]    async (collection, filters, opts) => docs[]; the singleton guard
 * @param {Function} [deps.getProcess]        async (id) => playbook|null; resolves a responsibility's processRef
 * @param {Function} [deps.loadStore]         async () => docs[]; the agent's own store; throws when unreadable
 * @param {Array<{source: string, responsibilities: object[]}>} [deps.defaults] - installed defaults,
 *   parsed from the role packages (generic first)
 * @param {object}   [deps.policy]            resolved responsibility_store policy (refresh_ms, min_interval_minutes, max_own)
 * @param {Function} [deps.getDefaultProjectId] () => string|null
 * @param {Function} [deps.logger]            (level, msg) => void
 * @param {Function} [deps.clock]             () => ms; for on-demand and event spacing (injectable for tests)
 * @returns {object} the scheduler API
 */
export function createScheduler(deps) {
  const {
    processEnvelope,
    generateId,
    writeHistory,
    recallMemory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    getProcess,
    getDefaultProjectId = () => null,
    loadStore,
    defaults = [],
    policy = DEFAULT_POLICY,
    clock = Date.now,
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[scheduler] ${level}: ${msg}`));

  let responsibilities = [];
  const lastFired = {};        // id -> ms
  let nextFires = {};          // id -> Date, or null = no slot within the horizon yet
  const rearmAt = {};          // id -> ms of the last attempt to arm a null next-fire
  const badZoneWarned = new Set();
  let intervalId = null;

  let installed = [];          // the installed defaults, as collectDefaults() returned them
  let storeDocs = [];          // the agent's own store, as last read successfully
  let storeSig = '';
  let storeCheckedAt = -Infinity;
  let storeWarnedAt = -Infinity;
  const issuesLogged = new Set();
  let armed = false;           // start() has run; changes re-arm from then on
  const armedSig = {};         // id -> the schedule signature its current slot was armed for

  const iso = () => new Date(clock()).toISOString();

  /**
   * The zone a responsibility's schedule is written in. An unknown zone falls back to UTC loudly: it
   * must not throw inside the tick loop, and silently never firing is the failure this module keeps
   * finding.
   */
  function zoneFor(r) {
    const tz = r.timezone || 'UTC';
    if (tz === 'UTC') return tz;
    try {
      wallClock(new Date(0), tz); // validates the zone (and caches its formatter)
      return tz;
    } catch {
      if (!badZoneWarned.has(r.id)) {
        badZoneWarned.add(r.id);
        log('WARN', `Responsibility ${r.id}: unknown timezone '${tz}', scheduling it in UTC`);
      }
      return 'UTC';
    }
  }

  function nextFireFor(r, from = new Date(clock())) {
    return cronNextFire(r.schedule, zoneFor(r), from);
  }

  // ---- Loading ----

  /** What a responsibility's armed slot depends on; a change to any of it re-arms. */
  function armSignature(r) {
    return `${isEnabled(r)}|${r.schedule || ''}|${r.timezone || 'UTC'}`;
  }

  function armOne(r, at) {
    armedSig[r.id] = armSignature(r);
    if (isEnabled(r) && r.schedule) {
      nextFires[r.id] = nextFireFor(r, at);
      const nextStr = nextFires[r.id]
        ? nextFires[r.id].toISOString()
        : 'none within 8d (re-armed automatically as it comes into range)';
      log('INFO', `Responsibility ${r.id}: next fire ${nextStr} (${r.schedule} ${zoneFor(r)}), ${describeProvenance(r)}`);
    } else {
      delete nextFires[r.id];
    }
  }

  /**
   * Swaps in a new effective set. Before start() nothing is armed, so this only records it. After
   * start(), only the responsibilities whose schedule, zone or enabled flag changed are re-armed: a
   * full re-arm computes every next fire from "now", which silently drops any slot that came due in
   * the seconds before the next tick, and with a store refresh every minute that would be a real loss.
   */
  function applyEffective(next, at) {
    responsibilities = next;
    if (!armed) return;
    const ids = new Set(next.map((r) => r.id));
    for (const r of next) {
      if (armedSig[r.id] !== armSignature(r)) armOne(r, at);
    }
    for (const id of Object.keys(armedSig)) {
      if (ids.has(id)) continue;
      delete armedSig[id];
      delete nextFires[id];
      log('INFO', `Responsibility ${id}: no longer defined, unscheduled`);
    }
  }

  function recompute(at) {
    const { effective, issues } = mergeResponsibilities(installed, storeDocs, { policy, nextFire: cronNextFire });
    for (const issue of issues) {
      const key = `${issue.id}:${issue.reason}`;
      if (issuesLogged.has(key)) continue;
      issuesLogged.add(key);
      log('WARN', `Responsibility ${issue.id}: ${issue.reason}`);
    }
    applyEffective(effective, at);
  }

  /**
   * Takes in the installed defaults and re-applies the agent's store.
   *
   * @param {Array<{source: string, responsibilities: object[]}>} [packages=deps.defaults] - the parsed
   *   responsibilities of each installed role package, the generic role first. On an id collision
   *   the first package wins, so the base stays authoritative.
   * @returns {object[]} the effective responsibilities
   */
  function loadResponsibilities(packages = defaults) {
    installed = collectDefaults(packages);
    recompute(new Date(clock()));
    if (responsibilities.length > 0) {
      log('INFO', `Responsibilities loaded: ${responsibilities.map((r) => r.id).join(', ')}`);
    }
    return responsibilities;
  }

  /**
   * Re-reads the agent's own store and applies it if it changed. Throttled to policy.refresh_ms. An
   * unreadable store keeps the last good set: an outage must never read as "the agent has no
   * responsibilities of its own".
   *
   * @param {Date} [at=now]
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<boolean>} true when the effective set changed
   */
  async function refreshStore(at = new Date(clock()), { force = false } = {}) {
    if (!loadStore) return false;
    if (!force && at.getTime() - storeCheckedAt < policy.refresh_ms) return false;
    storeCheckedAt = at.getTime();
    let docs;
    try {
      docs = (await loadStore()) || [];
    } catch (e) {
      if (at.getTime() - storeWarnedAt > STORE_WARN_INTERVAL_MS) {
        storeWarnedAt = at.getTime();
        log('WARN', `Responsibility store unreadable (${e.message}); keeping the last good set (${storeDocs.length} record(s))`);
      }
      return false;
    }
    const sig = storeSignature(docs);
    if (sig === storeSig) return false;
    storeSig = sig;
    storeDocs = docs;
    log('INFO', `Responsibility store changed: ${docs.length} record(s): ${sig || 'none'}`);
    recompute(at);
    return true;
  }

  // ---- Firing ----

  /**
   * Whether a cycle of `id` is in progress. A failed check proceeds: refusing every fire during a
   * store outage would silently stop the agent's scheduled work.
   *
   * @returns {Promise<string|null>} the id of the in-progress mission, or null
   */
  async function inProgressCycle(id) {
    if (!firestoreQuery) return null;
    try {
      const found = await firestoreQuery(COLLECTIONS.work, inProgressCycleFilters(id), { noOrderBy: true, limit: 5 });
      const running = (found || []).find((e) => e.type === 'M' && RESP_IN_PROGRESS.includes(e.status));
      return running ? running.id : null;
    } catch (e) {
      log('WARN', `Responsibility ${id}: singleton check failed (${e.message}), proceeding`);
      return null;
    }
  }

  /**
   * Fires one responsibility: creates the R envelope and its M mission and runs the mission through
   * processEnvelope. A linked process playbook, if any, is recalled as planning context, never
   * executed as steps.
   *
   * @param {object} resp - an effective responsibility
   */
  async function fireResponsibility(resp) {
    const successCriteria = resp.success_criteria ?? resp.context?.success_criteria;
    const contextParts = [];
    if (resp.context?.purpose) contextParts.push(`PURPOSE: ${resp.context.purpose}`);
    if (resp.context?.process?.length) {
      contextParts.push(`PROCESS:\n${resp.context.process.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    }
    // processRef: the playbook this responsibility follows, resolved here, deterministically, and
    // carried as the mission's planning prior: a narrative the agent adapts, never steps. A missing
    // or retired playbook degrades to context.process alone, loudly.
    let playbookId = null;
    if (resp.processRef && getProcess) {
      let playbook = null;
      try { playbook = await getProcess(resp.processRef); } catch { playbook = null; }
      if (playbook?.narrative && playbook.status !== 'deprecated') {
        playbookId = resp.processRef;
        contextParts.push(`PLAYBOOK — ${playbook.name || playbookId} (${playbookId}): ${playbook.narrative}`);
      } else {
        log('WARN', `Responsibility ${resp.id}: processRef '${resp.processRef}' not found, retired, or without a narrative; firing on context.process alone`);
      }
    }
    if (resp.context?.reference_files?.length) {
      contextParts.push(`REFERENCE FILES: ${resp.context.reference_files.join(', ')}`);
    }
    // The top-level field first. Printing context.success_criteria unconditionally once wrote
    // "SUCCESS CRITERIA: undefined" for every responsibility that declared it where the schema puts it.
    if (successCriteria) contextParts.push(`SUCCESS CRITERIA: ${successCriteria}`);
    // Learnings: the authored context value first, then the dated lines the brain appends to the
    // responsibility_state overlay after each run. The overlay read is best-effort; a miss leaves the
    // authored value alone.
    let overlayLearnings = '';
    if (firestoreRead) {
      try {
        const overlay = await firestoreRead(COLLECTIONS.responsibilityState, resp.id);
        if (overlay?.prior_learnings) overlayLearnings = overlay.prior_learnings;
      } catch { /* the overlay is optional */ }
    }
    if (resp.context?.prior_learnings || overlayLearnings) {
      const merged = [resp.context?.prior_learnings, overlayLearnings].filter(Boolean).join('\n');
      contextParts.push(`PRIOR LEARNINGS: ${merged}`);
    }
    // A memory-scoped responsibility (the nightly consolidation) fires a mission that writes only the
    // memory layers. Stamped on source_meta, where the checkpoint executor enforces it
    // (memory-scope.mjs); stated here so the plan never has to discover the fence.
    const memoryScoped = resp.effect_scope === 'memory';
    if (memoryScoped) {
      contextParts.push('EFFECT SCOPE: memory — this mission writes only the agent\'s memory (working memory, '
        + 'Core Memory, Deep Truths), all of it by temporal-memory. Processes, projects, skills and '
        + 'responsibilities are read as context and never written.');
    }
    const scopeMeta = memoryScoped ? { effect_scope: 'memory' } : {};
    // The work records which definition produced it: an installed default, an override, or the
    // agent's own record, at which store revision.
    const prov = resp._provenance;
    if (prov) {
      scopeMeta.responsibility_origin = prov.origin;
      if (prov.revision != null) scopeMeta.responsibility_revision = prov.revision;
    }
    // Carried into the completion event so fireEvent can refuse to chain.
    if (resp._firedByEvent) scopeMeta.fired_by_event = resp._firedByEvent;
    const contextSummary = contextParts.join('\n\n');

    // The R envelope is a container, complete as soon as it exists.
    const respEnvId = generateId('w');
    const firedAt = iso();
    const respEnvelope = {
      id: respEnvId,
      type: 'R',
      parent_id: null,
      status: 'complete',
      intent: 'responsibility',
      title: resp.name || resp.id,
      instruction: resp.instruction,
      accept_criteria: successCriteria || null,
      context_summary: contextSummary,
      output: `Responsibility ${resp.id} fired at ${firedAt}`,
      children: [],
      context_forward: null,
      error: null,
      source_channel: 'scheduler',
      source_meta: {
        responsibility_id: resp.id,
        responsibility_name: resp.name,
        schedule: resp.schedule,
        ...scopeMeta,
      },
      created_at: firedAt,
      started_at: firedAt,
      completed_at: firedAt,
      updated_at: firedAt,
      iteration: 0,
    };

    await firestoreWrite(COLLECTIONS.work, respEnvId, respEnvelope);
    await writeHistory(respEnvId, null, 'complete', 'scheduler', `Responsibility ${resp.id} fired`);

    // The M mission enters the brain's normal mission loop.
    const missionId = generateId('w');
    const missionEnvelope = {
      id: missionId,
      type: 'M',
      parent_id: respEnvId,
      status: 'pending',
      intent: 'execute',
      title: `Execute: ${resp.name || resp.id}`,
      instruction: resp.instruction,
      accept_criteria: successCriteria || null,
      context_summary: contextSummary,
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: 'scheduler',
      source_meta: {
        responsibility_id: resp.id,
        responsibility_name: resp.name,
        fired_at: firedAt,
        ...scopeMeta,
        ...(playbookId ? { process_ref: playbookId } : {}),
      },
      // The playbook it followed, for the lesson the brain records after the mission.
      ...(playbookId ? { recalled_processes: [playbookId] } : {}),
      project_id: resp.project_id || getDefaultProjectId(),
      created_at: firedAt,
      started_at: null,
      completed_at: null,
      updated_at: firedAt,
      iteration: 0,
      memory_context: null, // filled in below, before the mission runs
    };

    respEnvelope.children.push(missionId);
    await firestoreWrite(COLLECTIONS.work, respEnvId, respEnvelope);

    await firestoreWrite(COLLECTIONS.work, missionId, missionEnvelope);
    await writeHistory(missionId, null, 'pending', 'scheduler', `Mission from responsibility ${resp.id}`);
    log('INFO', `Created R:${respEnvId} -> M:${missionId} for responsibility ${resp.id}`);

    const memory = await recallMemory(resp.instruction, {
      instruction: resp.instruction,
      context_summary: contextSummary.substring(0, 500),
    });
    missionEnvelope.memory_context = memory;
    await firestoreWrite(COLLECTIONS.work, missionId, missionEnvelope);

    await processEnvelope(missionEnvelope, memory);
  }

  /**
   * Fires a responsibility on demand, by id: the deliberate out-of-turn entry point (a person's "Run
   * now" in the dashboard, or the agent honoring a request). Same engine as the clock; only the
   * guards differ:
   *
   *   - Singleton is always enforced. Two concurrent cycles must never run: a second consolidation
   *     over the same memory would corrupt it.
   *   - min_spacing is honored unless opts.bypassSpacing (on-demand callers pass true: running out
   *     of turn is the point).
   *   - A disabled responsibility is refused unless opts.force.
   *
   * The mission starts detached and this returns at once, so neither the agent's decide loop nor the
   * dashboard waits the minutes a cycle takes. Callers find the running mission by
   * source_meta.responsibility_id.
   *
   * @param {string} id
   * @param {{bypassSpacing?: boolean, force?: boolean, source?: string}} [opts]
   * @returns {Promise<{ok: boolean, id?: string, name?: string, fired_at?: string, skipped?: boolean, error?: string}>}
   */
  async function fireById(id, opts = {}) {
    const { bypassSpacing = false, force = false, source = 'ondemand' } = opts;
    const resp = responsibilities.find((r) => r.id === id);
    if (!resp) return { ok: false, error: `responsibility '${id}' not found` };
    if (resp.enabled === false && !force) {
      return { ok: false, error: `responsibility '${id}' is disabled` };
    }

    if (resp.singleton) {
      const running = await inProgressCycle(id);
      if (running) {
        log('INFO', `fireById ${id}: singleton guard, cycle in progress (${running}), refusing`);
        return { ok: false, skipped: true, error: `a cycle is already in progress (${running})` };
      }
    }

    if (!bypassSpacing) {
      const minSpacingMs = (resp.min_spacing_minutes || DEFAULT_MIN_SPACING_MINUTES) * 60 * 1000;
      if (lastFired[id] && (clock() - lastFired[id]) < minSpacingMs) {
        return { ok: false, skipped: true, error: `min spacing (${resp.min_spacing_minutes}m) not elapsed` };
      }
    }

    lastFired[id] = clock();
    // Keep the cron cadence coherent: re-arm the next scheduled fire.
    if (isEnabled(resp) && resp.schedule) nextFires[id] = nextFireFor(resp);
    log('INFO', `[TELEMETRY] responsibility_triggered id=${id} source=${source} bypass_spacing=${bypassSpacing === true}`);

    fireResponsibility(resp).catch((e) => log('ERROR', `fireById ${id} fire failed: ${e.message}`));
    return { ok: true, id, name: resp.name || id, fired_at: iso() };
  }

  // ---- Start and stop ----

  /**
   * Arms every known responsibility and starts the one-minute tick. It arms even when nothing is
   * configured yet: the agent can create its first responsibility at runtime, and a scheduler that
   * returned early would never fire it.
   *
   * @param {Date} [at=now] - the instant next fires are computed from
   */
  function start(at = new Date(clock())) {
    armed = true;
    for (const r of responsibilities) armOne(r, at);
    if (responsibilities.length === 0) {
      log('INFO', 'No responsibilities yet; the scheduler keeps checking the agent\'s store');
    }
    // The store is read now, not a minute from now, so its responsibilities are armed as soon as
    // the brain is up.
    refreshStore(at, { force: true }).catch((e) => log('WARN', `Responsibility store refresh failed: ${e.message}`));

    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(() => {
      tick().catch((e) => log('ERROR', `Scheduler tick failed: ${e.message}`));
    }, TICK_INTERVAL_MS);
  }

  /**
   * One scheduler pass: fires every responsibility whose next slot has arrived. start() runs it
   * every minute; tests drive it directly with a fixed clock.
   *
   * @param {Date} [at=now]
   */
  async function tick(at = new Date(clock())) {
    await refreshStore(at);
    for (const r of responsibilities) {
      if (!isEnabled(r) || !r.schedule) continue;
      let nextFire = nextFires[r.id];
      if (!nextFire) {
        // null means "no slot within the horizon when last computed", not "never". Re-arm it,
        // throttled, so a cron that truly never matches does not rescan every minute.
        if (at.getTime() - (rearmAt[r.id] || 0) < REARM_INTERVAL_MS) continue;
        rearmAt[r.id] = at.getTime();
        nextFire = nextFires[r.id] = nextFireFor(r, at);
        if (!nextFire) continue;
      }
      if (at < nextFire) continue;

      const minSpacingMs = (r.min_spacing_minutes || DEFAULT_MIN_SPACING_MINUTES) * 60 * 1000;
      if (lastFired[r.id] && (at.getTime() - lastFired[r.id]) < minSpacingMs) {
        log('INFO', `Responsibility ${r.id} skipped (min spacing ${r.min_spacing_minutes}m)`);
        nextFires[r.id] = nextFireFor(r, at);
        continue;
      }

      if (r.singleton) {
        const running = await inProgressCycle(r.id);
        if (running) {
          log('INFO', `Responsibility ${r.id}: singleton guard, cycle in progress (${running}), sleeping`);
          nextFires[r.id] = nextFireFor(r, at);
          continue;
        }
      }

      log('INFO', `Responsibility ${r.id} firing: ${r.name}`);
      lastFired[r.id] = at.getTime();
      nextFires[r.id] = nextFireFor(r, at);

      try {
        await fireResponsibility(r);
      } catch (e) {
        log('ERROR', `Responsibility ${r.id} fire failed: ${e.message}`);
      }
    }
  }

  /** Stops the tick. */
  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  /**
   * Recomputes every next fire from `at`. loadResponsibilities() already re-arms exactly what
   * changed; this full recompute is for callers that want it, and it drops any slot that came due
   * since the last tick.
   */
  function recalcNextFires(at = new Date(clock())) {
    nextFires = {};
    for (const r of responsibilities) {
      armedSig[r.id] = armSignature(r);
      if (isEnabled(r) && r.schedule) nextFires[r.id] = nextFireFor(r, at);
    }
  }

  // ---- Event responsibilities ----

  /**
   * Fires the responsibilities whose `event` matches. Reads the effective set, the same one the
   * clock fires from, so an event responsibility from a role package or the agent's own store fires
   * too.
   *
   * @param {string} eventType - 'on_complete' or 'on_failure' ('on_deploy' is accepted; nothing raises it)
   * @param {object} [eventContext] - { mission_id, project_id, responsibility_id, fired_by_event }
   */
  async function fireEvent(eventType, eventContext = {}) {
    if (!eventType) return;

    const matching = responsibilities.filter((r) => isEnabled(r) && r.event && r.event === eventType);
    if (matching.length === 0) return;
    // No event chains. A mission an event responsibility produced never fires another event
    // responsibility, and no responsibility fires from its own mission: once the agent can write an
    // on_complete responsibility for itself, either would be a loop that runs a mission on every
    // completion, forever.
    if (eventContext.fired_by_event) {
      log('INFO', `Event '${eventType}' from an event-fired mission (${eventContext.mission_id || '?'}); not chaining`);
      return;
    }
    log('INFO', `Event '${eventType}' triggered: ${matching.length} matching responsibilities`);

    for (const resp of matching) {
      try {
        if (eventContext.responsibility_id === resp.id) continue;
        // Spacing, with the store's floor, so min_spacing_minutes: 0 cannot make a loop.
        const spacingMin = Math.max(resp.min_spacing_minutes || 0, policy.min_interval_minutes || 0);
        const t = clock();
        if (lastFired[resp.id] && (t - lastFired[resp.id]) < spacingMin * 60_000) {
          log('INFO', `Event resp ${resp.id}: skipping (${Math.round((t - lastFired[resp.id]) / 60_000)}m since last, min ${spacingMin}m)`);
          continue;
        }
        lastFired[resp.id] = t;

        let instruction = resp.instruction || '';
        if (eventContext.mission_id) {
          instruction += `\n\nTriggered by event: ${eventType} (mission: ${eventContext.mission_id})`;
        }
        if (eventContext.project_id) {
          instruction += `\nProject: ${eventContext.project_id}`;
        }

        await fireResponsibility({ ...resp, instruction, _firedByEvent: eventType });
        log('INFO', `Event resp ${resp.id} fired for '${eventType}'`);
      } catch (e) {
        log('WARN', `Failed to fire event resp ${resp.id}: ${e.message}`);
      }
    }
  }

  return {
    /** Take in the installed defaults and apply the agent's store. */
    loadResponsibilities,
    /** Arm everything and start the one-minute tick. */
    start,
    /** One scheduler pass at a given instant (the tick's body; tests drive it). */
    tick,
    /** Stop the tick. */
    stop,
    /** Fire the responsibilities that match an event. */
    fireEvent,
    /** Fire one responsibility on demand. */
    fireById,
    /** Recompute every next fire. */
    recalcNextFires,
    /** Re-read the agent's store now (throttled unless forced); true when the set changed. */
    refreshStore,
    /** The current effective responsibilities (installed defaults + the agent's store). */
    getResponsibilities: () => [...responsibilities],
    /** The next-fire map, for diagnostics. */
    getNextFires: () => ({ ...nextFires }),
  };
}
