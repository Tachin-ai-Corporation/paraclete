// agent/services/brain/approval-replies.mjs: a person's "approve" or "reject" in chat, recognized
// deterministically before any model classifies the message, so an approval never becomes a new
// mission. The reply resolves the pending approvals of its own conversation (one when there is one, a
// numbered choice or "approve all" when there are several, a question back when it is unclear), the
// resolution patches only the fields approvalResolution() returns (rewriting the whole document would
// drop `_processed` and the poller would never see it), the person gets a receipt, and the approvals
// poller resumes or fails the paused missions at once. The brain is the only resolver of chat replies;
// the dashboard resolves its own buttons. Called by intake.mjs.
//
// Who may approve. The dashboard's users list is the authority, in Chat as in the dashboard. A
// dashboard message comes from a dashboard user by construction (IAP and the users record). Anyone in
// the organization who can reach the agent's Workspace account may ask it things in Google Chat, but
// an approval from Chat counts only when the ears matched its sender to a dashboard user
// (source_meta.sender_email, agent/services/ears/chat-identity.mjs) and that user's record still
// holds a dashboard role; anyone else is told how to approve and nothing is resolved. A Chat reply
// resolves only gates whose mission came from the same Chat space (its own thread first); never a
// gate raised in the dashboard or in another space. A dashboard reply resolves only gates raised in
// its own thread (each dashboard user has their own), even when one gate is all that is pending: a
// "yes" in one person's conversation never decides another's gate. The Approvals page decides any.

import { isDashboardUser } from '../../storage/dashboard-users.mjs';
import { COLLECTIONS } from '../../storage/collections.mjs';
import { firestoreEncode, StoreConflict } from '../../storage/firestore.mjs';
import { approvalResolution, scopeApprovalsToConversation } from '../../work/approvals.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { addressMeta } from './envelope-store.mjs';

export const APPROVE_PATTERN = /^(approve|approved|lgtm|go ahead|proceed|yes|ship it|better|land it)\b/i;
export const REJECT_PATTERN = /^(reject|rejected|deny|denied|no(?:\s|$)|stop|needs?\s*changes?|worse|revert|not yet)\b/i;

/** The roles a dashboard user record holds (dashboard/lib/server/users.mjs); a record with any other is no user. */

/** What a Chat sender who is not a known dashboard user hears instead of a receipt. */
export const NOT_AUTHORIZED_REPLY = 'I can only take an approval in Chat from someone I know uses my dashboard, '
  + 'so nothing was approved or rejected. If you use the dashboard, decide it there under Approvals; once you '
  + 'have sent me a direct message here, I will recognize you in Chat too.';

/**
 * The pending approvals a Chat reply may resolve: those whose mission came from the reply's own
 * space, its own thread first. A gate whose mission could not be read is left out: its space is
 * unknown.
 *
 * @param {object[]} pending   from livePending(), each with `_address`
 * @param {object}   address   the reply's Address
 * @returns {object[]}
 */
export function chatScopedApprovals(pending, address) {
  const space = address?.space || '';
  if (!space) return [];
  const inSpace = pending.filter((a) => a._address?.channel === 'gchat' && a._address?.space === space);
  return scopeApprovalsToConversation(inSpace, { thread: address?.thread || '' });
}

/**
 * The pending approvals a dashboard reply may resolve: those raised in its own thread. Nothing when
 * the reply names no thread.
 *
 * @param {object[]} pending   from livePending()
 * @param {object}   address   the reply's Address
 * @returns {object[]}
 */
export function dashboardScopedApprovals(pending, address) {
  const thread = address?.thread || '';
  if (!thread) return [];
  return pending.filter((a) => a.source_channel === 'dashboard' && a.source_thread === thread);
}

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
  /**
   * Pending approvals whose mission is still paused at its gate, oldest first, each with `_address`:
   * where its mission came from (null when the mission could not be read).
   */
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
      const address = env?.source_meta?.address;
      live.push({ ...a, _address: address && typeof address === 'object' ? address : null });
    }
    return live.sort((x, y) => String(x.requestedAt || '').localeCompare(String(y.requestedAt || '')));
  }

  /**
   * Who is approving: the dashboard user's email, or null when a Chat sender is not known to be one.
   * The users record is read now, so a user removed since the ears matched them no longer counts. An
   * outage throws, and the intake is tried again; it never reads as "not a user".
   */
  async function approverOf(intake) {
    const meta = intake.source_meta || {};
    if (intake.source !== 'gchat') return toStr(meta.sender).trim() || `${intake.source || 'chat'} reply`;
    const email = toStr(meta.sender_email).trim().toLowerCase();
    if (!email || !email.includes('@') || email.includes('/')) return null;
    const user = await db.read(`${COLLECTIONS.users}/${email}`, { strict: true });
    return isDashboardUser(user) ? email : null;
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
   * @returns {Promise<'approved'|'rejected'|'disambiguation'|'not_authorized'|'already_decided'|null>} null
   *   when it is not one, and classification goes on as usual ("yes" with nothing pending is an
   *   ordinary message)
   */
  async function handle(intake) {
    const parsed = parseApprovalReply(intake.source_meta?.raw_text || intake.text);
    if (!parsed) return null;
    let pending;
    try {
      const live = await livePending();
      pending = intake.source === 'gchat'
        ? chatScopedApprovals(live, intake.source_meta?.address)
        : dashboardScopedApprovals(live, intake.source_meta?.address);
    } catch (e) {
      log('WARN', `approval reply check could not read the approvals (${e.message}); classifying the message instead`);
      return null;
    }
    if (pending.length === 0) return null;
    log('INFO', `approval reply: "${parsed.userText.substring(0, 60)}" ${parsed.decision}, ${pending.length} pending in this conversation`);

    const resolvedBy = await approverOf(intake);
    if (!resolvedBy) {
      log('WARN', `approval reply from ${toStr(intake.source_meta?.sender) || 'an unknown sender'} not taken: not a known dashboard user`);
      await reply(intake, { title: 'Approval not taken', output: NOT_AUTHORIZED_REPLY });
      await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'resolution', 'resolved_at'],
        firestoreEncode({ status: 'resolved_approval', resolution: 'not_authorized', resolved_at: store.iso() }));
      return 'not_authorized';
    }

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
    // Each gate is decided only if it is unchanged since it was read: of two people deciding at the
    // same moment (here, in the dashboard, in Chat), the second never overwrites the first.
    const decided = [];
    for (const a of targets) {
      const path = `${COLLECTIONS.approvals}/${a.id}`;
      const fields = approvalResolution({ decision: parsed.decision, resolvedBy, reason, now: store.iso() });
      try {
        const current = await db.readDoc(path);
        if (!current || current.data.status !== 'pending') {
          log('INFO', `approval ${a.id} was decided meanwhile; left as it is`);
          continue;
        }
        await db.patch(path, Object.keys(fields), firestoreEncode(fields), { strict: true, precondition: { updateTime: current.updateTime } });
        decided.push(a);
        log('INFO', `approval ${a.id} ${parsed.decision} by ${resolvedBy} (mission ${a.envelopeId})`);
      } catch (e) {
        log('WARN', e instanceof StoreConflict
          ? `approval ${a.id} changed while it was being decided; left as it is`
          : `approval ${a.id} could not be resolved: ${e.message}`);
      }
    }

    if (decided.length === 0) {
      await reply(intake, {
        parentId: targets[0].envelopeId || null,
        title: 'Already decided',
        output: 'Nothing changed: that approval was decided by someone else just before your reply. The Approvals page shows who decided it.',
      });
      await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'resolution', 'resolved_at'],
        firestoreEncode({ status: 'resolved_approval', resolution: 'already_decided', resolved_at: store.iso() }));
      return 'already_decided';
    }

    // The receipt goes out before the work resumes, so it reaches the person ahead of the results.
    const titles = decided.map((a) => a.title || a.envelopeId).join(', ');
    await reply(intake, {
      parentId: decided[0].envelopeId || null,
      title: `Approval ${parsed.decision}`,
      output: parsed.decision === 'approved'
        ? `✅ Approved: ${titles}. Resuming work.`
        : `❌ Rejected: ${titles}. ${reason || 'Work stopped at this gate.'}`,
    });
    await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'resolution', 'resolved_at', 'approval_ids'],
      firestoreEncode({ status: 'resolved_approval', resolution: parsed.decision, resolved_at: store.iso(), approval_ids: decided.map((a) => a.id) }));

    // Act now rather than at the poller's next turn: an approval resumes the paused plan, a
    // rejection fails the mission with the reason.
    await approvals.checkPending();
    return parsed.decision;
  }

  return { handle };
}
