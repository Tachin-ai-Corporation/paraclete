// Tests for agent/gateway/turn-loop.mjs: the tool loop on both providers, the tool log, the loop
// guard, and a fallback that continues the transcript instead of rerunning tools.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, runTurnWithFallback, resolveSettings, DEFAULT_SETTINGS } from '../../../agent/gateway/turn-loop.mjs';
import { SKIP_THOUGHT_SIGNATURE } from '../../../agent/gateway/google-step.mjs';
import {
  fakeGoogle, fakeAnthropic, geminiCalls, geminiText, claudeCalls, claudeText, providerError,
  lookupTool, recordingTool, quiet, noSleep,
} from './fakes.mjs';

const GEMINI = 'vertex-google/gemini-4-argon';
const FLASH = 'vertex-google/gemini-3.8-flash';
const CLAUDE = 'vertex-anthropic/claude-opus-test';
const ask = [{ role: 'user', content: 'What is the value for key alpha?' }];
const base = { logger: quiet, sleep: noSleep };

describe('a Gemini tool turn', () => {
  it('sends each functionResponse back with the call id, and keeps the thought signature on the call', async () => {
    const google = fakeGoogle([
      geminiCalls([{ id: 'call_334802', name: 'lookup', args: { key: 'alpha' }, signature: 'c2lnLTE=' }]),
      geminiText('The value is value-42.'),
    ]);
    const keys = [];
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { lookup: lookupTool(keys) } });

    assert.deepEqual(keys, ['alpha'], 'the tool ran once');
    const second = google.requests[1].contents;
    assert.deepEqual(second[1], {
      role: 'model',
      parts: [{ functionCall: { id: 'call_334802', name: 'lookup', args: { key: 'alpha' } }, thoughtSignature: 'c2lnLTE=' }],
    });
    assert.deepEqual(second[2], {
      role: 'user',
      parts: [{ functionResponse: { id: 'call_334802', name: 'lookup', response: { result: 'value-42' } } }],
    });
    assert.match(out.text, /^The value is value-42\./);
    assert.match(out.text, /\[TOOL EXECUTION LOG\]\n\[TOOL\] lookup\({"key":"alpha"}\) → value-42\n\[END TOOL LOG\]/);
    assert.equal(out.toolCalls[0].id, 'call_334802', 'the Gemini id is the transcript id');
    assert.equal(out.model, GEMINI);
  });

  it('sends no id when the model gave none (older Gemini models)', async () => {
    const google = fakeGoogle([geminiCalls([{ name: 'lookup', args: { key: 'alpha' } }]), geminiText('done')]);
    await runTurn({ ...base, clients: { google }, model: FLASH, messages: ask, tools: { lookup: lookupTool() } });
    const [, call, response] = google.requests[1].contents;
    assert.equal('id' in call.parts[0].functionCall, false);
    assert.equal('thoughtSignature' in call.parts[0], false, 'a Gemini call without a signature stays without');
    assert.equal('id' in response.parts[0].functionResponse, false);
  });

  it('declares tools, sends temperature and topP, and the system blocks as one instruction', async () => {
    const google = fakeGoogle([geminiText('ok')]);
    await runTurn({
      ...base, clients: { google }, model: GEMINI, systemBlocks: ['stable', 'memory'], messages: ask,
      tools: { lookup: lookupTool() }, limits: { maxTokens: 1000 }, sampling: { temperature: 0.2, topP: 0.8 },
    });
    const { config, model } = google.requests[0];
    assert.equal(model, 'gemini-4-argon');
    assert.equal(config.systemInstruction, 'stable\n\nmemory');
    assert.equal(config.tools[0].functionDeclarations[0].name, 'lookup');
    assert.equal(config.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
    assert.deepEqual([config.temperature, config.topP, config.maxOutputTokens], [0.2, 0.8, 1000]);
    assert.equal(config.toolConfig, undefined, 'mode AUTO unless the organ must answer with a call');
  });

  it('forces a function call on every step for an organ that must (the verifier)', async () => {
    const google = fakeGoogle([geminiCalls([{ name: 'report_pass', args: { reasoning: 'ok', checks: [] } }])]);
    const pass = recordingTool('report_pass', 'PASS');
    await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { report_pass: pass }, forceToolCall: true });
    assert.deepEqual(google.requests[0].config.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  });

  it('appends the skill catalog to the first system block, only for an organ with tools', async () => {
    const google = fakeGoogle([geminiText('a'), geminiText('b')]);
    const catalog = '\n\n## Available Skills\n- files';
    await runTurn({ ...base, clients: { google }, model: GEMINI, systemBlocks: ['stable', 'memory'], messages: ask, tools: { lookup: lookupTool() }, skillCatalog: catalog });
    await runTurn({ ...base, clients: { google }, model: GEMINI, systemBlocks: ['stable', 'memory'], messages: ask, skillCatalog: catalog });
    assert.equal(google.requests[0].config.systemInstruction, `stable${catalog}\n\nmemory`);
    assert.equal(google.requests[1].config.systemInstruction, 'stable\n\nmemory');
  });

  it('separates the text of successive steps', async () => {
    const google = fakeGoogle([
      geminiCalls([{ name: 'lookup', args: { key: 'alpha' } }], { text: '## Step 1: look it up' }),
      geminiText('## Step 2: answer'),
    ]);
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { lookup: lookupTool() } });
    assert.match(out.text, /^## Step 1: look it up\n\n## Step 2: answer/);
  });

  it('reads plain response data and ignores thought parts', async () => {
    const google = fakeGoogle([{
      candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, cachedContentTokenCount: 2 },
    }]);
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask });
    assert.equal(out.text, 'answer');
    assert.equal(out.finishReason, 'STOP');
    assert.equal(out.usage.prompt_tokens, 7);
    assert.equal(out.usage.cachedContentTokenCount, 2);
  });
});

describe('a Claude tool turn', () => {
  it('streams, sends temperature only, and pairs tool_result with the tool_use id', async () => {
    const anthropic = fakeAnthropic([
      claudeCalls([{ id: 'toolu_01', name: 'lookup', input: { key: 'alpha' } }], { text: 'Looking it up.' }),
      claudeText('The value is value-42.'),
    ]);
    const keys = [];
    const out = await runTurn({
      ...base, clients: { anthropic }, model: CLAUDE, systemBlocks: ['stable'], messages: ask,
      tools: { lookup: lookupTool(keys) }, sampling: { temperature: 0.3, topP: 0.9 },
    });
    assert.deepEqual(keys, ['alpha']);
    const first = anthropic.requests[0].params;
    assert.equal(first.temperature, 0.3);
    assert.equal('top_p' in first, false, 'Claude Opus rejects temperature together with top_p');
    assert.equal(first.tools[0].input_schema.type, 'object');
    const [, assistant, result] = anthropic.requests[1].params.messages;
    assert.deepEqual(assistant.content, [
      { type: 'text', text: 'Looking it up.' },
      { type: 'tool_use', id: 'toolu_01', name: 'lookup', input: { key: 'alpha' } },
    ]);
    assert.deepEqual(result.content, [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'value-42' }]);
    assert.match(out.text, /^Looking it up\.\n\nThe value is value-42\./);
    assert.equal(out.usage.prompt_tokens, 200, 'input + cache reads + cache writes, two steps');
    assert.equal(out.usage.cacheCreationTokenCount, 10);
    assert.equal(out.usage.provider, 'vertex-anthropic');
  });
});

describe('the loop', () => {
  it('runs only the first of parallel calls; the model re-issues the rest', async () => {
    const google = fakeGoogle([
      geminiCalls([
        { id: 'call_1', name: 'lookup', args: { key: 'alpha' }, signature: 'sig-a' },
        { id: 'call_2', name: 'lookup', args: { key: 'beta' } },
      ]),
      geminiText('done'),
    ]);
    const keys = [];
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { lookup: lookupTool(keys) } });
    assert.deepEqual(keys, ['alpha']);
    const replayed = google.requests[1].contents[1].parts;
    assert.equal(replayed.length, 1, 'one call, one response');
    assert.equal(replayed[0].thoughtSignature, 'sig-a', 'the kept call is the one carrying the signature');
    assert.equal(out.toolCalls.length, 1);
  });

  it('ends the turn when a terminal tool runs', async () => {
    const google = fakeGoogle([
      geminiCalls([{ name: 'report_pass', args: { reasoning: 'met', checks: [] } }]),
      geminiText('never asked for'),
    ]);
    const pass = recordingTool('report_pass', '{"verdict":"PASS"}');
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { report_pass: pass } });
    assert.equal(google.requests.length, 1, 'no model call after the verdict');
    assert.match(out.text, /\[TOOL\] report_pass\(/);
  });

  it('records an unknown tool as an error result and warns when the text claims success', async () => {
    const google = fakeGoogle([
      geminiCalls([{ name: 'nope', args: {} }]),
      geminiText('SUCCESS: all done'),
    ]);
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { lookup: lookupTool() } });
    assert.match(out.text, /\[TOOL\] nope\(\{\}\) → ERROR: Tool "nope" not found in registry/);
    assert.match(out.text, /\[WARNING: One or more tool calls returned errors\. Verify status accuracy\.\]$/);
  });

  it('turns a throwing tool into an ERROR result instead of failing the turn', async () => {
    const google = fakeGoogle([geminiCalls([{ name: 'boom', args: {} }]), geminiText('noted')]);
    const boom = { name: 'boom', description: 'b', schema: { type: 'object' }, execute: async () => { throw new Error('disk full'); } };
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { boom } });
    assert.equal(out.toolCalls[0].result, 'ERROR: disk full');
  });

  it('stops at the step budget', async () => {
    const google = fakeGoogle([
      geminiCalls([{ name: 'lookup', args: { key: 'a' } }]),
      geminiCalls([{ name: 'lookup', args: { key: 'b' } }]),
      geminiText('never asked for'),
    ]);
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { lookup: lookupTool() }, limits: { maxSteps: 2 } });
    assert.equal(google.requests.length, 2);
    assert.equal(out.toolCalls.length, 2);
  });

  it('warns once, then stops a loop that keeps getting the same result, and answers from what it gathered', async () => {
    const same = () => geminiCalls([{ name: 'lookup', args: { key: 'alpha' } }]);
    const google = fakeGoogle([same(), same(), same(), geminiText('From what I gathered: value-42.')]);
    const keys = [];
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, tools: { lookup: lookupTool(keys) } });
    assert.equal(keys.length, 3, 'stopped on the third identical result');
    assert.ok(google.requests[2].contents.some((c) => c.parts.some((p) => /\[WARNING\] lookup just returned the exact same result/.test(p.text || ''))), 'the warning reached the model');
    const synthesis = google.requests[3];
    assert.equal(synthesis.config.tools, undefined, 'the synthesis step has no tools');
    assert.match(synthesis.contents.at(-1).parts[0].text, /\[SYNTHESIZE NOW\]/);
    assert.match(out.text, /^From what I gathered: value-42\.\n\n---\n\[TOOL EXECUTION LOG\]/, 'the answer replaces the stop message; the log stays');
  });

  it('keeps the stop message when synthesis is turned off', async () => {
    const same = () => geminiCalls([{ name: 'lookup', args: { key: 'alpha' } }]);
    const google = fakeGoogle([same(), same(), same()]);
    const out = await runTurn({
      ...base, clients: { google }, model: GEMINI, messages: ask, tools: { lookup: lookupTool() },
      settings: { loopGuard: { synthesize: false } },
    });
    assert.equal(google.requests.length, 3);
    assert.match(out.text, /\[LOOP DETECTED\] lookup returned a byte-identical result 3 times/);
  });

  it('retries a rate-limited call with backoff, then succeeds', async () => {
    const limited = new Error('429 RESOURCE_EXHAUSTED');
    limited.status = 429;
    const google = fakeGoogle([limited, geminiText('ok')]);
    const waits = [];
    const out = await runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(out.text, 'ok');
    assert.equal(waits.length, 1);
  });

  it('does not retry other errors, and the error carries the turn state', async () => {
    const google = fakeGoogle([providerError()]);
    await assert.rejects(runTurn({ ...base, clients: { google }, model: GEMINI, messages: ask }), (err) => {
      assert.equal(google.requests.length, 1);
      assert.deepEqual(err.turnState.transcript, ask);
      assert.deepEqual(err.turnState.toolCalls, []);
      return true;
    });
  });

  it('fails clearly when Claude is not turned on', async () => {
    await assert.rejects(
      runTurn({ ...base, clients: { google: fakeGoogle() }, model: CLAUDE, messages: ask }),
      /Claude is not turned on/,
    );
  });
});

describe('the fallback continues the turn; tools never run twice', () => {
  it('Gemini to Claude: the executed call and its result stay in history, under the Gemini call id', async () => {
    const google = fakeGoogle([
      geminiCalls([{ id: 'call_334802', name: 'lookup', args: { key: 'alpha' }, signature: 'sig-1' }]),
      providerError(),
    ]);
    const anthropic = fakeAnthropic([claudeText('The value is value-42.')]);
    const keys = [];
    const out = await runTurnWithFallback({
      ...base, clients: { google, anthropic }, model: GEMINI, fallbackModel: CLAUDE,
      messages: ask, tools: { lookup: lookupTool(keys) },
    });
    assert.deepEqual(keys, ['alpha'], 'the tool ran once across both attempts');
    const messages = anthropic.requests[0].params.messages;
    assert.deepEqual(messages[1].content, [{ type: 'tool_use', id: 'call_334802', name: 'lookup', input: { key: 'alpha' } }]);
    assert.deepEqual(messages[2].content, [{ type: 'tool_result', tool_use_id: 'call_334802', content: 'value-42' }]);
    assert.match(out.text, /\[TOOL\] lookup\({"key":"alpha"}\) → value-42/, 'the log covers the first attempt');
    assert.equal(out.model, CLAUDE);
    assert.equal(out.fallbackFrom.model, GEMINI);
    assert.equal(out.usage.steps, 2, 'usage covers both attempts');
    assert.equal(out.usage.prompt_tokens, 100 + 100);
  });

  it('Claude to Gemini: the Claude call gets the documented placeholder signature', async () => {
    const anthropic = fakeAnthropic([
      claudeCalls([{ id: 'toolu_01', name: 'lookup', input: { key: 'alpha' } }]),
      providerError('overloaded'),
    ]);
    const google = fakeGoogle([geminiText('The value is value-42.')]);
    const keys = [];
    const out = await runTurnWithFallback({
      ...base, clients: { google, anthropic }, model: CLAUDE, fallbackModel: GEMINI,
      messages: ask, tools: { lookup: lookupTool(keys) },
    });
    assert.deepEqual(keys, ['alpha']);
    const [, call, response] = google.requests[0].contents;
    assert.deepEqual(call, {
      role: 'model',
      parts: [{ functionCall: { name: 'lookup', args: { key: 'alpha' } }, thoughtSignature: SKIP_THOUGHT_SIGNATURE }],
    });
    assert.equal(SKIP_THOUGHT_SIGNATURE, 'skip_thought_signature_validator');
    assert.deepEqual(response, { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { result: 'value-42' } } }] });
    assert.match(out.text, /→ value-42/);
  });

  it('Gemini to another Gemini model: the call keeps its id, and its signature becomes the placeholder', async () => {
    const google = fakeGoogle([
      geminiCalls([{ id: 'call_334802', name: 'lookup', args: { key: 'alpha' }, signature: 'argon-sig' }]),
      providerError(),
      geminiText('The value is value-42.'),
    ]);
    const keys = [];
    await runTurnWithFallback({
      ...base, clients: { google }, model: GEMINI, fallbackModel: FLASH, messages: ask, tools: { lookup: lookupTool(keys) },
    });
    assert.deepEqual(keys, ['alpha']);
    assert.equal(google.requests[1].contents[1].parts[0].thoughtSignature, 'argon-sig', 'the same model gets its own signature');
    const fallback = google.requests[2];
    assert.equal(fallback.model, 'gemini-3.8-flash');
    assert.deepEqual(fallback.contents[1].parts[0], {
      functionCall: { id: 'call_334802', name: 'lookup', args: { key: 'alpha' } },
      thoughtSignature: SKIP_THOUGHT_SIGNATURE,
    });
    assert.equal(fallback.contents[2].parts[0].functionResponse.id, 'call_334802');
  });

  it('a Gemini call without an id gets a deterministic tool_use id on Claude', async () => {
    const google = fakeGoogle([geminiCalls([{ name: 'lookup', args: { key: 'alpha' } }]), providerError()]);
    const anthropic = fakeAnthropic([claudeText('done')]);
    await runTurnWithFallback({
      ...base, clients: { google, anthropic }, model: FLASH, fallbackModel: CLAUDE,
      messages: ask, tools: { lookup: lookupTool() },
    });
    const [, assistant, result] = anthropic.requests[0].params.messages;
    assert.equal(assistant.content[0].id, 'call_1');
    assert.equal(result.content[0].tool_use_id, 'call_1');
  });

  it('continues with the step budget the first model left', async () => {
    const google = fakeGoogle([geminiCalls([{ name: 'lookup', args: { key: 'a' } }]), providerError()]);
    const anthropic = fakeAnthropic([
      claudeCalls([{ id: 'toolu_2', name: 'lookup', input: { key: 'b' } }]),
      claudeText('never asked for'),
    ]);
    const keys = [];
    const out = await runTurnWithFallback({
      ...base, clients: { google, anthropic }, model: GEMINI, fallbackModel: CLAUDE,
      messages: ask, tools: { lookup: lookupTool(keys) }, limits: { maxSteps: 2 },
    });
    assert.deepEqual(keys, ['a', 'b']);
    assert.equal(anthropic.requests.length, 1, 'two steps in all');
    assert.equal(out.toolCalls.length, 2);
  });

  it('a failure before any tool ran is a plain rerun', async () => {
    const google = fakeGoogle([providerError(), geminiText('fine on the fallback')]);
    const out = await runTurnWithFallback({
      ...base, clients: { google }, model: GEMINI, fallbackModel: FLASH, systemBlocks: ['sys'], messages: ask,
    });
    assert.equal(out.text, 'fine on the fallback');
    assert.deepEqual(google.requests[1].contents, google.requests[0].contents);
    assert.equal(google.requests[1].model, 'gemini-3.8-flash');
  });

  it('rethrows when there is no fallback, or it is the same model', async () => {
    await assert.rejects(runTurnWithFallback({ ...base, clients: { google: fakeGoogle([providerError()]) }, model: GEMINI, messages: ask }), /INTERNAL/);
    const google = fakeGoogle([providerError()]);
    await assert.rejects(runTurnWithFallback({ ...base, clients: { google }, model: GEMINI, fallbackModel: GEMINI, messages: ask }), /INTERNAL/);
    assert.equal(google.requests.length, 1);
  });

  it('when the fallback fails too, its error carries the first one', async () => {
    const google = fakeGoogle([providerError('first'), providerError('second')]);
    await assert.rejects(
      runTurnWithFallback({ ...base, clients: { google }, model: GEMINI, fallbackModel: FLASH, messages: ask }),
      (err) => err.message === 'second' && err.primaryError.message === 'first',
    );
  });
});

describe('resolveSettings', () => {
  it('fills defaults and keeps valid values', () => {
    const s = resolveSettings({
      anthropic: { promptCaching: true, cacheTtlMission: '5m' },
      gemini: { explicitCacheTtlSeconds: 600 },
      loopGuard: { duplicateTerminate: 6, synthesize: false },
      toolRecord: { verbatim_chars: 9000 },
    });
    assert.equal(s.anthropic.promptCaching, true);
    assert.equal(s.anthropic.cacheTtlMission, '5m');
    assert.equal(s.anthropic.cacheTtlStable, '1h');
    assert.equal(s.gemini.explicitCacheTtlSeconds, 600);
    assert.equal(s.loopGuard.duplicateTerminate, 6);
    assert.equal(s.loopGuard.synthesize, false);
    assert.equal(s.toolRecord.verbatim_chars, 9000);
    assert.equal(s.retry.maxRetries, DEFAULT_SETTINGS.retry.maxRetries);
  });

  it('ignores invalid values', () => {
    const s = resolveSettings({ anthropic: { promptCaching: 'yes', cacheTtlStable: '2h' }, loopGuard: { identicalTerminate: -1 } });
    assert.equal(s.anthropic.promptCaching, false);
    assert.equal(s.anthropic.cacheTtlStable, '1h');
    assert.equal(s.loopGuard.identicalTerminate, DEFAULT_SETTINGS.loopGuard.identicalTerminate);
  });
});
