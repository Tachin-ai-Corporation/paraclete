// agent/work/process-registry.mjs: loads the agent's process playbooks and serves them read-only. A
// process is a remembered playbook (name, description, narrative) the agent recalls into its own
// checkpoint plan; it is never executed as steps. Two sources: the installed playbooks of the role
// packages, passed in as parsed data, and the root `processes` collection, where playbooks the agent
// evolved live and override an installed one with the same id. It does not write playbooks (the
// agent's process command and the dashboard do). Used by the brain and the scheduler (processRef).

import { COLLECTIONS } from '../storage/collections.mjs';

const DEFAULT_REFRESH_MS = 60_000; // default; callers pass the contracts value
const QUERY_LIMIT = 300;

const usable = (p) => Boolean(p && typeof p.id === 'string' && p.id && p.status !== 'deprecated');

/**
 * Creates a process registry.
 *
 * @param {object}   deps
 * @param {object}   deps.db           - a client from agent/storage/firestore.mjs
 * @param {object[]} [deps.defaults]   - installed playbooks from the role packages, parsed
 * @param {Function} [deps.logger]     - (level, msg) => void
 * @param {number}   [deps.refreshMs]  - how long a load stays fresh for ensureLoaded()
 * @param {Function} [deps.clock]      - () => ms (injectable for tests)
 * @returns {{loadProcesses: Function, ensureLoaded: Function, getProcess: Function, getAllProcesses: Function}}
 */
export function createProcessRegistry(deps = {}) {
  const { db, defaults = [], refreshMs = DEFAULT_REFRESH_MS, clock = Date.now } = deps;
  const log = deps.logger || ((level, msg) => console.log(`[process-registry] ${level}: ${msg}`));

  let processes = {};
  let stored = {};      // the Firestore playbooks as last read successfully
  let loadedAt = -Infinity;

  /**
   * Loads the installed playbooks and the stored ones; a stored playbook overrides an installed
   * one with the same id. An unreadable store keeps the stored playbooks last read: an outage must
   * not read as "the agent has evolved no playbooks", which would quietly fall back to the
   * installed versions.
   */
  async function loadProcesses() {
    const installed = {};
    for (const p of Array.isArray(defaults) ? defaults : []) {
      if (usable(p)) installed[p.id] = p;
    }

    if (db) {
      try {
        // The client takes each document's id from its path, so a playbook a writer stored without
        // `id` in its body still loads under its document id.
        const docs = await db.query('', COLLECTIONS.processes, [], { noOrderBy: true, strict: true, limit: QUERY_LIMIT });
        const next = {};
        for (const p of docs) {
          if (!p.id) {
            log('WARN', 'A stored process has no id; skipped');
            continue;
          }
          if (usable(p)) next[p.id] = p;
        }
        stored = next;
      } catch (e) {
        log('WARN', `Failed to load stored processes (${e.message}); keeping the ${Object.keys(stored).length} last read`);
      }
    }

    processes = { ...installed, ...stored };
    loadedAt = clock();
    const installedCount = Object.keys(installed).length;
    const storedCount = Object.keys(stored).length;
    if (installedCount + storedCount > 0) {
      log('INFO', `Processes loaded: ${Object.keys(processes).join(', ')} (${installedCount} installed, ${storedCount} stored)`);
    }
  }

  /** Loads when the last load is older than the refresh interval. */
  async function ensureLoaded() {
    if (clock() - loadedAt > refreshMs) await loadProcesses();
  }

  return {
    /** Load every playbook now. */
    loadProcesses,
    /** Load if the last load is stale. */
    ensureLoaded,
    /** One playbook by id, or undefined. */
    getProcess: (id) => processes[id],
    /** Every playbook, keyed by id. */
    getAllProcesses: () => processes,
  };
}
