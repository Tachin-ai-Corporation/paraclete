// agent/gateway/model-clients.mjs: the Vertex AI SDK clients the gateway calls, and how a model string
// names its provider. It only builds clients; turn-loop.mjs runs turns with them. The gateway service
// builds one set at startup and hands it to createGatewayServer(); tests pass fakes of the same shape.
//
// Model strings are '<provider>/<model id>': 'vertex-google/gemini-4-argon' or
// 'vertex-anthropic/claude-opus-…'. A bare id is a Gemini model.

import { GoogleGenAI } from '@google/genai';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

export const PROVIDERS = Object.freeze({
  google: 'vertex-google',
  anthropic: 'vertex-anthropic',
});

const KNOWN_PROVIDERS = new Set(Object.values(PROVIDERS));

/**
 * Builds the SDK clients. Gemini is always on; Claude is opt-in, so the Anthropic client exists only
 * when an Anthropic location is given. Both SDKs authenticate with application default credentials,
 * which on the VM is its service account through the metadata server.
 *
 * @param {object}   options
 * @param {string}   options.project              the Google Cloud project
 * @param {string}   [options.googleLocation]     Vertex location for Gemini; gemini-4-argon answers only on 'global'
 * @param {string}   [options.anthropicLocation]  Vertex region for Claude; omit to leave Claude off
 * @param {string}   [options.accessToken]        a fixed access token instead of application default
 *                                                credentials, for running off the VM (a developer's
 *                                                `gcloud auth print-access-token`). Leave unset on the VM.
 * @param {object}   [options.sdk]                { GoogleGenAI, AnthropicVertex } constructors (injectable for tests)
 * @param {Function} [options.logger]             (level, msg) logger
 * @returns {{project: string, googleLocation: string, anthropicLocation: string|null, google: object, anthropic: object|null}}
 */
export function createModelClients({
  project,
  googleLocation = 'global',
  anthropicLocation,
  accessToken,
  sdk = { GoogleGenAI, AnthropicVertex },
  logger = defaultLogger,
} = {}) {
  if (!project) throw new Error('createModelClients: project is required');
  // Both SDKs ask an auth client for request headers on every call (the Anthropic SDK stores an
  // `accessToken` option but never uses it), so a fixed token goes in as the auth client.
  const authClient = accessToken ? fixedTokenAuthClient(accessToken) : null;
  const google = new sdk.GoogleGenAI({
    vertexai: true,
    project,
    location: googleLocation,
    ...(authClient && { googleAuthOptions: { authClient } }),
  });

  let anthropic = null;
  if (anthropicLocation) {
    try {
      anthropic = new sdk.AnthropicVertex({ projectId: project, region: anthropicLocation, ...(authClient && { authClient }) });
    } catch (err) {
      // Claude is an upgrade, never a dependency: a client that cannot be built leaves it off, and any
      // organ routed to it lands on its fallback model.
      logger('WARN', `Anthropic client unavailable: ${err.message}`);
    }
  }
  logger('INFO', `model clients: project=${project} google=${googleLocation} anthropic=${anthropic ? anthropicLocation : 'off'}`);
  return { project, googleLocation, anthropicLocation: anthropic ? anthropicLocation : null, google, anthropic };
}

/** The minimal auth client both SDKs need: they only ever ask it for request headers. */
function fixedTokenAuthClient(accessToken) {
  return { getRequestHeaders: async () => new Headers({ Authorization: `Bearer ${accessToken}` }) };
}

/**
 * Splits a model string into its provider and model id. A bare id is a Gemini model.
 *
 * @param {string} modelString e.g. 'vertex-google/gemini-4-argon'
 * @returns {{provider: string, modelId: string}}
 */
export function parseModel(modelString) {
  const s = String(modelString || '').trim();
  if (!s) throw new Error('parseModel: a model is required');
  const slash = s.indexOf('/');
  if (slash < 0) return { provider: PROVIDERS.google, modelId: s };
  const provider = s.slice(0, slash);
  const modelId = s.slice(slash + 1);
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`parseModel: unknown provider '${provider}' in '${s}' (expected ${[...KNOWN_PROVIDERS].join(' or ')})`);
  }
  if (!modelId) throw new Error(`parseModel: no model id in '${s}'`);
  return { provider, modelId };
}

/**
 * The client for a provider, or an error that says why there is none.
 *
 * @param {object} clients output of createModelClients()
 * @param {string} provider
 * @returns {object}
 */
export function clientFor(clients, provider) {
  const client = provider === PROVIDERS.anthropic ? clients?.anthropic : clients?.google;
  if (!client) {
    throw new Error(provider === PROVIDERS.anthropic
      ? 'Claude is not turned on: the gateway has no Anthropic client'
      : 'the gateway has no Gemini client');
  }
  return client;
}

/**
 * Which providers have a client, and where. Served by /v1/models, /ready and /status.
 *
 * @param {object} clients output of createModelClients()
 * @returns {Record<string, {available: boolean, location: string|null}>}
 */
export function providerStatus(clients) {
  return {
    [PROVIDERS.google]: { available: Boolean(clients?.google), location: clients?.googleLocation ?? null },
    [PROVIDERS.anthropic]: { available: Boolean(clients?.anthropic), location: clients?.anthropicLocation ?? null },
  };
}

function defaultLogger(level, msg) {
  console.log(`[gateway] ${level}: ${msg}`);
}
