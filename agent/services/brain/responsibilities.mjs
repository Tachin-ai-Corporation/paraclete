// agent/services/brain/responsibilities.mjs: the brain's responsibilities, the work it owns on a
// schedule or an event. Wires the scheduler (agent/work/scheduler.mjs) to the installed defaults (the
// generic role's responsibilities.json, then the instance role's, read by agent/work/role-packages.mjs)
// and the agent's own store, and hands each mission a firing creates to the runner's
// queue rather than running it in the scheduler's tick: the brain runs one mission at a time. Also
// claims the "run now" triggers the control service writes (responsibility_triggers/{id}) exactly once,
// fires them, and records the outcome.

import { COLLECTIONS } from '../../storage/collections.mjs';
import { firestoreEncode, StoreConflict } from '../../storage/firestore.mjs';
import { createScheduler } from '../../work/scheduler.mjs';
import { readStore, resolvePolicy } from '../../work/responsibility-store.mjs';

/** How many pending triggers one pass takes. */
const TRIGGER_PAGE = 20;

/**
 * Creates the brain's responsibilities.
 *
 * @param {object}   deps
 * @param {object}   deps.db         a client from agent/storage/firestore.mjs
 * @param {object}   deps.store      envelope-store.mjs
 * @param {object}   deps.contracts  for the store policy (responsibility_store)
 * @param {Array}    deps.defaults   from readInstalledResponsibilities() in agent/work/role-packages.mjs
 * @param {Function} deps.recall     (query, ctx) => memory; memory.mjs recall
 * @param {object}   [deps.processes] the process registry, for a responsibility's playbook
 * @param {object}   [deps.projects]  the project registry, for the default project
 * @param {Function} [deps.log]
 * @param {Function} [deps.clock]
 */
export function createResponsibilities({ db, store, contracts, defaults = [], recall, processes = null, projects = null, log = () => {}, clock = Date.now }) {
  /**
   * The scheduler's hand-off: the mission it wrote as pending joins the runner's queue. The runner,
   * not the scheduler's tick, runs it, so a scheduled mission never runs beside another.
   */
  async function enqueue(mission) {
    await store.setStatus(mission, 'queued', 'Queued for the brain', { actor: 'scheduler' });
  }

  const scheduler = createScheduler({
    processEnvelope: enqueue,
    generateId: (prefix) => store.newId(prefix),
    writeHistory: (...args) => store.writeHistory(...args),
    recallMemory: recall,
    firestoreWrite: store.firestoreWrite,
    firestoreRead: store.firestoreRead,
    firestoreQuery: store.firestoreQuery,
    getProcess: processes ? async (id) => { await processes.ensureLoaded(); return processes.getProcess(id) || null; } : undefined,
    loadStore: () => readStore(db),
    defaults,
    policy: resolvePolicy(contracts),
    getDefaultProjectId: () => projects?.getDefaultId() || null,
    logger: log,
    clock,
  });

  /** The responsibilities a person may ask the agent to run now (marked triggerable). */
  function triggerable() {
    return scheduler.getResponsibilities()
      .filter((r) => r.enabled !== false && r.triggerable === true)
      .map((r) => ({ id: r.id, name: r.name || r.id, purpose: String(r.context?.purpose || r.instruction || '').substring(0, 160) }));
  }

  /** Fires one responsibility now, reading the agent's store first when the id is not yet known. */
  async function fire(id, opts = {}) {
    if (!scheduler.getResponsibilities().some((r) => r.id === id)) {
      await scheduler.refreshStore(new Date(clock()), { force: true }).catch(() => false);
    }
    return scheduler.fireById(id, opts);
  }

  /**
   * Claims a pending trigger: compare-and-swap from pending to firing, so a trigger is fired exactly
   * once even if two passes see it.
   *
   * @returns {Promise<object|null>} the trigger, or null when someone else took it
   */
  async function claimTrigger(id) {
    const path = `${COLLECTIONS.responsibilityTriggers}/${id}`;
    const current = await db.readDoc(path);
    if (!current || current.data.status !== 'pending') return null;
    const claimed = { ...current.data, status: 'firing', claimed_at: new Date(clock()).toISOString() };
    try {
      await db.commit([{ path, data: claimed, precondition: { updateTime: current.updateTime } }]);
      return claimed;
    } catch (e) {
      if (e instanceof StoreConflict) return null;
      throw e;
    }
  }

  /**
   * One pass over the "run now" triggers: claim each pending one, fire it, and record fired, skipped
   * or error with its detail and when.
   *
   * @returns {Promise<Array<{id: string, status: string}>>}
   */
  async function checkTriggers() {
    let pending;
    try {
      pending = await db.query('', COLLECTIONS.responsibilityTriggers, [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
      ], { noOrderBy: true, limit: TRIGGER_PAGE });
    } catch (e) {
      log('WARN', `responsibility triggers could not be read: ${e.message}`);
      return [];
    }
    const done = [];
    for (const t of pending) {
      try {
        const claimed = await claimTrigger(t.id);
        if (!claimed) continue;
        const r = await fire(claimed.responsibility_id, { bypassSpacing: claimed.bypass_spacing !== false, source: 'dashboard' });
        const status = r.ok ? 'fired' : (r.skipped ? 'skipped' : 'error');
        const fields = { status, detail: r.error || r.name || null, fired_at: new Date(clock()).toISOString() };
        await db.patch(`${COLLECTIONS.responsibilityTriggers}/${t.id}`, Object.keys(fields), firestoreEncode(fields));
        log('INFO', `responsibility trigger ${t.id} (${claimed.responsibility_id}): ${status}${r.error ? `: ${r.error}` : ''}`);
        done.push({ id: t.id, status });
      } catch (e) {
        log('WARN', `responsibility trigger ${t.id} failed: ${e.message}`);
        try {
          const fields = { status: 'error', detail: String(e.message).substring(0, 500), fired_at: new Date(clock()).toISOString() };
          await db.patch(`${COLLECTIONS.responsibilityTriggers}/${t.id}`, Object.keys(fields), firestoreEncode(fields));
        } catch { /* best effort */ }
        done.push({ id: t.id, status: 'error' });
      }
    }
    return done;
  }

  return {
    scheduler,
    /** Takes in the installed defaults and starts the one-minute tick. */
    start() {
      scheduler.loadResponsibilities(defaults);
      scheduler.start(new Date(clock()));
    },
    stop: () => scheduler.stop(),
    tick: (at) => scheduler.tick(at),
    triggerable,
    fire,
    fireEvent: (eventType, ctx) => scheduler.fireEvent(eventType, ctx),
    checkTriggers,
  };
}
