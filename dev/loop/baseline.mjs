// dev/loop/baseline.mjs: how the agent does on the model suite (dev/harness2/model-suite.mjs) at main's
// head, so the loop finds work in the agent's measured weak spots, not only in what people wrote down.
// A cycle runs a baseline (cycle.mjs: `eval --real-model` on main's head, in a clone of its own) once a
// day at most, when main has moved, and keeps the latest summary here. The planner (planner.mjs) turns
// a training task whose checks fail on main into a `loop` issue that names the task as its target; the
// cycle and the Loop guard (guard.mjs) then refuse a change unless its measurement shows that task's
// capability rose, besides refusing any regression.
//
// The same summary, file and judgement serve an organ's bench (dev/harness2/bench.mjs), which that
// organ's lane measures main's head on and plans from: summarizeBaseline and failingTasks take the
// bench's suite and version, and its kept file is benchBaselinePath(organ).
//
// A held-out task stays a score here: none of its checks is named, so nothing the planner or the
// proposer reads steers a change toward it, and the measurement's held-out regression check means
// what it says.
//
//   summarizeBaseline(result, { commit, at })  the summary of an `eval --real-model` result
//   readBaseline / writeBaseline               the kept file: the latest summary and the last attempt
//   baselineDue({ kept, head, now, everyHours })
//   failingTasks(summary)                      the training tasks with a check failing in half their runs or more
//   taskPlanKey / TARGET_MARKER / issueTarget  how a planned issue names its task
//   MEASURED_BASE_MARKER / measuredBase        how a measured pull request names the main it was measured on
//   targetProblems(evidence, target)           why a measurement does not show the target improved beyond noise
//   baselineCurrent({ summary, head, changed }) whether a baseline still describes main's head
//
// Pure except readBaseline and writeBaseline. Called by cycle.mjs, planner.mjs and guard.mjs.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EVIDENCE_RULES } from '../harness2/evidence.mjs';
import { MODEL_SUITE, MODEL_SUITE_VERSION } from '../harness2/model-suite.mjs';

/** The kept baseline, relative to the checkout. */
export const BASELINE_PATH = '.local/loop/baseline.json';

/** The kept baseline of an organ's bench (dev/harness2/bench.mjs), which that organ's lane plans from. */
export const benchBaselinePath = (organ) => `.local/loop/bench-${organ}.json`;

/** The hidden marker an issue planned from a baseline carries: `<!-- loop-target: <task id> -->`. */
export const TARGET_MARKER = 'loop-target';

/**
 * The hidden marker a measured loop pull request carries, naming the commit of main it was measured
 * against: `<!-- loop-measured-base: <sha> -->`. The Loop guard refuses the change once what the agent
 * reads changed on main since.
 */
export const MEASURED_BASE_MARKER = 'loop-measured-base';

const round = (n) => Number(n.toFixed(4));

/**
 * The summary of a real-model evaluation of main's head: per task its role, split, runs and mean
 * capability, and for a training task each check with how many of its measured runs it failed.
 *
 * @param {object} result  runCli `eval --real-model`'s result ({ trials, trajectories })
 * @param {object} o       { commit, at, tasks } (tasks: the suite, for tests)
 * @returns {object}
 */
export function summarizeBaseline(result, { commit, at, tasks = MODEL_SUITE, suite = 'model', version = MODEL_SUITE_VERSION } = {}) {
  const trajectories = (Array.isArray(result?.trajectories) ? result.trajectories : []).filter((t) => t?.taskId);
  const rows = new Map();
  for (const t of trajectories) {
    const row = rows.get(t.taskId) || { runs: 0, scores: [], checks: new Map(), split: t.split };
    row.runs += 1;
    if (t.measured && typeof t.checkScore === 'number') {
      row.scores.push(t.checkScore);
      for (const c of Array.isArray(t.checks) ? t.checks : []) {
        const k = row.checks.get(c.name) || { name: String(c.name), runs: 0, failed: 0 };
        k.runs += 1;
        if (!c.ok) {
          k.failed += 1;
          if (!k.detail && c.detail) k.detail = String(c.detail).slice(0, 300);
        }
        row.checks.set(c.name, k);
      }
    }
    rows.set(t.taskId, row);
  }
  const summary = [...rows].map(([id, row]) => {
    const task = tasks.find((x) => x.id === id);
    const split = task?.split || row.split || 'train';
    return {
      id,
      role: task?.role || null,
      split,
      runs: row.runs,
      measuredRuns: row.scores.length,
      score: row.scores.length ? round(row.scores.reduce((a, b) => a + b, 0) / row.scores.length) : null,
      ...(split === 'train' ? { checks: [...row.checks.values()] } : {}),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    suite,
    suiteVersion: version,
    commit: commit || null,
    at: at || null,
    trials: result?.trials ?? null,
    measured: trajectories.length > 0 && trajectories.every((t) => t.measured),
    tasks: summary,
  };
}

/** The kept file, { latest, attempt }, or an empty one. */
export function readBaseline({ repoRoot = process.cwd(), readFile = (p) => fs.readFileSync(p, 'utf8'), file = BASELINE_PATH } = {}) {
  try {
    const kept = JSON.parse(readFile(path.join(repoRoot, file)));
    return { latest: kept?.latest || null, attempt: kept?.attempt || null };
  } catch {
    return { latest: null, attempt: null };
  }
}

/** Keeps the latest summary (when this attempt made one) and this attempt: { at, commit, ok, reason }. */
export function writeBaseline({ repoRoot = process.cwd(), kept, summary = null, attempt, file: rel = BASELINE_PATH }) {
  const file = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ latest: summary || kept?.latest || null, attempt }, null, 2)}\n`);
}

/**
 * Whether a cycle should measure main's head now: never on a head already measured (or tried) with
 * this suite, and at most once in `everyHours`, counted from the last attempt, so a run that fails is
 * not retried every cycle.
 */
export function baselineDue({ kept, head, now = new Date(), everyHours = 24, version = MODEL_SUITE_VERSION }) {
  const last = kept?.attempt || null;
  if (!last) return true;
  if (last.commit === head && kept?.latest?.suiteVersion === version) return false;
  return now.getTime() - Date.parse(last.at) >= everyHours * 3_600_000;
}

/**
 * The training tasks main's head fails: each with the checks that failed in half of its measured runs
 * or more (a request that comes back wrong half the time is a weakness to fix), worst task first.
 * Nothing from a summary that was not all real-model runs, or of another version of the suite.
 */
export function failingTasks(summary, { suite = 'model', version = MODEL_SUITE_VERSION } = {}) {
  if (!summary?.measured || (summary.suite || 'model') !== suite || summary.suiteVersion !== version) return [];
  return (summary.tasks || [])
    .filter((t) => t.split === 'train' && t.measuredRuns > 0)
    .map((t) => ({ ...t, failing: (t.checks || []).filter((c) => c.runs > 0 && c.failed * 2 >= c.runs) }))
    .filter((t) => t.failing.length)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.id.localeCompare(b.id));
}

/**
 * The plan key of an issue for a failing task: the task, the suite's version and which checks fail,
 * so the same failure is planned once (a `loop-stuck` issue included), and a different set of failing
 * checks, after a fix of some, is planned anew.
 */
export function taskPlanKey(task, { prefix = 'model', version = MODEL_SUITE_VERSION } = {}) {
  const names = (task.failing || []).map((c) => c.name).sort().join('\n');
  const digest = createHash('sha256').update(names).digest('hex').slice(0, 8);
  return `${prefix}-${task.id}-v${version}-${digest}`;
}

/**
 * Whether a baseline still describes main: it measured main's head, or nothing the agent reads changed
 * since (`changed`: the paths that differ between the two commits). A failure it saw may already be
 * fixed on main otherwise, so nothing is planned from it until the next baseline. Pure.
 *
 * @param {object} o  { summary, head, changed, isBehaviourPath }
 * @returns {{ current: boolean, reason: string|null }}
 */
export function baselineCurrent({ summary, head, changed = [], isBehaviourPath }) {
  if (!summary?.commit || !head) return { current: false, reason: "the baseline's commit or main's head is unknown" };
  if (summary.commit === head) return { current: true, reason: null };
  const behaviour = changed.filter((p) => isBehaviourPath(p));
  if (!behaviour.length) return { current: true, reason: null };
  return {
    current: false,
    reason: `what the agent reads changed since the baseline of ${summary.commit.slice(0, 12)} (${behaviour.slice(0, 3).join(', ')}${behaviour.length > 3 ? ', ...' : ''})`,
  };
}

/** The commit a pull request's evidence was measured against, from its MEASURED_BASE_MARKER, or null. */
export function measuredBase(body) {
  return new RegExp(`<!-- ${MEASURED_BASE_MARKER}: ([0-9a-f]{40}) -->`).exec(String(body || ''))?.[1] || null;
}

/** The task a planned issue targets, from its TARGET_MARKER, or null. */
export function issueTarget(body) {
  return new RegExp(`<!-- ${TARGET_MARKER}: ([a-z0-9-]+) -->`).exec(String(body || ''))?.[1] || null;
}

/**
 * Why a measurement does not show the target task improved: it did not run the task on both sides, or
 * the change's gain on it is not above zero and beyond run-to-run noise: more than `noiseZ` standard
 * errors of the difference of the two means, as promotion evidence demands of a gain. Pure.
 *
 * @param {object|null} evidence  buildPromotionEvidence's result
 * @param {string} target         the task id
 * @param {object} [rules]        { noiseZ }, DEFAULT_EVIDENCE_RULES's by default
 * @returns {string[]}
 */
export function targetProblems(evidence, target, { noiseZ = DEFAULT_EVIDENCE_RULES.noiseZ } = {}) {
  const t = (evidence?.perTask || []).find((x) => x.taskId === target);
  if (!t?.baseline?.n || !t?.candidate?.n) return [`its measurement did not run the target task ${target} on both sides`];
  const gain = t.candidate.mean - t.baseline.mean;
  const se = Math.sqrt((t.baseline.sd ?? 0) ** 2 / t.baseline.n + (t.candidate.sd ?? 0) ** 2 / t.candidate.n);
  if (!(gain > 0)) return [`the target task ${target} did not improve: capability ${t.baseline.mean} -> ${t.candidate.mean}`];
  if (!(gain > noiseZ * se)) {
    return [`the target task ${target}'s gain ${round(gain)} (${t.baseline.n} and ${t.candidate.n} runs) is within run-to-run noise (${noiseZ} x ${round(se)} = ${round(noiseZ * se)})`];
  }
  return [];
}
