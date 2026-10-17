// Tests for agent/auth/dwd-token.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDwdTokenSource } from '../../../agent/auth/dwd-token.mjs';

const SIGNER = 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com';
const AGENT = 'agent@example.com';

/** Fakes IAM signJwt and the OAuth token endpoint; each exchange returns token-1, token-2, ... */
function fakeGoogle({ signStatus = 200, exchange } = {}) {
  const calls = [];
  let issued = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes(':signJwt')) {
      return {
        ok: signStatus === 200,
        status: signStatus,
        text: async () => 'permission denied',
        json: async () => ({ signedJwt: `signed-${JSON.parse(JSON.parse(init.body).payload).scope}` }),
      };
    }
    const body = exchange ? exchange() : { access_token: `token-${++issued}`, expires_in: 3600 };
    return { ok: Boolean(body.access_token), status: body.access_token ? 200 : 400, json: async () => body };
  };
  return { fetch, calls };
}

const vmToken = async () => 'vm-token';

test('signs claims for the subject and scopes, then exchanges the signed JWT', async () => {
  const google = fakeGoogle();
  const getDwdToken = createDwdTokenSource({ fetch: google.fetch, now: () => 1_000_000, getVmAccessToken: vmToken });
  const token = await getDwdToken({ signerServiceAccount: SIGNER, subjectEmail: AGENT, scopes: ['scope-a', 'scope-b'] });
  assert.equal(token, 'token-1');

  const [sign, exchange] = google.calls;
  assert.match(sign.url, /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/.+:signJwt$/);
  assert.equal(sign.init.headers.Authorization, 'Bearer vm-token');
  const claims = JSON.parse(JSON.parse(sign.init.body).payload);
  assert.deepEqual(
    { iss: claims.iss, sub: claims.sub, scope: claims.scope, iat: claims.iat, exp: claims.exp },
    { iss: SIGNER, sub: AGENT, scope: 'scope-a scope-b', iat: 1000, exp: 4600 },
  );
  const form = new URLSearchParams(exchange.init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion'), 'signed-scope-a scope-b');
});

test('caches per scope set, so different scopes never share a token', async () => {
  const google = fakeGoogle();
  const getDwdToken = createDwdTokenSource({ fetch: google.fetch, now: () => 0, getVmAccessToken: vmToken });
  const request = { signerServiceAccount: SIGNER, subjectEmail: AGENT };
  const chatRead = await getDwdToken({ ...request, scopes: 'chat.read' });
  const chatReadAgain = await getDwdToken({ ...request, scopes: ['chat.read'] });
  const chatWrite = await getDwdToken({ ...request, scopes: 'chat.write' });
  assert.equal(chatRead, chatReadAgain);
  assert.notEqual(chatRead, chatWrite);
  assert.equal(google.calls.filter((call) => call.url.includes(':signJwt')).length, 2);
});

test('refreshes a cached token two minutes before it expires', async () => {
  let clock = 0;
  const google = fakeGoogle();
  const getDwdToken = createDwdTokenSource({ fetch: google.fetch, now: () => clock, getVmAccessToken: vmToken });
  const request = { signerServiceAccount: SIGNER, subjectEmail: AGENT, scopes: 's' };
  assert.equal(await getDwdToken(request), 'token-1');
  clock = 3_470_000;
  assert.equal(await getDwdToken(request), 'token-1');
  clock = 3_490_000;
  assert.equal(await getDwdToken(request), 'token-2');
});

test('requires a signer, a subject and at least one scope', async () => {
  const getDwdToken = createDwdTokenSource({ fetch: fakeGoogle().fetch, getVmAccessToken: vmToken });
  await assert.rejects(getDwdToken({ subjectEmail: AGENT, scopes: 's' }), /signerServiceAccount is required/);
  await assert.rejects(getDwdToken({ signerServiceAccount: SIGNER, scopes: 's' }), /subjectEmail is required/);
  await assert.rejects(getDwdToken({ signerServiceAccount: SIGNER, subjectEmail: AGENT, scopes: [] }), /at least one scope/);
});

test('reports a signing failure and a refused exchange', async () => {
  const request = { signerServiceAccount: SIGNER, subjectEmail: AGENT, scopes: 's' };
  const signFails = createDwdTokenSource({ fetch: fakeGoogle({ signStatus: 403 }).fetch, getVmAccessToken: vmToken });
  await assert.rejects(signFails(request), /signJwt failed \(HTTP 403\): permission denied/);
  const exchangeRefused = createDwdTokenSource({
    fetch: fakeGoogle({ exchange: () => ({ error: 'unauthorized_client', error_description: 'Client is unauthorized' }) }).fetch,
    getVmAccessToken: vmToken,
  });
  await assert.rejects(exchangeRefused(request), /Delegated token exchange failed: Client is unauthorized/);
});
