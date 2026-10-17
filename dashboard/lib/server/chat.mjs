// dashboard/lib/server/chat.mjs: each dashboard user's conversation with the agent. Four reads and
// one write, all for the signed-in user only:
//   - the thread: one `threads/{id}` document per user, created the first time they send something;
//   - the messages: the root `messages` collection, filtered by the thread's id, newest last, paged
//     back in time; and sending one, in exactly the shape the ears read (dev/say.mjs writes the same);
//   - presence: the missions this thread asked for that are not finished yet, from `work`;
//   - notices: the agent's messages that belong to no thread (work nobody in particular asked for).
//
// The thread id is derived from the user's email, never taken from the browser, so nobody can read
// or write someone else's conversation. The agent shares the thread document: its thread ledger
// (agent/context/thread-ledger.mjs) patches `channel`, `last_turn_at`, `summary` and
// `summary_through_ts` onto it. The dashboard therefore only ever patches its own fields, by field
// mask, and never writes the whole document.
//
// The agent's side of all this lives in agent/services/ears/dashboard-inbox.mjs (reading these
// messages), agent/providers/channel.mjs (writing its replies) and agent/services/brain/
// intake-handlers.mjs (the missions a message becomes).

import { createHash } from 'node:crypto';
import { firestoreEncode } from '../../../agent/storage/firestore.mjs';
import { ENVELOPE_STATUSES, TERMINAL_STATUSES } from '../../../agent/work/work-transitions.mjs';
import { HttpError } from './errors.mjs';
import { newDocId } from './commands.mjs';
import { isDownloadablePath } from './files.mjs';

/** The `sender` on every message the agent writes (AGENT_SENDER in agent/providers/channel.mjs). */
export const AGENT_SENDER = 'agent';

/** The longest message the dashboard sends. The ears keep 8000 characters verbatim on the intake. */
export const MAX_MESSAGE_CHARS = 20_000;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
/** The user's recent messages read before a send, to see what the ears would drop. */
const RECENT_FOR_SEND = 20;
/** Unfinished work read to find this thread's missions: newest first, across the instance. */
const PRESENCE_SCAN = 200;
/**
 * The agent's newest messages read to find the ones that belong to no thread. Every one read is a
 * billed Firestore read on each poll, so this bounds how far back notices reach.
 */
const NOTICE_SCAN = 100;
const DEFAULT_NOTICES = 8;
const MAX_NOTICES = 20;
const TITLE_CHARS = 120;
const STEP_CHARS = 160;

/** Work that is not finished: everything before a terminal status. */
export const OPEN_STATUSES = Object.freeze(ENVELOPE_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status)));

/**
 * The thread id of a user's conversation: `user-` and the first 32 hex digits of the SHA-256 of
 * their lowercased email. Deterministic, so finding a user's thread needs no lookup and two tabs
 * creating it at once land on the same document. Only [a-z0-9-], so it is a valid document id and
 * the agent's thread ledger, which rewrites any other character in a thread id, keys its record by
 * the same id and patches this very document. And no email in an id the agent copies into its
 * envelopes and log lines.
 *
 * @param {string} email a dashboard user's email
 * @returns {string}
 */
export function threadIdFor(email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) throw new Error('threadIdFor: an email is required');
  return `user-${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

const threadPath = (runtime, id) => `${runtime.collections.threads}/${id}`;

/** How the user is named on their messages: their name when the record has one, else their email's local part. */
function senderNameOf(user) {
  return String(user.name || '').trim() || user.email.split('@')[0];
}

/** An ISO string for a stored time (the client decodes Firestore timestamps as ISO strings), else null. */
function isoOf(value) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value ? value : null;
}

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function shapeThread(id, doc) {
  return {
    id,
    owner: doc?.owner ?? null,
    title: doc?.title ?? null,
    created_at: isoOf(doc?.created_at),
    last_message_at: isoOf(doc?.last_message_at),
  };
}

/** A message's files as the chat shows them; only the agent's outgoing files are downloadable. */
function attachmentsOf(runtime, list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((file) => file && typeof file === 'object' && (typeof file.gcsPath === 'string' || typeof file.name === 'string'))
    .map((file) => {
      const gcsPath = typeof file.gcsPath === 'string' ? file.gcsPath : '';
      return {
        name: String(file.name || gcsPath.split('/').pop() || 'file'),
        size: Number(file.size) || 0,
        gcsPath,
        downloadable: isDownloadablePath(runtime, gcsPath),
      };
    });
}

/**
 * A message as the chat shows it.
 *
 * @param {object} runtime
 * @param {object} row  a decoded `messages` document with its id
 * @returns {object} `{ id, from: 'agent'|'user', sender, sender_name, text, timestamp, processed,
 *   thread_id, attachments }`
 */
export function shapeMessage(runtime, row) {
  const fromAgent = row.sender === AGENT_SENDER;
  return {
    id: row.id,
    from: fromAgent ? 'agent' : 'user',
    sender: typeof row.sender === 'string' ? row.sender : '',
    sender_name: row.sender_name || (fromAgent ? runtime.settings.agentName : row.sender || ''),
    text: typeof row.text === 'string' ? row.text : '',
    timestamp: isoOf(row.timestamp),
    processed: row.processed === true,
    thread_id: typeof row.thread_id === 'string' && row.thread_id ? row.thread_id : null,
    attachments: attachmentsOf(runtime, row.attachments),
  };
}

function pageSize(limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

/**
 * Makes sure the user's thread document carries the dashboard's fields. Field-masked, so whatever the
 * agent's ledger already wrote onto it stays.
 *
 * @param {object} runtime
 * @param {{email: string, name?: string}} user
 * @param {Date} [now]
 * @returns {Promise<object>} the thread
 */
export async function ensureThread(runtime, user, now = new Date()) {
  const id = threadIdFor(user.email);
  const path = threadPath(runtime, id);
  const doc = await runtime.db.read(path, { strict: true });
  if (doc?.owner) {
    if (doc.owner !== user.email) throw new Error(`thread ${id} belongs to ${doc.owner}, not ${user.email}`);
    return shapeThread(id, doc);
  }
  const fields = {
    owner: user.email,
    owner_name: senderNameOf(user),
    title: `Conversation with ${user.email}`,
    created_at: now,
  };
  await runtime.db.patch(path, Object.keys(fields), firestoreEncode(fields), { strict: true });
  return shapeThread(id, { ...doc, ...fields });
}

/** A cursor from the query string as an ISO instant, or null when absent. */
function instantParam(name, value) {
  if (value === null || value === undefined || value === '') return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new HttpError(400, `'${name}' must be a date and time, not '${value}'`);
  return new Date(at).toISOString();
}

/**
 * A page of the user's conversation, oldest first. Three ways to ask, all through the `thread_id` +
 * `timestamp` index:
 *   - neither cursor: the newest `limit` messages; `has_more` says older ones exist;
 *   - `before`: the newest `limit` strictly older than it, for paging back in time;
 *   - `since`: the messages at or after it, which is how the open chat polls. Each poll then reads
 *     only what is new (and the person's messages still waiting to be read), not a whole page;
 *     `has_more` says there were more than `limit`, so the caller should start again from the newest.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {{email: string}} o.user
 * @param {string|null} [o.before]
 * @param {string|null} [o.since]
 * @param {number|string} [o.limit]
 * @returns {Promise<{thread_id: string, since: string|null, messages: object[], has_more: boolean}>}
 */
export async function listMessages(runtime, { user, before = null, since = null, limit = DEFAULT_PAGE }) {
  const threadId = threadIdFor(user.email);
  const size = pageSize(limit);
  const olderThan = instantParam('before', before);
  const from = instantParam('since', since);
  if (olderThan && from) throw new HttpError(400, "ask for messages 'before' or 'since' a time, not both");
  const filters = [{ field: 'thread_id', op: 'EQUAL', value: { stringValue: threadId } }];
  if (olderThan) filters.push({ field: 'timestamp', op: 'LESS_THAN', value: { timestampValue: olderThan } });
  if (from) filters.push({ field: 'timestamp', op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: from } });
  const rows = await runtime.db.query('', runtime.collections.messages, filters, {
    orderBy: 'timestamp', orderDirection: 'DESCENDING', limit: size + 1, strict: true,
  });
  return {
    thread_id: threadId,
    since: from,
    messages: rows.slice(0, size).map((row) => shapeMessage(runtime, row)).reverse(),
    has_more: rows.length > size,
  };
}

/**
 * Why the ears would drop a message without reading it, or null when they would take it in. Pure.
 * The ears (agent/services/ears/inbound-gate.mjs) drop a person's message that reaches them within
 * `cooldown_ms` of that person's previous one, and the same text from them again within
 * `dedup_window_ms` (a double send); either is marked processed and never reaches the brain. Refused
 * here, the person learns it and keeps their text. The ears measure both by when each message was
 * sent, as this does.
 *
 * @param {string}   text
 * @param {object[]} previous   the person's own earlier messages (shaped), any order
 * @param {number}   nowMs
 * @param {object}   ears       contracts.ears: cooldown_ms, dedup_window_ms
 * @param {string}   agentName
 * @returns {{status: number, message: string}|null}
 */
export function earsWouldDrop(text, previous, nowMs, ears, agentName) {
  const cooldownMs = Number(ears?.cooldown_ms) || 0;
  const dedupMs = Number(ears?.dedup_window_ms) || 0;
  const key = String(text).trim().toLowerCase();
  const timed = previous
    .map((m) => ({ m, at: Date.parse(m.timestamp) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => b.at - a.at);

  const latest = timed[0];
  if (latest && cooldownMs > 0 && nowMs - latest.at < cooldownMs) {
    const wait = Math.max(1, Math.ceil((cooldownMs - (nowMs - latest.at)) / 1000));
    return {
      status: 429,
      message: `${agentName} takes in one message at a time from each person: send this again in ${wait} s`,
    };
  }
  const repeat = timed.find(({ m, at }) => nowMs - at < dedupMs && m.attachments.length === 0 && m.text.trim().toLowerCase() === key);
  if (repeat) {
    const seconds = Math.max(1, Math.round((nowMs - repeat.at) / 1000));
    const window = dedupMs < 120_000 ? `${Math.round(dedupMs / 1000)} s` : `${Math.round(dedupMs / 60_000)} min`;
    return {
      status: 409,
      message: `you sent exactly this ${seconds} s ago, and ${agentName} takes the same message again only after ${window}: wait a moment, or reword it`,
    };
  }
  return null;
}

/**
 * Sends a message from the user into their thread, creating the thread on their first message. The
 * document is the one the ears read: `{ text, timestamp (a Firestore timestamp), processed: false,
 * sender, sender_name, thread_id, attachments: [] }`.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {{email: string, name?: string}} o.user
 * @param {unknown} o.text
 * @param {Date}   [o.now]
 * @returns {Promise<{message: object}>}
 */
export async function sendMessage(runtime, { user, text, now = new Date() }) {
  if (typeof text !== 'string') throw new HttpError(400, 'the message must be text');
  const body = text.trim();
  if (!body) throw new HttpError(400, 'the message is empty');
  if (body.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `the message is ${body.length} characters long; the most is ${MAX_MESSAGE_CHARS}`);
  }

  const threadId = threadIdFor(user.email);
  const recent = await runtime.db.query('', runtime.collections.messages, [
    { field: 'thread_id', op: 'EQUAL', value: { stringValue: threadId } },
  ], { orderBy: 'timestamp', orderDirection: 'DESCENDING', limit: RECENT_FOR_SEND, strict: true });
  const own = recent.filter((row) => row.sender === user.email).map((row) => shapeMessage(runtime, row));
  const drop = earsWouldDrop(body, own, now.getTime(), runtime.contracts.ears, runtime.settings.agentName);
  if (drop) throw new HttpError(drop.status, drop.message);

  await ensureThread(runtime, user, now);
  const id = newDocId();
  const data = {
    text: body,
    timestamp: now,
    processed: false,
    sender: user.email,
    sender_name: senderNameOf(user),
    thread_id: threadId,
    attachments: [],
  };
  await runtime.db.commit([{ path: `${runtime.collections.messages}/${id}`, data, precondition: { exists: false } }]);

  // The message is sent; a thread that misses its latest-activity time is not worth failing it for.
  const activity = { last_message_at: now };
  if (!(await runtime.db.patch(threadPath(runtime, threadId), Object.keys(activity), firestoreEncode(activity)))) {
    runtime.log('WARN', `thread ${threadId}: message ${id} was sent, but last_message_at was not updated`);
  }
  return { message: shapeMessage(runtime, { ...data, id }) };
}

/** The dashboard thread an envelope came from, or null. */
function threadOf(env) {
  for (const address of [env.source_meta?.address, env.delivery_address]) {
    if (address && typeof address === 'object' && address.channel === 'dashboard' && address.thread) return address.thread;
  }
  return null;
}

/** Where a mission's plan stands, from its checkpoint spine: done, total and the step it is on. */
function progressOf(spine) {
  if (!Array.isArray(spine) || spine.length === 0) return null;
  const done = spine.filter((step) => step?.status === 'complete').length;
  const current = spine.find((step) => step?.status !== 'complete');
  return { done, total: spine.length, current: current?.outcome ? clip(current.outcome, STEP_CHARS) : null };
}

function shapePresence(env) {
  return {
    id: env.id,
    title: clip(env.title || env.instruction || env.id, TITLE_CHARS),
    status: env.status,
    created_at: env.created_at ?? null,
    started_at: env.started_at ?? null,
    updated_at: env.updated_at ?? null,
    blocker: env.status === 'blocked' && env.blocker ? clip(env.blocker, 300) : null,
    waiting_until: env.status === 'waiting' ? env.wait_resume_at ?? null : null,
    progress: progressOf(env._cp_spine),
  };
}

/**
 * The missions the user's thread asked for that are not finished yet, newest first. Reads the
 * unfinished work across the instance through the `status` + `created_at` index (the one work recall
 * uses) and keeps this thread's missions; checkpoints and tasks carry the address too, and are left
 * out.
 *
 * @param {object} runtime
 * @param {{user: {email: string}}} o
 * @returns {Promise<{thread_id: string, missions: object[]}>}
 */
export async function threadPresence(runtime, { user }) {
  const threadId = threadIdFor(user.email);
  const rows = await runtime.db.query('', runtime.collections.work, [
    { field: 'status', op: 'IN', value: { arrayValue: { values: OPEN_STATUSES.map((status) => ({ stringValue: status })) } } },
  ], { orderBy: 'created_at', orderDirection: 'DESCENDING', limit: PRESENCE_SCAN, strict: true });
  return {
    thread_id: threadId,
    missions: rows.filter((env) => env.type === 'M' && threadOf(env) === threadId).map(shapePresence),
  };
}

/**
 * The agent's newest messages that belong to no thread: the outcome of work nobody in particular
 * asked for, such as a responsibility's report. The mouth writes them without a `thread_id`
 * (dashboardMessageFields in agent/providers/channel.mjs), and Firestore cannot query for a missing
 * field, so this reads the agent's newest messages (the `sender` + `timestamp` index) and keeps the
 * unaddressed ones. Every user sees them.
 *
 * @param {object} runtime
 * @param {{limit?: number|string}} [o]
 * @returns {Promise<{notices: object[]}>} newest first
 */
export async function listNotices(runtime, { limit = DEFAULT_NOTICES } = {}) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_NOTICES, 1), MAX_NOTICES);
  const rows = await runtime.db.query('', runtime.collections.messages, [
    { field: 'sender', op: 'EQUAL', value: { stringValue: AGENT_SENDER } },
  ], { orderBy: 'timestamp', orderDirection: 'DESCENDING', limit: NOTICE_SCAN, strict: true });
  return { notices: rows.filter((row) => !row.thread_id).slice(0, n).map((row) => shapeMessage(runtime, row)) };
}
