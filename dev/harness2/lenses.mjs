// dev/harness2/lenses.mjs: Dual-Lens Mutation Proposers (L_INV vs. L_DOM) for Loop A harness evolution.

import { PARACLETE_SURFACE } from './surface.mjs';

/**
 * The two orthogonal diagnostic and mutation lenses from Harness² adapted to
 * Paraclete's 8-component surface (`c1..c8`).
 */
export const MUTATION_LENSES = Object.freeze({
  INV: Object.freeze({
    id: 'INV',
    name: 'Domain-Invariant Execution Mechanics Lens',
    allowedComponents: Object.freeze(['c1_contracts', 'c2_base_prompts', 'c3_cerebellum_verifier', 'c4_memory_consolidation', 'c8_shell_ergonomics']),
    focus: [
      'Reduce checkpoint replan loops and tool syntax/flag errors.',
      'Eliminate unverified resource ID fabrication and enforce read-back verification.',
      'Right-size organ thinking effort levels, context compaction thresholds, and max tool turns.',
      'Improve shell error diagnostics and temporal memory contrastive lesson extraction.',
    ],
  }),
  DOM: Object.freeze({
    id: 'DOM',
    name: 'Domain-Specific Role & Skill Craft Lens',
    allowedComponents: Object.freeze(['c5_role_overlays', 'c6_skill_playbooks', 'c7_role_manifests']),
    focus: [
      'Deepen role-specific planning decomposition in roles/<role>/prompts/prefrontal.md.',
      'Strengthen domain-specific adversarial verification heuristics in roles/<role>/prompts/cerebellum.md.',
      'Refine procedural step order, failure recovery recipes, and output verification in skills/<skill>/SKILL.md.',
    ],
  }),
});

/**
 * Deterministically classify a batch of `ParacleteTrajectory` objects to decide
 * whether the dominant failure bottleneck is `INV` (Domain-Invariant Mechanics),
 * `DOM` (Domain-Specific Craft), or `BOTH`.
 *
 * @param {object[]} trajectories
 * @returns {{ primaryLens: 'INV' | 'DOM', invSignalScore: number, domSignalScore: number, reasons: string[] }}
 */
export function selectLensForTrajectories(trajectories = []) {
  let invSignalScore = 0;
  let domSignalScore = 0;
  const reasons = [];

  for (const t of trajectories) {
    if ((t.errorToolCalls || 0) > 0) {
      invSignalScore += 2 * t.errorToolCalls;
      reasons.push(`mission ${t.missionId}: ${t.errorToolCalls} tool error(s)`);
    }
    if ((t.evidenceFloorFailureCount || 0) > 0) {
      invSignalScore += 3 * t.evidenceFloorFailureCount;
      reasons.push(`mission ${t.missionId}: ${t.evidenceFloorFailureCount} evidence-floor failure(s)`);
    }
    if ((t.idRuleViolationCount || 0) > 0) {
      invSignalScore += 3 * t.idRuleViolationCount;
      reasons.push(`mission ${t.missionId}: ${t.idRuleViolationCount} unverified-ID violation(s)`);
    }
    if ((t.adversarialFailureCount || 0) > 0 && (t.errorToolCalls || 0) === 0) {
      domSignalScore += 3 * t.adversarialFailureCount;
      reasons.push(`mission ${t.missionId}: ${t.adversarialFailureCount} adversarial domain rejection(s) with clean tool execution`);
    }
    if (!t.missionCompleted && (t.errorToolCalls || 0) === 0 && (t.evidenceFloorFailureCount || 0) === 0) {
      domSignalScore += 2;
      reasons.push(`mission ${t.missionId}: incomplete domain rubric with zero mechanical tool errors`);
    }
    for (const cp of t.checkpoints || []) {
      if (cp.replanLens === 'INV') invSignalScore += 2;
      if (cp.replanLens === 'DOM') domSignalScore += 2;
    }
  }

  const primaryLens = domSignalScore > invSignalScore ? 'DOM' : 'INV';
  return {
    primaryLens,
    invSignalScore,
    domSignalScore,
    reasons,
  };
}

/**
 * Build a structured mutation proposal specification for either `INV` or `DOM`,
 * including allowed target components, diagnostic evidence, and reflection history
 * from any failed within-generation attempts.
 *
 * @param {object} opts
 * @param {'INV' | 'DOM'} opts.lens
 * @param {object[]} opts.trajectories
 * @param {string} [opts.stage]
 * @param {string} [opts.role]
 * @param {object[]} [opts.priorAttempts]  Prior within-generation attempts for directional escalation
 */
export function buildMutationProposalSpec(opts = {}) {
  const lensKey = opts.lens === 'DOM' ? 'DOM' : 'INV';
  const lens = MUTATION_LENSES[lensKey];
  const stage = opts.stage || 'stage1';
  const priorAttempts = Array.isArray(opts.priorAttempts) ? opts.priorAttempts : [];

  const allowedSurfaceDetails = lens.allowedComponents.map((cid) => ({
    id: cid,
    description: PARACLETE_SURFACE[cid]?.description || cid,
    paths: PARACLETE_SURFACE[cid]?.paths || [],
  }));

  const escalationMode =
    priorAttempts.length === 0
      ? 'initial_targeted_patch'
      : priorAttempts.length === 1
        ? 'refined_root_cause_patch'
        : 'structural_escalation';

  return {
    lens: lensKey,
    lensName: lens.name,
    stage,
    role: opts.role || null,
    escalationMode,
    allowedComponents: [...lens.allowedComponents],
    allowedSurfaceDetails,
    focus: [...lens.focus],
    priorAttemptsSummary: priorAttempts.map((a, idx) => ({
      attempt: idx + 1,
      hypothesis: a.hypothesis || '',
      deltaFitness: a.deltaFitness ?? null,
      revertReason: a.revertReason || null,
    })),
    constraints: [
      'Never modify immutable spine files under agent/services/brain/, agent/work/, agent/context/, or tests/.',
      'Keep every (organ, role) assembled prompt <= 24,000 characters.',
      'Use LF (\\n) line endings only and zero banned terminology in prompts/, skills/, and roles/.',
    ],
  };
}
