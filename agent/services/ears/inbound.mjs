// agent/services/ears/inbound.mjs: takes in one inbound message from any channel: the drop rules,
// the Chat repair pass, the intake write, then marking the message consumed on its channel. Reading
// a channel is dashboard-inbox.mjs and chat-inbox.mjs; what the intake holds is intake.mjs. Used by
// the ears' poll loops in main.mjs.
//
// An inbound message, whatever its channel:
//   { channel: 'dashboard'|'gchat', id, text, rawText, timestamp, sender, senderName,
//     address, attachments: [{ name, size, gcsPath }], conversation? }
// `text` is what the brain classifies (a Chat message carries its chat framing); `rawText` is the
// person's own message; `address` is the immutable Address the reply goes to.
//
// The order is the point. The intake is written before the message is marked consumed, and the
// drop rules remember a message only once its intake exists, so a failed write leaves the message
// to be read again on the next poll instead of losing it.

import { buildIntake, writeIntake } from './intake.mjs';

/**
 * Creates the handler.
 *
 * @param {object}   deps
 * @param {object}   deps.db           a client from agent/storage/firestore.mjs
 * @param {{intake: string}} deps.collections
 * @param {object}   deps.gate         from inbound-gate.mjs
 * @param {Function} deps.preprocess   from preprocess.mjs, applied to Chat messages
 * @param {Function} [deps.log]        (level, message, fields) logger
 * @param {Function} [deps.now]        clock in milliseconds (injectable for tests)
 * @returns {(msg: object, inbox: {consume: Function}) => Promise<'created'|'exists'|'duplicate'|'cooldown'>}
 */
export function createInboundHandler({ db, collections, gate, preprocess, log = () => {}, now = Date.now }) {
  return async function handle(msg, inbox) {
    const verdict = gate.check(msg);
    if (verdict !== 'accept') {
      log('INFO', `inbound ${verdict}: dropped`, { channel: msg.channel, message: msg.id, sender: msg.sender });
      await inbox.consume(msg);
      return verdict;
    }

    const text = msg.channel === 'gchat' ? await preprocess(msg.text) : msg.text;
    const intake = buildIntake(msg, { text, createdAt: new Date(now()).toISOString() });
    const result = await writeIntake(db, collections, intake);
    gate.record(msg);
    await inbox.consume(msg);
    log('INFO', result === 'created' ? 'intake written' : 'intake already existed for this message', {
      intake: intake.id, channel: msg.channel, sender: msg.sender, chars: intake.text.length,
      attachments: intake.attachments.length,
    });
    return result;
  };
}
