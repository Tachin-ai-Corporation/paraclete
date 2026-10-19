// dev/harness2/promote.mjs: Promote a winning Pareto candidate after Tier-1 and Tier-2 canary verification.

import { isNonRegression } from './selection.mjs';
import { validateCandidateWorkspace } from './validate.mjs';

/**
 * Verify whether a winning candidate is eligible for promotion (PR / release cut)
 * by checking:
 * 1. Candidate workspace passes `validateCandidateWorkspace`.
 * 2. Tier-1 scores satisfy non-regression guards against baseline.
 * 3. If Tier-2 canary results are required/provided, canary smoke passed and
 *    Tier-2 scores satisfy non-regression guards.
 *
 * @param {object} opts
 * @param {object} opts.candidate
 * @param {object} opts.baselineScores
 * @param {object} [opts.tier2Result]
 * @param {boolean} [opts.requireTier2]
 * @param {object} [opts.validationResult]
 */
export function evaluatePromotionReadiness(opts = {}) {
  const reasons = [];
  const { candidate, baselineScores, tier2Result = null, requireTier2 = false } = opts;

  if (!candidate || !candidate.scores) {
    return { ready: false, reasons: ['Missing candidate or candidate scores'] };
  }

  const validation =
    opts.validationResult ||
    validateCandidateWorkspace({
      touchedPaths: candidate.touchedPaths || [],
      stage: candidate.stage || 'stage1',
      runTests: false,
    });

  if (!validation.ok) {
    reasons.push(...validation.violations.map((v) => `validation: ${v}`));
  }

  if (baselineScores && !isNonRegression(candidate.scores, baselineScores)) {
    reasons.push('Tier-1 candidate scores violate capability or reliability non-regression guard');
  }

  if (requireTier2 && !tier2Result) {
    reasons.push('Tier-2 canary evaluation is required before promotion');
  }

  if (tier2Result) {
    if (!tier2Result.smokePassed) {
      reasons.push(`Tier-2 canary smoke check failed on ${tier2Result.canaryAgent || 'canary'}`);
    }
    if (baselineScores && tier2Result.summary && !isNonRegression(tier2Result.summary, baselineScores)) {
      reasons.push('Tier-2 canary scores violate non-regression guard');
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    summary: {
      candidateId: candidate.id || 'candidate',
      lens: candidate.lens || null,
      touchedPaths: candidate.touchedPaths || [],
      tier1Scores: candidate.scores,
      tier2Scores: tier2Result?.summary || null,
    },
  };
}

/**
 * Format a concise Markdown promotion report suitable for a pull request description
 * or operator console output.
 *
 * @param {object} readiness  Output of `evaluatePromotionReadiness()`
 * @returns {string}
 */
export function formatPromotionReport(readiness) {
  const s = readiness.summary || {};
  const t1 = s.tier1Scores || {};
  const lines = [
    `# Paraclete-H² Candidate Promotion Report (${s.candidateId || 'unknown'})`,
    '',
    `- **Status**: ${readiness.ready ? 'READY FOR PROMOTION' : 'BLOCKED'}`,
    `- **Lens**: ${s.lens || 'SYN'}`,
    `- **Touched Files**: ${(s.touchedPaths || []).length > 0 ? s.touchedPaths.map((p) => `\`${p}\``).join(', ') : 'none'}`,
    `- **Tier-1 Scores**: capability=${t1.capability ?? 0}, reliability=${t1.reliability ?? 0}, efficiency=${t1.efficiency ?? 0}, fitness=${t1.fitness ?? 0}`,
  ];

  if (s.tier2Scores) {
    const t2 = s.tier2Scores;
    lines.push(
      `- **Tier-2 Canary Scores**: capability=${t2.capability ?? 0}, reliability=${t2.reliability ?? 0}, efficiency=${t2.efficiency ?? 0}, fitness=${t2.fitness ?? 0}`,
    );
  }

  if (!readiness.ready && Array.isArray(readiness.reasons) && readiness.reasons.length > 0) {
    lines.push('', '## Blocking Reasons');
    for (const r of readiness.reasons) {
      lines.push(`- ${r}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
