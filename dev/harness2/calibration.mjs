// dev/harness2/calibration.mjs: whether a real-model run's measurement can be trusted before a
// promotion relies on it. Two checks, on the same tasks and trials as the promotion:
//
// - A/A: the baseline run again, as if it were a candidate. The gate must not see a gain (or a loss)
//   where there is no change. If it does, the runs are too noisy or drift, and any "gain" is noise.
// - Known-bad: the baseline with a change known to break the agent (KNOWN_BAD_CHANGE: the motor, the
//   organ that does the work, told to do nothing). The runs must show a clear loss. If they do not,
//   the measurement cannot see a prompt change at all.
//
// A calibration holds for one baseline commit, role, suite version, task set and trial count (a role
// without tasks of its own runs the generic tasks under their own ids, as that role), and is kept in
// .local/harness2/calibration/ for CALIBRATION_MAX_AGE_HOURS, so cycles on the same commit pay for it
// once. It is run only when a promotion would otherwise pass (cli.mjs), since it costs two sides of
// runs. It does not run rollouts itself: the caller's `evaluate(filePatches)` does. Called by cli.mjs;
// its verdict goes into the evidence (evidence.mjs `buildPromotionEvidence`), whose judge refuses a
// promotion without a passing one.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EVIDENCE_RULES, compareRuns } from './evidence.mjs';

/** The change every calibration runs, known to break the agent. On the mutable surface, as a real one is. */
export const KNOWN_BAD_CHANGE = Object.freeze({
  path: 'prompts/motor.md',
  text: [
    '# Motor',
    '',
    'Do not run any command, read any file or change anything. Whatever the task, answer with the single',
    'word "done".',
    '',
  ].join('\n'),
});

/** A known-bad change must cost at least this much capability, and more than the noise. */
export const KNOWN_BAD_MIN_LOSS = 0.1;

export const CALIBRATION_MAX_AGE_HOURS = 24;

export const DEFAULT_CALIBRATION_DIR = '.local/harness2/calibration';

/**
 * The verdict on a calibration's runs. Pure.
 *
 * @param {object} p
 * @param {object[]} p.baselineTrajectories  the promotion's baseline runs
 * @param {object[]} p.repeatTrajectories    the baseline again
 * @param {object[]} p.knownBadTrajectories  the baseline with KNOWN_BAD_CHANGE
 * @param {object} [p.rules]                 the evidence rules the promotion is judged by
 * @returns {{ ok: boolean, aa: object, knownBad: object, problems: string[] }}
 */
export function judgeCalibration({ baselineTrajectories = [], repeatTrajectories = [], knownBadTrajectories = [], rules = {} } = {}) {
  const r = { ...DEFAULT_EVIDENCE_RULES, ...rules };
  const aa = compareRuns(baselineTrajectories, repeatTrajectories);
  const bad = compareRuns(baselineTrajectories, knownBadTrajectories);
  const problems = [];
  if (!aa.baseline.n || !aa.candidate.n) problems.push('the A/A check has no runs');
  else if (Math.abs(aa.delta) >= r.minGain && Math.abs(aa.delta) > r.noiseZ * aa.noise) {
    problems.push(`the baseline against itself moved ${aa.delta} (noise ${aa.noise}): the gate would see a change where there is none`);
  }
  const loss = -bad.delta;
  const detected = bad.candidate.n > 0 && loss >= KNOWN_BAD_MIN_LOSS && loss > r.noiseZ * bad.noise;
  if (!bad.baseline.n || !bad.candidate.n) problems.push('the known-bad check has no runs');
  else if (!detected) {
    problems.push(`a known-bad change moved capability only ${bad.delta} (noise ${bad.noise}): the measurement cannot see a prompt change`);
  }
  return {
    ok: problems.length === 0,
    aa: { delta: aa.delta, noise: aa.noise, runs: aa.candidate.n },
    knownBad: { change: KNOWN_BAD_CHANGE.path, delta: bad.delta, noise: bad.noise, runs: bad.candidate.n, detected },
    problems,
  };
}

/** The cache key: one baseline commit, role, suite version, task set and trial count. */
export function calibrationKey({ commit, role = null, suiteVersion = null, taskIds, trials }) {
  const hash = createHash('sha256').update(JSON.stringify({ role, suiteVersion, taskIds: [...taskIds].sort(), trials })).digest('hex').slice(0, 10);
  return `${String(commit || 'unknown').slice(0, 12)}-${hash}`;
}

/**
 * The calibration for this baseline: the cached one when it is fresh, else two runs (`evaluate({})`,
 * the baseline again, and `evaluate({[KNOWN_BAD_CHANGE.path]: text})`) judged and cached.
 *
 * @param {object} p
 * @param {(filePatches: object) => Promise<{ trajectories: object[] }>} p.evaluate
 * @param {object[]} p.baselineTrajectories
 * @param {string} p.commit       the baseline's commit
 * @param {string|null} [p.role]  the role the tasks ran as
 * @param {number|null} [p.suiteVersion]
 * @param {string[]} p.taskIds
 * @param {number} p.trials
 * @param {string} [p.repoRoot]
 * @param {string} [p.dir]        the cache directory, relative to repoRoot
 * @param {boolean} [p.refresh]   ignore the cache (`--recalibrate`)
 * @param {Date} [p.now]
 * @param {object} [p.rules]
 * @returns {Promise<object>} judgeCalibration's verdict, with `commit`, `key`, `at` and `cached`
 */
export async function calibrateMeasurement({
  evaluate, baselineTrajectories, commit, role = null, suiteVersion = null, taskIds, trials, repoRoot = process.cwd(),
  dir = DEFAULT_CALIBRATION_DIR, refresh = false, now = new Date(), rules,
}) {
  const key = calibrationKey({ commit, role, suiteVersion, taskIds, trials });
  const file = path.join(repoRoot, dir, `${key}.json`);
  if (!refresh && fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      const age = now.getTime() - Date.parse(cached.at);
      if (Number.isFinite(age) && age >= 0 && age < CALIBRATION_MAX_AGE_HOURS * 3_600_000) return { ...cached, cached: true };
    } catch {
      // a broken cache file is run again
    }
  }
  const repeat = await evaluate({});
  const knownBad = await evaluate({ [KNOWN_BAD_CHANGE.path]: KNOWN_BAD_CHANGE.text });
  const verdict = {
    ...judgeCalibration({
      baselineTrajectories, repeatTrajectories: repeat.trajectories, knownBadTrajectories: knownBad.trajectories, rules,
    }),
    commit,
    key,
    at: now.toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  return { ...verdict, cached: false };
}
