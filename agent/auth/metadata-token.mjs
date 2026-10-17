// agent/auth/metadata-token.mjs: access tokens for the VM's service account, read from the GCE
// metadata server and cached until shortly before they expire. Every package that calls a Google API
// gets its token here. Tokens for the agent's own Workspace account come from dwd-token.mjs instead.
// No key is ever created or read.

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const REFRESH_MARGIN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Creates a token source with its own cache.
 *
 * @param {object}   [options]
 * @param {Function} [options.fetch]    fetch implementation (injectable for tests)
 * @param {Function} [options.now]      clock in milliseconds (injectable for tests)
 * @param {string}   [options.override] a fixed token to return instead, for running on a developer machine
 * @returns {() => Promise<string>} returns a valid access token
 */
export function createMetadataTokenSource({ fetch = globalThis.fetch, now = Date.now, override } = {}) {
  let cached = { token: null, expiresAt: 0 };

  return async function getAccessToken() {
    if (override) return override;
    if (cached.token && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;

    const response = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Metadata server token request failed: HTTP ${response.status}`);
    const body = await response.json();
    if (!body.access_token) throw new Error('Metadata server response had no access_token');

    cached = { token: body.access_token, expiresAt: now() + (body.expires_in || 3600) * 1000 };
    return cached.token;
  };
}

/**
 * The VM's token source. On a developer machine there is no metadata server: set GCP_TOKEN to the
 * output of `gcloud auth print-access-token` and that token is returned instead.
 */
export const getAccessToken = createMetadataTokenSource({ override: process.env.GCP_TOKEN });
