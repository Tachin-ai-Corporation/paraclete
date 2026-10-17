// Replays a recorded gemini-4-argon tool turn through runTurn (agent/gateway/turn-loop.mjs) with a
// fake Google client that answers with the recorded responses. It proves the gateway handles what the
// live model actually returns: the second request sends the functionResponse back with the recorded
// call id, and the model's functionCall part keeps its thought signature.
//
// The fixture is { model, exchanges: [{ request, response }] }: each request is the params object the
// gateway passed to ai.models.generateContent, each response the plain JSON of what came back. The
// turn asks for the value under key 'alpha' with one tool, `lookup`, which returns 'value-42'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runTurn } from '../../../agent/gateway/turn-loop.mjs';
import { lookupTool, quiet, noSleep } from './fakes.mjs';

const FIXTURE = new URL('./fixtures/gemini-4-tool-turn.json', import.meta.url);
const SKIP = !existsSync(FIXTURE) && 'record the fixture with dev/record-gemini-turn.mjs';

test('a recorded gemini-4-argon tool turn replays with its call id and thought signature', { skip: SKIP }, async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(fixture.model, 'gemini-4-argon');
  assert.ok(fixture.exchanges.length >= 2, 'a tool turn takes at least two model calls');

  const recordedCallPart = fixture.exchanges[0].response.candidates[0].content.parts.find((p) => p.functionCall);
  assert.ok(recordedCallPart, 'the first recorded response asks for a tool');
  assert.equal(recordedCallPart.functionCall.name, 'lookup');
  assert.ok(recordedCallPart.functionCall.id, 'gemini-4-argon returns a call id');
  assert.ok(recordedCallPart.thoughtSignature, 'gemini-4-argon returns a thought signature');

  // The same inputs the recorder used, taken from its first request.
  const first = fixture.exchanges[0].request;
  const systemInstruction = first.config.systemInstruction;
  const messages = [{ role: 'user', content: first.contents[0].parts.map((p) => p.text).join('') }];

  const responses = fixture.exchanges.map((e) => structuredClone(e.response));
  const sent = [];
  const google = {
    models: {
      async generateContent(params) {
        sent.push(structuredClone(params));
        if (responses.length === 0) throw new Error('the replay asked for more model calls than were recorded');
        return responses.shift();
      },
    },
  };
  const keys = [];
  const out = await runTurn({
    clients: { google },
    model: `vertex-google/${fixture.model}`,
    systemBlocks: typeof systemInstruction === 'string' ? [systemInstruction] : [],
    messages,
    tools: { lookup: lookupTool(keys) },
    logger: quiet,
    sleep: noSleep,
  });

  assert.deepEqual(keys, ['alpha'], 'the tool ran once, for the recorded arguments');
  const second = sent[1].contents;
  const modelTurn = second.find((c) => c.role === 'model' && c.parts.some((p) => p.functionCall));
  const callPart = modelTurn.parts.find((p) => p.functionCall);
  assert.equal(callPart.functionCall.id, recordedCallPart.functionCall.id);
  assert.equal(callPart.thoughtSignature, recordedCallPart.thoughtSignature);
  const responsePart = second.flatMap((c) => c.parts).find((p) => p.functionResponse);
  assert.deepEqual(responsePart.functionResponse, {
    id: recordedCallPart.functionCall.id,
    name: 'lookup',
    response: { result: 'value-42' },
  });
  assert.match(out.text, /value-42/);
  assert.match(out.text, /\[TOOL\] lookup\({"key":"alpha"}\) → value-42/);
});
