// Tests for agent/services/ears/preprocess.mjs and its prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPreprocessor, needsPreprocess } from '../../../../agent/services/ears/preprocess.mjs';

const LONG = `Please open the file 1aBcDeFgHiJkLmNopQrStUvWxyZ01234 ${'and check it '.repeat(40)}`;

function fakeTransform(answers) {
  const calls = [];
  const transform = async (text, instruction, opts) => {
    calls.push({ text, instruction, opts });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { transform, calls };
}

test('only long or multi-line text is worth a repair call', () => {
  assert.equal(needsPreprocess('@Paraclete what is on my calendar?'), false);
  assert.equal(needsPreprocess('x'.repeat(501)), true);
  assert.equal(needsPreprocess('one\ntwo\nthree\nfour'), true);
  assert.equal(needsPreprocess('one\ntwo'), false);
  assert.equal(needsPreprocess(''), false);
});

test('a repair the model reports replaces the text; the call gets the prompt and the contract options', async () => {
  const fake = fakeTransform([JSON.stringify({ cleaned: 'repaired text', repairs: ['restored _ in an id'], confidence: 'high' })]);
  const logs = [];
  const preprocess = createPreprocessor({
    enabled: true, prompt: 'REPAIR', transform: fake.transform,
    callOptions: { maxTokens: 2000, temperature: 0, disableThinking: true }, log: (...a) => logs.push(a),
  });
  assert.equal(await preprocess(LONG), 'repaired text');
  assert.deepEqual(fake.calls[0], { text: LONG, instruction: 'REPAIR', opts: { maxTokens: 2000, temperature: 0, disableThinking: true } });
  assert.equal(logs[0][1], 'preprocess repaired a message');
  assert.deepEqual(logs[0][2].repairs, ['restored _ in an id']);
});

test('no repairs, a fenced answer, or an empty cleaned text keep the original', async () => {
  const fake = fakeTransform([
    '```json\n{"cleaned": "changed anyway", "repairs": [], "confidence": "high"}\n```',
    JSON.stringify({ cleaned: '', repairs: ['x'] }),
  ]);
  const preprocess = createPreprocessor({ enabled: true, prompt: 'REPAIR', transform: fake.transform });
  assert.equal(await preprocess(LONG), LONG);
  assert.equal(await preprocess(LONG), LONG);
});

test('a failed, silent or unparseable model never blocks the message', async () => {
  const fake = fakeTransform([null, 'not json at all', new Error('network down')]);
  const preprocess = createPreprocessor({ enabled: true, prompt: 'REPAIR', transform: fake.transform });
  assert.equal(await preprocess(LONG), LONG);
  assert.equal(await preprocess(LONG), LONG);
  assert.equal(await preprocess(LONG), LONG);
});

test('switched off, without a prompt, or for short text, no call is made', async () => {
  const fake = fakeTransform([]);
  assert.equal(await createPreprocessor({ enabled: false, prompt: 'REPAIR', transform: fake.transform })(LONG), LONG);
  assert.equal(await createPreprocessor({ enabled: true, prompt: '', transform: fake.transform })(LONG), LONG);
  assert.equal(await createPreprocessor({ enabled: true, prompt: 'REPAIR', transform: fake.transform })('short'), 'short');
  assert.equal(fake.calls.length, 0);
});

test('the prompt asks for the JSON shape the preprocessor reads', () => {
  const prompt = readFileSync(new URL('../../../../agent/services/ears/preprocess-prompt.md', import.meta.url), 'utf8');
  for (const field of ['"cleaned"', '"repairs"', '"confidence"']) assert.ok(prompt.includes(field), `prompt names ${field}`);
});
