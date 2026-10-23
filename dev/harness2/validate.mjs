// dev/harness2/validate.mjs: Fast structural and contract validation gate for Loop A candidate mutations,
// and the lint on the text a promotion adds to product prompts (promptAdditionProblems, which
// promote.mjs runs on the candidate's diff before it opens a pull request).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadOrganPrompt } from '../../agent/gateway/organs.mjs';
import {
  ORGANS_ALLOWLIST,
  DEFAULT_ROLES,
  ORGAN_PROMPT_MAX_CHARS,
  CONTRACTS_HARD_CEILINGS,
  classifySurfacePath,
  isContractKeyTunable,
} from './surface.mjs';

const VALID_EFFORT_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function readByPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

function flattenObjectPaths(obj, prefix = '') {
  const out = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenObjectPaths(v, next));
    } else {
      out.push([next, v]);
    }
  }
  return out;
}

/**
 * Validate a list of mutated repo-relative file paths against the Paraclete
 * 8-component surface (`c1..c8`) and immutable spine boundaries.
 *
 * @param {string[]} touchedPaths
 * @param {object} [opts]
 * @param {string} [opts.stage]
 * @param {string[]} [opts.allowedComponents]
 * @returns {{ ok: boolean, violations: string[], classifications: object[] }}
 */
export function validateTouchedPaths(touchedPaths = [], opts = {}) {
  const violations = [];
  const classifications = [];
  const allowedSet = Array.isArray(opts.allowedComponents) ? new Set(opts.allowedComponents) : null;

  for (const relPath of touchedPaths) {
    const info = classifySurfacePath(relPath, {
      stage: opts.stage,
      allowedRoles: opts.allowedRoles,
      allowNewRoles: opts.allowNewRoles,
    });
    classifications.push({ path: relPath, ...info });
    if (!info.allowed) {
      violations.push(`${relPath}: ${info.reason}`);
      continue;
    }
    if (allowedSet && info.component && !allowedSet.has(info.component)) {
      violations.push(`${relPath}: component ${info.component} is outside allowed lens scope [${[...allowedSet].join(', ')}]`);
    }
  }

  return { ok: violations.length === 0, violations, classifications };
}

/**
 * Validate `config/contracts.json` against hard safety ceilings and optionally
 * check that only tunable contract paths changed relative to a baseline object.
 *
 * @param {object} candidateContracts
 * @param {object} [baselineContracts]
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function validateContractsMutation(candidateContracts, baselineContracts = null) {
  const violations = [];
  if (!candidateContracts || typeof candidateContracts !== 'object') {
    return { ok: false, violations: ['contracts.json must be a JSON object'] };
  }

  for (const [dotPath, bounds] of Object.entries(CONTRACTS_HARD_CEILINGS)) {
    const val = readByPath(candidateContracts, dotPath);
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      violations.push(`contracts.${dotPath} must be a finite number (got ${String(val)})`);
      continue;
    }
    if (val < bounds.min || val > bounds.max) {
      violations.push(`contracts.${dotPath}=${val} violates bounds [${bounds.min}, ${bounds.max}]`);
    }
  }

  for (const organId of ORGANS_ALLOWLIST) {
    const effort = candidateContracts?.organs?.[organId]?.effortLevel;
    if (effort !== undefined && !VALID_EFFORT_LEVELS.has(effort)) {
      violations.push(`contracts.organs.${organId}.effortLevel=${String(effort)} is not a valid Gemini thinking level`);
    }
  }

  if (baselineContracts && typeof baselineContracts === 'object') {
    const candidateLeaves = new Map(flattenObjectPaths(candidateContracts));
    const baselineLeaves = new Map(flattenObjectPaths(baselineContracts));
    const allKeys = new Set([...candidateLeaves.keys(), ...baselineLeaves.keys()]);
    for (const key of allKeys) {
      const a = candidateLeaves.get(key);
      const b = baselineLeaves.get(key);
      if (JSON.stringify(a) !== JSON.stringify(b) && !isContractKeyTunable(key)) {
        violations.push(`contracts.${key} was modified but is not on the tunable allowlist`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Validate that every `(organ, role)` assembled prompt stays within the
 * 24,000-character ceiling enforced by `tests/content/packages.test.mjs`.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string[]} [opts.roles]
 * @param {string[]} [opts.organs]
 * @param {(path: string) => string} [opts.readText]
 * @returns {{ ok: boolean, violations: string[], measurements: Array<{ organ: string, role: string, chars: number }> }}
 */
export function validatePromptBudgets(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const roles = opts.roles || DEFAULT_ROLES;
  const organs = opts.organs || ORGANS_ALLOWLIST;
  const readText =
    opts.readText ||
    ((p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
      }
    });

  const violations = [];
  const measurements = [];
  const promptsDir = join(repoRoot, 'prompts');

  for (const role of roles) {
    const rolePromptsDir = join(repoRoot, 'roles', role, 'prompts');
    for (const organ of organs) {
      const assembled = loadOrganPrompt(organ, { promptsDir, rolePromptsDir, readText });
      const chars = assembled.length;
      measurements.push({ organ, role, chars });
      if (chars === 0) {
        violations.push(`assembled prompt for (${organ}, ${role}) is empty`);
      } else if (chars > ORGAN_PROMPT_MAX_CHARS) {
        violations.push(
          `assembled prompt for (${organ}, ${role}) is ${chars} chars (max ${ORGAN_PROMPT_MAX_CHARS})`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations, measurements };
}

/**
 * Run the fast structural and content test suites (`tests/repo/*.test.mjs` and
 * `tests/content/*.test.mjs`) as a hard gate before any benchmark rollout.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {typeof spawnSync} [opts.spawn]
 * @returns {{ ok: boolean, status: number, stdout: string, stderr: string }}
 */
export function runFastTestGate(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const spawnFn = opts.spawn || spawnSync;
  const testFiles = [
    'tests/repo/structure.test.mjs',
    'tests/repo/boundaries.test.mjs',
    'tests/repo/hygiene.test.mjs',
    'tests/repo/docs.test.mjs',
    'tests/content/packages.test.mjs',
    'tests/content/content-hygiene.test.mjs',
    'tests/content/command-flags.test.mjs',
  ];

  const res = spawnFn(process.execPath, ['--test', ...testFiles], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });

  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

/**
 * Run the complete validation gate on a candidate workspace mutation.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string[]} [opts.touchedPaths]
 * @param {string} [opts.stage]
 * @param {string[]} [opts.allowedComponents]
 * @param {object} [opts.baselineContracts]
 * @param {boolean} [opts.runTests]
 * @param {object} [opts.deps]
 */
export function validateCandidateWorkspace(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const readText = opts.deps?.readText || ((p) => readFileSync(p, 'utf8'));
  const violations = [];

  const pathCheck = validateTouchedPaths(opts.touchedPaths || [], {
    stage: opts.stage,
    allowedRoles: opts.allowedRoles,
    allowNewRoles: opts.allowNewRoles,
    allowedComponents: opts.allowedComponents,
  });
  if (!pathCheck.ok) violations.push(...pathCheck.violations);

  let contractsCheck = { ok: true, violations: [] };
  try {
    const raw = readText(join(repoRoot, 'config', 'contracts.json'));
    const candidateContracts = JSON.parse(raw);
    contractsCheck = validateContractsMutation(candidateContracts, opts.baselineContracts || null);
    if (!contractsCheck.ok) violations.push(...contractsCheck.violations);
  } catch (err) {
    contractsCheck = { ok: false, violations: [`Failed to parse config/contracts.json: ${err.message}`] };
    violations.push(...contractsCheck.violations);
  }

  const promptCheck = validatePromptBudgets({ repoRoot, readText: opts.deps?.readText });
  if (!promptCheck.ok) violations.push(...promptCheck.violations);

  let testGate = { ok: true, status: 0, stdout: '', stderr: '' };
  if (opts.runTests !== false && violations.length === 0) {
    testGate = runFastTestGate({ repoRoot, spawn: opts.deps?.spawn });
    if (!testGate.ok) {
      violations.push(`Fast test gate failed (exit ${testGate.status})`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    pathCheck,
    contractsCheck,
    promptCheck,
    testGate,
  };
}

/**
 * The prompts every instance's agent reads: base organ prompts and role organ prompt appends, except
 * the development role paraclete-h2's own, which is about the harness.
 */
const PRODUCT_PROMPT = /^(prompts\/[^/]+\.md|roles\/(?!paraclete-h2\/)[^/]+\/prompts\/[^/]+\.md)$/;

/**
 * Words that mean something only inside the harness. The agent reading a product prompt has no idea
 * what they are, so an added line that uses one is the harness writing about itself.
 */
export const HARNESS_VOCABULARY = Object.freeze([
  /immutable spine/i,
  /\bTier-[12]\b/,
  /ΔS/,
  /\bc[1-8]_[a-z_]+\b/,
  /\bc1\s*\.\.\s*c8\b/,
  /Capability-First Credo/i,
  /mutable surface/i,
  /\bharness2\b/i,
]);

/**
 * The lines each file gains, from `git diff --unified=0` output.
 *
 * @param {string} diffText
 * @returns {Record<string, string[]>}
 */
export function addedLinesFromDiff(diffText) {
  const added = {};
  let file = null;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      file = header[1] === '/dev/null' ? null : header[1];
      if (file) added[file] = added[file] || [];
    } else if (file && line.startsWith('+')) {
      added[file].push(line.slice(1));
    }
  }
  return added;
}

/**
 * What is wrong with the text a candidate adds to product prompts: harness vocabulary, or one block
 * of two or more lines added identically to several prompts (one organ's or role's rule pasted
 * everywhere, rather than a change written for each). Only added lines count, so text already in a
 * prompt is never held against a new change.
 *
 * @param {Record<string, string[]>} addedByPath  addedLinesFromDiff's result
 * @returns {string[]}
 */
export function promptAdditionProblems(addedByPath = {}) {
  const problems = [];
  const blocks = new Map();
  for (const [path, lines] of Object.entries(addedByPath)) {
    if (!PRODUCT_PROMPT.test(path)) continue;
    for (const line of lines) {
      const word = HARNESS_VOCABULARY.find((re) => re.test(line));
      if (word) problems.push(`${path} adds harness vocabulary the agent has no meaning for (${word.exec(line)[0]}): ${line.trim()}`);
    }
    const text = lines.map((l) => l.trim()).filter(Boolean);
    if (text.length >= 2) {
      const key = text.join('\n');
      blocks.set(key, [...(blocks.get(key) || []), path]);
    }
  }
  for (const paths of blocks.values()) {
    if (paths.length > 1) problems.push(`the same added block appears in ${paths.join(', ')}: write each prompt's change for that organ or role`);
  }
  return problems;
}
