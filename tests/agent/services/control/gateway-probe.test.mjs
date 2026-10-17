// Tests for agent/services/control/gateway-probe.mjs: readiness without the token, the running models
// with it, a gateway that is down or refuses the token reported as such, and a wait that returns the
// moment the restarted gateway is ready or its time runs out. Fake fetch and clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeGateway, waitForGateway } from '../../../../agent/services/control/gateway-probe.mjs';
import { fakeGatewayFetch, GATEWAY_TOKEN } from './fakes.mjs';

const url = 'http://127.0.0.1:18789';
const MODELS = { cortex: 'vertex-google/gemini-4-argon', strong: 'vertex-google/gemini-4-argon', fast: 'vertex-google/gemini-3.8-flash', fallback: 'vertex-google/gemini-3.8-flash' };

test('with the token, the probe reports readiness and the models the gateway runs', async () => {
  const gw = fakeGatewayFetch({ models: MODELS });
  const probe = await probeGateway({ url, token: GATEWAY_TOKEN, fetch: gw.fetch });
  assert.equal(probe.reachable, true);
  assert.equal(probe.ready, true);
  assert.deepEqual(probe.required, ['vertex-google']);
  assert.deepEqual(probe.models, MODELS);
  assert.equal(probe.uptime_sec, 3);
  assert.equal(probe.sessions, 1, 'a count of sessions, never their content');
  assert.equal(gw.calls[1].headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
});

test('without the token only readiness is read', async () => {
  const gw = fakeGatewayFetch({ models: MODELS });
  const probe = await probeGateway({ url, fetch: gw.fetch });
  assert.equal(probe.ready, true);
  assert.equal(probe.models, null);
  assert.deepEqual(gw.calls.map((c) => new URL(c.url).pathname), ['/ready']);
});

test('a gateway that is down, not ready, or refuses the token says so', async () => {
  const down = await probeGateway({ url, token: GATEWAY_TOKEN, fetch: fakeGatewayFetch({ down: true }).fetch });
  assert.deepEqual(down, { reachable: false, ready: false, error: 'the gateway did not answer: connect ECONNREFUSED 127.0.0.1:18789' });

  const notReady = await probeGateway({ url, fetch: fakeGatewayFetch({ ready: false }).fetch });
  assert.equal(notReady.reachable, true);
  assert.equal(notReady.ready, false);

  const refused = await probeGateway({ url, token: 'wrong-token', fetch: fakeGatewayFetch({ models: MODELS }).fetch });
  assert.equal(refused.ready, true);
  assert.equal(refused.models, null);
  assert.match(refused.error, /\/status answered HTTP 401/);
});

test('the wait returns as soon as the gateway is ready', async () => {
  const gw = fakeGatewayFetch({ readyAfter: 2, models: MODELS });
  const sleeps = [];
  const probe = await waitForGateway({
    url, token: GATEWAY_TOKEN, timeoutMs: 30_000, intervalMs: 1_000, fetch: gw.fetch,
    sleep: async (ms) => { sleeps.push(ms); }, now: () => 0,
  });
  assert.equal(probe.ready, true);
  assert.deepEqual(probe.models, MODELS);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test('the wait gives up at its deadline and returns the last probe', async () => {
  let clock = 0;
  const probe = await waitForGateway({
    url, timeoutMs: 5_000, intervalMs: 1_000, fetch: fakeGatewayFetch({ down: true }).fetch,
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  });
  assert.equal(probe.ready, false);
  assert.equal(probe.reachable, false);
  assert.equal(clock, 5_000);
});
