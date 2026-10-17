// agent/auth/dwd-token.mjs: access tokens for the agent's own Google Workspace account, through
// domain-wide delegation. Only roles flagged `workspace` use it. The VM's service account asks IAM to
// sign a JWT as the delegation signer service account, naming the agent's Workspace account as the
// subject, then exchanges the signed JWT for a token. No key is ever created or read.
//
// Tokens are cached per (signer, subject, scopes): two callers asking for different scopes never
// share a token.

import { getAccessToken as getVmAccessToken } from './metadata-token.mjs';

const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 120_000;
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Creates a delegation token source with its own cache.
 *
 * @param {object}   [options]
 * @param {Function} [options.fetch]            fetch implementation (injectable for tests)
 * @param {Function} [options.now]              clock in milliseconds (injectable for tests)
 * @param {Function} [options.getVmAccessToken] token for the VM's own service account
 * @returns {(request: {signerServiceAccount: string, subjectEmail: string, scopes: string|string[]}) => Promise<string>}
 */
export function createDwdTokenSource({
  fetch = globalThis.fetch,
  now = Date.now,
  getVmAccessToken: vmToken = getVmAccessToken,
} = {}) {
  const cache = new Map();

  return async function getDwdToken({ signerServiceAccount, subjectEmail, scopes }) {
    if (!signerServiceAccount) {
      throw new Error('getDwdToken: signerServiceAccount is required (the service account that holds the delegation grant)');
    }
    if (!subjectEmail) throw new Error("getDwdToken: subjectEmail is required (the agent's Workspace account)");
    const scope = (Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/)).filter(Boolean).join(' ');
    if (!scope) throw new Error('getDwdToken: at least one scope is required');

    const key = `${signerServiceAccount}|${subjectEmail}|${scope}`;
    const hit = cache.get(key);
    if (hit && now() < hit.expiresAt - REFRESH_MARGIN_MS) return hit.token;

    const issuedAt = Math.floor(now() / 1000);
    const claims = {
      iss: signerServiceAccount,
      sub: subjectEmail,
      scope,
      aud: OAUTH_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_S,
    };

    const signUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(signerServiceAccount)}:signJwt`;
    const signResponse = await fetch(signUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await vmToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
    });
    if (!signResponse.ok) {
      const detail = await signResponse.text();
      throw new Error(`signJwt failed (HTTP ${signResponse.status}): ${detail.slice(0, 200)}`);
    }
    const { signedJwt } = await signResponse.json();

    const tokenResponse = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt,
      }).toString(),
    });
    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenBody.access_token) {
      const reason = tokenBody.error_description || tokenBody.error || `HTTP ${tokenResponse.status}`;
      throw new Error(`Delegated token exchange failed: ${reason}`);
    }

    const expiresInMs = (tokenBody.expires_in || TOKEN_LIFETIME_S) * 1000;
    cache.set(key, { token: tokenBody.access_token, expiresAt: now() + expiresInMs });
    return tokenBody.access_token;
  };
}

/** The agent's delegation token source. */
export const getDwdToken = createDwdTokenSource();
