// agent/gateway/anthropic-step.mjs: one Claude step of the turn loop. Turns the gateway's transcript
// into Anthropic messages, places prompt-caching breakpoints, and calls the model by streaming. The
// loop itself (tools, guards, fallback) is turn-loop.mjs; the Gemini side is google-step.mjs.
//
// Three rules here were each learned from a request the provider rejected:
//   - send temperature only: Claude Opus rejects a request with both temperature and top_p;
//   - stream: the SDK refuses a non-streaming request it expects to run past ten minutes, and
//     stream().finalMessage() returns the same message create() would;
//   - only API fields reach the provider. The brain's content parts carry a `tier` hint for
//     breakpoint placement, stripped before sending; tool_use and tool_result blocks pass through
//     untouched (apiContentBlock). Rebuilding them as text parts dropped their payload, and every
//     step after a tool call was rejected and fell back to another model.
//
// A tool result's images (viewImage) go inside its tool_result, as base64 image blocks after the
// result's text.

import { computeBreakpointLayout, estimateTokens, apiContentBlock, isTextOnly } from '../context/prompt-blocks.mjs';
import { PROVIDERS } from './model-clients.mjs';

/**
 * A cache_control marker. '5m' is the provider's default, so its ttl field is left out.
 *
 * @param {string} ttl '5m' or '1h'
 * @returns {object}
 */
export function cacheControl(ttl) {
  return ttl && ttl !== '5m' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
}

/**
 * The transcript as Anthropic messages (see turn-loop.mjs for the transcript format). Text parts keep
 * their `tier` hint for breakpoint placement; toApiMessages() or a breakpoint pass removes it.
 *
 * @param {Array<object>} messages
 * @returns {Array<{role: 'user'|'assistant', content: string|Array<object>}>}
 */
export function toAnthropicMessages(messages) {
  return messages.filter((msg) => msg.role !== 'system').map((msg) => {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
          ...msg.toolCalls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} })),
        ],
      };
    }

    if (msg.role === 'tool') {
      const text = msg.content !== null && typeof msg.content === 'object' ? JSON.stringify(msg.content) : String(msg.content ?? '');
      const images = (msg.images || []).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } }));
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          // A tool result with images is a block list: its text (the API rejects an empty text block),
          // then each image. Without images it stays a plain string.
          content: images.length > 0 ? [...(text ? [{ type: 'text', text }] : []), ...images] : text,
        }],
      };
    }

    if (Array.isArray(msg.content)) {
      return {
        role,
        content: msg.content.map((p) => {
          if (p?.type && p.type !== 'text') return p;
          return { type: 'text', text: p?.text || '', ...(p?.tier ? { tier: p.tier } : {}) };
        }),
      };
    }
    return { role, content: msg.content || '' };
  });
}

/**
 * Strips every non-API field from array-content messages, in place. Used when no breakpoint pass
 * runs, so a `tier` hint never reaches the provider whatever the caching settings.
 *
 * @param {Array<object>} anthropicMessages
 */
export function toApiMessages(anthropicMessages) {
  for (const msg of anthropicMessages) {
    if (Array.isArray(msg.content)) msg.content = msg.content.map(apiContentBlock);
  }
}

/**
 * Places cache_control on the brain's content parts (the first text-only user message), by the layout
 * in computeBreakpointLayout(), and strips tier hints from every array-content message, in place.
 * Tool blocks pass through intact. Logs each part's token estimate, so a part under the provider's
 * cache floor (about 4,096 tokens for Opus) explains its own miss.
 *
 * @param {Array<object>} anthropicMessages
 * @param {object} o
 * @param {number} o.systemBreakpointsUsed
 * @param {string} o.ttlStable
 * @param {string} o.ttlMission
 * @param {Function} [o.logger]
 */
export function applyMessageBreakpoints(anthropicMessages, { systemBreakpointsUsed, ttlStable, ttlMission, logger = () => {} }) {
  const first = anthropicMessages.find((m) => m.role === 'user' && isTextOnly(m.content));
  for (const msg of anthropicMessages) {
    if (!Array.isArray(msg.content)) continue;
    if (msg === first) {
      const layout = computeBreakpointLayout(msg.content, { systemBreakpointsUsed, ttlStable, ttlMission });
      const sizes = msg.content.map((p) => `${p.tier || 'volatile'}≈${estimateTokens(p.text)}tok`).join(' ');
      logger('INFO', `cache breakpoints: ${layout.length} message breakpoint(s) [${sizes}]`);
      msg.content = msg.content.map((p, i) => {
        const bp = layout.find((b) => b.index === i);
        const clean = { type: 'text', text: p.text };
        return bp ? { ...clean, cache_control: cacheControl(bp.ttl) } : clean;
      });
    } else {
      msg.content = msg.content.map(apiContentBlock);
    }
  }
}

/**
 * On a session continue, places one rolling breakpoint at the end of the frozen prefix (everything
 * the gateway stored before this turn's delta), so the byte-stable transcript is read from cache and
 * only the delta is billed in full. With the system breakpoint that makes two, under the provider's
 * limit of four. The boundary message may be an assistant string turn or a user content-parts array.
 * Tier hints are stripped everywhere; tool blocks pass through intact. In place.
 *
 * @param {Array<object>} anthropicMessages
 * @param {number} boundaryIndex number of frozen messages before the delta
 * @param {object} o
 * @param {string} o.ttlMission
 * @param {Function} [o.logger]
 */
export function applySessionBoundaryBreakpoint(anthropicMessages, boundaryIndex, { ttlMission, logger = () => {} }) {
  const idx = boundaryIndex - 1;
  anthropicMessages.forEach((msg, i) => {
    if (i === idx) {
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(apiContentBlock);
        parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: cacheControl(ttlMission) };
        msg.content = parts;
      } else {
        msg.content = [{ type: 'text', text: msg.content || '', cache_control: cacheControl(ttlMission) }];
      }
    } else if (Array.isArray(msg.content)) {
      msg.content = msg.content.map(apiContentBlock);
    }
  });
  logger('INFO', `session cache breakpoint at the frozen-prefix boundary (message ${idx}, ttl=${ttlMission})`);
}

/**
 * The system field. With prompt caching on, the stable first block carries the one system breakpoint;
 * later blocks (working memory) stay uncached, because their churn is why they come last.
 *
 * @param {string[]} systemBlocks
 * @param {{promptCaching: boolean, cacheTtlStable: string}} anthropic
 * @returns {string|Array<object>|undefined}
 */
export function anthropicSystem(systemBlocks, anthropic) {
  if (systemBlocks.length === 0) return undefined;
  if (!anthropic.promptCaching) return systemBlocks.join('\n');
  return systemBlocks.map((text, i) => (i === 0
    ? { type: 'text', text, cache_control: cacheControl(anthropic.cacheTtlStable) }
    : { type: 'text', text }));
}

/**
 * One Claude response, read from plain data.
 *
 * @param {object} response the final message
 * @returns {{text: string, calls: Array<{id: string, name: string, args: object}>, finishReason: string|undefined, usage: object}}
 */
export function readAnthropicStep(response) {
  const content = response?.content || [];
  const text = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
  const calls = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ anthropicId: b.id, name: b.name, args: b.input ?? {} }));
  const u = response?.usage || {};
  // Anthropic reports uncached input, cache reads and cache writes separately; the prompt the model
  // attended to is their sum, which matches Gemini's promptTokenCount.
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  return {
    text,
    calls,
    finishReason: response?.stop_reason,
    usage: {
      input: (u.input_tokens || 0) + cacheRead + cacheWrite,
      output: u.output_tokens || 0,
      cacheRead,
      cacheWrite,
      reported: Boolean(response?.usage),
    },
  };
}

/**
 * The Claude side of one turn: call() runs one step on the transcript. There is no synthesize(): a
 * tool-less request whose history holds tool blocks needs the tools declared, so a stopped loop on
 * Claude keeps its stop message.
 *
 * @param {object}   o
 * @param {object}   o.client        an AnthropicVertex client (or a fake with messages.stream)
 * @param {string}   o.modelId
 * @param {string[]} o.systemBlocks
 * @param {object}   [o.tools]
 * @param {number}   o.maxTokens
 * @param {number}   o.temperature
 * @param {object}   o.anthropic     { promptCaching, messageBreakpoints, sessionAffinity, cacheTtlStable, cacheTtlMission }
 * @param {number}   [o.sessionCacheBoundary] frozen messages before this turn's delta (0: none)
 * @param {string}   [o.affinityKey] keeps consecutive calls on one backend so cache reads hit
 * @param {Function} o.callWithRetry
 * @param {Function} o.logger
 */
export function createAnthropicStepper({
  client, modelId, systemBlocks, tools, maxTokens, temperature, anthropic,
  sessionCacheBoundary = 0, affinityKey = '', callWithRetry, logger,
}) {
  const anthropicTools = tools
    ? Object.values(tools).map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))
    : undefined;
  const system = anthropicSystem(systemBlocks, anthropic);
  // Session affinity: load-balanced Vertex endpoints only serve cache reads when consecutive calls
  // land on the same backend.
  const requestOptions = anthropic.sessionAffinity && affinityKey
    ? { headers: { 'X-Vertex-Ai-Session-Id': affinityKey } }
    : undefined;

  return {
    provider: PROVIDERS.anthropic,

    async call(history, step) {
      const messages = toAnthropicMessages(history);
      if (anthropic.promptCaching && anthropic.messageBreakpoints) {
        if (sessionCacheBoundary > 0) {
          applySessionBoundaryBreakpoint(messages, sessionCacheBoundary, { ttlMission: anthropic.cacheTtlMission, logger });
        } else {
          applyMessageBreakpoints(messages, {
            systemBreakpointsUsed: 1, ttlStable: anthropic.cacheTtlStable, ttlMission: anthropic.cacheTtlMission, logger,
          });
        }
      } else {
        toApiMessages(messages);
      }
      const params = {
        model: modelId,
        max_tokens: maxTokens,
        ...(system !== undefined ? { system } : {}),
        messages,
        ...(anthropicTools ? { tools: anthropicTools } : {}),
        temperature,
      };
      logger('INFO', `calling Claude ${modelId} (step ${step})`);
      const response = await callWithRetry(async () => {
        const stream = client.messages.stream(params, requestOptions);
        return stream.finalMessage();
      }, `Claude ${modelId} step ${step}`);
      return readAnthropicStep(response);
    },
  };
}
