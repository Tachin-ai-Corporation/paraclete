// agent/services/ears/chat-message.mjs: what the ears read out of one Google Chat API message: is
// it the agent's own, is the agent mentioned, the message text with the chat framing the brain
// expects, and the thread's conversation from the same poll page. Pure: no network, no clock.
// Polling Chat is chat-inbox.mjs. Used by chat-inbox.mjs.
//
// A Chat message: { name, text, argumentText, createTime, sender: { name: 'users/<id>', displayName,
// email? }, thread: { name }, annotations: [{ type, startIndex, length, userMention: { user: { name } } }] }.
//
// `who` describes the agent: { agentUserId: 'users/<id>' or null, agentName, mention: '@<name>' }.
// The user id is the stable identity; the display name stands in only until the id is known.

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
const squash = (s) => String(s || '').replace(/[@\-_\s]/g, '').toLowerCase();

/**
 * Whether the agent wrote this message.
 *
 * @param {object} m   a Chat message
 * @param {object} who
 * @returns {boolean}
 */
export function isFromAgent(m, who) {
  if (who.agentUserId) return m.sender?.name === who.agentUserId;
  return Boolean(who.agentName) && m.sender?.displayName === who.agentName;
}

/**
 * Whether the message mentions the agent. With mention matching by annotation, a USER_MENTION of
 * the agent's user id counts, and so does one whose mentioned text matches the agent's name or
 * mention; that match also tells the ears the agent's user id when it was not known yet. Text that
 * contains the agent's mention always counts.
 *
 * @param {object} m
 * @param {object} who
 * @param {string} [mentionMatch='annotation'] ears.mention_match
 * @returns {{mentioned: boolean, agentUserId: string|null}} agentUserId is set when the annotation
 *   revealed it
 */
export function findMention(m, who, mentionMatch = 'annotation') {
  const text = textOf(m);
  if (mentionMatch === 'annotation' && Array.isArray(m.annotations)) {
    for (const ann of m.annotations) {
      if (ann.type !== 'USER_MENTION') continue;
      const user = ann.userMention?.user?.name || null;
      if (who.agentUserId && user === who.agentUserId) return { mentioned: true, agentUserId: null };
      const length = ann.length ?? 0;
      if (length > 0) {
        const start = ann.startIndex ?? 0;
        const mentioned = squash(text.slice(start, start + length));
        const names = [squash(who.agentName), squash(who.mention)].filter(Boolean);
        if (names.some((n) => mentioned.includes(n))) {
          return { mentioned: true, agentUserId: !who.agentUserId && user ? user : null };
        }
      }
    }
  }
  if (who.mention && text.includes(who.mention)) return { mentioned: true, agentUserId: null };
  return { mentioned: false, agentUserId: null };
}

/**
 * The text with the agent's mention (and the spaces after it) removed; the original text when
 * nothing would be left. The message's own line breaks and spacing are kept: a pasted list or code
 * block must reach the brain as it was written.
 *
 * @param {string} text
 * @param {string} [mention]
 * @returns {string}
 */
export function cleanMentionText(text, mention) {
  if (!text || !mention) return text;
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const clean = text.replace(new RegExp(`${escaped}[ \\t]*`, 'g'), '').trim();
  return clean || text;
}

/**
 * The text the brain classifies: the earlier messages of the poll page (the agent's own left out)
 * as context, then the message to answer under "[Current message - respond to this]".
 *
 * @param {object}   target the message to answer
 * @param {object[]} prior  earlier messages to show as context, oldest first
 * @param {object}   who
 * @returns {string}
 */
export function buildContextualMessage(target, prior, who) {
  const lines = [];
  for (const m of prior) {
    const text = textOf(m);
    if (!text.trim() || isFromAgent(m, who)) continue;
    lines.push(`${m.sender?.displayName || 'Someone'}: ${text}`);
  }
  const context = lines.length > 0 ? `${CONTEXT_MARKER}\n${lines.join('\n')}\n\n` : '';
  return `${context}${CURRENT_MESSAGE_MARKER}\nUser: ${cleanMentionText(textOf(target), who.mention)}`;
}

/**
 * The thread's conversation before `target`, from the messages of the same poll page, in the shape
 * agent/context/conversation-context.mjs returns. A threadless space (a direct message) uses the
 * whole page.
 *
 * @param {object}   target
 * @param {object[]} pageMsgs the poll page, oldest first
 * @param {object}   who
 * @param {object}   [config] max_turns, per_turn_chars, budget_chars (contracts.conversation)
 * @returns {null|{block: string, turns: object[], last_user_text: string|null,
 *   last_agent_text: string|null, cue_text: string}} null when nothing came before
 */
export function buildThreadConversation(target, pageMsgs, who, config = {}) {
  const cfg = { ...DEFAULT_CONVERSATION, ...config };
  const threadName = target.thread?.name || null;
  const before = pageMsgs
    .filter((m) => (threadName ? m.thread?.name === threadName : true))
    .filter((m) => instant(m.createTime) < instant(target.createTime))
    .slice(-cfg.max_turns);

  const turns = before.map((m) => {
    const role = isFromAgent(m, who) ? 'agent' : 'user';
    const text = textOf(m).trim();
    return {
      role,
      name: role === 'agent' ? 'agent' : (m.sender?.displayName || m.sender?.email || 'user'),
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
