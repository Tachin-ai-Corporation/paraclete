// tests/agent/gateway/fakes.mjs: fake Vertex AI clients and tools for the gateway tests. Each fake
// records the request it was sent, deep-copied at call time, and answers from a script of responses;
// a scripted Error is thrown instead. Responses are plain JSON, the shape the SDKs return.

export const quiet = () => {};
export const noSleep = async () => {};

/** A fake GoogleGenAI client: models.generateContent and caches.create. */
export function fakeGoogle(responses = [], { cacheName = 'cachedContents/fake-1' } = {}) {
  const requests = [];
  const cacheCreates = [];
  return {
    requests,
    cacheCreates,
    models: {
      async generateContent(params) {
        requests.push(structuredClone(params));
        if (responses.length === 0) throw new Error('fake Gemini: no scripted response left');
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    caches: {
      async create(params) {
        cacheCreates.push(structuredClone(params));
        return { name: cacheName };
      },
    },
  };
}

/** A fake AnthropicVertex client: messages.stream(params, options).finalMessage(). */
export function fakeAnthropic(responses = []) {
  const requests = [];
  return {
    requests,
    messages: {
      stream(params, options) {
        requests.push({ params: structuredClone(params), options: options ? structuredClone(options) : undefined });
        return {
          async finalMessage() {
            if (responses.length === 0) throw new Error('fake Claude: no scripted response left');
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next;
          },
        };
      },
    },
  };
}

const geminiUsage = { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 0 };

/** A Gemini response asking for one or more function calls. */
export function geminiCalls(calls, { text } = {}) {
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: [
          ...(text ? [{ text }] : []),
          ...calls.map(({ name, args, id, signature }) => ({
            functionCall: { ...(id ? { id } : {}), name, args },
            ...(signature ? { thoughtSignature: signature } : {}),
          })),
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: { ...geminiUsage },
  };
}

/** A Gemini response with text only. */
export function geminiText(text, finishReason = 'STOP') {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
    usageMetadata: { ...geminiUsage },
  };
}

const claudeUsage = { input_tokens: 80, output_tokens: 12, cache_read_input_tokens: 15, cache_creation_input_tokens: 5 };

/** A Claude message asking for one or more tool calls. */
export function claudeCalls(calls, { text } = {}) {
  return {
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map(({ id, name, input }) => ({ type: 'tool_use', id, name, input })),
    ],
    stop_reason: 'tool_use',
    usage: { ...claudeUsage },
  };
}

/** A Claude message with text only. */
export function claudeText(text) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { ...claudeUsage } };
}

/** An HTTP 500 from a provider. */
export function providerError(message = 'INTERNAL: backend error') {
  const err = new Error(message);
  err.status = 500;
  return err;
}

/** The `lookup` tool: returns 'value-42' for key 'alpha'. Records every call in `calls`. */
export function lookupTool(calls = []) {
  return {
    name: 'lookup',
    description: 'Look up the value stored under a key.',
    schema: { type: 'object', properties: { key: { type: 'string', description: 'The key' } }, required: ['key'] },
    execute: async ({ key }) => {
      calls.push(key);
      return { result: key === 'alpha' ? 'value-42' : `no value for ${key}` };
    },
  };
}

/** A tool that records its calls and returns a fixed result. */
export function recordingTool(name, result, calls = []) {
  return {
    name,
    description: `The ${name} tool.`,
    schema: { type: 'object', properties: { x: { type: 'string' } } },
    execute: async (args) => {
      calls.push(args);
      return { result };
    },
  };
}
