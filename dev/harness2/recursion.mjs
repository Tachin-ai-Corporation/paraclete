// dev/harness2/recursion.mjs: Within-Generation Recursion Controller with Capability-First Credo, regression revert, and directional escalation.

import { DEFAULT_EVIDENCE_RULES } from './evidence.mjs';
import { buildMutationProposalSpec } from './lenses.mjs';
import { isNonRegression, isBetterUnderCapabilityCredo } from './selection.mjs';

/**
 * Why a candidate is not worth evaluating, or null when it is. Only a candidate that records its
 * proposal (`candidate.proposal`, from live-runner.mjs) is judged here: one whose model proposal fell
 * back to the template, whose source the promotion evidence always refuses (evidence.mjs), or that
 * changed nothing. Evaluating it would pay for runs whose winner could never be promoted.
 *
 * @param {object} candidate
 * @returns {string|null}
 */
export function evaluationSkipReason(candidate) {
  const proposal = candidate?.proposal;
  if (!proposal) return null;
  if (proposal.fallbackReason) return `the model proposal fell back to the template: ${proposal.fallbackReason}`;
  if (DEFAULT_EVIDENCE_RULES.refusedSources.includes(proposal.source)) {
    return `a '${proposal.source}' change is never promoted`;
  }
  if (!candidate.touchedPaths?.length) return 'the proposal changed nothing';
  return null;
}

/**
 * Run up to `maxSteps` within-generation recursive refinement steps for a single
 * lens (`INV` or `DOM`).
 *
 * At each step `r`:
 * 1. Build a mutation proposal spec conditioned on `priorAttempts` (directional escalation).
 * 2. Call `proposeAndApply(spec, parentState)` to generate a candidate state. When
 *    `evaluationSkipReason` names a reason (a template fallback, or no change), revert and record it
 *    without validating or evaluating.
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
    // Held-out runs never reach the proposer: a change tuned to them would pass the evidence unseen.
    const spec = buildMutationProposalSpec({
      lens,
      trajectories: (currentBest.trajectories || []).filter((t) => t.split !== 'holdout'),
      stage: opts.stage,
      role: opts.role,
      priorAttempts: history,
    });

    const candidate = await opts.proposeAndApply(spec, currentBest);
    const attempt = {
      step,
      lens,
      escalationMode: spec.escalationMode,
      candidateId: candidate.id ?? null,
      hypothesis: candidate.hypothesis || `step-${step}`,
      ...(candidate.proposal ? { proposal: candidate.proposal } : {}),
    };

    const skipReason = evaluationSkipReason(candidate);
    if (skipReason) {
      if (typeof opts.restoreSnapshot === 'function') {
        await opts.restoreSnapshot(currentBest);
      }
      history.push({
        ...attempt,
        evaluated: false,
        accepted: false,
        deltaCapability: null,
        deltaFitness: null,
        revertReason: `not_evaluated: ${skipReason}`,
      });
      continue;
    }

    const validation = await opts.validateCandidate(candidate);

    if (!validation.ok) {
      if (typeof opts.restoreSnapshot === 'function') {
        await opts.restoreSnapshot(currentBest);
      }
      history.push({
        ...attempt,
        evaluated: false,
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
        ...attempt,
        evaluated: true,
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
        ...attempt,
        evaluated: true,
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
