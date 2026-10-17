// agent/work/finalization.mjs: pure predicates and renderers for a mission's terminal status: what
// counts as a real task failure, whether the deliverable stands despite a failed milestone verdict,
// the caveat section, and the blocker stated from the mission's own evidence. Choosing the terminal
// status is the brain's job; its synthesize and blocked steps call these at finalization.
//
// A milestone verdict (the cerebellum's check of a checkpoint, pushed as a step "N.verify") judges
// a checkpoint, not the mission's deliverable. Conflating the two once ended a finished mission as
// `blocked`, with the mission's own success summary written into the blocker field: a complete
// two-page flyer PDF delivered to the person as a failure. These predicates draw the line: a
// `blocked` terminal needs a genuinely failed task, not a milestone verdict; and a milestone FAIL
// over tasks that all succeeded is not failed work, the same exclusion the synthesize step applies
// to inconclusive and timed-out rows.

/**
 * A cerebellum checkpoint-milestone verdict pseudo-step, e.g. { step: '2.verify', ... }. It is a
 * statement about a checkpoint milestone, never a unit of dispatched work.
 */
export const isMilestoneVerdict = (r) =>
  typeof r?.step === 'string' && r.step.endsWith('.verify');

/**
 * A row representing real dispatched work (a task an organ actually ran), not a system nudge, a
 * human note, or a milestone verdict.
 */
export const isWorkRow = (r) =>
  !!r && r.agent !== 'system' && r.agent !== 'human' && !isMilestoneVerdict(r);

/**
 * A genuine failed task: real work, hard-failed, and not merely inconclusive (the verifier could
 * not see the evidence) or timed out (outcome unknown). Neither of those is a judgement that the
 * work is wrong, so neither counts as a failure here.
 */
export const isRealTaskFailure = (r) =>
  isWorkRow(r) && r.success === false && !r.inconclusive && !r.timedOut;

/** A real task that succeeded. */
export const isRealTaskSuccess = (r) =>
  isWorkRow(r) && r.success === true;

/**
 * True when a mission's deliverable stands despite a milestone verdict: at least one real task
 * succeeded and no real task failed. In that state a `blocked` terminal is a mislabel: the only
 * "failure" present is a checkpoint verdict, which judges a checkpoint, not the deliverable. This
 * does not assert the mission is complete (that call stays with the cerebellum); it only asserts
 * that recording `blocked` would be wrong.
 *
 * @param {Array} priorResults - the mission's accumulated dispatch results
 * @returns {boolean}
 */
export function deliverableStandsDespiteMilestone(priorResults) {
  const rows = Array.isArray(priorResults) ? priorResults : [];
  return rows.some(isRealTaskSuccess) && !rows.some(isRealTaskFailure);
}

/**
 * Render the caveat block for a completion that was met with a caveat.
 *
 * A caveat is an honest, non-defeating gap the cerebellum passed a milestone with. It must be
 * shown to the person, never swallowed: a swallowed caveat is a silent quality regression. This
 * composes the accumulated milestone caveats into one section appended to the mission output. It
 * dedups and trims, and returns '' when there is nothing to say, so a clean completion is
 * unchanged.
 *
 * @param {Array<string>} caveats - accumulated caveat lines (e.g. "CP2: two folders resolve at runtime")
 * @returns {string} the section text, or '' when empty
 */
export function renderCaveatSection(caveats) {
  const seen = new Set();
  const lines = (Array.isArray(caveats) ? caveats : [])
    .map((c) => String(c ?? '').trim())
    .filter((c) => c.length > 0 && !seen.has(c) && seen.add(c));
  if (lines.length === 0) return '';
  return `\n\n— Caveats (noted, non-blocking) —\n${lines.map((l) => `• ${l}`).join('\n')}`;
}

// A line that says something a person could act on. `[FAILED]` markers, bare tool echoes and
// empty frames are structure, not explanation.
const isSubstantive = (line) => {
  const t = line.trim();
  if (t.length < 12) return false;
  if (/^\[(TOOL|FAILED|SKIPPED|CHECKPOINT)\b/.test(t)) return false;
  if (/^[-=*#\s]+$/.test(t)) return false;
  return true;
};

/**
 * The blocker, stated from evidence the mission already produced.
 *
 * `blocked` exists to hand a problem back to a person. A handback that says "Blocked on external
 * dependency." with blocker "Unknown blocker" is a dead end: the person learns that something
 * stopped, not what to do about it, and the mission's own diagnosis is thrown away on the way out.
 *
 * That happened: a mission asked to create a spreadsheet discovered there was no tool that creates
 * one, read its own skill instructions to confirm, and reported "Provide the motor agent with a
 * functional tool or command to create Google Sheets", exactly the sentence the person needed. The
 * cortex then chose `blocked` without carrying any of it forward, and the terminal output was the
 * constant.
 *
 * So when the cortex articulates nothing, do not invent and do not fall back to a phrase: recover
 * what the failing task already said. Deterministic: code moves evidence that exists; it does not
 * ask anyone to describe it again.
 *
 * @param {Array} priorResults - the mission's accumulated dispatch results
 * @param {(text: string) => string} extractRecommendation - verdict.mjs's
 *   extractFailRecommendation, injected so this module stays pure and testable
 * @returns {{ step: string, agent: string, detail: string } | null} null when the evidence is
 *   genuinely empty; the caller must then say so, not paper over it
 */
export function articulateBlocker(priorResults, extractRecommendation) {
  const failed = (Array.isArray(priorResults) ? priorResults : []).filter(isRealTaskFailure);
  if (!failed.length) return null;

  // The last failure: after a re-plan the earlier ones are superseded attempts, and handing back
  // the first thing that went wrong describes a mission the agent has already moved on from.
  const last = failed[failed.length - 1];
  const text = String(last.result ?? last.summary ?? '');

  let detail = '';
  try {
    const rec = extractRecommendation ? extractRecommendation(text) : '';
    if (rec && rec !== 'No recommendation available') detail = String(rec).trim();
  } catch { /* a malformed tool log is not a reason to lose the row entirely */ }

  if (!detail) detail = (text.split('\n').find(isSubstantive) || '').trim();
  if (!detail) return null;

  return {
    step: String(last.step ?? ''),
    agent: String(last.agent ?? ''),
    detail: detail.length > 600 ? `${detail.slice(0, 600)}…` : detail,
  };
}
