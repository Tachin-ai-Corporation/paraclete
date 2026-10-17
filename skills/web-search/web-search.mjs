#!/usr/bin/env node
// skills/web-search/web-search.mjs: the web-search command. Asks Gemini on Vertex AI a question with
// Google Search grounding and prints the answer, the sources it was grounded in, and the searches that
// ran. It only reads; reading one page in full is web-fetch.mjs. Uses the contracts' fast model and
// Vertex location and the instance's project. Documented in skills/web-search/SKILL.md.

import { pathToFileURL } from 'node:url';
import { getAccessToken as metadataToken } from '../../agent/auth/metadata-token.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { loadInstance } from '../../config/instance.mjs';

export const USAGE = [
  'Usage: web-search "<question>"',
  '       web-search --stdin        (the question on stdin)',
].join('\n');

const SYSTEM_INSTRUCTION = 'Answer the question using Google Search. Be accurate and concise. Rely on the '
  + 'search results, and say plainly when they do not answer the question instead of guessing.';

// Thinking models spend reasoning tokens from the same ceiling as the answer, so the ceiling needs room.
const MAX_OUTPUT_TOKENS = 8192;
const TEMPERATURE = 0.3;
const TIMEOUT_MS = 90_000;

/**
 * The model id and location web-search uses, from the contracts and the instance record.
 *
 * @param {object} contracts
 * @param {object} instance
 * @returns {{project: string, model: string, location: string}}
 */
export function resolveConfig(contracts, instance) {
  const tier = contracts?.vertex?.models?.fast || '';
  const [provider, model] = tier.includes('/') ? tier.split('/', 2) : ['vertex-google', tier];
  if (provider !== 'vertex-google' || !model) {
    throw new Error(`web-search needs a Gemini model; vertex.models.fast is '${tier}'`);
  }
  return { project: instance.project, model, location: contracts.vertex.location || 'global' };
}

/**
 * The generateContent endpoint for a model. The global location has no regional host prefix.
 *
 * @param {{project: string, model: string, location: string}} config
 */
export function endpoint({ project, model, location }) {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

/**
 * The printed result for a generateContent response, or an error when it holds no answer.
 *
 * @param {object} data the parsed response
 * @returns {{text: string} | {error: string}}
 */
export function formatAnswer(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const answer = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  if (!answer) {
    if (candidate?.finishReason === 'MAX_TOKENS') {
      return { error: 'the model used its whole output budget without answering; ask a narrower question' };
    }
    return { error: `Vertex AI returned no answer (finish reason: ${candidate?.finishReason || 'none'})` };
  }

  const meta = candidate.groundingMetadata || {};
  const seen = new Set();
  const sources = [];
  for (const chunk of meta.groundingChunks || []) {
    const uri = chunk?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push(`${sources.length + 1}. ${chunk.web.title || 'untitled'} ${uri}`);
  }
  const lines = [answer, ''];
  if (sources.length > 0) {
    lines.push('Sources:', ...sources);
  } else {
    lines.push('Sources: none returned. The answer above is not grounded in a search result: treat it as unverified.');
  }
  const searches = (meta.webSearchQueries || []).filter(Boolean);
  if (searches.length > 0) lines.push(`Searches: ${searches.join(' | ')}`);
  return { text: lines.join('\n') };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.getAccessToken]
 * @param {Function} [deps.readStdin]  () => Promise<string>
 * @param {{project: string, model: string, location: string}} [deps.config] default: contracts + instance
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const getAccessToken = deps.getAccessToken || metadataToken;
  const readStdin = deps.readStdin || (() => readAll(process.stdin));
  const fail = (message) => { stderr.write(`[web-search] ${message}\n`); return 1; };

  if (argv[0] === '--help' || argv[0] === '-h') { stdout.write(`${USAGE}\n`); return 0; }
  if (argv.length !== 1) return fail(`give one question, quoted, or use --stdin\n${USAGE}`);
  const question = (argv[0] === '--stdin' ? await readStdin() : argv[0]).trim();
  if (!question) return fail(`the question is empty\n${USAGE}`);

  let config = deps.config;
  try {
    if (!config) config = resolveConfig(loadContracts(), loadInstance());
  } catch (err) {
    return fail(err.message);
  }

  let response;
  try {
    const token = await getAccessToken();
    response = await fetchImpl(endpoint(config), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: question }] }],
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(`the request failed: ${err.message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return fail(`Vertex AI returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return fail(`Vertex AI returned a response that is not JSON: ${err.message}`);
  }
  const result = formatAnswer(data);
  if (result.error) return fail(result.error);
  stdout.write(`${result.text}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
