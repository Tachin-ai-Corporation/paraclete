// agent/auth/command-signature.mjs: who may command the VM. The control service runs as root and
// carries out the commands in the `commands` collection, but the agent's own service account can write
// to that collection too. So every command carries a signature: the dashboard signs it as its own
// service account through IAM Credentials `signJwt`, and control checks the signature against the keys
// Google publishes for that account before running anything. The agent's account cannot sign as the
// dashboard's, and no shared secret exists to leak.
//
// The signature is a JWT stored in the command's `signature` field. Its claims bind it to one command:
// the document id, the type, a digest of the params and who asked, with a short expiry. A signature
// copied onto another command, or a command edited after signing, fails the check.
//
// The dashboard uses commandClaims() and createCommandSigner(); control uses createCommandVerifier().

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

/** The audience every command signature names. */
export const COMMAND_AUDIENCE = 'paraclete-control';

/** How long a signature stays valid. Control polls every few seconds; a command older than this was never picked up. */
export const COMMAND_SIGNATURE_TTL_SECONDS = 600;

/** The longest lifetime a verifier accepts, whatever a signature claims. */
const MAX_LIFETIME_SECONDS = 3600;

/** Clock difference tolerated between the dashboard and the VM. */
const CLOCK_SKEW_SECONDS = 60;

/** How long published keys are trusted before they are fetched again. */
const KEY_CACHE_MS = 3_600_000;

const IAM_CREDENTIALS_HOST = 'https://iamcredentials.googleapis.com';
const JWKS_HOST = 'https://www.googleapis.com';

/** Why a command's signature was refused. */
export class CommandSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandSignatureError';
  }
}

/**
 * JSON with object keys sorted at every level, so the same value always gives the same text.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The digest a signature carries for a command's params: base64url SHA-256 of their canonical JSON.
 * Missing params count as `{}`.
 *
 * @param {object|undefined|null} params
 * @returns {string}
 */
export function paramsDigest(params) {
  return createHash('sha256').update(canonicalJson(params ?? {})).digest('base64url');
}

/**
 * The claims to sign for one command.
 *
 * @param {object} o
 * @param {string} o.id           the command's document id
 * @param {string} o.type
 * @param {object} [o.params]
 * @param {string} o.requestedBy  the dashboard user's email, as stored in `requested_by`
 * @param {string} o.signer       the signing service account's email
 * @param {number} [o.now]        milliseconds since the epoch
 * @param {number} [o.ttlSeconds]
 * @returns {object}
 */
export function commandClaims({ id, type, params, requestedBy, signer, now = Date.now(), ttlSeconds = COMMAND_SIGNATURE_TTL_SECONDS }) {
  for (const [name, value] of Object.entries({ id, type, requestedBy, signer })) {
    if (typeof value !== 'string' || !value) throw new Error(`commandClaims: ${name} is required`);
  }
  const iat = Math.floor(now / 1000);
  return {
    iss: signer,
    sub: signer,
    aud: COMMAND_AUDIENCE,
    iat,
    exp: iat + ttlSeconds,
    cmd: id,
    type,
    params_sha256: paramsDigest(params),
    requested_by: requestedBy,
  };
}

/**
 * Signs command claims as a service account through IAM Credentials `signJwt`. The caller's token
 * must carry `iam.serviceAccounts.signJwt` on that account (the dashboard's account holds Token
 * Creator on itself).
 *
 * @param {object}   o
 * @param {string}   o.signerEmail
 * @param {Function} o.getAccessToken async () => string
 * @param {Function} [o.fetch]
 * @param {string}   [o.host]
 * @returns {(claims: object) => Promise<string>} the signed JWT
 */
export function createCommandSigner({ signerEmail, getAccessToken, fetch = globalThis.fetch, host = IAM_CREDENTIALS_HOST }) {
  if (!signerEmail) throw new Error('createCommandSigner: signerEmail is required');
  return async function sign(claims) {
    const url = `${host}/v1/projects/-/serviceAccounts/${encodeURIComponent(signerEmail)}:signJwt`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`signing the command as ${signerEmail} failed (${response.status}): ${detail}`);
    }
    const { signedJwt } = await response.json();
    if (typeof signedJwt !== 'string' || !signedJwt) throw new Error('signJwt returned no signedJwt');
    return signedJwt;
  };
}

/**
 * Creates the check control runs on every command before it runs. The keys are the ones Google
 * publishes for the signing account, fetched once an hour, and again when a signature names a key
 * not yet seen (Google rotates them).
 *
 * @param {object}   o
 * @param {string}   o.signerEmail the only account whose signatures are accepted
 * @param {Function} [o.fetch]
 * @param {Function} [o.now]       milliseconds since the epoch
 * @param {string}   [o.host]
 * @returns {(command: object, id: string) => Promise<object>} resolves to the verified claims; rejects
 *   with CommandSignatureError when the command may not run, or another error when the keys could not
 *   be fetched
 */
export function createCommandVerifier({ signerEmail, fetch = globalThis.fetch, now = Date.now, host = JWKS_HOST }) {
  if (!signerEmail) throw new Error('createCommandVerifier: signerEmail is required');
  let keys = null;
  let fetchedAt = 0;

  async function loadKeys() {
    const url = `${host}/service_accounts/v1/jwk/${encodeURIComponent(signerEmail)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch the signing keys of ${signerEmail} (${response.status})`);
    const body = await response.json();
    keys = new Map((body.keys || []).filter((key) => key && key.kid).map((key) => [key.kid, key]));
    fetchedAt = now();
  }

  async function keyFor(kid) {
    if (!keys || now() - fetchedAt > KEY_CACHE_MS) await loadKeys();
    if (!keys.has(kid)) await loadKeys();
    const jwk = keys.get(kid);
    if (!jwk) throw new CommandSignatureError(`the signature names key ${kid}, which ${signerEmail} does not have`);
    return createPublicKey({ key: jwk, format: 'jwk' });
  }

  return async function verifyCommand(command, id) {
    const token = command?.signature;
    if (typeof token !== 'string' || !token) throw new CommandSignatureError('the command is not signed');
    const parts = token.split('.');
    if (parts.length !== 3) throw new CommandSignatureError('the signature is not a JWT');
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeSegment(headerPart, 'header');
    const claims = decodeSegment(payloadPart, 'claims');
    if (header.alg !== 'RS256') throw new CommandSignatureError(`the signature uses ${header.alg}, not RS256`);
    if (typeof header.kid !== 'string' || !header.kid) throw new CommandSignatureError('the signature names no key');

    const key = await keyFor(header.kid);
    const valid = verifySignature('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, 'base64url'));
    if (!valid) throw new CommandSignatureError('the signature does not match');

    const seconds = Math.floor(now() / 1000);
    const expect = (ok, reason) => { if (!ok) throw new CommandSignatureError(reason); };
    expect(claims.iss === signerEmail, `the command was signed by ${claims.iss}, not ${signerEmail}`);
    expect(claims.aud === COMMAND_AUDIENCE, 'the signature is not meant for the control service');
    expect(Number.isFinite(claims.iat) && Number.isFinite(claims.exp), 'the signature has no issue or expiry time');
    expect(claims.exp - claims.iat <= MAX_LIFETIME_SECONDS, 'the signature claims too long a lifetime');
    expect(claims.iat <= seconds + CLOCK_SKEW_SECONDS, 'the signature was issued in the future');
    expect(claims.exp > seconds - CLOCK_SKEW_SECONDS, 'the signature has expired; send the command again');
    expect(claims.cmd === id, 'the signature belongs to another command');
    expect(claims.type === command.type, 'the command type differs from the one signed');
    expect(claims.params_sha256 === paramsDigest(command.params), 'the params differ from the ones signed');
    expect(claims.requested_by === command.requested_by, 'requested_by differs from the one signed');
    return claims;
  };
}

function decodeSegment(segment, name) {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // reported below
  }
  throw new CommandSignatureError(`the signature's ${name} is unreadable`);
}
