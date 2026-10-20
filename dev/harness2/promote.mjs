// dev/harness2/promote.mjs: Promote a winning Pareto candidate after Tier-1 and Tier-2 canary verification.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isNonRegression } from './selection.mjs';
import { validateCandidateWorkspace } from './validate.mjs';

function defaultExecGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

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
 * Materialize a promotion-ready winning candidate's `filePatches` onto `repoRoot`
 * (optionally checking out `branch` first) and run `validateCandidateWorkspace`.
 * Rolls back all touched files automatically if post-apply validation fails.
 *
 * @param {object} opts
 * @param {object} opts.candidate
 * @param {object} opts.readiness
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.branch]
 * @param {boolean} [opts.runTests]
 * @param {Function} [opts.execGit]
 * @param {Function} [opts.validate]
 */
export function applyPromotedCandidate(opts = {}) {
  const {
    candidate,
    readiness,
    repoRoot = process.cwd(),
    branch = null,
    runTests = false,
    execGit = defaultExecGit,
    validate = validateCandidateWorkspace,
  } = opts;

  if (!readiness?.ready) {
    return {
      applied: false,
      reason: 'Candidate is not ready for promotion',
      appliedPaths: [],
      branch: null,
    };
  }

  const patches = candidate?.filePatches || {};
  const relPaths = Object.keys(patches);
  if (relPaths.length === 0) {
    return {
      applied: false,
      reason: 'Candidate has no filePatches to apply',
      appliedPaths: [],
      branch: null,
    };
  }

  if (branch) {
    execGit(['checkout', '-B', branch], repoRoot);
  }

  const backups = new Map();
  for (const relPath of relPaths) {
    const absPath = path.join(repoRoot, relPath);
    backups.set(relPath, fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const normalized = String(patches[relPath]).replace(/\r\n/g, '\n');
    fs.writeFileSync(absPath, normalized, 'utf8');
  }

  const validation = validate({
    repoRoot,
    touchedPaths: relPaths,
    stage: candidate.stage || 'stage1',
    runTests: Boolean(runTests),
  });

  if (!validation.ok) {
    for (const [relPath, original] of backups.entries()) {
      const absPath = path.join(repoRoot, relPath);
      if (original === null) {
        fs.rmSync(absPath, { force: true });
      } else {
        fs.writeFileSync(absPath, original, 'utf8');
      }
    }
    return {
      applied: false,
      reason: `Post-apply validation failed: ${(validation.violations || []).join('; ')}`,
      appliedPaths: [],
      branch: branch || null,
      validation,
    };
  }

  return {
    applied: true,
    reason: 'Applied candidate filePatches and verified workspace',
    appliedPaths: relPaths,
    branch: branch || null,
    validation,
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

  if (readiness.application) {
    const app = readiness.application;
    lines.push(
      '',
      '## Applied Promotion',
      `- **Applied**: ${Boolean(app.applied)}`,
      ...(app.branch ? [`- **Branch**: \`${app.branch}\``] : []),
      `- **Materialized Files**: ${(app.appliedPaths || []).length > 0 ? app.appliedPaths.map((p) => `\`${p}\``).join(', ') : 'none'}`,
      ...(app.reason ? [`- **Detail**: ${app.reason}`] : []),
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
