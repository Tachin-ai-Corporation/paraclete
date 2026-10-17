// agent/providers/vertex-text.mjs: single-shot text calls to a Gemini model on Vertex AI, for the
// brain's small utility jobs: summaries, mission titles, free text transforms, and forcing the
// cortex's (the organ that decides each step) JSON into its schema. No tools, no sessions, no
// fallback model; organ turns go through the gateway instead. Used by the brain, the checkpoint
// executor, notifications.mjs, and context/compaction.mjs (smartTruncate).

import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';
import { parseJsonResponse } from './json-repair.mjs';

// The current Gemini models answer only on Vertex AI's global endpoint.
const DEFAULT_LOCATION = 'global'; // default; callers pass the contracts value
const DEFAULT_MODEL = 'gemini-3.8-flash'; // default; callers pass the contracts value

const CLASSIFICATIONS = ['new_mission', 'attach', 'continue', 'cancel', 'respond'];
const STAKES = ['routine', 'consequential', 'irreversible'];
const DECIDE_ACTIONS = [
  'checkpoint_plan', 'synthesize', 'synthesize_with_failure',
  'needs_input', 'blocked', 'status_update',
  'wait', 'trigger_responsibility',
];
const STEP_TYPES = ['standard', 'approval_gate', 'ask'];
const EPISTEMIC_BINS = ['verified', 'inferred', 'assumed'];

// ---- Schemas the cortex's output is held to ----

const TASK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    agent:           { type: 'STRING' },
    task:            { type: 'STRING' },
    accept_criteria: { type: 'STRING' },
    step_type:       { type: 'STRING', enum: STEP_TYPES },
    brief_part:      { type: 'STRING' },
  },
  required: ['agent', 'task'],
};

const CHECKPOINT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    instruction:     { type: 'STRING' },
    accept_criteria: { type: 'STRING' },
    tasks:           { type: 'ARRAY', items: TASK_SCHEMA },
  },
  required: ['instruction', 'accept_criteria', 'tasks'],
};

/**
 * Vertex AI response schemas, one per cortex mode. `enforceSchema` checks a response against the
 * matching rules and, when it fails, asks the model to restructure it into this schema.
 *
 * @type {Record<string, object>}
 */
export const CORTEX_SCHEMAS = {
  classify: {
    type: 'OBJECT',
    properties: {
      classification: { type: 'STRING', enum: CLASSIFICATIONS },
      response:       { type: 'STRING' },
      instruction:    { type: 'STRING' },
      intent:         { type: 'STRING' },
      reasoning:      { type: 'STRING' },
      attach_to:      { type: 'STRING' },
      continue_mission: { type: 'STRING' },
      continue_envelope: { type: 'STRING' },
      accept_criteria: { type: 'STRING' },
      context_summary: { type: 'STRING' },
      project_id:     { type: 'STRING' },
      process_id:     { type: 'STRING' },
      job_to_be_done: { type: 'STRING' },
      stakes:         { type: 'STRING', enum: STAKES },
      // Ids of the read tools the brain offers a respond turn; the brain checks them against its list.
      reads:          { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['classification', 'reasoning'],
  },
  analyze: {
    type: 'OBJECT',
    properties: {
      objective: { type: 'STRING' },
      parts: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        id:           { type: 'STRING' },
        summary:      { type: 'STRING' },
        risk:         { type: 'STRING', enum: ['none', 'mutating', 'destructive_or_public'] },
        depends_on:   { type: 'ARRAY', items: { type: 'STRING' } },
        unknowns:     { type: 'ARRAY', items: { type: 'STRING' } },
        check:        { type: 'STRING' },
        assumes:      { type: 'ARRAY', items: { type: 'STRING' } },
        load_bearing: { type: 'BOOLEAN' },
      }, required: ['id', 'summary', 'risk'] } },
      process_match: { type: 'STRING' },
      kill_shot:     { type: 'STRING' },
      premise:       { type: 'STRING', enum: ['sound', 'flawed'] },
      premise_note:  { type: 'STRING' },
    },
    required: ['objective', 'parts'],
  },
  decide: {
    type: 'OBJECT',
    properties: {
      action:          { type: 'STRING', enum: DECIDE_ACTIONS },
      reasoning:       { type: 'STRING' },
      checkpoints:     { type: 'ARRAY', items: CHECKPOINT_SCHEMA },
      synthesis:       { type: 'STRING' },
      failure_summary: { type: 'STRING' },
      question:        { type: 'STRING' },
      what_is_needed:  { type: 'STRING' },
      blocker:         { type: 'STRING' },
      blocker_type:    { type: 'STRING' },
      minutes:         { type: 'NUMBER' },
      reason:          { type: 'STRING' },
      then:            { type: 'STRING' },
      escalation_message: { type: 'STRING' },
      processId:       { type: 'STRING' },
      responsibilityId: { type: 'STRING' },
      parameters:      { type: 'OBJECT' },
      message:         { type: 'STRING' },
      instruction:     { type: 'STRING' },
      goal_check: { type: 'OBJECT', properties: {
        criteria_met:   { type: 'ARRAY', items: { type: 'STRING' } },
        criteria_unmet: { type: 'ARRAY', items: { type: 'STRING' } },
        confidence:     { type: 'STRING', enum: ['high', 'medium', 'low'] },
        assessment:     { type: 'STRING' },
      } },
      answer: { type: 'STRING' },
      risk:   { type: 'STRING' },
      assumptions: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        claim:  { type: 'STRING' },
        status: { type: 'STRING', enum: EPISTEMIC_BINS },
        note:   { type: 'STRING' },
      }, required: ['claim', 'status'] } },
      // Result refs whose full content the cortex needs before it can decide. The brain fetches them
      // and returns them next turn; this turn's action is deferred. Meant for when a result's summary
      // is genuinely not enough, never for re-reading work already in view.
      request_context: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['action'],
  },
  plan: {
    type: 'OBJECT',
    properties: {
      checkpoints: { type: 'ARRAY', items: CHECKPOINT_SCHEMA },
    },
    required: ['checkpoints'],
  },
  respond_compose: {
    type: 'OBJECT',
    properties: {
      reasoning: { type: 'STRING' },
      response:  { type: 'STRING' },
    },
    required: ['reasoning', 'response'],
  },
};

// ---- Pure helpers ----

/**
 * Cuts text to a budget by keeping its head and tail (40% each) and stating how much was cut in
 * between, so both the framing and the conclusion survive. No model call.
 *
 * @param {string} text
 * @param {number} budget maximum characters to keep from the text
 * @returns {string}
 */
export function smartTruncate(text, budget) {
  if (!text || text.length <= budget) return text;
  const headBudget = Math.floor(budget * 0.4);
  const tailBudget = Math.floor(budget * 0.4);
  const head = text.substring(0, headBudget);
  const tail = text.substring(text.length - tailBudget);
  const truncated = text.length - headBudget - tailBudget;
  return `${head}\n[...${truncated} chars truncated...]\n${tail}`;
}

/**
 * A title from the first sentence of `text`, cut at a word boundary. Strips the chat framing the ears
 * add to an intake ("[Current message ...]", "User: "). No model call: used for checkpoints and tasks,
 * and when a mission title from the model fails.
 *
 * @param {string} text
 * @param {number} [maxLen=80]
 * @returns {string}
 */
export function summarizeTitle(text, maxLen = 80) {
  if (!text) return 'Untitled';
  let cleaned = text
    .replace(/^\[Current message[^\]]*\]\s*/i, '')
    .replace(/^\[Chat messages since[^\]]*\]\s*/i, '')
    .replace(/^\[Previous context[^\]]*\]\s*/i, '')
    .replace(/^(User|Someone|Human):\s*/i, '')
    .trim();
  cleaned = cleaned.replace(/^```[^\n]*\n?/, '').trim();
  const firstSentence = cleaned.split(/[.\n!?]/)[0].trim();
  if (!firstSentence) return cleaned.substring(0, maxLen);
  if (firstSentence.length <= maxLen) return firstSentence;
  const truncated = firstSentence.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.substring(0, lastSpace) : truncated) + '…';
}

// ---- Client ----

/**
 * Creates a Vertex AI text client.
 *
 * @param {object}   config
 * @param {string}   config.projectId                    GCP project that hosts Vertex AI
 * @param {string}   [config.location='global']          Vertex AI location
 * @param {string}   [config.model='gemini-3.8-flash']   model id
 * @param {number}   [config.timeoutMs=30000]            timeout for text calls
 * @param {number}   [config.enforceSchemaTimeoutMs=15000] timeout for each schema coercion call
 * @param {number}   [config.enforceSchemaMaxAttempts=2] coercion calls before giving up
 * @param {Function} [config.logger]                     (level, msg) logger
 * @param {Function} [config.getAccessToken]             VM token source (injectable for tests)
 * @param {Function} [config.fetch]                      fetch implementation (injectable for tests)
 * @returns {{summarize: Function, generateTitle: Function, enforceSchema: Function, transform: Function}}
 */
export function createVertexText(config = {}) {
  if (!config.projectId) throw new Error('createVertexText: projectId is required');
  const log = config.logger || ((...args) => console.log('[vertex-text]', ...args));
  const getAccessToken = config.getAccessToken || getVmAccessToken;
  const fetchImpl = config.fetch || globalThis.fetch;
  const location = config.location || DEFAULT_LOCATION;
  const model = config.model || DEFAULT_MODEL;
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const generateUrl = `https://${host}/v1/projects/${config.projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const timeoutMs = config.timeoutMs || 30_000;
  const enforceSchemaTimeoutMs = config.enforceSchemaTimeoutMs || 15_000;
  const enforceSchemaMaxAttempts = config.enforceSchemaMaxAttempts || 2;

  /** Utility calls are otherwise invisible to token accounting: log the counts, never the content. */
  function logUsage(data, stage) {
    const um = data.usageMetadata;
    if (!um) return;
    log('INFO', `TELEMETRY utility_usage${stage ? ` stage=${stage}` : ''} model=${model} input=${um.promptTokenCount || 0} output=${um.candidatesTokenCount || 0} cached=${um.cachedContentTokenCount || 0}`);
  }

  async function postGenerate(body, timeout) {
    const token = await getAccessToken();
    return fetchImpl(generateUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  }

  /**
   * The core text-to-text call every other method uses.
   *
   * @param {string} text
   * @param {string} instruction what to do with the text
   * @param {object} [opts]
   * @param {number} [opts.maxTokens=1024]
   * @param {number} [opts.temperature=0.3]
   * @param {boolean} [opts.disableThinking] turn thinking off for trivial jobs
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<string|null>} the model's text, or null on any failure
   */
  async function callVertex(text, instruction, opts = {}) {
    const maxTokens = opts.maxTokens || 1024;
    const temperature = opts.temperature ?? 0.3;

    try {
      log('DEBUG', `callVertex: model=${model}, instruction="${instruction.substring(0, 80)}", input=${text.length} chars`);
      const body = {
        contents: [{ role: 'user', parts: [{ text: `${instruction}\n\n---\n\n${text}` }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      };
      if (opts.disableThinking) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };

      const resp = await postGenerate(body, opts.timeoutMs || timeoutMs);
      if (!resp.ok) {
        const errText = await resp.text();
        log('ERROR', `callVertex HTTP ${resp.status}: ${errText.substring(0, 200)}`);
        return null;
      }

      const data = await resp.json();
      logUsage(data);
      // Thinking models return thought parts first; the answer is the last non-thought text part.
      const parts = data.candidates?.[0]?.content?.parts || [];
      let result = '';
      for (const part of parts) {
        if (part.text && !part.thought) result = part.text;
      }
      log('DEBUG', `callVertex result: ${result.length} chars`);
      return result.trim();
    } catch (err) {
      log('ERROR', `callVertex failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Summarizes text to fit a budget. Text already within budget comes back unchanged with no model
   * call; when the model fails, smartTruncate stands in.
   *
   * @param {string} text
   * @param {string} instruction
   * @param {object} [opts]
   * @param {number} [opts.budget]    maximum characters in the result
   * @param {number} [opts.maxTokens] defaults to budget / 3
   * @returns {Promise<string>}
   */
  async function summarize(text, instruction, opts = {}) {
    const budget = opts.budget;
    if (budget && (!text || text.length <= budget)) return text || '';
    const maxTokens = opts.maxTokens || (budget ? Math.ceil(budget / 3) : 1024);
    const result = await callVertex(text, instruction, { ...opts, maxTokens });
    if (result) {
      if (budget) return result.length <= budget ? result : result.substring(0, budget);
      return result;
    }
    return budget ? smartTruncate(text, budget) : (text || '');
  }

  /**
   * A title for an envelope. Only missions get a model-written title; checkpoints and tasks, and a
   * mission whose model call fails, use summarizeTitle.
   *
   * @param {string} text
   * @param {'mission'|'checkpoint'|'task'} [type='mission']
   * @returns {Promise<string>}
   */
  async function generateTitle(text, type = 'mission') {
    if (!text || text.length < 3) return 'Untitled';
    if (type !== 'mission') return summarizeTitle(text);
    const prompt = 'A MISSION is a strategic goal — the top-level objective being accomplished. Title it as the outcome or deliverable. 5-12 words.\nNo quotes, no prefixes, no labels. Just the title.';
    const result = await callVertex(text.substring(0, 1000), prompt, { maxTokens: 60, temperature: 0.3, disableThinking: true });
    if (result && result.length > 2 && result.length < 120) {
      return result.replace(/^["']|["']$/g, '').replace(/^(Mission|Checkpoint|Task):\s*/i, '').trim();
    }
    return summarizeTitle(text);
  }

  /**
   * Checks a parsed object against the rules for a schema.
   *
   * @param {object} parsed
   * @param {string} schemaName a key of CORTEX_SCHEMAS
   * @returns {{valid: boolean, reason?: string}}
   */
  function validateSchema(parsed, schemaName) {
    if (!parsed || typeof parsed !== 'object') return { valid: false, reason: 'not an object' };
    if (schemaName === 'classify') {
      if (!CLASSIFICATIONS.includes(parsed.classification)) return { valid: false, reason: `classification missing or invalid: ${parsed.classification}` };
      if (parsed.classification === 'respond' && (typeof parsed.response !== 'string' || !parsed.response.trim())) {
        return { valid: false, reason: 'response missing for respond classification' };
      }
      if (typeof parsed.reasoning !== 'string' || !parsed.reasoning) return { valid: false, reason: 'reasoning missing' };
      if (parsed.stakes && !STAKES.includes(parsed.stakes)) return { valid: false, reason: `stakes invalid: ${parsed.stakes}` };
      return { valid: true };
    }
    if (schemaName === 'respond_compose') {
      if (typeof parsed.reasoning !== 'string' || !parsed.reasoning) return { valid: false, reason: 'reasoning missing' };
      if (typeof parsed.response !== 'string' || !parsed.response) return { valid: false, reason: 'response missing' };
      return { valid: true };
    }
    if (schemaName === 'decide') {
      if (!DECIDE_ACTIONS.includes(parsed.action)) return { valid: false, reason: `action missing or invalid: ${parsed.action}` };
      if (Array.isArray(parsed.assumptions)) {
        for (const a of parsed.assumptions) {
          if (!a || !a.claim || !EPISTEMIC_BINS.includes(a.status)) {
            return { valid: false, reason: 'assumptions entries require claim and status in {verified,inferred,assumed}' };
          }
        }
      }
      return { valid: true };
    }
    if (schemaName === 'analyze') {
      if (typeof parsed.objective !== 'string' || !parsed.objective) return { valid: false, reason: 'objective missing' };
      if (!Array.isArray(parsed.parts)) return { valid: false, reason: 'parts missing or not array' };
      return { valid: true };
    }
    if (schemaName === 'plan') {
      if (!Array.isArray(parsed.checkpoints)) return { valid: false, reason: 'checkpoints missing or not array' };
      return { valid: true };
    }
    return { valid: false, reason: `unknown schema: ${schemaName}` };
  }

  /**
   * Maps the field names the cortex drifts to onto the schema's names, in place, so common drift
   * passes the deterministic check with no model call.
   *
   * @param {object} parsed
   * @param {string} schemaName
   * @returns {object} the same object
   */
  function normalizeDecision(parsed, schemaName) {
    if (!parsed || typeof parsed !== 'object') return parsed;

    if (parsed.move && !parsed.action) {
      parsed.action = parsed.move;
      log('DEBUG', `normalizeDecision: move → action (${parsed.action})`);
    }

    // In classify mode the cortex often echoes the mode as "action":"classify" and puts the real
    // decision under "type", or puts the decision straight under "action". Without these aliases the
    // classification was silently undefined, which downstream treats as new_mission: a duplicate
    // mission instead of resuming the one waiting for input. The literal "classify" is not a
    // classification and is never aliased.
    if (schemaName === 'classify' && !parsed.classification) {
      if (parsed.type && CLASSIFICATIONS.includes(parsed.type)) {
        parsed.classification = parsed.type;
        log('DEBUG', `normalizeDecision: type → classification (${parsed.classification})`);
      } else if (parsed.action && CLASSIFICATIONS.includes(parsed.action)) {
        parsed.classification = parsed.action;
        log('DEBUG', `normalizeDecision: action → classification (${parsed.classification})`);
      }
    }

    if (parsed.attach_to_mission && !parsed.attach_to) {
      parsed.attach_to = parsed.attach_to_mission;
      log('DEBUG', 'normalizeDecision: attach_to_mission → attach_to');
    }
    if (parsed.continue_to && !parsed.continue_mission) {
      parsed.continue_mission = parsed.continue_to;
      log('DEBUG', 'normalizeDecision: continue_to → continue_mission');
    }

    // The cortex nests checkpoints at varying depths.
    if (!parsed.checkpoints) {
      if (parsed.plan?.checkpoints) {
        parsed.checkpoints = parsed.plan.checkpoints;
        log('DEBUG', 'normalizeDecision: plan.checkpoints → checkpoints');
      } else if (parsed.checkpoint_plan?.checkpoints) {
        parsed.checkpoints = parsed.checkpoint_plan.checkpoints;
        log('DEBUG', 'normalizeDecision: checkpoint_plan.checkpoints → checkpoints');
      } else if (parsed.steps && Array.isArray(parsed.steps)) {
        parsed.checkpoints = parsed.steps;
        log('DEBUG', 'normalizeDecision: steps → checkpoints');
      }
    }

    if (parsed.assessment && !parsed.goal_check) parsed.goal_check = { assessment: parsed.assessment };
    if (parsed.goal_assessment && !parsed.goal_check) parsed.goal_check = parsed.goal_assessment;

    return parsed;
  }

  /**
   * Holds a cortex response to a schema. First a free deterministic parse, alias and check; then a
   * fast exit for valid JSON that carries the schema's deciding field (the brain's own legality checks
   * catch the rest); then up to `enforceSchemaMaxAttempts` model calls that restructure the response
   * with Vertex AI structured output. When all of that fails, the plain parse comes back. Never
   * throws.
   *
   * An empty response never reaches the coercion model: asked to restructure nothing, it could invent
   * a decision.
   *
   * @param {string|object} raw the cortex's response, as text or already parsed
   * @param {string} schemaName a key of CORTEX_SCHEMAS
   * @returns {Promise<object>} a conforming object, the raw object, or { error: 'parse_failed', ... }
   */
  async function enforceSchema(raw, schemaName) {
    const isObject = raw !== null && typeof raw === 'object';
    const plainParse = () => (isObject ? raw : parseJsonResponse(raw));
    const schema = CORTEX_SCHEMAS[schemaName];
    if (!schema) return plainParse();

    // Parse and alias once: the deterministic check and the fast exit must see the same object.
    const parsed = normalizeDecision(plainParse(), schemaName);

    if (parsed) {
      const check = validateSchema(parsed, schemaName);
      if (check.valid) {
        // `plan` has neither discriminator; don't log "action=undefined" on a passing check.
        const disc = parsed.action || parsed.classification;
        log('DEBUG', `enforceSchema OK (deterministic): schema=${schemaName}${disc ? ` action=${disc}` : ''}`);
        return parsed;
      }
      log('INFO', `enforceSchema deterministic invalid: ${check.reason} | action=${parsed.action || 'none'}`);

      // Classify exits on `classification` only: its "action" is always the echoed mode marker, so
      // its presence proves nothing.
      if (schemaName === 'decide' && parsed.action) {
        log('INFO', `enforceSchema fast-exit: valid JSON with action=${parsed.action}`);
        return parsed;
      }
      if (schemaName === 'classify' && parsed.classification) {
        log('INFO', `enforceSchema fast-exit: valid JSON with classification=${parsed.classification}`);
        return parsed;
      }
      if (schemaName === 'respond_compose' && parsed.response) {
        log('INFO', 'enforceSchema fast-exit: valid JSON with response');
        return parsed;
      }
    }

    const input = typeof raw === 'string' ? raw : (isObject ? JSON.stringify(raw) : '');
    if (!input.trim()) {
      log('WARN', `enforceSchema: empty response for schema=${schemaName}; nothing to restructure`);
      return plainParse();
    }

    const prompt = `Restructure this AI decision into the required JSON schema. Preserve ALL semantic content exactly — do not invent, remove, or modify any decisions, instructions, or reasoning.\n\n---\n${input}`;
    for (let attempt = 1; attempt <= enforceSchemaMaxAttempts; attempt++) {
      try {
        const resp = await postGenerate({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema,
            maxOutputTokens: 8192,
            temperature: 0.1,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }, enforceSchemaTimeoutMs);

        if (!resp.ok) {
          log('WARN', `enforceSchema attempt ${attempt}: HTTP ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        logUsage(data, 'enforce_schema');
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) { log('WARN', `enforceSchema attempt ${attempt}: empty response`); continue; }

        const coerced = JSON.parse(text);
        log('DEBUG', `enforceSchema OK (attempt ${attempt}): action=${coerced.action || coerced.classification}`);
        return coerced;
      } catch (err) {
        log('WARN', `enforceSchema attempt ${attempt}: ${err.message}`);
      }
    }

    log('WARN', `enforceSchema failed ${enforceSchemaMaxAttempts}x, falling back to parseJsonResponse`);
    return plainParse();
  }

  /**
   * A free text-to-text transform: rephrase, extract, summarize without a budget.
   *
   * @param {string} text
   * @param {string} instruction
   * @param {object} [opts] maxTokens, temperature, disableThinking, timeoutMs
   * @returns {Promise<string|null>} the model's text, or null on failure
   */
  async function transform(text, instruction, opts = {}) {
    return callVertex(text, instruction, opts);
  }

  return { summarize, generateTitle, enforceSchema, transform };
}
