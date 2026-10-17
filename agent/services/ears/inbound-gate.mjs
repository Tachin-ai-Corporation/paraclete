// agent/services/ears/inbound-gate.mjs: the ears' two drop rules for inbound messages: the same
// message twice inside the dedup window, and a second message from the same person inside the
// cooldown. It only decides; taking a message in or marking it consumed is inbound.mjs. Used by the
// ears for every channel.
//
// Both rules are keyed per person. A dashboard has several users, each in their own thread, so "yes"
// from one user must never be dropped because another user said "yes" a minute earlier, and one
// person's quick message must never put everyone else on cooldown.

const DEFAULT_DEDUP_WINDOW_MS = 300_000; // default; callers pass the contracts value
const DEFAULT_COOLDOWN_MS = 2_000; // default; callers pass the contracts value

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
  const recent = new Map(); // dedup key -> when it was taken in
  const lastFrom = new Map(); // sender -> when their last message was taken in

  function expire(t) {
    for (const [key, at] of recent) if (t - at > dedupWindowMs) recent.delete(key);
    for (const [sender, at] of lastFrom) if (t - at >= cooldownMs) lastFrom.delete(sender);
  }

  function check(msg) {
    const t = now();
    expire(t);
    if (recent.has(dedupKey(msg))) return 'duplicate';
    const last = lastFrom.get(msg.sender || '');
    if (last !== undefined && t - last < cooldownMs) return 'cooldown';
    return 'accept';
  }

  function record(msg) {
    const t = now();
    recent.set(dedupKey(msg), t);
    lastFrom.set(msg.sender || '', t);
  }

  return { check, record };
}
