// agent/services/brain/envelope-runner.mjs: the mission loop. The brain runs one mission at a time:
// the runner picks the next one (a mission ready to continue first, then the oldest queued), claims it
// durably, and runs it until the run ends (complete, failed, blocked, waiting, paused at an approval
// gate, or asking a question). A run continues where the mission stands: after an approval, the plan
// resumes at the task after the gate; after a crash, from the progress the checkpoint executor saved;
// otherwise the cortex (the organ that decides each step) decides, move by move, in the decide loop
// below, and the actions in actions/ carry each move out. Classifying what comes in is intake.mjs's
// job; ending a run is completion.mjs's.
//
// "Ready to continue" is an active mission nobody holds: a resumed wait, an approved gate, an answered
// question, a continued blocker, or one a restart orphaned. Every resume moves the mission to active,
// the one status the transition table lets each pause move to, and the runner's claim is what marks
// the mission it is running.

import { ApprovalNotRaised, requesterOf } from '../../work/checkpoint-executor.mjs';
import { rebuildFromSpine } from '../../work/checkpoint-spine.mjs';
import { StoreUnavailable } from '../../storage/firestore.mjs';
import { COLLECTIONS } from '../../storage/collections.mjs';
import { smartTruncate } from '../../providers/vertex-text.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { ACTION_HANDLERS, ACTION_NAMES } from './actions/index.mjs';
import { accumulateContext, boundPriorResults } from './mission-context.mjs';
import { createCortexSession } from './gateway-client.mjs';
import { analyzeRequest, cortexSystem, cortexUser, decideBlocks, decideDeltaBlocks, decidePayload } from './prompt-assembly.mjs';

/** How long a mission that hit an error waits before the runner tries it again. */
const RETRY_DELAY_MS = 60_000;
/** Consecutive errors (not storage outages) after which a mission is failed instead of retried. */
const MAX_MISSION_ERRORS = 3;
/** The paused-at-a-gate state on a mission's source_meta, cleared once the plan resumes. */
const PAUSED_KEYS = ['paused_approval_id', 'paused_checkpoints', 'paused_checkpoint_index', 'paused_task_index', 'paused_all_results'];
/** Statuses a mission's run can end in that close the cortex's session and may compact its context. */
const SUSPENDED = ['waiting', 'needs_input', 'blocked', 'awaiting_approval'];

/**
 * The results of a plan the brain resumed (after an approval or a crash), as the context the cortex
 * decides from next. Labelled by what happened: a plan that ran to its end on resume is told to
 * synthesize, never to re-plan or ask again for an approval already granted for work already done. A
 * 200-character summary once hid that an approved production deploy had succeeded, and the cortex
 * re-planned, re-gated and asked again, on every approval.
 *
 * @param {Array} results - the executor's rows
 * @param {boolean} failed
 * @param {number} previewChars - brain.result_preview_chars
 * @returns {string}
 */
export function resumeContext(results, failed, previewChars) {
  const header = failed
    ? '[CHECKPOINT PLAN RESULTS — a step FAILED on resume; use synthesize_with_failure or needs_input, do not silently retry]'
    : '[CHECKPOINT PLAN RESULTS — every step COMPLETED on resume; SYNTHESIZE the deliverable from these results. Do NOT re-plan or re-request an approval already granted for work already done.]';
  return `${header}\n${(results || []).map((r) => `${r.step || r.checkpoint_step || '?'} (${r.agent || '?'}): ${r.success ? 'OK' : 'FAIL'} — ${smartTruncate(toStr(r.result), previewChars)}`).join('\n')}`;
}

/** The executor's result rows as the decide loop's results. */
function asPriorResults(results) {
  return (results || []).map((r) => ({
    agent: r.agent, task: r.task, result: r.result, summary: r.summary, ref: r.ref, success: r.success,
    durationMs: r.durationMs, checkpoint_step: r.step,
    ...(r.inconclusive ? { inconclusive: true } : {}), ...(r.timedOut ? { timedOut: true } : {}),
  }));
}

/**
 * Creates the runner.
 *
 * @param {object} deps
 * @param {object}   deps.store            envelope-store.mjs
 * @param {object}   deps.gateway          gateway-client.mjs: askJson, closeSession
 * @param {Function} deps.callAgent        (organ, payload) => result, accounted to the mission
 * @param {Function} deps.enforceSchema    (raw, mode) => decision; vertex-text's
 * @param {object}   deps.executor         the checkpoint executor
 * @param {object}   deps.completion       completion.mjs
 * @param {object}   deps.memory           memory.mjs
 * @param {object}   deps.memoryFiles      memory.mjs createMemoryFiles()
 * @param {object}   deps.missionContext   mission-context.mjs
 * @param {object}   deps.projects         the project registry
 * @param {object}   deps.processes        the process registry
 * @param {object}   [deps.artifacts]      the artifact manager
 * @param {object}   [deps.responsibilities] { triggerable(), fire(id, opts) }
 * @param {Function} deps.writeStatusUpdate (envelopeId, message) => Promise
 * @param {Function} deps.addressFor       (envelope) => Address
 * @param {Function} deps.capabilityMap    () => string, refreshed at each mission boundary
 * @param {Function} [deps.refreshCapabilities] () => void, called at each mission boundary
 * @param {Function} [deps.planSkill]      () => the plan-structuring skill's text
 * @param {object}   deps.settings         brainSettings()
 * @param {Function} [deps.log]
 * @param {Function} [deps.clock]
 */
export function createEnvelopeRunner(deps) {
  const {
    store, gateway, callAgent, enforceSchema, executor, completion, memory, memoryFiles, missionContext,
    projects, processes, artifacts = null, responsibilities = null, writeStatusUpdate, addressFor,
    settings, log = () => {}, clock = Date.now,
  } = deps;

  let active = null; // { id, claimId, since }
  const cancelRequests = new Map(); // missionId -> reason
  const retryAt = new Map(); // missionId -> ms
  const errors = new Map(); // missionId -> consecutive errors
  let missionsRun = 0;

  const ready = (env) => !store.isClaimLive(env) && !((retryAt.get(env.id) || 0) > clock());

  /** The next mission to run, or null. */
  async function pickNext() {
    const live = await store.query([
      { field: 'status', op: 'EQUAL', value: { stringValue: 'active' } },
      { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
    ], { noOrderBy: true, limit: 50 });
    const resumable = live.filter(ready).sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
    if (resumable.length > 0) return resumable[0];

    const queued = await store.query([
      { field: 'status', op: 'EQUAL', value: { stringValue: 'queued' } },
      { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
    ], { noOrderBy: true, limit: 50 });
    const waiting = queued.filter(ready).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    for (const env of waiting) {
      if (!projects || await projects.checkDependencies(env)) return env;
    }
    return null;
  }

  /**
   * One runner pass: runs the next mission to the end of its run. Resolves with the mission's id, or
   * null when there was nothing to run.
   */
  async function tick() {
    if (active) return null;
    let next;
    try {
      next = await pickNext();
    } catch (e) {
      log('WARN', `the runner could not look for work: ${e.message}`);
      return null;
    }
    if (!next) return null;
    return (await processMission(next)) ? next.id : null;
  }

  /**
   * Runs one mission until its run ends. Never throws: an error leaves the mission active and
   * unclaimed for a later attempt, and a mission that keeps failing for reasons other than a
   * storage outage is failed with the reason rather than retried forever.
   *
   * @param {object} candidate - the mission as found; it is re-read under the claim
   * @returns {Promise<boolean>} whether this processor claimed and ran it
   */
  async function processMission(candidate) {
    const claimed = await store.claim(candidate.id);
    if (!claimed) return false;
    const { claimId } = claimed;
    const env = claimed.envelope;
    active = { id: env.id, claimId, since: clock() };
    missionsRun += 1;
    log('INFO', `[WORK QUEUE] running mission ${env.id} (${env.status}): "${String(env.title || env.instruction || '').substring(0, 60)}"`);
    try {
      if (typeof deps.refreshCapabilities === 'function') deps.refreshCapabilities(`mission ${env.id}`);
      await projects?.ensureLoaded();
      await processes?.ensureLoaded();
      if (env.status !== 'active') {
        await store.setStatus(env, 'active', env.status === 'queued' ? 'Processing started' : `Resumed from ${env.status}`);
      }
      const mem = env.memory_context?.recalled
        ? env.memory_context
        : await memory.recall(env.instruction, { resources: env.context?.resources, contextSummary: toStr(env.context_summary).substring(0, 500) });
      if (artifacts) await artifacts.initWorkspace(env.id, { projectId: env.project_id, envelope: env });

      if (await cancelIfRequested(env)) return true;
      if (env.source_meta?.paused_approval_id) await resumeAfterApproval(env, mem);
      else if (env._cp_progress) await resumeFromProgress(env, env._cp_progress, mem, 'crash');
      else await decideLoop(env, mem);
      errors.delete(env.id);
    } catch (e) {
      await onMissionError(env, e);
    } finally {
      await store.release(env.id, claimId);
      active = null;
    }
    return true;
  }

  async function onMissionError(env, e) {
    if (e instanceof ApprovalNotRaised || e instanceof StoreUnavailable) {
      log('WARN', `mission ${env.id} could not continue (${e.message}); trying again later`);
      retryAt.set(env.id, clock() + RETRY_DELAY_MS);
      return;
    }
    const count = (errors.get(env.id) || 0) + 1;
    errors.set(env.id, count);
    log('ERROR', `mission ${env.id} hit an error (${count}/${MAX_MISSION_ERRORS}): ${e.message}`);
    if (count < MAX_MISSION_ERRORS) {
      retryAt.set(env.id, clock() + RETRY_DELAY_MS);
      return;
    }
    errors.delete(env.id);
    try {
      const fresh = (await store.read(env.id)) || env;
      if (fresh.status === 'active') {
        await completion.completeEnvelope(fresh, {
          status: 'failed',
          output: `The brain hit the same error ${MAX_MISSION_ERRORS} times while running this mission and stopped: ${e.message}`,
          historyDetail: `Failed after ${MAX_MISSION_ERRORS} errors: ${String(e.message).substring(0, 150)}`,
          skipArtifacts: true, skipMemory: true,
        });
      }
    } catch (err) {
      log('ERROR', `mission ${env.id} could not be failed after its errors: ${err.message}`);
      retryAt.set(env.id, clock() + RETRY_DELAY_MS);
    }
  }

  /**
   * Asks for a mission to stop. The running mission stops at its next decision; the intake cancels
   * a mission nobody is running itself.
   */
  function requestCancel(id, reason) {
    cancelRequests.set(id, reason || 'Cancelled at the request of a person');
  }

  /** Cancels the mission if a person asked for it to stop. */
  async function cancelIfRequested(env, session = null) {
    if (!cancelRequests.has(env.id)) return false;
    const reason = cancelRequests.get(env.id);
    cancelRequests.delete(env.id);
    if (session) await session.close();
    await store.setStatus(env, 'cancelled', `Cancelled: ${String(reason).substring(0, 100)}`, { event: { reason } });
    await cancelChildren(env.id);
    await writeStatusUpdate(env.id, `✅ Cancelled mission: "${toStr(env.title || env.instruction).substring(0, 100)}"`);
    log('INFO', `mission ${env.id} cancelled`);
    return true;
  }

  /** Cancels the unfinished checkpoints and tasks under an envelope, all the way down. */
  async function cancelChildren(parentId, depth = 0) {
    if (depth > 4) return;
    const children = await store.query([{ field: 'parent_id', op: 'EQUAL', value: { stringValue: parentId } }], { noOrderBy: true, limit: 300 });
    for (const child of children) {
      if (['active', 'pending', 'queued', 'waiting', 'needs_input', 'blocked', 'awaiting_approval'].includes(child.status)) {
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
   * After an approval: continue the paused plan at the task after the gate, deterministically.
   * Deciding again would re-plan the gate's checkpoint and insert the same gate, so a checkpoint that
   * bundles a gate with its gated action would ask for approval forever. The paused state is cleared
   * before the plan runs; from then on the executor's progress covers a crash.
   */
  async function resumeAfterApproval(env, mem) {
    const meta = env.source_meta || {};
    const ci = meta.paused_checkpoint_index;
    const ti = meta.paused_task_index;
    const saved = Array.isArray(meta.paused_all_results) ? meta.paused_all_results : [];
    let checkpoints = meta.paused_checkpoints;
    if ((!Array.isArray(checkpoints) || checkpoints.length === 0) && Array.isArray(env._cp_spine) && env._cp_spine.length) {
      checkpoints = rebuildFromSpine(env._cp_spine).checkpoints;
    }
    const nextMeta = { ...meta };
    for (const key of PAUSED_KEYS) delete nextMeta[key];
    env.source_meta = nextMeta;
    await store.save(env);
    if (!Array.isArray(checkpoints) || checkpoints.length === 0 || !Number.isInteger(ci) || !Number.isInteger(ti)) {
      log('WARN', `approval resume of ${env.id}: the paused plan cannot be rebuilt (ci=${ci} ti=${ti}); deciding again`);
      return decideLoop(env, mem);
    }
    log('INFO', `approval resume of ${env.id}: continuing at CP${ci + 1} task ${ti + 2}, the task after the approved gate`);
    return resumeFromProgress(env, { checkpointIndex: ci, taskIndex: ti + 1, allResults: saved, checkpoints }, mem, 'approval');
  }

  /** Runs the rest of a plan from saved progress, then lets the cortex decide on the results. */
  async function resumeFromProgress(env, progress, mem, kind) {
    const { checkpointIndex = 0, taskIndex = 0, allResults = [], checkpoints } = progress || {};
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
      log('WARN', `${kind} resume of ${env.id}: no checkpoints in the saved progress; deciding again`);
      env._cp_progress = null;
      await store.save(env);
      return decideLoop(env, mem);
    }
    if (kind === 'crash') {
      await store.writeHistory(env.id, 'active', 'active', 'brain', `Resuming from CP${checkpointIndex + 1} task ${taskIndex + 1} (the brain restarted mid-plan)`);
    }
    log('INFO', `${kind} resume of ${env.id}: ${checkpoints.length} checkpoints, from CP${checkpointIndex + 1} task ${taskIndex + 1}`);
    const run = await executor.executeCheckpoints(checkpoints, {
      envelope: env, startCpIndex: checkpointIndex, startTaskIndex: taskIndex, savedResults: allResults,
    });
    if (run.paused) return;
    const failed = !run.success;
    env.context_forward = resumeContext(run.results, failed, settings.resultPreviewChars);
    await store.save(env);
    const rows = asPriorResults(run.results);
    rows.push({ agent: 'system', result: resumeContext([], failed, settings.resultPreviewChars).trim() });
    return decideLoop(env, mem, { results: rows });
  }

  /** The decide turn's context about the work waiting behind this mission. */
  async function queueState() {
    try {
      const pending = await store.firestoreQuery(COLLECTIONS.intake, [{ field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } }], { noOrderBy: true, limit: 20 });
      const queued = await store.query([
        { field: 'status', op: 'EQUAL', value: { stringValue: 'queued' } },
        { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
      ], { noOrderBy: true, limit: 20 });
      return {
        pending_intake_count: pending.length,
        pending_queue: queued.map((q, i) => ({ position: i + 1, text: String(q.title || q.instruction || '').substring(0, 120) })),
      };
    } catch {
      return { pending_intake_count: 0, pending_queue: [] };
    }
  }

  /**
   * The cortex decide loop: decide a move, carry it out, decide again, until a move ends the run or
   * the mission reaches its iteration limit. Iterations count over the mission's life, so a resumed
   * mission does not get a fresh budget.
   *
   * @param {object} env
   * @param {object} mem - recalled memory
   * @param {object} [opts]
   * @param {Array}  [opts.results] - results to start from (a resumed plan's), instead of context_forward
   */
  async function decideLoop(env, mem, opts = {}) {
    const priorResults = [];
    if (Array.isArray(opts.results)) priorResults.push(...opts.results);
    else if (env.context_forward) priorResults.push({ agent: 'human', result: env.context_forward, success: true });

    let iteration = env.iteration || 0;
    let lastPromptTokens = 0;
    let guard = null;
    const session = createCortexSession({
      client: gateway, missionId: env.id, enabled: settings.session.enabled, breaker: settings.session.breaker,
      generation: env._session?.generation || 0, enforceSchema, log,
    });
    const requester = requesterOf(env);
    const actionDeps = {
      ...deps,
      completeEnvelope: (e, o) => completion.completeEnvelope(e, o),
      clock,
    };

    while (iteration < settings.maxIterations) {
      iteration += 1;
      env.iteration = iteration;
      if (await cancelIfRequested(env, session)) return;

      missionContext.writeBlackboard(env, priorResults, iteration);
      if (boundPriorResults(priorResults)) await session.close();

      try {
        const seq = await missionContext.compact(env, { lastPromptTokens });
        if (seq > 0) {
          await session.close();
          priorResults.push({ agent: 'system', success: true, result: `[SYSTEM] Context compacted (seq ${seq}): older iterations are summarized in the [CONTEXT COMPACTED] block. Digest claims carry their epistemic bins; treat 'assumed' as unverified. Full task outputs stay retrievable by ref.` });
        }
      } catch (e) {
        log('WARN', `compaction check failed (not fatal): ${e.message}`);
      }

      const queue = await queueState();
      const acc = accumulateContext({
        accumulated: env._accumulated_context, priorResults, memory: mem, iteration, timestamp: store.iso(),
        tokenBudget: settings.contextTokenBudget, sliceChars: settings.contextSliceChars,
      });
      if (acc.pruned > 0) log('INFO', `mission ${env.id}: ${acc.pruned} context blocks pruned for budget`);
      env._accumulated_context = acc.text;

      // ---- The Brief: the prefrontal analyzes the work once, on the first iteration ----
      let brief = env._brief || null;
      if (!brief && iteration === 1) {
        const project = env.project_id ? projects?.get(env.project_id) : null;
        const req = analyzeRequest({
          envelope: env, memory: mem, priorResults, project,
          processes: processes?.getAllProcesses() || {}, capabilityMap: deps.capabilityMap(), requester,
        });
        const analyzed = await gateway.askJson({ organ: 'prefrontal', mode: 'analyze', system: req.system, user: req.user, enforceSchema, missionId: env.id });
        if (analyzed && !analyzed.error && Array.isArray(analyzed.parts)) {
          const { usage: _u, durationMs: _d, _session: _s, _coercedDecision: _c, ...clean } = analyzed;
          brief = clean;
          env._brief = brief;
          log('INFO', `Brief: ${brief.parts.length} parts, process_match=${brief.process_match || 'none'}`);
        }
      }

      // ---- Decide ----
      const project = env.project_id ? projects?.get(env.project_id) : null;
      const payload = decidePayload({
        envelope: env,
        memory: mem,
        envelopeContext: acc.text,
        priorResults,
        iteration,
        queue,
        brief,
        capabilityMap: deps.capabilityMap(),
        project,
        // The project's own context; the mission's working context (its resource ledger, its git
        // state) is not a context packet and reaches the cortex as known_resources instead.
        renderedProjectContext: project ? projects.buildContext(env.project_id, null) : null,
        processes: processes?.getAllProcesses() || {},
        triggerable: responsibilities?.triggerable() || [],
        resourceLimit: settings.resourceLedger.recallLimit,
      });
      const system = cortexSystem({
        deepTruths: memoryFiles.deepTruths(),
        workingMemory: memoryFiles.workingMemory(),
        projects: projects?.getAll() || {},
        processes: processes?.getAllProcesses() || {},
      });
      const decision = await session.decide({
        system,
        openUser: cortexUser(decideBlocks(payload), { requester }),
        deltaUser: (sentUpto) => cortexUser(decideDeltaBlocks(payload, sentUpto)),
        resultsCount: priorResults.length,
      });
      env._session = session.snapshot();
      if (decision?.usage) {
        lastPromptTokens = decision.usage.last_step_input_tokens || decision.usage.promptTokenCount || decision.usage.prompt_tokens || lastPromptTokens;
      }

      if (!decision || decision.error) {
        if (decision?.error === 'parse_failed' && iteration < settings.maxIterations) {
          log('WARN', `mission ${env.id}: the cortex's reply could not be read; asking again for JSON only`);
          priorResults.push({ agent: 'system', result: '[SYSTEM] Your previous response could not be parsed as JSON. Respond with EXACTLY one JSON object, no markdown fences, no text before or after it. Required field: "action".' });
          continue;
        }
        await session.close();
        if (decision?.error && decision.error !== 'parse_failed') {
          // The gateway could not answer: that is not a verdict on the mission. The runner tries it
          // again later, and fails it only if the error persists.
          throw new Error(`the cortex could not be reached: ${decision.error}`);
        }
        await completion.completeEnvelope(env, {
          status: 'failed',
          output: `The cortex's decision could not be read: ${JSON.stringify(decision).substring(0, 300)}`,
          historyDetail: 'The cortex decision could not be parsed',
          skipArtifacts: true, skipMemory: true,
        });
        return;
      }
      const { usage: _usage, durationMs: _dur, _session: _sess, _coercedDecision: _coerced, ...lastDecision } = decision;
      env._lastDecision = lastDecision;
      let action = decision.action;
      log('INFO', `cortex decision: action=${action} (mission ${env.id}, iteration ${iteration})`);

      // ---- The full content of results the cortex asked for by ref ----
      if (Array.isArray(decision.request_context) && decision.request_context.length > 0) {
        const fetched = await missionContext.hydrate(env, decision.request_context, priorResults);
        if (fetched === 'fetched') continue; // decide again with the content in view
      }

      // After a self-unblock attempt only a resolution may follow: a re-plan there is a stall.
      if ((env._swf_state === 'awaiting_unblock' || env._swf_state === 'unblock_attempted') && action === 'checkpoint_plan') {
        log('WARN', `mission ${env.id}: checkpoint_plan after a self-unblock attempt; ending as blocked`);
        action = 'blocked';
        decision.action = 'blocked';
        decision.blocker = decision.failure_summary || env._failure_synthesis || 'The failure could not be resolved another way';
        decision.blocker_type = 'task_failure';
        decision.escalation_message = env._failure_synthesis || decision.failure_summary || decision.blocker;
      }

      // ---- A guard an earlier move set: one move it forbids, and what to do instead ----
      if (guard && iteration > guard.injectedAt) {
        if (action === guard.forbidden) {
          const toSynthesis = guard.fallback === 'synthesize' || guard.fallback === 'synthesize_with_failure';
          const hasSummary = Boolean(decision.synthesis || decision.summary || decision.answer || decision.content || decision.message);
          if (toSynthesis && !hasSummary && !env._synth_grace_used) {
            // One turn to write the answer, so a forced synthesis is not empty.
            env._synth_grace_used = true;
            log('WARN', `mission ${env.id}: the cortex chose the forbidden '${action}' with no summary; one turn to write it before forcing '${guard.fallback}'`);
            priorResults.push({ agent: 'system', result: `[SYSTEM] Finish now: return action "${guard.fallback}" with a written outcome for the person in the "synthesis" field: what was accomplished, or why it could not be. Do NOT plan more work.` });
            guard = { ...guard, injectedAt: iteration };
            continue;
          }
          log('WARN', `mission ${env.id}: the cortex chose the forbidden '${action}'; forcing '${guard.fallback}'`);
          action = guard.fallback;
          decision.action = action;
          if (guard.context) Object.assign(decision, guard.context);
        }
        guard = null;
      }

      // ---- Carry out the move ----
      let handler = ACTION_HANDLERS[action];
      if (!handler) {
        log('WARN', `mission ${env.id}: unknown action '${action}'`);
        priorResults.push({ agent: 'system', result: `[SYSTEM] Invalid action "${action}". Valid actions: ${ACTION_NAMES.join(', ')}.` });
        continue;
      }
      const ctx = { envelope: env, decision, priorResults, memory: mem, iteration };
      let result = await handler(ctx, actionDeps);
      if (result?.nextAction) {
        action = result.nextAction;
        handler = ACTION_HANDLERS[action];
        decision.action = action;
        result = handler ? await handler(ctx, actionDeps) : { continue: true };
      }
      if (result?.exit) {
        await session.close();
        if (result.retryLater) retryAt.set(env.id, clock() + RETRY_DELAY_MS);
        // A mission pausing above half its working budget resumes from a digest, not from the whole
        // accumulated context, after what may be days.
        if (SUSPENDED.includes(env.status)) {
          try {
            await missionContext.compact(env, { lastPromptTokens, trigger: 'suspend', triggerPct: 0.5 });
          } catch (e) {
            log('WARN', `compact-on-suspend failed (not fatal): ${e.message}`);
          }
        }
        return;
      }
      if (result?.activeGuard) guard = result.activeGuard;
      if (result?.priorResultsAppend) priorResults.push(...result.priorResultsAppend);
    }

    await session.close();
    await completion.completeEnvelope(env, {
      status: 'failed',
      output: `The mission reached its limit of ${settings.maxIterations} decisions without finishing.`,
      historyDetail: `Max iterations (${settings.maxIterations}) reached`,
      skipArtifacts: true,
      skipMemory: true,
    });
  }

  /**
   * Startup recovery. One brain runs per instance, so every claim left on a mission at startup
   * belongs to a process that is gone: clearing it lets the runner continue the mission at once
   * (from its saved progress, when it has some). A responsibility's mission written as pending but
   * never queued is queued.
   */
  async function recover() {
    try {
      const live = await store.query([
        { field: 'status', op: 'EQUAL', value: { stringValue: 'active' } },
        { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
      ], { noOrderBy: true, limit: 300 });
      for (const env of live.filter((e) => e.claimed_by)) {
        await store.patch(env.id, { claimed_by: null, claimed_at_ms: null });
        log('INFO', `recovery: released the claim a previous process left on ${env.id}`);
      }
      const pending = await store.query([
        { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
        { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
      ], { noOrderBy: true, limit: 100 });
      for (const env of pending) {
        if (!env.source_meta?.responsibility_id || (Array.isArray(env.depends_on) && env.depends_on.length > 0)) continue;
        await store.setStatus(env, 'queued', 'Queued after a restart', { actor: 'brain' });
        log('INFO', `recovery: queued ${env.id}, a responsibility's mission a restart left pending`);
      }
    } catch (e) {
      log('WARN', `startup recovery failed: ${e.message}`);
    }
  }

  return {
    tick,
    processMission,
    recover,
    requestCancel,
    activeMissionId: () => active?.id || null,
    state: () => ({ active_mission: active?.id || null, since: active ? new Date(active.since).toISOString() : null, missions_run: missionsRun }),
  };
}
