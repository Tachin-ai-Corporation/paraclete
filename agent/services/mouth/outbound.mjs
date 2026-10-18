// agent/services/mouth/outbound.mjs: the mouth's one send call. Picks the token an Address's channel
// needs, hands the text to deliverToAddress (agent/providers/channel.mjs), and remembers when the
// agent last spoke to each Address, which the status notes consult, and how Google Chat last
// answered, which the mouth's health file reports. Deciding what to say is voice.mjs; which envelopes
// to send is delivery.mjs. Used by delivery.mjs and status-updates.mjs.

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
 * @returns {{send: Function, lastSpokenAt: (addr: object) => number, chatStatus: () => object}}
 */
export function createOutbound({
  getVmToken, getChatToken = null, replyInThread = true, deliver = deliverToAddress, log = () => {}, now = Date.now,
}) {
  const spokenAt = new Map();
  const iso = () => new Date(now()).toISOString();
  const chat = { sent: 0, refused: 0, last_sent_at: null, last_error: null, last_error_at: null };

  /**
   * Sends text to an Address.
   *
   * @param {object} addr
   * @param {string} text
   * @param {object} [opts]
   * @param {string[]} [opts.mentions]    Chat only
   * @param {string}   [opts.key]         Chat only: what this message is; the same key posts once
   * @param {Array}    [opts.attachments] dashboard only: { name, size, gcsPath }
   * @returns {Promise<boolean>} whether the channel accepted the message
   * @throws {UndeliverableError} for Chat on an instance without a Workspace account
   */
  async function send(addr, text, { mentions = [], attachments = [], key } = {}) {
    const isChat = addr?.channel === 'gchat';
    if (isChat && !getChatToken) {
      throw new UndeliverableError('Google Chat is not set up on this instance');
    }
    let token;
    try {
      token = isChat ? await getChatToken() : await getVmToken();
    } catch (err) {
      if (isChat) Object.assign(chat, { refused: chat.refused + 1, last_error: `no Workspace token: ${err.message}`, last_error_at: iso() });
      throw err;
    }
    const report = ({ ok, error }) => {
      if (!isChat) return;
      if (ok) Object.assign(chat, { sent: chat.sent + 1, last_sent_at: iso() });
      else Object.assign(chat, { refused: chat.refused + 1, last_error: error || 'refused', last_error_at: iso() });
    };
    const ok = await deliver(addr, text, {
      token, replyInThread, mentions, attachments, messageKey: key, report, log: channelLogger(log),
    });
    if (ok) spokenAt.set(addressKey(addr), now());
    return ok;
  }

  /** When the agent last said anything to this Address in this run, in milliseconds; 0 for never. */
  function lastSpokenAt(addr) {
    return spokenAt.get(addressKey(addr)) || 0;
  }

  /** How Google Chat has answered the mouth in this run: posts accepted and refused, the last error. */
  const chatStatus = () => ({ ...chat });

  return { send, lastSpokenAt, chatStatus };
}
