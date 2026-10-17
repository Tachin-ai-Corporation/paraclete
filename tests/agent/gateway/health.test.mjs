// Tests for agent/gateway/health.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleHealth, isReady } from '../../../agent/gateway/health.mjs';

function fakeResponse() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

const status = {
  'vertex-google': { available: true, location: 'global' },
  'vertex-anthropic': { available: false, location: null },
};

describe('handleHealth', () => {
  it('/healthz answers ok', () => {
    const res = fakeResponse();
    assert.equal(handleHealth('/healthz', res, { status, requiredProviders: [] }), true);
    assert.deepEqual([res.status, res.body], [200, 'ok']);
  });

  it('/ready is 200 when every required provider has a client, and Claude being off is fine', () => {
    const res = fakeResponse();
    handleHealth('/ready', res, { status, requiredProviders: ['vertex-google'] });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ready, true);
  });

  it('/ready is 503 when an organ is routed to a provider with no client', () => {
    const res = fakeResponse();
    handleHealth('/ready', res, { status, requiredProviders: ['vertex-google', 'vertex-anthropic'] });
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body).required, ['vertex-google', 'vertex-anthropic']);
  });

  it('leaves other paths alone', () => {
    assert.equal(handleHealth('/status', fakeResponse(), { status, requiredProviders: [] }), false);
  });

  it('isReady needs every provider', () => {
    assert.equal(isReady(status, []), true);
    assert.equal(isReady(status, ['vertex-anthropic']), false);
    assert.equal(isReady(undefined, ['vertex-google']), false);
  });
});
