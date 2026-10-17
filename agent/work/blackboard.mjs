// agent/work/blackboard.mjs: renders the mission blackboard, one markdown view of a mission's
// evolving state: goal, acceptance criteria, every result and decision so far (summary plus ref),
// and open failures. Any organ can read the whole picture from one place instead of reconstructing
// it from what each call happened to pass along. Pure: no I/O, no clock; the caller passes
// `iteration`. Writing it into the mission's artifact repository (shared/<missionId>/MISSION.md)
// each iteration is the brain's job.

function clip(text, budget) {
  const t = String(text || '').replace(/\s+$/g, '');
  if (t.length <= budget) return t;
  return t.slice(0, budget) + ` …[+${t.length - budget} chars]`;
}

function stepLabel(r) {
  return r.checkpoint_step || r.step || '—';
}

// One compact blackboard row per result: step · agent · (summary|result) · ref · status.
function renderRow(r, perRow) {
  const agent = r.agent || 'unknown';
  const body = clip(r.summary || r.result || '', perRow);
  const ref = r.ref ? ` _(ref: ${r.ref})_` : '';
  const status = r.success === false ? ' ❌ FAILED' : '';
  return `- **[${stepLabel(r)}] ${agent}**${status}: ${body}${ref}`;
}

/**
 * Render the mission blackboard as markdown. Deterministic.
 *
 * @param {Object} envelope - the mission envelope (id, instruction or goal, accept_criteria)
 * @param {Array}  priorResults - result packets and decisions accumulated by this mission
 * @param {Object} [opts] - { maxChars = 12000, iteration = 0, perRow = 400 }
 * @returns {string}
 */
export function renderBlackboard(envelope, priorResults = [], opts = {}) {
  const { maxChars = 12000, iteration = 0, perRow = 400 } = opts;
  const id = envelope?.id || 'unknown';
  const goal = clip(envelope?.instruction || envelope?.goal || '(no goal recorded)', 800);
  const criteria = envelope?.accept_criteria ? clip(envelope.accept_criteria, 600) : '';

  // A missing row is skipped rather than allowed to crash the render of every other row.
  const results = (Array.isArray(priorResults) ? priorResults : []).filter((r) => r && typeof r === 'object');
  const rows = results.map((r) => renderRow(r, perRow));
  const failures = results
    .filter((r) => r.success === false)
    .map((r) => `- [${stepLabel(r)}] ${r.agent || 'unknown'}: ${clip(r.summary || r.result || '', 300)}`);

  const parts = [
    `# Mission Blackboard — ${id}`,
    ``,
    `## Goal`,
    goal,
    ...(criteria ? [``, `## Acceptance Criteria`, criteria] : []),
    ``,
    `## Results & Decisions (chronological)`,
    rows.length ? rows.join('\n') : '_(none yet)_',
    ``,
    `## Open / Failures`,
    failures.length ? failures.join('\n') : '_(none)_',
    ``,
    `_maintained by the brain · iteration ${iteration}_`,
  ];
  const doc = parts.join('\n');
  // Bound the whole document; keep the head (goal and earliest results), which anchors context.
  return doc.length > maxChars
    ? doc.slice(0, maxChars) + `\n\n…[blackboard truncated to ${maxChars} chars]`
    : doc;
}
