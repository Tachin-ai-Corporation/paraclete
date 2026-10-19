// agent/work/memory-scope.mjs: the mission-level half of the memory boundary. Recognizes a
// memory-scoped mission, fences each of its tasks to the memory organs, and writes its one-pass
// plan. Pure: every decision is a function of the envelope, the step type and the task's organ.
// The gateway half, which gives temporal-memory (the organ that maintains the agent's memory) only
// memory tools, lives in agent/gateway. Called by the checkpoint executor for every task and by
// the brain's planning step.
//
// Memory is a closed set of three layers: working memory (MEMORY.md), Core Memory and Deep
// Truths, and a mission whose job is memory writes nothing else. A responsibility declares that
// with `effect_scope: "memory"` (the nightly consolidation does), and the scheduler stamps it onto
// the mission's source_meta.
//
// Why a mission fence and not just the organ's toolset: a consolidation plan can assign a task to
// motor (the organ that executes tasks with tools), which holds a full shell. One did, and
// rewrote project context through the project CLI. Routing motor's task to temporal-memory keeps
// the work and drops the reach.

export const MEMORY_SCOPE = 'memory';

// Organs that may act in a memory mission. Temporal-memory is the memory authority (its toolset is
// memory-only); temporal-research (the organ that researches outside sources) changes nothing in
// memory. It has the open toolset (agent/gateway/organs.mjs), so only its prompt keeps it to research.
const MEMORY_SAFE_AGENTS = new Set(['temporal-memory', 'temporal-research']);

/** True when the mission was fired by a memory-scoped responsibility. */
export function isMemoryScoped(envelope) {
  return envelope?.source_meta?.effect_scope === MEMORY_SCOPE;
}

/**
 * Decide what the checkpoint executor does with one task of a memory-scoped mission.
 *
 * @param {object} p
 * @param {string} p.stepType  - 'standard' | 'approval_gate' | …
 * @param {string} p.taskAgent - the organ the plan assigned
 * @returns {{action:'allow'} | {action:'reroute', agent:string, reason:string} | {action:'refuse', reason:string}}
 */
export function fenceMemoryTask({ stepType = 'standard', taskAgent } = {}) {
  if (stepType === 'approval_gate') {
    return { action: 'refuse', reason: 'a memory-scoped mission may not open an approval gate — nothing it does leaves the memory layers, so there is nothing to approve' };
  }
  if (stepType !== 'standard') {
    return { action: 'refuse', reason: `a memory-scoped mission runs only standard memory tasks, not '${stepType}'` };
  }
  if (MEMORY_SAFE_AGENTS.has(taskAgent)) return { action: 'allow' };
  return {
    action: 'reroute',
    agent: 'temporal-memory',
    reason: `'${taskAgent || 'unassigned'}' holds effects beyond memory — the task runs on temporal-memory, whose toolset writes only the memory layers`,
  };
}

/**
 * Causal contrastive guidance for memory consolidation: attributes candidate lessons
 * by comparing clean first-attempt checkpoints against replanned or failed checkpoints.
 *
 * @returns {string}
 */
export function contrastiveConsolidationGuidance() {
  return 'When evaluating candidate lessons from recent sessions, contrast checkpoints that passed on the first attempt against checkpoints that needed a re-plan or failed: classify each candidate practice as helped (present in clean passes, absent in failures), hurt (triggered replans or verifier rejections), or confounded (mixed evidence — hold in working memory rather than promoting to Core Memory).';
}

/**
 * The plan of a memory-scoped mission: one checkpoint whose one task is the whole cycle, run by
 * temporal-memory in a single pass.
 *
 * Why code writes this plan instead of a planner: every task of a memory mission runs on
 * temporal-memory, a fresh session each time, which can write only MEMORY.md and the consolidation
 * report. A plan split into checkpoints therefore has no way to hand its triage forward, and the
 * planner kept inventing one: several nightly consolidations in a row routed the work through a
 * plan file (`consolidation_plan.json`, `reconciliation_plan.md`) that memory may not write, so
 * every later checkpoint found nothing and the mission blocked. A task does not see the mission's
 * context, so this one carries the full process itself.
 *
 * @param {object} envelope - the mission: instruction, accept_criteria, context_summary
 * @param {object} [opts]
 * @param {string} [opts.unmet] - what the verifier found unmet last time, for a retry to address
 * @returns {Array<{instruction:string, accept_criteria:string, tasks:Array<{agent:string, task:string}>}>}
 */
export function memoryMissionPlan(envelope, { unmet = '' } = {}) {
  const instruction = String(envelope?.instruction || '').trim() || 'Consolidate memory.';
  const context = String(envelope?.context_summary || '').trim();
  const missed = String(unmet || '').trim();
  const task = [
    `Run the whole cycle in ONE pass, yourself, with your memory tools: ${instruction}`,
    'Do every step of the PROCESS below, in order — gather, triage, retire and promote, rewrite working memory, review Deep Truths — then write the report.',
    'There is no other task to hand anything to, and memory writes only MEMORY.md and consolidation_report.md: keep your triage in your own working context, never in a file of your own.',
    contrastiveConsolidationGuidance(),
    'Write consolidation_report.md LAST, from what you actually did: every retirement, promotion and Deep-Truth change with its id and reason, and the final MEMORY.md character count. The report is the outcome the verifier checks.',
    'Changing nothing is a valid outcome: when nothing in working memory needs to change, leave MEMORY.md as it is and say so in the report.',
    missed ? `\nThe last attempt did not satisfy all of the criteria. Address every one of these this time:\n${missed}` : '',
    context ? `\n${context}` : '',
  ].filter(Boolean).join('\n');
  return [{
    instruction,
    accept_criteria: String(envelope?.accept_criteria || ''),
    tasks: [{ agent: 'temporal-memory', task }],
  }];
}
