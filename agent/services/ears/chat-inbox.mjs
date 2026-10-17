// agent/services/ears/chat-inbox.mjs: reads Google Chat for a workspace role. Finds the spaces the
// agent's Workspace account belongs to, reads each space's new messages, keeps the ones that mention
// the agent, and turns each into an inbound message (see inbound.mjs) addressed to its space and
// thread. It also copies the thread's turns from the poll page into the thread ledger. It only
// reads: replies leave through the mouth, which holds the send scope. Used by the ears' Chat loop.
//
// Per space, a cursor holds the newest message time taken in, and a short list of message names
// guards against reading one twice; both survive restarts through the state store
// (chat-state.mjs). A space seen for the first time starts at "now" (ears.new_space_seed), so
// joining a space never replays its history.

import { makeAddress } from '../../providers/channel.mjs';
import { threadKeyFor } from '../../context/thread-ledger.mjs';
import { instant, isFromAgent, findMention, buildContextualMessage, buildThreadConversation } from './chat-message.mjs';

const CHAT_API = 'https://chat.googleapis.com/v1';
const PAGE_SIZE = 25;
const DISCOVERY_INTERVAL_MS = 300_000;
const SEEN_LIMIT = 200;
const LIST_TIMEOUT_MS = 10_000;

// Token errors that mean the agent's Workspace user does not exist yet: the expected state of a new
// install until an admin creates it, as opposed to a domain-wide delegation misconfiguration.
const PENDING_USER = /invalid email or user id|invalid_grant|not found|does not exist|notfound/i;

/**
 * Creates the Chat inbox.
 *
 * @param {object}   deps
 * @param {Function} deps.getToken           () => Promise<string>: the agent's Workspace token, read scopes
 * @param {Function} deps.discoverSpaces     (token) => Promise<string[]> (agent/providers/channel.mjs)
 * @param {Function} deps.resolveAgentUserId (token) => Promise<string|null> (agent/providers/channel.mjs)
 * @param {object}   deps.store              { load, save } from chat-state.mjs
 * @param {Function} deps.appendTurn         (turn: {threadKey, turnId, role, name, text, channelMeta}) => Promise<boolean>
 * @param {string}   deps.agentName          the agent's display name in Chat
 * @param {string}   [deps.mention]          the text that mentions the agent, e.g. '@Paraclete'
 * @param {object}   [deps.config]
 * @param {number}   [deps.config.maxPagesPerPoll=5]   ears.max_pages_per_poll
 * @param {string}   [deps.config.newSpaceSeed='now']  ears.new_space_seed: 'now', or anything else for a space's whole history
 * @param {string}   [deps.config.mentionMatch]        ears.mention_match
 * @param {number}   [deps.config.contextMessages=0]   ears.gchat_context_messages: earlier page messages framed as context
 * @param {object}   [deps.config.conversation]        contracts.conversation
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.log]              (level, message, fields) logger
 * @param {Function} [deps.now]              clock in milliseconds (injectable for tests)
 */
export function createChatInbox({
  getToken, discoverSpaces, resolveAgentUserId, store, appendTurn, agentName, mention = '',
  config = {}, fetch = globalThis.fetch, log = () => {}, now = Date.now,
}) {
  const maxPages = config.maxPagesPerPoll || 5;
  const contextMessages = config.contextMessages ?? 0;
  const conversation = config.conversation || {};

  const saved = store.load();
  const cursors = { ...saved.cursors };
  const seen = new Set(saved.seen);
  let agentUserId = saved.agentUserId;
  let spaces = [];
  let lastDiscovery = 0;
  let ready = false;
  let tokenFailures = 0;
  let lastErrors = 0;
  const backfills = new Set();

  const who = () => ({ agentUserId, agentName, mention });
  const persist = () => store.save({ cursors, seen: [...seen], agentUserId });

  /**
   * One attempt to come online: the Workspace token, then the agent's own user id. False while the
   * token fails; the caller retries later instead of crashing, so an agent whose Workspace user is
   * created after install comes online by itself.
   */
  async function connect() {
    let token;
    try {
      token = await getToken();
    } catch (err) {
      tokenFailures += 1;
      log('WARN', PENDING_USER.test(err.message || '')
        ? "Chat: waiting for the agent's Workspace account to be created"
        : 'Chat: the Workspace token is failing; retrying', { error: err.message, attempt: tokenFailures });
      return false;
    }
    log('INFO', tokenFailures ? 'Chat: the Workspace account now resolves; coming online' : 'Chat: Workspace token OK',
      tokenFailures ? { after_attempts: tokenFailures } : {});
    if (!agentUserId) {
      agentUserId = await resolveAgentUserId(token).catch(() => null);
      if (agentUserId) {
        log('INFO', 'Chat: agent user id resolved', { user: agentUserId });
        persist();
      } else {
        log('WARN', "Chat: the agent's user id is unknown; matching its display name until a mention reveals the id");
      }
    }
    ready = true;
    return true;
  }

  async function discover(token) {
    if (now() - lastDiscovery < DISCOVERY_INTERVAL_MS && spaces.length > 0) return;
    spaces = await discoverSpaces(token);
    lastDiscovery = now();
    log('INFO', 'Chat: discovered spaces', { count: spaces.length });
    let seeded = false;
    for (const space of spaces) {
      if (space in cursors) continue;
      cursors[space] = config.newSpaceSeed === 'now' || config.newSpaceSeed === undefined ? new Date(now()).toISOString() : '';
      seeded = true;
      log('INFO', 'Chat: new space', { space, seed: cursors[space] ? 'now' : 'beginning' });
    }
    if (seeded) persist();
  }

  /** Copies the thread's turns on this page into the thread ledger. Idempotent; never awaited by the poll. */
  function backfill(address, page) {
    const threadKey = threadKeyFor(address);
    if (!threadKey) return;
    const turns = page
      .filter((m) => (m.thread?.name || null) === address.thread && (m.text || '').trim())
      .slice(-((conversation.max_turns || 12) * 2));
    const job = (async () => {
      for (const m of turns) {
        await appendTurn({
          threadKey,
          turnId: m.name,
          role: isFromAgent(m, who()) ? 'agent' : 'user',
          name: m.sender?.displayName || '',
          text: m.text,
          channelMeta: address,
        });
      }
    })().catch((err) => log('WARN', 'Chat: thread ledger backfill failed', { thread: threadKey, error: err.message }));
    backfills.add(job);
    job.finally(() => backfills.delete(job));
  }

  async function pollSpace(space, token) {
    const cursor = instant(cursors[space]);
    const found = [];
    let pageToken = null;
    let pages = 0;
    do {
      let url = `${CHAT_API}/${space}/messages?pageSize=${PAGE_SIZE}&orderBy=createTime%20desc`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`listing messages failed: HTTP ${res.status}`);
      const data = await res.json();
      const page = (data.messages || []).slice().reverse(); // oldest first
      pageToken = data.nextPageToken || null;
      pages += 1;

      for (let i = 0; i < page.length; i++) {
        const m = page[i];
        const createTime = m.createTime || '';
        // At the cursor's own instant, the names already taken in tell old from new.
        if (instant(createTime) < cursor || seen.has(m.name) || isFromAgent(m, who())) continue;
        const text = m.text || m.argumentText || '';
        if (!text) continue;

        const match = findMention(m, who(), config.mentionMatch);
        if (match.agentUserId) {
          agentUserId = match.agentUserId;
          log('INFO', 'Chat: agent user id learned from a mention', { user: agentUserId });
          persist();
        }
        if (!match.mentioned && (mention || agentUserId)) continue;

        const address = makeAddress('gchat', { space, thread: m.thread?.name || null });
        backfill(address, page);
        found.push({
          channel: 'gchat',
          id: m.name,
          text: buildContextualMessage(m, contextMessages > 0 ? page.slice(Math.max(0, i - contextMessages), i) : [], who()),
          rawText: text,
          timestamp: createTime,
          sender: m.sender?.email || m.sender?.name || '',
          senderName: m.sender?.displayName || '',
          address,
          attachments: [],
          conversation: buildThreadConversation(m, page, who(), conversation),
        });
      }

      // Pages run newest first: once a page reaches back to the cursor, every later page is older,
      // and reading them only spends Chat API quota.
      const reachedCursor = page.length > 0 && instant(page[0].createTime) < cursor;
      if (page.length === 0 || !pageToken || reachedCursor) break;
    } while (pages < maxPages);
    return found;
  }

  /**
   * New messages that mention the agent, across every space, oldest first. A space that fails is
   * logged and counted in status().errors; the others are still read.
   */
  async function poll() {
    const token = await getToken();
    await discover(token);
    const messages = [];
    lastErrors = 0;
    for (const space of spaces) {
      try {
        messages.push(...await pollSpace(space, token));
      } catch (err) {
        lastErrors += 1;
        log('WARN', 'Chat: poll failed for a space', { space, error: err.message });
      }
    }
    return messages.sort((a, b) => instant(a.timestamp) - instant(b.timestamp));
  }

  /** Marks a message taken in: remembered by name, and its space's cursor moves up to it. */
  async function consume(msg) {
    seen.add(msg.id);
    for (const name of seen) {
      if (seen.size <= SEEN_LIMIT) break;
      seen.delete(name);
    }
    const space = msg.address?.space;
    if (space && instant(msg.timestamp) > instant(cursors[space])) cursors[space] = msg.timestamp;
    persist();
  }

  /** Waits for the ledger copies still running (on shutdown, and in tests). */
  async function settle() {
    await Promise.allSettled([...backfills]);
  }

  const status = () => ({ ready, spaces: spaces.length, errors: lastErrors, agentUserId });

  return { connect, poll, consume, settle, status, get ready() { return ready; } };
}
