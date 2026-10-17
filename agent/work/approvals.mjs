// agent/work/approvals.mjs: the approval gate's lifecycle. The checkpoint executor raises a gate
// (buildApprovalRecord, then create), a person resolves it from the dashboard or by replying in
// chat (approvalResolution), and the brain's poller resumes or fails the paused mission
// (checkPending). Also the pure rules the gate uses: what its description says, and which pending
// approvals a chat reply may resolve. It does not pause the plan or notify anyone (the checkpoint
// executor does) and does not parse replies (the brain does).

import { COLLECTIONS } from '../storage/collections.mjs';
import { applyTransition } from './work-transitions.mjs';

/** The poller acts on every Nth call, so it can ride a fast intake loop (about 15s at a 3s loop). */
const DEFAULT_CHECK_EVERY = 5; // default; callers pass the contracts value

// How many resolved, unprocessed approvals one poll takes. Only unprocessed approvals match the
// query, so a long history of resolved gates can never crowd a new one out of this window.
const RESOLVED_PAGE = 100;

const DECISIONS = new Set(['approved', 'rejected']);

/**
 * The approval document a gate writes to the approvals collection.
 *
 * `_processed` is stamped false here because the poller queries `_processed == false`: Firestore
 * cannot match a missing field, so a record without it would never resume. A resolver therefore
 * patches only the fields approvalResolution() returns and never rewrites the whole document.
 *
 * @param {object} p
 * @param {object} p.envelope         - the paused mission
 * @param {string} p.checkpointId
 * @param {number} p.checkpointIndex
 * @param {number} p.taskIndex
 * @param {string} p.title            - the gate task, in the plan's words
 * @param {string} p.description      - from describeApprovalGate()
 * @param {string} [p.projectName]
 * @param {string} [p.requestedBy]    - the person whose request the mission serves; '' for scheduled work
 * @param {string} [p.now]            - ISO timestamp
 * @returns {object}
 */
export function buildApprovalRecord({
  envelope, checkpointId, checkpointIndex, taskIndex, title, description,
  projectName = '', requestedBy = '', now = new Date().toISOString(),
}) {
  const address = envelope?.source_meta?.address || {};
  return {
    envelopeId: envelope.id,
    checkpointId,
    checkpointIndex,
    taskIndex,
    title: String(title || '').substring(0, 200),
    description,
    projectName,
    project_id: envelope.project_id || '',
    source_channel: envelope.source_channel || '',
    // The conversation the gate came from, so a chat reply resolves gates from its own conversation
    // (scopeApprovalsToConversation).
    source_thread: address.thread || '',
    requestedBy,
    requestedAt: now,
    status: 'pending',
    _processed: false,
  };
}

/**
 * The fields a resolver patches onto an approval: the decision, who made it and when. Recording who
 * approved is not optional: every approval shows who asked and who approved.
 *
 * @param {object} p
 * @param {'approved'|'rejected'} p.decision
 * @param {string} p.resolvedBy - the dashboard user's email
 * @param {string} [p.reason]   - why, for a rejection
 * @param {string} [p.now]      - ISO timestamp
 * @returns {{status: string, resolvedAt: string, resolvedBy: string, reason?: string}}
 */
export function approvalResolution({ decision, resolvedBy, reason, now = new Date().toISOString() }) {
  if (!DECISIONS.has(decision)) throw new Error(`approvalResolution: decision must be approved or rejected, got '${decision}'`);
  if (!resolvedBy) throw new Error('approvalResolution: resolvedBy is required; an approval records who resolved it');
  return { status: decision, resolvedAt: now, resolvedBy, ...(reason ? { reason } : {}) };
}

/**
 * Creates the approval checker the brain runs.
 *
 * @param {object}   deps
 * @param {object}   deps.db                    - a client from agent/storage/firestore.mjs; reads and writes approvals
 * @param {Function} deps.firestoreRead         - async (collection, docId) => envelope|null
 * @param {Function} deps.firestoreWrite        - async (collection, docId, data) => result
 * @param {Function} deps.writeHistory          - async (envelopeId, prevStatus, newStatus, actor, detail) => void
 * @param {Function} deps.recallMemory          - async (query, ctx) => memory
 * @param {Function} deps.resumeCheckpointPlan  - async (envelope, memory, approval) => void; continues the
 *                                                plan at the task after the gate
 * @param {Function} [deps.logger]              - (level, msg) => void
 * @param {number}   [deps.checkEvery=5]        - act on every Nth checkPending call
 * @param {Function} [deps.clock]               - () => ms (injectable for tests)
 * @returns {{create: Function, checkPending: Function, startPolling: Function, stopPolling: Function}}
 */
export function createApprovalChecker(deps) {
  const {
    db,
    firestoreRead,
    firestoreWrite,
    writeHistory,
    recallMemory,
    resumeCheckpointPlan,
    checkEvery = DEFAULT_CHECK_EVERY,
    clock = Date.now,
  } = deps;
  const log = deps.logger || ((level, msg) => console.log(`[approvals] ${level}: ${msg}`));
  // Checked here, not at the first approval: the poller marks an approval processed before it
  // resumes, so a missing resume would spend the approval and strand its mission.
  if (!db) throw new Error('createApprovalChecker: db is required');
  if (typeof resumeCheckpointPlan !== 'function') throw new Error('createApprovalChecker: resumeCheckpointPlan is required');

  let checkCount = 0;
  let intervalId = null;
  const now = () => new Date(clock()).toISOString();

  /**
   * Writes a gate's approval document.
   *
   * @param {string} approvalId
   * @param {object} record - from buildApprovalRecord()
   * @returns {Promise<boolean>} whether Firestore accepted it
   */
  async function create(approvalId, record) {
    const written = await db.write(`${COLLECTIONS.approvals}/${approvalId}`, record);
    if (!written) log('WARN', `Approval ${approvalId}: could not write the approval document`);
    return Boolean(written);
  }

  /**
   * Ends a paused mission at its gate through legal transitions only: a rejection ends it `rejected`;
   * an approved mission that cannot continue goes back to `active`, then `failed`. Top-level missions
   * are delivered so the person hears why.
   */
  async function failAtGate(envelope, { rejected = false, output, error, detail }) {
    const at = now();
    let current = envelope;
    for (const to of rejected ? ['rejected'] : ['active', 'failed']) {
      const step = applyTransition(current, { to, at, error });
      if (!step.ok) throw new Error(`Approval gate: cannot move ${envelope.id} to ${to}: ${step.reason}`);
      current = step.envelope;
    }
    Object.assign(envelope, current, { output, error });
    if (!envelope.parent_id) envelope.delivery_status = 'pending';
    await firestoreWrite(COLLECTIONS.work, envelope.id, envelope);
    await writeHistory(envelope.id, 'awaiting_approval', envelope.status, 'brain', detail);
  }

  /**
   * Acts on every resolved, unprocessed approval: a rejection fails its mission, an approval
   * resumes the plan at the task after the gate. Runs on every Nth call.
   */
  async function checkPending() {
    checkCount++;
    if (checkCount % checkEvery !== 0) return;

    try {
      const resolved = await db.query('', COLLECTIONS.approvals, [
        { field: 'status', op: 'IN', value: { arrayValue: { values: [...DECISIONS].map((s) => ({ stringValue: s })) } } },
        { field: '_processed', op: 'EQUAL', value: { booleanValue: false } },
      ], { noOrderBy: true, limit: RESOLVED_PAGE });

      for (const approval of resolved) {
        const approvalId = approval.id;
        const envelopeId = approval.envelopeId;
        if (!envelopeId || approval._processed || !DECISIONS.has(approval.status)) continue;

        // Marked first, so a mission that fails to resume is never resumed twice by later polls.
        await db.patch(`${COLLECTIONS.approvals}/${approvalId}`, ['_processed'], { _processed: { booleanValue: true } });

        const envelope = await firestoreRead(COLLECTIONS.work, envelopeId);
        if (!envelope || envelope.status !== 'awaiting_approval') {
          log('WARN', `Approval ${approvalId}: envelope ${envelopeId} is not awaiting approval (${envelope?.status})`);
          continue;
        }
        const by = approval.resolvedBy ? ` by ${approval.resolvedBy}` : '';
        log('INFO', `Approval ${approvalId} ${approval.status}${by}: acting on envelope ${envelopeId}`);

        // A rejection needs no resume state. It used to be checked after the resume state, so a
        // rejected mission missing that state stayed in awaiting_approval with its approval spent.
        if (approval.status === 'rejected') {
          await failAtGate(envelope, {
            rejected: true,
            output: `Rejected at the approval gate (approval ${approvalId})${by}.`,
            error: approval.reason || `Approval rejected${by}`,
            detail: `Approval rejected${by}`,
          });
          log('INFO', `Envelope ${envelopeId} rejected at the approval gate`);
          continue;
        }

        const meta = envelope.source_meta || {};
        const hasPlan = meta.paused_checkpoints || (Array.isArray(envelope._cp_spine) && envelope._cp_spine.length);
        if (!hasPlan || meta.paused_checkpoint_index === undefined || meta.paused_task_index === undefined) {
          // Without the paused plan there is nothing to resume. Failing loudly tells the person;
          // leaving it paused would strand the mission with its approval spent.
          log('WARN', `Approval ${approvalId}: envelope ${envelopeId} has no resume state; failing it`);
          await failAtGate(envelope, {
            output: `Approved${by}, but the paused plan could not be found, so the work could not continue.`,
            error: 'approved, but the mission has no paused plan to resume',
            detail: `Approved${by}; no resume state`,
          });
          continue;
        }

        // Continue the checkpoint plan at the task after the gate, deterministically. Re-deciding
        // would re-plan the gate's checkpoint and insert the same gate again, so a checkpoint that
        // bundles a gate with its gated action would ask for approval forever.
        log('INFO', `Approved: continuing the checkpoint plan for ${envelopeId} at the task after the gate`);
        try {
          const memory = await recallMemory(envelope.instruction, {
            instruction: envelope.instruction,
            context_summary: (envelope.context_summary || '').substring(0, 500),
          });
          await resumeCheckpointPlan(envelope, memory, approval);
        } catch (e) {
          // The approval is already spent, so a mission whose resume fails would sit paused forever
          // with nothing left to retry it. Fail it with the reason, and go on to the next approval.
          log('WARN', `Approval ${approvalId}: resuming ${envelopeId} failed: ${e.message}`);
          await failAtGate(envelope, {
            output: `Approved${by}, but the work could not continue: ${e.message}`,
            error: `resume after approval failed: ${e.message}`,
            detail: `Approved${by}; resume failed`,
          });
        }
      }
    } catch (e) {
      log('WARN', `Approval check error: ${e.message}`);
    }
  }

  /**
   * Starts periodic polling.
   *
   * @param {number} [intervalMs=3000]
   */
  function startPolling(intervalMs = 3000) {
    if (intervalId) return;
    intervalId = setInterval(() => checkPending(), intervalMs);
  }

  /** Stops periodic polling. */
  function stopPolling() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { create, checkPending, startPolling, stopPolling };
}

/**
 * The pending approvals a chat reply ("approve", "reject") may resolve: those from the reply's own
 * conversation, so one person's "approve" never resolves a gate raised in someone else's
 * conversation, and "approve all" never sweeps up unrelated gates.
 *
 * The refinement only narrows and never strands: the most specific discriminator that matches at
 * least one approval wins (thread, then project, then channel); one that matches none is skipped. A
 * single pending approval is returned as is.
 *
 * @param {object[]} approvals - pending approval documents
 * @param {object} [ctx]
 * @param {string} [ctx.thread]    - the reply's conversation thread
 * @param {string} [ctx.projectId] - the reply's project, if known
 * @param {string} [ctx.channel]   - the reply's channel
 * @returns {object[]}
 */
export function scopeApprovalsToConversation(approvals, ctx = {}) {
  if (!Array.isArray(approvals) || approvals.length === 0) return [];
  const scoped = approvals.filter(Boolean);
  if (scoped.length <= 1) return scoped;

  const { thread, projectId, channel } = ctx;
  const discriminators = [
    thread ? ((a) => a.source_thread === thread) : null,
    projectId ? ((a) => a.project_id === projectId) : null,
    channel ? ((a) => a.source_channel === channel) : null,
  ].filter(Boolean);

  for (const match of discriminators) {
    const narrowed = scoped.filter(match);
    if (narrowed.length > 0) return narrowed;
  }
  return scoped;
}

/**
 * The description an approval gate carries: what runs once it is approved, in the plan's own words,
 * so the person can see what they are saying yes to. Never the gate's accept_criteria: a planner
 * writes that as the gate's own pass condition ("Approval granted."), which then showed as the
 * request's description while it was still pending.
 *
 * @param {object} p
 * @param {string}   [p.message]       - an explicit approval message the plan carries; wins when present
 * @param {string[]} [p.next]          - the instructions that run after the gate, in order
 * @param {number}   [p.maxChars=1000]
 * @returns {string}
 */
export function describeApprovalGate({ message = '', next = [], maxChars = 1000 } = {}) {
  const clip = (s) => (s.length > maxChars ? `${s.slice(0, maxChars - 1).trimEnd()}…` : s);
  const explicit = String(message || '').trim();
  if (explicit) return clip(explicit);
  const steps = (Array.isArray(next) ? next : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (steps.length === 0) return 'If approved, the mission finishes and reports — nothing else waits on this approval.';
  return clip(`If approved, this runs next: ${steps.join(' Then: ')}`);
}
