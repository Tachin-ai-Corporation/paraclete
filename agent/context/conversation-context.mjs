// agent/context/conversation-context.mjs: the recent conversation a request came from, as a block for
// the brain to put into prompts. The conversation is context, not memory: it is read from the
// channel's stored messages, trimmed to a budget, and injected by the brain. Organs never fetch chat
// history themselves. Dashboard threads only; a Google Chat assembler can return the same shape
// later without changing callers. Used by the brain when it classifies a request and creates work.
//
// The speakers are a dashboard user, named by the message's sender_name (or their email), and the
// agent, whose messages carry sender 'agent' (see providers/channel.mjs).

import { FIRESTORE_HOST } from '../storage/hosts.mjs';
import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';
import { AGENT_SENDER } from '../providers/channel.mjs';
import { COLLECTIONS } from '../storage/collections.mjs';

const DEFAULTS = {
  max_turns: 12, // default; callers pass the contracts value
  budget_chars: 6000, // default; callers pass the contracts value
  per_turn_chars: 600, // default; callers pass the contracts value
};
const QUERY_TIMEOUT_MS = 8000;

function trimTurn(text, perTurnChars) {
  const t = (text || '').trim();
  if (t.length <= perTurnChars) return t;
  return `${t.substring(0, perTurnChars)} […trimmed]`;
}

/** The runQuery body for a thread's latest messages, newest first. */
function threadQuery(threadId, limit) {
  return {
    structuredQuery: {
      from: [{ collectionId: COLLECTIONS.messages }],
      where: {
        fieldFilter: { field: { fieldPath: 'thread_id' }, op: 'EQUAL', value: { stringValue: threadId } },
      },
      orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
      limit,
    },
  };
}

/**
 * Assembles the recent conversation of one dashboard thread, oldest turn first. Only that thread is
 * read, so one user's conversation never reaches work for another.
 *
 * @param {object}   p
 * @param {string}   p.projectId          GCP project that holds the Firestore database
 * @param {string}   p.threadId           the dashboard thread the request came from
 * @param {object}   [p.config]           max_turns, budget_chars, per_turn_chars
 * @param {Function} [p.getAccessToken]   VM token source (injectable for tests)
 * @param {Function} [p.fetch]            fetch implementation (injectable for tests)
 * @param {Function} [p.log]              (level, msg) logger
 * @returns {Promise<null | {
 *   block: string,
 *   turns: Array<{role: 'user'|'agent', name: string, text: string, ts: string}>,
 *   last_user_text: string|null,
 *   last_agent_text: string|null,
 *   cue_text: string,
 * }>} null when there is no thread, no messages, or the read fails. `block` is the rendered
 *   transcript; `cue_text` joins the last four turns, for cue extraction.
 */
export async function assembleConversation({
  projectId,
  threadId,
  config = {},
  getAccessToken = getVmAccessToken,
  fetch: fetchImpl = globalThis.fetch,
  firestoreHost = FIRESTORE_HOST,
  log = () => {},
}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!projectId || !threadId) return null;

  let rows;
  try {
    const token = await getAccessToken();
    if (!token) return null;
    const documents = `${firestoreHost.replace(/\/+$/, '')}/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetchImpl(`${documents}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(threadQuery(threadId, cfg.max_turns)),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      log('WARN', `conversation-context: runQuery HTTP ${res.status}`);
      return null;
    }
    rows = await res.json();
  } catch (e) {
    log('WARN', `conversation-context: fetch failed: ${e.message}`);
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const turns = rows
    .filter((r) => r.document?.fields?.text?.stringValue)
    .map((r) => {
      const f = r.document.fields;
      const sender = f.sender?.stringValue || '';
      const role = sender === AGENT_SENDER ? 'agent' : 'user';
      return {
        role,
        name: role === 'agent' ? 'agent' : (f.sender_name?.stringValue || sender || 'user'),
        text: trimTurn(f.text.stringValue, cfg.per_turn_chars),
        ts: f.timestamp?.timestampValue || '',
      };
    })
    .reverse();

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
