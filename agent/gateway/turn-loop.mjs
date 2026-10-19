// agent/gateway/turn-loop.mjs: runs one organ turn: the model call, the tools it asks for, and the
// next call, until the model answers, a terminal tool reports, the loop guard stops it, or the step
// budget runs out. Then it appends the tool log the model cannot fabricate. runTurnWithFallback()
// moves a failed turn onto the fallback model without running any tool twice. Provider request
// shapes live in google-step.mjs and anthropic-step.mjs; the HTTP surface is server.mjs.
//
// The transcript (`messages`, and what a failed turn hands its fallback) is provider-neutral:
//   { role: 'user'|'assistant', content: string | Array<{type: 'text', text, tier?}> }
//   { role: 'assistant', content: string|null,
//     toolCalls: [{ id, name, args, provider, modelId, googleId?, thoughtSignature?, anthropicThinking? }] }
//   { role: 'tool', toolCallId, name, content, images?: [{ mimeType, data, name }] }
// `id` is unique in the transcript and safe as a Claude tool_use id. `provider` and `modelId` name
// the model that made the call. `googleId` and `thoughtSignature` are what Gemini returned with it,
// and `anthropicThinking` the thinking blocks Claude wrote before it: each is sent back to the model
// that made the call, as it came. `images` are what a tool such as viewImage returned for the
// model to look at (base64 `data`, a viewable `mimeType`, the `name` the organ gave): each provider's
// step turns them into its own image part, and only the most recent `images.kept` stay attached
// (retainImages() in images.mjs). Images never reach the tool log, the tool records or the response.

import { buildToolLog, recordPolicy, DEFAULT_RECORD_POLICY, TERMINAL_TOOLS, quoteToolLogMarkers } from '../context/tool-record.mjs';
import { parseModel, clientFor, PROVIDERS } from './model-clients.mjs';
import { LoopGuard, DEFAULT_LOOP_GUARD } from './loop-guard.mjs';
import { retainImages, isTranscriptImage } from './images.mjs';
import { createGoogleStepper } from './google-step.mjs';
import { createAnthropicStepper } from './anthropic-step.mjs';

/** Every setting the turn loop reads. Defaults; callers pass the contracts values. */
export const DEFAULT_SETTINGS = Object.freeze({
  anthropic: Object.freeze({
    promptCaching: false,
    messageBreakpoints: false,
    sessionAffinity: false,
    // 1h is load-bearing, not an optimization: one motor task can outlive the 5m default.
    cacheTtlStable: '1h',
    cacheTtlMission: '1h',
    // The Claude models a request may send a temperature to; the others take none.
    temperatureModels: Object.freeze([]),
  }),
  gemini: Object.freeze({
    explicitCache: false,
    explicitCacheTtlSeconds: 3600,
  }),
  images: Object.freeze({
    // Images a turn keeps attached: every step resends the transcript, and each image with it.
    kept: 3,
    // Where a tool's image goes in a Gemini request (google-step.mjs): inside the function response
    // ('function-response', documented for Gemini 3 and later) or as a part after it ('user-part').
    geminiPlacement: 'function-response',
  }),
  toolRecord: DEFAULT_RECORD_POLICY,
  loopGuard: Object.freeze({ ...DEFAULT_LOOP_GUARD, synthesize: true }),
  retry: Object.freeze({ maxRetries: 3, baseDelayMs: 2000 }),
});

const TTLS = new Set(['5m', '1h']);
const GEMINI_PLACEMENTS = new Set(['function-response', 'user-part']);

/**
 * A complete settings object: each valid value taken, anything missing or invalid left at its default.
 *
 * @param {object} [settings] partial settings, shaped like DEFAULT_SETTINGS
 * @returns {object}
 */
export function resolveSettings(settings = {}) {
  const s = settings || {};
  const d = DEFAULT_SETTINGS;
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  const pos = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
  const nonNeg = (v, dflt) => (Number.isInteger(v) && v >= 0 ? v : dflt);
  const ttl = (v, dflt) => (TTLS.has(v) ? v : dflt);
  const a = s.anthropic || {};
  const g = s.gemini || {};
  const lg = s.loopGuard || {};
  const r = s.retry || {};
  const im = s.images || {};
  const guard = { synthesize: bool(lg.synthesize, d.loopGuard.synthesize) };
  for (const key of Object.keys(DEFAULT_LOOP_GUARD)) guard[key] = Number.isInteger(lg[key]) && lg[key] > 0 ? lg[key] : DEFAULT_LOOP_GUARD[key];
  return {
    anthropic: {
      promptCaching: bool(a.promptCaching, d.anthropic.promptCaching),
      messageBreakpoints: bool(a.messageBreakpoints, d.anthropic.messageBreakpoints),
      sessionAffinity: bool(a.sessionAffinity, d.anthropic.sessionAffinity),
      cacheTtlStable: ttl(a.cacheTtlStable, d.anthropic.cacheTtlStable),
      cacheTtlMission: ttl(a.cacheTtlMission, d.anthropic.cacheTtlMission),
      temperatureModels: Array.isArray(a.temperatureModels)
        ? a.temperatureModels.filter((m) => typeof m === 'string' && m) : d.anthropic.temperatureModels,
    },
    gemini: {
      explicitCache: bool(g.explicitCache, d.gemini.explicitCache),
      explicitCacheTtlSeconds: pos(g.explicitCacheTtlSeconds, d.gemini.explicitCacheTtlSeconds),
    },
    images: {
      kept: Number.isInteger(im.kept) && im.kept > 0 ? im.kept : d.images.kept,
      geminiPlacement: GEMINI_PLACEMENTS.has(im.geminiPlacement) ? im.geminiPlacement : d.images.geminiPlacement,
    },
    toolRecord: recordPolicy(s.toolRecord),
    loopGuard: guard,
    retry: {
      maxRetries: nonNeg(r.maxRetries, d.retry.maxRetries),
      baseDelayMs: nonNeg(r.baseDelayMs, d.retry.baseDelayMs),
    },
  };
}

function isRateLimited(err) {
  return err?.status === 429 || err?.code === 429
    || String(err?.message || '').includes('429') || String(err?.message || '').includes('RESOURCE_EXHAUSTED');
}

/** fn, retried with exponential backoff and jitter on rate limits only. */
function retrying({ maxRetries, baseDelayMs }, sleep, logger) {
  return async function callWithRetry(fn, label) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimited(err) || attempt >= maxRetries) throw err;
        const delay = baseDelayMs * 2 ** attempt + Math.random() * Math.min(1000, baseDelayMs);
        logger('INFO', `${label}: rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delay);
      }
    }
  };
}

// Usage is summed across steps (each step is one billed call) and across a fallback. The shape
// carries OpenAI names plus the Gemini-style aliases the brain's telemetry reads.
// last_step_input_tokens is the final step's whole prompt: the context-size signal compaction keys on.
function newUsage(prior) {
  return {
    prompt: prior?.prompt_tokens || 0,
    completion: prior?.completion_tokens || 0,
    cacheRead: prior?.cachedContentTokenCount || 0,
    cacheWrite: prior?.cacheCreationTokenCount || 0,
    lastStepInput: prior?.last_step_input_tokens || 0,
    steps: prior?.steps || 0,
    provider: prior?.provider || null,
  };
}

function addUsage(acc, usage, provider) {
  acc.provider = provider;
  if (!usage?.reported) return;
  acc.prompt += usage.input;
  acc.completion += usage.output;
  acc.cacheRead += usage.cacheRead;
  acc.cacheWrite += usage.cacheWrite;
  acc.lastStepInput = usage.input || acc.lastStepInput;
  acc.steps++;
}

function finalizeUsage(acc) {
  return {
    prompt_tokens: acc.prompt,
    completion_tokens: acc.completion,
    total_tokens: acc.prompt + acc.completion,
    promptTokenCount: acc.prompt,
    candidatesTokenCount: acc.completion,
    cachedContentTokenCount: acc.cacheRead,
    cacheCreationTokenCount: acc.cacheWrite,
    last_step_input_tokens: acc.lastStepInput,
    steps: acc.steps,
    provider: acc.provider,
  };
}

// Each model step is its own block. Gluing them raw ran one step's prose into the next step's
// heading ("…confirm the usage.## Step 3: Download"), a transcript that reads as corrupt to the
// verifier that has to judge it.
function appendStepText(text, stepText) {
  if (!stepText) return text;
  const sep = text && !/\n\s*$/.test(text) && !/^\s*\n/.test(stepText) ? '\n\n' : '';
  return text + sep + stepText;
}

const SAFE_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Gives each model call a transcript id. The model's own id (Claude's tool_use id, Gemini's call id)
 * is reused when it is also a valid Claude tool_use id, so the call keeps one id whichever provider
 * continues the turn; otherwise the id is deterministic: 'call_<n>', n counting the calls in the
 * transcript.
 */
function assignCallId(call, transcript, provider) {
  const taken = new Set(transcript.flatMap((m) => (m.toolCalls || []).map((tc) => tc.id)));
  const own = provider === PROVIDERS.anthropic ? call.anthropicId : call.googleId;
  if (own && SAFE_TOOL_USE_ID.test(own) && !taken.has(own)) return own;
  let n = taken.size + 1;
  while (taken.has(`call_${n}`)) n++;
  return `call_${n}`;
}

// A failed step can leave the transcript ending in an assistant tool call with no result. The
// fallback continues only from complete exchanges.
function completeTranscript(history) {
  const out = [...history];
  const last = out[out.length - 1];
  if (last?.role === 'assistant' && last.toolCalls?.length) out.pop();
  return out;
}

function toolResultOf(execution) {
  if (execution === undefined || execution === null) return '';
  if (execution.result !== undefined) return execution.result;
  return execution.error || JSON.stringify(execution);
}

// The images a tool returned for the model to see, in the transcript's shape. Anything else a tool
// put under `images` is dropped: a provider rejects the whole request over one bad image part.
function toolImagesOf(execution) {
  if (!Array.isArray(execution?.images)) return [];
  return execution.images.filter(isTranscriptImage).map((img) => ({
    mimeType: img.mimeType,
    data: img.data,
    ...(img.name ? { name: String(img.name) } : {}),
  }));
}

const SYNTHESIZE_PROMPT = '[SYNTHESIZE NOW] Stop calling tools: the results you need are already in the tool outputs above. Write your final answer to the task now, in prose, from what you have gathered.';
const TOOL_LOG_START = '\n\n---\n[TOOL EXECUTION LOG]';

/**
 * Runs one organ turn on one model.
 *
 * On failure it throws the error with `err.turnState`: the transcript of complete exchanges so far,
 * the tool calls already executed, the text gathered, the steps used and the usage billed. Passing
 * that back as `resume` continues the turn without running those tools again.
 *
 * @param {object}   o
 * @param {object}   o.clients        { google, anthropic } from createModelClients() (or fakes)
 * @param {string}   o.model          e.g. 'vertex-google/gemini-4-argon'
 * @param {string[]} [o.systemBlocks] system text, most stable block first
 * @param {Array}    o.messages       the transcript (see the header); ignored when resuming
 * @param {object}   [o.tools]        { name: { name, description, schema, execute } }; omit for none
 * @param {string}   [o.skillCatalog] the skill index (skill-catalog.mjs), appended to the first
 *                                    system block when the organ has tools
 * @param {object}   [o.limits]       { maxSteps = 12, maxTokens = 8192 }
 * @param {object}   [o.sampling]     { temperature = 0.3, topP = 0.95 }; Claude gets temperature only
 * @param {boolean}  [o.forceToolCall] Gemini must answer every step with a function call
 * @param {number}   [o.sessionCacheBoundary] frozen session messages before this turn's delta
 * @param {string}   [o.affinityKey]  session-affinity key for Claude calls
 * @param {object}   [o.settings]     see DEFAULT_SETTINGS; resolved with resolveSettings()
 * @param {object}   [o.resume]       a failed turn's err.turnState; its transcript keeps the images
 *                                    still attached, so the fallback model sees what the failed one saw
 * @param {Function} [o.logger]       (level, msg) logger
 * @param {Function} [o.sleep]        (ms) => Promise, for retry backoff (injectable for tests)
 * @param {Function} [o.now]          clock in milliseconds
 * @returns {Promise<{text: string, toolCalls: Array, toolRecords: Array, usage: object, finishReason: string, model: string, transcript: Array}>}
 */
export async function runTurn({
  clients,
  model,
  systemBlocks = [],
  messages = [],
  tools,
  skillCatalog = '',
  limits = {},
  sampling = {},
  forceToolCall = false,
  sessionCacheBoundary = 0,
  affinityKey = '',
  settings,
  resume,
  logger = defaultLogger,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const cfg = resolveSettings(settings);
  const maxSteps = Number.isInteger(limits.maxSteps) && limits.maxSteps > 0 ? limits.maxSteps : 12;
  const maxTokens = Number.isInteger(limits.maxTokens) && limits.maxTokens > 0 ? limits.maxTokens : 8192;
  const temperature = Number.isFinite(sampling.temperature) ? sampling.temperature : 0.3;
  const topP = Number.isFinite(sampling.topP) ? sampling.topP : 0.95;
  const toolSet = tools && Object.keys(tools).length > 0 ? tools : undefined;

  const history = resume ? [...resume.transcript] : [...messages];
  const toolCalls = resume ? [...resume.toolCalls] : [];
  let text = resume?.text || '';
  let step = resume?.steps || 0;
  const usage = newUsage(resume?.usage);
  const guard = new LoopGuard(cfg.loopGuard);
  // A continued turn keeps its loop counts: replaying the calls already made means the fallback model
  // gets no fresh budget for a loop the first model was already in.
  for (const tc of toolCalls) guard.check(tc.toolName, tc.args, tc.result);

  const state = () => ({
    model,
    transcript: completeTranscript(history),
    toolCalls: [...toolCalls],
    text,
    steps: step,
    usage: finalizeUsage(usage),
  });

  let finishReason = 'stop';
  let stepper;
  try {
    const { provider, modelId } = parseModel(model);
    const client = clientFor(clients, provider);
    // The skill index is boot-stable: it joins the first block so the stable prefix stays
    // byte-identical across calls.
    const blocks = [...systemBlocks];
    if (toolSet && skillCatalog) blocks[0] = (blocks[0] || '') + skillCatalog;
    const sysBlocks = blocks.filter((b) => typeof b === 'string' && b.length > 0);
    const callWithRetry = retrying(cfg.retry, sleep, logger);

    stepper = provider === PROVIDERS.anthropic
      ? createAnthropicStepper({
        client, modelId, systemBlocks: sysBlocks, tools: toolSet, maxTokens, temperature,
        anthropic: cfg.anthropic, sessionCacheBoundary, affinityKey, callWithRetry, logger,
      })
      : createGoogleStepper({
        client, modelId, systemText: sysBlocks.join('\n\n'), tools: toolSet, maxTokens, temperature, topP,
        forceToolCall, gemini: cfg.gemini, toolImages: cfg.images.geminiPlacement, callWithRetry, logger, now,
      });

    while (step < maxSteps) {
      const out = await stepper.call(history, step);
      addUsage(usage, out.usage, stepper.provider);
      // A model's own text never carries a working tool-log marker: only the gateway writes the log.
      text = appendStepText(text, quoteToolLogMarkers(out.text));

      if (out.calls.length === 0) {
        finishReason = out.finishReason || 'stop';
        break;
      }

      // Serialize parallel tool calls: run only the first. A model that asks for several in one
      // step re-issues the rest on later steps, and a request whose function responses don't match
      // its function calls one for one is rejected. Gemini puts the thought signature on the first
      // call of a parallel set, so the call kept is the one that carries it.
      if (out.calls.length > 1) {
        logger('INFO', `serializing: running only the first of ${out.calls.length} parallel tool calls`);
      }
      const first = out.calls[0];
      const call = {
        id: assignCallId(first, history, stepper.provider),
        name: first.name,
        args: first.args ?? {},
        provider: stepper.provider,
        modelId,
        ...(first.googleId ? { googleId: first.googleId } : {}),
        ...(first.thoughtSignature ? { thoughtSignature: first.thoughtSignature } : {}),
        ...(out.thinking?.length ? { anthropicThinking: out.thinking } : {}),
      };
      history.push({ role: 'assistant', content: out.text || null, toolCalls: [call] });

      const tool = toolSet?.[call.name];
      let result;
      let images = [];
      if (tool) {
        try {
          logger('INFO', `running tool ${call.name} ${JSON.stringify(call.args).slice(0, 200)}`);
          const execution = await tool.execute(call.args);
          result = toolResultOf(execution);
          images = toolImagesOf(execution);
        } catch (err) {
          result = `ERROR: ${err.message}`;
        }
      } else {
        result = `ERROR: Tool "${call.name}" not found in registry`;
      }
      // The tool log and the loop guard see the text; only the transcript carries the image.
      toolCalls.push({ id: call.id, toolName: call.name, args: call.args, result });
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result, ...(images.length ? { images } : {}) });
      if (images.length) history.splice(0, history.length, ...retainImages(history, cfg.images.kept));
      step++;

      const verdict = guard.check(call.name, call.args, result);
      if (verdict.action === 'terminate') {
        logger('WARN', `loop guard stopped the turn: ${verdict.message.split('\n')[0]}`);
        text += `\n\n${verdict.message}`;
        break;
      }
      if (verdict.action === 'nudge') {
        logger('INFO', 'loop guard warning injected');
        history.push({ role: 'user', content: verdict.message });
      }
      if (TERMINAL_TOOLS.has(call.name)) {
        logger('INFO', `terminal tool ${call.name} ran; the turn ends`);
        break;
      }
    }
  } catch (err) {
    err.turnState = state();
    throw err;
  }

  // The tool log: ground truth the model cannot fabricate. toolRecords are the large results, in
  // full, for the brain to store and digest.
  let toolRecords = [];
  if (toolCalls.length > 0) {
    const { log, large } = buildToolLog(toolCalls, cfg.toolRecord);
    toolRecords = large;
    text += `${TOOL_LOG_START}\n${log}\n[END TOOL LOG]`;
    const toolErrors = toolCalls.some((tc) => typeof tc.result === 'string' && tc.result.startsWith('ERROR:'));
    if (toolErrors && /SUCCESS/i.test(text)) {
      text += '\n[WARNING: One or more tool calls returned errors. Verify status accuracy.]';
    }
  }

  // A stopped loop already holds the results the model needs. Give it one tool-less step to answer
  // from them (with no tools it cannot loop again), keeping the tool log. Any failure keeps the stop
  // message.
  if (guard.terminated && cfg.loopGuard.synthesize && stepper?.synthesize) {
    try {
      const out = await stepper.synthesize([...history, { role: 'user', content: SYNTHESIZE_PROMPT }]);
      addUsage(usage, out.usage, stepper.provider);
      if (out.text.trim()) {
        const logAt = text.indexOf(TOOL_LOG_START);
        text = quoteToolLogMarkers(out.text) + (logAt >= 0 ? text.slice(logAt) : '');
        logger('INFO', 'loop guard synthesis answered from the gathered results');
      }
    } catch (e) {
      logger('WARN', `loop guard synthesis failed (${e.message}); keeping the stop message`);
    }
  }

  return {
    text,
    toolCalls,
    toolRecords,
    usage: finalizeUsage(usage),
    finishReason,
    model,
    transcript: completeTranscript(history),
  };
}

/**
 * Runs a turn, and on failure continues it on the fallback model. The fallback picks up the
 * transcript where the failed model left it: the tool calls that already ran stay in history with
 * their results and are not run again (a mutating command never runs twice), and the tool log and
 * usage cover both attempts. A failure before any tool ran is a plain rerun.
 *
 * @param {object} o runTurn's options, plus:
 * @param {string} [o.fallbackModel]
 * @returns {Promise<object>} runTurn's result; `fallbackFrom` names the failed model and its error
 */
export async function runTurnWithFallback({ fallbackModel, ...opts }) {
  try {
    return await runTurn(opts);
  } catch (err) {
    if (!fallbackModel || fallbackModel === opts.model) throw err;
    const resume = err.turnState;
    const logger = opts.logger || defaultLogger;
    logger('WARN', `TELEMETRY fallback_turn primary=${opts.model} fallback=${fallbackModel} `
      + `tools_already_run=${resume?.toolCalls?.length || 0} error="${String(err.message).substring(0, 160)}"`);
    try {
      const result = await runTurn({ ...opts, model: fallbackModel, resume });
      return { ...result, fallbackFrom: { model: opts.model, error: String(err.message) } };
    } catch (fallbackErr) {
      fallbackErr.primaryError = err;
      throw fallbackErr;
    }
  }
}

function defaultLogger(level, msg) {
  console.log(`[gateway] ${level}: ${msg}`);
}
