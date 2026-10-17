// agent/work/effort.mjs: maps the instance's effort setting to a model sampling temperature. Higher
// effort means warmer, more exploratory sampling: the level multiplies each organ's base temperature
// and the result is clamped to a safe ceiling. Pure. Reading the setting (a dashboard admin sets it)
// and choosing each organ's base temperature belong to the caller, the brain, which applies this to
// every organ call.
//
// Effort only tunes sampling. It never changes which checks run, what the verifier demands, or any
// other part of the deterministic machinery around the models.

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];
export const DEFAULT_EFFORT = 'medium';

// Multiplier applied to the base temperature. 'medium' = 1.0, the unchanged baseline.
const SCALE = { low: 0.5, medium: 1.0, high: 1.4, max: 1.8 };
// Effective-temperature ceiling. Claude models cap temperature at 1.0 and the cortex can run on
// Claude; keeping every organ inside this band lets 'max' explore without becoming incoherent.
const TEMP_CEILING = 1.0;

/** Coerce any value to a known effort level; unknown or absent becomes DEFAULT_EFFORT. */
export function normalizeEffort(effort) {
  return EFFORT_LEVELS.includes(effort) ? effort : DEFAULT_EFFORT;
}

/** The temperature multiplier for an effort level. */
export function effortScale(effort) {
  return SCALE[normalizeEffort(effort)];
}

/**
 * Scale a base temperature by effort, clamped to [0, TEMP_CEILING].
 * 'medium' returns the base unchanged; a non-numeric base falls back to 0.5.
 */
export function applyEffort(baseTemperature, effort) {
  const base = typeof baseTemperature === 'number' ? baseTemperature : 0.5;
  const t = base * effortScale(effort);
  return Math.max(0, Math.min(TEMP_CEILING, t));
}
