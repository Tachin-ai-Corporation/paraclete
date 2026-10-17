// agent/services/mouth/voicing-context.mjs: the recent conversation the voice hears before it speaks,
// so a reply matches the thread's tone and refers naturally to what was just said. Read from the
// thread ledger at delivery time, keyed by the Address the reply goes to; the conversation snapshot
// the brain stored on the envelope stands in when the ledger has nothing. Only the tail is kept.
// Used by delivery.mjs.
//
// The snapshot was taken when the envelope was created, which for a long mission can be hours
// stale; the ledger includes everything said since, the agent's own acknowledgments too.

import { readThread as readLedgerThread, threadKeyFor } from '../../context/thread-ledger.mjs';

const DEFAULT_TAIL_CHARS = 1500; // default; callers pass the contracts value

/**
 * The tail of the conversation for one delivery.
 *
 * @param {object}   p
 * @param {object}   p.db         a client from agent/storage/firestore.mjs
 * @param {object}   p.address    the Address the reply goes to
 * @param {object}   p.envelope   the envelope being delivered (conversation_context is its snapshot)
 * @param {object}   [p.config]   contracts.conversation (voicing_tail_chars, and the ledger's budgets)
 * @param {Function} [p.readThread] agent/context/thread-ledger.mjs readThread (injectable for tests)
 * @param {Function} [p.log]
 * @returns {Promise<string>} '' when there is no conversation
 */
export async function voicingTail({ db, address, envelope, config = {}, readThread = readLedgerThread, log = () => {} }) {
  let block = String(envelope?.conversation_context || '').trim();
  const threadKey = threadKeyFor(address);
  if (threadKey) {
    const thread = await readThread({ db, threadKey, config, log });
    if (thread?.block) block = thread.block;
  }
  if (!block) return '';
  const tail = config.voicing_tail_chars || DEFAULT_TAIL_CHARS;
  return block.length > tail ? block.substring(block.length - tail) : block;
}
