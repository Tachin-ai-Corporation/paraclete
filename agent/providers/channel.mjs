// agent/providers/channel.mjs: channel addresses and delivery. Every inbound message gets an
// immutable Address when the ears take it in; the brain carries it through the work untouched, and
// the mouth delivers to exactly that Address. Two channels: the dashboard, which every instance has,
// and Google Chat, which workspace roles add. Deciding what to say, and voicing it, is the mouth's
// job. Used by the ears (addresses, the Chat spaces and direct messages the agent's account can see)
// and the mouth (delivery).
//
// Google Chat is called as the agent's own Workspace user (domain-wide delegation), never as a Chat
// app. With user authentication Chat names people only by their resource name ('users/<id>'): no
// display name and no email on a message's sender or on a mention. Two consequences shape this
// file. Every message the mouth posts carries a client-assigned id with AGENT_MESSAGE_ID_PREFIX, so
// the ears can tell the agent's own messages apart and learn its user id from them. And an email is
// matched to a person only through their direct message with the agent (findDirectMessage).

import { createHash, randomUUID } from 'node:crypto';

const CHAT_API = 'https://chat.googleapis.com/v1';
const GCHAT_LIMIT = 4096;
/** spaces.list returns at most this many per page. */
const SPACES_PAGE_SIZE = 1000;
/** A listing stops after this many pages; ten thousand spaces is far past any one account. */
const SPACES_MAX_PAGES = 10;
const CHAT_TIMEOUT_MS = 10_000;

/**
 * The prefix of the client-assigned id on every message the agent posts to Chat. Chat requires a
 * custom message id to start with `client-` and hold at most 63 lowercase letters, digits and dashes.
 */
export const AGENT_MESSAGE_ID_PREFIX = 'client-paraclete-';

/**
 * A Chat API call that failed: `status` is the HTTP status (429 when the quota is spent), the
 * message holds Google's own reason.
 */
export class ChatApiError extends Error {
  constructor(what, status, detail = '') {
    super(`${what} failed: HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'ChatApiError';
    this.status = status;
  }
}

/** Google's reason out of an error response, short. */
async function errorDetail(res) {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message || parsed?.error?.status || text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** The `sender` on every message the agent writes to the dashboard. A user's message carries their email. */
export const AGENT_SENDER = 'agent';

let settings = null;

/**
 * Configures dashboard delivery. Call once at service startup.
 *
 * @param {object}   params
 * @param {string}   params.firestoreUrl  Firestore REST base: https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/documents
 * @param {{messages: string}} params.collections collection names: pass COLLECTIONS from agent/storage/collections.mjs
 * @param {string}   [params.agentName]   the agent's display name, stored on its messages
 * @param {Function} [params.fetch]       fetch implementation (injectable for tests)
 * @param {Function} [params.now]         clock in milliseconds (injectable for tests)
 */
export function initChannel({ firestoreUrl, collections, agentName = '', fetch, now = Date.now } = {}) {
  if (!firestoreUrl) throw new Error('initChannel: firestoreUrl is required');
  if (!collections?.messages) {
    throw new Error('initChannel: collections.messages is required (pass COLLECTIONS from agent/storage/collections.mjs)');
  }
  settings = { firestoreUrl: firestoreUrl.replace(/\/+$/, ''), collections, agentName, fetch, now };
}

const fetchImpl = () => settings?.fetch || globalThis.fetch;

// ---- Addresses ----

/**
 * Creates an Address.
 *
 * - Google Chat: `{ channel: 'gchat', space, thread }`. `space` is a Chat space resource name, always
 *   with exactly one `spaces/` prefix; `thread` is a Chat thread resource name. A message in a space
 *   is answered in its thread; a direct message is answered in the conversation itself, so its
 *   Address has no thread.
 * - Dashboard: `{ channel: 'dashboard', thread }`. `thread` is the id of the conversation thread
 *   (a document in the threads collection) the reply belongs in.
 *
 * Any channel other than 'gchat' makes a dashboard Address.
 *
 * @param {'gchat'|'dashboard'} channel
 * @param {object} [opts]
 * @param {string} [opts.space]  Chat space
 * @param {string} [opts.thread] Chat thread, or dashboard thread id
 * @returns {object} the Address
 */
export function makeAddress(channel, opts = {}) {
  if (channel === 'gchat') {
    let space = opts.space || null;
    if (space && !space.startsWith('spaces/')) space = `spaces/${space}`;
    return { channel: 'gchat', space, thread: opts.thread || null };
  }
  return { channel: 'dashboard', thread: opts.thread || null };
}

/**
 * Encodes an Address as a Firestore mapValue, stored at source_meta.address on intake and envelope
 * documents. Empty fields are left out.
 *
 * @param {object} addr
 * @returns {object} Firestore mapValue, or {} for no address
 */
export function serializeAddress(addr) {
  if (!addr) return {};
  const fields = { channel: { stringValue: addr.channel } };
  if (addr.channel === 'gchat' && addr.space) fields.space = { stringValue: addr.space };
  if (addr.thread) fields.thread = { stringValue: addr.thread };
  return { mapValue: { fields } };
}

/**
 * Decodes an Address from a Firestore source_meta fields object. Reads the source_meta.address map
 * first. Without one, a flat spaceName/space field (and threadName) still means Google Chat, because
 * the ears also stamp those from the Chat message. Otherwise `sourceChannel` picks the channel.
 *
 * @param {object} sourceMeta    Firestore fields of source_meta
 * @param {string} sourceChannel 'gchat' | 'dashboard' | anything else (treated as dashboard)
 * @returns {object} the Address
 */
export function parseAddress(sourceMeta, sourceChannel) {
  if (!sourceMeta) return makeAddress(sourceChannel === 'gchat' ? 'gchat' : 'dashboard');

  const addrMap = sourceMeta.address?.mapValue?.fields;
  if (addrMap) {
    const channel = addrMap.channel?.stringValue || 'gchat';
    if (channel === 'gchat') {
      return makeAddress('gchat', {
        space: addrMap.space?.stringValue || null,
        thread: addrMap.thread?.stringValue || null,
      });
    }
    return makeAddress('dashboard', { thread: addrMap.thread?.stringValue || null });
  }

  const space = sourceMeta.spaceName?.stringValue || sourceMeta.space?.stringValue || null;
  const thread = sourceMeta.threadName?.stringValue || null;
  if (space) return makeAddress('gchat', { space, thread });

  return makeAddress(sourceChannel === 'gchat' ? 'gchat' : 'dashboard');
}

// ---- Formatting ----

/**
 * Converts markdown to what Google Chat renders: headings and bold-italic become bold, and links
 * become their text.
 *
 * @param {string} text
 * @returns {string}
 */
export function toGChatMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, '*$1*')
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * The Chat message text: the body in Chat markdown, then the @mentions. Chat rejects messages over
 * 4096 characters, so only the body is cut: the mentions must survive, or the person never gets
 * pinged.
 *
 * @param {string}   text
 * @param {string[]} [mentions] Chat user ids or emails to @mention, deduplicated
 * @param {Function} [log]
 * @returns {string}
 */
export function chatMessageText(text, mentions = [], log = () => {}) {
  let body = toGChatMarkdown(text);
  const suffix = mentions && mentions.length > 0
    ? `\n\n${[...new Set(mentions)].map((m) => `<users/${m}>`).join(' ')}`
    : '';
  if (body.length + suffix.length > GCHAT_LIMIT) {
    const room = Math.max(0, GCHAT_LIMIT - suffix.length - 3);
    log('WARN: Truncating message BODY for GChat 4096 limit (mentions preserved)', { bodyLength: body.length, suffixLength: suffix.length });
    body = `${body.slice(0, room)}...`;
  }
  // Unreachable with real mention lists, but a POST over the limit is rejected outright.
  return (body + suffix).slice(0, GCHAT_LIMIT);
}

// ---- Paths ----

/**
 * The client-assigned id of one message the agent posts: AGENT_MESSAGE_ID_PREFIX and a digest of
 * `key`. The same key always gives the same id, so a delivery retried after a crash names the message
 * it already posted.
 *
 * @param {string} key what this message is, e.g. an envelope id and a digest of its content
 * @returns {string} at most 63 characters, lowercase letters, digits and dashes
 */
export function agentMessageId(key) {
  return `${AGENT_MESSAGE_ID_PREFIX}${createHash('sha256').update(String(key)).digest('hex').slice(0, 40)}`;
}

/**
 * The Chat API URL a message to `addr` is posted to. A threaded address replies in its thread, and
 * starts a new thread if that one is gone. `messageId` tags the message as the agent's own;
 * `requestId` makes the post idempotent: Chat answers a repeated request id with the message it
 * already created instead of posting it twice.
 *
 * @param {object}  addr a gchat Address
 * @param {object}  [opts]
 * @param {boolean} [opts.replyInThread=true]
 * @param {string}  [opts.messageId]
 * @param {string}  [opts.requestId]
 * @returns {string}
 */
export function chatMessagesUrl(addr, { replyInThread = true, messageId, requestId } = {}) {
  const params = new URLSearchParams();
  if (addr.thread && replyInThread) params.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  if (messageId) params.set('messageId', messageId);
  if (requestId) params.set('requestId', requestId);
  const query = params.toString();
  return `${CHAT_API}/${addr.space}/messages${query ? `?${query}` : ''}`;
}

/**
 * The Firestore REST URL dashboard messages are created at: the root messages collection. Every
 * message carries its conversation's id in `thread_id`.
 *
 * @param {string} firestoreUrl
 * @param {{messages: string}} collections
 * @returns {string}
 */
export function dashboardMessagesUrl(firestoreUrl, collections) {
  return `${firestoreUrl.replace(/\/+$/, '')}/${collections.messages}`;
}

/**
 * The Firestore fields of a message from the agent to the dashboard. It is marked processed so the
 * ears never take the agent's own message as a new request.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.thread]      dashboard thread id
 * @param {string} [opts.agentName]
 * @param {Array<{name: string, size: number, gcsPath: string}>} [opts.attachments]
 * @param {string} opts.timestamp     ISO 8601 UTC
 * @returns {object} Firestore fields
 */
export function dashboardMessageFields(text, { thread = null, agentName = '', attachments = [], timestamp }) {
  const fields = {
    text: { stringValue: text },
    sender: { stringValue: AGENT_SENDER },
    timestamp: { timestampValue: timestamp },
    processed: { booleanValue: true },
  };
  if (agentName) fields.sender_name = { stringValue: agentName };
  if (thread) fields.thread_id = { stringValue: thread };
  if (attachments && attachments.length > 0) {
    fields.attachments = {
      arrayValue: {
        values: attachments.map((att) => ({
          mapValue: {
            fields: {
              name: { stringValue: att.name || '' },
              size: { integerValue: String(att.size || 0) },
              gcsPath: { stringValue: att.gcsPath || '' },
            },
          },
        })),
      },
    };
  }
  return fields;
}

// ---- Calls to Google Chat ----

/**
 * A space as the ears need it, from a Chat API Space.
 *
 * @typedef {object} ChatSpace
 * @property {string}  name        'spaces/<id>'
 * @property {'SPACE'|'GROUP_CHAT'|'DIRECT_MESSAGE'|string} spaceType
 * @property {boolean} external    whether the space admits people outside the organization
 * @property {string|null} lastActiveTime when its newest message was sent
 * @property {string}  displayName
 */

/** The space type, also from the older `type` field some answers still carry. */
function spaceTypeOf(space) {
  if (space.spaceType) return space.spaceType;
  if (space.type === 'DM') return 'DIRECT_MESSAGE';
  return space.type === 'ROOM' ? 'SPACE' : 'SPACE_TYPE_UNSPECIFIED';
}

/**
 * Every Chat space the agent's Workspace account is a member of: named spaces, group chats and
 * direct messages (a direct message is listed once its first message is sent). spaces.list, as the
 * account; needs chat.spaces.readonly.
 *
 * @param {string}   token the agent's Workspace token (domain-wide delegation)
 * @param {object}   [opts]
 * @param {Function} [opts.fetch]
 * @returns {Promise<ChatSpace[]>}
 * @throws {ChatApiError} when a page cannot be read: a failed listing must never look like no spaces
 */
export async function listSpaces(token, { fetch = fetchImpl() } = {}) {
  const spaces = [];
  let pageToken = '';
  for (let page = 0; page < SPACES_MAX_PAGES; page += 1) {
    const url = `${CHAT_API}/spaces?pageSize=${SPACES_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
    if (!res.ok) throw new ChatApiError('listing the Chat spaces', res.status, await errorDetail(res));
    const data = await res.json();
    for (const s of data.spaces || []) {
      if (!s?.name) continue;
      spaces.push({
        name: s.name,
        spaceType: spaceTypeOf(s),
        external: s.externalUserAllowed === true,
        lastActiveTime: s.lastActiveTime || null,
        displayName: s.displayName || '',
      });
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return spaces;
}

/**
 * The direct message between the agent's account and a person, found by the person's email (Chat
 * takes an email in place of a user id when it is called as a user). spaces.findDirectMessage;
 * needs chat.spaces.readonly.
 *
 * @param {string}   token the agent's Workspace token (domain-wide delegation)
 * @param {string}   email
 * @param {object}   [opts]
 * @param {Function} [opts.fetch]
 * @returns {Promise<string|null>} the space name, or null when the two have no direct message
 * @throws {ChatApiError} on any other failure
 */
export async function findDirectMessage(token, email, { fetch = fetchImpl() } = {}) {
  const url = `${CHAT_API}/spaces:findDirectMessage?name=${encodeURIComponent(`users/${email}`)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new ChatApiError('finding a direct message', res.status, await errorDetail(res));
  const data = await res.json();
  return data?.name || null;
}

// ---- Delivery ----

/**
 * Delivers text to an Address. The one delivery primitive; the mouth calls it for everything.
 *
 * @param {object}   addr
 * @param {string}   text
 * @param {object}   [opts]
 * @param {string}   opts.token                 Chat: the agent's Workspace token (domain-wide delegation). Dashboard: the VM's token.
 * @param {boolean}  [opts.replyInThread=true]  Chat only
 * @param {string[]} [opts.mentions]            Chat only
 * @param {string}   [opts.messageKey]          Chat only: what this message is (agentMessageId). The
 *   same key posts at most once: a retry gets back the message Chat already has. Without one the
 *   message gets a fresh id, still marked as the agent's own.
 * @param {Array}    [opts.attachments]         dashboard only: { name, size, gcsPath }
 * @param {Function} [opts.log]                 (message, details) logger
 * @param {Function} [opts.report]              ({ ok, status, error }) => void: how the channel answered
 * @returns {Promise<boolean>} whether the channel accepted the message
 */
export async function deliverToAddress(addr, text, opts = {}) {
  const { token, replyInThread = true, log = () => {}, mentions = [], attachments = [], messageKey, report = () => {} } = opts;

  if (addr?.channel === 'gchat') {
    if (!addr.space) {
      log('ERROR: deliverToAddress: no space on gchat address — dropping', { addr });
      report({ ok: false, status: 0, error: 'the address names no Chat space' });
      return false;
    }
    const body = { text: chatMessageText(text, mentions, log) };
    if (addr.thread && replyInThread) body.thread = { name: addr.thread };
    const messageId = agentMessageId(messageKey || randomUUID());
    const url = chatMessagesUrl(addr, { replyInThread, messageId, requestId: messageKey ? messageId : undefined });

    const res = await fetchImpl()(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    // A custom id is unique within its space: the message is already there, posted by an earlier try.
    if (res.status === 409 && messageKey) {
      log('deliverToAddress: Chat already has this message; not posting it again', { space: addr.space, messageId });
      report({ ok: true, status: 409, error: null });
      return true;
    }
    if (!res.ok) {
      const error = await errorDetail(res);
      log('ERROR: deliverToAddress: GChat POST failed', { status: res.status, space: addr.space, error: error.slice(0, 200) });
      report({ ok: false, status: res.status, error });
      return false;
    }
    report({ ok: true, status: res.status, error: null });
    return true;
  }

  if (addr?.channel === 'dashboard') {
    if (!settings) throw new Error('deliverToAddress: call initChannel before delivering to the dashboard');
    const fields = dashboardMessageFields(text, {
      thread: addr.thread,
      agentName: settings.agentName,
      attachments,
      timestamp: new Date(settings.now()).toISOString(),
    });
    const res = await fetchImpl()(dashboardMessagesUrl(settings.firestoreUrl, settings.collections), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) log('ERROR: deliverToAddress: dashboard message write failed', { status: res.status });
    report({ ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` });
    return res.ok;
  }

  log('ERROR: deliverToAddress: unknown channel', { channel: addr?.channel });
  report({ ok: false, status: 0, error: `unknown channel ${addr?.channel}` });
  return false;
}
