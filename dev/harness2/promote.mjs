// dev/harness2/promote.mjs: Promote a winning Pareto candidate after Tier-1 and Tier-2 canary verification.
// A promotion's commit subject and pull request title start with the next version
// (agent/release/versions.mjs), so a squash merge leaves main's head a commit dev/release.mjs can release.
// No pull request opens without measured evidence that passes its verdict (evidence.mjs), and none
// whose prompt additions fail the lint (validate.mjs promptAdditionProblems); the body carries the
// evidence block.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isNewer, isVersion, parseVersion, versionFromText } from '../../agent/release/versions.mjs';
import { formatEvidenceMarkdown, judgeEvidence } from './evidence.mjs';
import { CAPABILITY_CREDO, isNonRegression } from './selection.mjs';
import { classifySurfacePath } from './surface.mjs';
import { addedLinesFromDiff, promptAdditionProblems, validateCandidateWorkspace } from './validate.mjs';

function defaultExecGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The checkout's branch, or null when it is detached or unknown. */
function currentBranch(execGit, repoRoot) {
  try {
    const name = String(execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) || '').trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

function defaultExecGh(args, cwd) {
  return execFileSync('gh', args, {
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
 * `ready` says the candidate is safe to apply. Whether it is worth promoting is the evidence's own
 * verdict (`evidence.verdict`, evidence.mjs), which `pushAndCreatePullRequest` requires.
 *
 * @param {object} opts
 * @param {object} opts.candidate
 * @param {object} opts.baselineScores
 * @param {object} [opts.tier2Result]
 * @param {boolean} [opts.requireTier2]
 * @param {object} [opts.validationResult]
 * @param {object} [opts.evidence]       buildPromotionEvidence's result
 * @param {object} [opts.evidenceRules]  stricter rules than DEFAULT_EVIDENCE_RULES
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

  const deltaCapability =
    baselineScores && typeof candidate.scores?.capability === 'number' && typeof baselineScores.capability === 'number'
      ? Number((candidate.scores.capability - baselineScores.capability).toFixed(4))
      : 0;

  return {
    ready: reasons.length === 0,
    reasons,
    credo: CAPABILITY_CREDO.name,
    evidence: opts.evidence ? { ...opts.evidence, verdict: judgeEvidence(opts.evidence, opts.evidenceRules) } : null,
    summary: {
      candidateId: candidate.id || 'candidate',
      lens: candidate.lens || null,
      credo: CAPABILITY_CREDO.name,
      deltaCapability,
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

  // The branch the checkout was on, which pushAndCreatePullRequest returns it to once the promotion
  // is committed: a checkout left on a promotion branch would be the next cycle's baseline, and the
  // lab's follow-main timer moves only a checkout on main.
  let returnTo = null;
  if (branch) {
    returnTo = currentBranch(execGit, repoRoot);
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
    ...(returnTo ? { returnTo } : {}),
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
    `- **Credo**: ${s.credo || CAPABILITY_CREDO.name} (capability overrides all other metrics; zero regression tolerated)`,
    `- **Lens**: ${s.lens || 'SYN'}`,
    `- **Touched Files**: ${(s.touchedPaths || []).length > 0 ? s.touchedPaths.map((p) => `\`${p}\``).join(', ') : 'none'}`,
    `- **Tier-1 Scores**: capability=${t1.capability ?? 0} (delta=${s.deltaCapability >= 0 ? `+${s.deltaCapability}` : (s.deltaCapability ?? 0)}), reliability=${t1.reliability ?? 0}, efficiency=${t1.efficiency ?? 0}, fitness=${t1.fitness ?? 0}`,
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

  if (readiness.pullRequest) {
    const pr = readiness.pullRequest;
    lines.push(
      '',
      '## Primary Repo Pull Request',
      `- **Pushed**: ${Boolean(pr.pushed)}`,
      `- **Branch**: \`${pr.branch || 'none'}\``,
      ...(pr.prUrl ? [`- **Pull Request URL**: ${pr.prUrl}`] : []),
      ...(pr.reason ? [`- **Detail**: ${pr.reason}`] : []),
    );
  }

  if (!readiness.ready && Array.isArray(readiness.reasons) && readiness.reasons.length > 0) {
    lines.push('', '## Blocking Reasons');
    for (const r of readiness.reasons) {
      lines.push(`- ${r}`);
    }
  }

  if (readiness.evidence) {
    lines.push('', formatEvidenceMarkdown(readiness.evidence, readiness.evidence.verdict));
  } else {
    lines.push('', '## Measured Evidence', '', '- None: this candidate was not measured against the baseline, so it is not promotable.');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The version a promotion carries: the next change of the day after every version already known.
 * The day is UTC, as on the repo's other versioned commits. A day after the newest version starts
 * counting at 1; the newest version's own day (or a later one, when this clock is behind) counts on
 * from it. Text that is not a version is ignored.
 *
 * @param {object} [p]
 * @param {Iterable<string>} [p.subjects] commit subjects on the base branch
 * @param {Iterable<string>} [p.tags]     tag names
 * @param {Date} [p.now]
 * @returns {string} `vYYYY.MM.DD.N.1`
 */
export function nextPromotionVersion({ subjects = [], tags = [], now = new Date() } = {}) {
  const known = [
    ...[...subjects].map(versionFromText),
    ...[...tags].map((t) => String(t ?? '').trim()).filter(isVersion),
  ].filter(Boolean);
  const latest = known.reduce((a, b) => (a === null || isNewer(b, a) ? b : a), null);
  const today = `v${now.toISOString().slice(0, 10).replaceAll('-', '.')}.1.1`;
  if (latest === null || isNewer(today, latest)) return today;
  const [year, month, day, index] = parseVersion(latest).parts;
  const pad = (n) => String(n).padStart(2, '0');
  return `v${year}.${pad(month)}.${pad(day)}.${index + 1}.1`;
}

/**
 * The commit subjects of `<remote>/<baseBranch>` (of HEAD when that ref is missing, as in a clone
 * with no remote) and the tag names, as `nextPromotionVersion` takes them. A read git refuses
 * counts as nothing read.
 */
function readVersionSources({ execGit, repoRoot, remote, baseBranch }) {
  const lines = (args) => {
    try {
      return String(execGit(args, repoRoot) ?? '').split(/\r?\n/);
    } catch {
      return null;
    }
  };
  const subjects = lines(['log', '--format=%s', `${remote}/${baseBranch}`]) ?? lines(['log', '--format=%s', 'HEAD']) ?? [];
  const tags = lines(['tag', '--list']) ?? [];
  return { subjects, tags };
}

/** How a promotion's pull request must be merged for main to stay releasable. */
export function promotionMergeNote(version) {
  return [
    '## Merging',
    `Merge with **Squash and merge**, keeping the title as the commit subject. \`${version}: ...\` then becomes`,
    "main's head, which `dev/release.mjs` can release. A merge commit's subject carries no version, so a",
    'release cannot be cut from it.',
  ].join('\n');
}

/**
 * Commit applied candidate changes on `branch`, push to `remote` (`origin`),
 * and open a GitHub Pull Request (`gh pr create`) against `baseBranch` (`main`)
 * with the full Frontier Model Committee + Capability-First Credo promotion report.
 * It fetches `baseBranch` and the tags first, so the version in the commit subject and the title is
 * newer than every one there; a dry run reads the local refs and fetches nothing.
 * It refuses, before anything else and in a dry run too, unless `readiness.evidence.verdict` passed
 * and the lines the candidate adds to product prompts pass `promptAdditionProblems`.
 *
 * @param {object} opts
 * @param {object} opts.candidate
 * @param {object} opts.readiness
 * @param {object} [opts.application]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.branch]
 * @param {string} [opts.baseBranch]
 * @param {string} [opts.remote]
 * @param {boolean} [opts.dryRun]
 * @param {Function} [opts.execGit]
 * @param {Function} [opts.execGh]
 * @param {Date} [opts.now]
 */
export function pushAndCreatePullRequest(opts = {}) {
  const {
    candidate,
    readiness,
    application = null,
    repoRoot = process.cwd(),
    baseBranch = 'main',
    remote = 'origin',
    dryRun = false,
    execGit = defaultExecGit,
    execGh = defaultExecGh,
    now = new Date(),
  } = opts;

  if (!readiness?.ready) {
    return {
      pushed: false,
      branch: null,
      prUrl: null,
      reason: 'Candidate is not ready for promotion',
    };
  }

  const branch = opts.branch || application?.branch || `h2/promote-${candidate?.id || 'winner'}`;
  const touched = application?.appliedPaths?.length
    ? application.appliedPaths
    : candidate?.touchedPaths || Object.keys(candidate?.filePatches || {});

  // The promotion gate, before anything is fetched, committed or pushed: measured evidence whose
  // verdict passed, and additions to product prompts that the lint accepts.
  const refused = (why) => ({ pushed: false, branch: null, prUrl: null, reason: `Not promoted: ${why}` });
  const verdict = readiness.evidence?.verdict;
  if (!verdict?.ok) {
    return refused(verdict ? verdict.problems.join('; ') : 'no measured evidence (evaluatePromotionReadiness takes it from buildPromotionEvidence)');
  }
  let added = {};
  if (touched.length > 0) {
    try {
      added = addedLinesFromDiff(execGit(['diff', '--unified=0', '--no-color', 'HEAD', '--', ...touched], repoRoot));
    } catch (err) {
      return refused(`git could not show the candidate's changes (${err.message})`);
    }
  }
  const lint = promptAdditionProblems(added);
  if (lint.length > 0) return refused(lint.join('; '));

  const delta = readiness.evidence.capability?.delta ?? 0;
  const summary = `paraclete-h2(${candidate?.lens || 'SYN'}): promote ${candidate?.id || 'winner'} (ΔS_cap=${delta >= 0 ? `+${delta}` : delta}, n=${readiness.evidence.trials?.candidate ?? 0})`;
  const versionedPromotion = () => {
    const version = nextPromotionVersion({ ...readVersionSources({ execGit, repoRoot, remote, baseBranch }), now });
    return {
      version,
      title: `${version}: ${summary}`,
      body: `${formatPromotionReport(readiness)}\n${promotionMergeNote(version)}\n`,
    };
  };

  if (dryRun) {
    const { version, title } = versionedPromotion();
    return {
      pushed: false,
      dryRun: true,
      branch,
      baseBranch,
      remote,
      version,
      title,
      touchedPaths: touched,
      prUrl: `https://github.com/example/paraclete/pull/dry-run-${branch}`,
      reason: 'Dry-run mode: git push and gh pr create skipped',
    };
  }

  let promotion = { version: null, title: summary };
  const returnTo = application?.returnTo || currentBranch(execGit, repoRoot);
  let committed = false;
  try {
    execGit(['fetch', '--quiet', '--tags', remote, baseBranch], repoRoot);
    promotion = versionedPromotion();
    const { version, title, body } = promotion;
    execGit(['checkout', '-B', branch], repoRoot);
    if (touched.length > 0) {
      execGit(['add', '--', ...touched], repoRoot);
    }
    execGit(['commit', '--allow-empty', '-m', title], repoRoot);
    committed = true;
    try {
      execGit(['push', '-u', remote, branch], repoRoot);
    } catch {
      execGit(['push', '--force-with-lease', '-u', remote, branch], repoRoot);
    }
    let prUrl = null;
    let created = true;
    try {
      prUrl = execGh(
        ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body],
        repoRoot,
      );
    } catch {
      created = false;
      execGh(['pr', 'edit', branch, '--title', title, '--body', body], repoRoot);
      prUrl = execGh(['pr', 'view', branch, '--json', 'url', '--jq', '.url'], repoRoot);
    }
    return {
      pushed: true,
      created,
      updated: !created,
      branch,
      baseBranch,
      remote,
      version,
      title,
      prUrl: String(prUrl || '').trim(),
      reason: created
        ? 'Committed, pushed branch, and opened GitHub Pull Request'
        : 'Committed, force-with-lease pushed branch, and updated existing GitHub Pull Request',
    };
  } catch (err) {
    return {
      pushed: false,
      branch,
      baseBranch,
      remote,
      version: promotion.version,
      title: promotion.title,
      prUrl: null,
      reason: `Failed to push or create PR: ${err.message}`,
    };
  } finally {
    // Committed, the change lives on its branch: the checkout goes back where it was. Not committed,
    // the change is still in the working tree, and switching could carry or lose it, so it stays.
    if (committed && returnTo && returnTo !== branch) {
      try {
        execGit(['checkout', returnTo], repoRoot);
      } catch {
        // the result already says what happened to the promotion; the checkout stays on its branch
      }
    }
  }
}

function clampNumber(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function parseJsonObject(input) {
  if (!input) return null;
  if (typeof input === 'object') return structuredClone(input);
  return JSON.parse(String(input));
}

/**
 * Reconcile two concurrent `config/contracts.json` states (`baseRaw` on `main` vs `headRaw`
 * on a promotion PR branch, optionally with 3-way `ancestorRaw` merge-base) while preserving
 * all immutable keys from `baseRaw` and clamping numeric tunables strictly within Tier-1 bounds.
 *
 * @param {string | object} baseRaw
 * @param {string | object} headRaw
 * @param {string | object | null} [ancestorRaw]
 * @param {object} [opts]
 * @param {'balanced' | 'head' | 'base' | 'tighter'} [opts.strategy]
 */
export function mergeContractsJson(baseRaw, headRaw, ancestorRaw = null, opts = {}) {
  const strategy = opts.strategy || 'balanced';
  const baseObj = parseJsonObject(baseRaw) || {};
  const headObj = parseJsonObject(headRaw) || {};
  const ancObj = parseJsonObject(ancestorRaw);
  const merged = structuredClone(baseObj);
  const reconciledKeys = [];

  if (merged.vertex || headObj.vertex) {
    merged.vertex = { ...(merged.vertex || {}) };
    const baseCache = merged.vertex.gemini_explicit_cache;
    const headCache = headObj.vertex?.gemini_explicit_cache;
    if (typeof baseCache === 'boolean' || typeof headCache === 'boolean') {
      const nextCache = Boolean(baseCache || headCache);
      if (nextCache !== baseCache || nextCache !== headCache) {
        reconciledKeys.push('vertex.gemini_explicit_cache');
      }
      merged.vertex.gemini_explicit_cache = nextCache;
    }
  }

  if (merged.organs || headObj.organs) {
    merged.organs = { ...(merged.organs || {}) };
    const baseSteps = Number(baseObj.organs?.max_steps);
    const headSteps = Number(headObj.organs?.max_steps);
    const ancSteps = Number(ancObj?.organs?.max_steps);
    if (Number.isFinite(baseSteps) && Number.isFinite(headSteps)) {
      let chosen = baseSteps;
      if (baseSteps === headSteps) {
        chosen = baseSteps;
      } else if (Number.isFinite(ancSteps) && baseSteps === ancSteps && headSteps !== ancSteps) {
        chosen = headSteps;
      } else if (Number.isFinite(ancSteps) && headSteps === ancSteps && baseSteps !== ancSteps) {
        chosen = baseSteps;
      } else if (strategy === 'head') {
        chosen = headSteps;
      } else if (strategy === 'base') {
        chosen = baseSteps;
      } else if (strategy === 'tighter') {
        chosen = Math.min(baseSteps, headSteps);
      } else {
        chosen = Math.round((baseSteps + headSteps) / 2);
      }
      merged.organs.max_steps = clampNumber(chosen, 15, 40);
      if (baseSteps !== headSteps) {
        reconciledKeys.push('organs.max_steps');
      }
    }
  }

  if (merged.brain || headObj.brain) {
    merged.brain = { ...(merged.brain || {}) };
    const basePreview = Number(baseObj.brain?.result_preview_chars);
    const headPreview = Number(headObj.brain?.result_preview_chars);
    const ancPreview = Number(ancObj?.brain?.result_preview_chars);
    if (Number.isFinite(basePreview) && Number.isFinite(headPreview)) {
      let chosen = basePreview;
      if (basePreview === headPreview) {
        chosen = basePreview;
      } else if (Number.isFinite(ancPreview) && basePreview === ancPreview && headPreview !== ancPreview) {
        chosen = headPreview;
      } else if (Number.isFinite(ancPreview) && headPreview === ancPreview && basePreview !== ancPreview) {
        chosen = basePreview;
      } else if (strategy === 'head') {
        chosen = headPreview;
      } else if (strategy === 'base') {
        chosen = basePreview;
      } else if (strategy === 'tighter') {
        chosen = Math.min(basePreview, headPreview);
      } else {
        chosen = Math.round((basePreview + headPreview) / 2 / 50) * 50;
      }
      merged.brain.result_preview_chars = clampNumber(chosen, 1500, 6000);
      if (basePreview !== headPreview) {
        reconciledKeys.push('brain.result_preview_chars');
      }
    }
  }

  return {
    mergedObject: merged,
    mergedText: `${JSON.stringify(merged, null, 2)}\n`,
    reconciledKeys,
  };
}

function splitMarkdownSections(mdText) {
  const normalized = String(mdText || '').replace(/\r\n/g, '\n').trimEnd();
  const lines = normalized.split('\n');
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current.heading !== null || current.lines.length > 0) {
        sections.push(current);
      }
      current = { heading: line.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading !== null || current.lines.length > 0) {
    sections.push(current);
  }
  return sections;
}

function mergeSectionLines(baseLines, headLines) {
  const seenNonEmpty = new Set();
  const footerLines = [];
  const bodyLines = [];

  const isFooterGuard = (line) => /^Never mutate immutable spine modules\./i.test(line.trim());

  for (const rawLine of [...baseLines, ...headLines]) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] !== '') {
        bodyLines.push('');
      }
      continue;
    }
    if (isFooterGuard(trimmed)) {
      if (!footerLines.includes(rawLine)) {
        footerLines.push(rawLine);
      }
      continue;
    }
    if (!seenNonEmpty.has(trimmed)) {
      seenNonEmpty.add(trimmed);
      bodyLines.push(rawLine);
    }
  }

  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }

  return [...bodyLines, ...footerLines];
}

/**
 * Reconcile two concurrent Markdown prompt / role overlay versions (`baseMd` vs `headMd`,
 * optionally with `ancestorMd`) by preserving section structure, deduplicating bullet clauses,
 * and enforcing the 24,000-character prompt budget.
 *
 * @param {string} baseMd
 * @param {string} headMd
 * @param {string | null} [ancestorMd]
 */
export function mergePromptMarkdown(baseMd, headMd, ancestorMd = null) {
  const normBase = String(baseMd || '').replace(/\r\n/g, '\n');
  const normHead = String(headMd || '').replace(/\r\n/g, '\n');
  const normAnc = ancestorMd !== null && ancestorMd !== undefined ? String(ancestorMd).replace(/\r\n/g, '\n') : null;

  if (normBase === normHead) {
    return { mergedText: `${normBase.trimEnd()}\n`, charCount: normBase.trimEnd().length + 1 };
  }
  if (normAnc !== null && normBase === normAnc) {
    return { mergedText: `${normHead.trimEnd()}\n`, charCount: normHead.trimEnd().length + 1 };
  }
  if (normAnc !== null && normHead === normAnc) {
    return { mergedText: `${normBase.trimEnd()}\n`, charCount: normBase.trimEnd().length + 1 };
  }

  const baseSections = splitMarkdownSections(normBase);
  const headSections = splitMarkdownSections(normHead);
  const mergedSections = baseSections.map((s) => ({ heading: s.heading, lines: [...s.lines] }));

  for (const hSec of headSections) {
    const matchIdx = mergedSections.findIndex((bSec) => bSec.heading === hSec.heading);
    if (matchIdx === -1) {
      mergedSections.push({ heading: hSec.heading, lines: [...hSec.lines] });
    } else {
      mergedSections[matchIdx].lines = mergeSectionLines(mergedSections[matchIdx].lines, hSec.lines);
    }
  }

  const renderedBlocks = mergedSections.map((sec) => {
    const body = sec.lines.join('\n').trimEnd();
    if (sec.heading) {
      return body ? `${sec.heading}\n${body}` : sec.heading;
    }
    return body;
  });

  const mergedText = `${renderedBlocks.filter(Boolean).join('\n\n').trimEnd()}\n`;
  return {
    mergedText,
    charCount: mergedText.length,
  };
}

/**
 * Resolve a merge conflict on a single Paraclete-H² file path under the Capability-First Credo:
 * - Rejects any path outside the mutable surface (`c1..c7`): the immutable spine, a skill's command
 *   code, and a role's `role.json`.
 * - Uses `mergeContractsJson` for `config/contracts.json`.
 * - Uses `mergePromptMarkdown` for Markdown prompt / skill / role overlay files.
 * - Uses top-level JSON key reconciliation for role/skill metadata `.json` files.
 *
 * @param {object} opts
 * @param {string} opts.relPath
 * @param {string} opts.baseContent
 * @param {string} opts.headContent
 * @param {string | null} [opts.ancestorContent]
 * @param {'stage1' | 'stage2'} [opts.stage]
 * @param {'balanced' | 'head' | 'base' | 'tighter'} [opts.strategy]
 */
export function resolveHarnessMergeConflict(opts = {}) {
  const {
    relPath,
    baseContent = '',
    headContent = '',
    ancestorContent = null,
    stage = 'stage2',
    strategy = 'balanced',
  } = opts;

  const cleanPath = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const surfaceCheck = classifySurfacePath(cleanPath, { stage, allowNewRoles: true });
  if (!surfaceCheck.allowed) {
    return {
      resolved: false,
      relPath: cleanPath,
      component: surfaceCheck.component || null,
      reason: `Refusing to resolve conflict on immutable or disallowed path '${cleanPath}': ${surfaceCheck.reason}`,
    };
  }

  if (cleanPath === 'config/contracts.json') {
    const res = mergeContractsJson(baseContent, headContent, ancestorContent, { strategy });
    return {
      resolved: true,
      relPath: cleanPath,
      component: surfaceCheck.component,
      mergedText: res.mergedText,
      reconciledKeys: res.reconciledKeys,
    };
  }

  if (cleanPath.endsWith('.md')) {
    const res = mergePromptMarkdown(baseContent, headContent, ancestorContent);
    if (res.charCount > 24000) {
      return {
        resolved: false,
        relPath: cleanPath,
        component: surfaceCheck.component,
        reason: `Merged prompt '${cleanPath}' exceeds 24,000-character budget (${res.charCount} chars)`,
      };
    }
    return {
      resolved: true,
      relPath: cleanPath,
      component: surfaceCheck.component,
      mergedText: res.mergedText,
      charCount: res.charCount,
    };
  }

  if (cleanPath.endsWith('.json')) {
    try {
      const baseObj = parseJsonObject(baseContent) || {};
      const headObj = parseJsonObject(headContent) || {};
      const mergedObj = { ...baseObj, ...headObj };
      return {
        resolved: true,
        relPath: cleanPath,
        component: surfaceCheck.component,
        mergedText: `${JSON.stringify(mergedObj, null, 2)}\n`,
      };
    } catch (err) {
      return {
        resolved: false,
        relPath: cleanPath,
        component: surfaceCheck.component,
        reason: `Failed to parse JSON for '${cleanPath}': ${err.message}`,
      };
    }
  }

  return {
    resolved: false,
    relPath: cleanPath,
    component: surfaceCheck.component,
    reason: `No merge rule for '${cleanPath}': the surface holds only contracts.json, Markdown and JSON files`,
  };
}
