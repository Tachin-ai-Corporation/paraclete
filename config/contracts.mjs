// config/contracts.mjs: loads config/contracts.json, checks it, and returns it frozen. Services and
// command-line tools read configuration through here; library packages never do (they take values as
// parameters). A contract that fails a check stops the service at startup, before any work runs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where contracts.json sits next to this module, in the repo and on the VM alike. */
export const CONTRACTS_PATH = fileURLToPath(new URL('./contracts.json', import.meta.url));

/** Storage ceilings, not budgets: see the `_bounds` note in contracts.json. */
const MAX_CONTEXT_TOKEN_BUDGET = 125000;

const MODEL_PATTERN = /^vertex-(google|anthropic)\/[a-z0-9][a-z0-9.@_-]*$/;

const REQUIRED_SECTIONS = [
  'vertex', 'gateway', 'organs', 'tools', 'brain', 'archival', 'ears', 'mouth', 'chat', 'delivery',
  'conversation', 'compaction', 'session', 'organ_context', 'projects', 'utility', 'memory', 'git',
  'files', 'responsibility_store', 'control', 'effort', 'versioning',
];

const MODEL_TIERS = ['cortex', 'strong', 'fast', 'fallback', 'claude', 'claude_fallback'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

/**
 * Every problem with a contracts object, as readable strings. Empty means valid.
 * @param {object} c
 * @returns {string[]}
 */
export function validateContracts(c) {
  const problems = [];
  const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const need = (ok, message) => { if (!ok) problems.push(message); };

  if (!c || typeof c !== 'object') return ['contracts must be an object'];
  for (const section of REQUIRED_SECTIONS) need(c[section] && typeof c[section] === 'object', `missing section: ${section}`);
  if (problems.length) return problems;

  for (const tier of MODEL_TIERS) {
    const model = c.vertex.models?.[tier];
    need(typeof model === 'string' && MODEL_PATTERN.test(model), `vertex.models.${tier} must be '<vertex-google|vertex-anthropic>/<model id>', got ${JSON.stringify(model)}`);
  }
  need(!/anthropic/.test(c.vertex.models?.fallback || ''), 'vertex.models.fallback must be a Gemini model: Claude is optional');
  need(!/anthropic/.test(c.vertex.models?.claude_fallback || ''), 'vertex.models.claude_fallback must be a Gemini model');

  need(isPositive(c.brain.context_token_budget) && c.brain.context_token_budget <= MAX_CONTEXT_TOKEN_BUDGET,
    `brain.context_token_budget must be positive and at most ${MAX_CONTEXT_TOKEN_BUDGET} (the envelope is a 1 MiB Firestore document)`);
  need(isPositive(c.compaction.working_budget_tokens) && c.compaction.working_budget_tokens <= c.brain.context_token_budget,
    'compaction.working_budget_tokens must be positive and at most brain.context_token_budget');
  need(isPositive(c.brain.max_iterations), 'brain.max_iterations must be positive');
  need(isPositive(c.organs.max_steps), 'organs.max_steps must be positive');
  need(isPositive(c.brain.wait_max_minutes) && c.brain.wait_min_minutes <= c.brain.wait_default_minutes
    && c.brain.wait_default_minutes <= c.brain.wait_max_minutes,
    'brain.wait_min_minutes <= wait_default_minutes <= wait_max_minutes must hold');
  need(isPositive(c.archival.waiting_timeout_hours) && c.archival.waiting_timeout_hours * 60 > c.brain.wait_max_minutes,
    'archival.waiting_timeout_hours must exceed brain.wait_max_minutes, or the sweep could cancel a legitimate wait');
  need(['enforce', 'observe'].includes(c.brain.transition_guard), "brain.transition_guard must be 'enforce' or 'observe'");

  for (const key of ['output_chars', 'output_head_chars', 'output_tail_chars', 'timeout_ms', 'max_buffer_bytes']) {
    need(isPositive(c.tools[key]), `tools.${key} must be positive`);
  }
  need(c.tools.output_head_chars + c.tools.output_tail_chars <= c.tools.output_chars,
    'tools.output_head_chars + output_tail_chars must not exceed tools.output_chars');

  need(Number.isInteger(c.gateway.port) && c.gateway.port > 0 && c.gateway.port < 65536, 'gateway.port must be a TCP port');
  need(['127.0.0.1', '::1', 'localhost'].includes(c.gateway.bind), 'gateway.bind must be a loopback address');
  for (const key of ['poll_ms', 'gateway_ready_timeout_ms', 'upgrade_max_seconds']) {
    need(isPositive(c.control[key]), `control.${key} must be positive`);
  }
  need(EFFORT_LEVELS.includes(c.effort.default), `effort.default must be one of ${EFFORT_LEVELS.join(', ')}`);
  need(typeof c.git.prefix === 'string' && c.git.prefix.endsWith('/'), "git.prefix must end with '/'");
  need(typeof c.files.prefix === 'string' && c.files.prefix.endsWith('/'), "files.prefix must end with '/'");
  need(c.git.prefix !== c.files.prefix, 'git.prefix and files.prefix must differ');

  try {
    new RegExp(c.versioning.canonical_regex);
  } catch {
    problems.push('versioning.canonical_regex must be a valid regular expression');
  }
  return problems;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Reads, checks and freezes the contracts. Throws, naming every problem, when they don't check out.
 * @param {object} [options]
 * @param {string} [options.path] contracts.json to read (default: the one next to this module)
 * @returns {object}
 */
export function loadContracts({ path = CONTRACTS_PATH } = {}) {
  let contracts;
  try {
    contracts = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read contracts at ${path}: ${err.message}`);
  }
  const problems = validateContracts(contracts);
  if (problems.length) throw new Error(`Invalid contracts at ${path}:\n- ${problems.join('\n- ')}`);
  return deepFreeze(contracts);
}
