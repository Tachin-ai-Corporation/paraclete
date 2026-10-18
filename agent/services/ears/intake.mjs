// agent/services/ears/intake.mjs: the intake document the ears write for every inbound message the
// brain should see, and its create-only write. Classifying the intake (a new request, an answer to a
// waiting mission, an approval reply, or chat) is the brain's job; the ears only record what
// arrived, from whom, and the Address the reply must go to. Used by inbound.mjs.
//
// An intake's id comes from the channel's own message id, and the write only creates. A message
// read twice (a crash before it was marked consumed, a replayed poll) finds its intake already there
// and is not taken in again, so the brain never sees the same message as two requests.

import { firestoreDecode, StoreConflict } from '../../storage/firestore.mjs';
import { serializeAddress } from '../../providers/channel.mjs';
import { encodeResourceName } from '../../context/thread-ledger.mjs';

/** The most of a person's own message an intake keeps verbatim in source_meta.raw_text. */
const RAW_TEXT_CHARS = 8000;

/**
 * The intake id for a channel message: `i-<channel>-<message id>`, the message id made safe as a
 * document id. Deterministic, so the same message always maps to the same intake.
 *
 * @param {string} channel   'dashboard' | 'gchat'
 * @param {string} messageId dashboard message document id, or Chat message resource name
 * @returns {string}
 */
export function intakeIdFor(channel, messageId) {
  if (!messageId) throw new Error('intakeIdFor: messageId is required');
  return `i-${channel}-${encodeResourceName(messageId)}`;
}

/**
 * An Address as a plain object with only its set fields: the shape serializeAddress stores, so the
 * brain decodes the same Address the channel module would.
 */
function plainAddress(addr) {
  const encoded = serializeAddress(addr);
  return encoded.mapValue ? firestoreDecode(encoded.mapValue.fields) : null;
}

/** The text an intake carries when a person shared files without writing anything. */
function filesOnlyText(attachments) {
  return `Shared ${attachments.length} file${attachments.length === 1 ? '' : 's'}: ${attachments.map((a) => a.name).join(', ')}`;
}

/**
 * Builds the intake document for one inbound message. Pure.
 *
 * @param {object} msg            an inbound message (see inbound.mjs)
 * @param {object} [opts]
 * @param {string} [opts.text]    the text to classify, when preprocessing changed it (default msg.text)
 * @param {string} opts.createdAt ISO 8601 UTC
 * @returns {object} the intake document
 */
export function buildIntake(msg, { text, createdAt }) {
  const attachments = (msg.attachments || []).map((a) => ({ name: a.name || '', size: a.size || 0, gcsPath: a.gcsPath || '' }));
  let body = String(text ?? msg.text ?? '');
  if (!body.trim() && attachments.length > 0) body = filesOnlyText(attachments);

  const intake = {
    id: intakeIdFor(msg.channel, msg.id),
    text: body,
    source: msg.channel,
    status: 'pending',
    created_at: createdAt,
    attachments,
    source_meta: {
      address: plainAddress(msg.address),
      channel_msg_id: String(msg.id),
      raw_text: String(msg.rawText ?? msg.text ?? '').substring(0, RAW_TEXT_CHARS),
      sender: msg.sender || '',
      sender_name: msg.senderName || '',
    },
  };
  // A Chat sender the ears matched to a dashboard user (chat-identity.mjs). Chat names a sender only
  // by its user id; the brain takes an approval from Chat only with this email.
  if (msg.senderEmail) intake.source_meta.sender_email = String(msg.senderEmail);
  // The conversation around a Chat message, read from the same poll page. Dashboard threads have
  // no copy here: the brain reads them from the messages collection by thread.
  if (msg.conversation) intake.conversation_ctx = JSON.stringify(msg.conversation);
  return intake;
}

/**
 * Creates the intake document, and only creates it.
 *
 * @param {object} db          a client from agent/storage/firestore.mjs
 * @param {{intake: string}} collections
 * @param {object} intake      from buildIntake()
 * @returns {Promise<'created'|'exists'>} 'exists' when this message was already taken in
 * @throws {StoreUnavailable} when Firestore could not be written; the message is then left
 *   unconsumed, so the next poll tries again
 */
export async function writeIntake(db, collections, intake) {
  try {
    await db.commit([{ path: `${collections.intake}/${intake.id}`, data: intake, precondition: { exists: false } }]);
    return 'created';
  } catch (err) {
    if (err instanceof StoreConflict) return 'exists';
    throw err;
  }
}
