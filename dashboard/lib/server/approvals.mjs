// dashboard/lib/server/approvals.mjs: approval gates as the dashboard shows and decides them. A gate is
// a document in `approvals` that the agent's checkpoint executor writes when a mission reaches a step
// that needs a person's yes (buildApprovalRecord in agent/work/approvals.mjs); the mission pauses as
// `awaiting_approval` until it is resolved. The dashboard lists the gates, and any dashboard user,
// member or admin, may approve or reject one. The agent's approvals poller (createApprovalChecker in
// the same agent module) then resumes or fails the paused mission. A person can also answer in chat;
// the brain resolves those itself (agent/services/brain/approval-replies.mjs).
//
// Resolving patches only the fields approvalResolution() returns, with a field mask. Never the whole
// document: the poller finds a resolved gate by `_processed == false`, and a whole-document rewrite
// from a partial copy would drop that field and strand the mission.
//
// Guarding against a double decision: the gate is read, refused unless it is still pending and its
// mission still waits on it, then patched with an `updateTime` precondition: two people deciding in
// the same instant cannot both win, and the later one is told the gate was already decided.
//
// Does not: decide anything about the mission itself (the agent's poller does), or read the work tree
// (work.mjs, which shows a mission's own gates through approvalsForMission()).

import { firestoreEncode, StoreConflict, StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { approvalResolution } from '../../../agent/work/approvals.mjs';
import { HttpError } from './errors.mjs';

/** The two ways a person decides a gate. */
export const DECISIONS = Object.freeze(['approved', 'rejected']);

/** The longest reason the dashboard stores with a decision. */
export const REASON_MAX_CHARS = 1000;

const PENDING_LIMIT = 100;
const RECENT_LIMIT = 50;
const RESOLVED_SHOWN = 30;
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MISSION_TITLE_CHARS = 160;

/** How a mission's status reads in "its mission is ..., no longer waiting for it". */
const MISSION_STATE = Object.freeze({
  pending: 'not started', planned: 'not started', queued: 'queued', active: 'running',
  waiting: 'paused on a timer', needs_input: 'waiting for an answer', needs_review: 'waiting for a review',
  blocked: 'blocked', complete: 'finished', failed: 'failed', rejected: 'rejected', timed_out: 'timed out',
  cancelled: 'cancelled', archived: 'archived',
});

/**
 * Refuses an id that cannot be one document id.
 *
 * @param {unknown} id
 * @param {string}  what  for the message
 * @returns {string}
 */
export function checkDocId(id, what = 'id') {
  const value = String(id ?? '');
  if (!DOC_ID.test(value)) throw new HttpError(400, `'${value.slice(0, 80)}' is not a valid ${what}`);
  return value;
}

/** Runs a Firestore call; an outage becomes a 503 the person can act on, with the details logged. */
async function guarded(runtime, what, call) {
  try {
    return await call();
  } catch (err) {
    if (err instanceof StoreUnavailable) {
      runtime.log('WARN', `${what}: ${err.message}`);
      throw new HttpError(503, 'the dashboard could not read or write its database just now; try again in a moment');
    }
    throw err;
  }
}

/**
 * An approval as the dashboard's API returns it. The agent's record uses camelCase names; the API
 * uses the dashboard's own.
 *
 * @param {string} id
 * @param {object} doc  the decoded document
 * @returns {object}
 */
export function shapeApproval(id, doc) {
  const d = doc || {};
  return {
    id,
    mission_id: d.envelopeId || null,
    checkpoint_id: d.checkpointId || null,
    checkpoint: Number.isInteger(d.checkpointIndex) ? d.checkpointIndex + 1 : null,
    task: Number.isInteger(d.taskIndex) ? d.taskIndex + 1 : null,
    title: typeof d.title === 'string' ? d.title : '',
    description: typeof d.description === 'string' ? d.description : '',
    project: d.projectName || d.project_id || '',
    channel: d.source_channel || '',
    requested_by: d.requestedBy || '',
    requested_at: d.requestedAt || null,
    status: d.status || 'pending',
    resolved_by: d.resolvedBy || null,
    resolved_at: d.resolvedAt || null,
    reason: d.reason || null,
    // The agent's poller marks a resolution processed once it acted on it.
    acted_on: d._processed === true,
  };
}

/**
 * Whether a pending gate can still be decided, and why not. A gate can be decided while its mission
 * waits on it: `awaiting_approval`, paused at this approval. A mission that could not be read keeps
 * its gate decidable, as the chat path does: an outage never strands a person's decision.
 *
 * @param {object} approval            from shapeApproval()
 * @param {object|null|undefined} mission  the mission; null when it does not exist, undefined when
 *   it could not be read
 * @returns {{live: boolean, reason: string|null}}
 */
export function gateState(approval, mission) {
  if (approval.status !== 'pending') return { live: false, reason: `it was already ${approval.status}` };
  if (mission === undefined) return { live: true, reason: null };
  if (mission === null) return { live: false, reason: 'its mission no longer exists' };
  if (mission.status !== 'awaiting_approval') {
    return { live: false, reason: `its mission is ${MISSION_STATE[mission.status] || mission.status} and no longer waiting for it` };
  }
  const paused = mission.source_meta?.paused_approval_id;
  if (paused && paused !== approval.id) return { live: false, reason: 'its mission is waiting on a later approval instead' };
  return { live: true, reason: null };
}

/** The mission an approval gates: the document, null when absent, undefined when unreadable. */
async function readMission(runtime, missionId) {
  if (!missionId || !DOC_ID.test(missionId)) return null;
  try {
    return await runtime.db.read(`${runtime.collections.work}/${missionId}`, { strict: true });
  } catch (err) {
    if (err instanceof StoreUnavailable) {
      runtime.log('WARN', `approvals: mission ${missionId} could not be read: ${err.message}`);
      return undefined;
    }
    throw err;
  }
}

const missionBrief = (id, mission) => (mission
  ? { id, title: String(mission.title || mission.instruction || '').slice(0, MISSION_TITLE_CHARS), status: mission.status || null }
  : null);

/** Each pending approval with its mission and whether it can still be decided. */
async function pendingWithGates(runtime) {
  const docs = await guarded(runtime, 'approvals: pending query', () => runtime.db.query('', runtime.collections.approvals, [
    { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
  ], { noOrderBy: true, limit: PENDING_LIMIT, strict: true }));
  return Promise.all(docs.map(async (doc) => {
    const approval = shapeApproval(doc.id, doc);
    const mission = await readMission(runtime, approval.mission_id);
    const state = gateState(approval, mission);
    return { ...approval, mission: missionBrief(approval.mission_id, mission), live: state.live, stale_reason: state.reason };
  }));
}

const instant = (value) => Date.parse(value || '') || 0;

/**
 * The approvals page: the pending gates (those that can still be decided first, newest first), then
 * the recently decided ones, newest decision first.
 *
 * "Recent" is the newest RECENT_LIMIT gates by request time, which needs only Firestore's automatic
 * single-field index on `requestedAt`; a gate is usually decided soon after it is raised.
 *
 * @param {object} runtime
 * @returns {Promise<{pending: object[], resolved: object[]}>}
 */
export async function listApprovals(runtime) {
  const [pending, recent] = await Promise.all([
    pendingWithGates(runtime),
    guarded(runtime, 'approvals: recent query', () => runtime.db.query('', runtime.collections.approvals, [], {
      orderBy: 'requestedAt', orderDirection: 'DESCENDING', limit: RECENT_LIMIT, strict: true,
    })),
  ]);
  pending.sort((a, b) => (a.live === b.live ? instant(b.requested_at) - instant(a.requested_at) : a.live ? -1 : 1));
  const resolved = recent
    .filter((doc) => DECISIONS.includes(doc.status))
    .map((doc) => shapeApproval(doc.id, doc))
    .sort((a, b) => instant(b.resolved_at) - instant(a.resolved_at))
    .slice(0, RESOLVED_SHOWN);
  return { pending, resolved };
}

/**
 * How many gates wait for a decision right now: the navigation badge. Gates whose mission moved on
 * are not counted, since nobody can act on them.
 *
 * @param {object} runtime
 * @returns {Promise<{pending: number}>}
 */
export async function countPending(runtime) {
  return { pending: (await pendingWithGates(runtime)).filter((a) => a.live).length };
}

/**
 * Every gate one mission raised, oldest first, each with whether it can still be decided.
 *
 * @param {object} runtime
 * @param {object} mission  the mission document, with its id
 * @returns {Promise<object[]>}
 */
export async function approvalsForMission(runtime, mission) {
  const docs = await guarded(runtime, `approvals: gates of ${mission.id}`, () => runtime.db.query('', runtime.collections.approvals, [
    { field: 'envelopeId', op: 'EQUAL', value: { stringValue: mission.id } },
  ], { noOrderBy: true, limit: PENDING_LIMIT, strict: true }));
  return docs
    .map((doc) => {
      const approval = shapeApproval(doc.id, doc);
      const state = approval.status === 'pending' ? gateState(approval, mission) : { live: false, reason: null };
      return { ...approval, mission: missionBrief(mission.id, mission), live: state.live, stale_reason: state.reason };
    })
    .sort((a, b) => instant(a.requested_at) - instant(b.requested_at));
}

/** A reason as stored: trimmed, at most REASON_MAX_CHARS, '' for none. */
export function normalizeReason(reason) {
  if (reason === undefined || reason === null) return '';
  if (typeof reason !== 'string') throw new HttpError(400, 'the reason must be text');
  return reason.trim().slice(0, REASON_MAX_CHARS);
}

/**
 * Approves or rejects a pending gate as the signed-in user. Refuses one that was already decided
 * (409, saying by whom), one whose mission no longer waits on it (409, saying why), and an unknown one
 * (404).
 *
 * @param {object} runtime
 * @param {object} o
 * @param {string} o.id        the approval's id
 * @param {string} o.decision  'approved' | 'rejected'
 * @param {string} [o.reason]  optional, stored with the decision; a rejection's reason becomes the
 *   mission's error
 * @param {{email: string}} o.user  who decides; any dashboard user may
 * @param {Date}   [o.now]
 * @returns {Promise<object>} the approval as decided
 */
export async function resolveApproval(runtime, { id, decision, reason, user, now = new Date() }) {
  const approvalId = checkDocId(id, 'approval id');
  if (!DECISIONS.includes(decision)) throw new HttpError(400, `the decision must be one of ${DECISIONS.join(', ')}`);
  const why = normalizeReason(reason);
  const path = `${runtime.collections.approvals}/${approvalId}`;

  const read = await guarded(runtime, `approvals: read ${approvalId}`, () => runtime.db.readDoc(path));
  if (!read) throw new HttpError(404, 'there is no such approval');
  const doc = read.data;
  const approval = shapeApproval(approvalId, doc);
  if (approval.status !== 'pending') {
    const by = approval.resolved_by ? ` by ${approval.resolved_by}` : '';
    throw new HttpError(409, `this approval was already ${approval.status}${by}`);
  }

  const mission = await guarded(runtime, `approvals: mission of ${approvalId}`, () => (approval.mission_id && DOC_ID.test(approval.mission_id)
    ? runtime.db.read(`${runtime.collections.work}/${approval.mission_id}`, { strict: true })
    : null));
  const state = gateState(approval, mission);
  if (!state.live) throw new HttpError(409, `this approval can no longer be decided: ${state.reason}`);

  const fields = approvalResolution({ decision, resolvedBy: user.email, reason: why || undefined, now: now.toISOString() });
  // Only if the gate is unchanged since it was read: of two people deciding at the same moment, the
  // second is told, and the decision on record is the one the agent acts on.
  try {
    await guarded(runtime, `approvals: resolve ${approvalId}`, () => runtime.db.patch(path, Object.keys(fields), firestoreEncode(fields), {
      strict: true, precondition: { updateTime: read.updateTime },
    }));
  } catch (err) {
    if (!(err instanceof StoreConflict)) throw err;
    const after = await guarded(runtime, `approvals: read back ${approvalId}`, () => runtime.db.read(path, { strict: true }));
    const by = after?.resolvedBy ? ` by ${after.resolvedBy}` : '';
    throw new HttpError(409, `this approval changed while you were deciding: it is now ${after?.status || 'gone'}${by}`);
  }
  runtime.log('INFO', `approval ${approvalId} ${decision} by ${user.email} (mission ${approval.mission_id})`);
  return { ...shapeApproval(approvalId, { ...doc, ...fields }), mission: missionBrief(approval.mission_id, mission), live: false, stale_reason: null };
}
