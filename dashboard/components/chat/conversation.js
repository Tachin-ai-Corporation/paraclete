// dashboard/components/chat/conversation.js: the chat's bookkeeping, apart from how it looks. Messages
// arrive from several reads (the first page, the polls for what is new, older pages, the answer to a
// send) and are kept as one list without duplicates, oldest first; each poll asks only for what it
// has not seen settle; and the conversation's state at its end (is the agent on it, or has a message
// not been picked up at all) is worked out from the messages and the missions the thread asked for.
// Pure: no React, no fetching. Used by ChatView.jsx.

/** How long after a person's message the chat shows the agent as on it, with no reply yet. */
export const AWAIT_REPLY_MS = 3 * 60_000;
/** The ears read new messages every few seconds; one still unread after this is worth a word. */
export const NOT_PICKED_UP_MS = 30_000;
/** How far back a poll looks for the person's messages still waiting to be read. */
const UNREAD_LOOKBACK = 20;

const instant = (value) => Date.parse(value) || 0;

/** Oldest first; two messages in the same instant by id, so the order never flickers. */
function byTime(a, b) {
  return instant(a.timestamp) - instant(b.timestamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Merges lists of messages into one, oldest first. A message in a later list replaces the same
 * message in an earlier one, so newer reads win (a message the ears have since read, say).
 *
 * @param {...Array<object>} lists
 * @returns {object[]}
 */
export function mergeMessages(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const message of list || []) if (message?.id) byId.set(message.id, message);
  }
  return [...byId.values()].sort(byTime);
}

/**
 * Where the next poll starts: the newest message, or the oldest of the person's recent messages the
 * agent has not read yet, so the poll also sees it being read. Null before anything is known, which
 * asks for the newest page.
 *
 * @param {object[]} messages oldest first
 * @returns {string|null} an ISO time
 */
export function pollSince(messages) {
  if (messages.length === 0) return null;
  let since = messages[messages.length - 1];
  for (const message of messages.slice(-UNREAD_LOOKBACK)) {
    if (message.from !== 'agent' && !message.processed && instant(message.timestamp) < instant(since.timestamp)) since = message;
  }
  return since.timestamp || null;
}

/**
 * Where the conversation stands at its end:
 *   - `not_picked_up`: the person's last message has not been read by the agent's ears for a while,
 *     so its VM is probably stopped or busy restarting;
 *   - `working`: the person is waiting for a reply and a mission they asked for is running;
 *   - `thinking`: the person is waiting for a reply and nothing is running yet;
 *   - null: nothing to show (the agent spoke last, a send is still going out, or the wait is old).
 * Long-running work is shown by the presence strip, not here.
 *
 * @param {object}   o
 * @param {object[]} o.messages  oldest first
 * @param {object[]} o.missions  from /api/chat/presence
 * @param {boolean}  o.sending
 * @param {number}   o.now
 * @returns {{kind: 'not_picked_up', id: string}|{kind: 'working', title: string}|{kind: 'thinking'}|null}
 */
export function replyState({ messages, missions, sending, now }) {
  if (sending) return null;
  const last = messages[messages.length - 1];
  if (!last || last.from === 'agent') return null;
  const age = now - instant(last.timestamp);
  if (!last.processed) return age > NOT_PICKED_UP_MS ? { kind: 'not_picked_up', id: last.id } : { kind: 'thinking' };
  const running = (missions || []).find((mission) => mission.status === 'active');
  if (running) return { kind: 'working', title: running.title };
  return age < AWAIT_REPLY_MS ? { kind: 'thinking' } : null;
}
