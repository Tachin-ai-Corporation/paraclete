// agent/services/mouth/outbound.mjs: the mouth's one send call. Picks the token an Address's channel
// needs, hands the text to deliverToAddress (agent/providers/channel.mjs), and remembers when the
// agent last spoke to each Address, which the status notes consult. Deciding what to say is
// voice.mjs; which envelopes to send is delivery.mjs. Used by delivery.mjs and status-updates.mjs.

import { deliverToAddress } from '../../providers/channel.mjs';

/**
 * A delivery that can never succeed as addressed: no Chat space on the address, or Chat on an
 * instance without a Workspace account. Retrying cannot help, so the envelope fails at once.
 */
export class UndeliverableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UndeliverableError';
  }
}

/** One key per destination: channel, space and thread. */
export function addressKey(addr) {
  return [addr?.channel || '', addr?.space || '', addr?.thread || ''].join('|');
}

/** deliverToAddress logs with an "ERROR:" or "WARN:" prefix; this turns that into a log level. */
function channelLogger(log) {
  return (message, details) => {
    const text = String(message);
    const level = /^ERROR/.test(text) ? 'ERROR' : /^WARN/.test(text) ? 'WARN' : 'INFO';
    log(level, text.replace(/^(ERROR|WARN):\s*/, ''), details);
  };
}

/**
 * Creates the sender.
 *
 * @param {object}   deps
 * @param {Function} deps.getVmToken        () => Promise<string>: the VM's token, for dashboard writes
 * @param {Function} [deps.getChatToken]    () => Promise<string>: the agent's Workspace token with the
 *   send scope; absent when the instance has no Workspace account
 * @param {boolean}  [deps.replyInThread=true] chat.reply_in_thread
 * @param {Function} [deps.deliver]         deliverToAddress (injectable for tests)
 * @param {Function} [deps.log]             (level, message, fields) logger
 * @param {Function} [deps.now]             clock in milliseconds (injectable for tests)
 * @returns {{send: Function, lastSpokenAt: (addr: object) => number}}
 */
export function createOutbound({
  getVmToken, getChatToken = null, replyInThread = true, deliver = deliverToAddress, log = () => {}, now = Date.now,
}) {
  const spokenAt = new Map();

  /**
   * Sends text to an Address.
   *
   * @param {object} addr
   * @param {string} text
   * @param {object} [opts]
   * @param {string[]} [opts.mentions]    Chat only
   * @param {Array}    [opts.attachments] dashboard only: { name, size, gcsPath }
   * @returns {Promise<boolean>} whether the channel accepted the message
   * @throws {UndeliverableError} for Chat on an instance without a Workspace account
   */
  async function send(addr, text, { mentions = [], attachments = [] } = {}) {
    if (addr?.channel === 'gchat' && !getChatToken) {
      throw new UndeliverableError('Google Chat is not set up on this instance');
    }
    const token = addr?.channel === 'gchat' ? await getChatToken() : await getVmToken();
    const ok = await deliver(addr, text, { token, replyInThread, mentions, attachments, log: channelLogger(log) });
    if (ok) spokenAt.set(addressKey(addr), now());
    return ok;
  }

  /** When the agent last said anything to this Address in this run, in milliseconds; 0 for never. */
  function lastSpokenAt(addr) {
    return spokenAt.get(addressKey(addr)) || 0;
  }

  return { send, lastSpokenAt };
}
