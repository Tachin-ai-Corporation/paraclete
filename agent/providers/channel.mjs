// agent/providers/channel.mjs: channel addresses and delivery. Every inbound message gets an
// immutable Address when the ears take it in; the brain carries it through the work untouched, and
// the mouth delivers to exactly that Address. Two channels: the dashboard, which every instance has,
// and Google Chat, which workspace roles add. Deciding what to say, and voicing it, is the mouth's
// job. Used by the ears (addresses, Chat space discovery) and the mouth (delivery).

const CHAT_API = 'https://chat.googleapis.com/v1';
const GCHAT_LIMIT = 4096;

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
 *   with exactly one `spaces/` prefix; `thread` is a Chat thread resource name.
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
 * The Chat API URL a message to `addr` is posted to. A threaded address replies in its thread, and
 * starts a new thread if that one is gone.
 *
 * @param {object}  addr a gchat Address
 * @param {object}  [opts]
 * @param {boolean} [opts.replyInThread=true]
 * @returns {string}
 */
export function chatMessagesUrl(addr, { replyInThread = true } = {}) {
  const url = `${CHAT_API}/${addr.space}/messages`;
  return addr.thread && replyInThread ? `${url}?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` : url;
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
 * The Chat spaces the agent's Workspace account can see (first page of 100).
 *
 * @param {string} token the agent's Workspace token (domain-wide delegation)
 * @returns {Promise<string[]>} space resource names; [] on failure
 */
export async function discoverSpaces(token) {
  const res = await fetchImpl()(`${CHAT_API}/spaces?pageSize=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.spaces || []).map((s) => s.name).filter(Boolean);
}

/**
 * The agent's own Chat user resource name ('users/12345'). The ears filter the agent's own messages
 * by it, which stays stable where display names don't.
 *
 * @param {string} token the agent's Workspace token (domain-wide delegation)
 * @returns {Promise<string|null>}
 */
export async function resolveAgentUserId(token) {
  try {
    const res = await fetchImpl()(`${CHAT_API}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.name || null;
  } catch {
    return null;
  }
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
 * @param {Array}    [opts.attachments]         dashboard only: { name, size, gcsPath }
 * @param {Function} [opts.log]                 (message, details) logger
 * @returns {Promise<boolean>} whether the channel accepted the message
 */
export async function deliverToAddress(addr, text, opts = {}) {
  const { token, replyInThread = true, log = () => {}, mentions = [], attachments = [] } = opts;

  if (addr?.channel === 'gchat') {
    if (!addr.space) {
      log('ERROR: deliverToAddress: no space on gchat address — dropping', { addr });
      return false;
    }
    const body = { text: chatMessageText(text, mentions, log) };
    if (addr.thread && replyInThread) body.thread = { name: addr.thread };

    const res = await fetchImpl()(chatMessagesUrl(addr, { replyInThread }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log('ERROR: deliverToAddress: GChat POST failed', { status: res.status, space: addr.space, error: errText.slice(0, 200) });
      return false;
    }
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
    return res.ok;
  }

  log('ERROR: deliverToAddress: unknown channel', { channel: addr?.channel });
  return false;
}
