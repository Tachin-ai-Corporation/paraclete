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

/** The base64 a fake image tool returns for a path: distinct per path, never a real image. */
export const fakePixels = (path) => Buffer.from(`pixels of ${path}`).toString('base64');

/**
 * A fake `viewImage`: returns a text result and one PNG for the path, the shape the real tool returns
 * (agent/gateway/tools.mjs), without touching the disk. Records every path in `calls`.
 */
export function imageTool(calls = []) {
  return {
    name: 'viewImage',
    description: 'Look at an image file.',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async ({ path }) => {
      calls.push(path);
      return {
        result: `Viewing ${path}: PNG, 2x2 px, 70 bytes. The image is attached to this result.`,
        images: [{ mimeType: 'image/png', data: fakePixels(path), name: path }],
      };
    },
  };
}

/** A PNG's signature and IHDR chunk: enough header for the size check, not a decodable image. */
export function pngHeader(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // truecolour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/** A JPEG's start, a JFIF segment and a baseline frame header with the size. */
export function jpegHeader(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

/** A WebP's RIFF header and first chunk, in each of its three encodings. */
export function webpHeader(encoding, width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'latin1');
  if (encoding === 'VP8X') {
    buf.write('VP8X', 12, 'latin1');
    buf.writeUInt32LE(10, 16);
    buf.writeUIntLE(width - 1, 24, 3);
    buf.writeUIntLE(height - 1, 27, 3);
  } else if (encoding === 'VP8L') {
    buf.write('VP8L', 12, 'latin1');
    buf.writeUInt32LE(10, 16);
    buf[20] = 0x2f;
    buf.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  } else {
    buf.write('VP8 ', 12, 'latin1');
    buf.writeUInt32LE(10, 16);
    buf[23] = 0x9d; buf[24] = 0x01; buf[25] = 0x2a;
    buf.writeUInt16LE(width, 26);
    buf.writeUInt16LE(height, 28);
  }
  return buf;
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
