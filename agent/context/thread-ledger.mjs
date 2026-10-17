// agent/context/thread-ledger.mjs: the agent's record of each conversation thread, kept in the root
// `threads` collection as one thread document plus a `turns` subcollection. The services write it
// idempotently at three seams (the brain when it claims a request, the ears when they backfill a
// Google Chat thread, the mouth when it delivers), and the brain reads it back as a conversation
// block. It is a rebuildable cache: every reader falls back to assembling the conversation from the
// channel (conversation-context.mjs) when the ledger is missing or unreadable, so losing it costs
// coverage, never correctness. No organ reads or writes it directly.
//
// A dashboard thread's key is its own document id in `threads`, so the ledger adds its fields and
// turns to the thread the dashboard created. A Google Chat thread is keyed `gchat-<thread>`.
//
// Turn ids are the channel's own message ids (a Chat message name, a dashboard message id, the
// envelope id of a delivery), so every writer's retry is a replay-safe upsert. Nothing here keeps a
// counter: three services write concurrently, and read-modify-write counters would drift.

import { COLLECTIONS, SUBCOLLECTIONS } from '../storage/collections.mjs';
import { toStr } from '../providers/to-str.mjs';
import { smartTruncate } from '../providers/vertex-text.mjs';
import { redactSecrets } from './compaction.mjs';

/**
 * The subcollection of a thread document that holds its turns. Named here until
 * agent/storage/collections.mjs SUBCOLLECTIONS lists it.
 */

const DEFAULTS = {
  max_turns: 12, // default; callers pass the contracts value
  budget_chars: 6000, // default; callers pass the contracts value
  per_turn_chars: 600, // default; callers pass the contracts value
  turn_store_chars: 8000, // default; callers pass the contracts value
  summary_max_chars: 1200, // default; callers pass the contracts value
  compact_after_turns: 30, // default; callers pass the contracts value
  turn_retention_days: 14, // default; callers pass the contracts value
};
const SWEEP_THREADS_PER_RUN = 100;
const SWEEP_TURNS_PER_THREAD = 50;
const EPOCH = '1970-01-01T00:00:00Z';

const threadPath = (threadKey) => `${COLLECTIONS.threads}/${threadKey}`;
const turnPath = (threadKey, turnId) => `${threadPath(threadKey)}/${SUBCOLLECTIONS.threadTurns}/${turnId}`;
const roleOf = (role) => (role === 'agent' ? 'agent' : 'user');

/**
 * Encodes a channel resource name as a Firestore document id. Google Chat names
 * ('spaces/AAA/threads/BBB') are case-sensitive over [A-Za-z0-9_-] plus '/'. Case is preserved
 * (lowercasing could merge two distinct threads, the worst failure for a context source) and '/'
 * becomes '~', which document ids allow and that alphabet excludes.
 *
 * @param {string} name
 * @returns {string}
 */
export function encodeResourceName(name) {
  return String(name || '').replace(/\//g, '~').replace(/[^A-Za-z0-9_~.-]/g, '_');
}

/**
 * The thread key for an Address (see providers/channel.mjs). Pure.
 *
 * @param {object|null} address - { channel, space?, thread? }
 * @returns {string|null} the key, or null when the address names no thread
 */
export function threadKeyFor(address) {
  if (!address || !address.channel) return null;
  if (address.channel === 'gchat') {
    const ref = address.thread || address.space;
    return ref ? `gchat-${encodeResourceName(ref)}` : null;
  }
  return address.thread ? encodeResourceName(address.thread) : null;
}

/**
 * Upserts one turn. Text is capped and scrubbed of secrets before it is stored, as is every copy on
 * the thread document.
 *
 * @param {object} p
 * @param {object} p.db           - a client from agent/storage/firestore.mjs
 * @param {string} p.threadKey    - from threadKeyFor()
 * @param {string} p.turnId       - the channel's id for this message
 * @param {'user'|'agent'} p.role
 * @param {string} [p.name]       - the speaker's display name (a user's name or email)
 * @param {string} p.text
 * @param {string} [p.source]     - which seam wrote it: intake, backfill, delivery
 * @param {object} [p.channelMeta] - { channel, space, thread } recorded on the thread document
 * @param {object} [p.config]
 * @param {Function} [p.log]
 * @param {Function} [p.clock]    - () => ms
 * @returns {Promise<boolean>} whether the turn was stored
 */
export async function appendTurn({
  db, threadKey, turnId, role, name = '', text, source = 'intake',
  channelMeta = {}, config = {}, log = () => {}, clock = Date.now,
}) {
  if (!db || !threadKey || !turnId || !text) return false;
  const cfg = { ...DEFAULTS, ...config };
  const ts = new Date(clock());
  const clean = redactSecrets(smartTruncate(toStr(text), cfg.turn_store_chars));

  try {
    const stored = await db.write(turnPath(threadKey, encodeResourceName(turnId)), {
      role: roleOf(role),
      ...(name ? { name } : {}),
      text: clean,
      ts,
      source,
    });
    if (!stored) {
      log('WARN', `thread-ledger: turn upsert failed (${threadKey}/${turnId})`);
      return false;
    }
    // Field-masked, so concurrent writers never clobber each other or the dashboard's own fields.
    const channel = channelMeta.channel || (threadKey.startsWith('gchat-') ? 'gchat' : 'dashboard');
    const fields = {
      channel: { stringValue: channel },
      ...(channel === 'gchat' && channelMeta.space ? { space: { stringValue: channelMeta.space } } : {}),
      ...(channel === 'gchat' && channelMeta.thread ? { thread: { stringValue: channelMeta.thread } } : {}),
      last_turn_at: { timestampValue: ts.toISOString() },
    };
    await db.patch(threadPath(threadKey), Object.keys(fields), fields);
    return true;
  } catch (e) {
    log('WARN', `thread-ledger: appendTurn failed (${threadKey}): ${e.message}`);
    return false;
  }
}

/**
 * Reads and renders a thread in the shape conversation-context.mjs assembleConversation returns, so
 * a reader can switch sources without changing its call site.
 *
 * @param {object} p
 * @param {object} p.db
 * @param {string} p.threadKey
 * @param {object} [p.config]
 * @param {Function} [p.log]
 * @returns {Promise<null | {
 *   block: string,
 *   turns: Array<{role: 'user'|'agent', name: string, text: string, ts: string}>,
 *   last_user_text: string|null,
 *   last_agent_text: string|null,
 *   cue_text: string,
 * }>} null when the ledger has nothing, or cannot be read (the caller falls back)
 */
export async function readThread({ db, threadKey, config = {}, log = () => {} }) {
  if (!db || !threadKey) return null;
  const cfg = { ...DEFAULTS, ...config };

  let thread;
  let rows;
  try {
    thread = await db.read(threadPath(threadKey), { strict: true });
    rows = await db.query(threadPath(threadKey), SUBCOLLECTIONS.threadTurns, [], {
      orderBy: 'ts', orderDirection: 'DESCENDING', limit: cfg.max_turns, strict: true,
    });
  } catch (e) {
    log('WARN', `thread-ledger: readThread failed (${threadKey}): ${e.message}`);
    return null;
  }
  const summary = thread?.summary || '';

  const trimTurn = (t) => {
    const s = (t || '').trim();
    return s.length <= cfg.per_turn_chars ? s : `${s.substring(0, cfg.per_turn_chars)} […trimmed]`;
  };
  const turns = (rows || [])
    .filter((r) => r.text)
    .map((r) => {
      const role = roleOf(r.role);
      return { role, name: role === 'agent' ? 'agent' : (r.name || 'user'), text: trimTurn(r.text), ts: r.ts || '' };
    })
    .reverse();
  if (turns.length === 0 && !summary) return null;

  // Over budget: drop the oldest whole turns, always keeping the newest.
  const render = (ts) => ts.map((t) => `[${t.name}${t.ts ? ` ${t.ts.substring(0, 16)}` : ''}] ${t.text}`).join('\n');
  let kept = turns;
  while (kept.length > 1 && render(kept).length > cfg.budget_chars) kept = kept.slice(1);

  const lastUser = [...kept].reverse().find((t) => t.role === 'user') || null;
  const lastAgent = [...kept].reverse().find((t) => t.role === 'agent') || null;
  const summarySection = summary
    ? `## Thread summary (compacted, derived — not verbatim; ranks below what the user actually said)\n${summary}\n\n`
    : '';

  return {
    block: `${summarySection}## Conversation (most recent ${kept.length} turns, oldest first)\n${render(kept)}`,
    turns: kept,
    last_user_text: lastUser?.text || null,
    last_agent_text: lastAgent?.text || null,
    cue_text: kept.slice(-4).map((t) => t.text).join(' '),
  };
}

/**
 * Retention sweep: deletes turns that are both folded into their thread's summary (ts at or before
 * summary_through_ts) and older than the retention horizon. Digest before prune: a turn not yet
 * folded is never deleted, whatever its age. Bounded per run; called on the archival cadence.
 *
 * @param {object} p
 * @param {object} p.db
 * @param {object} [p.config]
 * @param {Function} [p.log]
 * @param {number} [p.maxDeletes=200]
 * @param {Function} [p.clock]
 * @returns {Promise<number>} turns deleted
 */
export async function sweepThreadTurns({ db, config = {}, log = () => {}, maxDeletes = 200, clock = Date.now }) {
  const cfg = { ...DEFAULTS, ...config };
  const cutoff = new Date(clock() - cfg.turn_retention_days * 86_400_000).toISOString();
  let deleted = 0;

  try {
    // Only threads with a summary can have folded turns. Filtering on the watermark keeps the
    // dashboard's other threads from filling the page.
    const threads = await db.query('', COLLECTIONS.threads, [
      { field: 'summary_through_ts', op: 'GREATER_THAN', value: { timestampValue: EPOCH } },
    ], { orderBy: 'summary_through_ts', limit: SWEEP_THREADS_PER_RUN, strict: true });

    for (const t of threads) {
      if (deleted >= maxDeletes) break;
      const watermark = t.summary_through_ts || '';
      if (!watermark) continue;
      // Compared as instants: Firestore returns '...:00Z' for a whole second, which sorts after
      // '...:00.123Z' as a string.
      const bound = Date.parse(watermark) < Date.parse(cutoff) ? watermark : cutoff;
      const turns = await db.query(threadPath(t.id), SUBCOLLECTIONS.threadTurns, [
        { field: 'ts', op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: bound } },
      ], { orderBy: 'ts', limit: Math.min(SWEEP_TURNS_PER_THREAD, maxDeletes - deleted), strict: true });
      for (const turn of turns) {
        if (await db.del(turnPath(t.id, turn.id))) deleted++;
      }
    }
    if (deleted > 0) log('INFO', `[TELEMETRY] thread_turns_swept deleted=${deleted} horizon_days=${cfg.turn_retention_days}`);
  } catch (e) {
    log('WARN', `thread-ledger: sweep failed: ${e.message}`);
  }
  return deleted;
}

/**
 * Folds turns older than the recent window into the thread's summary, through one summarizing
 * model call. Triggered by code, never by a model. The write is guarded by the watermark: it lands
 * only if summary_through_ts is still the one this fold started from, so a replay advances it at
 * most once. The summary lives only on the thread document; memory is never written here.
 *
 * @param {object} p
 * @param {object} p.db
 * @param {string} p.threadKey
 * @param {Function} p.summarize - async (text, instruction, opts) => string
 * @param {object} [p.config]
 * @param {Function} [p.log]
 * @returns {Promise<boolean>} whether a fold happened
 */
export async function compactThread({ db, threadKey, summarize, config = {}, log = () => {} }) {
  if (!db || !threadKey || !summarize) return false;
  const cfg = { ...DEFAULTS, ...config };

  try {
    // Strict reads: an outage must not look like a thread with no summary, which would fold from
    // the first turn and overwrite the summary already there.
    const thread = await db.read(threadPath(threadKey), { strict: true });
    const prevSummary = thread?.summary || '';
    const watermark = thread?.summary_through_ts || '';

    // The trigger is a count from a bounded query; there are no counters to race.
    const rows = (await db.query(threadPath(threadKey), SUBCOLLECTIONS.threadTurns,
      watermark ? [{ field: 'ts', op: 'GREATER_THAN', value: { timestampValue: watermark } }] : [],
      { orderBy: 'ts', orderDirection: 'ASCENDING', limit: cfg.compact_after_turns + cfg.max_turns + 1, strict: true },
    )).filter((r) => r.text);
    if (rows.length < cfg.compact_after_turns + cfg.max_turns) return false;

    // Fold everything except the newest max_turns.
    const folding = rows.slice(0, rows.length - cfg.max_turns);
    const foldText = folding
      .map((r) => `[${roleOf(r.role) === 'agent' ? 'agent' : (r.name || 'user')}] ${r.text}`)
      .join('\n');
    const newWatermark = folding[folding.length - 1].ts || '';
    if (!newWatermark) return false;

    const instruction = 'Fold this conversation into a running thread summary. Preserve who-said-what attributions, open commitments, unresolved questions, and exact names/ids. Mark inferences as inferences. Be concise.';
    const input = prevSummary ? `EXISTING SUMMARY:\n${prevSummary}\n\nNEW TURNS:\n${foldText}` : foldText;
    const result = await summarize(input, instruction, { maxTokens: Math.ceil(cfg.summary_max_chars / 3) });
    if (!result) {
      log('WARN', `thread-ledger: compaction summarize failed (${threadKey}); the window keeps rendering verbatim`);
      return false;
    }
    const summary = redactSecrets(result.substring(0, cfg.summary_max_chars));

    const fresh = await db.read(threadPath(threadKey), { strict: true });
    if ((fresh?.summary_through_ts || '') !== watermark) {
      log('INFO', `thread-ledger: compaction lost the watermark race (${threadKey}); skipping`);
      return false;
    }
    await db.patch(threadPath(threadKey), ['summary', 'summary_through_ts'], {
      summary: { stringValue: summary },
      summary_through_ts: { timestampValue: newWatermark },
    }, { strict: true });
    log('INFO', `[TELEMETRY] thread_compact thread=${threadKey} folded_turns=${folding.length} summary_chars=${summary.length}`);
    return true;
  } catch (e) {
    log('WARN', `thread-ledger: compactThread failed (${threadKey}): ${e.message}`);
    return false;
  }
}
