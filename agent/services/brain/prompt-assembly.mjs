// agent/services/brain/prompt-assembly.mjs: the context the brain sends with each organ turn. The
// gateway leads every turn with the organ's own prompt and the agent's identity (prompts/), so this
// file builds only what comes after: the system blocks (Deep Truths and the project and process
// registries, most stable first, then working memory), the capability map (which organ can do what,
// from the installed skills), and the user turn for each cortex mode (classify, decide and its
// session delta, respond_compose) and for the prefrontal's analyze and plan requests. Pure apart from
// reading skill manifests. Deciding what to ask is the runner's, the intake's and the actions' job.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toContentParts } from '../../context/prompt-blocks.mjs';
import { renderResources } from '../../work/resource-ledger.mjs';
import { smartTruncate } from '../../providers/vertex-text.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { BRAIN_MARKER } from './gateway-client.mjs';

/** The order organs appear in the capability map. */
const ORGAN_ORDER = ['cortex', 'prefrontal', 'motor', 'cerebellum', 'temporal-memory', 'temporal-research'];

/**
 * Per-result cap for a session delta. The delta is appended verbatim to the gateway-held transcript,
 * so an uncapped result would inflate one turn and then be re-read on every later turn.
 */
const DELTA_RESULT_CHARS = 2000;

/**
 * Envelope fields that change while a mission runs. The decide turn sends them in its working state;
 * everything else is mission-stable and sent once, so the stable prefix stays byte-identical.
 */
const ENVELOPE_MUTABLE_KEYS = new Set([
  'status', 'updated_at', 'iteration', 'started_at', 'completed_at', 'output', 'error', 'children',
  'context_forward',
]);

// ---- Skills and the capability map ----

/**
 * The installed skills, from each directory's <skill>/skill.json, in the order given (base skills,
 * the generic role's, the chosen role's, the agent's own). The first skill with an id wins: the same
 * skill reached twice is one skill. Unreadable manifests are skipped.
 *
 * @param {string[]} skillDirs
 * @param {object} [io]
 * @param {Function} [io.readText]
 * @param {Function} [io.listDir]
 * @returns {Array<{id: string, name: string, whenToUse: string, organs: string[]}>}
 */
export function readSkills(skillDirs, { readText = (p) => readFileSync(p, 'utf8'), listDir = (d) => readdirSync(d), exists = existsSync } = {}) {
  const seen = new Set();
  const out = [];
  for (const dir of skillDirs || []) {
    if (!dir || !exists(dir)) continue;
    let names;
    try { names = listDir(dir).sort(); } catch { continue; }
    for (const name of names) {
      const manifest = join(dir, name, 'skill.json');
      if (!exists(manifest)) continue;
      try {
        const m = JSON.parse(readText(manifest));
        const id = m.id || name;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          name: m.name || id,
          whenToUse: m.when_to_use || '',
          organs: Array.isArray(m.organs) ? m.organs : (m.organs ? [m.organs] : []),
        });
      } catch { /* an invalid skill.json leaves that skill out */ }
    }
  }
  return out;
}

/**
 * What each organ can do, at a high level: skill names and their first sentence, grouped by organ.
 * No paths and no how-to: the planning organs see which organ can do what, never how, and the
 * executing organ picks its own skills.
 *
 * @param {Array<{name: string, whenToUse: string, organs: string[]}>} skills
 * @returns {string}
 */
export function capabilityMap(skills) {
  const byOrgan = {};
  for (const s of skills || []) {
    const brief = String(s.whenToUse || '').split('. ')[0].slice(0, 120);
    for (const organ of (s.organs && s.organs.length ? s.organs : ['motor'])) {
      (byOrgan[organ] ||= []).push(`- ${s.name}${brief ? ` — ${brief}` : ''}`);
    }
  }
  const rank = (o) => { const i = ORGAN_ORDER.indexOf(o); return i < 0 ? 99 : i; };
  return Object.keys(byOrgan)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((o) => `## ${o}\n${byOrgan[o].sort().join('\n')}`)
    .join('\n\n');
}

// ---- System blocks ----

/** The projects as the cortex's registry: what each holds, never its team or its channel. */
export function projectRegistry(projects) {
  return Object.values(projects || {}).map((p) => ({
    id: p.id, name: p.name, status: p.status, description: p.description, context: p.context || {},
  }));
}

/** The process playbooks as the cortex sees them: remembered narratives, not programs. */
export function processRegistry(processes) {
  return Object.values(processes || {}).map((p) => ({
    id: p.id, name: p.name, description: p.description, narrative: p.narrative || null,
  }));
}

/**
 * The cortex's system blocks after its own prompt. The first block is the session's identity (the
 * gateway hashes it), so it holds only what changes rarely: the Deep Truths and the registries.
 * Working memory changes with every finished mission, so it rides last, in its own block, and a
 * memory write re-keys only that small block.
 *
 * @param {object} p
 * @param {string} [p.deepTruths]
 * @param {string} [p.workingMemory]
 * @param {object} [p.projects] - id -> project
 * @param {object} [p.processes] - id -> playbook
 * @returns {string[]} [stable, volatile], empty blocks dropped
 */
export function cortexSystem({ deepTruths = '', workingMemory = '', projects = {}, processes = {} } = {}) {
  const stable = [];
  if (String(deepTruths).trim()) {
    stable.push(`[DEEP TRUTHS — principles confirmed across many sessions]\n${String(deepTruths).trim()}`);
  }
  const reg = projectRegistry(projects);
  if (reg.length > 0) {
    stable.push(`[PROJECT REGISTRY — work streams with their context]\nEach project carries context that applies to every mission in it. When classifying or deciding, identify the relevant project and use its context.\n${JSON.stringify(reg, null, 2)}`);
  }
  const playbooks = processRegistry(processes);
  if (playbooks.length > 0) {
    stable.push(`[PROCESS PLAYBOOKS — how this has been done well before]\nA process is a remembered narrative, not a program. When the work resembles one, treat its narrative as guidance and plan your own checkpoints with it (checkpoint_plan): adapt it and keep control.\n${JSON.stringify(playbooks, null, 2)}`);
  }
  stable.push('Respond with exactly one JSON object and nothing else.');
  const volatile = String(workingMemory).trim() ? `[WORKING MEMORY — MEMORY.md]\n${String(workingMemory).trim()}` : '';
  return [stable.join('\n\n'), volatile].filter(Boolean);
}

// ---- The cortex's user turn ----

/**
 * A cortex user turn as cache-tiered content parts: the brain's marker opens the boot tier, the
 * requester rides the mission tier so it never re-keys the boot block.
 *
 * @param {Array<{label: string, text: string, tier: string}>} blocks
 * @param {object} [opts]
 * @param {string} [opts.requester] - the person's address
 * @returns {Array}
 */
export function cortexUser(blocks, { requester = '' } = {}) {
  return toContentParts([
    { label: '', text: BRAIN_MARKER, tier: 'boot' },
    ...(requester ? [{ label: 'REQUESTER', text: `The person who asked: ${requester}. Use this address when the work shares something with them.`, tier: 'mission' }] : []),
    ...blocks,
  ]);
}

/** Guidance the classify turn always carries. */
export const CLASSIFICATION_GUIDANCE = Object.freeze({
  blocked_missions: 'If a blocked mission exists and the message addresses the blocker or asks to retry, fix or continue the work, classify as "continue" with continue_mission set to the mission id. Do not classify as "attach" for a blocked mission.',
  attach_vs_continue: '"attach" = follow-up information or a new instruction for active or waiting work. "continue" = resume blocked or stalled work, or retry after a failure.',
  dedup_prevention: 'If a recent completed mission has a very similar instruction to the new message (same goal, same action), do not create a new_mission: classify as "attach" to that mission. Create a new_mission only for genuinely different work.',
  project_identification: 'If the work matches a project in project_registry, set project_id. Not every piece of work belongs to a project.',
  required_processes: 'A project may define required_processes: activities that must go through a specific process. If any part of the message matches one, set project_id to that project; the decide step surfaces the process.',
  conversation_grounding: 'When a conversation block is present, resolve pronouns, ellipsis and references ("yes", "do that", "the second one", "same as before") against it before classifying. The latest agent turn (last_agent_reply) is what the person is most likely answering.',
  respond_rules: 'Classify as "respond" only when the turn is conversational or informational and fully answerable from the conversation, memory, active_envelopes and recent_completed_missions in this payload, or with at most one read from respond_reads_available: greetings, acknowledgments, status questions about visible work, questions the memory answers, clarifying answers. A respond changes nothing and starts nothing. If a read is needed, put its id in "reads" (one at most) and write a draft in "response"; the brain grounds the draft on the read before sending it. Anything that runs, writes or changes something is not a respond. When in doubt, new_mission.',
  input_answer_binding: 'If an active envelope is in needs_input or blocked and the new turn plausibly answers its question (the question is usually the last agent turn in the conversation), classify as "continue" with the answer carried in instruction, never as a new_mission that restates the question.',
  cancel_target: 'For "cancel", set cancel_target to the id of the mission to stop.',
});

/**
 * The classify turn's blocks.
 *
 * @param {object} p
 * @param {object} p.inbound - { text, source, source_meta }
 * @param {string|null} [p.conversation]
 * @param {string|null} [p.lastAgentReply]
 * @param {object} [p.memory]
 * @param {Array}  [p.activeEnvelopes]
 * @param {Array}  [p.recentMissions]
 * @param {Array}  [p.respondReads] - [{ id, description }]
 * @param {string} [p.capabilityMap]
 * @param {object} [p.projects]
 * @param {object} [p.processes]
 * @returns {Array} blocks for cortexUser()
 */
export function classifyBlocks(p) {
  const projects = Object.values(p.projects || {});
  const processes = Object.values(p.processes || {});
  const boot = {
    classification_guidance: CLASSIFICATION_GUIDANCE,
    capability_map: p.capabilityMap || '',
    respond_reads_available: p.respondReads || [],
    ...(processes.length ? {
      process_registry: processes.map((x) => ({ id: x.id, name: x.name, description: x.description })),
    } : {}),
    ...(projects.length ? {
      project_registry: projects.map((x) => {
        const entry = { id: x.id, name: x.name, description: x.description, context_summary: JSON.stringify(x.context || {}) };
        const rp = x.required_processes || x.context?.required_processes;
        if (Array.isArray(rp) && rp.length > 0) entry.required_processes = rp;
        return entry;
      }),
    } : {}),
  };
  const turn = {
    mode: 'classify',
    inbound: p.inbound,
    conversation_context: p.conversation || null,
    last_agent_reply: p.lastAgentReply || null,
    memory: p.memory || {},
    active_envelopes: p.activeEnvelopes || [],
    recent_completed_missions: p.recentMissions || [],
  };
  return [
    { label: 'BOOT-STABLE CONTEXT', text: JSON.stringify(boot), tier: 'boot' },
    { label: 'CURRENT TURN', text: JSON.stringify(turn), tier: 'volatile' },
  ];
}

/** The respond_compose turn: ground a drafted reply on one read's result. */
export function respondComposeBlocks({ inbound, conversation = null, memory = {}, toolGrounding = '', draft = '' }) {
  return [{
    label: '',
    text: JSON.stringify({
      mode: 'respond_compose',
      inbound,
      conversation_context: conversation,
      memory,
      tool_grounding: toolGrounding,
      draft_response: draft,
      guidance: 'Combine the message, the conversation, the recalled memory and the live read result into one concise, accurate reply. No placeholders, nothing the read does not support, and the tone of the conversation.',
    }),
    tier: 'volatile',
  }];
}

// ---- The decide turn ----

const REPLAN_SCOPE = 'A checkpoint that fails is re-tasked against its pinned outcome: the mission keeps its shape. If the shape itself is wrong (a phase is missing, or the outcomes describe work that is already done or was never needed), send { action: "checkpoint_plan", replan_scope: "mission", replan_reason: "..." } to discard the pinned skeleton and re-shape. Use it when re-tasking cannot fix the problem, not when a task merely failed.';
const AFTER_FAILED_CHECKPOINT = 'Returning { action: "checkpoint_plan" } is enough: the failed checkpoint is re-tasked automatically against its pinned outcome, and checkpoints that already passed keep their verdicts and are not re-run. There is no separate "retask" action. There is no action for fetching more context either: the identifiers already resolved are in known_resources on every decision, and a step\'s full output is fetched by naming its ref in request_context.';
const SKILL_GUIDANCE = 'Write task instructions that describe what should happen, not how. Each organ knows its own tools. Describe the outcome, the inputs and the acceptance criteria.';

/**
 * The decide turn's whole payload, before it is split into tiers.
 *
 * @param {object} a
 * @param {object} a.envelope       - the mission
 * @param {object} [a.memory]
 * @param {string} [a.envelopeContext]
 * @param {Array}  [a.priorResults]
 * @param {number} [a.iteration]
 * @param {object} [a.queue]        - { pending_intake_count, pending_queue }
 * @param {object} [a.brief]
 * @param {string} [a.capabilityMap]
 * @param {object} [a.project]      - the mission's project
 * @param {string} [a.renderedProjectContext]
 * @param {object} [a.processes]
 * @param {Array}  [a.triggerable]  - responsibilities a person may ask to run now
 * @param {number} [a.resourceLimit]
 * @returns {object}
 */
export function decidePayload(a) {
  const env = a.envelope || {};
  const projection = {
    id: env.id,
    type: env.type,
    instruction: env.instruction,
    accept_criteria: env.accept_criteria,
    context_summary: env.context_summary,
    conversation_context: env.conversation_context || null,
  };
  const p = {
    mode: 'decide',
    envelope: projection,
    memory: a.memory || {},
    envelope_context: a.envelopeContext || null,
    prior_results: a.priorResults || [],
    iteration: a.iteration || 1,
    pending_intake_count: a.queue?.pending_intake_count || 0,
    pending_queue: a.queue?.pending_queue || [],
    capability_map: a.capabilityMap || '',
  };
  if (a.project) {
    p.project = a.project;
    if (a.renderedProjectContext) p.rendered_project_context = a.renderedProjectContext;
    const rp = a.project.required_processes || a.project.context?.required_processes;
    if (Array.isArray(rp) && rp.length > 0) p.required_processes = rp;
  }
  // The ids resolved so far, as they stand now. Recall runs once per mission, so an id captured in
  // step 1.1 would otherwise be invisible to the next decision; a mission that could not name ids it
  // had just captured once invented an action to fetch them and then blocked.
  try {
    const block = renderResources(env.context?.resources, {
      limit: a.resourceLimit ?? 40,
      cues: String(env.instruction || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
    });
    if (block) p.known_resources = block;
  } catch { /* a bookkeeping miss never costs a decision */ }
  const playbooks = Object.values(a.processes || {});
  if (playbooks.length > 0) {
    p.available_processes = playbooks.map((x) => ({
      id: x.id, name: x.name, description: String(x.description || '').substring(0, 200),
      narrative: x.narrative || null, intent_keywords: x.intent_keywords || [],
    }));
  }
  if (Array.isArray(a.triggerable) && a.triggerable.length > 0) {
    p.available_responsibilities = a.triggerable;
    p.responsibility_trigger_guidance = 'These are scheduled cycles. Only when the person explicitly asks to run one of them now, respond with { "action": "trigger_responsibility", "responsibilityId": "<id from available_responsibilities>" }. That starts the cycle in the background; you then confirm with synthesize. Never use it for anything not listed, and never plan a cycle\'s internal steps yourself.';
  }
  if (a.brief) {
    p.brief = a.brief;
    p.dispatch_guidance = {
      rule: 'Commit work from the Brief with checkpoint_plan. Give a full checkpoints array, or only a goal and constraints and the prefrontal structures the plan.',
      minimal_form: '{ action: "checkpoint_plan", goal: "...", constraints: "..." }: the prefrontal structures the plan',
      full_form: '{ action: "checkpoint_plan", checkpoints: [...] }: you give the full structure',
      preference: 'Use the minimal form unless you have specific structural requirements.',
      step_types: 'standard (work by motor, temporal-research or temporal-memory), approval_gate (a destructive or public action: a person approves first), ask (an unknown no one can resolve: use needs_input)',
      sequencing: 'Independent parts fan out within a checkpoint. Dependent parts serialize across checkpoint boundaries.',
      skill_guidance: SKILL_GUIDANCE,
      replan_scope: REPLAN_SCOPE,
      after_a_failed_checkpoint: AFTER_FAILED_CHECKPOINT,
    };
  } else {
    p.dispatch_guidance = {
      rule: 'All work uses checkpoint_plan. One focused task per task entry. Even single-step work is one checkpoint with one task.',
      reasoning: 'Each task has a limited step budget. Focused tasks prevent timeouts and keep context on failure, and the mission, checkpoint, task shape lets progress be tracked and a failure re-planned.',
      skill_guidance: SKILL_GUIDANCE,
      replan_scope: REPLAN_SCOPE,
      after_a_failed_checkpoint: AFTER_FAILED_CHECKPOINT,
    };
  }
  if (a.project && Array.isArray(a.project.standardProcesses) && a.project.standardProcesses.length > 0) {
    p.dispatch_guidance.process_preference = `Project "${a.project.name}" has playbooks for this work: ${a.project.standardProcesses.join(', ')}. Treat their narrative as guidance and plan your own checkpoints.`;
  }
  if (env.accept_criteria) {
    p.goal_state = {
      accept_criteria: env.accept_criteria,
      prior_work_count: (a.priorResults || []).length,
      instruction: 'Include a goal_check object in your decision with criteria_met, criteria_unmet, confidence (high, medium or low) and assessment. Do not synthesize while criteria_unmet has items unless every path is exhausted.',
    };
  }
  if (a.brief?.premise === 'flawed' && a.brief?.premise_note) {
    p.premise_check = {
      status: 'flawed',
      note: a.brief.premise_note,
      instruction: 'The prefrontal flagged the premise as flawed. Decide whether to proceed with the instruction as given or reframe the work. Do not plan inside a false frame.',
    };
  }
  return p;
}

/** Splits an envelope projection into its mission-stable and changing fields, keys sorted. */
export function splitEnvelope(env) {
  const statics = {};
  const state = {};
  for (const k of Object.keys(env || {}).sort()) (ENVELOPE_MUTABLE_KEYS.has(k) ? state : statics)[k] = env[k];
  return { statics, state };
}

/**
 * The decide turn's blocks, ordered most stable first: boot (capabilities and playbooks), mission
 * (the envelope's stable fields, memory, project, Brief), then the working state.
 *
 * @param {object} p - from decidePayload()
 * @returns {Array}
 */
export function decideBlocks(p) {
  const { statics, state } = splitEnvelope(p.envelope);
  const boot = {
    capability_map: p.capability_map,
    available_processes: p.available_processes,
    available_responsibilities: p.available_responsibilities,
    responsibility_trigger_guidance: p.responsibility_trigger_guidance,
  };
  const mission = {
    envelope: statics,
    memory: p.memory,
    project: p.project,
    rendered_project_context: p.rendered_project_context,
    required_processes: p.required_processes,
    brief: p.brief,
    dispatch_guidance: p.dispatch_guidance,
  };
  const working = {
    mode: 'decide',
    iteration: p.iteration,
    envelope_state: state,
    envelope_context: p.envelope_context,
    known_resources: p.known_resources,
    prior_results: p.prior_results,
    pending_intake_count: p.pending_intake_count,
    pending_queue: p.pending_queue,
    goal_state: p.goal_state,
    premise_check: p.premise_check,
  };
  return [
    { label: 'BOOT-STABLE CONTEXT', text: JSON.stringify(boot), tier: 'boot' },
    { label: 'MISSION CONTEXT', text: JSON.stringify(mission), tier: 'mission' },
    { label: 'WORKING STATE', text: JSON.stringify(working), tier: 'volatile' },
  ];
}

/**
 * A session `continue`'s only block: what is new since the model's last decision. The cumulative
 * context and the earlier results are omitted on purpose: the model read them as earlier turns of
 * the same conversation. A result with a packet summary shows the summary (its ref rides along);
 * any other result is capped.
 *
 * @param {object} p - from decidePayload()
 * @param {number} [sentUpto=0] - how many prior results the model already saw
 * @returns {Array}
 */
export function decideDeltaBlocks(p, sentUpto = 0) {
  const tail = (p.prior_results || []).slice(sentUpto).map((r) => {
    if (r.summary) {
      const { summary, result: _result, ...rest } = r;
      return { ...rest, result: summary };
    }
    return { ...r, result: typeof r.result === 'string' ? smartTruncate(r.result, DELTA_RESULT_CHARS) : r.result };
  });
  return [{
    label: 'WORKING STATE (delta) — new since your last decision',
    text: JSON.stringify({
      mode: 'decide',
      iteration: p.iteration,
      new_results: tail,
      known_resources: p.known_resources,
      pending_intake_count: p.pending_intake_count,
      pending_queue: p.pending_queue,
      goal_state: p.goal_state,
      premise_check: p.premise_check,
    }),
    tier: 'volatile',
  }];
}

// ---- The prefrontal ----

/**
 * The prefrontal's analyze request: its system blocks and its user turn.
 *
 * @param {object} p
 * @param {object} p.envelope
 * @param {object} [p.memory]
 * @param {Array}  [p.priorResults]
 * @param {object} [p.project]
 * @param {object} [p.processes]
 * @param {string} [p.capabilityMap]
 * @param {string} [p.requester]
 * @returns {{system: string[], user: string}}
 */
export function analyzeRequest({ envelope, memory = {}, priorResults = [], project = null, processes = {}, capabilityMap: map = '', requester = '' }) {
  const system = [];
  const playbooks = Object.values(processes || {});
  if (playbooks.length > 0) {
    system.push(`[PROCESS PLAYBOOKS — how this has been done well before]\n${JSON.stringify(
      playbooks.map((x) => ({ id: x.id, name: x.name, description: String(x.description || '').substring(0, 200), narrative: x.narrative || null })),
      null, 2,
    )}`);
  }
  if (project) {
    system.push(`[PROJECT CONTEXT]\n${JSON.stringify({
      id: project.id, name: project.name, description: project.description, context: project.context || {}, deploy: project.deploy || null,
    }, null, 2)}`);
  }
  if (map) {
    system.push(`[CAPABILITY MAP — what each organ can do, at a high level]\nDecompose by outcome. You see which organ can do what, never how; never name a skill, command or tool for another organ.\n\n${map}`);
  }
  system.push('Respond with exactly one JSON object and nothing else.');
  const user = [
    BRAIN_MARKER,
    requester ? `## Requester\nThe person who asked: ${requester}` : '',
    JSON.stringify({
      mode: 'analyze',
      instruction: envelope?.instruction || '',
      context_summary: envelope?.context_summary || '',
      memory: memory || {},
      prior_results: priorResults || [],
    }),
  ].filter(Boolean).join('\n');
  return { system, user };
}

/**
 * The prefrontal's request for a whole plan. Stable content leads (the skill and the capability
 * map are the same on every call) and volatile content trails, so the stable part can be cached.
 *
 * @param {object} p
 * @returns {string}
 */
export function planInstruction({ goal, brief = null, skillDoc = '', capabilityMap: map = '', idRule = '', processHint = '', constraints = '', priorResults = [] }) {
  return [
    '[PLAN STRUCTURING]',
    'Structure a checkpoint and task plan for the goal, following the plan-structuring skill below.',
    '',
    skillDoc ? `## Plan Structuring Skill Instructions\n${skillDoc}` : '',
    '',
    map ? `## Capability Map (plan by outcome; the executing organ picks its own skills — never name a skill or tool here)\n${map}` : '',
    '',
    '## Goal',
    toStr(goal),
    '',
    brief ? `## Brief\n${JSON.stringify(brief)}` : '',
    '',
    idRule,
    '',
    processHint,
    '',
    constraints ? `## Constraints\n${constraints}` : '',
    priorResults.length > 0
      ? `## Prior Results\n${priorResults.map((r) => `${r.checkpoint_step || r.step || r.agent}: ${toStr(r.result).substring(0, 200)}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
}

/**
 * The prefrontal's request for new tasks for one failed checkpoint, whose outcome and criteria are
 * pinned. The ids rule sits immediately before the tasks that were tried, because that list is where
 * a mistyped id gets copied from.
 *
 * @param {object} p
 * @param {object} p.target      - the spine entry { n, outcome, accept_criteria, tasks }
 * @param {string} [p.skillDoc]
 * @param {string} [p.capabilityMap]
 * @param {string} [p.failureNote] - what the verifier found unmet
 * @param {string} [p.idRule]
 * @returns {string}
 */
export function singleCheckpointInstruction({ target, skillDoc = '', capabilityMap: map = '', failureNote = '', idRule = '' }) {
  return [
    '[PLAN STRUCTURING — SINGLE CHECKPOINT]',
    'Structure the TASKS for exactly one checkpoint. Do not re-plan the mission and do',
    'not restate the other checkpoints: they are already decided.',
    '',
    skillDoc ? `## Plan Structuring Skill Instructions\n${skillDoc}` : '',
    '',
    map ? `## Capability Map (plan by outcome; the executing organ picks its own skills)\n${map}` : '',
    '',
    `## Checkpoint ${target.n} — outcome (FIXED, do not reword)`,
    toStr(target.outcome),
    '',
    '## Acceptance criteria (FIXED — plan tasks that satisfy these as written)',
    toStr(target.accept_criteria) || '(none stated)',
    '',
    // A checklist, not a narrative. The verifier reports one bullet per unmet clause; a re-plan once
    // tasked only one of two clauses, and with the criteria pinned it failed the same way three times.
    failureNote ? [
      '## Clauses the verifier found UNMET — every one needs a task',
      failureNote,
      '',
      'Treat the above as a checklist. Read the pinned criteria clause by clause and make sure',
      'your task list addresses EVERY unmet clause, not only the easiest or the most recent. A',
      'checkpoint is judged against all of its criteria at once: an untasked clause fails again.',
    ].join('\n') : '',
    '',
    idRule,
    '',
    '## Tasks that were tried and did not get there',
    (target.tasks || []).map((t) => `- ${toStr(t.task || t.instruction || '')}`).join('\n') || '(none)',
    'Any identifier in that list is SUSPECT: it did not work. Take ids from the Known Resources block, not from these tasks.',
    '',
    'Return a plan whose checkpoints array contains EXACTLY ONE checkpoint: this one.',
  ].filter(Boolean).join('\n');
}
