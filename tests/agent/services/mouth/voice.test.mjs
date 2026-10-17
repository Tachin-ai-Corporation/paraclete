// Tests for agent/services/mouth/voice.mjs and its prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVoice } from '../../../../agent/services/mouth/voice.mjs';

function fakeTransform(answers) {
  const calls = [];
  return {
    calls,
    transform: async (text, instruction, opts) => { calls.push({ text, instruction, opts }); return answers.shift() ?? null; },
  };
}

const voiceWith = (answers, over = {}) => {
  const fake = fakeTransform(answers);
  const voice = createVoice({
    transform: fake.transform, prompt: 'You are {agent_name}. Voice it as {agent_name}.', agentName: 'Paraclete',
    callOptions: { maxTokens: 2000, temperature: 0.1, disableThinking: true }, ...over,
  });
  return { voice, calls: fake.calls };
};

test('the brain output is voiced, with the conversation, the guidance and the question in order', async () => {
  const { voice, calls } = voiceWith([JSON.stringify({ action: 'deliver', text: 'I found three overdue invoices.' })]);
  const out = await voice({ rawText: 'RESULT: 3 overdue', question: 'Which invoices are overdue?', contextHint: 'Keep it short.', convoTail: '[Ana] check invoices' });
  assert.deepEqual(out, { action: 'deliver', text: 'I found three overdue invoices.', voiced: 'yes' });
  assert.equal(calls[0].instruction, 'You are Paraclete. Voice it as Paraclete.');
  assert.deepEqual(calls[0].opts, { maxTokens: 2000, temperature: 0.1, disableThinking: true });
  const text = calls[0].text;
  const order = ['RECENT CONVERSATION', 'DELIVERY GUIDANCE', 'CONTEXT (what the person asked', 'BRAIN OUTPUT:\nRESULT: 3 overdue'];
  const positions = order.map((s) => text.indexOf(s));
  assert.ok(positions.every((p) => p >= 0), 'every part is there');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('with the model off, the text goes out as the brain wrote it', async () => {
  const { voice, calls } = voiceWith([], { enabled: false });
  assert.deepEqual(await voice({ rawText: 'raw', contextHint: 'Keep it short.' }), { action: 'deliver', text: 'raw', voiced: 'raw' });
  assert.equal(calls.length, 0);
  const noPrompt = voiceWith([], { prompt: '' });
  assert.equal((await noPrompt.voice({ rawText: 'raw' })).voiced, 'raw');
});

test('an unavailable or unparseable model never loses the message', async () => {
  assert.deepEqual(await voiceWith([null]).voice({ rawText: 'raw' }), { action: 'deliver', text: 'raw', voiced: 'unavailable' });
  assert.deepEqual(await voiceWith(['I would say hello']).voice({ rawText: 'raw' }), { action: 'deliver', text: 'raw', voiced: 'unparsed' });
});

test('internal noise is suppressed, but an escalation always reaches a person', async () => {
  const suppress = JSON.stringify({ action: 'suppress', text: '' });
  assert.deepEqual(await voiceWith([suppress]).voice({ rawText: 'iteration 4 of 50' }), { action: 'suppress', text: '', voiced: 'suppressed' });
  const escalated = await voiceWith([JSON.stringify({ action: 'suppress', text: 'I need help with the deploy.' })])
    .voice({ rawText: '[ESCALATE] the deploy keeps failing' });
  assert.deepEqual(escalated, { action: 'deliver', text: 'I need help with the deploy.', voiced: 'yes' });
});

test('a voiced answer with no text gets one plain rephrase, then the raw text', async () => {
  const empty = JSON.stringify({ action: 'deliver', text: '' });
  const retried = voiceWith([empty, 'I checked the invoices and three are overdue.']);
  assert.deepEqual(await retried.voice({ rawText: 'RESULT: 3 overdue' }),
    { action: 'deliver', text: 'I checked the invoices and three are overdue.', voiced: 'retry' });
  assert.match(retried.calls[1].instruction, /^You are Paraclete\. Rephrase the following for chat\./);
  assert.equal(retried.calls[1].text, 'RESULT: 3 overdue');

  assert.deepEqual(await voiceWith([empty, 'ok']).voice({ rawText: 'RESULT: 3 overdue' }),
    { action: 'deliver', text: 'RESULT: 3 overdue', voiced: 'passthrough_empty' });
});

test('an identical rephrase is reported as such', async () => {
  const { voice } = voiceWith([JSON.stringify({ action: 'deliver', text: 'Done.' })]);
  assert.equal((await voice({ rawText: 'Done.' })).voiced, 'passthrough_identical');
});

test('the prompt names the agent and asks for the JSON the voice reads', () => {
  const prompt = readFileSync(new URL('../../../../agent/services/mouth/voice-prompt.md', import.meta.url), 'utf8');
  assert.ok(prompt.includes('{agent_name}'));
  assert.match(prompt, /"action": "deliver" \| "suppress"/);
  assert.match(prompt, /"text"/);
});
