// agent/work/plan-lint.mjs: finds one deterministic smell in a structured checkpoint plan: a task
// whose required input is an identifier an earlier task must discover. It reports findings; it
// does not rewrite plans. Pure: no I/O, no clock, no randomness. Called by the brain's planning
// step, which logs and counts the findings.
//
// The defect it measures, from a real plan:
//   CP1 Task 1  "Locate the master fixed comp addendum template within the … folder."
//   CP1 Task 2  "Duplicate the master template (identified in the previous task) three times into
//                the 'In Progress' folder (ID: FOLDER_ID). Name them …"
// Task 1 found the template and reported its id as a verified claim. Task 2 was a separate
// dispatch, so it had to re-resolve "identified in the previous task" from context, and picked the
// first row of a folder listing (…_Addendum_Retainer_Royalty) instead of
// …_Addendum_Retainer_Fixed. Three documents were built from the wrong template, and every
// downstream find-and-replace then had nothing to match.
//
// The plan shape is the bug: two tasks that are one outcome must not be split. This module finds
// that shape so it can be counted rather than argued about.
//
// Deliberately conservative: a phrase must say "an input I need was produced by an earlier task".
// Ordinary sequencing ("after the drafts exist", "once the folder is ready", "for each advisor")
// carries no identifier dependency and is not a finding.

/**
 * Verbs that mean "an identifier was resolved", and only those.
 *
 * Deliberately narrow. Weaker verbs (noted, listed, mentioned, specified, referenced, reported,
 * returned) once made "the responsibilities listed above" and "the rates specified above" into
 * findings, and both point at the request, not at a previous task's output. A lint that cries wolf
 * gets ignored, which costs more than the coverage it buys.
 */
const DISCOVERED = 'identified|found|located|discovered|determined|resolved|retrieved';

/** Words pointing backwards through the plan. */
const BACKWARD = 'previous|prior|preceding|earlier|last|foregoing|aforementioned';

/** The units a planner numbers its work in. */
const UNIT = 'task|tasks|step|steps|checkpoint|checkpoints|sub-?task|action|instruction';

/** Prepositions that make what follows an input rather than a destination. */
const FROM = 'in|from|by|per|of|at|during|using|with|based\\s+on';

// Ordered most specific first; the first match becomes the reported phrase.
const PATTERNS = [
  // "from the previous task", "in the prior task", "output of the previous step",
  // "based on the preceding checkpoint": the shape that broke the mission.
  new RegExp(`\\b(?:${FROM})\\s+(?:the\\s+)?(?:${BACKWARD})\\s+(?:${UNIT})(?:'s)?\\b`, 'i'),
  // "from step 1", "identified in task 2", "per checkpoint 3"
  new RegExp(`\\b(?:${FROM})\\s+(?:${UNIT})\\s*#?\\s*\\d+\\b`, 'i'),
  // "in the first task", "from the second step"
  new RegExp(`\\b(?:in|from)\\s+(?:the\\s+)?(?:first|1st|second|2nd|third|3rd)\\s+(?:${UNIT})\\b`, 'i'),
  // "identified above", "found above", "located earlier", "as determined earlier"
  new RegExp(`\\b(?:${DISCOVERED})\\s+(?:above|earlier|previously)\\b`, 'i'),
  // "the previously identified template", "the earlier located folder"
  new RegExp(`\\b(?:previously|earlier)\\s+(?:${DISCOVERED})\\b`, 'i'),
  // "the aforementioned template"
  /\bthe\s+aforementioned\b/i,
  // "the template you located", "the doc you just found"
  new RegExp(`\\byou\\s+(?:just\\s+|already\\s+|previously\\s+)?(?:${DISCOVERED})\\b`, 'i'),
  // A pattern matching "using the <thing> id from …" used to live here, and it fired on "using the
  // folder id from the Known Resources block", which is exactly what the plan-structuring skill
  // tells a planner to do. It never required the source after "from" to be an earlier task, so
  // every source matched, including the correct one. Removed rather than narrowed: the first two
  // patterns already catch the same sentence whenever the source really is a previous task
  // ("… from the previous task", "… from step 1").
];

/** A task may carry its text as `task`, `instruction`, or be a bare string. */
function taskText(task) {
  if (typeof task === 'string') return task.trim();
  if (!task || typeof task !== 'object') return '';
  // `||`, not `??`: a task carrying `task: ''` must still fall through to `instruction`. With `??`
  // an empty string counted as present and blocked the fallback entirely.
  const t = task.task || task.instruction || task.description || '';
  return typeof t === 'string' ? t.trim() : '';
}

/**
 * The back-reference phrase inside a task's text, or null.
 *
 * Reports the first match only: one phrase is enough to condemn the plan shape, and one phrase is
 * what a log line has room for.
 *
 * @param {string} text
 * @returns {string|null} the matched phrase, whitespace collapsed
 */
export function matchBackReference(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return null;
  for (const re of PATTERNS) {
    const m = re.exec(s);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * Find tasks whose required input is an identifier a previous task must discover.
 *
 * Only the very first task of the whole plan is exempt: it has nothing behind it, so a backward
 * phrase there refers to something outside the plan and means something else.
 *
 * The exemption is plan-wide rather than per checkpoint on purpose. Per checkpoint let the defect
 * through whenever the split straddled a boundary: a plan of CP1 "locate the template" and CP2
 * "duplicate the template identified in the previous task" went uncounted, because the offending
 * task was index 0 of its own checkpoint. The hazard is identical either way (a separate dispatch
 * re-resolving an identifier from context), and a checkpoint boundary makes it slightly worse.
 *
 * @param {Array<{tasks?: Array}>} checkpoints - structured plan, as the executor sees it
 * @returns {Array<{checkpoint: number, task: number, phrase: string, text: string}>}
 *   findings in plan order; `checkpoint` and `task` are both 1-based
 */
export function findBackReferences(checkpoints) {
  if (!Array.isArray(checkpoints)) return [];
  const findings = [];
  let seen = 0;                                  // tasks encountered across the whole plan
  checkpoints.forEach((cp, ci) => {
    const tasks = cp && Array.isArray(cp.tasks) ? cp.tasks : [];
    tasks.forEach((task, ti) => {
      seen += 1;
      if (seen === 1) return;                    // nothing precedes the plan's first task
      const text = taskText(task);
      const phrase = matchBackReference(text);
      if (phrase) findings.push({ checkpoint: ci + 1, task: ti + 1, phrase, text });
    });
  });
  return findings;
}

/**
 * One-line shape for logs and telemetry, e.g.
 * `CP1 task 2 back-ref "in the previous task": Duplicate the master template…`.
 *
 * @param {{checkpoint: number, task: number, phrase: string, text: string}} finding
 * @returns {string}
 */
export function formatBackReference(finding) {
  if (!finding) return '';
  const text = String(finding.text || '');
  const shown = text.length > 100 ? `${text.slice(0, 100)}…` : text;
  return `CP${finding.checkpoint} task ${finding.task} back-ref "${finding.phrase}": ${shown}`;
}
