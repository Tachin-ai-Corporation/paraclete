// agent/services/brain/completion.mjs: the one way a mission ends a run, whether it completed, failed,
// blocked or stopped to ask a question. In order: compose a deliverable that is never empty, move the
// status through the transition table, address the delivery for the mouth, write the mission record
// and publish its artifacts, save, then the records a finished mission leaves (the working-memory line,
// the lessons, the responsibility's learnings) and the effects on other work (dependents, project
// completion, event responsibilities, context promotion). Every step after the save is best effort:
// none of them can undo a finished mission. The reply's attachments are the mission's outgoing files
// (its 'out' records in `files`, whether file-share or the artifact export sent them), set on
// `context.attachments_export` for the mouth. Called by the actions and the runner.

import { join } from 'node:path';
import { replyAttachments } from '../../files/outgoing.mjs';
import { COLLECTIONS } from '../../storage/collections.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { composeDeliverable } from '../../work/deliverable.mjs';
import { writeMissionRecord } from '../../work/mission-record.mjs';

/** The event a mission's end fires for event responsibilities. A question is not an end. */
export function completionEvent(status) {
  if (status === 'complete') return 'on_complete';
  if (status === 'failed' || status === 'blocked') return 'on_failure';
  return null;
}

/**
 * Creates the completion step.
 *
 * @param {object}   deps
 * @param {object}   deps.store          from envelope-store.mjs
 * @param {object}   deps.memory         from memory.mjs: writeMissionLine, recordLessons
 * @param {object}   [deps.projects]     the project registry
 * @param {object}   [deps.artifacts]    the artifact manager (agent/work/artifacts.mjs)
 * @param {Function} [deps.fireEvent]    (eventType, eventContext) => Promise; the scheduler's
 * @param {Function} deps.addressFor     (envelope) => the Address a reply goes to
 * @param {Function} [deps.missionDir]   (missionId) => the mission tree's path
 * @param {object}   [deps.usage]        token accounting: summary(missionId), drop(missionId)
 * @param {Function} [deps.outgoingFiles] (missionId) => Promise<records>: the mission's 'out' records
 *   (agent/files/outgoing.mjs listOutgoing, bound to the db); without it, a reply carries only what
 *   the artifact export attached
 * @param {object}   [deps.settings]     { minDeliverableChars, learningsMaxEntries }
 * @param {Function} [deps.log]
 * @returns {{completeEnvelope: Function}}
 */
export function createCompletion({
  store, memory, projects = null, artifacts = null, fireEvent = null, addressFor, missionDir = null,
  usage = null, outgoingFiles = null, settings = {}, log = () => {},
}) {
  const learningsMax = settings.learningsMaxEntries || 5; // default; callers pass the contracts value

  /**
   * Ends a mission's run.
   *
   * @param {object} envelope - changed in place and saved
   * @param {object} opts
   * @param {'complete'|'failed'|'blocked'|'needs_input'} opts.status
   * @param {string} [opts.output]
   * @param {string} [opts.historyDetail]
   * @param {string} [opts.blocker]
   * @param {string} [opts.blockerType]
   * @param {Array}  [opts.priorResults] - for a deliverable composed from mission state
   * @param {boolean} [opts.skipArtifacts]
   * @param {boolean} [opts.skipMemory]
   * @param {boolean} [opts.skipCleanup]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function completeEnvelope(envelope, opts) {
    const {
      status, output, historyDetail, blocker = null, blockerType = null, priorResults = null,
      skipArtifacts = false, skipMemory = false, skipCleanup = false,
    } = opts;

    // A deliverable is never empty: a real synthesis is used as written, and an empty or
    // artifact-only body is replaced by a summary composed from the mission's own state, headed by
    // the status the mission is ending in, not the one it is leaving.
    const deliverable = composeDeliverable({ ...envelope, status, ...(blocker ? { blocker } : {}) }, {
      synthesis: output, priorResults, minChars: settings.minDeliverableChars,
    });
    if (deliverable.composed) log('WARN', `[deliverable] empty synthesis on ${envelope.id} (${status}); composed a summary from mission state`);

    let hops;
    try {
      hops = store.move(envelope, status, {
        output: deliverable.body,
        error: status === 'failed' ? toStr(output || deliverable.body).substring(0, 2000) : undefined,
        blocker: blocker || undefined,
        blockerType: blockerType || undefined,
      });
    } catch (e) {
      log('WARN', `completion of ${envelope.id} as ${status} refused: ${e.message}`);
      return { ok: false, error: e.message };
    }
    envelope.output = deliverable.body;

    // A parentless mission's outcome goes back to whoever asked. A scheduled mission's parent is its
    // responsibility, so its outcome stays in the dashboard.
    if (!envelope.parent_id) {
      envelope.delivery_status = 'pending';
      envelope.delivery_address = addressFor(envelope);
    } else if (!envelope.delivery_status) {
      envelope.delivery_status = 'internal';
    }

    if (envelope.type === 'M' && envelope.project_id && status === 'complete' && typeof missionDir === 'function') {
      try {
        const record = writeMissionRecord(envelope, missionDir(envelope.id), log);
        if (record.written) {
          envelope.context = envelope.context || {};
          envelope.context.mission_record = record.files;
        }
      } catch (e) {
        log('WARN', `mission record write failed: ${e.message}`);
        envelope.context = { ...(envelope.context || {}), artifact_status: 'degraded: mission record failed' };
      }
    }

    if (!skipArtifacts && envelope.type === 'M' && artifacts) {
      try {
        const manifest = await artifacts.publish(envelope);
        if (manifest && manifest.kind === 'artifact_manifest') {
          envelope.output = `${envelope.output || ''}\n\n📎 Artifacts: ${manifest.repo || 'repo'}@${manifest.branch || 'main'} ${String(manifest.commit || 'unknown').slice(0, 8)} — ${manifest.files?.length || 0} file(s)`;
          envelope.context = { ...(envelope.context || {}), artifact_status: 'ok' };
        }
      } catch (e) {
        log('WARN', `artifact publishing failed: ${e.message}`);
        envelope.context = { ...(envelope.context || {}), artifact_status: `degraded: ${String(e.message).slice(0, 100)}` };
      }
    }

    // Every file the mission handed back rides on its reply, the ones it shared on purpose first.
    if (envelope.type === 'M' && typeof outgoingFiles === 'function') {
      try {
        const attachments = replyAttachments(await outgoingFiles(envelope.id), envelope.context?.attachments_export || []);
        if (attachments.length > 0) envelope.context = { ...(envelope.context || {}), attachments_export: attachments };
      } catch (e) {
        log('WARN', `outgoing files of ${envelope.id} could not be listed; the reply carries only the exported ones: ${e.message}`);
      }
    }

    await store.save(envelope);
    const detail = historyDetail || `${status}: ${toStr(output).substring(0, 200)}`;
    for (const [from, to] of hops) await store.writeHistory(envelope.id, from, to, 'brain', detail);
    log('INFO', `envelope ${envelope.id} ${status} (${detail.substring(0, 120)})`);

    const total = usage?.summary(envelope.id);
    if (total && total.calls > 0) {
      log('INFO', `[TELEMETRY] mission_total mission=${envelope.id} calls=${total.calls} input=${total.input} output=${total.output} cached=${total.cached} cache_writes=${total.cacheWrites}`);
    }

    if (!skipMemory) await memory.writeMissionLine(envelope);
    if (status === 'complete' && envelope.type === 'M') await memory.recordLessons(envelope);
    await feedResponsibilityLearnings(envelope, status);

    if (!skipCleanup && artifacts) {
      try { await artifacts.cleanupWorkspace(envelope.id); } catch (e) { log('WARN', `workspace cleanup failed: ${e.message}`); }
    }

    if (envelope.type === 'M' && status !== 'needs_input') {
      if (projects) {
        try { await projects.activateDependents(envelope.id); } catch (e) { log('WARN', `activateDependents failed: ${e.message}`); }
        if (envelope.project_id) {
          try { await projects.checkCompletion(envelope.project_id); } catch (e) { log('WARN', `project completion check failed: ${e.message}`); }
        }
      }
      const eventType = completionEvent(status);
      if (eventType && fireEvent) {
        try {
          await fireEvent(eventType, {
            mission_id: envelope.id,
            project_id: envelope.project_id,
            // Where this mission came from, so an event responsibility never fires from its own
            // mission or from any event-fired mission.
            responsibility_id: envelope.source_meta?.responsibility_id || null,
            fired_by_event: envelope.source_meta?.fired_by_event || null,
          });
        } catch (e) {
          log('WARN', `event responsibilities failed: ${e.message}`);
        }
      }
      if (projects && envelope.project_id && envelope.context) {
        try { await projects.suggestContextPromotions(envelope); } catch (e) { log('WARN', `context promotion failed: ${e.message}`); }
      }
    }
    usage?.drop(envelope.id);
    return { ok: true };
  }

  /**
   * The durable learnings a responsibility's mission distilled (its compaction digest) feed the next
   * firing's PRIOR LEARNINGS, through the responsibility_state overlay the scheduler merges. Never the
   * installed responsibilities file: an upgrade overwrites that. Newest kept, oldest dropped.
   */
  async function feedResponsibilityLearnings(envelope, status) {
    const respId = envelope.source_meta?.responsibility_id;
    const learnings = envelope._compaction?.durable_learnings;
    if (!respId || status !== 'complete' || !Array.isArray(learnings) || learnings.length === 0) return;
    try {
      const overlay = (await store.firestoreRead(COLLECTIONS.responsibilityState, respId)) || {};
      const existing = String(overlay.prior_learnings || '').split('\n').filter(Boolean);
      const day = store.iso().substring(0, 10);
      const additions = learnings.slice(0, 2).map((l) => `- [${day}] ${toStr(l).substring(0, 300)}`);
      const merged = [...existing, ...additions].slice(-learningsMax);
      await store.firestoreWrite(COLLECTIONS.responsibilityState, respId, {
        ...overlay, id: respId, prior_learnings: merged.join('\n'), updated_at: store.iso(),
      });
      log('INFO', `[TELEMETRY] learnings_feed responsibility=${respId} added=${additions.length} total=${merged.length}`);
    } catch (e) {
      log('WARN', `responsibility learnings feed failed (not fatal): ${e.message}`);
    }
  }

  return { completeEnvelope };
}

/** The mission tree's path under the data root's missions directory. */
export function missionDirIn(missionsRoot) {
  return (missionId) => join(missionsRoot, String(missionId));
}
