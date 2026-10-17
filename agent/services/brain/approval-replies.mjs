// agent/services/brain/approval-replies.mjs: a person's "approve" or "reject" in chat, recognized
// deterministically before any model classifies the message, so an approval never becomes a new
// mission. The reply resolves the pending approvals of its own conversation (one when there is one, a
// numbered choice or "approve all" when there are several, a question back when it is unclear), the
// resolution patches only the fields approvalResolution() returns (rewriting the whole document would
// drop `_processed` and the poller would never see it), the person gets a receipt, and the approvals
// poller resumes or fails the paused missions at once. The brain is the only resolver of chat replies;
// the dashboard resolves its own buttons. Called by intake.mjs.

import { COLLECTIONS } from '../../storage/collections.mjs';
import { firestoreEncode } from '../../storage/firestore.mjs';
import { approvalResolution, scopeApprovalsToConversation } from '../../work/approvals.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { addressMeta } from './envelope-store.mjs';

export const APPROVE_PATTERN = /^(approve|approved|lgtm|go ahead|proceed|yes|ship it|better|land it)\b/i;
export const REJECT_PATTERN = /^(reject|rejected|deny|denied|no(?:\s|$)|stop|needs?\s*changes?|worse|revert|not yet)\b/i;

/**
 * Reads an approval reply out of a message: the person's own line (after any "User:" framing),
 * whether it approves or rejects, the numbers it names, and whether it approves all.
 *
 * @param {string} text
 * @returns {{decision: 'approved'|'rejected', userText: string, numbers: number[], all: boolean}|null}
 */
export function parseApprovalReply(text) {
  const lines = String(text || '').trim().split('\n');
  const line = lines.find((l) => l.startsWith('User: ')) || lines[lines.length - 1] || '';
  const userText = line.replace(/^User:\s*/, '').trim();
  let decision = null;
  if (APPROVE_PATTERN.test(userText)) decision = 'approved';
  else if (REJECT_PATTERN.test(userText)) decision = 'rejected';
  if (!decision) return null;
  const after = userText.match(/(?:approve|reject)\s+(.+)/i);
  const numbers = after ? (after[1].match(/\b\d+\b/g) || []).map((n) => parseInt(n, 10)) : [];
  return { decision, userText, numbers, all: /^approve\s+all\b/i.test(userText) };
}

/**
 * Which pending approvals a reply resolves.
 *
 * @param {object[]} pending - in the order the person sees them
 * @param {object} reply - from parseApprovalReply()
 * @returns {object[]|null} null when the reply does not say which, and the person must be asked
 */
export function chooseTargets(pending, reply) {
  if (pending.length === 1) return [pending[0]];
  if (reply.all && reply.decision === 'approved') return pending;
  const picked = reply.numbers.map((n) => pending[n - 1]).filter(Boolean);
  return picked.length > 0 ? picked : null;
}

/** The numbered list a person chooses from. */
export function listApprovals(pending) {
  return pending.map((a, i) => `${i + 1}. **${a.title || a.description || a.envelopeId || 'Untitled'}**`).join('\n');
}

/**
 * Creates the approval-reply handler.
 *
 * @param {object}   deps
 * @param {object}   deps.db            a client from agent/storage/firestore.mjs
 * @param {object}   deps.store         envelope-store.mjs
 * @param {object}   deps.approvals     the approvals poller (agent/work/approvals.mjs): checkPending()
 * @param {Function} deps.addressFor    (envelope or intake-shaped { source_meta, source_channel }) => Address
 * @param {Function} [deps.log]
 * @returns {{handle: Function}}
 */
export function createApprovalReplies({ db, store, approvals, addressFor, log = () => {} }) {
  /** Pending approvals whose mission is still paused at its gate, oldest first. */
  async function livePending() {
    const pending = await db.query('', COLLECTIONS.approvals, [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ], { noOrderBy: true, limit: 100, strict: true });
    const live = [];
    for (const a of pending) {
      const env = a.envelopeId ? await store.read(a.envelopeId).catch(() => null) : null;
      // A gate whose mission moved on (cancelled, resolved some other way) is not offered. One that
      // cannot be read is kept: a reply is never stranded by a failed read.
      if (env && env.status && env.status !== 'awaiting_approval') continue;
      live.push(a);
    }
    return live.sort((x, y) => String(x.requestedAt || '').localeCompare(String(y.requestedAt || '')));
  }

  async function reply(intake, { parentId = null, title, output }) {
    const id = store.newId('w');
    const at = store.iso();
    await store.firestoreWrite(COLLECTIONS.work, id, {
      id,
      // A reply about one mission sits under it; a reply about several is the request it answers.
      type: parentId ? 'T' : 'R',
      parent_id: parentId,
      status: 'complete',
      intent: 'notification',
      title,
      instruction: title,
      accept_criteria: '',
      output,
      children: [],
      context_summary: null,
      context_forward: null,
      error: null,
      source_channel: intake.source || 'dashboard',
      source_meta: addressMeta(intake.source_meta),
      created_at: at, started_at: at, completed_at: at, updated_at: at,
      iteration: 0,
      delivery_status: 'pending',
      delivery_address: addressFor({ source_meta: intake.source_meta, source_channel: intake.source }),
    });
    return id;
  }

  /**
   * Handles a message if it is an approval reply with pending approvals to resolve.
   *
   * @param {object} intake
   * @returns {Promise<'approved'|'rejected'|'disambiguation'|null>} null when it is not one, and
   *   classification goes on as usual ("yes" with nothing pending is an ordinary message)
   */
  async function handle(intake) {
    const parsed = parseApprovalReply(intake.source_meta?.raw_text || intake.text);
    if (!parsed) return null;
    let pending;
    try {
      pending = scopeApprovalsToConversation(await livePending(), {
        thread: intake.source_meta?.address?.thread || '',
        channel: intake.source || '',
      });
    } catch (e) {
      log('WARN', `approval reply check could not read the approvals (${e.message}); classifying the message instead`);
      return null;
    }
    if (pending.length === 0) return null;
    log('INFO', `approval reply: "${parsed.userText.substring(0, 60)}" ${parsed.decision}, ${pending.length} pending in this conversation`);

    const targets = chooseTargets(pending, parsed);
    if (!targets) {
      await reply(intake, {
        title: 'Which approval?',
        output: `You have ${pending.length} pending approvals:\n\n${listApprovals(pending)}\n\nReply with the number (e.g. \`approve 1\`), or \`approve all\`.`,
      });
      await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'resolution', 'resolved_at'],
        firestoreEncode({ status: 'resolved_approval', resolution: 'disambiguation', resolved_at: store.iso() }));
      return 'disambiguation';
    }

    const reason = parsed.decision === 'rejected' && parsed.userText.length > 20 ? parsed.userText : undefined;
    const resolvedBy = toStr(intake.source_meta?.sender).trim() || `${intake.source || 'chat'} reply`;
    for (const a of targets) {
      const fields = approvalResolution({ decision: parsed.decision, resolvedBy, reason, now: store.iso() });
      try {
        await db.patch(`${COLLECTIONS.approvals}/${a.id}`, Object.keys(fields), firestoreEncode(fields), { strict: true });
        log('INFO', `approval ${a.id} ${parsed.decision} by ${resolvedBy} (mission ${a.envelopeId})`);
      } catch (e) {
        log('WARN', `approval ${a.id} could not be resolved: ${e.message}`);
      }
    }

    // The receipt goes out before the work resumes, so it reaches the person ahead of the results.
    const titles = targets.map((a) => a.title || a.envelopeId).join(', ');
    await reply(intake, {
      parentId: targets[0].envelopeId || null,
      title: `Approval ${parsed.decision}`,
      output: parsed.decision === 'approved'
        ? `✅ Approved: ${titles}. Resuming work.`
        : `❌ Rejected: ${titles}. ${reason || 'Work stopped at this gate.'}`,
    });
    await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'resolution', 'resolved_at', 'approval_ids'],
      firestoreEncode({ status: 'resolved_approval', resolution: parsed.decision, resolved_at: store.iso(), approval_ids: targets.map((a) => a.id) }));

    // Act now rather than at the poller's next turn: an approval resumes the paused plan, a
    // rejection fails the mission with the reason.
    await approvals.checkPending();
    return parsed.decision;
  }

  return { handle };
}
