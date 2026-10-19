// dev/harness2/selection.mjs: Pareto frontier maintenance, non-regression guards, and cross-lens synthesis.

/**
 * Default tolerance thresholds for non-regression guards.
 */
export const DEFAULT_REGRESSION_GUARDS = Object.freeze({
  capabilityDropTolerance: 0.0,
  reliabilityDropTolerance: 0.02,
});

/**
 * Verify that `candidateScores` does not violate capability or reliability
 * non-regression guards relative to `baselineScores`.
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
 * sorted descending by `fitness` (then `capability`, then `reliability`).
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

  return frontier.sort((x, y) => {
    const sx = x.scores || x;
    const sy = y.scores || y;
    if ((sy.fitness ?? 0) !== (sx.fitness ?? 0)) return (sy.fitness ?? 0) - (sx.fitness ?? 0);
    if ((sy.capability ?? 0) !== (sx.capability ?? 0)) return (sy.capability ?? 0) - (sx.capability ?? 0);
    return (sy.reliability ?? 0) - (sx.reliability ?? 0);
  });
}

/**
 * Synthesize complementary winning patches from the `INV` branch (components `c1..c4, c8`)
 * and the `DOM` branch (components `c5..c7`). Because `INV` and `DOM` mutate disjoint
 * components of the 8-component surface, their file-level patches can be merged cleanly
 * without textual conflict and evaluated as a combined `H_SYN` candidate.
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

  if (invImproved && domImproved && typeof mergeAndEvaluate === 'function') {
    const merged = await mergeAndEvaluate(invResult.bestCandidate, domResult.bestCandidate, parentState);
    const pool = [parentState, invResult.bestCandidate, domResult.bestCandidate, merged];
    const frontier = computeParetoFrontier(pool);
    return {
      synthesized: true,
      mergedCandidate: merged,
      bestOverall: frontier[0] || merged,
      frontier,
    };
  }

  const pool = [
    parentState,
    ...(invImproved ? [invResult.bestCandidate] : []),
    ...(domImproved ? [domResult.bestCandidate] : []),
  ].filter(Boolean);

  const frontier = computeParetoFrontier(pool);
  return {
    synthesized: false,
    mergedCandidate: null,
    bestOverall: frontier[0] || parentState,
    frontier,
  };
}
