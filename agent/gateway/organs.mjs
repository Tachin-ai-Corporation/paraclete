// agent/gateway/organs.mjs: the brain's organs as the gateway runs them: each one's job, toolset,
// sampling and step budget, the model it runs on, and its prompt. It decides nothing about when an
// organ is called; the brain does that and names the organ in each request. The gateway service
// builds one registry at startup from the contracts' models and the installed prompt directories.
//
// Models come in three tiers: the cortex has its own; the strong tier (prefrontal, motor, cerebellum)
// is on for every role; the temporal organs run on the fast model. Every organ falls back to the one
// fallback model. Nothing else chooses a model: no per-organ file pins one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_TOOLSET, CEREBELLUM_TOOLSET, MEMORY_TOOLSET } from './tools.mjs';

/** Models per tier. Defaults; callers pass the contracts values. */
export const DEFAULT_MODELS = Object.freeze({
  cortex: 'vertex-google/gemini-4-argon',
  strong: 'vertex-google/gemini-4-argon',
  fast: 'vertex-google/gemini-3.8-flash',
  fallback: 'vertex-google/gemini-3.8-flash',
});

/** Model calls a tooled organ may make in one turn. Default; callers pass the contracts value. */
export const DEFAULT_MAX_STEPS = 12;

const NONE = Object.freeze([]);

// Sampling per organ. An output ceiling is not a spend: reasoning tokens bill against the same
// ceiling, so an organ that reasons hard needs room. The verifier at 8192 twice spent the whole
// allowance thinking and returned no verdict at all, and a healthy mission was blocked as failed.
export const ORGANS = Object.freeze({
  cortex: Object.freeze({
    job: 'Decides the next step of a mission',
    tier: 'cortex', toolset: NONE, maxTokens: 32768, temperature: 0.4, topP: 0.95,
  }),
  prefrontal: Object.freeze({
    job: "Plans a mission's checkpoints",
    tier: 'strong', toolset: NONE, maxTokens: 32768, temperature: 0.6, topP: 0.95,
  }),
  motor: Object.freeze({
    job: 'Executes tasks with tools',
    tier: 'strong', toolset: OPEN_TOOLSET, maxTokens: 65536, temperature: 0.3, topP: 0.9,
  }),
  cerebellum: Object.freeze({
    job: 'Verifies each checkpoint against its acceptance criteria and owns the verdict',
    tier: 'strong', toolset: CEREBELLUM_TOOLSET, forceToolCall: true, maxTokens: 32768, temperature: 0.1, topP: 0.85,
  }),
  // Toolless on the recall path (the brain fetches what it recalls); tooled with the memory toolset
  // only when a request asks it to execute (consolidation). Without that signal it stays toolless.
  'temporal-memory': Object.freeze({
    job: "Maintains the agent's memory",
    tier: 'fast', toolset: NONE, execToolset: MEMORY_TOOLSET, maxTokens: 32768, temperature: 0.3, topP: 0.9,
  }),
  'temporal-research': Object.freeze({
    job: 'Researches outside sources',
    tier: 'fast', toolset: OPEN_TOOLSET, maxTokens: 32768, temperature: 0.5, topP: 0.95,
  }),
});

/**
 * The model and fallback model an organ runs on.
 *
 * @param {string} organId
 * @param {object} [models] { cortex, strong, fast, fallback }; missing tiers take DEFAULT_MODELS
 * @returns {{model: string, fallbackModel: string}}
 */
export function resolveOrganModels(organId, models = {}) {
  const organ = ORGANS[organId];
  if (!organ) throw unknownOrgan(organId);
  const m = { ...DEFAULT_MODELS };
  for (const [tier, value] of Object.entries(models || {})) {
    if (tier in DEFAULT_MODELS && typeof value === 'string' && value.trim()) m[tier] = value.trim();
  }
  return { model: m[organ.tier], fallbackModel: m.fallback };
}

/**
 * An organ's prompt: the base prompt plus the role's append for that organ, when there is one.
 * Missing files read as empty.
 *
 * @param {string} organId
 * @param {object} dirs
 * @param {string} [dirs.promptsDir]     the base prompts, `<organ>.md`
 * @param {string} [dirs.rolePromptsDir] the role's prompts directory, `<organ>.md`
 * @param {Function} [dirs.readText]     (path) => text or null (injectable for tests)
 * @returns {string}
 */
export function loadOrganPrompt(organId, { promptsDir, rolePromptsDir, readText = readTextOrNull } = {}) {
  const base = promptsDir ? readText(join(promptsDir, `${organId}.md`)) : null;
  const role = rolePromptsDir ? readText(join(rolePromptsDir, `${organId}.md`)) : null;
  return [base, role].map((t) => (t || '').trim()).filter(Boolean).join('\n\n');
}

/**
 * The organ registry the gateway server reads.
 *
 * @param {object} [o]
 * @param {object} [o.models]         { cortex, strong, fast, fallback }
 * @param {number} [o.maxSteps]       model calls a tooled organ may make in one turn
 * @param {string} [o.promptsDir]     e.g. <install root>/prompts
 * @param {string} [o.rolePromptsDir] e.g. <install root>/roles/<role>/prompts
 * @param {Function} [o.readText]     (path) => text or null (injectable for tests)
 * @returns {{ids: string[], models: object, get: (organId: string, opts?: {exec?: boolean}) => object}}
 */
export function createOrganRegistry({ models, maxSteps, promptsDir, rolePromptsDir, readText = readTextOrNull } = {}) {
  const steps = Number.isInteger(maxSteps) && maxSteps > 0 ? maxSteps : DEFAULT_MAX_STEPS;
  const resolvedModels = { ...DEFAULT_MODELS };
  for (const tier of Object.keys(DEFAULT_MODELS)) {
    if (typeof models?.[tier] === 'string' && models[tier].trim()) resolvedModels[tier] = models[tier].trim();
  }
  return {
    ids: Object.keys(ORGANS),
    models: Object.freeze(resolvedModels),
    /**
     * One organ's configuration for one request.
     *
     * @param {string} organId
     * @param {{exec?: boolean}} [opts] exec: the request asks the memory organ to execute
     */
    get(organId, { exec = false } = {}) {
      const organ = ORGANS[organId];
      if (!organ) throw unknownOrgan(organId);
      const toolset = exec && organ.execToolset ? organ.execToolset : organ.toolset;
      return {
        id: organId,
        job: organ.job,
        ...resolveOrganModels(organId, resolvedModels),
        systemPrompt: loadOrganPrompt(organId, { promptsDir, rolePromptsDir, readText }),
        toolset: [...toolset],
        forceToolCall: organ.forceToolCall === true,
        maxSteps: toolset.length > 0 ? steps : 1,
        maxTokens: organ.maxTokens,
        temperature: organ.temperature,
        topP: organ.topP,
      };
    },
  };
}

function unknownOrgan(organId) {
  const err = new Error(`unknown organ '${organId}' (expected one of ${Object.keys(ORGANS).join(', ')})`);
  err.statusCode = 400;
  return err;
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
