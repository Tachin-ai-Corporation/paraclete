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
  'files', 'responsibility_store', 'control', 'dashboard', 'effort', 'versioning',
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
  problems.push(...claudeCandidateProblems(c.vertex));

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
  problems.push(...dashboardProblems(c.dashboard));
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

/**
 * The Claude models an admin may turn Claude on with (vertex.models.claude_candidates): a list of
 * distinct Claude models on Vertex AI, newest first, that includes vertex.models.claude (what runs when
 * no choice is stored), each with its context window in vertex.context_windows.
 *
 * @param {object} vertex the contracts' vertex section
 * @returns {string[]}
 */
function claudeCandidateProblems(vertex) {
  const candidates = vertex.models?.claude_candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return ['vertex.models.claude_candidates must be a non-empty list of Claude models, newest first'];
  }
  const problems = [];
  for (const model of candidates) {
    if (typeof model !== 'string' || !MODEL_PATTERN.test(model) || !model.startsWith('vertex-anthropic/')) {
      problems.push(`vertex.models.claude_candidates must hold only 'vertex-anthropic/<model id>' entries, got ${JSON.stringify(model)}`);
      continue;
    }
    const window = vertex.context_windows?.[model.slice(model.indexOf('/') + 1)];
    if (!(typeof window === 'number' && Number.isFinite(window) && window > 0)) {
      problems.push(`vertex.context_windows must give ${model.slice(model.indexOf('/') + 1)} a context window, since it is a Claude candidate`);
    }
  }
  if (new Set(candidates).size !== candidates.length) problems.push('vertex.models.claude_candidates must not list a model twice');
  if (!candidates.includes(vertex.models.claude)) {
    problems.push(`vertex.models.claude_candidates must include vertex.models.claude (${vertex.models.claude}), the model Claude runs when no choice is stored`);
  }
  return problems;
}

/** Cloud Run's ingress settings. */
const INGRESS = ['all', 'internal', 'internal-and-cloud-load-balancing'];

/** The shortest time the dashboard keeps GitHub's release list: GitHub answers 60 unauthenticated requests an hour. */
const MIN_RELEASE_CHECK_TTL_SECONDS = 300;

/**
 * The dashboard's build and service (the `dashboard` section): what install/lib/dashboard.mjs passes to
 * gcloud and the dashboard's upgrade passes to Cloud Build and Cloud Run.
 *
 * @param {object} d the contracts' dashboard section
 * @returns {string[]}
 */
function dashboardProblems(d) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const isWhole = (v) => Number.isInteger(v) && v > 0;
  const service = d.service || {};
  need(typeof service.cpu === 'string' && /^(\d+(\.\d+)?|\d+m)$/.test(service.cpu), "dashboard.service.cpu must be a CPU count such as '1' or '1000m'");
  need(typeof service.memory === 'string' && /^\d+(Mi|Gi)$/.test(service.memory), "dashboard.service.memory must be a size such as '512Mi' or '1Gi'");
  need(isWhole(service.max_instances), 'dashboard.service.max_instances must be a whole number above 0');
  need(INGRESS.includes(service.ingress), `dashboard.service.ingress must be one of ${INGRESS.join(', ')}`);
  need(typeof d.image_name === 'string' && /^[a-z0-9]+([._-][a-z0-9]+)*$/.test(d.image_name), 'dashboard.image_name must be an image name: lowercase letters, digits and . _ -');
  need(typeof d.build_config_path === 'string' && /^dashboard\/[a-z0-9._-]+\.json$/.test(d.build_config_path),
    'dashboard.build_config_path must name a JSON file in dashboard/');
  need(isWhole(d.build_timeout_seconds), 'dashboard.build_timeout_seconds must be a whole number above 0');
  need(isWhole(d.release_check_ttl_seconds) && d.release_check_ttl_seconds >= MIN_RELEASE_CHECK_TTL_SECONDS,
    `dashboard.release_check_ttl_seconds must be a whole number of at least ${MIN_RELEASE_CHECK_TTL_SECONDS}: GitHub answers 60 unauthenticated requests an hour`);
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
