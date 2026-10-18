// agent/services/brain/intake-handlers.mjs: what the brain does with a classified message. A new
// mission is created and queued; a respond is answered at once, with no mission run; an attach or a
// continue resumes the mission it names when that mission is waiting on a person (a question, a
// blocker), and otherwise starts a follow-up mission that carries the earlier one as context, because
// a finished mission is never reopened and a running one is never written to from outside; a cancel
// stops the mission it names. Every path consumes the intake. Files shared with a message reach the
// mission as a block naming the exact file-get command for each, and the mission that takes an upload
// is noted on its `files` record. Called by intake.mjs.

import { mergeSharedFiles, sharedFilesBlock, uploadIdOf } from '../../files/shared-files.mjs';
import { COLLECTIONS } from '../../storage/collections.mjs';
import { firestoreEncode, StoreConflict } from '../../storage/firestore.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { addressMeta } from './envelope-store.mjs';

/** Statuses in which a mission waits for a person, and an answer resumes it. */
const AWAITING_PERSON = ['needs_input', 'blocked'];
/** Statuses a cancel can stop. */
const CANCELLABLE = ['active', 'pending', 'queued', 'waiting', 'needs_input', 'blocked', 'awaiting_approval', 'planned'];
const STATUS_QUERY = /\b(?:status|progress|how.{0,10}going|where.{0,10}at|what.{0,10}happening|any.{0,10}update|how.{0,10}coming)\b/i;

/**
 * Strips the chat framing the ears or a preprocessor put around a message ("[Current message ...]",
 * "User:"), for titles and instructions.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripChatFraming(text) {
  if (!text) return text || '';
  return String(text)
    .replace(/^\[Current message[^\]]*\]\s*/i, '')
    .replace(/^\[Chat messages since[^\]]*\]\s*(?:Someone:.*\n)*/i, '')
    .replace(/^\[Previous context[^\]]*\]\s*/i, '')
    .replace(/^(User|Someone|Human):\s*/i, '')
    .trim();
}

/**
 * The files a person shared with a message, as a block a mission's context carries: each with the
 * exact command that brings it into the mission's inbox (agent/files/shared-files.mjs).
 *
 * @param {Array<{name: string, size?: number, gcsPath?: string}>} attachments
 * @param {string} [missionId] the mission that takes them; without it the command names a placeholder
 * @returns {string}
 */
export function filesBlock(attachments, missionId = null) {
  return sharedFilesBlock(attachments, missionId);
}

/**
 * Creates the handlers.
 *
 * @param {object}   deps
 * @param {object}   deps.db                 a client from agent/storage/firestore.mjs (intake updates)
 * @param {object}   deps.store              envelope-store.mjs
 * @param {Function} deps.generateTitle      (text, type) => Promise<string>; vertex-text's
 * @param {object}   deps.memory             memory.mjs: writeMissionLine
 * @param {object}   [deps.projects]         the project registry
 * @param {Function} deps.writeStatusUpdate  (envelopeId, message) => Promise
 * @param {object}   deps.runner             { activeMissionId(), requestCancel(id, reason) }
 * @param {Function} deps.addressFor         (envelope) => Address
 * @param {Function} [deps.log]
 */
export function createIntakeHandlers({ db, store, generateTitle, memory, projects = null, writeStatusUpdate, runner, addressFor, log = () => {} }) {
  const projectFor = (decision) => {
    const id = decision?.project_id;
    if (id && projects?.get(id)) return id;
    return projects?.getDefaultId() || null;
  };

  async function consume(intake, envelopeId) {
    await db.patch(`${COLLECTIONS.intake}/${intake.id}`, ['status', 'consumed_by', 'consumed_at'],
      firestoreEncode({ status: 'consumed', consumed_by: envelopeId, consumed_at: store.iso() }));
  }

  /**
   * Notes on each uploaded file's `files` record the mission that took it. A field-masked patch, and
   * only on a record that exists: the dashboard writes the rest of the record, and a file shared
   * without one is left alone. Best effort: a mission never fails over its bookkeeping.
   */
  async function markTaken(attachments, missionId) {
    for (const a of attachments || []) {
      const uploadId = uploadIdOf(a?.gcsPath);
      if (!uploadId) continue;
      try {
        await db.patch(`${COLLECTIONS.files}/${uploadId}`, ['mission_id'], firestoreEncode({ mission_id: missionId }), { precondition: { exists: true } });
      } catch (e) {
        if (!(e instanceof StoreConflict)) log('WARN', `upload ${uploadId} not marked as taken by ${missionId}: ${e.message}`);
      }
    }
  }

  /** A person's reply as a resumed mission reads it: their words, then any files they shared with it. */
  function replyForward(intake, missionId) {
    return [toStr(intake.text), filesBlock(intake.attachments, missionId)].filter(Boolean).join('\n\n');
  }

  async function ack(mission, intake, text, key) {
    if (!text) return;
    await store.createCT(mission, {
      checkpointTitle: 'Acknowledge receipt',
      taskTitle: 'Write acknowledgment',
      taskOutput: text,
      taskIntent: 'ack',
      deliveryStatus: 'pending',
      deliveryAddress: addressFor({ source_meta: intake.source_meta, source_channel: intake.source }),
      ctKey: key,
    });
    await store.save(mission);
  }

  /**
   * Creates a mission from a message and queues it for the runner.
   *
   * @param {object} intake
   * @param {object} decision - the classification
   * @param {object} [opts]
   * @param {object} [opts.memory]       - recalled memory, carried so the runner need not recall again
   * @param {object} [opts.conversation] - the conversation block
   * @param {string} [opts.ackText]
   * @param {object} [opts.followUpOf]   - an earlier mission this one follows
   * @param {string} [opts.sourceText]   - the person's own words
   * @returns {Promise<object>} the mission
   */
  async function newMission(intake, decision, { memory: mem = null, conversation = null, ackText = null, followUpOf = null, sourceText = null } = {}) {
    const instruction = toStr(decision.instruction) || stripChatFraming(intake.text);
    // The id comes first: the files block names it in each file's fetch command.
    const id = store.newId('w');
    const context = [
      toStr(decision.context_summary),
      followUpOf
        ? `This follows mission ${followUpOf.id} (${followUpOf.status}): ${toStr(followUpOf.title || followUpOf.instruction).substring(0, 160)}.${followUpOf.output ? ` Its outcome so far: ${toStr(followUpOf.output).substring(0, 600)}` : ''}`
        : '',
      filesBlock(intake.attachments, id),
    ].filter(Boolean).join('\n\n');
    const at = store.iso();
    const mission = {
      id,
      type: 'M',
      parent_id: null,
      status: 'queued',
      intent: decision.intent || 'decide',
      title: await generateTitle(instruction.length > 100 ? instruction : (stripChatFraming(intake.text) || instruction), 'mission'),
      instruction,
      accept_criteria: toStr(decision.accept_criteria) || null,
      context_summary: context || null,
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: intake.source,
      source_meta: intake.source_meta || {},
      source_text: sourceText || stripChatFraming(intake.text) || null,
      project_id: followUpOf?.project_id && !decision.project_id ? followUpOf.project_id : projectFor(decision),
      context: Array.isArray(intake.attachments) && intake.attachments.length
        ? { inbound_files: intake.attachments }
        : null,
      stakes: ['routine', 'consequential', 'irreversible'].includes(decision.stakes) ? decision.stakes : 'routine',
      job_to_be_done: decision.job_to_be_done || null,
      created_at: at,
      started_at: null,
      completed_at: null,
      updated_at: at,
      iteration: 0,
      memory_context: mem && mem.recalled ? mem : null,
      conversation_context: conversation || null,
      thread_key: intake._thread_key || null,
      // Not delivered until the mission ends: completion sets it pending.
      delivery_status: 'internal',
    };
    await store.save(mission);
    await store.writeHistory(id, null, 'queued', 'brain', `Created from intake ${intake.id}${followUpOf ? ` (follows ${followUpOf.id})` : ''}`);
    await markTaken(intake.attachments, id);
    await ack(mission, intake, ackText, `ack-${id}`);
    await consume(intake, id);
    log('INFO', `mission ${id} queued from intake ${intake.id}`);
    return mission;
  }

  /**
   * Resumes a mission waiting on a person with their answer. Compare-and-swap, and only while the
   * mission is still waiting on them and nobody holds it.
   *
   * @returns {Promise<object|null>} the resumed mission, or null when it moved on meanwhile
   */
  async function resume(target, intake, decision, { conversation = null, contextForward }) {
    const from = target.status;
    const done = await store.update(target.id, (doc) => {
      if (!AWAITING_PERSON.includes(doc.status) || store.isClaimLive(doc)) return null;
      store.move(doc, 'active');
      doc.context_forward = contextForward;
      // Files shared with the answer join the mission's shared files, so every later task can see them.
      if (Array.isArray(intake.attachments) && intake.attachments.length) {
        doc.context = { ...(doc.context || {}), inbound_files: mergeSharedFiles(doc.context?.inbound_files, intake.attachments) };
      }
      if (conversation) doc.conversation_context = conversation;
      if (decision.project_id && projects?.get(decision.project_id)) doc.project_id = decision.project_id;
      // The earlier delivery (the question, the blocker) is done; the next one starts afresh.
      Object.assign(doc, {
        delivery_status: 'internal', delivered_at: null, delivered_channel: null,
        delivery_attempts: 0, delivery_error: null, next_delivery_attempt_at: null,
        _swf_state: null,
      });
      return doc;
    });
    if (!done) return null;
    await markTaken(intake.attachments, target.id);
    await store.writeHistory(target.id, from, 'active', 'brain', `Resumed by a reply: ${toStr(intake.text).substring(0, 100)}`);
    log('INFO', `mission ${target.id} resumed from ${from} by intake ${intake.id}`);
    return done;
  }

  /** A short reply about a mission in flight, under that mission, for the mouth to deliver. */
  async function statusReply(target, intake) {
    const id = store.newId('w');
    const at = store.iso();
    await store.firestoreWrite(COLLECTIONS.work, id, {
      id, type: 'T', parent_id: target.id, status: 'complete', intent: 'status_check',
      title: 'Status check', instruction: `Status check on ${target.id}`, accept_criteria: '',
      output: `I'm still working on that: "${toStr(target.title || target.instruction).substring(0, 160)}". Status: ${target.status}, step ${target.iteration || 0}.`,
      children: [], context_summary: null, context_forward: null, error: null,
      source_channel: intake.source, source_meta: addressMeta(intake.source_meta), project_id: target.project_id || null,
      created_at: at, started_at: at, completed_at: at, updated_at: at, iteration: 0,
      delivery_status: 'pending',
      delivery_address: addressFor({ source_meta: intake.source_meta, source_channel: intake.source }),
    });
    await consume(intake, id);
  }

  async function readTarget(id) {
    if (!id) return null;
    const env = await store.read(id);
    return env && env.type === 'M' ? { ...env, id } : null;
  }

  /**
   * A follow-up to work in flight or done: a status question gets a status reply, an answer to a
   * waiting question resumes the mission, anything else is a follow-up mission.
   */
  async function attach(intake, decision, opts = {}) {
    const target = await readTarget(decision.attach_to || decision.continue_mission);
    if (!target) {
      log('WARN', `attach target ${decision.attach_to || '(none)'} not found or not a mission; creating a new mission`);
      return newMission(intake, decision, opts);
    }
    if (target.status === 'needs_input') {
      const resumed = await resume(target, intake, decision, { conversation: opts.conversation, contextForward: replyForward(intake, target.id) });
      if (resumed) {
        await ack(resumed, intake, opts.ackText, `ack-resume-${resumed.id}-${intake.id}`);
        await consume(intake, resumed.id);
        return resumed;
      }
    }
    if (target.status === 'blocked') return continueMission(intake, { ...decision, continue_mission: target.id }, opts);
    if (['active', 'queued', 'waiting', 'awaiting_approval', 'pending', 'planned'].includes(target.status) && STATUS_QUERY.test(intake.text || '')) {
      await statusReply(target, intake);
      return target;
    }
    log('INFO', `attach to ${target.id} (${target.status}): starting a follow-up mission`);
    return newMission(intake, decision, { ...opts, followUpOf: target });
  }

  /** Resumes a blocked or questioning mission, or follows up on one that cannot be resumed. */
  async function continueMission(intake, decision, opts = {}) {
    const target = await readTarget(decision.continue_mission || decision.continue_envelope || decision.mission_id);
    if (!target) {
      log('WARN', `[TELEMETRY] classify_cascade: continue target missing or not a mission; new mission`);
      return newMission(intake, decision, opts);
    }
    if (AWAITING_PERSON.includes(target.status)) {
      const contextForward = target.status === 'blocked'
        ? [target.context_forward || '', `[UNBLOCKED] ${toStr(intake.text)}`, `[REVISED INSTRUCTION] ${toStr(decision.instruction || intake.text)}`, filesBlock(intake.attachments, target.id)].filter(Boolean).join('\n\n')
        : replyForward(intake, target.id);
      const resumed = await resume(target, intake, decision, { conversation: opts.conversation, contextForward });
      if (resumed) {
        await ack(resumed, intake, opts.ackText, `ack-resume-${resumed.id}-${intake.id}`);
        await consume(intake, resumed.id);
        return resumed;
      }
    }
    if (['active', 'queued', 'waiting', 'awaiting_approval', 'pending', 'planned'].includes(target.status)) {
      return attach(intake, { ...decision, attach_to: target.id, continue_mission: null }, opts);
    }
    // Finished: a finished mission is never reopened, so its continuation is a new mission that
    // carries it.
    log('INFO', `[TELEMETRY] classify_cascade: continue of a ${target.status} mission ${target.id}; follow-up mission`);
    return newMission(intake, decision, { ...opts, followUpOf: target });
  }

  /** Stops the mission a person asked to stop. */
  async function cancel(intake, decision) {
    const id = decision.cancel_target || decision.cancel_mission || decision.attach_to || decision.continue_mission;
    const target = await readTarget(id);
    if (!target) {
      log('WARN', `cancel target ${id || '(none)'} not found`);
      await consume(intake, null);
      return null;
    }
    if (!CANCELLABLE.includes(target.status)) {
      log('INFO', `cancel target ${target.id} is already ${target.status}`);
      await consume(intake, target.id);
      return target;
    }
    const reason = toStr(decision.reasoning || intake.text || 'Cancelled at the request of a person').substring(0, 500);
    if (runner.activeMissionId() === target.id) {
      // The runner holds it: it stops at its next decision and says so.
      runner.requestCancel(target.id, reason);
      await consume(intake, target.id);
      return target;
    }
    const from = target.status;
    const done = await store.update(target.id, (doc) => {
      if (!CANCELLABLE.includes(doc.status) || store.isClaimLive(doc)) return null;
      store.move(doc, 'cancelled', { reason });
      return doc;
    });
    if (!done) {
      runner.requestCancel(target.id, reason); // picked up meanwhile: stop it at its next decision
      await consume(intake, target.id);
      return target;
    }
    await store.writeHistory(target.id, from, 'cancelled', 'brain', `Cancelled: ${reason.substring(0, 100)}`);
    await cancelChildren(target.id);
    await writeStatusUpdate(target.id, `✅ Cancelled mission: "${toStr(target.title || target.instruction).substring(0, 100)}"`);
    await consume(intake, target.id);
    log('INFO', `mission ${target.id} cancelled (was ${from})`);
    return done;
  }

  async function cancelChildren(parentId, depth = 0) {
    if (depth > 4) return;
    const children = await store.query([{ field: 'parent_id', op: 'EQUAL', value: { stringValue: parentId } }], { noOrderBy: true, limit: 300 });
    for (const child of children) {
      if (CANCELLABLE.includes(child.status)) {
        try {
          await store.setStatus(child, 'cancelled', `Parent ${parentId} cancelled`, { event: { reason: `Parent ${parentId} cancelled` } });
        } catch (e) {
          log('WARN', `could not cancel ${child.id}: ${e.message}`);
        }
      }
      await cancelChildren(child.id, depth + 1);
    }
  }

  /**
   * Answers a conversational turn at once: a mission complete on creation, delivered by the mouth.
   */
  async function respond(intake, decision, text, { conversation = null } = {}) {
    const id = store.newId('w');
    const at = store.iso();
    const mission = {
      id, type: 'M', parent_id: null, status: 'complete', intent: 'respond',
      title: `Chat reply: ${stripChatFraming(intake.text || '').substring(0, 60)}`,
      instruction: toStr(decision.instruction) || stripChatFraming(intake.text),
      accept_criteria: null, context_summary: null, output: text, children: [], context_forward: null, error: null,
      source_channel: intake.source, source_meta: intake.source_meta || {}, source_text: intake.text || null,
      project_id: projects?.getDefaultId() || null, context: null, stakes: 'routine', job_to_be_done: 'respond',
      created_at: at, started_at: at, completed_at: at, updated_at: at, iteration: 1,
      memory_context: null, conversation_context: conversation || null, thread_key: intake._thread_key || null,
      delivery_status: 'pending',
      delivery_address: addressFor({ source_meta: intake.source_meta, source_channel: intake.source }),
    };
    await store.save(mission);
    await store.writeHistory(id, null, 'complete', 'brain', 'Answered at once (respond)');
    await memory.writeMissionLine(mission);
    await consume(intake, id);
    log('INFO', `responded to intake ${intake.id}: ${text.substring(0, 80)}`);
    return mission;
  }

  return { newMission, attach, continueMission, cancel, respond };
}
