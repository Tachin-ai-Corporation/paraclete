// agent/services/control/responsibilities.mjs: the dashboard's view of the agent's responsibilities,
// its on/off switch for one, and its "run now". The view runs the same merge the scheduler runs
// (agent/work/responsibility-store.mjs), so the dashboard shows what actually fires, the agent's own
// changes included. A switch is a revision in the store, never an edit of an installed file: an
// installed file is replaced by the next upgrade, which silently reverted every such edit. "Run now"
// writes a trigger document the brain's scheduler claims and fires; the scheduler itself lives in the
// brain service. Called by commands.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectDefaults, readStore, mergeResponsibilities, resolvePolicy, describeProvenance, planWrite,
} from '../../work/responsibility-store.mjs';
import { cronNextFire } from '../../work/scheduler.mjs';
import { ID_PATTERN } from '../../work/work-ids.mjs';
import { StoreConflict } from '../../storage/firestore.mjs';

/**
 * The installed role packages' responsibilities, generic first, as collectDefaults() takes them. A
 * role without a responsibilities.json has none; an unreadable one is logged and skipped, so one bad
 * file never hides the rest.
 *
 * @param {object}   o
 * @param {object}   o.paths     the service runtime's paths
 * @param {object}   o.instance
 * @param {Function} [o.readText] (path) => string; throws when missing
 * @param {Function} [o.log]
 * @returns {Array<{source: string, responsibilities: object[]}>}
 */
export function rolePackages({ paths, instance, readText = (p) => readFileSync(p, 'utf8'), log = () => {} }) {
  const roles = [['generic', paths.genericRole]];
  if (instance.role !== 'generic') roles.push([instance.role, paths.role]);
  const packages = [];
  for (const [source, dir] of roles) {
    const file = join(dir, 'responsibilities.json');
    let text;
    try {
      text = readText(file);
    } catch (err) {
      if (err.code !== 'ENOENT') log('WARN', `cannot read ${file}: ${err.message}`);
      continue;
    }
    try {
      const data = JSON.parse(text);
      packages.push({ source, responsibilities: Array.isArray(data) ? data : (data.responsibilities || []) });
    } catch (err) {
      log('WARN', `${file} is not valid JSON; its responsibilities are left out: ${err.message}`);
    }
  }
  return packages;
}

/**
 * Every responsibility the agent runs, with where each definition comes from. An unreadable store
 * shows the installed defaults alone and says so in `store_error`.
 *
 * @param {object}   o
 * @param {object}   o.db
 * @param {object}   o.contracts
 * @param {object}   o.paths
 * @param {object}   o.instance
 * @param {Function} [o.readText]
 * @param {Function} [o.log]
 * @param {Function} [o.now] () => Date
 * @returns {Promise<{responsibilities: object[], issues: Array<{id: string, reason: string}>, store_error: string|null}>}
 */
export async function listResponsibilities({ db, contracts, paths, instance, readText, log = () => {}, now = () => new Date() }) {
  const { effective, issues, storeError } = await effectiveResponsibilities({ db, contracts, paths, instance, readText, log });
  const at = now();
  return { responsibilities: effective.map((r) => summarize(r, at)), issues, store_error: storeError };
}

/**
 * Turns one responsibility on or off by writing the next revision of its store record, and that
 * revision's copy, in one atomic commit that fails if the record changed since it was read. Locked
 * upkeep refuses.
 *
 * @param {object} o
 * @param {*}      o.id
 * @param {*}      o.enabled
 * @param {string} [o.actor] who asked
 * @returns {Promise<{id: string, enabled: boolean, revision: number, message: string}>}
 */
export async function setResponsibilityEnabled({
  id, enabled, actor, db, collections, subcollections, contracts, paths, instance, readText, log = () => {},
  nowIso = () => new Date().toISOString(),
}) {
  checkId(id);
  if (typeof enabled !== 'boolean') throw new Error('params.enabled must be true or false');
  const defaults = collectDefaults(rolePackages({ paths, instance, readText, log }));
  const path = `${collections.responsibilities}/${id}`;
  const current = await db.readDoc(path);
  const plan = planWrite({
    verb: 'update',
    id,
    input: { enabled },
    current: current?.data || null,
    installed: defaults.find((r) => r.id === id) || null,
    actor: actor || 'dashboard',
    now: nowIso(),
    policy: resolvePolicy(contracts),
    nextFire: cronNextFire,
  });
  if (!plan.ok) throw new Error(plan.error);
  try {
    await db.commit([
      { path, data: plan.doc, precondition: current ? { updateTime: current.updateTime } : { exists: false } },
      { path: `${path}/${subcollections.responsibilityRevisions}/${plan.doc.revision}`, data: plan.doc, precondition: { exists: false } },
    ]);
  } catch (err) {
    if (err instanceof StoreConflict) throw new Error(`'${id}' changed while it was being switched; nothing was written, try again`);
    throw err;
  }
  log('INFO', `responsibility ${id} enabled=${enabled} (revision ${plan.doc.revision})`);
  return {
    id,
    enabled,
    revision: plan.doc.revision,
    message: `'${id}' is ${enabled ? 'on' : 'off'} (revision ${plan.doc.revision}). The scheduler picks it up within `
      + `${Math.round(resolvePolicy(contracts).refresh_ms / 1000)} seconds, and it survives upgrades.`,
  };
}

/**
 * Asks the brain's scheduler to run one responsibility now. Writes a trigger document whose id is
 * the command's own, created only if absent, so one command can never queue two runs. The scheduler
 * skips the spacing floor for it (running out of turn is the point) but never the one-at-a-time guard.
 *
 * @param {object} o
 * @param {*}      o.id
 * @param {string} o.commandId
 * @param {string} [o.actor]
 * @returns {Promise<{id: string, name: string, trigger_id: string, message: string}>}
 */
export async function runResponsibility({
  id, commandId, actor, db, collections, contracts, paths, instance, readText, log = () => {},
  nowIso = () => new Date().toISOString(),
}) {
  checkId(id);
  const { effective } = await effectiveResponsibilities({ db, contracts, paths, instance, readText, log });
  const known = effective.find((r) => r.id === id);
  if (!known) throw new Error(`responsibility '${id}' not found`);
  const trigger = {
    responsibility_id: id,
    status: 'pending',
    bypass_spacing: true,
    requested_by: actor || 'dashboard',
    requested_at: nowIso(),
    command_id: commandId,
  };
  try {
    await db.commit([{ path: `${collections.responsibilityTriggers}/${commandId}`, data: trigger, precondition: { exists: false } }]);
  } catch (err) {
    if (err instanceof StoreConflict) throw new Error(`a run of '${id}' was already queued by this command`);
    throw err;
  }
  log('INFO', `queued an on-demand run of ${id}`, { trigger: commandId });
  const name = known.name || id;
  return { id, name, trigger_id: commandId, message: `'${name}' is queued; the brain starts it within a few seconds.` };
}

async function effectiveResponsibilities({ db, contracts, paths, instance, readText, log }) {
  const defaults = collectDefaults(rolePackages({ paths, instance, readText, log }));
  let docs = [];
  let storeError = null;
  try {
    docs = await readStore(db);
  } catch (err) {
    storeError = err.message;
    log('WARN', `the responsibility store is unreadable; showing installed defaults only: ${err.message}`);
  }
  const { effective, issues } = mergeResponsibilities(defaults, docs, { policy: resolvePolicy(contracts), nextFire: cronNextFire });
  for (const issue of issues) log('WARN', `responsibility store record ignored: ${issue.id}: ${issue.reason}`);
  return { effective, issues, storeError };
}

function summarize(r, at) {
  const steps = Array.isArray(r.context?.process) ? r.context.process : [];
  return {
    id: r.id || 'unknown',
    name: r.name || r.id || 'Unnamed',
    schedule: r.schedule || (r.event ? `on ${r.event}` : ''),
    timezone: r.timezone || 'UTC',
    enabled: r.enabled !== false,
    next_fire: r.enabled !== false && r.schedule ? nextFire(r.schedule, r.timezone || 'UTC', at) : null,
    min_spacing_minutes: r.min_spacing_minutes || 0,
    instruction: r.instruction || '',
    has_process: steps.length > 0 || Boolean(r.processRef),
    process_steps: steps.length,
    steps,
    triggerable: r.triggerable === true,
    locked: r.locked === true,
    source: describeProvenance(r),
    origin: r._provenance?.origin || 'default',
    revision: r._provenance?.revision ?? null,
    updated_by: r._provenance?.updated_by ?? null,
  };
}

function nextFire(schedule, timeZone, at) {
  try {
    return cronNextFire(schedule, timeZone, at)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`params.id must be a responsibility id (lowercase letters, digits and dashes), got ${JSON.stringify(id)}`);
  }
}
