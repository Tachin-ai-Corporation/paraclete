// Tests for dashboard/lib/server/iap.mjs. A real P-256 key pair stands in for IAP's signing key: the
// test signs headers with its private half and publishes the public half as IAP does, as JWKs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signData } from 'node:crypto';
import { createIapVerifier, IapError, IAP_ISSUER, IAP_KEYS_URL } from '../../../../dashboard/lib/server/iap.mjs';

const AUDIENCE = '/projects/123456789012/locations/us-central1/services/paraclete';
const NOW = 1_800_000_000_000;

function keyPair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256' } };
}

function assertion({ kid, privateKey }, claims, { alg = 'ES256' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = signData('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

const claims = (overrides = {}) => ({
  iss: IAP_ISSUER,
  aud: AUDIENCE,
  iat: NOW / 1000 - 30,
  exp: NOW / 1000 + 570,
  sub: 'accounts.google.com:1234567890',
  email: 'Ada@Example.com',
  ...overrides,
});

function keyServer(...keys) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ keys: keys.map((key) => key.jwk) }) };
  };
  return { fetch, calls };
}

test('a header IAP signed for this dashboard gives the person, email lowercased', async () => {
  const key = keyPair('iap-1');
  const server = keyServer(key);
  const verify = createIapVerifier({ audience: AUDIENCE, fetch: server.fetch, now: () => NOW });
  assert.deepEqual(await verify(assertion(key, claims())), { email: 'ada@example.com', sub: 'accounts.google.com:1234567890' });
  assert.deepEqual(server.calls, [IAP_KEYS_URL]);
});

test('no header, or not a JWT, is refused: the request did not come through IAP', async () => {
  const verify = createIapVerifier({ audience: AUDIENCE, fetch: keyServer().fetch, now: () => NOW });
  await assert.rejects(verify(null), (err) => err instanceof IapError && /did not come through IAP/.test(err.message));
  await assert.rejects(verify('abc.def'), /not a JWT/);
});

test('a header for another service, issuer or time is refused', async () => {
  const key = keyPair('iap-1');
  const verify = createIapVerifier({ audience: AUDIENCE, fetch: keyServer(key).fetch, now: () => NOW });
  await assert.rejects(verify(assertion(key, claims({ aud: '/projects/1/locations/us-central1/services/other' }))), /is for \/projects\/1\/.+not this dashboard/);
  await assert.rejects(verify(assertion(key, claims({ iss: 'https://accounts.google.com' }))), /issued by https:\/\/accounts\.google\.com/);
  await assert.rejects(verify(assertion(key, claims({ exp: NOW / 1000 - 120 }))), /expired/);
  await assert.rejects(verify(assertion(key, claims({ iat: NOW / 1000 + 600 }))), /in the future/);
  await assert.rejects(verify(assertion(key, claims({ email: undefined }))), /names no email/);
});

test('a header signed by any other key, or with another algorithm, is refused', async () => {
  const iap = keyPair('iap-1');
  const forger = keyPair('iap-1');
  const verify = createIapVerifier({ audience: AUDIENCE, fetch: keyServer(iap).fetch, now: () => NOW });
  await assert.rejects(verify(assertion(forger, claims())), /signature does not match/);
  await assert.rejects(verify(assertion(keyPair('unknown'), claims())), /names key unknown/);
  await assert.rejects(verify(assertion(iap, claims(), { alg: 'HS256' })), /HS256, not ES256/);
});

test('without an audience nothing is accepted', async () => {
  const key = keyPair('iap-1');
  const verify = createIapVerifier({ audience: '', fetch: keyServer(key).fetch, now: () => NOW });
  await assert.rejects(verify(assertion(key, claims())), /does not know its IAP audience/);
});

test('keys are cached, and fetched again for a key not yet seen', async () => {
  const first = keyPair('iap-1');
  const second = keyPair('iap-2');
  const server = keyServer(first, second);
  const verify = createIapVerifier({ audience: AUDIENCE, fetch: server.fetch, now: () => NOW });
  await verify(assertion(first, claims()));
  await verify(assertion(second, claims()));
  await verify(assertion(first, claims()));
  assert.equal(server.calls.length, 1);
  await assert.rejects(verify(assertion(keyPair('iap-3'), claims())), /names key iap-3/);
  assert.equal(server.calls.length, 2);
});
