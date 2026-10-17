// dashboard/lib/server/iap.mjs: who is asking. Identity-Aware Proxy sits in front of the dashboard's
// Cloud Run service and admits only people it has been told to (the IAP grant on the service). It
// passes each request on with a JWT in `x-goog-iap-jwt-assertion`, signed with ES256 by Google. The
// dashboard trusts that signed header and nothing else: never the plain email header IAP also sends,
// which anything that reached the service another way could set.

import { createPublicKey, verify as verifySignature } from 'node:crypto';

/** Where Google publishes IAP's signing keys, as JWKs. */
export const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_HEADER = 'x-goog-iap-jwt-assertion';

const KEY_CACHE_MS = 3_600_000;
const CLOCK_SKEW_SECONDS = 60;

/** Why a request's identity was not accepted. */
export class IapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IapError';
  }
}

/**
 * Creates the check for IAP's signed header. Keys are fetched once an hour, and again when a header
 * names a key not yet seen.
 *
 * @param {object}   o
 * @param {string}   o.audience  `/projects/<number>/locations/<region>/services/<service>`
 * @param {Function} [o.fetch]
 * @param {Function} [o.now]     milliseconds since the epoch
 * @param {string}   [o.keysUrl]
 * @returns {(assertion: string|null|undefined) => Promise<{email: string, sub: string}>}
 */
export function createIapVerifier({ audience, fetch = globalThis.fetch, now = Date.now, keysUrl = IAP_KEYS_URL }) {
  let keys = null;
  let fetchedAt = 0;

  async function loadKeys() {
    const response = await fetch(keysUrl);
    if (!response.ok) throw new Error(`could not fetch IAP's signing keys (${response.status})`);
    const body = await response.json();
    keys = new Map((body.keys || []).filter((key) => key && key.kid).map((key) => [key.kid, key]));
    fetchedAt = now();
  }

  async function keyFor(kid) {
    if (!keys || now() - fetchedAt > KEY_CACHE_MS) await loadKeys();
    if (!keys.has(kid)) await loadKeys();
    const jwk = keys.get(kid);
    if (!jwk) throw new IapError(`the IAP header names key ${kid}, which IAP does not publish`);
    return createPublicKey({ key: jwk, format: 'jwk' });
  }

  return async function verifyIapAssertion(assertion) {
    if (!audience) throw new IapError('the dashboard does not know its IAP audience (PARACLETE_PROJECT_NUMBER, PARACLETE_REGION, service name)');
    if (typeof assertion !== 'string' || !assertion) throw new IapError('the request did not come through IAP');
    const parts = assertion.split('.');
    if (parts.length !== 3) throw new IapError('the IAP header is not a JWT');
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeSegment(headerPart, 'header');
    const claims = decodeSegment(payloadPart, 'claims');
    if (header.alg !== 'ES256') throw new IapError(`the IAP header uses ${header.alg}, not ES256`);

    const key = await keyFor(header.kid);
    const valid = verifySignature(
      'sha256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!valid) throw new IapError('the IAP header signature does not match');

    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== IAP_ISSUER) throw new IapError(`the IAP header was issued by ${claims.iss}`);
    if (claims.aud !== audience) throw new IapError(`the IAP header is for ${claims.aud}, not this dashboard (${audience})`);
    if (!(claims.exp > seconds - CLOCK_SKEW_SECONDS)) throw new IapError('the IAP header has expired');
    if (!(claims.iat <= seconds + CLOCK_SKEW_SECONDS)) throw new IapError('the IAP header was issued in the future');
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new IapError('the IAP header names no email');
    return { email: claims.email.toLowerCase(), sub: String(claims.sub || '') };
  };
}

function decodeSegment(segment, name) {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // reported below
  }
  throw new IapError(`the IAP header's ${name} is unreadable`);
}
