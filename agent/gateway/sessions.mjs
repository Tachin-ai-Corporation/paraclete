// agent/gateway/sessions.mjs: the cortex's conversation sessions. The brain owns every lifecycle
// decision (open, continue, reset, close); the gateway only stores what the brain sent and replays it
// to the provider, so a long mission's stable transcript prefix is read from the provider's cache
// instead of being billed in full on every call. server.mjs drives it from the request's `session`
// field.
//
// A session is a cache that can always be rebuilt: memory only, nothing persisted, and every miss is
// answered fast so the brain reopens it from its own state. Losing the store costs one full-price
// rebuild, never correctness. The gateway never stores model output: the brain sends the decision it
// accepted as the assistant turn of the next continue.
//
// Invalidation: the system hash covers the stable system block only (working memory changes all the
// time and must not churn sessions); a prompt or skill change arrives with a gateway restart, which
// empties the store. `seq` catches the brain and the gateway drifting apart.

import { createHash } from 'node:crypto';

/** Store limits. Defaults; callers pass the contracts values. */
export const DEFAULT_SESSION_LIMITS = Object.freeze({
  idleTtlMs: 30 * 60_000,
  maxSessions: 16,
  // the per-turn content budget the brain's own context assembly uses
  turnContentCap: 8000,
});

/**
 * A short, content-keyed hash of the stable system block.
 *
 * @param {string} stableSystemBlock
 * @returns {string}
 */
export function hashSystem(stableSystemBlock) {
  return createHash('sha256').update(stableSystemBlock || '').digest('hex').substring(0, 16);
}

/**
 * Characters / 4 over a messages array. For telemetry only.
 *
 * @param {Array<{content: *}>} messages
 * @returns {number}
 */
export function estimateMessageTokens(messages) {
  return Math.ceil(messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return sum + content.length / 4;
  }, 0));
}

/**
 * Creates an empty session store.
 *
 * @param {object}   [o]
 * @param {number}   [o.idleTtlMs]      a session unused this long is dropped
 * @param {number}   [o.maxSessions]    beyond this, the least recently used are dropped
 * @param {number}   [o.turnContentCap] the most characters one stored user or tool message keeps
 * @param {Function} [o.now]            clock in milliseconds
 */
export function createSessionStore({
  idleTtlMs = DEFAULT_SESSION_LIMITS.idleTtlMs,
  maxSessions = DEFAULT_SESSION_LIMITS.maxSessions,
  turnContentCap = DEFAULT_SESSION_LIMITS.turnContentCap,
  now = Date.now,
} = {}) {
  const sessions = new Map();

  // A session must not swap bounded digests for an unbounded transcript. Caps user and tool string
  // content at the budget the stateless path uses: the store's own backstop against one oversized
  // turn being read from cache on every later continue. Content-part arrays are left intact; the
  // brain's tier assembly already budgets them.
  function capMessage(m) {
    if ((m.role === 'tool' || m.role === 'user') && typeof m.content === 'string' && m.content.length > turnContentCap) {
      return { ...m, content: `${m.content.substring(0, turnContentCap)} [...capped at ${turnContentCap} chars; the full result is in the envelope's state]` };
    }
    return m;
  }

  function evictIfNeeded() {
    const t = now();
    for (const [id, s] of sessions) {
      if (t - s.lastUsedAt > idleTtlMs) sessions.delete(id);
    }
    while (sessions.size > maxSessions) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, s] of sessions) {
        if (s.lastUsedAt < oldestAt) { oldestAt = s.lastUsedAt; oldestId = id; }
      }
      if (oldestId === null) break;
      sessions.delete(oldestId);
    }
  }

  /** op 'open': stores the whole opening context the brain assembled, at seq 0. */
  function openSession({ id, organ, systemHash, messages }) {
    const t = now();
    const s = {
      id,
      organ,
      systemHash,
      messages: messages.map(capMessage),
      seq: 0,
      lastRealPromptTokens: 0,
      createdAt: t,
      lastUsedAt: t,
    };
    sessions.set(id, s);
    evictIfNeeded();
    return s;
  }

  /**
   * op 'continue': the session, or a typed miss: 'absent', 'organ', 'system_hash' or 'seq'. A miss
   * never throws; the server answers it without a provider call and the brain rebuilds.
   */
  function continueSession({ id, organ, systemHash, expectedSeq }) {
    const s = sessions.get(id);
    if (!s) return { miss: 'absent' };
    if (s.organ !== organ) return { miss: 'organ' };
    if (systemHash && s.systemHash !== systemHash) return { miss: 'system_hash' };
    if (typeof expectedSeq === 'number' && s.seq !== expectedSeq) return { miss: 'seq' };
    s.lastUsedAt = now();
    return { session: s };
  }

  /** Appends the brain's delta for a completed turn and advances seq. Null when the session is gone. */
  function appendTurn(id, newMessages, promptTokens = 0) {
    const s = sessions.get(id);
    if (!s) return null;
    for (const m of newMessages) s.messages.push(capMessage(m));
    s.seq++;
    s.lastRealPromptTokens = promptTokens || s.lastRealPromptTokens;
    s.lastUsedAt = now();
    return s;
  }

  /** op 'reset': replaces the transcript wholesale (the brain compacted or repaired it); seq carries on. */
  function resetSession({ id, organ, systemHash, messages }) {
    const existing = sessions.get(id);
    const seq = existing ? existing.seq : 0;
    const s = openSession({ id, organ, systemHash, messages });
    s.seq = seq;
    return s;
  }

  /** Drops a session. Idempotent: true when it existed. */
  function closeSession(id) {
    return sessions.delete(id);
  }

  /** Ids and counters for /status. Never content. */
  function listSessions() {
    const t = now();
    return Array.from(sessions.values()).map((s) => ({
      id: s.id,
      organ: s.organ,
      seq: s.seq,
      est_tokens: estimateMessageTokens(s.messages),
      last_prompt_tokens: s.lastRealPromptTokens,
      age_sec: Math.round((t - s.createdAt) / 1000),
      idle_sec: Math.round((t - s.lastUsedAt) / 1000),
    }));
  }

  return { openSession, continueSession, appendTurn, resetSession, closeSession, listSessions };
}
