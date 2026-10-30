// Tests for agent/gateway/google-step.mjs: the transcript in Gemini's shape, the schema dialect, and
// explicit context caching.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toGoogleSchema, toGoogleContents, readGoogleStep, createGoogleStepper, isGeminiCacheGone,
  SKIP_THOUGHT_SIGNATURE,
} from '../../../agent/gateway/google-step.mjs';
import { fakeGoogle, geminiText, quiet } from './fakes.mjs';

describe('toGoogleSchema', () => {
  it('strips keywords Gemini does not support and upper-cases types, at every depth', () => {
    const probe = {
      type: 'object',
      additionalProperties: false,
      properties: {
        probes: {
          type: 'array', minItems: 1, maxItems: 3,
          items: { type: 'object', properties: { claim: { type: 'string', pattern: '^x', format: 'uri' } } },
        },
      },
    };
    assert.deepEqual(toGoogleSchema(probe), {
      type: 'OBJECT',
      properties: {
        probes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { claim: { type: 'STRING' } } } },
      },
    });
    assert.equal(probe.properties.probes.minItems, 1, 'the input is not changed');
    assert.equal(toGoogleSchema(undefined), undefined);
  });
});

describe('toGoogleContents', () => {
  it('maps roles, skips system messages, and joins content parts as renderBlocks() would', () => {
    const contents = toGoogleContents([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'boot', tier: 'boot' }, { type: 'text', text: 'tail' }] },
      { role: 'assistant', content: 'decision' },
    ]);
    assert.deepEqual(contents, [
      { role: 'user', parts: [{ text: 'boot\n\ntail' }] },
      { role: 'model', parts: [{ text: 'decision' }] },
    ]);
  });

  it('batches consecutive tool results into one user turn, each with its call id', () => {
    const contents = toGoogleContents([
      { role: 'user', content: 'go' },
      {
        role: 'assistant', content: null, toolCalls: [
          { id: 'call_a', name: 'a', args: {}, provider: 'vertex-google', googleId: 'call_a', thoughtSignature: 's' },
          { id: 'call_b', name: 'b', args: { x: 1 }, provider: 'vertex-google', googleId: 'call_b' },
        ],
      },
      { role: 'tool', toolCallId: 'call_a', name: 'a', content: 'A' },
      { role: 'tool', toolCallId: 'call_b', name: 'b', content: { structured: true } },
    ]);
    assert.equal(contents.length, 3);
    assert.deepEqual(contents[2], {
      role: 'user',
      parts: [
        { functionResponse: { id: 'call_a', name: 'a', response: { result: 'A' } } },
        { functionResponse: { id: 'call_b', name: 'b', response: { structured: true } } },
      ],
    });
    assert.equal('thoughtSignature' in contents[1].parts[1], false, 'only Gemini-returned signatures are echoed');
  });

  it('gives a call another provider made the placeholder signature, and no Gemini id', () => {
    const [call] = toGoogleContents([
      { role: 'assistant', content: 'checking', toolCalls: [{ id: 'toolu_9', name: 'a', args: {}, provider: 'vertex-anthropic' }] },
    ]);
    assert.deepEqual(call.parts, [{ functionCall: { name: 'a', args: {} }, thoughtSignature: SKIP_THOUGHT_SIGNATURE }]);
  });

  describe('a tool result with an image', () => {
    const history = [
      { role: 'user', content: 'look at the chart' },
      {
        role: 'assistant', content: null,
        toolCalls: [{ id: 'call_5', name: 'viewImage', args: { path: 'chart.png' }, provider: 'vertex-google', modelId: 'gemini-4-argon', googleId: 'call_5', thoughtSignature: 'sig' }],
      },
      {
        role: 'tool', toolCallId: 'call_5', name: 'viewImage', content: 'Viewing chart.png: PNG, 2x2 px, 70 bytes. The image is attached to this result.',
        images: [{ mimeType: 'image/png', data: 'iVBORw0K', name: 'chart.png' }],
      },
    ];

    it('goes inside the function response by default (multimodal function responses)', () => {
      const contents = toGoogleContents(history, { modelId: 'gemini-4-argon' });
      assert.deepEqual(contents[2], {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_5',
            name: 'viewImage',
            response: { result: 'Viewing chart.png: PNG, 2x2 px, 70 bytes. The image is attached to this result.' },
            parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } }],
          },
        }],
      });
      assert.deepEqual(toGoogleContents(history, { modelId: 'gemini-4-argon', toolImages: 'function-response' }), contents);
    });

    it("goes after the function responses, in the same user turn, with 'user-part'", () => {
      const contents = toGoogleContents(history, { modelId: 'gemini-4-argon', toolImages: 'user-part' });
      assert.deepEqual(contents[2], {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call_5', name: 'viewImage', response: { result: 'Viewing chart.png: PNG, 2x2 px, 70 bytes. The image is attached to this result.' } } },
          { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } },
        ],
      });
    });

    it('a result without images keeps the plain shape: no parts key', () => {
      const [, , response] = toGoogleContents([history[0], history[1], { ...history[2], images: undefined }]);
      assert.equal('parts' in response.parts[0].functionResponse, false);
    });
  });

  it('echoes a signature only to the Gemini model that made the call', () => {
    const history = [{
      role: 'assistant', content: null,
      toolCalls: [{ id: 'call_1', name: 'a', args: {}, provider: 'vertex-google', modelId: 'gemini-4-argon', googleId: 'call_1', thoughtSignature: 'own' }],
    }];
    assert.equal(toGoogleContents(history, { modelId: 'gemini-4-argon' })[0].parts[0].thoughtSignature, 'own');
    assert.equal(toGoogleContents(history, { modelId: 'gemini-3.8-flash' })[0].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
  });
});

describe('readGoogleStep', () => {
  it('reads calls with their ids and signatures from plain data', () => {
    const step = readGoogleStep({
      candidates: [{ content: { parts: [
        { text: 'calling' },
        { functionCall: { id: 'call_7', name: 'lookup', args: { key: 'k' } }, thoughtSignature: 'sig' },
      ] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    assert.equal(step.text, 'calling');
    assert.deepEqual(step.calls, [{ name: 'lookup', args: { key: 'k' }, googleId: 'call_7', thoughtSignature: 'sig' }]);
    assert.deepEqual(step.usage, { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, reported: true });
  });

  it('treats a response with no candidate as an empty answer', () => {
    const step = readGoogleStep({ promptFeedback: { blockReason: 'SAFETY' } });
    assert.equal(step.text, '');
    assert.deepEqual(step.calls, []);
    assert.equal(step.usage.reported, false);
  });
});

describe('explicit context caching', () => {
  const big = 'x'.repeat(2048 * 4);
  const stepper = (client, systemText, explicitCache = true) => createGoogleStepper({
    client, modelId: 'gemini-4-argon', systemText, maxTokens: 100, temperature: 0.3, topP: 0.9,
    gemini: { explicitCache, explicitCacheTtlSeconds: 3600 },
    callWithRetry: (fn) => fn(), logger: quiet, now: () => 0,
  });

  it('caches a prefix over the floor once, and sends the cache instead of the prefix', async () => {
    const client = fakeGoogle([geminiText('a'), geminiText('b')]);
    await stepper(client, big).call([{ role: 'user', content: 'q' }], 0);
    await stepper(client, big).call([{ role: 'user', content: 'q' }], 0);
    assert.equal(client.cacheCreates.length, 1, 'the second turn reuses the handle');
    assert.equal(client.cacheCreates[0].config.ttl, '3600s');
    assert.equal(client.requests[0].config.cachedContent, 'cachedContents/fake-1');
    assert.equal(client.requests[0].config.systemInstruction, undefined);
  });

  it('sends a prefix under the floor inline, and so does a turn whose cache creation failed', async () => {
    const small = fakeGoogle([geminiText('a')]);
    await stepper(small, 'short system').call([{ role: 'user', content: 'q' }], 0);
    assert.equal(small.cacheCreates.length, 0);
    assert.equal(small.requests[0].config.systemInstruction, 'short system');

    const failing = fakeGoogle([geminiText('a')]);
    failing.caches.create = async () => { throw new Error('quota'); };
    await stepper(failing, big).call([{ role: 'user', content: 'q' }], 0);
    assert.equal(failing.requests[0].config.systemInstruction, big);
  });

  it('is off unless turned on', async () => {
    const client = fakeGoogle([geminiText('a')]);
    await stepper(client, big, false).call([{ role: 'user', content: 'q' }], 0);
    assert.equal(client.cacheCreates.length, 0);
  });

  // The SDK's ApiError: the HTTP status, and the response body as the message.
  const apiError = (status, message) => Object.assign(
    new Error(JSON.stringify({ error: { code: status, message, status: status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT' } })),
    { name: 'ApiError', status },
  );
  const deleted = () => apiError(400, 'Invalid resource state for cache content 4417.');
  const unknown = () => apiError(404, 'Not found: cached content metadata for 4417.');

  it('recognises the errors Vertex gives for a deleted or unknown cache, and nothing else', () => {
    assert.equal(isGeminiCacheGone(deleted()), true);
    assert.equal(isGeminiCacheGone(unknown()), true);
    assert.equal(isGeminiCacheGone(apiError(400, 'Request contains an invalid argument.')), false);
    assert.equal(isGeminiCacheGone(apiError(500, 'Internal error with cached content.')), false);
    assert.equal(isGeminiCacheGone(new Error('fetch failed')), false);
  });

  it('sends a step again inline when its cache is gone, keeps the rest of the turn inline, and makes a new cache next turn', async () => {
    for (const gone of [deleted, unknown]) {
      const client = fakeGoogle([gone(), geminiText('a'), geminiText('b'), geminiText('c')]);
      const turn = stepper(client, big);
      assert.equal((await turn.call([{ role: 'user', content: 'q' }], 0)).text, 'a');
      assert.equal(client.requests[0].config.cachedContent, 'cachedContents/fake-1');
      assert.equal(client.requests[1].config.cachedContent, undefined);
      assert.equal(client.requests[1].config.systemInstruction, big);
      assert.deepEqual(client.requests[1].contents, client.requests[0].contents);

      await turn.call([{ role: 'user', content: 'q' }], 1);
      assert.equal(client.requests[2].config.systemInstruction, big, 'the rest of the turn stays inline');

      await stepper(client, big).call([{ role: 'user', content: 'q' }], 0);
      assert.equal(client.cacheCreates.length, 2, 'the next turn creates a new cache');
      assert.equal(client.requests[3].config.cachedContent, 'cachedContents/fake-1');
    }
  });

  it('throws any other error from a cached step, and keeps the handle', async () => {
    const client = fakeGoogle([apiError(400, 'Request contains an invalid argument.'), geminiText('b')]);
    await assert.rejects(stepper(client, big).call([{ role: 'user', content: 'q' }], 0), /invalid argument/);
    assert.equal(client.requests.length, 1, 'not sent again');
    await stepper(client, big).call([{ role: 'user', content: 'q' }], 0);
    assert.equal(client.cacheCreates.length, 1, 'the next turn reuses the handle');
  });

  it('throws a cache error from a step that sent the prefix inline', async () => {
    const client = fakeGoogle([deleted()]);
    await assert.rejects(stepper(client, 'short system').call([{ role: 'user', content: 'q' }], 0), /cache content/);
    assert.equal(client.requests.length, 1);
  });
});

describe('the stepper places tool images where toolImages says', () => {
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'viewImage', args: { path: 'a.png' }, provider: 'vertex-google' }] },
    { role: 'tool', toolCallId: 'call_1', name: 'viewImage', content: 'Viewing a.png', images: [{ mimeType: 'image/jpeg', data: 'AAAA' }] },
  ];
  const run = async (toolImages) => {
    const client = fakeGoogle([geminiText('a'), geminiText('b')]);
    const s = createGoogleStepper({
      client, modelId: 'gemini-4-argon', systemText: 'sys', maxTokens: 100, temperature: 0.3, topP: 0.9,
      gemini: { explicitCache: false }, toolImages, callWithRetry: (fn) => fn(), logger: quiet, now: () => 0,
    });
    await s.call(history, 1);
    await s.synthesize(history);
    return client.requests.map((r) => r.contents[2].parts);
  };

  it('in the function response by default, on every step and on the loop synthesis', async () => {
    for (const parts of await run(undefined)) {
      assert.deepEqual(parts[0].functionResponse.parts, [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }]);
      assert.equal(parts.length, 1);
    }
  });

  it("as a user part with 'user-part'", async () => {
    for (const parts of await run('user-part')) {
      assert.equal('parts' in parts[0].functionResponse, false);
      assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    }
  });
});
