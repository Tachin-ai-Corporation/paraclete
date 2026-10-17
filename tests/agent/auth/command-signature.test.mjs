// Tests for agent/auth/command-signature.mjs. A real RSA key pair stands in for the dashboard's
// Google-managed key: the fake IAM signs with its private half, and the fake key endpoint publishes the
// public half as a JWK, the way Google publishes a service account's keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  COMMAND_AUDIENCE,
  CommandSignatureError,
  canonicalJson,
  commandClaims,
  createCommandSigner,
  createCommandVerifier,
  paramsDigest,
} from '../../../agent/auth/command-signature.mjs';

const SIGNER = 'paraclete-dashboard@your-gcp-project.iam.gserviceaccount.com';
const NOW = 1_800_000_000_000;

function keyPair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function signWith({ kid, privateKey }, claims, { alg = 'RS256' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Google, faked: signJwt signs with the current key; the JWK endpoint publishes the published keys. */
function fakeGoogle(...keys) {
  const calls = [];
  const state = { signing: keys[0], published: keys };
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes(':signJwt')) {
      const claims = JSON.parse(JSON.parse(init.body).payload);
      return { ok: true, status: 200, json: async () => ({ keyId: state.signing.kid, signedJwt: signWith(state.signing, claims) }) };
    }
    return { ok: true, status: 200, json: async () => ({ keys: state.published.map((key) => key.jwk) }) };
  };
  return { fetch, calls, state };
}

const command = (overrides = {}) => ({
  type: 'restart_service',
  params: { service: 'brain' },
  status: 'pending',
  requested_by: 'admin@example.com',
  created_at: '2027-01-15T08:00:00.000Z',
  ...overrides,
});

async function signedCommand(google, id = 'cmd-1', overrides = {}) {
  const base = command(overrides);
  const sign = createCommandSigner({ signerEmail: SIGNER, getAccessToken: async () => 'dashboard-token', fetch: google.fetch });
  const claims = commandClaims({ id, type: base.type, params: base.params, requestedBy: base.requested_by, signer: SIGNER, now: NOW });
  return { ...base, signature: await sign(claims) };
}

test('canonical JSON sorts keys at every level, so the params digest ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(paramsDigest({ id: 'x', enabled: true }), paramsDigest({ enabled: true, id: 'x' }));
  assert.equal(paramsDigest(undefined), paramsDigest({}));
  assert.notEqual(paramsDigest({ service: 'brain' }), paramsDigest({ service: 'mouth' }));
});

test('claims bind the signature to one command, with a ten-minute expiry', () => {
  const claims = commandClaims({ id: 'cmd-1', type: 'upgrade', params: { ref: 'v2027.01.15.1.1' }, requestedBy: 'admin@example.com', signer: SIGNER, now: NOW });
  assert.deepEqual(claims, {
    iss: SIGNER,
    sub: SIGNER,
    aud: COMMAND_AUDIENCE,
    iat: NOW / 1000,
    exp: NOW / 1000 + 600,
    cmd: 'cmd-1',
    type: 'upgrade',
    params_sha256: paramsDigest({ ref: 'v2027.01.15.1.1' }),
    requested_by: 'admin@example.com',
  });
  assert.throws(() => commandClaims({ id: 'cmd-1', type: 'upgrade', signer: SIGNER }), /requestedBy is required/);
});

test('the signer asks IAM to sign as the dashboard account, with the caller token', async () => {
  const google = fakeGoogle(keyPair('key-1'));
  await signedCommand(google);
  const [call] = google.calls;
  assert.equal(call.url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER)}:signJwt`);
  assert.equal(call.init.headers.Authorization, 'Bearer dashboard-token');
});

test('a signing failure says who could not sign and why', async () => {
  const fetch = async () => ({ ok: false, status: 403, text: async () => 'Permission iam.serviceAccounts.signJwt denied' });
  const sign = createCommandSigner({ signerEmail: SIGNER, getAccessToken: async () => 't', fetch });
  await assert.rejects(sign({}), /signing the command as paraclete-dashboard@.+ failed \(403\): Permission/);
});

test('a correctly signed command verifies, and its claims come back', async () => {
  const google = fakeGoogle(keyPair('key-1'));
  const signed = await signedCommand(google);
  const verify = createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch, now: () => NOW + 5_000 });
  const claims = await verify(signed, 'cmd-1');
  assert.equal(claims.cmd, 'cmd-1');
  assert.ok(google.calls.some((call) => call.url === `https://www.googleapis.com/service_accounts/v1/jwk/${encodeURIComponent(SIGNER)}`));
});

test('an unsigned or malformed command is refused', async () => {
  const google = fakeGoogle(keyPair('key-1'));
  const verify = createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch, now: () => NOW });
  await assert.rejects(verify(command(), 'cmd-1'), (err) => err instanceof CommandSignatureError && /not signed/.test(err.message));
  await assert.rejects(verify(command({ signature: 'a.b' }), 'cmd-1'), /not a JWT/);
  await assert.rejects(verify(command({ signature: 'x.y.z' }), 'cmd-1'), /header is unreadable/);
});

test('every way of moving or editing a signed command is refused', async () => {
  const google = fakeGoogle(keyPair('key-1'));
  const signed = await signedCommand(google);
  const verify = createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch, now: () => NOW });
  await assert.rejects(verify(signed, 'cmd-2'), /belongs to another command/);
  await assert.rejects(verify({ ...signed, type: 'upgrade' }, 'cmd-1'), /type differs/);
  await assert.rejects(verify({ ...signed, params: { service: 'control' } }, 'cmd-1'), /params differ/);
  await assert.rejects(verify({ ...signed, requested_by: 'someone@example.com' }, 'cmd-1'), /requested_by differs/);
});

test('an expired signature, or one from the future, is refused', async () => {
  const google = fakeGoogle(keyPair('key-1'));
  const signed = await signedCommand(google);
  const later = createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch, now: () => NOW + 11 * 60_000 });
  await assert.rejects(later(signed, 'cmd-1'), /expired; send the command again/);
  const earlier = createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch, now: () => NOW - 5 * 60_000 });
  await assert.rejects(earlier(signed, 'cmd-1'), /issued in the future/);
});

test('a signature from any other key, account or audience is refused', async () => {
  const dashboard = keyPair('key-1');
  const agentKey = keyPair('key-agent');
  const google = fakeGoogle(dashboard);
  const verify = createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch, now: () => NOW });
  const base = command();
  const claims = commandClaims({ id: 'cmd-1', type: base.type, params: base.params, requestedBy: base.requested_by, signer: SIGNER, now: NOW });

  // A key the dashboard account does not have, even one claiming the same kid.
  await assert.rejects(verify({ ...base, signature: signWith(agentKey, claims) }, 'cmd-1'), /names key key-agent/);
  await assert.rejects(verify({ ...base, signature: signWith({ ...agentKey, kid: 'key-1' }, claims) }, 'cmd-1'), /does not match/);
  // The right key, but claims naming another issuer or audience.
  await assert.rejects(verify({ ...base, signature: signWith(dashboard, { ...claims, iss: 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com' }) }, 'cmd-1'), /signed by paraclete-agent@/);
  await assert.rejects(verify({ ...base, signature: signWith(dashboard, { ...claims, aud: 'elsewhere' }) }, 'cmd-1'), /not meant for the control service/);
  await assert.rejects(verify({ ...base, signature: signWith(dashboard, { ...claims, exp: claims.iat + 86_400 }) }, 'cmd-1'), /too long a lifetime/);
  await assert.rejects(verify({ ...base, signature: signWith(dashboard, claims, { alg: 'HS256' }) }, 'cmd-1'), /HS256, not RS256/);
});

test('keys are cached, and fetched again when Google rotates to a key not yet seen', async () => {
  const first = keyPair('key-1');
  const second = keyPair('key-2');
  const google = fakeGoogle(first);
  const verify = createCommandVerifier({ signerEmail: SIGNER, fetch: google.fetch, now: () => NOW });
  await verify(await signedCommand(google, 'cmd-1'), 'cmd-1');
  await verify(await signedCommand(google, 'cmd-2'), 'cmd-2');
  const keyFetches = () => google.calls.filter((call) => call.url.includes('/jwk/')).length;
  assert.equal(keyFetches(), 1);

  google.state.signing = second;
  google.state.published = [first, second];
  await verify(await signedCommand(google, 'cmd-3'), 'cmd-3');
  assert.equal(keyFetches(), 2);
});

test('keys that cannot be fetched fail the check with a plain error, not a refusal', async () => {
  const google = fakeGoogle(keyPair('key-1'));
  const signed = await signedCommand(google);
  const fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const verify = createCommandVerifier({ signerEmail: SIGNER, fetch, now: () => NOW });
  await assert.rejects(verify(signed, 'cmd-1'), (err) => !(err instanceof CommandSignatureError) && /could not fetch the signing keys .+ \(503\)/.test(err.message));
});
