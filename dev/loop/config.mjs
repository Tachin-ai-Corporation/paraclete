// dev/loop/config.mjs: the self-improvement loop's fixed settings, in one place: its budget and caps,
// which paths a proposal may change, which of them change the agent's behaviour (and so must be
// measured), which are code (and so must come with a new test), and where a developer's own proposer
// settings live. The loop's own runner and every
// path that judges a change (the referee) are off limits to a proposal: only a person changes them.
//
// It reads nothing but the optional local settings file, and decides nothing itself: cycle.mjs applies
// these rules. Called by cycle.mjs, proposer.mjs and timer.mjs.

import fs from 'node:fs';
import path from 'node:path';

/** The loop's defaults. A cycle takes one issue; a day takes at most `maxCyclesPerDay` cycles. */
export const LOOP_DEFAULTS = Object.freeze({
  /** The label on the issues the loop works on. */
  label: 'loop',
  /** Every branch the loop pushes starts with this; its pull requests come from such branches only. */
  branchPrefix: 'loop/',
  /** Cycles a day, counted from the cycle log. */
  maxCyclesPerDay: 4,
  /** An issue the loop tried and failed is left alone for this long before it is tried again. */
  retryAfterHours: 24,
  /** The proposer's budget for one cycle, passed to its command (proposer.mjs). */
  proposer: Object.freeze({ wallMinutes: 45, maxTurns: 150, maxTokens: 4_000_000 }),
  /** How many times a change that fails the suite goes back to the proposer, with the failing tests,
   * before the cycle refuses it. Each round is a proposer run within the proposer's budget. */
  repairRounds: 2,
  /** The reviewer's budget for one change, and how much of the diff its brief carries (reviewer.mjs). */
  reviewer: Object.freeze({ wallMinutes: 15, maxTurns: 60, maxTokens: 2_000_000, maxDiffChars: 80_000 }),
  /** The suite every change must pass, and how long it may take. */
  testCommand: Object.freeze(['npm', 'test']),
  testTimeoutMinutes: 40,
  /** A behaviour change is measured on both sides with this many runs of every task, within this cap. */
  measure: Object.freeze({ trials: 3, maxRollouts: 120 }),
  /** The planner (planner.mjs) opens an issue only while fewer loop issues than this are open. */
  planner: Object.freeze({ maxOpen: 2, wallMinutes: 15, maxTurns: 60, maxTokens: 2_000_000 }),
  /** After this many refused attempts on one issue the loop gives it up: `loop` becomes `loop-stuck`. */
  maxAttempts: 6,
  /** The loop reverts a merge of its own that broke main (sentinel.mjs); this many reverts within a day
   * pause its cycles. */
  maxRevertsPerDay: 2,
  /** Releasing main once the loop's merges have run healthy on the lab (releaser.mjs): off unless the
   * lab driver's local settings turn it on; the lab must run the head this long, and releases keep
   * this far apart. */
  release: Object.freeze({ enabled: false, soakHours: 2, minHoursBetween: 20 }),
  /** The loop's merger (merger.mjs) merges at most this many loop pull requests a day (UTC). */
  merge: Object.freeze({ maxPerDay: 3 }),
});

/** Developer-local settings: which proposer command to run (never committed: `.local/` is ignored). */
export const LOCAL_SETTINGS = '.local/loop.json';

const posix = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * The referee: what judges a change, and the loop itself. A proposal that changes any of these is
 * refused; a person changes them. Patterns are repo-relative.
 */
export const REFEREE_PATHS = Object.freeze([
  /^dev\/loop\//,
  /^dev\/harness2\/(evidence|evidence-check|calibration|model-suite|model-runs|merge|pause|health|surface|validate)\.mjs$/,
  /^dev\/release(-check)?\.mjs$/,
  /^\.github\//,
  /^install\//,
  /^migrations\//,
  /^roles\/[^/]+\/role\.json$/,
  /^config\/contracts\.mjs$/,
  /^docs\/canon\//,
  /^(DEVELOPING|CLAUDE|AGENTS)\.md$/,
  /(^|\/)package(-lock)?\.json$/,
]);

/** Never part of a proposal, whatever else it changes. */
const FORBIDDEN_PATHS = Object.freeze([/^\.local\//, /(^|\/)\.env/, /\.(pem|key)$/, /credentials.*\.json$/]);

/**
 * What a running agent reads on a mission: a change to any of these changes how it behaves, so it is
 * measured. Only what a measured run loads counts (dev/harness2/model-runs.mjs: the gateway, the brain
 * and what they import, the commands the motor runs): the control, ears and mouth services never run
 * there, so measuring a change to them takes hours and shows nothing; their tests judge them.
 */
const BEHAVIOUR_PATHS = Object.freeze([
  /^prompts\//,
  /^config\/contracts\.json$/,
  /^agent\/(?!services\/(control|ears|mouth)\/)/,
  /^skills\//,
  /^roles\/[^/]+\/(?!role\.json$)/,
]);

/**
 * Why a change to one path is refused, or null when it may be part of a proposal. An existing test may
 * not be changed or removed (the loop may add tests, never weaken the ones it is judged by).
 *
 * @param {string} rel     repo path
 * @param {string} status  git's name-status letter: A, M, D, R, C...
 * @returns {string|null}
 */
export function pathRefusal(rel, status = 'M') {
  const p = posix(rel);
  if (FORBIDDEN_PATHS.some((re) => re.test(p))) return `${p} is never part of a proposal`;
  if (REFEREE_PATHS.some((re) => re.test(p))) return `${p} judges changes or runs the loop: only a person changes it`;
  if (/^tests\//.test(p) && status !== 'A') return `${p} is an existing test: a proposal may add tests, never change or remove one`;
  return null;
}

/** Whether a change to this path changes the agent's behaviour, and so must be measured. */
export function isBehaviourPath(rel) {
  const p = posix(rel);
  return BEHAVIOUR_PATHS.some((re) => re.test(p));
}

/** Source files: a proposal that adds or changes one must also add a test. */
const CODE_FILE = /\.(mjs|cjs|js|jsx|ts|tsx|sh|py)$/;

/** Whether this path is code outside the tests: a proposal that adds or changes it must add a test. */
export function isCodePath(rel) {
  const p = posix(rel);
  return CODE_FILE.test(p) && !/^tests\//.test(p);
}

/**
 * Why a proposal is refused for its tests, or null. A change that adds or changes code must add at
 * least one test file (a new `.test.mjs` under `tests/`): passing the suite is not enough, since the
 * suite cannot fail on code nothing tests. Removing code alone needs none.
 *
 * @param {{ status: string, path: string }[]} changes  as cycle.mjs parseNameStatus gives them
 * @returns {string|null}
 */
export function testRefusal(changes) {
  const code = changes.filter((c) => c.status !== 'D' && isCodePath(c.path)).map((c) => posix(c.path));
  if (code.length === 0) return null;
  if (changes.some((c) => c.status === 'A' && /^tests\/.+\.test\.mjs$/.test(posix(c.path)))) return null;
  return `it changes code (${code.join(', ')}) and adds no test: a change to code must add a test file under tests/ that exercises it`;
}

/**
 * The loop's settings: the defaults, with the developer's local file over them (its `proposer` block
 * names the command a cycle runs: see proposer.mjs).
 *
 * @param {object} [o]
 * @param {string} [o.repoRoot]
 * @param {Function} [o.readFile]
 * @returns {object}
 */
export function loadLoopSettings({ repoRoot = process.cwd(), readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let local = {};
  try {
    local = JSON.parse(readFile(path.join(repoRoot, LOCAL_SETTINGS)));
  } catch {
    local = {};
  }
  return {
    ...LOOP_DEFAULTS,
    ...local,
    proposer: { ...LOOP_DEFAULTS.proposer, ...(local.proposer || {}) },
    reviewer: { ...LOOP_DEFAULTS.reviewer, ...(local.reviewer || {}) },
    planner: { ...LOOP_DEFAULTS.planner, ...(local.planner || {}) },
    measure: { ...LOOP_DEFAULTS.measure, ...(local.measure || {}) },
    merge: { ...LOOP_DEFAULTS.merge, ...(local.merge || {}) },
    release: { ...LOOP_DEFAULTS.release, ...(local.release || {}) },
  };
}
