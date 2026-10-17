// agent/services/mouth/delivery.mjs: delivers every envelope whose delivery is pending to exactly its
// Address: a mission's answer or question, a direct reply, an acknowledgment, a status note. Each is
// voiced (voice.mjs) with the thread's recent conversation (voicing-context.mjs), sent with its
// mentions and attachments (outbound.mjs), recorded in the thread ledger, and marked delivered. A
// failed send backs off and retries, then fails for good. Deciding that something should be said is
// the brain's: it sets delivery_status to 'pending'. Used by the mouth's main.mjs on every poll.
//
// Fields the mouth reads on an envelope: id, type, parent_id, status, intent, output, instruction,
// context_summary, created_at, delivery_status, delivery_attempts, next_delivery_attempt_at,
// delivery_address, source_channel, source_meta (address, sender), conversation_context and
// context.attachments_export. Fields it writes, by field mask only: delivery_status ('delivered',
// 'failed' or 'internal'), delivered_at, delivered_channel, delivery_attempts, delivery_error and
// next_delivery_attempt_at.

import { createHash } from 'node:crypto';
import { firestoreEncode } from '../../storage/firestore.mjs';
import { parseAddress } from '../../providers/channel.mjs';
import { threadKeyFor } from '../../context/thread-ledger.mjs';
import { stripArtifactFooter } from '../../work/deliverable.mjs';
import { RUNNING_STATUSES } from '../../work/work-transitions.mjs';
import { UndeliverableError } from './outbound.mjs';

/** Work still under way: there is nothing to say about it yet, whatever its delivery_status. */
export const IN_PROGRESS_STATUSES = Object.freeze(['pending', 'planned', 'queued', ...RUNNING_STATUSES]);

/** A checkpoint or task reaches a person only as one of these. Everything else in it is internal. */
const CHILD_INTENTS = new Set(['ack', 'notification']);

const POLL_LIMIT = 50;
/** How many delivered envelopes the mouth remembers, to recognise one it has already said. */
const REMEMBERED = 500;
const ERROR_CHARS = 500;

const DEFAULT_RETRY = {
  max_attempts: 8, // default; callers pass the contracts value
  retry_backoff_base_seconds: 5, // default; callers pass the contracts value
  retry_backoff_max_seconds: 600, // default; callers pass the contracts value
};

/**
 * Where an envelope's message goes: its delivery_address, else the Address on its source_meta, else
 * the dashboard (or an unusable Chat address, for Chat work). Decoded through parseAddress, the one
 * Address decoder.
 *
 * @param {object} env a decoded envelope
 * @returns {object} the Address
 */
export function resolveAddress(env) {
  const channel = env.source_channel === 'gchat' ? 'gchat' : 'dashboard';
  const delivery = env.delivery_address;
  if (delivery && typeof delivery === 'object' && delivery.channel) {
    return parseAddress({ address: { mapValue: { fields: firestoreEncode(delivery) } } }, channel);
  }
  const meta = env.source_meta && typeof env.source_meta === 'object' ? firestoreEncode(env.source_meta) : null;
  return parseAddress(meta, channel);
}

/**
 * What to do with one pending envelope now. Pure.
 *
 * @param {object} env
 * @param {number} nowMs
 * @returns {'deliver'|'empty'|'internal'|'not_ready'|'backoff'|'skip'}
 *   empty: finished with nothing to say, so it is marked delivered; internal: a checkpoint or task
 *   that no one should hear, marked internal so it stops being read; not_ready, backoff, skip: left
 *   for a later poll
 */
export function deliveryDecision(env, nowMs) {
  if (!env?.id || env.delivery_status !== 'pending' || env.status === 'archived') return 'skip';
  if (IN_PROGRESS_STATUSES.includes(env.status)) return 'not_ready';
  const next = Date.parse(env.next_delivery_attempt_at || '');
  if ((env.delivery_attempts || 0) > 0 && Number.isFinite(next) && next > nowMs) return 'backoff';
  // Missions reach people; the one parented mission is the one a responsibility fired.
  if (env.parent_id && env.type !== 'M' && !CHILD_INTENTS.has(env.intent)) return 'internal';
  if (!String(env.output || '').trim()) return 'empty';
  return 'deliver';
}

/**
 * Who to @mention in Chat: the person who asked, else everyone in the space when the agent is
 * stuck and nobody in particular asked. Dashboard messages mention no one.
 *
 * @param {object} env
 * @param {object} addr
 * @returns {string[]} Chat user ids or emails
 */
export function mentionsFor(env, addr) {
  if (addr?.channel !== 'gchat') return [];
  const sender = String(env.source_meta?.sender || '').replace(/^users\//, '');
  if (sender) return [sender];
  if (env.status === 'needs_input' || env.status === 'blocked') return ['all'];
  return [];
}

/**
 * The outgoing files a delivery carries, as the dashboard shows them.
 *
 * @param {object} env
 * @returns {Array<{name: string, size: number, gcsPath: string}>}
 */
export function attachmentsOf(env) {
  const list = env.context?.attachments_export || env.context?.attachments;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a === 'object' && a.gcsPath)
    .map((a) => ({ name: a.name || '', size: Number(a.size) || 0, gcsPath: a.gcsPath }));
}

/**
 * What kind of message this is, for the voice. Given to the model as guidance, never put in the
 * text, so a message sent unvoiced does not carry it.
 *
 * @param {object} env
 * @returns {string}
 */
export function contextHintFor(env) {
  if (env.status === 'needs_input') return 'This is a question or request for the person: the agent needs their input to continue.';
  if (env.status === 'blocked') return 'The agent is blocked and needs help: say so clearly.';
  if (env.intent === 'notification') return 'This is a status notification: keep it brief and informational.';
  if (env.intent === 'ack') return 'This is a quick acknowledgment: keep it very short.';
  if (env.intent === 'respond') return 'This is a direct conversational reply: be polite, direct and helpful, and do not mention tasks or missions.';
  return '';
}

/**
 * The bookkeeping for a failed attempt: count it, back off exponentially, and fail for good at the
 * attempt cap (or at once for a delivery that can never succeed). Pure.
 *
 * @param {number}  previousAttempts
 * @param {string}  error
 * @param {number}  nowMs
 * @param {object}  [retry]    contracts.delivery
 * @param {boolean} [undeliverable]
 * @returns {{attempts: number, terminal: boolean, mask: string[], fields: object}} Firestore fields
 */
export function failureUpdate(previousAttempts, error, nowMs, retry = DEFAULT_RETRY, undeliverable = false) {
  const cfg = { ...DEFAULT_RETRY, ...retry };
  const attempts = (previousAttempts || 0) + 1;
  const terminal = undeliverable || attempts >= cfg.max_attempts;
  const backoffSeconds = Math.min(cfg.retry_backoff_base_seconds * 2 ** attempts, cfg.retry_backoff_max_seconds);
  const fields = {
    delivery_attempts: { integerValue: String(attempts) },
    delivery_error: { stringValue: String(error).slice(0, ERROR_CHARS) },
    next_delivery_attempt_at: { stringValue: new Date(nowMs + backoffSeconds * 1000).toISOString() },
  };
  if (terminal) fields.delivery_status = { stringValue: 'failed' };
  return { attempts, terminal, mask: Object.keys(fields), fields };
}

/** What a delivery said, as a short digest: the same envelope with the same status and output. */
export function contentDigest(env) {
  return createHash('sha256').update(`${env.status || ''}\n${env.output || ''}`).digest('hex').slice(0, 16);
}

/**
 * Creates the delivery pass.
 *
 * @param {object}   deps
 * @param {object}   deps.db           a client from agent/storage/firestore.mjs
 * @param {{work: string}} deps.collections
 * @param {object}   deps.outbound     from outbound.mjs
 * @param {Function} deps.voice        from voice.mjs
 * @param {Function} deps.voicingTail  ({ address, envelope }) => Promise<string> (voicing-context.mjs, bound)
 * @param {Function} deps.appendTurn   (turn: {threadKey, turnId, role, text, channelMeta}) => Promise<boolean>
 * @param {object}   [deps.retry]      contracts.delivery
 * @param {Function} [deps.log]        (level, message, fields) logger
 * @param {Function} [deps.now]        clock in milliseconds (injectable for tests)
 * @returns {{pass: () => Promise<{delivered: number, failed: number, waiting: number}>}}
 */
export function createDelivery({
  db, collections, outbound, voice, voicingTail, appendTurn, retry = DEFAULT_RETRY, log = () => {}, now = Date.now,
}) {
  const path = (id) => `${collections.work}/${id}`;
  const said = new Map(); // envelope id -> contentDigest of what was delivered

  function remember(id, digest) {
    said.delete(id);
    said.set(id, digest);
    for (const key of said.keys()) {
      if (said.size <= REMEMBERED) break;
      said.delete(key);
    }
  }

  async function mark(env, channel) {
    await db.patch(path(env.id), ['delivered_at', 'delivered_channel', 'delivery_status'], {
      delivered_at: { stringValue: new Date(now()).toISOString() },
      delivered_channel: { stringValue: channel },
      delivery_status: { stringValue: 'delivered' },
    }, { strict: true });
  }

  async function recordInLedger(env, addr, text) {
    const threadKey = threadKeyFor(addr);
    if (!threadKey) return;
    const turn = { threadKey, turnId: `d-${env.id}`, role: 'agent', text, channelMeta: addr };
    try {
      if (!(await appendTurn(turn))) await appendTurn(turn);
    } catch (err) {
      log('WARN', 'thread ledger append failed after delivery', { envelope: env.id, error: err.message });
    }
  }

  async function deliverOne(env) {
    const addr = resolveAddress(env);
    if (addr.channel === 'gchat' && !addr.space) throw new UndeliverableError('the address names no Chat space');
    const digest = contentDigest(env);

    // A whole-document write of a stale copy can set delivery_status back to 'pending' after the
    // mouth marked it delivered. The same status and output again is that, not something new to say.
    if (said.get(env.id) === digest) {
      log('INFO', 'envelope already delivered with this content; marking it delivered again', { envelope: env.id });
      await mark(env, addr.channel);
      return false;
    }

    let body = env.output;
    if (!stripArtifactFooter(body)) {
      const files = attachmentsOf(env).length;
      const noun = files ? `${files} file${files === 1 ? ' was' : 's were'} produced` : 'the work completed';
      body = `I finished this, but no written summary was generated: ${noun}. Details below:\n\n${body}`;
      log('WARN', 'envelope reached the mouth with only an artifact footer; prefixed a plain summary', { envelope: env.id });
    }

    const voiced = await voice({
      rawText: body,
      question: env.instruction || env.context_summary || '',
      contextHint: contextHintFor(env),
      convoTail: await voicingTail({ address: addr, envelope: env }),
    });

    if (voiced.action === 'deliver') {
      const ok = await outbound.send(addr, voiced.text, { mentions: mentionsFor(env, addr), attachments: attachmentsOf(env) });
      if (!ok) throw new Error(`the ${addr.channel} channel refused the message`);
      remember(env.id, digest);
      await recordInLedger(env, addr, voiced.text);
      log('INFO', 'delivered', {
        envelope: env.id, channel: addr.channel, status: env.status, intent: env.intent || '', voiced: voiced.voiced,
        chars: voiced.text.length,
      });
    } else {
      remember(env.id, digest);
      log('INFO', 'suppressed as internal', { envelope: env.id, chars: body.length });
    }

    // The brain may have rewritten the envelope while it was being voiced. Mark it delivered only
    // if it still holds what was said; a new version stays pending and goes out on the next poll.
    // The message is out either way, so a failure here is not a failed delivery: the envelope stays
    // pending, and the next poll recognises it and only marks it.
    try {
      const fresh = await db.readDoc(path(env.id));
      if (fresh && contentDigest(fresh.data) !== digest) {
        log('INFO', 'envelope changed while it was delivered; its new content goes out next', { envelope: env.id });
      } else if (fresh) {
        await mark(env, addr.channel);
      }
    } catch (err) {
      log('WARN', 'delivered, but not yet marked delivered; the next poll marks it', { envelope: env.id, error: err.message });
    }
    return true;
  }

  async function recordFailure(env, err) {
    const update = failureUpdate(env.delivery_attempts, err.message || err, now(), retry, err instanceof UndeliverableError);
    try {
      await db.patch(path(env.id), update.mask, update.fields, { strict: true });
    } catch (bookErr) {
      log('ERROR', 'delivery failure could not be recorded', { envelope: env.id, error: bookErr.message });
    }
    log(update.terminal ? 'ERROR' : 'WARN', update.terminal ? 'delivery failed for good' : 'delivery failed; will retry', {
      envelope: env.id, attempts: update.attempts, error: String(err.message || err).slice(0, 200),
    });
  }

  /**
   * One pass over the pending envelopes, oldest first, so an acknowledgment goes out before the
   * answer that follows it. A strict query: an outage throws instead of looking like silence.
   */
  async function pass() {
    const rows = await db.query('', collections.work, [
      { field: 'delivery_status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ], { noOrderBy: true, limit: POLL_LIMIT, strict: true });
    rows.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));

    const counts = { delivered: 0, failed: 0, waiting: 0 };
    for (const env of rows) {
      const decision = deliveryDecision(env, now());
      if (decision === 'not_ready' || decision === 'backoff' || decision === 'skip') {
        counts.waiting += 1;
        continue;
      }
      try {
        if (decision === 'internal') {
          // Left pending, it would be read on every poll and, never archived, fill the poll window.
          await db.patch(path(env.id), ['delivery_status'], { delivery_status: { stringValue: 'internal' } }, { strict: true });
          log('INFO', 'checkpoint or task marked internal: nothing in it is for a person', { envelope: env.id, intent: env.intent || '' });
        } else if (decision === 'empty') {
          await mark(env, resolveAddress(env).channel);
          log('WARN', 'envelope finished with no output; marked delivered with nothing said', { envelope: env.id });
        } else if (await deliverOne(env)) {
          counts.delivered += 1;
        }
      } catch (err) {
        counts.failed += 1;
        await recordFailure(env, err);
      }
    }
    return counts;
  }

  return { pass };
}
