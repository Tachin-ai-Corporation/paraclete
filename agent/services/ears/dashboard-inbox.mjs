// agent/services/ears/dashboard-inbox.mjs: reads the dashboard's chat. Finds the messages the ears
// have not taken in yet in the root messages collection, turns each into an inbound message (see
// inbound.mjs) addressed to its own thread, and marks it consumed. Writing the agent's replies there
// is the mouth's job. Used by the ears' dashboard loop.
//
// A dashboard message: { text, timestamp (Firestore timestamp), processed, sender ('agent' or the
// user's email), sender_name, thread_id, attachments: [{ name, size, gcsPath }] }.

import { AGENT_SENDER, makeAddress } from '../../providers/channel.mjs';

/** Unprocessed messages read per poll. */
const POLL_LIMIT = 50;

/**
 * Creates the dashboard inbox.
 *
 * @param {object}   deps
 * @param {object}   deps.db          a client from agent/storage/firestore.mjs
 * @param {{messages: string}} deps.collections
 * @param {Function} [deps.log]       (level, message, fields) logger
 * @returns {{poll: () => Promise<object[]>, consume: (msg: object) => Promise<void>}}
 */
export function createDashboardInbox({ db, collections, log = () => {} }) {
  const path = (id) => `${collections.messages}/${id}`;

  async function markProcessed(id) {
    await db.patch(path(id), ['processed'], { processed: { booleanValue: true } }, { strict: true });
  }

  /**
   * The unprocessed messages, oldest first. A strict read: an outage throws instead of looking like
   * a quiet chat. Ordering happens here, so the query needs no composite index.
   */
  async function poll() {
    const rows = await db.query('', collections.messages, [
      { field: 'processed', op: 'EQUAL', value: { booleanValue: false } },
    ], { noOrderBy: true, limit: POLL_LIMIT, strict: true });

    const messages = [];
    for (const row of rows) {
      const text = typeof row.text === 'string' ? row.text : '';
      const attachments = Array.isArray(row.attachments) ? row.attachments.filter((a) => a && typeof a === 'object') : [];
      // A message the ears will never take in must still leave the unprocessed set: otherwise it is
      // read on every poll, and enough of them fill the poll window so new messages are never seen.
      if (row.sender === AGENT_SENDER || (!text.trim() && attachments.length === 0)) {
        log('WARN', 'dashboard message is not a request; marking it processed', { message: row.id, sender: row.sender || '' });
        await markProcessed(row.id);
        continue;
      }
      if (!row.thread_id) log('WARN', 'dashboard message has no thread_id; the reply cannot be threaded', { message: row.id });
      messages.push({
        channel: 'dashboard',
        id: row.id,
        text,
        rawText: text,
        timestamp: typeof row.timestamp === 'string' ? row.timestamp : '',
        sender: row.sender || '',
        senderName: row.sender_name || '',
        address: makeAddress('dashboard', { thread: row.thread_id || null }),
        attachments,
      });
    }
    // Compared as instants: Firestore writes a whole second as '...:00Z', which sorts after
    // '...:00.5Z' as a string.
    return messages.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  }

  async function consume(msg) {
    await markProcessed(msg.id);
  }

  return { poll, consume };
}
