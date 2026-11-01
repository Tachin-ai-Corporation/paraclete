// agent/organs/temporal-memory/context-maintenance.mjs: the lesson step after a mission. When a finished mission
// worked in a project or followed a process playbook, the temporal-memory organ (the organ that
// maintains the agent's memory) is asked what durable lesson the run taught. The lesson is memory:
// the brain appends it to working memory (MEMORY.md), and the nightly consolidation decides whether
// it earns a place in Core Memory, the same gate every other learning passes.
//
// A lesson is never written into the project record or the playbook. Those are definitions,
// read-only to memory: letting one mission's view rewrite a playbook, or put history into a
// project's overview, is the failure this design exists to prevent.
//
// This file holds the pure parts: whether to ask, the prompts, parsing the answer, and the
// working-memory line. The brain dispatches the organ and appends the line.

/**
 * Whether a mission should be asked for a project lesson, and about which project. Only for a
 * finished mission that worked in a project, with the step turned on.
 *
 * @param {object}  mission
 * @param {object}  [options]
 * @param {boolean} [options.enabled] whether the lesson step is on (contracts value)
 * @returns {{run: boolean, projectId?: string, reason?: string}}
 */
export function shouldMaintainContext(mission, options) {
  if (!options?.enabled) return { run: false, reason: 'flag off' };
  if (!mission || mission.type !== 'M') return { run: false, reason: 'not a mission' };
  if (mission.status !== 'complete') return { run: false, reason: 'not complete' };
  const projectId = mission.project_id || null;
  if (!projectId) return { run: false, reason: 'no project touched' };
  return { run: true, projectId };
}

/**
 * The organ's instruction for a project lesson. The project's own context is shown read-only so the
 * lesson doesn't restate what the project already says, and the answer is a lesson for memory, not
 * an edit to the project.
 *
 * @param {object} mission
 * @param {object} project
 * @returns {string}
 */
export function buildMaintenancePrompt(mission, project) {
  const goal = String(mission?.title || mission?.instruction || '').replace(/\s+/g, ' ').slice(0, 500);
  const outcome = String(mission?.output || '').replace(/\s+/g, ' ').slice(0, 2000);
  let current = '';
  try {
    const c = project?.context;
    if (c && typeof c === 'object' && Object.keys(c).length) current = JSON.stringify(c).slice(0, 2000);
  } catch { current = ''; }
  return [
    'You are the temporal-memory organ, recording what a mission taught us about a project it worked in.',
    'What you write is MEMORY — a lesson the agent recalls the next time it works in this project. It is',
    'never written into the project record: the project context below is read-only, shown so you do not',
    'restate what it already declares. Record only something DURABLE this run revealed (a constraint, an',
    'approach that worked, a pitfall worth naming); if the run was routine, say nothing — silence is the',
    'honest default. Never invent, never log task chatter, never include secrets.',
    '',
    `PROJECT: ${project?.name || project?.id || 'unknown'} (${project?.id || ''})`,
    `PROJECT CONTEXT (read-only): ${current || '(none)'}`,
    '',
    `MISSION GOAL: ${goal}`,
    `MISSION OUTCOME: ${outcome || '(none)'}`,
    '',
    'Respond with exactly ONE JSON object and nothing else:',
    '  {"lesson": "<one durable lesson about working in this project, <= 300 chars, or an EMPTY string if nothing durable was learned>"}',
  ].join('\n');
}

/**
 * Reads the organ's answer into one bounded line of lesson. Never throws.
 *
 * @param {string} text
 * @param {number} [maxLen=300]
 * @returns {{lesson: string}} '' when nothing durable was learned, or on any parse failure
 */
export function parseMaintenanceResponse(text, maxLen = 300) {
  if (!text) return { lesson: '' };
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return { lesson: '' };
    const obj = JSON.parse(m[0]);
    const raw = typeof obj.lesson === 'string' ? obj.lesson : '';
    return { lesson: raw.replace(/\s+/g, ' ').trim().slice(0, maxLen) };
  } catch {
    return { lesson: '' };
  }
}

/**
 * Whether a mission should be asked for lessons about the playbooks it drew on. Only for a finished
 * mission whose planner recalled playbooks (mission.recalled_processes, stamped at planning when a
 * playbook's intent keywords matched the goal), with the step turned on. Deduplicated and bounded to
 * `max`, so one mission never fans out.
 *
 * @param {object}  mission
 * @param {object}  [options]
 * @param {boolean} [options.enabled] whether the lesson step is on (contracts value)
 * @param {number}  [max=3]
 * @returns {{run: boolean, processIds?: string[], reason?: string}}
 */
export function shouldMaintainProcesses(mission, options, max = 3) {
  if (!options?.enabled) return { run: false, reason: 'flag off' };
  if (!mission || mission.type !== 'M') return { run: false, reason: 'not a mission' };
  if (mission.status !== 'complete') return { run: false, reason: 'not complete' };
  const ids = Array.isArray(mission.recalled_processes)
    ? [...new Set(mission.recalled_processes.filter((x) => typeof x === 'string' && x))].slice(0, max)
    : [];
  if (ids.length === 0) return { run: false, reason: 'no playbook recalled' };
  return { run: true, processIds: ids };
}

/**
 * The organ's instruction for a playbook lesson. The narrative is shown read-only: memory never
 * rewrites a playbook. Changing one is an authoring decision, not a memory write.
 *
 * @param {object} process
 * @param {object} mission
 * @returns {string}
 */
export function buildProcessMaintenancePrompt(process, mission) {
  const goal = String(mission?.title || mission?.instruction || '').replace(/\s+/g, ' ').slice(0, 500);
  const outcome = String(mission?.output || '').replace(/\s+/g, ' ').slice(0, 2000);
  const current = String(process?.narrative || '').replace(/\s+/g, ' ').slice(0, 1200);
  return [
    'You are the temporal-memory organ, recording what a mission taught us about a PROCESS PLAYBOOK it drew on.',
    'What you write is MEMORY — a lesson recalled the next time this kind of work comes up. The playbook is a',
    'definition and is read-only to memory: you never rewrite it. Record a lesson ONLY if this run revealed',
    'something the narrative below does not already carry (a sharper way, a pitfall worth naming, a step that',
    'proved to matter); if the run was routine, say nothing — silence is the honest default. NO tool syntax,',
    'NO commands, NO step lists, never invent.',
    '',
    `PLAYBOOK: ${process?.name || process?.id || 'unknown'} (${process?.id || ''})`,
    `PLAYBOOK NARRATIVE (read-only): ${current || '(none)'}`,
    '',
    `MISSION THAT USED IT — GOAL: ${goal}`,
    `MISSION OUTCOME: ${outcome || '(none)'}`,
    '',
    'Respond with exactly ONE JSON object and nothing else:',
    '  {"lesson": "<one durable lesson about this kind of work, <= 300 chars, or an EMPTY string if nothing durable was learned>"}',
  ].join('\n');
}

/**
 * The working-memory line a lesson becomes, scoped so consolidation and recall know what it is
 * about. One line, whitespace normalized.
 *
 * @param {object} p
 * @param {'project'|'playbook'} p.scope
 * @param {string} p.id
 * @param {string} p.lesson
 * @param {string} [p.date] YYYY-MM-DD; today (UTC) when omitted
 * @returns {string} the line, newline-terminated; '' when there is no lesson
 */
export function lessonLine({ scope, id, lesson, date } = {}) {
  const text = String(lesson || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const day = date || new Date().toISOString().slice(0, 10);
  return `- [${day}] lesson (${scope === 'playbook' ? 'playbook' : 'project'} ${id || 'unknown'}): ${text}\n`;
}
