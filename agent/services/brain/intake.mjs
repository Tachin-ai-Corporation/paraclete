// agent/services/brain/intake.mjs: how the brain takes in what the ears wrote. Each pending intake
// (one per inbound message, agent/services/ears/intake.mjs) is claimed, its turn recorded in the
// conversation's thread ledger, checked first for an approval reply (approval-replies.mjs), then
// classified by the cortex (the organ that decides) with the conversation, recalled memory, the work
// in flight and recent missions in view: new_mission, attach, continue, cancel or respond. A respond
// may ground its draft on one whitelisted read first. A person gets a quick acknowledgment for work.
// The handlers in intake-handlers.mjs act on the classification; nothing here runs a mission.

import { COLLECTIONS } from '../../storage/collections.mjs';
import { firestoreEncode } from '../../storage/firestore.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { appendTurn, compactThread, readThread, threadKeyFor } from '../../context/thread-ledger.mjs';
import { extractCues, recentWorkDigest } from '../../context/work-recall.mjs';
import { classifyBlocks, cortexSystem, cortexUser, respondComposeBlocks } from './prompt-assembly.mjs';

/** Attempts at one intake before it is marked failed. */
export const MAX_INTAKE_ATTEMPTS = 3;
/** How long one respond read may take. */
const READ_TIMEOUT_MS = 10_000;
/** Sources that are the agent's own, which get no acknowledgment. */
const OWN_SOURCES = new Set(['brain', 'system', 'scheduler']);
/** What each read a respond may ask for does. Only reads of the agent's own work exist. */
export const RESPOND_READS = Object.freeze({
  recent_work: 'The work this agent finished, failed or stopped in the last 7 days, with outcomes. Use it to answer what has been done recently.',
});

/**
 * Creates the intake processor.
 *
 * @param {object}   deps
 * @param {object}   deps.db              a client from agent/storage/firestore.mjs
 * @param {object}   deps.store           envelope-store.mjs
 * @param {object}   deps.gateway         gateway-client.mjs: askJson
 * @param {Function} deps.enforceSchema   (raw, mode) => decision
 * @param {object}   deps.notifier        agent/providers/notifications.mjs: generateAck, extractCurrentMessage
 * @param {object}   deps.memory          memory.mjs: recall
 * @param {object}   deps.memoryFiles     memory.mjs createMemoryFiles()
 * @param {object}   deps.handlers        intake-handlers.mjs
 * @param {object}   deps.approvalReplies approval-replies.mjs
 * @param {object}   [deps.projects]      the project registry
 * @param {object}   [deps.processes]     the process registry
 * @param {Function} deps.capabilityMap   () => string
 * @param {Function} [deps.assembleConversation] ({ threadId }) => conversation | null (dashboard threads)
 * @param {object}   deps.settings        brainSettings()
 * @param {Function} [deps.summarize]     (text, instruction, opts) => summary; for thread compaction
 * @param {Function} [deps.log]
 */
export function createIntake(deps) {
  const {
    db, store, gateway, enforceSchema, notifier, memory, memoryFiles, handlers, approvalReplies,
    projects = null, processes = null, settings, log = () => {},
  } = deps;
  const intakePath = (id) => `${COLLECTIONS.intake}/${id}`;
  const setIntake = (id, fields) => db.patch(intakePath(id), Object.keys(fields), firestoreEncode(fields));

  /** The intakes waiting for the brain, oldest first. */
  async function pending() {
    return db.query('', COLLECTIONS.intake, [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ], { limit: 25 });
  }

  /**
   * Records the inbound turn in its thread's ledger. The ledger is a cache, never a gate: an intake
   * that names no thread is skipped and a failed write is only logged.
   */
  async function ledgerInboundTurn(intake) {
    const meta = intake.source_meta || {};
    const address = meta.address?.channel ? meta.address : null;
    const threadKey = threadKeyFor(address);
    if (!threadKey) return;
    const ok = await appendTurn({
      db, threadKey, turnId: meta.channel_msg_id || intake.id, role: 'user', name: meta.sender_name || meta.sender || '',
      text: meta.raw_text || intake.text, source: 'intake', channelMeta: address, config: settings.conversation, log,
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    if (!ok) return;
    intake._thread_key = threadKey;
    log('INFO', `[TELEMETRY] thread_turn_append thread=${threadKey} role=user source=intake`);
    if (deps.summarize) {
      compactThread({ db, threadKey, summarize: deps.summarize, config: settings.conversation, log })
        .catch((e) => log('WARN', `thread compaction failed (not fatal): ${e.message}`));
    }
  }

  /** The conversation the message came from: the Chat page the ears captured, the dashboard thread, or the ledger. */
  async function conversationFor(intake) {
    if (intake.conversation_ctx) {
      try { return JSON.parse(intake.conversation_ctx); } catch (e) { log('WARN', `the intake's conversation could not be read: ${e.message}`); }
    }
    const thread = intake.source_meta?.address?.thread;
    if (intake.source === 'dashboard' && thread && deps.assembleConversation) {
      const convo = await deps.assembleConversation({ threadId: thread });
      if (convo) return convo;
    }
    if (intake._thread_key) {
      const convo = await readThread({ db, threadKey: intake._thread_key, config: settings.conversation, log });
      if (convo) log('INFO', `[TELEMETRY] convo_assembled thread=${intake._thread_key} source=ledger turns=${convo.turns?.length || 0}`);
      return convo;
    }
    return null;
  }

  /** The top-level work in flight or waiting on a person, for the classifier and the acknowledgment. */
  async function scanActive() {
    const out = [];
    for (const status of ['active', 'queued', 'waiting', 'needs_input', 'blocked', 'awaiting_approval']) {
      const envs = await store.query([{ field: 'status', op: 'EQUAL', value: { stringValue: status } }], { noOrderBy: true, limit: 50 });
      for (const env of envs) {
        if (env.parent_id || env.type !== 'M') continue;
        out.push({
          id: env.id, type: env.type, instruction: toStr(env.instruction).substring(0, 200), status: env.status,
          blocker: env.blocker || null, blocker_type: env.blocker_type || null, updated_at: env.updated_at,
        });
      }
    }
    return out;
  }

  /** The most recently completed missions, for dedup and continuity. */
  async function scanRecent(limit = 5) {
    // The status and created_at index serves this; the type is filtered here, not in the query.
    const done = await store.query([
      { field: 'status', op: 'EQUAL', value: { stringValue: 'complete' } },
    ], { orderBy: 'created_at', orderDirection: 'DESCENDING', limit: 50 });
    return done
      .filter((e) => e.type === 'M')
      .sort((a, b) => String(b.completed_at || b.updated_at || '').localeCompare(String(a.completed_at || a.updated_at || '')))
      .slice(0, limit)
      .map((e) => ({
        id: e.id, instruction: toStr(e.instruction).substring(0, 120), output: toStr(e.output).substring(0, 150),
        status: e.status, completed_at: e.completed_at || e.updated_at, project_id: e.project_id || null,
      }));
  }

  /** The read a respond asked for, run in-process, read-only, with a time limit. */
  async function runRead(id) {
    if (id === 'recent_work') {
      const work = recentWorkDigest({ firestoreQuery: store.firestoreQuery, sinceDays: 7, limit: 50 });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`the ${id} read timed out`)), READ_TIMEOUT_MS).unref?.());
      return toStr(await Promise.race([work, timeout])).substring(0, 4000);
    }
    throw new Error(`no read named ${id}`);
  }

  function system() {
    return cortexSystem({
      deepTruths: memoryFiles.deepTruths(),
      workingMemory: memoryFiles.workingMemory(),
      projects: projects?.getAll() || {},
      processes: processes?.getAllProcesses() || {},
    });
  }

  /**
   * Classifies one intake and acts on it.
   *
   * @param {object} intake
   * @returns {Promise<string>} what was done: approved, rejected, disambiguation, respond, attach, ...
   */
  async function process(intake) {
    await projects?.ensureLoaded();
    await processes?.ensureLoaded();
    log('INFO', `processing intake ${intake.id} from ${intake.source}`);
    const sourceText = notifier.extractCurrentMessage(intake.source_meta?.raw_text || intake.text);
    await setIntake(intake.id, { status: 'claimed', claimed_at: store.iso() });

    const approval = await approvalReplies.handle(intake);
    if (approval) {
      log('INFO', `intake ${intake.id} was an approval reply (${approval})`);
      return approval;
    }

    const convo = await conversationFor(intake);
    const lastAgentReply = convo?.last_agent_text || null;
    const active = await scanActive();
    const ambient = await memory.recall(intake.text, {
      lastAgentReply,
      cues: extractCues([intake.text, convo?.cue_text || ''].filter(Boolean).join(' ')),
    });
    const respondReads = (settings.respondReads || []).filter((id) => RESPOND_READS[id]).map((id) => ({ id, description: RESPOND_READS[id] }));
    const recent = await scanRecent(5);
    const inbound = { text: intake.text, source: intake.source, source_meta: intake.source_meta || {} };

    const decision = await gateway.askJson({
      mode: 'classify',
      system: system(),
      user: cortexUser(classifyBlocks({
        inbound, conversation: convo?.block || null, lastAgentReply, memory: ambient, activeEnvelopes: active,
        recentMissions: recent, respondReads, capabilityMap: deps.capabilityMap(),
        projects: projects?.getAll() || {}, processes: processes?.getAllProcesses() || {},
      })),
      enforceSchema,
    });
    if (!decision || decision.error) {
      throw new Error(`classification failed: ${JSON.stringify(decision?.error || decision).substring(0, 200)}`);
    }
    let classification = decision.classification || 'new_mission';
    log('INFO', `intake ${intake.id} classified as ${classification}`);

    // Mission-bound work gets a second, sharper recall from the classifier's own reading of the request.
    let mem = ambient;
    if (['new_mission', 'attach', 'continue'].includes(classification) && (decision.instruction || decision.context_summary)) {
      const enriched = await memory.recall(intake.text, {
        instruction: decision.instruction,
        contextSummary: decision.context_summary,
        conversationHint: convo?.cue_text || null,
        cues: extractCues([intake.text, decision.instruction || '', convo?.cue_text || ''].filter(Boolean).join(' ')),
      });
      if (enriched.recalled && enriched.recalled !== ambient.recalled) {
        mem = { recalled: [ambient.recalled || '', enriched.recalled].filter(Boolean).join('\n\n---\n\n').substring(0, 4000) };
      }
    }

    let ackText = null;
    if (!OWN_SOURCES.has(intake.source) && ['new_mission', 'continue', 'attach'].includes(classification)) {
      ackText = await notifier.generateAck(intake.text || '', active, recent);
      await setIntake(intake.id, { quick_ack_sent: true });
    }
    const opts = { memory: mem, conversation: convo?.block || null, ackText, sourceText };

    if (classification === 'attach') { await handlers.attach(intake, decision, opts); return 'attach'; }
    if (classification === 'continue') { await handlers.continueMission(intake, decision, opts); return 'continue'; }
    if (classification === 'cancel') { await handlers.cancel(intake, decision); return 'cancel'; }

    if (classification === 'respond') {
      let text = toStr(decision.response).trim();
      const reads = Array.isArray(decision.reads) ? decision.reads : [];
      try {
        if (reads.length > 0) {
          // One read per respond, and only one the brain offered. A draft written to be grounded is
          // never sent ungrounded.
          const readId = reads.find((r) => respondReads.some((x) => x.id === r)) || null;
          if (reads.length > 1) log('WARN', `respond asked for ${reads.length} reads; running at most one (${readId || 'none'})`);
          if (!readId) {
            log('WARN', `respond asked for reads not offered (${JSON.stringify(reads)}); making it a mission`);
            text = '';
          } else {
            const result = await runRead(readId);
            const composed = await gateway.askJson({
              mode: 'respond_compose',
              system: system(),
              user: cortexUser(respondComposeBlocks({
                inbound, conversation: convo?.block || null, memory: ambient,
                toolGrounding: `[TOOL RESULT: ${readId}]\n${result}`, draft: text,
              })),
              enforceSchema,
            });
            const grounded = toStr(composed?.response).trim();
            if (composed?.error || !grounded) throw new Error('respond_compose returned nothing usable');
            text = grounded;
          }
        }
        if (text) {
          await handlers.respond(intake, decision, text, { conversation: convo?.block || null });
          return 'respond';
        }
        log('WARN', 'respond without a deliverable text; making it a mission');
      } catch (e) {
        log('WARN', `respond failed (${e.message}); making it a mission`);
      }
      classification = 'new_mission';
      if (!ackText && !OWN_SOURCES.has(intake.source)) ackText = await notifier.generateAck(intake.text || '', active, recent);
      opts.ackText = ackText;
    }

    await handlers.newMission(intake, decision, opts);
    return 'new_mission';
  }

  /**
   * One intake pass: every pending intake, oldest first. A failure puts the intake back for another
   * try, and after MAX_INTAKE_ATTEMPTS marks it failed with the reason.
   *
   * @returns {Promise<number>} how many intakes were handled
   */
  async function poll() {
    const items = await pending();
    let handled = 0;
    for (const intake of items) {
      try {
        try {
          await ledgerInboundTurn(intake);
        } catch (e) {
          log('WARN', `thread ledger inbound append failed (not fatal): ${e.message}`);
        }
        await process(intake);
        handled += 1;
      } catch (e) {
        log('ERROR', `intake ${intake.id} failed: ${e.message}`);
        await retryOrFail(intake, e.message);
      }
    }
    return handled;
  }

  async function retryOrFail(intake, error) {
    try {
      const fresh = await db.read(intakePath(intake.id));
      if (fresh && ['consumed', 'resolved_approval'].includes(fresh.status)) return;
      const attempts = (Number(fresh?.retry_count ?? intake.retry_count) || 0) + 1;
      if (attempts >= MAX_INTAKE_ATTEMPTS) {
        await setIntake(intake.id, { status: 'failed', error: `Failed ${attempts} times: ${String(error).substring(0, 500)}`, retry_count: attempts, failed_at: store.iso() });
        log('ERROR', `intake ${intake.id} failed for good after ${attempts} attempts`);
      } else {
        await setIntake(intake.id, { status: 'pending', claimed_at: null, retry_count: attempts });
      }
    } catch (e) {
      log('ERROR', `intake ${intake.id} could not be put back: ${e.message}`);
    }
  }

  /**
   * Startup recovery: an intake claimed by a process that is gone was never finished, so it goes back
   * to pending, counted as an attempt.
   */
  async function recover() {
    try {
      const claimed = await db.query('', COLLECTIONS.intake, [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'claimed' } },
      ], { noOrderBy: true, limit: 100 });
      for (const intake of claimed) await retryOrFail(intake, 'the brain restarted while handling it');
    } catch (e) {
      log('WARN', `intake recovery failed: ${e.message}`);
    }
  }

  return { poll, process, recover, ledgerInboundTurn };
}
