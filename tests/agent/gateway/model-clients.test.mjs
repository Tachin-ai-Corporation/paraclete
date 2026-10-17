// Tests for agent/gateway/model-clients.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createModelClients, parseModel, clientFor, providerStatus, PROVIDERS } from '../../../agent/gateway/model-clients.mjs';
import { quiet } from './fakes.mjs';

function fakeSdk({ anthropicThrows = false } = {}) {
  const made = { google: [], anthropic: [] };
  return {
    made,
    sdk: {
      GoogleGenAI: class { constructor(opts) { made.google.push(opts); } },
      AnthropicVertex: class {
        constructor(opts) {
          if (anthropicThrows) throw new Error('no credentials');
          made.anthropic.push(opts);
        }
      },
    },
  };
}

describe('parseModel', () => {
  it('splits provider and model id; a bare id is Gemini', () => {
    assert.deepEqual(parseModel('vertex-google/gemini-4-argon'), { provider: 'vertex-google', modelId: 'gemini-4-argon' });
    assert.deepEqual(parseModel('vertex-anthropic/claude-opus-x@2026'), { provider: 'vertex-anthropic', modelId: 'claude-opus-x@2026' });
    assert.deepEqual(parseModel('gemini-3.8-flash'), { provider: 'vertex-google', modelId: 'gemini-3.8-flash' });
  });

  it('refuses an unknown provider, an empty id and no model at all', () => {
    assert.throws(() => parseModel('openai/gpt'), /unknown provider 'openai'/);
    assert.throws(() => parseModel('vertex-google/'), /no model id/);
    assert.throws(() => parseModel(''), /a model is required/);
  });
});

describe('createModelClients', () => {
  it('builds a Gemini client on the global endpoint by default and leaves Claude off', () => {
    const { sdk, made } = fakeSdk();
    const clients = createModelClients({ project: 'your-gcp-project', sdk, logger: quiet });
    assert.deepEqual(made.google, [{ vertexai: true, project: 'your-gcp-project', location: 'global' }]);
    assert.equal(made.anthropic.length, 0);
    assert.equal(clients.anthropic, null);
    assert.throws(() => clientFor(clients, PROVIDERS.anthropic), /Claude is not turned on/);
    assert.ok(clientFor(clients, PROVIDERS.google));
  });

  it('builds the Claude client when given its region', () => {
    const { sdk, made } = fakeSdk();
    const clients = createModelClients({ project: 'your-gcp-project', anthropicLocation: 'us-east5', sdk, logger: quiet });
    assert.deepEqual(made.anthropic, [{ projectId: 'your-gcp-project', region: 'us-east5' }]);
    assert.deepEqual(providerStatus(clients), {
      'vertex-google': { available: true, location: 'global' },
      'vertex-anthropic': { available: true, location: 'us-east5' },
    });
  });

  it('leaves Claude off when its client cannot be built', () => {
    const { sdk } = fakeSdk({ anthropicThrows: true });
    const clients = createModelClients({ project: 'your-gcp-project', anthropicLocation: 'us-east5', sdk, logger: quiet });
    assert.equal(clients.anthropic, null);
    assert.equal(providerStatus(clients)['vertex-anthropic'].available, false);
  });

  it('requires a project', () => {
    assert.throws(() => createModelClients({ sdk: fakeSdk().sdk, logger: quiet }), /project is required/);
  });

  it('a fixed access token reaches both SDKs as their auth client, never as application credentials', async () => {
    const { sdk, made } = fakeSdk();
    createModelClients({ project: 'your-gcp-project', anthropicLocation: 'us-east5', accessToken: 'dev-token', sdk, logger: quiet });
    const googleAuthClient = made.google[0].googleAuthOptions.authClient;
    const anthropicAuthClient = made.anthropic[0].authClient;
    for (const authClient of [googleAuthClient, anthropicAuthClient]) {
      const headers = await authClient.getRequestHeaders();
      assert.equal(headers.get('Authorization'), 'Bearer dev-token');
    }
    assert.equal('accessToken' in made.anthropic[0], false, 'the Anthropic SDK ignores accessToken; the auth client carries it');
  });
});
