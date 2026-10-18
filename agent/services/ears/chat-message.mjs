// agent/services/ears/chat-message.mjs: what the ears read out of one Google Chat API message: is
// it the agent's own, is the agent mentioned, the request's text with the chat framing the brain
// expects, and the conversation from the same poll page. Pure: no network, no clock. Polling Chat is
// chat-inbox.mjs. Used by chat-inbox.mjs.
//
// A Chat message, as the API returns it to a user-authenticated caller: { name, text, createTime,
// clientAssignedMessageId?, sender: { name: 'users/<id>', type }, thread: { name },
// annotations: [{ type: 'USER_MENTION', startIndex, length, userMention: { user: { name } } }] }.
// Called as a user, Chat gives people only their resource name: a sender has no display name and no
// email, and neither has a mentioned user. `text` still shows a mention as the person's name
// ("@Ada Agent please..."), and the annotation says where it sits and whom it names.
//
// `who` describes the agent: { agentUserId: 'users/<id>' or null, agentName }. The id is the stable
// identity. It is learned from the agent's own messages (agentUserIdFrom); until then the agent's
// name stands in, matched whole word by whole word so that "@Al" never matches "@Alice".

import { AGENT_MESSAGE_ID_PREFIX } from '../../providers/channel.mjs';

const CURRENT_MESSAGE_MARKER = '[Current message - respond to this]';
const CONTEXT_MARKER = '[Chat messages since your last reply - for context]';

const DEFAULT_CONVERSATION = {
  max_turns: 12, // default; callers pass the contracts value
  per_turn_chars: 600, // default; callers pass the contracts value
  budget_chars: 6000, // default; callers pass the contracts value
};

const textOf = (m) => m.text || m.argumentText || '';

/**
 * A timestamp as milliseconds, for comparing. Chat and Firestore write a varying number of
 * fractional digits ('...:00Z', '...:00.5Z', '...:00.000123Z'), so the strings do not sort the way
 * the instants do. Missing or unparseable is the beginning of time.
 *
 * @param {string} ts
 * @returns {number}
 */
export function instant(ts) {
  const t = Date.parse(ts || '');
  return Number.isFinite(t) ? t : -Infinity;
}

/** The words of a name, lowercased, without the @ and the punctuation: '@Ada-Agent' -> ['ada', 'agent']. */
export function nameWords(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Whether `text` starts with every word of the agent's name, in order. */
function startsWithName(text, agentName) {
  const want = nameWords(agentName);
  const have = nameWords(text);
  return want.length > 0 && want.every((word, i) => have[i] === word);
}

/** Whether the agent's own mouth posted this message: the client-assigned id it gives every post. */
function postedByMouth(m) {
  return String(m.clientAssignedMessageId || '').startsWith(AGENT_MESSAGE_ID_PREFIX);
}

/**
 * Whether the agent wrote this message: one its mouth posted, or one from its user id. Before the id
 * is known, a sender display name equal to the agent's name also counts (Chat sends none to a user
 * caller, so this matters only for answers that carry one).
 *
 * @param {object} m   a Chat message
 * @param {object} who
 * @returns {boolean}
 */
export function isFromAgent(m, who) {
  if (postedByMouth(m)) return true;
  if (who.agentUserId) return m.sender?.name === who.agentUserId;
  return Boolean(who.agentName) && m.sender?.displayName === who.agentName;
}

/**
 * The agent's own Chat user id, when this message is one the mouth posted: its sender is then the
 * agent. Null for every other message.
 *
 * @param {object} m
 * @returns {string|null}
 */
export function agentUserIdFrom(m) {
  const id = m.sender?.name;
  return postedByMouth(m) && typeof id === 'string' && id.startsWith('users/') ? id : null;
}

/** The USER_MENTION annotations of a message, each with the text it covers. */
function userMentions(m) {
  const text = textOf(m);
  return (Array.isArray(m.annotations) ? m.annotations : [])
    .filter((a) => a?.type === 'USER_MENTION')
    .map((a) => {
      const start = a.startIndex ?? 0;
      const length = a.length ?? 0;
      return { user: a.userMention?.user?.name || null, start, end: start + length, text: text.slice(start, start + length) };
    });
}

/** Whether one mention annotation names the agent: by its id once known, by its name until then. */
function mentionIsAgent(mention, who) {
  if (who.agentUserId) return mention.user === who.agentUserId;
  return mention.end > mention.start && startsWithName(mention.text, who.agentName);
}

/** Where `@<agent name>` is typed as plain text, outside any mention of somebody else. */
function typedMentions(m, who) {
  if (!who.agentName) return [];
  const text = textOf(m);
  const escaped = String(who.agentName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const others = userMentions(m).filter((x) => !mentionIsAgent(x, who));
  const found = [];
  for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])@${escaped}(?![\\p{L}\\p{N}])`, 'giu'))) {
    const start = match.index;
    const end = start + match[0].length;
    if (!others.some((o) => start < o.end && end > o.start)) found.push({ start, end });
  }
  return found;
}

/**
 * Whether the message mentions the agent. With ears.mention_match 'annotation' (the default), a
 * USER_MENTION annotation naming the agent's user id counts; until the id is known, one whose text
 * starts with the agent's name does. `@<agent name>` typed as plain text also counts, unless it is
 * part of a mention of somebody else ("@Ada Lovelace" for an agent called Ada). With 'text', only the
 * typed name counts.
 *
 * @param {object} m
 * @param {object} who
 * @param {string} [mentionMatch='annotation'] ears.mention_match
 * @returns {boolean}
 */
export function mentionsAgent(m, who, mentionMatch = 'annotation') {
  if (mentionMatch === 'annotation' && userMentions(m).some((x) => mentionIsAgent(x, who))) return true;
  return typedMentions(m, who).length > 0;
}

/**
 * The person's request: the message text with the agent's mentions (and the spaces after them)
 * taken out. The message's own line breaks and spacing are kept: a pasted list or code block must
 * reach the brain as it was written. The original text when nothing would be left.
 *
 * @param {object} m
 * @param {object} who
 * @returns {string}
 */
export function requestText(m, who) {
  const text = textOf(m);
  const cuts = [
    ...userMentions(m).filter((x) => mentionIsAgent(x, who)),
    ...typedMentions(m, who),
  ].sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Infinity;
  for (const { start, end } of cuts) {
    if (end > lastStart) continue; // overlapping: already cut
    const tail = out.slice(end).replace(/^[ \t]+/, '');
    out = out.slice(0, start) + tail;
    lastStart = start;
  }
  const clean = out.trim();
  return clean || text;
}

/**
 * The text the brain classifies: the earlier messages of the poll page (the agent's own left out)
 * as context, then the message to answer under "[Current message - respond to this]".
 *
 * @param {object}   target the message to answer
 * @param {object[]} prior  earlier messages to show as context, oldest first
 * @param {object}   who
 * @param {Function} [nameOf] (message) => how a person is named; their sender id otherwise
 * @returns {string}
 */
export function buildContextualMessage(target, prior, who, nameOf = defaultName) {
  const lines = [];
  for (const m of prior) {
    const text = textOf(m);
    if (!text.trim() || isFromAgent(m, who)) continue;
    lines.push(`${nameOf(m)}: ${text}`);
  }
  const context = lines.length > 0 ? `${CONTEXT_MARKER}\n${lines.join('\n')}\n\n` : '';
  return `${context}${CURRENT_MESSAGE_MARKER}\nUser: ${requestText(target, who)}`;
}

function defaultName(m) {
  return m.sender?.displayName || m.sender?.email || 'Someone';
}

/**
 * The conversation before `target`, from the messages of the same poll page, in the shape
 * agent/context/conversation-context.mjs returns. In a space it is the target's thread; in a direct
 * message (`whole`) it is the whole page, because the conversation itself is the thread there.
 *
 * @param {object}   target
 * @param {object[]} pageMsgs the poll page, oldest first
 * @param {object}   who
 * @param {object}   [config] max_turns, per_turn_chars, budget_chars (contracts.conversation)
 * @param {object}   [opts]
 * @param {boolean}  [opts.whole=false]  use every message on the page, whatever its thread
 * @param {Function} [opts.nameOf]       (message) => how a person is named
 * @returns {null|{block: string, turns: object[], last_user_text: string|null,
 *   last_agent_text: string|null, cue_text: string}} null when nothing came before
 */
export function buildThreadConversation(target, pageMsgs, who, config = {}, { whole = false, nameOf = null } = {}) {
  const cfg = { ...DEFAULT_CONVERSATION, ...config };
  const threadName = whole ? null : target.thread?.name || null;
  const before = pageMsgs
    .filter((m) => (threadName ? m.thread?.name === threadName : true))
    .filter((m) => instant(m.createTime) < instant(target.createTime))
    .filter((m) => textOf(m).trim())
    .slice(-cfg.max_turns);

  const turns = before.map((m) => {
    const role = isFromAgent(m, who) ? 'agent' : 'user';
    const text = textOf(m).trim();
    return {
      role,
      name: role === 'agent' ? 'agent' : (nameOf ? nameOf(m) : (m.sender?.displayName || m.sender?.email || 'user')),
      text: text.length > cfg.per_turn_chars ? `${text.substring(0, cfg.per_turn_chars)} […trimmed]` : text,
      ts: m.createTime || '',
    };
  });
  if (turns.length === 0) return null;

  // Over budget: drop the oldest whole turns, always keeping the newest.
  const render = (ts) => ts.map((t) => `[${t.name}${t.ts ? ` ${t.ts.substring(0, 16)}` : ''}] ${t.text}`).join('\n');
  let kept = turns;
  while (kept.length > 1 && render(kept).length > cfg.budget_chars) kept = kept.slice(1);

  const lastUser = [...kept].reverse().find((t) => t.role === 'user') || null;
  const lastAgent = [...kept].reverse().find((t) => t.role === 'agent') || null;
  return {
    block: `## Conversation (most recent ${kept.length} turns, oldest first)\n${render(kept)}`,
    turns: kept,
    last_user_text: lastUser?.text || null,
    last_agent_text: lastAgent?.text || null,
    cue_text: kept.slice(-4).map((t) => t.text).join(' '),
  };
}
