// dev/harness2/evidence.mjs: the measured evidence a promotion carries, and the verdict on it. A
// promotion is a candidate harness change scored against the current version (the baseline) on the
// same benchmark tasks, each task run several times on each side. This module turns those runs into
// per-task and overall capability statistics, judges whether the gain is real, and writes and reads
// the evidence block a promotion pull request carries, so whoever merges it can check the evidence
// instead of trusting a number in a title.
//
// The verdict passes only when every rule holds: a model proposed the change (never the fixed edits
// of the template fallback), no run was the synthetic dry run (which always completes, so it measures
// nothing), no run was answered by the scripted in-process gateway (which gives every harness the
// same answers, so it measures nothing either), every run was a real-model run that sent its own
// side's prompts to the model (`measured`, model-runs.mjs), the measurement passed its calibration
// (calibration.mjs: the baseline against itself shows no gain, and a known-bad change shows a loss),
// every task ran at least `minTrials` times on both sides, the capability gain is at least `minGain`
// and larger than `noiseZ` standard errors of the difference, no task got worse by more than
// `taskTolerance`, and the held-out tasks (model-suite.mjs), which the proposer never saw, got no
// worse than `holdoutTolerance`.
//
// Pure: no git, no network, no files. Called by promote.mjs (readiness, the pull request gate and the
// report) and cli.mjs (building evidence from an evaluation's trajectories). It does not run anything.

import { scoreTrajectory } from './trajectory.mjs';

/** The evidence format, written into the block so a reader can refuse one it does not know. */
export const EVIDENCE_SCHEMA = 'paraclete-h2-evidence/1';

/** The info string of the fenced block a promotion pull request carries the evidence in. */
export const EVIDENCE_FENCE = 'json paraclete-h2-evidence';

export const DEFAULT_EVIDENCE_RULES = Object.freeze({
  /** Runs of every task, on each side. */
  minTrials: 3,
  /** The gain must exceed this many standard errors of the difference of the two means. */
  noiseZ: 2,
  /** And be at least this much capability (0..1). */
  minGain: 0.01,
  /** No task's mean capability may fall by more than this. */
  taskTolerance: 0.05,
  /** The held-out tasks' mean capability may fall by no more than this. */
  holdoutTolerance: 0.01,
  /** Every run must be a real-model run of its own side (`measured`). */
  requireMeasured: true,
  /** The measurement must have passed its calibration (calibration.mjs). */
  requireCalibration: true,
  /** Proposal sources that are never promoted: the template fallback's fixed edits, or no change. */
  refusedSources: Object.freeze(['template', 'fallback', 'none', 'unknown']),
});

const round = (n) => Number(Number(n).toFixed(4));

/** n, mean and sample standard deviation of a list of numbers. */
function stats(values) {
  const n = values.length;
  const mean = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: round(mean), sd: round(sd) };
}

/** Each run's task, trial, split, how it ran (synthetic, scripted, measured), and its capability. */
function capabilityRuns(trajectories, budgets) {
  return (Array.isArray(trajectories) ? trajectories : []).map((t) => ({
    taskId: String(t.taskId ?? t.missionId ?? 'unknown'),
    trial: t.trial ?? null,
    split: t.split || null,
    synthetic: Boolean(t.synthetic) || /^dryrun-/.test(String(t.missionId || '')),
    scripted: Boolean(t.scripted),
    measured: Boolean(t.measured),
    capability: typeof t.capability === 'number' ? t.capability : scoreTrajectory(t, budgets).capability,
  }));
}

/**
 * Two sets of runs compared: each side's capability statistics, the difference of their means, and
 * the standard error of that difference.
 *
 * @param {object[]} baseTrajectories
 * @param {object[]} candTrajectories
 * @param {object} [budgets]
 * @returns {{ baseline: object, candidate: object, delta: number, noise: number }}
 */
export function compareRuns(baseTrajectories, candTrajectories, budgets) {
  return compareCapability(capabilityRuns(baseTrajectories, budgets), capabilityRuns(candTrajectories, budgets));
}

function compareCapability(base, cand) {
  const b = stats(base.map((r) => r.capability));
  const c = stats(cand.map((r) => r.capability));
  const noise = Math.sqrt((b.n ? b.sd ** 2 / b.n : 0) + (c.n ? c.sd ** 2 / c.n : 0));
  return { baseline: b, candidate: c, delta: round(c.mean - b.mean), noise: round(noise) };
}

/**
 * The evidence for one candidate against the baseline.
 *
 * @param {object} p
 * @param {object} p.candidate               the winning candidate: id, lens, touchedPaths, proposal
 * @param {object[]} p.baselineTrajectories  the baseline's runs (each with taskId and trial)
 * @param {object[]} [p.candidateTrajectories] the candidate's runs; default `candidate.trajectories`
 * @param {object} [p.budgets]               scoring budgets, as trajectory.mjs takes them
 * @returns {object} the evidence, schema EVIDENCE_SCHEMA
 */
export function buildPromotionEvidence({
  candidate = {}, baselineTrajectories = [], candidateTrajectories, budgets, calibration = null, suite = null,
} = {}) {
  const base = capabilityRuns(baselineTrajectories, budgets);
  const cand = capabilityRuns(candidateTrajectories ?? candidate.trajectories, budgets);
  const taskIds = [...new Set([...base, ...cand].map((r) => r.taskId))].sort();
  const perTask = taskIds.map((taskId) => {
    const b = stats(base.filter((r) => r.taskId === taskId).map((r) => r.capability));
    const c = stats(cand.filter((r) => r.taskId === taskId).map((r) => r.capability));
    return { taskId, baseline: b, candidate: c, delta: round(c.mean - b.mean) };
  });
  const baseline = stats(base.map((r) => r.capability));
  const candidateStats = stats(cand.map((r) => r.capability));
  const noise = Math.sqrt((baseline.n ? baseline.sd ** 2 / baseline.n : 0) + (candidateStats.n ? candidateStats.sd ** 2 / candidateStats.n : 0));
  const fewest = (side) => (perTask.length ? Math.min(...perTask.map((t) => t[side].n)) : 0);
  const all = [...base, ...cand];
  const heldOut = (runs) => runs.filter((r) => r.split === 'holdout');
  const holdout = heldOut(all).length ? compareCapability(heldOut(base), heldOut(cand)) : null;
  return {
    schema: EVIDENCE_SCHEMA,
    candidateId: candidate.id || null,
    lens: candidate.lens || null,
    touchedPaths: candidate.touchedPaths || [],
    proposal: {
      source: candidate.proposal?.source || 'unknown',
      hypothesis: candidate.proposal?.hypothesis || candidate.hypothesis || null,
    },
    trials: { baseline: fewest('baseline'), candidate: fewest('candidate') },
    synthetic: all.some((r) => r.synthetic),
    scripted: all.some((r) => r.scripted),
    measured: all.length > 0 && all.every((r) => r.measured),
    suite,
    calibration,
    holdout,
    capability: {
      baseline,
      candidate: candidateStats,
      delta: round(candidateStats.mean - baseline.mean),
      noise: round(noise),
    },
    perTask,
  };
}

/**
 * Whether the evidence shows a real gain. Every problem is named, so a refused promotion says why.
 *
 * @param {object|null} evidence  buildPromotionEvidence's result, or one read back from a block
 * @param {object} [rules]        DEFAULT_EVIDENCE_RULES, or stricter
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function judgeEvidence(evidence, rules = DEFAULT_EVIDENCE_RULES) {
  const r = { ...DEFAULT_EVIDENCE_RULES, ...rules };
  if (!evidence || typeof evidence !== 'object') return { ok: false, problems: ['no measured evidence'] };
  if (evidence.schema !== EVIDENCE_SCHEMA) {
    return { ok: false, problems: [`evidence schema '${evidence.schema}' is not ${EVIDENCE_SCHEMA}`] };
  }
  const problems = [];
  const source = evidence.proposal?.source || 'unknown';
  if (r.refusedSources.includes(source)) {
    problems.push(`the change came from '${source}', not a model: the template fallback's fixed edits are never promoted`);
  }
  if (evidence.synthetic) problems.push('some runs were the synthetic dry run, which always completes and measures nothing');
  if (evidence.scripted) {
    problems.push(
      "some runs were answered by the scripted in-process gateway, which gives every harness the same answers and measures nothing; only runs whose organs answer through a model measure a change",
    );
  }
  if (r.requireMeasured && !evidence.measured && !evidence.synthetic && !evidence.scripted) {
    problems.push("some runs did not send their own side's prompts to a model; only a --real-model run measures a change");
  }
  // Calibration is judged only for measured runs: unmeasured ones are refused above, whatever it says.
  if (r.requireCalibration && evidence.measured) {
    if (!evidence.calibration) problems.push('the measurement was not calibrated (calibration.mjs)');
    else if (!evidence.calibration.ok) {
      problems.push(`the measurement failed its calibration: ${(evidence.calibration.problems || ['no reason given']).join('; ')}`);
    }
  }
  const perTask = Array.isArray(evidence.perTask) ? evidence.perTask : [];
  if (perTask.length === 0) problems.push('no task was run');
  const onlyOneSide = perTask.filter((t) => !t.baseline?.n || !t.candidate?.n).map((t) => t.taskId);
  if (onlyOneSide.length) problems.push(`tasks run on one side only: ${onlyOneSide.join(', ')}`);
  const trials = Math.min(evidence.trials?.baseline ?? 0, evidence.trials?.candidate ?? 0);
  if (trials < r.minTrials) {
    problems.push(`a task ran only ${trials} time(s) on one side; a promotion needs ${r.minTrials} runs of every task on both sides`);
  }
  const delta = evidence.capability?.delta ?? 0;
  const noise = evidence.capability?.noise ?? 0;
  if (delta < r.minGain) problems.push(`the capability gain ${delta} is below ${r.minGain}`);
  else if (delta <= r.noiseZ * noise) {
    problems.push(`the capability gain ${delta} is within run-to-run noise (${r.noiseZ} x ${noise} = ${round(r.noiseZ * noise)})`);
  }
  for (const t of perTask) {
    if (t.baseline?.n && t.candidate?.n && t.candidate.mean < t.baseline.mean - r.taskTolerance) {
      problems.push(`task ${t.taskId} got worse: capability ${t.baseline.mean} -> ${t.candidate.mean}`);
    }
  }
  const h = evidence.holdout;
  if (h?.baseline?.n && h?.candidate?.n && h.candidate.mean < h.baseline.mean - r.holdoutTolerance) {
    problems.push(`the held-out tasks got worse: capability ${h.baseline.mean} -> ${h.candidate.mean}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The evidence as a pull request section: a table per task, the verdict, and the machine-readable
 * block (`parseEvidenceBlock` reads it back).
 *
 * @param {object} evidence
 * @param {{ ok: boolean, problems: string[] }} [verdict]  judgeEvidence(evidence) when omitted
 * @returns {string}
 */
export function formatEvidenceMarkdown(evidence, verdict = judgeEvidence(evidence)) {
  const cell = (s) => `${s.mean} ± ${s.sd} (n=${s.n})`;
  const lines = [
    '## Measured Evidence',
    '',
    `- **Proposal**: ${evidence.proposal?.source || 'unknown'}${evidence.proposal?.hypothesis ? ` — ${evidence.proposal.hypothesis}` : ''}`,
    `- **Runs per task**: baseline ${evidence.trials?.baseline ?? 0}, candidate ${evidence.trials?.candidate ?? 0}${evidence.synthetic ? ' (synthetic dry run)' : ''}${evidence.scripted ? ' (scripted in-process gateway)' : ''}`,
    `- **Capability**: ${cell(evidence.capability.baseline)} -> ${cell(evidence.capability.candidate)}, delta ${evidence.capability.delta}, noise (SE) ${evidence.capability.noise}`,
    ...(evidence.holdout ? [`- **Held-out tasks**: ${cell(evidence.holdout.baseline)} -> ${cell(evidence.holdout.candidate)}, delta ${evidence.holdout.delta}`] : []),
    `- **Measured**: ${evidence.measured ? `every run sent its side's own prompts to the model${evidence.suite ? ` (suite ${evidence.suite.name} v${evidence.suite.version})` : ''}` : 'no'}`,
    `- **Calibration**: ${evidence.calibration ? `${evidence.calibration.ok ? 'passed' : 'failed'}: the baseline against itself ${evidence.calibration.aa?.delta ?? '?'} (noise ${evidence.calibration.aa?.noise ?? '?'}), a known-bad change ${evidence.calibration.knownBad?.delta ?? '?'}` : 'not run'}`,
    `- **Verdict**: ${verdict.ok ? 'measured gain' : `not promotable: ${verdict.problems.join('; ')}`}`,
    '',
    '| Task | Baseline | Candidate | Delta |',
    '|---|---|---|---|',
    ...(evidence.perTask || []).map((t) => `| \`${t.taskId}\` | ${cell(t.baseline)} | ${cell(t.candidate)} | ${t.delta} |`),
    '',
    `\`\`\`${EVIDENCE_FENCE}`,
    JSON.stringify({ ...evidence, verdict }, null, 2),
    '```',
  ];
  return lines.join('\n');
}

/**
 * The evidence block in a pull request body, or null when there is none or it is not JSON.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseEvidenceBlock(text) {
  const m = new RegExp(`\`\`\`${EVIDENCE_FENCE}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``).exec(String(text || ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
