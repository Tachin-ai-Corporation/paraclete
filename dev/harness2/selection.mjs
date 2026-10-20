// dev/harness2/selection.mjs: Capability-First Credo, Pareto frontier maintenance, non-regression guards, and cross-lens synthesis.

/**
 * The Paraclete-H² Capability-First Credo:
 * Capability overrides all other metrics. It is first and foremost the metric that can never
 * regress, and reliability or efficiency are optimized only AFTER capability is maximized.
 */
export const CAPABILITY_CREDO = Object.freeze({
  name: 'CAPABILITY_FIRST',
  priorityOrder: Object.freeze(['capability', 'reliability', 'efficiency']),
  primaryMetric: 'capability',
  secondaryMetric: 'reliability',
  tertiaryMetric: 'efficiency',
  capabilityDropTolerance: 0.0,
  capabilityTieEpsilon: 1e-4,
  reliabilityTieEpsilon: 1e-4,
  statement:
    'Capability overrides all other metrics. It can never regress, and reliability or efficiency are optimized only after capability is maximized.',
});

/**
 * Default tolerance thresholds for non-regression guards.
 * Capability drop tolerance is strictly 0.0 under the Capability-First Credo.
 */
export const DEFAULT_REGRESSION_GUARDS = Object.freeze({
  capabilityDropTolerance: 0.0,
  reliabilityDropTolerance: 0.02,
});

/**
 * Verify that `candidateScores` does not violate capability or reliability
 * non-regression guards relative to `baselineScores`.
 *
 * Under the Capability-First Credo, `capabilityDropTolerance` defaults to `0.0`:
 * any drop in capability is immediately rejected regardless of efficiency or reliability gains.
 *
 * @param {object} candidateScores  `{ capability, reliability, efficiency, fitness }`
 * @param {object} baselineScores   `{ capability, reliability, efficiency, fitness }`
 * @param {object} [guards]
 * @returns {boolean}
 */
export function isNonRegression(candidateScores, baselineScores, guards = DEFAULT_REGRESSION_GUARDS) {
  if (!candidateScores || !baselineScores) return false;
  const capTol = guards.capabilityDropTolerance ?? DEFAULT_REGRESSION_GUARDS.capabilityDropTolerance;
  const relTol = guards.reliabilityDropTolerance ?? DEFAULT_REGRESSION_GUARDS.reliabilityDropTolerance;

  const capDrop = (baselineScores.capability ?? 0) - (candidateScores.capability ?? 0);
  const relDrop = (baselineScores.reliability ?? 0) - (candidateScores.reliability ?? 0);

  return capDrop <= capTol + 1e-9 && relDrop <= relTol + 1e-9;
}

/**
 * Compare two candidates (or score vectors) in descending order under the
 * Capability-First Credo (returns `< 0` if `a` ranks ahead of `b`, `> 0` if `b` ranks ahead of `a`):
 *
 * 1. **Capability First**: If `|capability(a) - capability(b)| > capEpsilon`, the candidate with
 *    higher `capability` strictly wins, overriding any difference in efficiency, reliability, or fitness.
 * 2. **Reliability Second**: When capability is tied within `capEpsilon`, higher `reliability` wins.
 * 3. **Efficiency & Fitness Third**: Only when capability and reliability are tied do `efficiency`
 *    and scalar `fitness` break the tie.
 *
 * @param {object} a
 * @param {object} b
 * @param {object} [opts]
 * @returns {number}
 */
export function compareCapabilityFirst(a, b, opts = {}) {
  const sa = a?.scores || a || {};
  const sb = b?.scores || b || {};
  const capEps = opts.capabilityTieEpsilon ?? CAPABILITY_CREDO.capabilityTieEpsilon;
  const relEps = opts.reliabilityTieEpsilon ?? CAPABILITY_CREDO.reliabilityTieEpsilon;

  const capDiff = (sb.capability ?? 0) - (sa.capability ?? 0);
  if (Math.abs(capDiff) > capEps) return capDiff;

  const relDiff = (sb.reliability ?? 0) - (sa.reliability ?? 0);
  if (Math.abs(relDiff) > relEps) return relDiff;

  const effDiff = (sb.efficiency ?? 0) - (sa.efficiency ?? 0);
  if (Math.abs(effDiff) > 1e-4) return effDiff;

  return (sb.fitness ?? 0) - (sa.fitness ?? 0);
}

/**
 * Determine whether `candidateScores` is strictly better than `baselineScores`
 * under the Capability-First Credo:
 * - Must first pass `isNonRegression(candidateScores, baselineScores, guards)` (zero capability regression).
 * - If `capability` strictly increased (`> capEpsilon`), it is accepted immediately (even if it used
 *   more tokens/time and lowered `efficiency`, provided reliability stayed within guard).
 * - If `capability` is tied with `baselineScores`, it is accepted only if `reliability`, `efficiency`,
 *   or composite `fitness` strictly improved without regressing reliability.
 *
 * @param {object} candidateScores
 * @param {object} baselineScores
 * @param {object} [guards]
 * @returns {boolean}
 */
export function isBetterUnderCapabilityCredo(
  candidateScores,
  baselineScores,
  guards = DEFAULT_REGRESSION_GUARDS,
) {
  if (!candidateScores || !baselineScores) return false;

  const capTol = guards.capabilityDropTolerance ?? DEFAULT_REGRESSION_GUARDS.capabilityDropTolerance;
  const relTol = guards.reliabilityDropTolerance ?? DEFAULT_REGRESSION_GUARDS.reliabilityDropTolerance;
  const capEps = CAPABILITY_CREDO.capabilityTieEpsilon;
  const relEps = CAPABILITY_CREDO.reliabilityTieEpsilon;

  const capDrop = (baselineScores.capability ?? 0) - (candidateScores.capability ?? 0);
  if (capDrop > capTol + 1e-9) {
    return false;
  }

  const capGain = (candidateScores.capability ?? 0) - (baselineScores.capability ?? 0);
  // Rule 1: Capability overrides all other metrics — any strict capability gain wins immediately.
  if (capGain > capEps) {
    return true;
  }

  // Rule 2: At equal capability, enforce reliability non-regression guard first, then optimize reliability -> efficiency.
  const relDrop = (baselineScores.reliability ?? 0) - (candidateScores.reliability ?? 0);
  if (relDrop > relTol + 1e-9) {
    return false;
  }

  const relGain = (candidateScores.reliability ?? 0) - (baselineScores.reliability ?? 0);
  if (relGain > relEps) {
    return true;
  }

  const effGain = (candidateScores.efficiency ?? 0) - (baselineScores.efficiency ?? 0);
  const fitGain = (candidateScores.fitness ?? 0) - (baselineScores.fitness ?? 0);
  return effGain > 1e-4 || fitGain > 1e-4;
}

/**
 * Return true if candidate `a` Pareto-dominates candidate `b` across
 * `(capability, reliability, efficiency)`: >= on all three axes and strictly > on at least one.
 *
 * @param {object} a  Candidate with `scores: { capability, reliability, efficiency }` or direct score fields
 * @param {object} b  Candidate with `scores: { capability, reliability, efficiency }` or direct score fields
 * @returns {boolean}
 */
export function dominates(a, b) {
  const sa = a.scores || a;
  const sb = b.scores || b;
  const axes = ['capability', 'reliability', 'efficiency'];

  const geAll = axes.every((k) => (sa[k] ?? 0) >= (sb[k] ?? 0));
  const gtAny = axes.some((k) => (sa[k] ?? 0) > (sb[k] ?? 0));
  return geAll && gtAny;
}

/**
 * Compute the non-dominated Pareto frontier from a list of candidates,
 * sorted in descending Capability-First Credo order (`compareCapabilityFirst`:
 * capability first, reliability second, efficiency & fitness third).
 *
 * @param {object[]} candidates
 * @returns {object[]}
 */
export function computeParetoFrontier(candidates = []) {
  const frontier = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    let isDominated = false;
    for (let j = 0; j < candidates.length; j += 1) {
      if (i === j) continue;
      if (dominates(candidates[j], cand)) {
        isDominated = true;
        break;
      }
    }
    if (!isDominated) {
      frontier.push(cand);
    }
  }

  return frontier.sort((x, y) => compareCapabilityFirst(x, y));
}

/**
 * Synthesize complementary winning patches from the `INV` branch (components `c1..c4, c8`)
 * and the `DOM` branch (components `c5..c7`). Because `INV` and `DOM` mutate disjoint
 * components of the 8-component surface, their file-level patches can be merged cleanly
 * without textual conflict and evaluated as a combined `H_SYN` candidate.
 *
 * Selection of `bestOverall` strictly enforces the Capability-First Credo:
 * any candidate that regresses capability relative to `parentState` is excluded from winning,
 * and `frontier[0]` is chosen via `compareCapabilityFirst`.
 *
 * @param {object} opts
 * @param {object} opts.parentState
 * @param {object} opts.invResult  Output of `runWithinGenerationRecursion` for `INV`
 * @param {object} opts.domResult  Output of `runWithinGenerationRecursion` for `DOM`
 * @param {(invCandidate: object, domCandidate: object, parentState: object) => Promise<object>} [opts.mergeAndEvaluate]
 */
export async function synthesizeCrossLensCandidate(opts = {}) {
  const { parentState, invResult, domResult, mergeAndEvaluate } = opts;
  const invImproved = Boolean(invResult?.improved);
  const domImproved = Boolean(domResult?.improved);
  const baseScores = parentState?.scores || parentState;

  const filterEligible = (pool) => {
    if (!baseScores || typeof baseScores.capability !== 'number') return pool;
    const nonRegressing = pool.filter((c) => isNonRegression(c?.scores || c, baseScores));
    return nonRegressing.length > 0 ? nonRegressing : [parentState];
  };

  if (invImproved && domImproved && typeof mergeAndEvaluate === 'function') {
    const merged = await mergeAndEvaluate(invResult.bestCandidate, domResult.bestCandidate, parentState);
    const pool = filterEligible([parentState, invResult.bestCandidate, domResult.bestCandidate, merged].filter(Boolean));
    const frontier = computeParetoFrontier(pool);
    return {
      synthesized: true,
      mergedCandidate: merged,
      bestOverall: frontier[0] || parentState,
      frontier,
    };
  }

  const pool = filterEligible(
    [
      parentState,
      ...(invImproved ? [invResult.bestCandidate] : []),
      ...(domImproved ? [domResult.bestCandidate] : []),
    ].filter(Boolean),
  );

  const frontier = computeParetoFrontier(pool);
  return {
    synthesized: false,
    mergedCandidate: null,
    bestOverall: frontier[0] || parentState,
    frontier,
  };
}
