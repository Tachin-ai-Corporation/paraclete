// agent/work/responsibility-store.mjs: the one place that decides what the agent's responsibilities
// are. Two layers, each with one writer:
//
//   installed defaults  the responsibilities.json of the generic role and of the instance's role,
//                       installed with a release. The caller reads the files and passes them in as
//                       parsed data. A default marked `locked` is upkeep nothing may override.
//   the agent's own     documents in the root `responsibilities` collection: overrides of an
//                       installed default and responsibilities the agent created. Written by the
//                       agent's responsibility command and by the dashboard.
//
// Why the agent's layer lives in Firestore and not in an installed file: writers that edited the
// installed file in place lost every change at the next upgrade, which reinstalled the file. The
// store survives upgrades and VM rebuilds, and the scheduler re-reads it every refresh, so a change
// is live without a release.
//
// It does not run anything (scheduler.mjs fires responsibilities) and does not define the record
// shape (responsibility-schema.mjs). The scheduler (what runs), the control service (what the
// dashboard shows and toggles) and the responsibility command (what an author writes) all merge and
// validate through it, so the three can never disagree. Everything here is pure except readStore().

import { COLLECTIONS } from '../storage/collections.mjs';
import { RESPONSIBILITY_SCHEMA } from './responsibility-schema.mjs';
import { validate } from './validate-schema.mjs';

/** The root collection holding the agent's own responsibility records, one document per id. */
export const STORE_COLLECTION = COLLECTIONS.responsibilities;

/** How many store records one read returns. Far above max_own plus one override per default. */
const STORE_READ_LIMIT = 200;

/** Defaults for the contracts' responsibility_store section. */
export const DEFAULT_POLICY = Object.freeze({
  refresh_ms: 60_000, // default; callers pass the contracts value
  min_interval_minutes: 15, // default; callers pass the contracts value
  max_own: 25, // default; callers pass the contracts value
});

/**
 * The store policy from a contracts object, with a default for every missing or invalid value.
 *
 * @param {object} contracts - the parsed contracts; only `responsibility_store` is read
 * @returns {{refresh_ms: number, min_interval_minutes: number, max_own: number}}
 */
export function resolvePolicy(contracts) {
  const p = contracts?.responsibility_store || {};
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return {
    refresh_ms: num(p.refresh_ms, DEFAULT_POLICY.refresh_ms),
    min_interval_minutes: num(p.min_interval_minutes, DEFAULT_POLICY.min_interval_minutes),
    max_own: num(p.max_own, DEFAULT_POLICY.max_own),
  };
}

/**
 * Reads the agent's own store. Strict: an unreachable store throws, so the scheduler keeps the last
 * set it read instead of reading an outage as "the agent has no responsibilities of its own".
 *
 * @param {{query: Function}} db - a client from agent/storage/firestore.mjs
 * @returns {Promise<object[]>} the store documents, each with its document id as `id`
 */
export async function readStore(db, { limit = STORE_READ_LIMIT } = {}) {
  return db.query('', STORE_COLLECTION, [], { noOrderBy: true, strict: true, limit });
}

// ---- Installed defaults --------------------------------------------------------

/**
 * The installed defaults as one list: the packages in the order given (the generic role first, then
 * the instance's role), first id seen wins, so the base stays authoritative. Each record is tagged
 * with its package in `_source`, an underscore field, so it is never validated or mistaken for part
 * of the record.
 *
 * @param {Array<{source: string, responsibilities: object[]}>} packages - parsed responsibilities.json
 *   of each installed role package
 * @returns {object[]}
 */
export function collectDefaults(packages) {
  const merged = [];
  const seen = new Set();
  for (const pkg of Array.isArray(packages) ? packages : []) {
    for (const r of Array.isArray(pkg?.responsibilities) ? pkg.responsibilities : []) {
      if (!r || !r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push({ ...r, _source: pkg.source || 'installed' });
    }
  }
  return merged;
}

// ---- Validation ----------------------------------------------------------------

// Several installed responsibilities nest success_criteria under context, and the scheduler reads
// either, so the body accepts both and the check below insists on one of them.
const BODY_PROPS = Object.fromEntries(
  Object.entries(RESPONSIBILITY_SCHEMA.spec.properties)
    .map(([k, spec]) => [k, k === 'success_criteria' ? { ...spec, required: false } : spec]),
);

/** The schema a stored body is validated against: the responsibility, with success criteria in either place. */
export const RESPONSIBILITY_BODY_SCHEMA = {
  id: 'responsibility-body',
  version: RESPONSIBILITY_SCHEMA.version,
  spec: {
    type: 'object',
    properties: BODY_PROPS,
    check: (r) => RESPONSIBILITY_SCHEMA.spec.check(r)
      || ((r.success_criteria || r.context?.success_criteria)
        ? null
        : 'success_criteria is required: how the agent knows a firing succeeded'),
  },
};

const CRON_FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 6]];

function checkCronField(expr, lo, hi) {
  if (expr === '*') return null;
  const step = /^\*\/(\d+)$/.exec(expr);
  if (step) return (+step[1] >= 1 && +step[1] <= hi) ? null : `a step must be 1-${hi}`;
  for (const part of expr.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    // The scheduler's matcher understands exactly these forms. Anything else (a name such as MON, a
    // stepped range such as 1-5/2, 7 for Sunday) would parse, never match, and leave a
    // responsibility that silently never fires.
    if (!m) return 'use *, */N, a number, a range (a-b) or a list (a,b); the scheduler reads nothing else';
    const a = +m[1];
    const b = m[2] === undefined ? a : +m[2];
    if (a < lo || b > hi || a > b) return `values must lie in ${lo}-${hi}`;
  }
  return null;
}

/**
 * @param {string} expression
 * @returns {string|null} null when the scheduler can read `expression`, else what is wrong with it
 */
export function checkCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return 'must be a five-field cron expression (minute hour day-of-month month day-of-week)';
  for (let i = 0; i < 5; i += 1) {
    const [label, lo, hi] = CRON_FIELDS[i];
    const err = checkCronField(parts[i], lo, hi);
    if (err) return `${label} '${parts[i]}': ${err}`;
  }
  return null;
}

/**
 * The floor between two fires of one schedule, so a responsibility the agent writes for itself
 * cannot become a loop that runs a mission every minute. Measured on the schedule's first few fires
 * from a fixed Monday, in UTC: frequency does not depend on the zone, and a fixed start keeps the
 * verdict deterministic. `nextFire` is the scheduler's cronNextFire, passed in so this module never
 * imports the scheduler.
 *
 * @param {string} expression
 * @param {number} minMinutes
 * @param {Function|null} nextFire - (expression, timeZone, from) => Date|null
 * @returns {string|null} what is wrong, or null
 */
export function checkFrequency(expression, minMinutes, nextFire) {
  if (!minMinutes || !nextFire) return null;
  let prev = nextFire(expression, 'UTC', new Date('2026-01-05T00:00:00Z'));
  for (let i = 0; i < 6 && prev; i += 1) {
    const next = nextFire(expression, 'UTC', prev);
    if (!next) break;
    const gap = Math.round((next.getTime() - prev.getTime()) / 60_000);
    if (gap < minMinutes) {
      return `fires ${gap} minute(s) apart; the floor between two fires is ${minMinutes} minutes`;
    }
    prev = next;
  }
  return null;
}

function isKnownZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function scheduleErrors(record, { policy, nextFire }) {
  const errors = [];
  if (typeof record.schedule === 'string' && record.schedule.trim()) {
    const cron = checkCron(record.schedule);
    if (cron) errors.push(`schedule: ${cron}`);
    else {
      const freq = checkFrequency(record.schedule, policy?.min_interval_minutes, nextFire);
      if (freq) errors.push(`schedule: ${freq}`);
    }
  }
  if (typeof record.timezone === 'string' && !isKnownZone(record.timezone)) {
    errors.push(`timezone: '${record.timezone}' is not an IANA zone (e.g. America/Chicago)`);
  }
  return errors;
}

/**
 * @param {object} record
 * @param {{policy?: object, nextFire?: Function|null}} [opts]
 * @returns {string[]} every reason `record` cannot run as a responsibility; [] when it can
 */
export function validateBody(record, { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const errors = validate(RESPONSIBILITY_BODY_SCHEMA, record).errors
    .map((e) => `${e.path || '(root)'}: ${e.message}`);
  if (record && typeof record === 'object') errors.push(...scheduleErrors(record, { policy, nextFire }));
  return errors;
}

/**
 * Validates the fields a patch sets, without the installed record it will apply to.
 *
 * @returns {string[]}
 */
export function validatePatch(patch, { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const props = {};
  for (const k of Object.keys(patch || {})) {
    if (BODY_PROPS[k]) props[k] = { ...BODY_PROPS[k], required: false };
  }
  const errors = validate({ id: 'responsibility-patch', version: 1, spec: { type: 'object', properties: props } }, patch)
    .errors.map((e) => `${e.path || '(root)'}: ${e.message}`);
  errors.push(...scheduleErrors(patch || {}, { policy, nextFire }));
  return errors;
}

/**
 * Validates an override: the fields it sets, plus the rules that span fields (a schedule or an
 * event, never both; success criteria somewhere) on the result. The installed fields it leaves alone
 * are product content and are not judged again, so a template's placeholder value can never stop
 * the agent turning a default off.
 *
 * @returns {string[]}
 */
export function validateOverride(installed, patch, { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const floor = patch?.schedule && patch.schedule !== installed?.schedule ? nextFire : null;
  const errors = validatePatch(patch, { policy, nextFire: floor });
  const cross = RESPONSIBILITY_BODY_SCHEMA.spec.check(applyPatch(installed, patch));
  if (cross) errors.push(cross);
  return errors;
}

// ---- Layering --------------------------------------------------------------------

/**
 * A record with an override applied. Top-level fields replace; `context` merges key by key, so an
 * override that rewrites the process steps leaves the purpose and learnings alone. Fields the
 * override does not name keep flowing from the default, so a later product fix still reaches an
 * agent that changed only its schedule. A patch never renames the record.
 *
 * @param {object} base
 * @param {object} [patch]
 * @returns {object}
 */
export function applyPatch(base, patch = {}) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'id') continue;
    if (k === 'context' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.context = { ...(out.context || {}), ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function withoutScratch(r) {
  const out = {};
  for (const [k, v] of Object.entries(r || {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

// The frequency floor governs schedules an author writes. An installed schedule is product content
// with its own review; an override that only flips `enabled` must not be refused because the
// default it sits on is frequent.
function floorOpts(opts, schedule, installedSchedule) {
  return schedule && schedule !== installedSchedule ? opts : { ...opts, nextFire: null };
}

/**
 * The responsibilities the agent actually runs: the installed defaults with its own store applied.
 * Store records that are locked out, invalid or orphaned are reported in `issues` and skipped, and
 * the default keeps running, so a bad write can never take a responsibility away or crash the
 * scheduler.
 *
 * Each result carries `_provenance` {origin: default|override|agent, source, revision, updated_by,
 * updated_at}.
 *
 * @param {object[]} defaults - from collectDefaults()
 * @param {object[]} docs     - the agent's store documents
 * @param {{policy?: object, nextFire?: Function|null}} [opts]
 * @returns {{effective: object[], issues: Array<{id: string, reason: string}>}}
 */
export function mergeResponsibilities(defaults, docs = [], { policy = DEFAULT_POLICY, nextFire = null } = {}) {
  const issues = [];
  const byId = new Map();
  for (const d of docs || []) {
    if (!d || typeof d.id !== 'string' || d.status === 'removed') continue;
    if (d.mode !== 'own' && d.mode !== 'override') {
      issues.push({ id: d.id, reason: `store record has unknown mode '${d.mode}'; ignored` });
      continue;
    }
    byId.set(d.id, d);
  }
  const stamp = (d) => ({ revision: d.revision ?? null, updated_by: d.updated_by ?? null, updated_at: d.updated_at ?? null });

  const effective = [];
  const defaultIds = new Set();
  for (const r of defaults || []) {
    defaultIds.add(r.id);
    const source = r._source || 'installed';
    const fallback = { ...r, _provenance: { origin: 'default', source } };
    const doc = byId.get(r.id);
    if (!doc) { effective.push(fallback); continue; }
    if (r.locked) {
      issues.push({ id: r.id, reason: `locked installed responsibility: the ${doc.mode} (rev ${doc.revision}, by ${doc.updated_by}) is ignored` });
      effective.push(fallback);
      continue;
    }
    const candidate = doc.mode === 'own' ? { ...(doc.body || {}), id: r.id } : applyPatch(r, doc.patch || {});
    const errors = doc.mode === 'own'
      ? validateBody(candidate, floorOpts({ policy, nextFire }, candidate.schedule, r.schedule))
      : validateOverride(r, doc.patch || {}, { policy, nextFire });
    if (errors.length) {
      issues.push({ id: r.id, reason: `${doc.mode} rev ${doc.revision} is invalid, running the installed default: ${errors.join('; ')}` });
      effective.push(fallback);
      continue;
    }
    effective.push({
      ...withoutScratch(candidate),
      _provenance: doc.mode === 'own'
        ? { origin: 'agent', source, shadows: source, ...stamp(doc) }
        : { origin: 'override', source, ...stamp(doc) },
    });
  }

  for (const doc of byId.values()) {
    if (defaultIds.has(doc.id)) continue;
    if (doc.mode === 'override') {
      issues.push({ id: doc.id, reason: `override rev ${doc.revision} has no installed default to apply to; ignored` });
      continue;
    }
    const candidate = { ...(doc.body || {}), id: doc.id };
    const errors = validateBody(candidate, { policy, nextFire });
    if (errors.length) {
      issues.push({ id: doc.id, reason: `rev ${doc.revision} is invalid; not scheduled: ${errors.join('; ')}` });
      continue;
    }
    effective.push({ ...withoutScratch(candidate), _provenance: { origin: 'agent', source: 'store', ...stamp(doc) } });
  }
  return { effective, issues };
}

/**
 * @param {object} r - an effective responsibility
 * @returns {string} one line saying where its current definition comes from
 */
export function describeProvenance(r) {
  const p = r?._provenance || {};
  const by = p.revision != null ? ` (rev ${p.revision}, by ${p.updated_by || 'unknown'})` : '';
  if (p.origin === 'override') return `${p.source} + override${by}`;
  if (p.origin === 'agent') return p.shadows ? `agent-owned, adopted from ${p.shadows}${by}` : `agent-owned${by}`;
  return `${p.source || r?._source || 'installed'}${r?.locked ? ' (locked)' : ''}`;
}

/**
 * A cheap change detector for a set of store documents.
 *
 * @param {object[]} docs
 * @returns {string}
 */
export function storeSignature(docs = []) {
  return docs.map((d) => `${d.id}@${d.revision}:${d.status}`).sort().join('|');
}

// ---- Authoring -------------------------------------------------------------------

const fail = (error) => ({ ok: false, error });
const isActive = (d) => Boolean(d) && d.status !== 'removed';

/**
 * Decides the store document one authoring step produces. No I/O, so every rule is testable and the
 * responsibility command and the dashboard get the same answer.
 *
 * @param {object} a
 * @param {'create'|'update'|'remove'|'reset'|'adopt'|'revert'} a.verb
 * @param {string}  a.id
 * @param {object}  [a.input]       - the fields the author supplied
 * @param {object}  [a.current]     - the store document now (null if none)
 * @param {object}  [a.installed]   - the installed default with this id (null if none)
 * @param {object}  [a.revisionDoc] - for revert: the revision to restore
 * @param {number}  [a.ownCount=0]  - the agent's active own records (for max_own)
 * @param {string}  a.actor         - who is writing: 'agent', or the dashboard user's email
 * @param {string}  [a.note]
 * @param {string}  [a.now]         - ISO timestamp stamped as updated_at
 * @param {object}  [a.policy]
 * @param {Function|null} [a.nextFire] - the scheduler's cronNextFire, for the frequency floor
 * @returns {{ok: true, doc: object, summary: string} | {ok: false, error: string}}
 */
export function planWrite({
  verb, id, input = {}, current = null, installed = null,
  revisionDoc = null, ownCount = 0, actor, note = '', now = new Date().toISOString(),
  policy = DEFAULT_POLICY, nextFire = null,
}) {
  if (!id || typeof id !== 'string') return fail('an id is required');
  if (input && Object.prototype.hasOwnProperty.call(input, 'locked')) {
    return fail('`locked` is reserved for installed upkeep; it changes only with a release');
  }
  if (input?.id && input.id !== id) return fail(`the body's id '${input.id}' does not match '${id}'`);
  if (installed?.locked && verb !== 'create') {
    return fail(`'${id}' is installed upkeep (locked); it changes only with a release`);
  }

  const opts = { policy, nextFire };
  const base = {
    id,
    revision: (current?.revision || 0) + 1,
    status: 'active',
    updated_at: now,
    updated_by: actor || 'unknown',
    ...(note ? { note } : {}),
  };
  const invalid = (errors) => fail(`not a valid responsibility:\n  - ${errors.join('\n  - ')}`);
  const overLimit = () => ownCount >= policy.max_own
    ? fail(`the agent already owns ${ownCount} responsibilities (the limit is ${policy.max_own}); remove one first`)
    : null;

  switch (verb) {
    case 'create': {
      if (installed) return fail(`'${id}' is an installed default; use update to change it, or adopt to take it over`);
      if (isActive(current)) return fail(`'${id}' already exists; use update`);
      const limit = overLimit();
      if (limit) return limit;
      const body = { enabled: true, min_spacing_minutes: 30, ...input, id };
      const errors = validateBody(body, opts);
      if (!body.context?.purpose) errors.push('context.purpose: is required; say why this responsibility exists');
      if (!Array.isArray(body.context?.process) || body.context.process.length === 0) {
        errors.push('context.process: is required; the steps a firing follows');
      }
      if (errors.length) return invalid(errors);
      return { ok: true, doc: { ...base, mode: 'own', body }, summary: `created '${id}'` };
    }

    case 'update': {
      if (!input || Object.keys(input).length === 0) return fail('nothing to update');
      if (current?.mode === 'own' && isActive(current)) {
        const body = applyPatch(current.body, input);
        const errors = validateBody(body, opts);
        if (errors.length) return invalid(errors);
        const kept = current.adopted_from ? { adopted_from: current.adopted_from } : {};
        return { ok: true, doc: { ...base, mode: 'own', body, ...kept }, summary: `updated '${id}'` };
      }
      if (installed || current?.mode === 'override') {
        const prior = current?.mode === 'override' && isActive(current) ? current.patch : {};
        const patch = applyPatch(prior, input);
        delete patch.id;
        const errors = installed ? validateOverride(installed, patch, opts) : validatePatch(patch, opts);
        if (errors.length) return invalid(errors);
        return { ok: true, doc: { ...base, mode: 'override', patch }, summary: `overrode ${Object.keys(input).join(', ')} on '${id}'` };
      }
      return fail(`'${id}' is not one of the agent's responsibilities; create it first`);
    }

    case 'remove': {
      if (current?.mode === 'own' && isActive(current)) {
        const kept = current.adopted_from ? { adopted_from: current.adopted_from } : {};
        return { ok: true, doc: { ...base, mode: 'own', body: current.body, status: 'removed', ...kept }, summary: `removed '${id}'` };
      }
      if (installed || current?.mode === 'override') {
        return fail(`'${id}' is an installed default; turn it off with enabled: false, or drop your changes with reset`);
      }
      return fail(`'${id}' is not one of the agent's own responsibilities`);
    }

    case 'reset': {
      if (current?.mode === 'override' && isActive(current)) {
        return { ok: true, doc: { ...base, mode: 'override', patch: current.patch, status: 'removed' }, summary: `'${id}' is back to its installed default` };
      }
      if (current?.mode === 'own' && isActive(current) && current.adopted_from) {
        // Once the default is no longer installed, "back to the default" would silently delete it.
        if (!installed) {
          return fail(`'${id}' is no longer an installed default; it is only the agent's own now; use remove to delete it`);
        }
        return { ok: true, doc: { ...base, mode: 'own', body: current.body, status: 'removed', adopted_from: current.adopted_from }, summary: `'${id}' is back to its installed default` };
      }
      return fail(`'${id}' has no changes to reset`);
    }

    case 'adopt': {
      if (!installed) return fail(`'${id}' is not an installed default`);
      if (current?.mode === 'own' && isActive(current)) return fail(`'${id}' is already the agent's own`);
      const limit = overLimit();
      if (limit) return limit;
      const prior = current?.mode === 'override' && isActive(current) ? current.patch : {};
      const body = { ...applyPatch(withoutScratch(applyPatch(installed, prior)), input), id };
      const errors = validateBody(body, floorOpts(opts, body.schedule, installed.schedule));
      if (errors.length) return invalid(errors);
      const from = installed._source || 'installed';
      return {
        ok: true,
        doc: { ...base, mode: 'own', body, adopted_from: from },
        summary: `'${id}' is now the agent's own (adopted from ${from})`,
      };
    }

    case 'revert': {
      if (!current) return fail(`'${id}' has no history`);
      if (!revisionDoc) return fail('no such revision');
      const restored = {
        ...base,
        mode: revisionDoc.mode,
        status: revisionDoc.status || 'active',
        reverted_from: revisionDoc.revision,
        ...(revisionDoc.mode === 'own' ? { body: revisionDoc.body } : { patch: revisionDoc.patch }),
        ...(revisionDoc.adopted_from ? { adopted_from: revisionDoc.adopted_from } : {}),
      };
      if (restored.status === 'active') {
        let errors;
        if (restored.mode === 'own') {
          const record = { ...(restored.body || {}), id };
          errors = validateBody(record, floorOpts(opts, record.schedule, installed?.schedule));
        } else {
          errors = installed ? validateOverride(installed, restored.patch || {}, opts) : validatePatch(restored.patch || {}, opts);
        }
        if (errors.length) return invalid(errors);
      }
      return { ok: true, doc: restored, summary: `'${id}' restored to revision ${revisionDoc.revision}` };
    }

    default:
      return fail(`unknown verb '${verb}'`);
  }
}
