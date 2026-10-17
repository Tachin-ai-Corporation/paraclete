// Tests for agent/auth/metadata-token.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataTokenSource } from '../../../agent/auth/metadata-token.mjs';

function fakeMetadataServer(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  return { fetch, calls };
}

test('fetches a token from the metadata server with the Metadata-Flavor header', async () => {
  const server = fakeMetadataServer([{ status: 200, body: { access_token: 'token-1', expires_in: 3600 } }]);
  const getAccessToken = createMetadataTokenSource({ fetch: server.fetch });
  assert.equal(await getAccessToken(), 'token-1');
  assert.match(server.calls[0].url, /computeMetadata\/v1\/instance\/service-accounts\/default\/token$/);
  assert.equal(server.calls[0].init.headers['Metadata-Flavor'], 'Google');
});

test('reuses the cached token until it is close to expiry', async () => {
  let clock = 0;
  const server = fakeMetadataServer([
    { status: 200, body: { access_token: 'token-1', expires_in: 60 } },
    { status: 200, body: { access_token: 'token-2', expires_in: 60 } },
  ]);
  const getAccessToken = createMetadataTokenSource({ fetch: server.fetch, now: () => clock });
  assert.equal(await getAccessToken(), 'token-1');
  clock = 20_000;
  assert.equal(await getAccessToken(), 'token-1', 'still 40s from expiry: cached');
  clock = 31_000;
  assert.equal(await getAccessToken(), 'token-2', 'inside the 30s refresh margin: refetched');
  assert.equal(server.calls.length, 2);
});

test('returns the override without calling the metadata server', async () => {
  const server = fakeMetadataServer([]);
  const getAccessToken = createMetadataTokenSource({ fetch: server.fetch, override: 'dev-token' });
  assert.equal(await getAccessToken(), 'dev-token');
  assert.equal(server.calls.length, 0);
});

test('reports an HTTP failure and a response with no token', async () => {
  const failing = createMetadataTokenSource({ fetch: fakeMetadataServer([{ status: 404, body: {} }]).fetch });
  await assert.rejects(failing(), /HTTP 404/);
  const empty = createMetadataTokenSource({ fetch: fakeMetadataServer([{ status: 200, body: {} }]).fetch });
  await assert.rejects(empty(), /no access_token/);
});
