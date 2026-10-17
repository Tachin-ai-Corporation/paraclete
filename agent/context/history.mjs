// agent/context/history.mjs: appends status transitions to an envelope's history, the
// work/{id}/history subcollection the dashboard shows as the envelope's timeline. It only writes; it
// does not decide transitions (the brain does) or check that they are legal. Used by the brain.

import { COLLECTIONS, SUBCOLLECTIONS } from '../storage/collections.mjs';

const DETAIL_MAX_CHARS = 1000;

/**
 * Creates a history writer with its own ordering state.
 *
 * @param {object}   deps
 * @param {Function} deps.firestoreWrite async (collectionPath, docId, data) => result; upserts
 * @param {Function} [deps.now]          clock in milliseconds (injectable for tests)
 * @returns {{write: Function}}
 */
export function createHistoryWriter(deps) {
  const { firestoreWrite, now = Date.now } = deps;

  let counter = 0;
  let lastMs = 0;

  /**
   * Appends one transition record.
   *
   * Record ids are `{ms}-{counter}`, ordered and unique within this process. The counter breaks ties
   * inside one millisecond, and a clock that steps backwards keeps counting from the last id instead
   * of reusing one, so a record never overwrites an earlier one.
   *
   * With `logicalKey`, the key is the id instead. The write is an upsert, so replaying the same
   * logical transition after a crash overwrites its record rather than adding a duplicate.
   *
   * @param {string}      envelopeId
   * @param {string|null} prevStatus null when the envelope is created
   * @param {string}      newStatus
   * @param {string}      agent      the service or organ that made the transition, e.g. 'brain'
   * @param {string}      detail     what happened, in words (cut to 1000 chars)
   * @param {string}      [logicalKey]
   */
  async function write(envelopeId, prevStatus, newStatus, agent, detail, logicalKey) {
    const ms = now();
    let historyId = logicalKey;
    if (!historyId) {
      if (ms > lastMs) {
        lastMs = ms;
        counter = 0;
      } else {
        counter++;
      }
      historyId = `${lastMs}-${counter}`;
    }
    await firestoreWrite(`${COLLECTIONS.work}/${envelopeId}/${SUBCOLLECTIONS.workHistory}`, historyId, {
      seq: ms,
      prev_status: prevStatus,
      new_status: newStatus,
      agent,
      timestamp: new Date(ms).toISOString(),
      detail: (detail || '').substring(0, DETAIL_MAX_CHARS),
    });
  }

  return { write };
}
