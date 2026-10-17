// agent/work/archival.mjs: the periodic sweep that keeps the work collection current. It archives
// finished envelopes once they are delivered and their lessons recorded, and cancels work that can
// no longer progress: stale waits without a resume time, stale active envelopes, and children whose
// parent is gone. It never touches a timed wait before its resume time (the brain resumes those) and
// never archives blocked or queued work, which waits for a person or for the brain. Used by the
// brain, on an interval.

import { COLLECTIONS } from '../storage/collections.mjs';

const HOUR_MS = 60 * 60 * 1000;

/** Defaults for the sweep's thresholds. */
export const DEFAULT_ARCHIVAL_CONFIG = Object.freeze({
  staleCleanupHours: 24, // default; callers pass the contracts value
  archiveAgeDays: 7, // default; callers pass the contracts value
  needsInputTimeoutHours: 72, // default; callers pass the contracts value
  waitingTimeoutHours: 8, // default; callers pass the contracts value
  activeTimeoutHours: 12, // default; callers pass the contracts value
});

/** A parent in one of these states can never collect its children's results. */
const DEAD_PARENT_STATUSES = ['cancelled', 'archived', 'failed'];

/**
 * When a waiting envelope's timed wait is due to end, or null for a wait with no (readable) resume
 * time.
 *
 * @param {object} env
 * @returns {number|null} ms since the epoch
 */
function resumeTime(env) {
  if (!env.wait_resume_at) return null;
  const t = Date.parse(env.wait_resume_at);
  return Number.isFinite(t) ? t : null;
}

/**
 * Creates the archival sweeper.
 *
 * @param {object}   deps
 * @param {Function} deps.firestoreWrite  - async (collection, docId, data) => result
 * @param {Function} deps.firestoreRead   - async (collection, docId) => data
 * @param {Function} deps.firestoreQuery  - async (collection, filters, opts) => docs[]
 * @param {object}   [deps.config]        - thresholds; see DEFAULT_ARCHIVAL_CONFIG
 * @param {Function} [deps.logger]        - (level, msg) => void
 * @param {Function} [deps.clock]         - () => ms (injectable for tests)
 * @returns {{sweep: Function, startSchedule: Function, stopSchedule: Function}}
 */
export function createArchivalSweeper(deps) {
  const { firestoreWrite, firestoreRead, firestoreQuery, clock = Date.now } = deps;
  const log = deps.logger || ((level, msg) => console.log(`[archival] ${level}: ${msg}`));
  const {
    staleCleanupHours, archiveAgeDays, needsInputTimeoutHours, waitingTimeoutHours, activeTimeoutHours,
  } = { ...DEFAULT_ARCHIVAL_CONFIG, ...(deps.config || {}) };

  let intervalId = null;

  const byStatus = (status) => firestoreQuery(COLLECTIONS.work, [
    { field: 'status', op: 'EQUAL', value: { stringValue: status } },
  ]).then((docs) => docs || []);

  /**
   * Runs one sweep.
   *
   * Archives:
   *  1. failed envelopes older than staleCleanupHours
   *  2. complete envelopes: children at once, top-level ones after staleCleanupHours once delivered
   *     and their lessons recorded (memory_written), or after archiveAgeDays regardless
   *  3. needs_input envelopes nobody answered within needsInputTimeoutHours
   *  4. cancelled envelopes older than staleCleanupHours
   *  5. timed_out envelopes, at once (they are terminal)
   *
   * Cancels:
   *  6. waiting envelopes with no resume time, idle longer than waitingTimeoutHours. A timed wait
   *     (wait_resume_at) is never cancelled here: it may last up to a day, and the brain resumes it.
   *  7. active envelopes idle longer than activeTimeoutHours
   *  8. active, pending, queued, blocked or waiting children whose parent is cancelled, archived,
   *     failed or gone
   *
   * @returns {Promise<number>} how many envelopes were archived
   */
  async function sweep() {
    log('INFO', 'Running envelope archival sweep...');
    const nowMs = clock();
    const now = new Date(nowMs).toISOString();
    const cutoff = (ms) => new Date(nowMs - ms).toISOString();
    const archive = (env, reason) => firestoreWrite(COLLECTIONS.work, env.id, {
      ...env, status: 'archived', archived_reason: reason, delivery_status: 'delivered', updated_at: now,
    });
    const cancel = (env, reason) => firestoreWrite(COLLECTIONS.work, env.id, {
      ...env, status: 'cancelled', cancelled_at: now, cancelled_reason: reason, updated_at: now, completed_at: now,
    });

    let totalArchived = 0;
    try {
      // 1. Failed envelopes.
      const staleCutoff = cutoff(staleCleanupHours * HOUR_MS);
      let failedCount = 0;
      for (const env of await byStatus('failed')) {
        if (env.created_at && env.created_at < staleCutoff) {
          await archive(env, 'stale_failed');
          failedCount++;
        }
      }
      if (failedCount) log('INFO', `Archived ${failedCount} failed envelopes (>${staleCleanupHours}h old)`);

      // 2. Complete envelopes.
      const forceCutoff = cutoff(archiveAgeDays * 24 * HOUR_MS);
      let completeCount = 0;
      for (const env of await byStatus('complete')) {
        // Work still waiting for delivery is never archived, child or not.
        if (env.delivery_status === 'pending') continue;
        // A child is delivered through its mission, so it can go at once.
        if (env.parent_id) {
          await archive(env, 'child_complete');
          completeCount++;
          continue;
        }
        const age = env.completed_at || env.updated_at || env.created_at;
        if (!age || age >= staleCutoff) continue;
        if (env.memory_written) {
          await archive(env, 'delivered');
          completeCount++;
        } else if (age < forceCutoff) {
          // The safety net: a mission whose lessons were never recorded still leaves eventually.
          log('WARN', `Force-archiving envelope without memory_written: ${env.id} (age > ${archiveAgeDays}d)`);
          await archive(env, 'delivered_no_memory');
          completeCount++;
        }
      }
      if (completeCount) log('INFO', `Archived ${completeCount} complete envelopes (children + >${staleCleanupHours}h old)`);

      // 3. Unanswered questions.
      const needsInputCutoff = cutoff(needsInputTimeoutHours * HOUR_MS);
      let needsInputCount = 0;
      for (const env of await byStatus('needs_input')) {
        if (env.updated_at && env.updated_at < needsInputCutoff) {
          await archive(env, 'unanswered');
          needsInputCount++;
          log('WARN', `Archived unanswered needs_input envelope: ${env.id} (last updated ${env.updated_at})`);
        }
      }

      // 4. Cancelled envelopes.
      let cancelledCount = 0;
      for (const env of await byStatus('cancelled')) {
        if (env.cancelled_at && env.cancelled_at < staleCutoff) {
          await archive(env, 'cancelled');
          cancelledCount++;
        }
      }
      if (cancelledCount) log('INFO', `Archived ${cancelledCount} cancelled envelopes (>${staleCleanupHours}h old)`);

      // 5. Timed-out envelopes.
      let timedOutCount = 0;
      for (const env of await byStatus('timed_out')) {
        await archive(env, 'timed_out');
        timedOutCount++;
      }
      if (timedOutCount) log('INFO', `Archived ${timedOutCount} timed_out envelopes`);

      // 6. Stale waits. This sweep once cancelled every waiting envelope idle past the timeout,
      // timed waits included, so a wait the agent set for a day was cancelled after eight hours.
      // A timed wait belongs to the brain, which resumes it at wait_resume_at; only a wait with no
      // resume time can be stale.
      const waitingCutoff = cutoff(waitingTimeoutHours * HOUR_MS);
      const waiting = await byStatus('waiting');
      let waitingCount = 0;
      for (const env of waiting) {
        const resumeAt = resumeTime(env);
        if (resumeAt !== null) {
          if (nowMs - resumeAt > waitingTimeoutHours * HOUR_MS) {
            log('WARN', `Timed wait ${env.id} is ${Math.round((nowMs - resumeAt) / HOUR_MS)}h past its resume time (${env.wait_resume_at}); left for the brain to resume`);
          }
          continue;
        }
        const age = env.updated_at || env.created_at;
        if (age && age < waitingCutoff) {
          await cancel(env, `Stale waiting >${waitingTimeoutHours}h`);
          env.status = 'cancelled';
          waitingCount++;
        }
      }
      if (waitingCount) log('INFO', `Cancelled ${waitingCount} stale waiting envelopes (>${waitingTimeoutHours}h old, no resume time)`);

      // 7. Stale active envelopes: a brain that died mid-step leaves them active forever.
      const activeCutoff = cutoff(activeTimeoutHours * HOUR_MS);
      const active = await byStatus('active');
      let staleActiveCount = 0;
      for (const env of active) {
        const age = env.updated_at || env.created_at;
        if (age && age < activeCutoff) {
          await cancel(env, `Stale active >${activeTimeoutHours}h`);
          env.status = 'cancelled';
          staleActiveCount++;
        }
      }
      if (staleActiveCount) log('INFO', `Cancelled ${staleActiveCount} stale active envelopes`);

      // 8. Orphaned children. A child whose parent can no longer collect it would otherwise run, or
      // wait, for nothing.
      const children = [
        ...active,
        ...(await byStatus('pending')),
        ...(await byStatus('queued')),
        ...(await byStatus('blocked')),
        ...waiting,
      ].filter((env) => env.parent_id && env.status !== 'cancelled');
      let orphanCount = 0;
      for (const env of children) {
        const parent = await firestoreRead(COLLECTIONS.work, env.parent_id);
        if (!parent || DEAD_PARENT_STATUSES.includes(parent.status)) {
          await cancel(env, parent ? `Parent ${env.parent_id} is ${parent.status}` : `Parent ${env.parent_id} not found`);
          orphanCount++;
        }
      }
      if (orphanCount) log('INFO', `Cancelled ${orphanCount} orphaned children (parent cancelled/archived/failed/missing)`);

      totalArchived = failedCount + completeCount + needsInputCount + cancelledCount + timedOutCount;
      const totalCancelled = waitingCount + staleActiveCount + orphanCount;
      log('INFO', `Archival sweep complete: ${totalArchived} archived, ${totalCancelled} cancelled (${failedCount} failed, ${completeCount} complete, ${needsInputCount} unanswered, ${cancelledCount} cancelled, ${timedOutCount} timed_out, ${waitingCount} waiting, ${staleActiveCount} stale_active, ${orphanCount} orphans)`);
    } catch (e) {
      log('WARN', `Archival sweep error: ${e.message}`);
    }
    return totalArchived;
  }

  /**
   * Starts periodic sweeps.
   *
   * @param {number} [intervalMs=3600000] - one hour
   */
  function startSchedule(intervalMs = HOUR_MS) {
    if (intervalId) return;
    intervalId = setInterval(() => sweep(), intervalMs);
    log('INFO', `Archival sweep scheduled every ${Math.round(intervalMs / HOUR_MS)}h`);
  }

  /** Stops periodic sweeps. */
  function stopSchedule() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { sweep, startSchedule, stopSchedule };
}
