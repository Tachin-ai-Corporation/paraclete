// dev/harness2/recursion.mjs: Within-Generation Recursion Controller with Capability-First Credo, regression revert, and directional escalation.

import { buildMutationProposalSpec } from './lenses.mjs';
import { isNonRegression, isBetterUnderCapabilityCredo } from './selection.mjs';

/**
 * Run up to `maxSteps` within-generation recursive refinement steps for a single
 * lens (`INV` or `DOM`).
 *
 * At each step `r`:
 * 1. Build a mutation proposal spec conditioned on `priorAttempts` (directional escalation).
 * 2. Call `proposeAndApply(spec, parentState)` to generate a candidate state.
 * 3. Validate the candidate via `validateCandidate(candidateState)`. If invalid, revert immediately.
 * 4. Evaluate the candidate on the benchmark subset via `evaluateCandidate(candidateState)`.
 * 5. Compare against the current best state in this generation under the Capability-First Credo:
 *    - Capability can NEVER regress (`isNonRegression`).
 *    - Any candidate that strictly improves `capability` (while respecting the reliability guard)
 *      wins immediately, even if efficiency decreased.
 *    - Only when `capability` is at least equal to `currentBest` do reliability/efficiency gains
 *      advance `currentBest`.
 *    - Otherwise, revert to `currentBest` and append a reflection entry so step `r+1` escalates.
 *
 * @param {object} opts
 * @param {'INV' | 'DOM'} opts.lens
 * @param {object} opts.parentState  `{ id, scores, trajectories, snapshot }`
 * @param {number} [opts.maxSteps]   Default 3
 * @param {string} [opts.stage]
 * @param {string} [opts.role]
 * @param {(spec: object, baseState: object) => Promise<object>} opts.proposeAndApply
 * @param {(candidate: object) => Promise<{ ok: boolean, violations: string[] }> | { ok: boolean, violations: string[] }} opts.validateCandidate
 * @param {(candidate: object) => Promise<{ summary: object, trajectories: object[] }>} opts.evaluateCandidate
 * @param {(state: object) => Promise<void> | void} [opts.restoreSnapshot]
 */
export async function runWithinGenerationRecursion(opts = {}) {
  const maxSteps = opts.maxSteps ?? 3;
  const lens = opts.lens || 'INV';
  let currentBest = opts.parentState;
  const history = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    const spec = buildMutationProposalSpec({
      lens,
      trajectories: currentBest.trajectories || [],
      stage: opts.stage,
      role: opts.role,
      priorAttempts: history,
    });

    const candidate = await opts.proposeAndApply(spec, currentBest);
    const validation = await opts.validateCandidate(candidate);

    if (!validation.ok) {
      if (typeof opts.restoreSnapshot === 'function') {
        await opts.restoreSnapshot(currentBest);
      }
      history.push({
        step,
        lens,
        escalationMode: spec.escalationMode,
        hypothesis: candidate.hypothesis || `step-${step}`,
        accepted: false,
        deltaCapability: null,
        deltaFitness: null,
        revertReason: `validation_failed: ${validation.violations.join('; ')}`,
      });
      continue;
    }

    const evalResult = await opts.evaluateCandidate(candidate);
    const candidateScores = evalResult.summary;
    const baseScores = currentBest.scores;
    const deltaCapability = Number(
      ((candidateScores.capability ?? 0) - (baseScores.capability ?? 0)).toFixed(4),
    );
    const deltaFitness = Number(
      ((candidateScores.fitness ?? 0) - (baseScores.fitness ?? 0)).toFixed(4),
    );

    const passesGuard = isNonRegression(candidateScores, baseScores);
    const improvesUnderCredo = isBetterUnderCapabilityCredo(candidateScores, baseScores);

    if (passesGuard && improvesUnderCredo) {
      currentBest = {
        ...candidate,
        scores: candidateScores,
        trajectories: evalResult.trajectories,
      };
      history.push({
        step,
        lens,
        escalationMode: spec.escalationMode,
        hypothesis: candidate.hypothesis || `step-${step}`,
        accepted: true,
        deltaCapability,
        deltaFitness,
        scores: candidateScores,
        revertReason: null,
      });
    } else {
      if (typeof opts.restoreSnapshot === 'function') {
        await opts.restoreSnapshot(currentBest);
      }
      const reason = !passesGuard
        ? 'regressed_capability_or_reliability'
        : `non_improving_capability_or_fitness (deltaCap=${deltaCapability}, deltaFit=${deltaFitness})`;
      history.push({
        step,
        lens,
        escalationMode: spec.escalationMode,
        hypothesis: candidate.hypothesis || `step-${step}`,
        accepted: false,
        deltaCapability,
        deltaFitness,
        scores: candidateScores,
        revertReason: reason,
      });
    }
  }

  return {
    lens,
    improved: currentBest !== opts.parentState,
    bestCandidate: currentBest,
    history,
  };
}
