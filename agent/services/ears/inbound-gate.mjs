// agent/services/ears/inbound-gate.mjs: the ears' two drop rules for inbound messages: the same
// message twice inside the dedup window (a double send), and a second message from the same person
// inside the cooldown. It only decides; taking a message in or marking it consumed is inbound.mjs.
// Used by the ears for every channel.
//
// Both rules are keyed per person. A dashboard has several users, each in their own thread, so "yes"
// from one user must never be dropped because another user said "yes" a minute earlier, and one
// person's quick message must never put everyone else on cooldown.
//
// Both rules measure time between the messages themselves, by the time each was sent, not when the
// ears read it. After the ears were down, a backlog of messages sent minutes apart is read in one
// poll; measured at read time, all but the first from each person would be dropped. A message with no
// readable send time is measured at read time.

const DEFAULT_DEDUP_WINDOW_MS = 30_000; // default; callers pass the contracts value
const DEFAULT_COOLDOWN_MS = 2_000; // default; callers pass the contracts value
/** How long, by the clock, a taken-in message is remembered beyond the windows: a backlog read late
 * is still compared with the messages read just before it. */
const MEMORY_MS = 3_600_000;

/**
 * The dedup key: who said it, where, what, and which files came with it. Two uploads of a file with
 * the same name are different messages, so attachments count by their object path.
 *
 * @param {object} msg an inbound message (see inbound.mjs)
 * @returns {string}
 */
export function dedupKey(msg) {
  const addr = msg.address || {};
  const files = (msg.attachments || []).map((a) => a.gcsPath || a.name || '').sort().join(',');
  return [
    msg.sender || '',
    addr.channel || '',
    addr.space || '',
    addr.thread || '',
    String(msg.text || '').trim().toLowerCase(),
    files,
  ].join('\n');
}

/**
 * Creates a gate with its own memory. `check` decides without remembering; `record` remembers a
 * message once it has been taken in, so a message whose intake write failed is not dropped as a
 * duplicate when it is retried.
 *
 * @param {object}   [options]
 * @param {number}   [options.dedupWindowMs]
 * @param {number}   [options.cooldownMs]
 * @param {Function} [options.now] clock in milliseconds (injectable for tests)
 * @returns {{check: (msg: object) => 'accept'|'duplicate'|'cooldown', record: (msg: object) => void}}
 */
export function createInboundGate({
  dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
} = {}) {
  const recent = new Map(); // dedup key -> { sent, seen }
  const lastFrom = new Map(); // sender -> { sent, seen } of their last message taken in

  /** When the message was sent, in milliseconds; when it is read, if it carries no usable time. */
  const sentAt = (msg) => {
    const t = Date.parse(msg.timestamp);
    return Number.isFinite(t) ? t : now();
  };

  function expire() {
    const t = now();
    const keep = Math.max(dedupWindowMs, cooldownMs) + MEMORY_MS;
    for (const [key, at] of recent) if (t - at.seen > keep) recent.delete(key);
    for (const [sender, at] of lastFrom) if (t - at.seen > keep) lastFrom.delete(sender);
  }

  function check(msg) {
    expire();
    const sent = sentAt(msg);
    const same = recent.get(dedupKey(msg));
    if (same && Math.abs(sent - same.sent) <= dedupWindowMs) return 'duplicate';
    const last = lastFrom.get(msg.sender || '');
    if (last && Math.abs(sent - last.sent) < cooldownMs) return 'cooldown';
    return 'accept';
  }

  function record(msg) {
    const at = { sent: sentAt(msg), seen: now() };
    recent.set(dedupKey(msg), at);
    lastFrom.set(msg.sender || '', at);
  }

  return { check, record };
}
