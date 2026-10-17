// agent/services/brain/waits.mjs: resumes a mission's timed wait when its time comes. The wait action
// pauses a mission with a resume time (wait_resume_at) and the next step (resume_instruction); when the
// time has passed, this moves the mission back to active with that step as its next input, and the
// runner continues it. A wait without a resume time is not this file's: the archival sweep ages it out.
//
// Resuming to active, not queued: the transition table lets every pause move to active and to no
// other running state, and the brain runs one mission at a time, so "active and unclaimed" is how a
// mission waits for the runner. The runner takes such missions before queued ones, and its durable
// claim is what marks the one it is running. This is decided once, for every resume (a wait, an
// approval, an answer, a cleared blocker), and the table is unchanged.

import { toStr } from '../../providers/to-str.mjs';

/**
 * Whether a waiting envelope's resume time has come.
 *
 * @param {object} env
 * @param {number} nowMs
 * @returns {boolean}
 */
export function waitIsOver(env, nowMs) {
  const at = Date.parse(env?.wait_resume_at || '');
  return Number.isFinite(at) && at <= nowMs;
}

/**
 * Creates the timed-wait check.
 *
 * @param {object}   deps
 * @param {object}   deps.store - envelope-store.mjs
 * @param {Function} [deps.log]
 * @param {Function} [deps.clock]
 * @returns {{check: Function}}
 */
export function createWaits({ store, log = () => {}, clock = Date.now }) {
  /**
   * Resumes every mission whose timed wait is over.
   *
   * @returns {Promise<string[]>} the ids resumed
   */
  async function check() {
    let waiting;
    try {
      waiting = await store.query([
        { field: 'status', op: 'EQUAL', value: { stringValue: 'waiting' } },
        { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
      ], { noOrderBy: true, limit: 100 });
    } catch (e) {
      log('WARN', `wait check could not read waiting missions: ${e.message}`);
      return [];
    }
    const resumed = [];
    for (const env of waiting) {
      if (!waitIsOver(env, clock())) continue;
      try {
        let then = '';
        // Compare-and-swap, so a cancel or an answer that lands at the same moment is never undone.
        const done = await store.update(env.id, (doc) => {
          if (doc.status !== 'waiting' || !waitIsOver(doc, clock())) return null;
          then = toStr(doc.resume_instruction || 'Continue the mission');
          store.move(doc, 'active');
          doc.context_forward = `[RESUMED AFTER WAIT]\n${then}`;
          return doc;
        });
        if (!done) continue;
        await store.writeHistory(env.id, 'waiting', 'active', 'brain', `Wait over; resuming: ${then.substring(0, 150)}`);
        log('INFO', `wait over: resumed mission ${env.id}`);
        resumed.push(env.id);
      } catch (e) {
        log('WARN', `could not resume the wait of ${env.id}: ${e.message}`);
      }
    }
    return resumed;
  }

  return { check };
}
