// agent/work/checkpoint-executor.mjs: runs a mission's checkpoint plan. For each checkpoint it
// creates or resumes the checkpoint envelope, runs each task on its organ through the gateway (one
// retry on failure), keeps the step ledger and progress so a resumed mission never repeats finished
// work, raises approval gates, has the cerebellum (the organ that verifies each checkpoint) judge the
// milestone, records the verdict on the checkpoint spine, and commits the mission tree after a
// checkpoint passes. A failed task or a failed milestone halts the plan: nothing proceeds past it.
// Deciding what to plan, and what to do with the results, is the brain's. Verification is
// checkpoint-verify.mjs, reading a task's result is task-outcome.mjs, the ledger is step-ledger.mjs.
// Constructed by the brain service, which calls executeCheckpoints for a new plan, a scoped re-plan,
// a crash resume (from `_cp_progress`) and a resume after an approval (from `source_meta.paused_*`).
//
// ---- API ----
//
//   const executor = createCheckpointExecutor(deps);
//   const out = await executor.executeCheckpoints(checkpoints, { envelope, startCpIndex, startTaskIndex, savedResults });
//
// `checkpoints` is the plan: [{ instruction, accept_criteria, tasks: [{ agent, task, accept_criteria?,
// step_type?, intent?, _optional? }] }] (plan-utils.mjs extractCheckpoints, or checkpoint-spine.mjs
// rebuildFromSpine). `out` is { success, results } when the plan ran to its end or halted at a
// failure, or { paused: true, approvalId, results } at an approval gate. `results` are rows
// { step: 'cp.task' | 'cp.verify', agent, task?, result, success, durationMs?, summary?, ref?,
// bytes?, shape?, inconclusive?, timedOut?, replayed? }, savedResults first.
//
// ---- Envelope fields ----
//
// Mission envelope, read: id, status, iteration, children, project_id, stakes, instruction,
//   source_text, context_summary, memory_context, context.resources, context.git_version_index,
//   source_channel, source_meta.sender (the person who asked), source_meta.address
//   ({ channel, space?, thread? }), source_meta.effect_scope, _brief.parts[].load_bearing,
//   step_ledger, _cp_spine, _milestone_caveats.
// Mission envelope, written (in place; the caller's object is the saved one): status and the fields
//   applyTransition stamps with it, children, context.resources, context.git_version_index,
//   context.git_checkpoint_count, step_ledger, _cp_progress, _cp_spine, _milestone_caveats,
//   source_meta.paused_approval_id / paused_checkpoint_index / paused_task_index /
//   paused_checkpoints / paused_all_results (at a gate), updated_at.
// Checkpoint (C) envelopes it creates: id, type, parent_id, status, intent 'checkpoint', title,
//   instruction, accept_criteria, context_summary, output, error, children, context_forward,
//   source_channel 'brain', source_meta { dispatched_by, checkpoint, checkpoint_total, approval_id?,
//   approval_task_index? }, project_id, created_at, started_at, completed_at, updated_at, iteration,
//   needs_review, _cp_digest.
// Task (T) envelopes: the same core fields, intent from the task (default 'execute'), source_meta
//   { dispatched_by, checkpoint, task_step, step_type, agent }.
// Approval notification (T, intent 'notification', parent_id the mission): output, delivery_status
//   'pending', delivery_address, source_meta { approval_id, notification_type: 'approval_gate' }.
//
// ---- What the brain does around it ----
//
// It maps the contracts onto `settings`; resumes from `_cp_progress` after a crash (checkpointIndex,
// taskIndex, allResults, checkpoints) and from `source_meta.paused_*` after an approval (the task
// after the gate: paused_task_index + 1), clearing the paused_* fields once resumed; treats
// ApprovalNotRaised as "try again later", never as a failed mission; and decides the mission's end
// from the results (the executor never finishes or fails a mission, it only pauses one at a gate).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from '../storage/collections.mjs';
import { allocateVersion } from '../storage/git-store.mjs';
import { toStr } from '../providers/to-str.mjs';
import { smartTruncate } from '../providers/vertex-text.mjs';
import { makeAddress, AGENT_SENDER } from '../providers/channel.mjs';
import { buildPriorWorkContext, renderCheckpointDigest, stepCheckpointNum } from '../context/compaction.mjs';
import { TOOL_RESULTS_COLLECTION } from '../context/tool-record.mjs';
import { applyTransition, canTransition, TERMINAL_STATUSES } from './work-transitions.mjs';
import { markCheckpoint, spineSummary } from './checkpoint-spine.mjs';
import { buildApprovalRecord, describeApprovalGate } from './approvals.mjs';
import { isMemoryScoped, fenceMemoryTask } from './memory-scope.mjs';
import { extractResources, mergeResources, renderResources, seedFromProse } from './resource-ledger.mjs';
import { buildResultPacket } from './result-packet.mjs';
import { isMilestoneVerdict } from './finalization.mjs';
import { deriveStepKey, completedStep, recordStep, clearCheckpointSteps } from './step-ledger.mjs';
import { applyMotorCheck, prepareRetry, withEvidenceWarnings } from './task-outcome.mjs';
import { verifyMilestone, VERIFY_DEFAULTS } from './checkpoint-verify.mjs';

/** The organs a checkpoint task may run on. Planning and verifying organs never run tasks. */
export const VALID_TASK_ORGANS = Object.freeze(['motor', 'temporal-research', 'temporal-memory']);

/**
 * Executor settings, with the contracts key each one maps from. Defaults; callers pass the contracts
 * values. The verification budgets are VERIFY_DEFAULTS in checkpoint-verify.mjs.
 */
export const EXECUTOR_DEFAULTS = Object.freeze({
  ...VERIFY_DEFAULTS,
  ctxAgentStep: 8000, // default; no contracts key yet. A task row keeps this much of its output
  ctxDispatchFailure: 3000, // default; no contracts key yet. A failed task row keeps this much
  checkpointDigestChars: 12000, // default; callers pass the contracts value (compaction.checkpoint_digest_chars)
  packetSummaryChars: 4000, // default; callers pass the contracts value (organ_context.packet_summary_chars)
  listSummaryTopK: 8, // default; callers pass the contracts value (organ_context.list_summary_top_k)
  toolAnswerMinProseChars: 240, // default; callers pass the contracts value (organ_context.tool_answer_min_prose_chars)
  resourceLedgerMax: 200, // default; callers pass the contracts value (memory.resource_ledger.max_entries)
  resourceLedgerRecallLimit: 40, // default; callers pass the contracts value (memory.resource_ledger.recall_limit)
  defaultBranch: 'main', // default; callers pass the contracts value (git.default_branch)
  transitionGuard: 'enforce', // default; callers pass the contracts value (brain.transition_guard)
});

// Agent-facing: how to weigh the known-resources block against other sources of an id. A planner
// once hand-copied a template id with one character wrong while the right id, read from a Drive
// listing, sat in the same prompt; every attempt failed the same way.
const RESOURCE_PRECEDENCE = [
  '(These are already resolved. Use the id directly — do not search for them by name.',
  'PRECEDENCE, strongest first, when two sources name an id for the same resource:',
  '  1. This block, and any id an earlier task reported as a verified claim — read back from a tool result.',
  '  2. An id written into the instruction above — typed out when the plan was written, so it can be mistyped.',
  '  3. A row in a raw listing you are looking at now — the WEAKEST source, because a listing answers "what is in this folder", not "which one did we mean".',
  'Never take the first row of a listing as "the" file. One mission had the right template named in this block, took the first row of a folder listing instead, and built three documents from the wrong template. If sources disagree, use the strongest and say in your report that you did.)',
].join('\n');

const RETRY_GUIDANCE = 'Read the governing SKILL.md and use its documented commands. Investigate why it failed (wrong arguments? missing input? wrong target? unread doc?) and correct it — a failing command is something you resolve, not a dead end. Do not simulate results.';

/**
 * The approval document could not be written, so the gate was not raised and nothing was paused.
 * The mission is still active with its progress saved: the brain should retry it later, not fail it.
 * A storage failure is not a verdict on the work.
 */
export class ApprovalNotRaised extends Error {
  constructor(approvalId, missionId) {
    super(`approval ${approvalId} for mission ${missionId} could not be written; the gate was not raised and the mission was not paused`);
    this.name = 'ApprovalNotRaised';
    this.approvalId = approvalId;
    this.missionId = missionId;
  }
}

/**
 * The person whose request a mission serves: the sender the ears recorded on the intake
 * (`source_meta.sender`: the dashboard user's email, or the Chat sender), carried onto the mission.
 * Empty for scheduled work, which no person asked for in the moment, and never the agent itself.
 *
 * @param {object} envelope
 * @returns {string}
 */
export function requesterOf(envelope) {
  const v = envelope?.source_meta?.sender;
  const who = typeof v === 'string' ? v.trim() : '';
  return who === AGENT_SENDER ? '' : who;
}

const merge = (defaults, given) => {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(given || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
};

/** One planned task, in the executor's terms. Planners spell the step type three ways. */
function readTask(task) {
  const t = task && typeof task === 'object' ? task : {};
  const text = toStr(t.task || t.instruction || '');
  return {
    organ: typeof t.agent === 'string' && t.agent ? t.agent : null,
    text,
    criteria: toStr(t.accept_criteria)
      || `The task's stated outcome is achieved: "${toStr(t.task || t.instruction || t.brief_part || '').substring(0, 200)}". Concrete tool evidence shows the outcome was produced (not simulated), with no unresolved errors.`,
    stepType: t._step_type || t.step_type || t.type || 'standard',
    optional: t._optional === true,
    intent: typeof t.intent === 'string' && t.intent ? t.intent : 'execute',
  };
}

/**
 * Creates the checkpoint executor.
 *
 * @param {object}   deps
 * @param {object}   deps.db          - a Firestore client from agent/storage/firestore.mjs; read(path)
 *   and write(path, data, opts) on the work collection, and read(ref) on stored tool results
 * @param {Function} deps.callAgent   - async (organ, payload) => { success, output, error, durationMs,
 *   finishReason?, timedOut?, usage? }: one organ turn through the gateway. The payload is
 *   { instruction, accept_criteria, _missionId, _projectContext, _sourceText, _requester,
 *   prior_results_context, memory_context, _exec: true } for a task, and { instruction, _missionId }
 *   for the cerebellum. callAgent renders the payload into the turn's messages (the project context
 *   travels only in _projectContext; _requester is the asking person's email, '' for scheduled
 *   work) and sends `exec` from _exec. A throw counts as a failed turn.
 * @param {Function} deps.writeHistory - async (envelopeId, prevStatus, newStatus, actor, detail): the
 *   brain's history writer (agent/context/history.mjs)
 * @param {object}   deps.approvals   - { create(approvalId, record) => Promise<boolean> }: the checker
 *   from approvals.mjs createApprovalChecker
 * @param {Function} deps.generateId  - (prefix) => unique id; 'w' for envelopes, 'apr' for approvals
 * @param {object}   [deps.projects]  - the project registry from projects.mjs: get(id) for the
 *   project's name, buildContext(id, envelopeContext) for the task's project context
 * @param {object}   [deps.artifacts] - the artifact manager from artifacts.mjs: commitAndSync(missionId,
 *   projectId, message) after each checkpoint that passes
 * @param {Function} [deps.missionDir] - (missionId) => the mission tree's path, for step notes and the
 *   commit version index; without it neither is written
 * @param {Function} [deps.summarizeForDelivery] - (type, rawText, ctx) => Promise<string>: the notifier's
 *   (agent/providers/notifications.mjs); rewrites the approval request. Without it the raw text goes out
 * @param {Function} [deps.addressFromMeta] - (sourceMeta, sourceChannel) => Address for the approval
 *   request; defaults to the mission's decoded source_meta.address, else the dashboard
 * @param {object}   [deps.settings]  - see EXECUTOR_DEFAULTS
 * @param {Function} [deps.logger]    - (level, msg)
 * @param {Function} [deps.clock]     - () => ms (injectable for tests)
 * @returns {{executeCheckpoints: Function}}
 */
export function createCheckpointExecutor(deps = {}) {
  const {
    db, callAgent, writeHistory, approvals, generateId,
    projects = null, artifacts = null, missionDir = null,
    summarizeForDelivery = null, addressFromMeta = null,
    clock = Date.now,
  } = deps;
  const required = [
    ['db', db && typeof db.read === 'function' && typeof db.write === 'function'],
    ['callAgent', typeof callAgent === 'function'],
    ['writeHistory', typeof writeHistory === 'function'],
    ['approvals', approvals && typeof approvals.create === 'function'],
    ['generateId', typeof generateId === 'function'],
  ];
  for (const [name, ok] of required) {
    if (!ok) throw new Error(`createCheckpointExecutor: deps.${name} is required`);
  }
  const s = merge(EXECUTOR_DEFAULTS, deps.settings);
  const log = deps.logger || ((level, msg) => console.log(`[checkpoint-executor] ${level}: ${msg}`));
  const iso = () => new Date(clock()).toISOString();
  const workPath = (id) => `${COLLECTIONS.work}/${id}`;

  // ---- Storage ----

  async function save(env, strict = false) {
    return db.write(workPath(env.id), env, strict ? { strict: true } : {});
  }

  async function load(id) {
    try { return await db.read(workPath(id)); } catch { return null; }
  }

  async function readToolResult(ref) {
    if (!String(ref || '').startsWith(`${TOOL_RESULTS_COLLECTION}/`)) return null;
    const doc = await db.read(ref);
    return doc?.result ? String(doc.result) : null;
  }

  // ---- Status changes ----

  /**
   * Moves an envelope to `to` in place, through applyTransition, and returns the moves made. A
   * paused envelope that cannot go straight to `to` resumes to active first: awaiting_approval →
   * complete is not a legal move, awaiting_approval → active → complete is.
   */
  function move(env, to, event = {}) {
    const at = iso();
    const from = env.status;
    let res = applyTransition(env, { ...event, to, at });
    let hops = [[from, to]];
    if (!res.ok && to !== 'active' && canTransition(from, 'active').allowed && canTransition('active', to).allowed) {
      const resumed = applyTransition(env, { to: 'active', at });
      const onward = resumed.ok ? applyTransition(resumed.envelope, { ...event, to, at }) : resumed;
      if (onward.ok) {
        res = onward;
        hops = [[from, 'active'], ['active', to]];
      }
    }
    if (!res.ok) {
      const reason = `${env.id}: '${from}' → '${to}' refused: ${res.reason}`;
      if (s.transitionGuard !== 'observe') throw new Error(`illegal envelope transition, ${reason}`);
      log('WARN', `[checkpoint-executor] transition guard (observe): ${reason}; applying it anyway`);
      Object.assign(env, { status: to, updated_at: at });
      return [[from, to]];
    }
    if (!res.changed) return [];
    Object.assign(env, res.envelope);
    return hops;
  }

  /** Changes an envelope's status, saves it, and writes one history record per move. */
  async function setStatus(env, to, detail, { event = {}, actor = 'brain', strict = false } = {}) {
    const hops = move(env, to, event);
    if (hops.length === 0) return;
    await save(env, strict);
    for (const [from, next] of hops) await writeHistory(env.id, from, next, actor, detail);
  }

  // ---- Envelopes ----

  /** The mission's checkpoint envelopes for checkpoint `cpNum`, oldest first. */
  async function checkpointEnvelopes(envelope, cpNum) {
    const found = [];
    for (const childId of envelope.children || []) {
      const child = await load(childId);
      if (child && child.type === 'C' && child.source_meta?.checkpoint === cpNum) found.push({ ...child, id: childId });
    }
    return found;
  }

  async function createCheckpointEnvelope(envelope, cp, cpNum, total, allResults) {
    const id = generateId('w');
    const at = iso();
    const instruction = toStr(cp.instruction) || `Checkpoint ${cpNum}`;
    const cpEnv = {
      id,
      type: 'C',
      parent_id: envelope.id,
      status: 'active',
      intent: 'checkpoint',
      title: instruction.substring(0, 100),
      instruction,
      accept_criteria: toStr(cp.accept_criteria || ''),
      context_summary: allResults.length > 0
        ? `Prior checkpoints:\n${allResults.map((r) => `Step ${r.step} (${r.agent}): ${toStr(r.result).substring(0, 200)}`).join('\n')}`
        : (envelope.context_summary || null),
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: 'brain',
      source_meta: { dispatched_by: envelope.id, checkpoint: cpNum, checkpoint_total: total },
      project_id: envelope.project_id || null,
      created_at: at,
      started_at: at,
      completed_at: null,
      updated_at: at,
      iteration: 0,
    };
    await save(cpEnv);
    envelope.children = [...(envelope.children || []), id];
    envelope.updated_at = at;
    await save(envelope);
    await writeHistory(id, null, 'active', 'brain', `Checkpoint ${cpNum}/${total}: ${instruction.substring(0, 60)}`);
    return cpEnv;
  }

  // ---- The resource ledger ----

  // The person usually states the ids ("put them in the In Progress folder (1ozAGM…)"). Anything
  // stated is known; seeding costs one regex pass and saves a search. The planner seeds the same
  // text before it writes a plan; this seeds the resume paths, which never pass through planning.
  function seedResources(envelope) {
    try {
      const text = [envelope.instruction, envelope.source_text, envelope.context_summary].filter(Boolean).map(toStr).join('\n');
      envelope.context = envelope.context || {};
      const { ledger, added, updated } = seedFromProse(envelope.context.resources, text, {
        max: s.resourceLedgerMax, now: iso(), source: 'request',
      });
      envelope.context.resources = ledger;
      if (added || updated) log('INFO', `[TELEMETRY] resource_ledger mission=${envelope.id} step=request added=${added} updated=${updated} total=${Object.keys(ledger).length}`);
    } catch (e) {
      log('WARN', `[checkpoint-executor] resource ledger seed failed: ${e.message}`);
    }
  }

  // An outside id resolved once is never searched for again. Capture is deterministic (ids come
  // from the structured JSON the skills print) and lands on the envelope, not the mission tree: a
  // resume re-clones the tree, and one mission re-ran the same failing Drive search six times for a
  // folder it had already located.
  function captureResources(envelope, output, step) {
    try {
      const found = extractResources(toStr(output));
      if (found.length === 0) return;
      envelope.context = envelope.context || {};
      const { ledger, added, updated, dropped } = mergeResources(envelope.context.resources, found, {
        max: s.resourceLedgerMax, now: iso(), source: step,
      });
      envelope.context.resources = ledger;
      if (added || updated || dropped) {
        log('INFO', `[TELEMETRY] resource_ledger mission=${envelope.id} step=${step} added=${added} updated=${updated} dropped=${dropped} total=${Object.keys(ledger).length}`);
      }
    } catch (e) {
      // Never fail a task that produced real work over a bookkeeping miss.
      log('WARN', `[checkpoint-executor] resource ledger capture failed: ${e.message}`);
    }
  }

  // ---- One task ----

  async function dispatch(organ, payload) {
    try {
      const r = await callAgent(organ, payload);
      return r && typeof r === 'object'
        ? { ...r }
        : { success: false, output: null, error: 'the gateway returned no result', durationMs: 0 };
    } catch (e) {
      return { success: false, output: null, error: e.message, durationMs: 0 };
    }
  }

  function buildPayload({ envelope, plan, cpNum, t, allResults, cpResults }) {
    const projectContext = envelope.project_id && projects && typeof projects.buildContext === 'function'
      ? (projects.buildContext(envelope.project_id, envelope.context || null) || null)
      : null;
    // Ids captured or seeded during the mission, kept in front of the organ that is about to act.
    // Memory recall runs once per mission, so an id found mid-mission never reaches later tasks
    // through recall.
    let known = '';
    try {
      known = renderResources(envelope.context?.resources, {
        limit: s.resourceLedgerRecallLimit,
        cues: t.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
      });
    } catch { known = ''; }
    return {
      instruction: t.text + (known ? `\n\n${known}\n${RESOURCE_PRECEDENCE}` : ''),
      accept_criteria: t.criteria,
      _missionId: envelope.id,
      _projectContext: projectContext,
      _sourceText: envelope.source_text || null,
      _requester: requesterOf(envelope),
      // Prior work is sent once: finished checkpoints as digests, the checkpoint in flight verbatim.
      prior_results_context: buildPriorWorkContext({
        checkpoints: plan,
        allResults,
        cpResults,
        currentCpNum: cpNum,
        missionId: envelope.id,
        stepChars: s.ctxAgentStep,
        digestChars: s.checkpointDigestChars,
      }) || null,
      memory_context: envelope.memory_context || null,
      // Checkpoint tasks are execution work: the memory organ gets its memory tools only with this.
      _exec: true,
    };
  }

  // A task's transcript, kept under missions/<id>/steps/ in the mission tree: process notes the
  // motor can read back, not project artifacts. The tree's git excludes keep missions/ out of every
  // commit, so these never land in the project and reappear in a later mission's tree.
  function writeStepNote(envelope, cpNum, taskNum, title, result) {
    if (typeof missionDir !== 'function' || !result.success || !result.output || result.output.length <= 200) return;
    try {
      const slug = String(title || `task-${cpNum}-${taskNum}`).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const dir = join(missionDir(envelope.id), 'missions', envelope.id, 'steps');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${cpNum}.${taskNum}-${slug}.md`), result.output);
    } catch (e) {
      log('DEBUG', `[checkpoint-executor] step note not written: ${e.message}`);
    }
  }

  async function runTask({ envelope, plan, cpEnv, cpNum, ti, t, step, allResults, cpResults }) {
    const taskNum = ti + 1;
    const prior = [...allResults, ...cpResults];
    const taskId = generateId('w');
    const at = iso();
    const tEnv = {
      id: taskId,
      type: 'T',
      parent_id: cpEnv.id,
      status: 'active',
      intent: t.intent,
      title: t.text.substring(0, 100),
      instruction: t.text,
      accept_criteria: t.criteria,
      context_summary: prior.length > 0
        ? prior.map((r) => `Step ${r.step} (${r.agent}): ${toStr(r.result).substring(0, 300)}`).join('\n')
        : null,
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: 'brain',
      source_meta: { dispatched_by: cpEnv.id, checkpoint: cpNum, task_step: taskNum, step_type: t.stepType, agent: t.organ },
      project_id: envelope.project_id || null,
      created_at: at,
      started_at: at,
      completed_at: null,
      updated_at: at,
      iteration: 0,
    };
    await save(tEnv);
    await writeHistory(taskId, null, 'active', 'brain', `CP${cpNum} Task ${taskNum}: ${t.organ}`);
    cpEnv.children = [...(cpEnv.children || []), taskId];
    cpEnv.updated_at = at;
    await save(cpEnv);

    log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: ${t.organ} — ${t.text.substring(0, 60)}`);
    const payload = buildPayload({ envelope, plan, cpNum, t, allResults, cpResults });

    let checked = applyMotorCheck(await dispatch(t.organ, payload), { organ: t.organ, taskText: t.text });
    if (checked.recoveredFrom) log('WARN', `[checkpoint-executor] CP${cpNum} T${taskNum}: the motor recovered from "${checked.recoveredFrom}" and produced a result; the cerebellum arbitrates`);
    const first = prepareRetry(checked.result);
    let result = first.result;

    // One retry for a required task. An optional task's failure is reported, not retried.
    if (!result.success && !t.optional) {
      log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum} failed (${t.organ}): ${result.error}. Retrying`);
      checked = applyMotorCheck(await dispatch(t.organ, {
        ...payload,
        instruction: `${payload.instruction}\n\n[RETRY] Previous attempt failed: ${result.error}. ${RETRY_GUIDANCE}${first.nudges}`,
        prior_results_context: [
          payload.prior_results_context,
          `[PREVIOUS ATTEMPT FAILED] ${result.error}\nOutput: ${smartTruncate(result.output || '', 500)}`,
        ].filter(Boolean).join('\n\n'),
      }), { organ: t.organ, taskText: t.text });
      if (checked.recoveredFrom) log('WARN', `[checkpoint-executor] CP${cpNum} T${taskNum}: the retry recovered from "${checked.recoveredFrom}"`);
      result = checked.result;
    }

    const floor = withEvidenceWarnings(result, { organ: t.organ });
    if (floor.warnings.length > 0) log('WARN', `[checkpoint-executor] CP${cpNum} T${taskNum}: evidence floor: ${floor.warnings.length} warning(s)`);
    result = floor.result;

    const ok = result.success === true;
    const error = ok ? null : (result.error || 'the task failed');
    tEnv.output = result.output || result.error || null;
    tEnv.error = error;
    await setStatus(tEnv, ok ? 'complete' : 'failed',
      ok ? `Completed (${result.durationMs || 0}ms)` : `Failed: ${error}`,
      { actor: t.organ, event: ok ? {} : { error } });

    captureResources(envelope, tEnv.output, step);
    writeStepNote(envelope, cpNum, taskNum, tEnv.title, result);

    const row = {
      step,
      agent: t.organ,
      task: t.text.substring(0, 200),
      // `result` keeps up to ctxAgentStep of the output, because the cerebellum verifies from it. The
      // cortex reads the packet summary; the full output stays on the task envelope, fetched by ref.
      result: ok
        ? smartTruncate(result.output || '', s.ctxAgentStep)
        : `[FAILED] ${error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', s.ctxDispatchFailure)}`,
      success: ok,
      durationMs: result.durationMs || 0,
      // A timeout's outcome is unknown, not failed: finalization does not count it as failed work.
      ...(!ok && result.timedOut ? { timedOut: true } : {}),
    };
    const pkt = buildResultPacket({
      text: ok ? (result.output || '') : row.result,
      ref: taskId,
      budget: s.packetSummaryChars,
      topK: s.listSummaryTopK,
      minProse: s.toolAnswerMinProseChars,
    });
    Object.assign(row, { summary: pkt.summary, ref: pkt.ref, bytes: pkt.bytes, shape: pkt.shape });
    log('INFO', `[TELEMETRY] result_packet step=${step} shape=${pkt.shape} bytes=${pkt.bytes} summary_chars=${pkt.summary.length} ref=${taskId}`);
    return { row, fullOutput: toStr(result.output || result.error || ''), taskId, error };
  }

  // ---- The approval gate ----

  function deliveryAddress(envelope) {
    if (typeof addressFromMeta === 'function') return addressFromMeta(envelope.source_meta, envelope.source_channel);
    const meta = envelope.source_meta || {};
    const a = meta.address;
    if (a && typeof a === 'object' && a.channel) return makeAddress(a.channel, { space: a.space, thread: a.thread });
    if (meta.spaceName || meta.space) return makeAddress('gchat', { space: meta.spaceName || meta.space, thread: meta.threadName });
    return makeAddress(envelope.source_channel === 'gchat' ? 'gchat' : 'dashboard');
  }

  async function writeApprovalRequest({ envelope, approvalId, title, description, allResults }) {
    // The work so far, not just this checkpoint's: a gate that opens its checkpoint has no results
    // of its own, and an empty list left the writer nothing to say about what was done.
    const steps = allResults.slice(-8).map((r) => ({
      step: r.step, agent: r.agent, success: r.success, result: toStr(r.result).substring(0, 1500),
    }));
    const core = `**${title}**\n\n${description}`;
    let body = core;
    if (typeof summarizeForDelivery === 'function') {
      try {
        body = (await summarizeForDelivery('approval_request', core, { steps, title, customMessage: description })) || core;
      } catch (e) {
        log('WARN', `[checkpoint-executor] approval request rewrite failed: ${e.message}; sending it as written`);
      }
    }
    const id = generateId('w');
    const at = iso();
    const written = await db.write(workPath(id), {
      id,
      type: 'T',
      // A notification under its mission. The mouth delivers a pending notification whatever its
      // parent; a gate is a question for a person, so it is always delivered. A scheduled mission's
      // gate once went undelivered because the mission had a parent.
      parent_id: envelope.id,
      status: 'complete',
      intent: 'notification',
      title: 'Approval needed',
      instruction: 'Approval gate notification',
      accept_criteria: '',
      output: `🔔 **Approval needed**\n\n${body}\n\nReply \`approve\` or \`reject\` here, or use the dashboard.`,
      context_summary: null,
      context_forward: null,
      error: null,
      children: [],
      source_channel: envelope.source_channel || 'system',
      source_meta: { approval_id: approvalId, notification_type: 'approval_gate' },
      project_id: envelope.project_id || null,
      created_at: at,
      started_at: at,
      completed_at: at,
      updated_at: at,
      iteration: 0,
      delivery_status: 'pending',
      delivery_address: deliveryAddress(envelope),
    });
    if (!written) {
      log('WARN', `[checkpoint-executor] the request for approval ${approvalId} could not be written; the approval still shows in the dashboard`);
      return;
    }
    await writeHistory(id, null, 'complete', 'brain', `Approval request ${approvalId} ready to deliver`);
  }

  async function raiseGate({ envelope, plan, ci, ti, tasks, cpEnv, cpResults, allResults, t }) {
    const cpNum = ci + 1;
    log('INFO', `[checkpoint-executor] CP${cpNum} Task ${ti + 1}: approval gate, pausing the mission`);
    // What the person is saying yes to: the work that runs once this is approved, the rest of this
    // checkpoint or else the next checkpoint. Never the gate's own criteria ("Approval granted."),
    // which once showed as the request's description while it was still pending.
    let next = tasks.slice(ti + 1).map((x) => toStr(x?.task || x?.instruction)).filter(Boolean);
    if (next.length === 0 && ci + 1 < plan.length) next = [toStr(plan[ci + 1]?.instruction)].filter(Boolean);
    const description = describeApprovalGate({ next });
    const project = envelope.project_id && projects && typeof projects.get === 'function' ? projects.get(envelope.project_id) : null;
    const approvalId = generateId('apr');
    const record = buildApprovalRecord({
      envelope,
      checkpointId: cpEnv.id,
      checkpointIndex: ci,
      taskIndex: ti,
      title: t.text,
      description,
      projectName: project?.name || '',
      requestedBy: requesterOf(envelope),
      now: iso(),
    });
    // No approval document, no pause: a mission paused on an approval nobody can see would wait
    // forever. Nothing is changed yet, so the mission stays active for the brain to retry.
    if (!(await approvals.create(approvalId, record))) throw new ApprovalNotRaised(approvalId, envelope.id);

    allResults.push(...cpResults);
    cpEnv.source_meta = { ...(cpEnv.source_meta || {}), approval_id: approvalId, approval_task_index: ti };
    await setStatus(cpEnv, 'awaiting_approval', `Approval gate: ${t.text.substring(0, 60)}`);

    // Resume state for the approval poller: it continues the plan at the task after the gate.
    envelope.source_meta = {
      ...(envelope.source_meta || {}),
      paused_approval_id: approvalId,
      paused_checkpoint_index: ci,
      paused_task_index: ti,
      paused_checkpoints: plan,
      paused_all_results: [...allResults],
    };
    await setStatus(envelope, 'awaiting_approval', `Approval gate: ${t.text.substring(0, 60)}`, { strict: true });

    await writeApprovalRequest({ envelope, approvalId, title: (t.text || 'Approval needed').substring(0, 200), description, allResults });
    log('INFO', `[checkpoint-executor] paused at CP${cpNum} task ${ti + 1}, awaiting approval ${approvalId}`);
    return { paused: true, approvalId };
  }

  // ---- One checkpoint ----

  /**
   * A checkpoint with no tasks left to run: every task already completed (an approval resumed past
   * a gate that ended its checkpoint), or it had none. It is marked complete on the spine every time.
   * Otherwise the first incomplete index keeps pointing at it, and a later re-plan restarts the
   * mission there, re-running finished work in a loop.
   */
  async function skipCheckpoint({ envelope, plan, ci, matches, allResults }) {
    const cpNum = ci + 1;
    log('INFO', `[checkpoint-executor] CP${cpNum}: no tasks left to run, skipping`);
    if (!matches.some((c) => c.status === 'complete')) {
      const cpEnv = matches.filter((c) => !TERMINAL_STATUSES.includes(c.status)).pop()
        || await createCheckpointEnvelope(envelope, plan[ci] || {}, cpNum, plan.length, allResults);
      cpEnv.output = 'Skipped: no tasks left to run';
      await setStatus(cpEnv, 'complete', 'Skipped (no tasks, or every task already completed)', { event: { output: cpEnv.output } });
    }
    if (Array.isArray(envelope._cp_spine) && envelope._cp_spine[ci] && envelope._cp_spine[ci].status !== 'complete') {
      envelope._cp_spine = markCheckpoint(envelope._cp_spine, ci, 'complete', { now: iso() });
      log('INFO', `[TELEMETRY] spine_status mission=${envelope.id} cp=${cpNum} status=complete (skipped) spine=${spineSummary(envelope._cp_spine)}`);
    }
    envelope._cp_progress = { checkpointIndex: ci + 1, taskIndex: 0, allResults: [...allResults], checkpoints: plan };
    envelope.updated_at = iso();
    await save(envelope);
  }

  /**
   * Resuming inside a checkpoint (after an approval, or a crash): its earlier task rows arrived with
   * the saved results. They are this checkpoint's own evidence, not earlier checkpoints' verified
   * work, so they move back into its rows, each with the output its task envelope recorded for a
   * complete-evidence re-check. A row for a task about to run again, or be replayed, is dropped
   * rather than doubled.
   */
  async function reclaimRows({ allResults, cpNum, firstTask, cpResults, fullOutputs }) {
    const own = (r) => stepCheckpointNum(r?.step) === cpNum && !isMilestoneVerdict(r);
    const carried = allResults.filter(own);
    if (carried.length === 0) return;
    const others = allResults.filter((r) => !own(r));
    allResults.splice(0, allResults.length, ...others);
    for (const r of carried) {
      const taskNum = Number(String(r.step).split('.')[1]);
      if (!(taskNum <= firstTask)) continue;
      cpResults.push(r);
      const recorded = r.ref ? await load(r.ref) : null;
      if (recorded && recorded.status === 'complete' && recorded.output) {
        fullOutputs.push({ step: r.step, agent: r.agent, output: toStr(recorded.output) });
      }
    }
  }

  async function verify({ envelope, cpEnv, cpNum, cpResults, fullOutputs, allResults }) {
    // A checkpoint is always judged: one planned without criteria is judged on its stated outcome.
    const criteria = toStr(cpEnv.accept_criteria)
      || `The checkpoint's stated outcome is achieved: "${toStr(cpEnv.instruction).substring(0, 300)}". The task outputs show concrete evidence that it was produced.`;
    try {
      return await verifyMilestone({
        callAgent,
        missionId: envelope.id,
        cpNum,
        instruction: cpEnv.instruction,
        acceptCriteria: criteria,
        rows: cpResults,
        fullOutputs,
        priorRows: allResults,
        stakes: envelope.stakes || 'routine',
        loadBearing: (envelope._brief?.parts || []).some((part) => part && part.load_bearing),
        readToolResult,
        settings: s,
        log,
      });
    } catch (e) {
      // A verification that could not run has judged nothing: the milestone does not pass, and the
      // work is not called wrong.
      log('WARN', `[checkpoint-executor] CP${cpNum}: verification could not run: ${e.message}; failing closed`);
      return {
        verdict: 'not_met', passed: false, inconclusive: true, needsReview: true, caveats: [], trail: [],
        row: {
          step: `${cpNum}.verify`, agent: 'cerebellum', success: false, inconclusive: true,
          result: `[CHECKPOINT VERIFICATION INCONCLUSIVE] Verification could not run (${e.message}), so this milestone is unverified and does not pass. The work was NOT judged wrong.`,
        },
      };
    }
  }

  async function commitCheckpoint(envelope, cpEnv, cpNum) {
    if (!artifacts || typeof artifacts.commitAndSync !== 'function' || !envelope.project_id) return;
    try {
      const d = new Date(clock());
      envelope.context = envelope.context || {};
      // The day's version index is allocated once per mission and kept, so every checkpoint commit
      // and the final publish share it: v<date>.<index>.<checkpoint>.
      if (!envelope.context.git_version_index) {
        let index = 1;
        if (typeof missionDir === 'function') {
          try { index = allocateVersion(missionDir(envelope.id), s.defaultBranch, d) || 1; } catch { index = 1; }
        }
        envelope.context.git_version_index = index;
      }
      envelope.context.git_checkpoint_count = cpNum;
      const message = `v${d.toISOString().slice(0, 10).replace(/-/g, '.')}.${envelope.context.git_version_index}.${cpNum}: ${toStr(cpEnv.title || `checkpoint-${cpNum}`).slice(0, 60)}`;
      const sync = await artifacts.commitAndSync(envelope.id, envelope.project_id, message);
      if (sync?.committed) log('INFO', `[checkpoint-executor] CP${cpNum}: committed ${String(sync.sha || '').slice(0, 8)} (synced=${sync.synced})`);
    } catch (e) {
      log('WARN', `[checkpoint-executor] CP${cpNum}: commit and sync failed (not fatal): ${e.message}`);
    }
  }

  async function runCheckpoint({ envelope, plan, ci, firstTask, allResults }) {
    const cp = plan[ci] || {};
    const cpNum = ci + 1;
    const tasks = Array.isArray(cp.tasks) ? cp.tasks : [];
    const matches = await checkpointEnvelopes(envelope, cpNum);

    if (firstTask >= tasks.length) {
      await skipCheckpoint({ envelope, plan, ci, matches, allResults });
      return { failed: false };
    }

    // Resume the checkpoint's envelope when one is still open (a crash, or an approval); a finished
    // one is never reopened, so a re-attempt gets a new envelope.
    let cpEnv = matches.filter((c) => !TERMINAL_STATUSES.includes(c.status)).pop() || null;
    if (!cpEnv) cpEnv = await createCheckpointEnvelope(envelope, cp, cpNum, plan.length, allResults);
    else if (cpEnv.status !== 'active') await setStatus(cpEnv, 'active', `Checkpoint ${cpNum} resumed`);

    log('INFO', `[checkpoint-executor] Checkpoint ${cpNum}/${plan.length}: ${toStr(cpEnv.instruction).substring(0, 60)} (${tasks.length} tasks)`);

    const cpResults = [];
    // Untruncated outputs, kept in memory only (a Firestore document holds at most 1 MiB), so the
    // cerebellum can re-verify from complete evidence.
    const fullOutputs = [];
    if (firstTask > 0) await reclaimRows({ allResults, cpNum, firstTask, cpResults, fullOutputs });
    let cpFailed = false;

    for (let ti = firstTask; ti < tasks.length; ti++) {
      const t = readTask(tasks[ti]);
      const taskNum = ti + 1;
      const step = `${cpNum}.${taskNum}`;

      // The memory boundary: a memory-scoped mission changes only the memory layers. Its tasks run
      // on the memory organs, and it may not open an approval gate.
      if (isMemoryScoped(envelope)) {
        const fence = fenceMemoryTask({ stepType: t.stepType, taskAgent: t.organ });
        if (fence.action === 'reroute') {
          log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: [memory-scope] ${fence.reason}`);
          t.organ = fence.agent;
        } else if (fence.action === 'refuse') {
          log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: [memory-scope] refused: ${fence.reason}`);
          cpResults.push({ step, agent: 'system', result: `[REFUSED] ${fence.reason}`, success: false });
          continue;
        }
      }

      if (t.stepType === 'approval_gate') {
        return raiseGate({ envelope, plan, ci, ti, tasks, cpEnv, cpResults, allResults, t });
      }

      if (!t.organ) {
        log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: no organ named, skipping`);
        cpResults.push({ step, agent: 'unknown', task: t.text.substring(0, 200), result: '[SKIPPED] The plan named no organ for this task.', success: false });
        continue;
      }

      // The step ledger: a task that already completed in this iteration is replayed, with the
      // output its task envelope recorded, so the verifier still sees the real result.
      const key = deriveStepKey(envelope.id, cpNum, 'cp_task', `${ci}.${ti}.${t.organ}`, envelope.iteration);
      const done = completedStep(envelope.step_ledger, key);
      if (done) {
        const recorded = done.ref ? await load(done.ref) : null;
        const output = recorded && recorded.status === 'complete' ? toStr(recorded.output) : '';
        log('INFO', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: already completed, replaying${output ? ' its recorded output' : ''}`);
        cpResults.push({
          step,
          agent: t.organ,
          task: t.text.substring(0, 200),
          result: output
            ? `[REPLAYED] Step already completed; its recorded output follows.\n${smartTruncate(output, s.ctxAgentStep)}`
            : `[REPLAYED] Step already completed (${done.status})`,
          success: true,
          durationMs: done.durationMs || 0,
          replayed: true,
          ...(done.ref ? { ref: done.ref } : {}),
        });
        if (output) fullOutputs.push({ step, agent: t.organ, output });
        continue;
      }

      if (!VALID_TASK_ORGANS.includes(t.organ)) {
        const message = `Invalid task organ "${t.organ}": must be one of ${VALID_TASK_ORGANS.join(', ')}`;
        log('WARN', `[checkpoint-executor] CP${cpNum} Task ${taskNum}: ${message}`);
        cpResults.push({ step, agent: t.organ, task: t.text.substring(0, 200), result: message, success: false, durationMs: 0 });
        if (!t.optional) { cpFailed = true; break; }
        continue;
      }

      const ran = await runTask({ envelope, plan, cpEnv, cpNum, ti, t, step, allResults, cpResults });
      cpResults.push(ran.row);
      fullOutputs.push({ step, agent: t.organ, output: ran.fullOutput });

      // The ledger entry and the progress go in one write. After the last task, progress points back
      // at it, so a crash before the milestone is judged replays that task and verifies, instead of
      // skipping a checkpoint nobody verified.
      envelope.step_ledger = recordStep(envelope.step_ledger, key, {
        success: ran.row.success, error: ran.error, durationMs: ran.row.durationMs, cp: cpNum, ref: ran.taskId,
      }, iso());
      envelope._cp_progress = {
        checkpointIndex: ci,
        taskIndex: ti + 1 < tasks.length ? ti + 1 : ti,
        allResults: [...allResults, ...cpResults],
        checkpoints: plan,
      };
      envelope.updated_at = iso();
      await save(envelope);

      if (!ran.row.success) { cpFailed = true; break; }
    }

    // ---- The milestone ----
    if (!cpFailed) {
      const review = await verify({ envelope, cpEnv, cpNum, cpResults, fullOutputs, allResults });
      if (review.row) cpResults.push(review.row);
      if (review.needsReview) cpEnv.needs_review = true;
      if (!review.passed) {
        cpFailed = true;
      } else if (review.caveats.length > 0) {
        envelope._milestone_caveats = [
          ...(Array.isArray(envelope._milestone_caveats) ? envelope._milestone_caveats : []),
          `CP${cpNum}: ${review.caveats.join(' ')}`,
        ];
        log('INFO', `[TELEMETRY] milestone_caveat mission=${envelope.id} cp=${cpNum}`);
      }
    }

    // A failed checkpoint's tasks run again on the next attempt: clear their ledger entries so a
    // replay does not hand the verifier the same judged-wrong work.
    if (cpFailed) {
      const { ledger, cleared } = clearCheckpointSteps(envelope.step_ledger, cpNum);
      if (cleared > 0) {
        envelope.step_ledger = ledger;
        log('INFO', `[checkpoint-executor] CP${cpNum} failed: cleared ${cleared} step-ledger entr${cleared === 1 ? 'y' : 'ies'} so the next attempt re-runs its tasks`);
      }
    }

    // The executor is the only thing that knows whether a milestone passed, so it owns this write.
    if (Array.isArray(envelope._cp_spine)) {
      envelope._cp_spine = markCheckpoint(envelope._cp_spine, ci, cpFailed ? 'failed' : 'complete', { now: iso() });
      log('INFO', `[TELEMETRY] spine_status mission=${envelope.id} cp=${cpNum} status=${cpFailed ? 'failed' : 'complete'} spine=${spineSummary(envelope._cp_spine)}`);
    }

    // Count real task rows, not the verdict row, so a milestone failure never reads as a task overflow.
    const taskCount = cpResults.filter((r) => !isMilestoneVerdict(r)).length;
    const verifyFailed = cpResults.some((r) => isMilestoneVerdict(r) && !r.success);
    cpEnv.output = !cpFailed
      ? `Checkpoint complete: ${taskCount} tasks`
      : verifyFailed
        ? `Checkpoint failed: milestone verification not passed (${taskCount}/${tasks.length} tasks ran)`
        : `Checkpoint failed at task ${taskCount}/${tasks.length}`;
    // A digest for observability only; prior-work context is recomputed from the results.
    cpEnv._cp_digest = renderCheckpointDigest({
      cpNum,
      instruction: cpEnv.instruction || '',
      acceptCriteria: cpEnv.accept_criteria || '',
      results: cpResults,
      missionId: envelope.id,
      capChars: s.checkpointDigestChars,
    });
    await setStatus(cpEnv, cpFailed ? 'failed' : 'complete',
      cpFailed ? `Failed (${taskCount} task(s) ran)` : `Complete (${taskCount} tasks)`,
      { event: cpFailed ? { error: cpEnv.output } : {} });

    allResults.push(...cpResults);
    if (!cpFailed) {
      await commitCheckpoint(envelope, cpEnv, cpNum);
      envelope._cp_progress = { checkpointIndex: ci + 1, taskIndex: 0, allResults: [...allResults], checkpoints: plan };
    }
    envelope.updated_at = iso();
    await save(envelope);
    return { failed: cpFailed };
  }

  /**
   * Runs a checkpoint plan for one mission, from `startCpIndex` / `startTaskIndex`.
   *
   * @param {Array}  checkpoints - the plan (see the file header)
   * @param {object} run
   * @param {object} run.envelope - the mission envelope, as read from Firestore. Changed in place and
   *   saved; the brain keeps using the same object. It is moved to `active` first if it is not (a
   *   resumed approval arrives `awaiting_approval`); a finished mission cannot be run and throws.
   * @param {number} [run.startCpIndex=0]   - first checkpoint to run (a scoped re-plan starts past the
   *   checkpoints that passed: rebuildFromSpine's startCpIndex)
   * @param {number} [run.startTaskIndex=0] - first task within that checkpoint (after an approval: the
   *   task after the gate; after a crash: `_cp_progress.taskIndex`)
   * @param {Array}  [run.savedResults=[]] - results banked before this run (a re-plan's passed
   *   checkpoints, or `paused_all_results` / `_cp_progress.allResults`); earlier evidence for the
   *   verifier, and the first rows of `results`
   * @returns {Promise<{success: boolean, results: Array} | {paused: true, approvalId: string, results: Array}>}
   * @throws {ApprovalNotRaised} when a gate's approval document cannot be written (nothing is paused)
   * @throws {Error} on an illegal status change while transitionGuard is 'enforce'
   */
  async function executeCheckpoints(checkpoints, run = {}) {
    const { envelope, startCpIndex = 0, startTaskIndex = 0, savedResults = [] } = run;
    if (!envelope || !envelope.id) throw new Error('executeCheckpoints: run.envelope (the mission envelope) is required');
    const plan = Array.isArray(checkpoints) ? checkpoints : [];

    if (envelope.status !== 'active') await setStatus(envelope, 'active', 'Running the checkpoint plan');
    seedResources(envelope);

    const allResults = Array.isArray(savedResults) ? [...savedResults] : [];
    const first = Math.max(0, startCpIndex | 0);
    let planFailed = false;
    for (let ci = first; ci < plan.length; ci++) {
      const outcome = await runCheckpoint({
        envelope, plan, ci, firstTask: ci === first ? Math.max(0, startTaskIndex | 0) : 0, allResults,
      });
      if (outcome.paused) return { paused: true, approvalId: outcome.approvalId, results: allResults };
      if (outcome.failed) { planFailed = true; break; }
    }

    envelope._cp_progress = null;
    envelope.updated_at = iso();
    await save(envelope);
    return { success: !planFailed, results: allResults };
  }

  return { executeCheckpoints };
}
