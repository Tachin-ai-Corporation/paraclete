// dev/record-gemini-turn.mjs: records one live gemini-4-argon tool turn as the fixture that
// tests/agent/gateway/gemini-4-replay.test.mjs replays. It runs the gateway's own runTurn against the
// real model with one tool, `lookup`, and captures every generateContent request and response.
//
// Run from the repo root, against a dev project that can call gemini-4-argon:
//   npm run setup
//   GCP_TOKEN=$(gcloud auth print-access-token) node dev/record-gemini-turn.mjs your-dev-project
// Without GCP_TOKEN the SDK uses application default credentials.
// Read the fixture before committing it: it must hold only this synthetic turn.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelClients } from '../agent/gateway/model-clients.mjs';
import { runTurn } from '../agent/gateway/turn-loop.mjs';

const MODEL = 'gemini-4-argon';
const FIXTURE = fileURLToPath(new URL('../tests/agent/gateway/fixtures/gemini-4-tool-turn.json', import.meta.url));

const project = process.argv[2];
if (!project) {
  console.error('usage: node dev/record-gemini-turn.mjs <gcp-project>');
  process.exit(2);
}

const clients = createModelClients({ project, googleLocation: 'global', accessToken: process.env.GCP_TOKEN || undefined });

// Capture each call exactly as the gateway made it and as the API answered it.
const exchanges = [];
const generate = clients.google.models.generateContent.bind(clients.google.models);
clients.google.models.generateContent = async (params) => {
  const request = structuredClone(params);
  const response = await generate(params);
  const plain = JSON.parse(JSON.stringify(response));
  delete plain.sdkHttpResponse; // transport headers, not part of the turn
  exchanges.push({ request, response: plain });
  return response;
};

const lookup = {
  name: 'lookup',
  description: 'Look up the value stored under a key.',
  schema: {
    type: 'object',
    properties: { key: { type: 'string', description: 'The key to look up' } },
    required: ['key'],
  },
  execute: async ({ key }) => ({ result: key === 'alpha' ? 'value-42' : `no value for ${key}` }),
};

const result = await runTurn({
  clients,
  model: `vertex-google/${MODEL}`,
  systemBlocks: ['You answer questions about stored values. Read every value with the lookup tool; never guess one.'],
  messages: [{ role: 'user', content: 'What is the value stored under the key "alpha"? Look it up, then answer in one sentence.' }],
  tools: { lookup },
  limits: { maxSteps: 4, maxTokens: 2048 },
});

const callPart = exchanges[0]?.response?.candidates?.[0]?.content?.parts?.find((p) => p.functionCall);
const problems = [
  !callPart && 'the first response asked for no tool',
  callPart && callPart.functionCall.name !== 'lookup' && `the first call was ${callPart.functionCall.name}, not lookup`,
  callPart && !callPart.functionCall.id && 'the call has no id',
  callPart && !callPart.thoughtSignature && 'the call has no thought signature',
  exchanges.length < 2 && 'the turn made fewer than two model calls',
  !/value-42/.test(result.text) && 'the answer does not contain value-42',
].filter(Boolean);
if (problems.length > 0) {
  console.error(`Not writing the fixture: ${problems.join('; ')}.`);
  console.error(JSON.stringify(exchanges, null, 2));
  process.exit(1);
}

mkdirSync(dirname(FIXTURE), { recursive: true });
writeFileSync(FIXTURE, `${JSON.stringify({ model: MODEL, exchanges }, null, 2)}\n`);
console.log(`Wrote ${FIXTURE}: ${exchanges.length} exchanges, call id ${callPart.functionCall.id}.`);
console.log(result.text);
