// agent/services/ears/chat-inbox.mjs: reads Google Chat for a Workspace role, as the agent's own
// Workspace user (never as a Chat app). Every poll lists the spaces the account is a member of,
// reads the new messages of each space that had any, and turns into inbound messages (see
// inbound.mjs) every message in a direct message and, in a named space or group chat, the messages
// that mention the agent. Each is addressed to its space and, in a space, its thread. It copies the
// conversation's turns from the poll page into the thread ledger, and says which dashboard user sent
// a message when it knows (chat-identity.mjs). It only reads: replies leave through the mouth, which
// holds the send scope. Used by the ears' Chat loop in main.mjs; how people use it is the ears README.
//
// Per space, a cursor holds the newest message time read, and a short list of message names guards
// against taking one in twice; both survive restarts through the state store (chat-state.mjs). The
// first listing ever starts every space an hour back (ears.new_space_seed "now", less
// FIRST_LISTING_LOOKBACK_MS), so joining Chat never replays history, but the message that brought the
// agent's account into Chat is read: Google Chat lists no spaces for a user nobody has written to, so
// for a new account that first message always comes before the first listing. A space that appears
// later starts a minute before the previous listing, so the message that opened a new direct message,
// or the mention that added the agent to a space, is read. A message read twice is still taken in
// once: the intake write is create-only (intake.mjs).
//
// Who may talk to the agent here: anyone who can reach its account, in every space it is in. A space
// that admits people outside the organization is read like any other (the owner's choice: people
// work with the agent in such spaces); its outside members can ask the agent too and see its answers
// there. Those spaces are counted in status().external, so the dashboard can say so. Which of the
// senders are dashboard users, who alone may approve work from Chat, is the brain's check on
// source_meta.sender_email.
//
// Chat API quota: one spaces.list per poll, and messages.list only for spaces whose newest message is
// newer than their cursor (every space at least every five minutes). A 429 stops the round and the
// loop backs off (status().rateLimited).

import { makeAddress, ChatApiError } from '../../providers/channel.mjs';
import { threadKeyFor } from '../../context/thread-ledger.mjs';
import {
  instant, isFromAgent, agentUserIdFrom, mentionsAgent, buildContextualMessage, buildThreadConversation,
} from './chat-message.mjs';

const CHAT_API = 'https://chat.googleapis.com/v1';
const PAGE_SIZE = 25;
/** Every space is read at least this often, whatever its last-active time says. */
const SWEEP_MS = 300_000;
/** A space that appears after the first listing starts this long before the previous listing. */
const SEED_MARGIN_MS = 60_000;
/** The first listing ever starts every space this long before it. */
export const FIRST_LISTING_LOOKBACK_MS = 3_600_000;
/** The listing time is saved at least this often even when nothing else changed. */
const LISTED_SAVE_MS = 60_000;
const SEEN_LIMIT = 200;
const LIST_TIMEOUT_MS = 10_000;
const DIRECT_MESSAGE = 'DIRECT_MESSAGE';

// Token errors that mean the agent's Workspace user does not exist yet: the expected state of a new
// install until an admin creates it, as opposed to a domain-wide delegation misconfiguration.
const PENDING_USER = /invalid email or user id|invalid_grant|not found|does not exist|notfound/i;

/**
 * Creates the Chat inbox.
 *
 * @param {object}   deps
 * @param {Function} deps.getToken     () => Promise<string>: the agent's Workspace token, read scopes
 * @param {Function} deps.listSpaces   (token) => Promise<ChatSpace[]> (agent/providers/channel.mjs)
 * @param {object}   deps.store        { load, save } from chat-state.mjs
 * @param {Function} deps.appendTurn   (turn: {threadKey, turnId, role, name, text, channelMeta}) => Promise<boolean>
 * @param {string}   deps.agentName    the agent's name, which stands in for its user id until that is learned
 * @param {object}   [deps.identity]   from chat-identity.mjs; without one no sender is matched to a dashboard user
 * @param {object}   [deps.config]
 * @param {number}   [deps.config.maxPagesPerPoll=5]   ears.max_pages_per_poll
 * @param {string}   [deps.config.newSpaceSeed='now']  ears.new_space_seed: 'now', or anything else for a space's whole history
 * @param {string}   [deps.config.mentionMatch]        ears.mention_match
 * @param {number}   [deps.config.contextMessages=0]   ears.gchat_context_messages: earlier page messages framed as context
 * @param {object}   [deps.config.conversation]        contracts.conversation
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.log]        (level, message, fields) logger
 * @param {Function} [deps.now]        clock in milliseconds (injectable for tests)
 */
export function createChatInbox({
  getToken, listSpaces, store, appendTurn, agentName, identity = null,
  config = {}, fetch = globalThis.fetch, log = () => {}, now = Date.now,
}) {
  const maxPages = config.maxPagesPerPoll || 5;
  const contextMessages = config.contextMessages ?? 0;
  const conversation = config.conversation || {};
  const seedFromNow = config.newSpaceSeed === 'now' || config.newSpaceSeed === undefined;

  const saved = store.load();
  const cursors = { ...saved.cursors };
  const seen = new Set(saved.seen);
  let agentUserId = saved.agentUserId;
  let listedAt = saved.listedAt || null;
  let listedSavedAt = -Infinity;
  let spaces = [];
  let lastSweep = -Infinity;
  let ready = false;
  let tokenFailures = 0;
  let tokenError = null;
  let lastErrors = 0;
  let rateLimited = false;
  let savedPeople = JSON.stringify(saved.people || {});
  const warnedExternal = new Set();
  const backfills = new Set();

  const who = () => ({ agentUserId, agentName });
  const people = () => (identity ? identity.saveable() : saved.people || {});
  function persist() {
    const p = people();
    savedPeople = JSON.stringify(p);
    listedSavedAt = now();
    store.save({ cursors, seen: [...seen], agentUserId, listedAt, people: p });
  }

  /**
   * One attempt to come online: the Workspace token. False while it fails; the caller retries later
   * instead of crashing, so an agent whose Workspace user is created after install comes online by
   * itself.
   */
  async function connect() {
    try {
      await getToken();
    } catch (err) {
      tokenFailures += 1;
      tokenError = err.message || String(err);
      log('WARN', PENDING_USER.test(err.message || '')
        ? "Chat: waiting for the agent's Workspace account to be created"
        : 'Chat: the Workspace token is failing; retrying', { error: err.message, attempt: tokenFailures });
      return false;
    }
    tokenError = null;
    log('INFO', tokenFailures ? 'Chat: the Workspace account now resolves; coming online' : 'Chat: Workspace token OK',
      tokenFailures ? { after_attempts: tokenFailures } : {});
    if (!agentUserId) {
      log('INFO', "Chat: the agent's own user id is learned from its first message; until then its name stands in for it");
    }
    ready = true;
    return true;
  }

  /** Lists the spaces, starts a cursor for each new one, forgets the ones the account left. */
  async function refreshSpaces(token) {
    const listed = await listSpaces(token);
    const names = new Set(listed.map((s) => s.name));
    const seed = !seedFromNow ? ''
      : new Date(listedAt ? Math.min(now(), instant(listedAt) - SEED_MARGIN_MS) : now() - FIRST_LISTING_LOOKBACK_MS).toISOString();
    let changed = false;
    let newDirect = false;
    for (const space of listed) {
      if (space.name in cursors) continue;
      cursors[space.name] = seed;
      changed = true;
      if (space.spaceType === DIRECT_MESSAGE) newDirect = true;
      log('INFO', 'Chat: new space', { space: space.name, type: space.spaceType, external: space.external, from: seed || 'the beginning' });
    }
    for (const name of Object.keys(cursors)) {
      if (names.has(name)) continue;
      delete cursors[name];
      changed = true;
      log('INFO', 'Chat: the account is no longer in a space; forgetting it', { space: name });
    }
    for (const space of listed) {
      if (!space.external || warnedExternal.has(space.name)) continue;
      warnedExternal.add(space.name);
      log('INFO', 'Chat: a space open to people outside the organization; its outside members see the agent\'s answers', { space: space.name, type: space.spaceType });
    }
    spaces = listed;
    listedAt = new Date(now()).toISOString();
    if (changed || now() - listedSavedAt >= LISTED_SAVE_MS) persist();
    return newDirect;
  }

  /** Whether a space has anything newer than its cursor, or is due its sweep. */
  function due(space, sweep) {
    if (sweep || !space.lastActiveTime) return true;
    return instant(space.lastActiveTime) > instant(cursors[space.name]);
  }

  /** Copies the conversation's turns on this page into the thread ledger. Idempotent; never awaited by the poll. */
  function backfill(address, page, inConversation, nameOf) {
    const threadKey = threadKeyFor(address);
    if (!threadKey) return;
    const turns = page
      .filter((m) => inConversation(m) && (m.text || '').trim())
      .slice(-((conversation.max_turns || 12) * 2));
    const job = (async () => {
      for (const m of turns) {
        const agent = isFromAgent(m, who());
        await appendTurn({
          threadKey,
          turnId: m.name,
          role: agent ? 'agent' : 'user',
          name: agent ? agentName : nameOf(m),
          text: m.text,
          channelMeta: address,
        });
      }
    })().catch((err) => log('WARN', 'Chat: thread ledger backfill failed', { thread: threadKey, error: err.message }));
    backfills.add(job);
    job.finally(() => backfills.delete(job));
  }

  /** The agent's own user id, learned from the messages its mouth posted. */
  function learnAgentId(page) {
    for (const m of page) {
      const id = agentUserIdFrom(m);
      if (!id || id === agentUserId) continue;
      log('INFO', "Chat: learned the agent's own user id from a message it posted", { user: id, previous: agentUserId });
      agentUserId = id;
      persist();
    }
  }

  async function pollSpace(space, token) {
    const name = space.name;
    const direct = space.spaceType === DIRECT_MESSAGE;
    const cursor = instant(cursors[name]);
    const nameOf = (m) => identity?.emailOf(m.sender?.name, name, direct) || m.sender?.displayName || 'someone';
    const found = [];
    let newest = null;
    let pageToken = null;
    let pages = 0;
    let complete = false;
    do {
      let url = `${CHAT_API}/${name}/messages?pageSize=${PAGE_SIZE}&orderBy=createTime%20desc`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      if (!res.ok) throw new ChatApiError('listing messages', res.status);
      const data = await res.json();
      const page = (data.messages || []).slice().reverse(); // oldest first
      pageToken = data.nextPageToken || null;
      pages += 1;
      learnAgentId(page);

      for (let i = 0; i < page.length; i++) {
        const m = page[i];
        const createTime = m.createTime || '';
        if (newest === null || instant(createTime) > instant(newest)) newest = createTime;
        // At the cursor's own instant, the names already taken in tell old from new.
        if (instant(createTime) < cursor || seen.has(m.name) || isFromAgent(m, who())) continue;
        const text = m.text || m.argumentText || '';
        if (!text.trim()) continue;
        if (direct) identity?.learn(m, name);
        else if (!mentionsAgent(m, who(), config.mentionMatch)) continue;

        const thread = m.thread?.name || null;
        const address = makeAddress('gchat', { space: name, thread: direct ? null : thread });
        backfill(address, page, direct ? () => true : (x) => (x.thread?.name || null) === thread, nameOf);
        const email = identity?.emailOf(m.sender?.name, name, direct) || null;
        found.push({
          channel: 'gchat',
          id: m.name,
          text: buildContextualMessage(m, contextMessages > 0 ? page.slice(Math.max(0, i - contextMessages), i) : [], who(), nameOf),
          rawText: text,
          timestamp: createTime,
          sender: m.sender?.name || '',
          senderName: email || m.sender?.displayName || '',
          senderEmail: email,
          address,
          attachments: [],
          conversation: buildThreadConversation(m, page, who(), conversation, { whole: direct, nameOf }),
        });
      }

      // Pages run newest first: once a page reaches back to the cursor, every later page is older,
      // and reading them only spends Chat API quota.
      if (page.length === 0 || !pageToken || instant(page[0].createTime) < cursor) complete = true;
    } while (!complete && pages < maxPages);

    if (!complete) {
      log('WARN', 'Chat: more new messages in a space than one poll reads; the older ones were passed over', { space: name, pages });
    }
    // Nothing here for the agent: the cursor moves up to the newest message read, so a busy space
    // is not paged through again on every poll. With something found, consume() moves it.
    if (found.length === 0 && newest && instant(newest) > cursor) {
      cursors[name] = newest;
      persist();
    }
    return found;
  }

  /**
   * New messages for the agent, across every space, oldest first. A space that fails is logged and
   * counted in status().errors; the others are still read. A rate limit ends the round.
   *
   * @throws {ChatApiError} when the spaces cannot be listed
   */
  async function poll() {
    const token = await getToken();
    lastErrors = 0;
    rateLimited = false;
    let newDirect;
    try {
      newDirect = await refreshSpaces(token);
    } catch (err) {
      if (err.status === 429) rateLimited = true;
      throw err;
    }
    if (identity) {
      try {
        await identity.refresh(token, { force: newDirect });
      } catch (err) {
        if (err.status === 429) {
          rateLimited = true;
          log('WARN', 'Chat: the Chat API quota is spent; reading again later');
          return [];
        }
        log('WARN', 'Chat: the dashboard users could not be read; senders stay unmatched for now', { error: err.message });
      }
    }
    const sweep = now() - lastSweep >= SWEEP_MS;
    if (sweep) lastSweep = now();
    const messages = [];
    for (const space of spaces) {
      if (!due(space, sweep)) continue;
      try {
        messages.push(...await pollSpace(space, token));
      } catch (err) {
        if (err.status === 429) {
          rateLimited = true;
          log('WARN', 'Chat: the Chat API quota is spent; reading again later', { space: space.name });
          break;
        }
        lastErrors += 1;
        log('WARN', 'Chat: poll failed for a space', { space: space.name, error: err.message });
      }
    }
    if (JSON.stringify(people()) !== savedPeople) persist();
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

  /** What the health file reports. */
  function status() {
    return {
      ready,
      tokenError,
      spaces: spaces.filter((s) => s.spaceType !== DIRECT_MESSAGE).length,
      directMessages: spaces.filter((s) => s.spaceType === DIRECT_MESSAGE).length,
      external: spaces.filter((s) => s.external).length,
      errors: lastErrors,
      rateLimited,
      agentUserId,
      knownUsers: identity ? identity.known() : 0,
    };
  }

  return { connect, poll, consume, settle, status, get ready() { return ready; } };
}
