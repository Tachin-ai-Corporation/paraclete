// agent/services/brain/actions/checkpoint-plan.mjs: the checkpoint_plan move, how every piece of
// execution happens. It settles the plan, runs it through the checkpoint executor, and turns the
// results into the next decision's input.
//
// Settling the plan: the first plan pins the mission's checkpoint spine (outcomes and criteria), and
// a later checkpoint_plan re-tasks only the first checkpoint that has not passed, against its pinned
// outcome, so a failure at checkpoint 2 never re-runs a checkpoint 1 that passed. A re-plan of a
// mission whose checkpoints all passed in this run is refused: verified work is delivered, not redone.
// A memory-scoped mission's plan is written by code, as one pass on the memory organ. Ids the mission
// already resolved are seeded from the request, shown to the planner, and mistyped ids are repaired
// before anything pins them. Called by the decide loop in envelope-runner.mjs.

import {
  applyReplan, buildSpine, diagnoseCheckpointFailure, firstIncompleteIndex, passedThisRun, rebuildFromSpine, spineSummary,
} from '../../../work/checkpoint-spine.mjs';
import { ApprovalNotRaised, VALID_TASK_ORGANS } from '../../../work/checkpoint-executor.mjs';
import { extractCheckpoints } from '../../../work/plan-utils.mjs';
import { findBackReferences, formatBackReference } from '../../../work/plan-lint.mjs';
import { isMemoryScoped, memoryMissionPlan } from '../../../work/memory-scope.mjs';
import { renderResources, repairIds, seedFromProse } from '../../../work/resource-ledger.mjs';
import { storedResultRefs } from '../../../context/tool-record.mjs';
import { toStr } from '../../../providers/to-str.mjs';
import { planInstruction, singleCheckpointInstruction } from '../prompt-assembly.mjs';

/** How many times a mission's plan may fail before the cortex must escalate instead of re-planning. */
export const MAX_REPLANS = 3;

const isFailedVerdictNote = (r) => typeof r?.result === 'string' && r.result.includes('[CHECKPOINT VERIFICATION FAILED]');

/**
 * Repairs mistyped ids in a plan against the mission's resource ledger, in place. Telling a planner
 * to copy ids carefully does not work (one plan copied three ids and got one wrong by a character,
 * which then fails identically on every retry and gets pinned), so code fixes it: only a unique
 * edit-distance-1 match against a known id counts as a typo. Also logs plans whose task depends on an
 * id an earlier task must discover, the shape that once built three documents from the wrong template.
 *
 * @returns {{repairs: Array, unknown: string[]}}
 */
export function repairPlan(checkpoints, ledger, { log = () => {}, missionId = '', where = '' } = {}) {
  const repairs = [];
  const unknown = [];
  if (!Array.isArray(checkpoints) || checkpoints.length === 0 || !ledger || Object.keys(ledger).length === 0) {
    return { repairs, unknown };
  }
  const fix = (obj, field) => {
    if (typeof obj?.[field] !== 'string' || !obj[field]) return;
    const out = repairIds(obj[field], ledger);
    if (out.repairs.length > 0) obj[field] = out.text;
    repairs.push(...out.repairs);
    for (const u of out.unknown) if (!unknown.includes(u)) unknown.push(u);
  };
  for (const cp of checkpoints) {
    fix(cp, 'instruction');
    fix(cp, 'accept_criteria');
    for (const t of cp.tasks || []) {
      fix(t, 'task');
      fix(t, 'instruction');
      fix(t, 'accept_criteria');
    }
  }
  for (const r of repairs) log('WARN', `[TELEMETRY] id_repair mission=${missionId} at=${where} kind=${r.kind} name="${r.name}" from=${r.from} to=${r.to}`);
  try {
    for (const f of findBackReferences(checkpoints)) log('WARN', `[TELEMETRY] plan_backref mission=${missionId} at=${where} ${formatBackReference(f)}`);
  } catch (e) {
    log('WARN', `plan back-reference lint failed: ${e.message}`);
  }
  if (unknown.length > 0) log('INFO', `[TELEMETRY] id_unverified mission=${missionId} at=${where} count=${unknown.length} ids=${unknown.slice(0, 5).join(',')}`);
  return { repairs, unknown };
}

/**
 * @param {object} ctx  - { envelope, decision, priorResults, iteration }
 * @param {object} deps - { store, executor, callAgent, enforceSchema, processes, projects,
 *   capabilityMap(), planSkill(), settings, log }
 */
export async function handleCheckpointPlan(ctx, deps) {
  const { envelope, decision, priorResults, iteration } = ctx;
  const { store, executor, callAgent, enforceSchema, settings, log } = deps;
  const capabilityMap = deps.capabilityMap ? deps.capabilityMap() : '';
  const playbooks = deps.processes ? Object.values(deps.processes.getAllProcesses() || {}) : [];

  // ---- The pinned spine ----
  const spine = Array.isArray(envelope._cp_spine) ? envelope._cp_spine : null;
  const scopedIdx = spine ? firstIncompleteIndex(spine) : -1;
  const isScopedReplan = scopedIdx >= 0 && scopedIdx < (spine?.length || 0);
  const forceFullReplan = decision.replan_scope === 'mission' || decision.replan_full === true;

  // A mission whose checkpoints all passed, with none failed, has verified work to deliver. The same
  // re-shape also arrives unannounced: a plain checkpoint_plan once every checkpoint passed in this
  // run (a weekly briefing passed every checkpoint, read a digested read-back as "truncated", and
  // planned itself again four times).
  const implicitReshape = !forceFullReplan && passedThisRun(spine, priorResults);
  const hasFailure = Boolean(spine?.some((s) => s?.status === 'failed'));
  const hasComplete = Boolean(spine?.some((s) => s?.status === 'complete'));
  if (spine && (forceFullReplan || implicitReshape) && hasComplete && !hasFailure) {
    const passRefs = [...new Set((priorResults || []).filter((r) => r?.ref && r.success).map((r) => r.ref))].slice(0, 6);
    const fullRefs = [...new Set((priorResults || []).flatMap((r) => storedResultRefs(toStr(r?.result))))].slice(0, 8);
    log('WARN', `[TELEMETRY] full_replan_refused mission=${envelope.id} spine=${spineSummary(spine)} implicit=${implicitReshape} reason=${String(decision.replan_reason || '').slice(0, 160)}`);
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] Re-plan refused: the checkpoints run so far all PASSED verification and none failed, so a new plan would discard verified work and run the mission again. Return "synthesize" and write the answer now, or "synthesize_with_failure" if the verified work does not meet the request. If a passed task's summary is not enough to write it, name its ref in "request_context"${passRefs.length ? ` (${passRefs.join(', ')})` : ''} to fetch the full output. A large tool result inside a task's log is a DIGEST of a stored result, not a cut: its own ref returns it word for word${fullRefs.length ? ` (${fullRefs.join(', ')})` : ''}. Do NOT re-plan to re-observe a result you can read.`,
      }],
      // Turns a further checkpoint_plan into synthesize. A turn that fetches context does not use it
      // up, and any later refusal re-arms it while the spine still says every checkpoint passed.
      activeGuard: { forbidden: 'checkpoint_plan', fallback: 'synthesize', injectedAt: iteration, context: {} },
    };
  }
  if (spine && forceFullReplan) {
    log('WARN', `[TELEMETRY] spine_replaced mission=${envelope.id} reason=${decision.replan_reason || 'mission-scope re-plan'} prior=${spineSummary(spine)}`);
    envelope._cp_spine = null;
  }

  // ---- Known ids, carried to the planner ----
  // Seeded before the first plan: the plan that introduces a typo is the first one, and it once saw
  // an empty ledger even when the person had stated the ids outright.
  let idRule = '';
  try {
    const seedText = [envelope.instruction, envelope.source_text, envelope.context_summary].filter(Boolean).map(toStr).join('\n');
    envelope.context = envelope.context || {};
    const { ledger, added, updated } = seedFromProse(envelope.context.resources, seedText, {
      max: settings.resourceLedger.max, now: store.iso(), source: 'request',
    });
    envelope.context.resources = ledger;
    if (added || updated) log('INFO', `[TELEMETRY] resource_ledger mission=${envelope.id} step=plan added=${added} updated=${updated} total=${Object.keys(ledger).length}`);
    const block = renderResources(ledger, {
      limit: settings.resourceLedger.recallLimit,
      cues: String(decision.goal || decision.instruction || envelope.instruction || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
    });
    if (block) {
      idRule = `${block}\nEvery id above was read back from a tool result. When a task needs one of these resources, COPY the id from this block character for character. Never retype one from memory or from an earlier task, and never invent one: if a resource you need is not listed, name it and let the executing organ resolve it.`;
    }
  } catch (e) {
    log('WARN', `planner resource block failed: ${e.message}`);
  }
  const repair = (cps, where) => repairPlan(cps, envelope.context?.resources, { log, missionId: envelope.id, where });

  // ---- The cortex's own plan, if it gave a valid one ----
  let checkpoints = extractCheckpoints(decision);
  repair(checkpoints, 'cortex_inline');
  let planSource = checkpoints && checkpoints.length > 0 ? 'cortex_inline' : 'none';
  if (checkpoints && checkpoints.some((cp) => cp.tasks.some((t) => !VALID_TASK_ORGANS.includes(t.agent)))) {
    const bad = checkpoints.flatMap((cp) => cp.tasks).find((t) => !VALID_TASK_ORGANS.includes(t.agent));
    log('WARN', `checkpoint_plan: the cortex's plan names an organ that cannot run tasks ('${bad?.agent}'); asking the prefrontal to structure it`);
    checkpoints = null;
    planSource = 'none';
  }

  // A destructive or public part needs an approval gate. Surfaced once per mission, then the plan
  // proceeds as it is: an unbounded nudge once burned every iteration and stalled the mission. Not
  // for a memory mission, which may not open a gate and changes nothing outside memory.
  if (checkpoints && checkpoints.length > 0 && envelope._brief?.parts && !isMemoryScoped(envelope)) {
    const risky = envelope._brief.parts.filter((p) => p.risk === 'destructive_or_public');
    const gated = checkpoints.some((cp) => (cp.tasks || []).some((t) => t.step_type === 'approval_gate' || t._step_type === 'approval_gate'));
    if (risky.length > 0 && !gated) {
      const nudged = (priorResults || []).some((r) => typeof r?.result === 'string' && r.result.includes('[IRREVERSIBILITY WARNING]'));
      if (!nudged) {
        log('WARN', `[checkpoint_plan] ${risky.length} destructive or public part(s) and no approval_gate in the plan`);
        return {
          continue: true,
          priorResultsAppend: [{
            agent: 'system',
            result: `[IRREVERSIBILITY WARNING] The Brief has ${risky.length} destructive_or_public part(s) (${risky.map((p) => p.id).join(', ')}) but the plan has no approval_gate step. Add an approval_gate before the destructive action, or re-plan with the person's explicit confirmation.`,
          }],
        };
      }
      log('WARN', '[checkpoint_plan] the irreversibility warning was already given; proceeding with the plan as it is');
    }
  }

  // ---- Playbooks the planner should see ----
  let processHint = '';
  const goalText = String(decision.goal || decision.instruction || decision.reasoning || envelope.instruction || '').toLowerCase();
  const matching = playbooks.filter((p) => p.status !== 'deprecated' && (p.intent_keywords || []).some((kw) => goalText.includes(String(kw).toLowerCase())));
  if (matching.length > 0) {
    log('INFO', `[checkpoint_plan] playbook match: ${matching.map((p) => p.id).join(', ')}`);
    // Recorded for the lesson the memory organ writes after the mission, merged so a playbook the
    // responsibility named at fire time is kept.
    envelope.recalled_processes = [...new Set([...(envelope.recalled_processes || []), ...matching.map((p) => p.id)])];
    processHint = `[PROCESS PLAYBOOKS] A remembered narrative may cover this work:\n${matching.map((p) => `- ${p.id}: ${p.name} — ${String(p.narrative || p.description || '').substring(0, 200)}`).join('\n')}\nTreat any that fits as guidance and fold it into your OWN checkpoints: adapt it, keep control.`;
  }

  const projectContext = envelope.project_id && deps.projects ? (deps.projects.buildContext(envelope.project_id, null) || null) : null;
  const askPlanner = (instruction) => callAgent('prefrontal', {
    instruction,
    _missionId: envelope.id,
    _projectContext: projectContext,
    _sourceText: envelope.source_text || null,
  });

  let scope = 'mission';
  let startCpIndex = 0;
  // Results of checkpoints that already passed, carried into a resumed run so the next checkpoint's
  // verifier sees the work that met the earlier criteria.
  let banked = [];

  // ---- A memory-scoped mission: one pass, planned by code ----
  // Every task of a memory mission runs on temporal-memory, which writes only memory: a plan split
  // into checkpoints cannot hand its triage forward, and several nightly consolidations blocked on a
  // planner-invented plan file. A retry is the same pass, told which clauses were unmet.
  const memoryMission = isMemoryScoped(envelope);
  if (memoryMission) {
    const scoped = isScopedReplan && !forceFullReplan;
    const retry = scoped && envelope._cp_spine?.length === 1;
    const unmet = scoped ? ((priorResults || []).filter(isFailedVerdictNote).slice(-1)[0]?.result || decision.failure_summary || '') : '';
    const plan = memoryMissionPlan(envelope, { unmet });
    if (retry) {
      const { spine: next } = applyReplan(envelope._cp_spine, scopedIdx, plan[0].tasks, {
        pinCriteria: true, maxCriteriaRevisions: settings.maxCriteriaRevisions, now: store.iso(),
      });
      envelope._cp_spine = next;
      const rebuilt = rebuildFromSpine(next);
      checkpoints = rebuilt.checkpoints;
      startCpIndex = rebuilt.startCpIndex;
      scope = 'checkpoint';
    } else {
      // The first plan, or a spine from before this rule that still holds a planner's checkpoints.
      if (envelope._cp_spine) envelope._cp_spine = null;
      checkpoints = plan;
    }
    planSource = 'memory_scope';
    log('INFO', `[TELEMETRY] memory_plan mission=${envelope.id} retry=${scope === 'checkpoint'} unmet=${unmet ? 'yes' : 'no'}`);
  }

  // ---- A scoped re-plan: new tasks for the first checkpoint that has not passed ----
  if (!memoryMission && envelope._cp_spine && isScopedReplan && !forceFullReplan) {
    const target = envelope._cp_spine[scopedIdx];
    log('INFO', `checkpoint_plan: scoped re-plan of CP${target.n} (spine ${spineSummary(envelope._cp_spine)}); passed checkpoints keep their verdicts`);
    try {
      const failureNote = (priorResults || []).filter(isFailedVerdictNote).slice(-1)[0]?.result || decision.failure_summary || '';
      const diagnosis = diagnoseCheckpointFailure({ target, failureNote, taskRows: priorResults });
      log('INFO', `[TELEMETRY] replan_diagnosis mission=${envelope.id} cp=${target.n} lens=${diagnosis.lens} signals=${diagnosis.signals.join(',') || 'none'}`);
      const res = await askPlanner(singleCheckpointInstruction({
        target, skillDoc: deps.planSkill ? deps.planSkill() : '', capabilityMap, failureNote, idRule, diagnosis,
      }));
      let fresh = null;
      if (res?.success && res.output) {
        try {
          fresh = extractCheckpoints(await enforceSchema(res.output, 'plan'));
          // Before applyReplan, or a typo lands in the spine and is served back as prior work.
          repair(fresh, `scoped_cp${target.n}`);
        } catch (e) {
          log('WARN', `scoped re-plan could not be read: ${e.message}`);
        }
      }
      const tasks = fresh?.[0]?.tasks || [];
      if (tasks.length > 0) {
        const { spine: next, criteriaChanged, revisionRefused } = applyReplan(envelope._cp_spine, scopedIdx, tasks, {
          newCriteria: fresh[0].accept_criteria, pinCriteria: true, maxCriteriaRevisions: settings.maxCriteriaRevisions, now: store.iso(), lens: diagnosis.lens,
        });
        envelope._cp_spine = next;
        const rebuilt = rebuildFromSpine(next);
        checkpoints = rebuilt.checkpoints;
        startCpIndex = rebuilt.startCpIndex;
        planSource = 'prefrontal';
        scope = 'checkpoint';
        const done = new Set(next.filter((s) => s.status === 'complete').map((s) => String(s.n)));
        if (done.size > 0) {
          const prior = envelope._cp_progress?.allResults;
          banked = (Array.isArray(prior) ? prior : []).filter((r) => done.has(String(r?.step || '').split('.')[0]));
        }
        log('INFO', `scoped re-plan: CP${target.n} re-tasked (${tasks.length} tasks), resuming at CP${rebuilt.startCpIndex + 1} of ${next.length}${criteriaChanged ? ' [criteria refined]' : ''}${revisionRefused ? ' [criteria rewording refused: the pinned wording holds]' : ''}`);
      } else {
        log('WARN', 'scoped re-plan produced no tasks; structuring the whole mission instead');
      }
    } catch (e) {
      log('WARN', `scoped re-plan failed: ${e.message}; structuring the whole mission instead`);
    }
  }

  // ---- The prefrontal structures the plan ----
  if (!checkpoints || checkpoints.length === 0) {
    log('INFO', 'checkpoint_plan: no usable plan from the cortex; asking the prefrontal to structure one');
    try {
      const res = await askPlanner(planInstruction({
        goal: decision.goal || decision.instruction || decision.reasoning || envelope.instruction,
        brief: envelope._brief || null,
        skillDoc: deps.planSkill ? deps.planSkill() : '',
        capabilityMap,
        idRule,
        processHint,
        constraints: decision.constraints || '',
        priorResults,
      }));
      if (res?.success && res.output) {
        checkpoints = extractCheckpoints(await enforceSchema(res.output, 'plan'));
        repair(checkpoints, 'prefrontal_mission');
        if (checkpoints && checkpoints.length > 0) planSource = 'prefrontal';
      }
    } catch (e) {
      log('WARN', `plan structuring failed: ${e.message}`);
    }
  }

  // The first plan pins the spine: from now on a failure re-tasks a checkpoint instead of re-shaping.
  if (!Array.isArray(envelope._cp_spine) && checkpoints && checkpoints.length > 0) {
    envelope._cp_spine = buildSpine(checkpoints, { now: store.iso() });
    log('INFO', `checkpoint spine pinned: ${spineSummary(envelope._cp_spine)}`);
  }

  log('INFO', `[TELEMETRY] plan_structuring: ${JSON.stringify({
    source: planSource, scope, spine_reused: scope === 'checkpoint',
    checkpoints: checkpoints?.length || 0, tasks: checkpoints?.reduce((n, c) => n + c.tasks.length, 0) || 0, missionId: envelope.id,
  })}`);

  if (!checkpoints || checkpoints.length === 0) {
    log('ERROR', `checkpoint_plan for ${envelope.id} produced no plan`);
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] checkpoint_plan produced no valid plan. Give checkpoints with at least one task each, or a clear goal for the prefrontal.' }],
    };
  }

  // ---- Run it ----
  let run;
  try {
    run = await executor.executeCheckpoints(checkpoints, { envelope, startCpIndex, startTaskIndex: 0, savedResults: banked });
  } catch (e) {
    if (e instanceof ApprovalNotRaised) {
      // The gate could not be written, so nothing was paused. Keep where the plan stands so the next
      // attempt runs from here, and try again later: a storage failure is not a verdict on the work.
      if (!envelope._cp_progress) {
        envelope._cp_progress = { checkpointIndex: startCpIndex, taskIndex: 0, allResults: banked, checkpoints };
      }
      await store.save(envelope);
      log('WARN', `${e.message}; the mission will try again`);
      return { exit: true, retryLater: true };
    }
    throw e;
  }
  if (run.paused) return { exit: true };

  const results = run.results || [];
  const failed = !run.success;
  const append = results.map((r) => ({
    agent: r.agent,
    task: r.task,
    result: r.result,
    summary: r.summary,
    ref: r.ref,
    bytes: r.bytes,
    shape: r.shape,
    success: r.success,
    durationMs: r.durationMs,
    checkpoint_step: r.step,
    ...(r.inconclusive ? { inconclusive: true } : {}),
    ...(r.timedOut ? { timedOut: true } : {}),
    failure_type: r.success ? null
      : (typeof r.result === 'string' && (r.result.includes('Command failed') || r.result.includes('[ERROR]')) ? 'tool_error' : 'quality_rejection'),
  }));

  if (failed) {
    envelope._replan_count = (envelope._replan_count || 0) + 1;
    append.push({
      agent: 'system',
      result: envelope._replan_count >= MAX_REPLANS
        ? `[SYSTEM] Checkpoint plan failed ${envelope._replan_count} times. You MUST use "synthesize_with_failure" or "needs_input" to escalate. No more checkpoint_plan.`
        : `[SYSTEM] Checkpoint failed (attempt ${envelope._replan_count}/${MAX_REPLANS}). Do NOT break the work into finer or tool-level steps: the executing organ owns the how and makes many tool calls per task. Work that already succeeded in prior_results is DONE: do NOT repeat it. Re-plan ONLY the part that still needs to change, by fixing the outcome's framing or a bad input: say what the task must achieve, correct a wrong assumption, or supply a missing input, and keep tasks coarse and outcome-shaped. A failing command is the executing organ's to resolve inside its task. Otherwise use "needs_input" to escalate a real blocker.`,
    });
  }

  // Every task was replayed: no new work happened, so the cortex is looping on a plan already done.
  const allReplayed = results.length > 0 && results.every((r) => typeof r.result === 'string' && r.result.startsWith('[REPLAYED]'));
  if (allReplayed && !failed) {
    log('WARN', `[checkpoint_plan] all ${results.length} tasks were replayed; steering to synthesize`);
    append.push({ agent: 'system', result: '[SYSTEM] Every checkpoint task was already completed earlier: no new work was done. You MUST "synthesize" now from the results already gathered. Do NOT create another checkpoint_plan.' });
  }

  // A plan that passed does not complete the mission by itself: the cortex must choose synthesize.
  // Without this steer a discovery mission whose data rode as a ref re-planned instead of reading it.
  if (!failed && !allReplayed) {
    const passRefs = [...new Set(results.filter((r) => r?.ref && r.success).map((r) => r.ref))].slice(0, 6);
    const fullRefs = [...new Set(results.flatMap((r) => storedResultRefs(toStr(r?.result))))].slice(0, 8);
    append.push({
      agent: 'system',
      result: `[SYSTEM] All ${checkpoints.length} checkpoint(s) PASSED verification: the work is DONE. Return "synthesize" now and write the answer from your result summaries. If you need a task's FULL output to write it, name its ref in "request_context"${passRefs.length ? ` (${passRefs.join(', ')})` : ''} and it will be fetched for you. A large tool result inside a task's log is a DIGEST of a stored result, not a cut: its own ref returns it word for word${fullRefs.length ? ` (${fullRefs.join(', ')})` : ''}. Do NOT re-plan or re-run verified work to re-observe a result you can already read.`,
    });
  }

  log('INFO', `checkpoint plan ${failed ? 'FAILED' : 'complete'}: ${checkpoints.length} checkpoints, ${results.length} results; asking the cortex`);
  const out = { continue: true, priorResultsAppend: append };
  if (allReplayed && !failed) out.activeGuard = { forbidden: 'checkpoint_plan', fallback: 'synthesize', injectedAt: iteration, context: {} };
  return out;
}
