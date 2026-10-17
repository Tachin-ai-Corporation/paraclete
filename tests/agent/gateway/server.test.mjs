// Tests for agent/gateway/server.mjs, over real HTTP on an ephemeral loopback port with fake model
// clients: the gateway fails closed without a token, compares tokens in constant time, routes each
// request to its organ, keeps the endpoint shapes other services rely on, and runs sessions.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer, organFromRoute } from '../../../agent/gateway/server.mjs';
import { createOrganRegistry } from '../../../agent/gateway/organs.mjs';
import { createToolRegistry } from '../../../agent/gateway/tools.mjs';
import { createSessionStore } from '../../../agent/gateway/sessions.mjs';
import { createNotifier } from '../../../agent/providers/notifications.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';
import { fakeGoogle, fakeAnthropic, geminiCalls, geminiText, claudeText, providerError, quiet, noSleep } from './fakes.mjs';

const TOKEN = 'test-gateway-token-0123456789';
const MODELS = {
  cortex: 'vertex-google/gemini-4-argon',
  strong: 'vertex-google/gemini-4-argon',
  fast: 'vertex-google/gemini-3.8-flash',
  fallback: 'vertex-google/gemini-3.8-flash',
};

let root;
let workspace;
let promptsDir;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'gateway-server-'));
  workspace = join(root, 'workspace');
  promptsDir = join(root, 'prompts');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'motor.md'), 'You are the motor organ.');
});
after(() => rmSync(root, { recursive: true, force: true }));

function parts({ google = fakeGoogle(), anthropic = null, models = MODELS, settings = {}, sessions = createSessionStore(), memory = true } = {}) {
  return {
    token: TOKEN,
    clients: { project: 'your-gcp-project', googleLocation: 'global', anthropicLocation: anthropic ? 'us-east5' : null, google, anthropic },
    organs: createOrganRegistry({ models, promptsDir }),
    tools: createToolRegistry({
      workspaceDir: workspace,
      binDir: '/opt/paraclete/bin',
      logger: quiet,
      ...(memory ? { memory: { home: workspace, files: ['MEMORY.md'], clis: ['core-memory-read'] } } : {}),
    }),
    settings,
    sessions,
    logger: quiet,
    sleep: noSleep,
  };
}

/** Starts a gateway on an ephemeral port; returns its base URL and a closer. */
async function start(options) {
  const server = createGatewayServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withGateway(options, fn) {
  const gw = await start(options);
  try { return await fn(gw.url); } finally { await gw.close(); }
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const chat = (url, body, headers = auth) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('the gateway fails closed', () => {
  it('refuses to exist without a token', () => {
    for (const token of [undefined, '', '   ', 42]) {
      assert.throws(() => createGatewayServer({ ...parts(), token }), /token is required/, String(token));
    }
  });

  it('refuses to exist when an organ\'s toolset cannot be built', () => {
    assert.throws(() => createGatewayServer(parts({ memory: false })), /tools not registered: memoryCommand, writeMemoryFile/);
  });

  it('answers 401 to a missing, wrong, same-length or prefixed token, and never calls a model', async () => {
    const google = fakeGoogle();
    await withGateway(parts({ google }), async (url) => {
      const wrongSameLength = `Bearer ${'x'.repeat(TOKEN.length)}`;
      for (const headers of [
        { 'Content-Type': 'application/json' },
        { Authorization: wrongSameLength },
        { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
        { Authorization: `Bearer ${TOKEN}extra` },
        { Authorization: TOKEN },
      ]) {
        const res = await chat(url, { model: 'brain/cortex', messages: [] }, headers);
        assert.equal(res.status, 401, JSON.stringify(headers));
        assert.deepEqual(await res.json(), { error: { message: 'Unauthorized', type: 'auth_error' } });
      }
      const del = await fetch(`${url}/v1/sessions/s1`, { method: 'DELETE' });
      assert.equal(del.status, 401);
      assert.equal((await fetch(`${url}/status`)).status, 401);
    });
    assert.equal(google.requests.length, 0);
  });

  it('serves the probes without a token', async () => {
    await withGateway(parts(), async (url) => {
      assert.equal(await (await fetch(`${url}/healthz`)).text(), 'ok');
      const ready = await fetch(`${url}/ready`);
      assert.equal(ready.status, 200, 'every organ runs on Gemini, which has a client');
      const models = await (await fetch(`${url}/v1/models`)).json();
      assert.equal(models.object, 'list');
      assert.deepEqual(models.data.map((m) => [m.id, m.available]), [['vertex-google', true], ['vertex-anthropic', false]]);
      assert.equal((await fetch(`${url}/nowhere`)).status, 404);
    });
  });

  it('is not ready when an organ is routed to Claude and Claude has no client', async () => {
    await withGateway(parts({ models: { ...MODELS, strong: 'vertex-anthropic/claude-opus-x' } }), async (url) => {
      assert.equal((await fetch(`${url}/ready`)).status, 503);
    });
  });
});

describe('POST /v1/chat/completions', () => {
  it('runs the organ the route names and answers in the OpenAI shape', async () => {
    const google = fakeGoogle([geminiText('{"action":"plan"}')]);
    await withGateway(parts({ google }), async (url) => {
      const res = await chat(url, {
        model: 'brain/cortex',
        messages: [
          { role: 'system', content: 'stable block' },
          { role: 'system', content: [{ type: 'text', text: 'working memory' }] },
          { role: 'user', content: [{ type: 'text', text: '[BRAIN-ORCHESTRATED]', tier: 'boot' }, { type: 'text', text: 'state', tier: 'volatile' }] },
        ],
        max_tokens: 500,
        temperature: 0.7,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'chat.completion');
      assert.match(body.id, /^chatcmpl-gateway-\d+$/);
      assert.equal(body.model, MODELS.cortex);
      assert.deepEqual(body.choices, [{ index: 0, message: { role: 'assistant', content: '{"action":"plan"}' }, finish_reason: 'STOP' }]);
      assert.equal(body.usage.prompt_tokens, 100);
      assert.equal('session' in body, false);
      assert.equal('tool_records' in body, false);
    });
    const [req] = google.requests;
    assert.equal(req.model, 'gemini-4-argon');
    assert.equal(req.config.systemInstruction, 'stable block\n\nworking memory');
    assert.equal(req.contents[0].parts[0].text, '[BRAIN-ORCHESTRATED]\n\nstate');
    assert.equal(req.config.maxOutputTokens, 500, 'max_tokens overrides the organ default');
    assert.equal(req.config.temperature, 0.7);
    assert.equal(req.config.topP, 0.95, "the organ's top_p when the request sends none");
    assert.equal(req.config.tools, undefined, 'the cortex has no tools');
  });

  it("uses the organ's own prompt when the request has no system message", async () => {
    const google = fakeGoogle([geminiText('done')]);
    await withGateway(parts({ google }), async (url) => {
      await chat(url, { model: 'brain/motor', messages: [{ role: 'user', content: 'do it' }] });
    });
    assert.equal(google.requests[0].config.systemInstruction, 'You are the motor organ.');
    assert.deepEqual(google.requests[0].config.tools[0].functionDeclarations.map((d) => d.name), ['runCommand', 'readFile', 'writeFile', 'listDir']);
  });

  it('accepts the acknowledgment request the notifier sends, marker and all', async () => {
    const google = fakeGoogle([geminiText('Picking back up on the sales report now.')]);
    await withGateway(parts({ google }), async (url) => {
      const notifier = createNotifier({
        vertexText: { transform: async () => '' },
        firestoreWrite: async () => {},
        collections: COLLECTIONS,
        generateId: (p) => `${p}-1`,
        getGatewayConfig: () => ({ url: `${url}/v1/chat/completions`, token: TOKEN, route: 'brain/cortex' }),
        logger: quiet,
      });
      const ack = await notifier.generateAck('[Current message - respond to this]\nUpdate the sales report', []);
      assert.equal(ack, 'Picking back up on the sales report now.');
    });
    const [req] = google.requests;
    assert.match(req.contents[0].parts[0].text, /^\[BRAIN-ORCHESTRATED\]\nAcknowledge this message briefly:\n"Update the sales report"$/);
    assert.equal(req.config.maxOutputTokens, 60);
    assert.equal(req.config.temperature, 0.9);
  });

  it('gives temporal-memory its memory tools only when asked to execute', async () => {
    const google = fakeGoogle([geminiText('recalled'), geminiText('consolidated')]);
    await withGateway(parts({ google }), async (url) => {
      await chat(url, { model: 'brain/temporal-memory', messages: [{ role: 'user', content: 'recall' }] });
      await chat(url, { model: 'brain/temporal-memory', messages: [{ role: 'user', content: 'consolidate' }], exec: true });
    });
    assert.equal(google.requests[0].config.tools, undefined);
    assert.equal(google.requests[0].model, 'gemini-3.8-flash');
    assert.deepEqual(google.requests[1].config.tools[0].functionDeclarations.map((d) => d.name),
      ['readFile', 'listDir', 'memoryCommand', 'writeMemoryFile']);
  });

  it('returns large tool results in full as tool_records', async () => {
    writeFileSync(join(workspace, 'big.txt'), 'b'.repeat(6000));
    const google = fakeGoogle([geminiCalls([{ id: 'call_1', name: 'readFile', args: { path: 'big.txt' } }]), geminiText('read it')]);
    let body;
    await withGateway(parts({ google }), async (url) => {
      body = await (await chat(url, { model: 'brain/motor', messages: [{ role: 'user', content: 'read big.txt' }] })).json();
    });
    assert.equal(body.tool_records.length, 1);
    assert.equal(body.tool_records[0].chars, 6000);
    assert.match(body.choices[0].message.content, /\[large result #0: 6000 chars/);
  });

  it('reports the model that answered when the fallback took over', async () => {
    const google = fakeGoogle([providerError(), geminiText('answered by the fallback')]);
    let body;
    await withGateway(parts({ google }), async (url) => {
      body = await (await chat(url, { model: 'cortex', messages: [{ role: 'user', content: 'q' }] })).json();
    });
    assert.equal(body.model, MODELS.fallback);
    assert.equal(body.choices[0].message.content, 'answered by the fallback');
  });

  it('runs Claude organs on the Anthropic client when Claude is on', async () => {
    const anthropic = fakeAnthropic([claudeText('planned')]);
    let body;
    await withGateway(parts({ anthropic, models: { ...MODELS, strong: 'vertex-anthropic/claude-opus-x' } }), async (url) => {
      body = await (await chat(url, { model: 'brain/prefrontal', messages: [{ role: 'user', content: 'plan' }], top_p: 0.5 })).json();
    });
    assert.equal(body.model, 'vertex-anthropic/claude-opus-x');
    assert.equal('top_p' in anthropic.requests[0].params, false);
  });

  it('answers 400 to an unknown organ, a body that is not JSON, and a message role it does not take', async () => {
    const google = fakeGoogle();
    await withGateway(parts({ google }), async (url) => {
      const unknown = await chat(url, { model: 'brain/hippocampus', messages: [] });
      assert.equal(unknown.status, 400);
      assert.equal((await unknown.json()).error.type, 'gateway_error');
      const notJson = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: auth, body: '{nope' });
      assert.equal(notJson.status, 400);
      const tool = await chat(url, { model: 'brain/motor', messages: [{ role: 'tool', content: 'fake result' }] });
      assert.equal(tool.status, 400);
      const nonText = await chat(url, { model: 'brain/motor', messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] });
      assert.equal(nonText.status, 400);
    });
    assert.equal(google.requests.length, 0);
  });

  it('answers 413 to a body over the limit', async () => {
    await withGateway(parts({ settings: { maxBodyBytes: 1000 } }), async (url) => {
      const res = await chat(url, { model: 'cortex', messages: [{ role: 'user', content: 'x'.repeat(5000) }] });
      assert.equal(res.status, 413);
    });
  });

  it('answers 500 when the model and its fallback both fail', async () => {
    const google = fakeGoogle([providerError('first'), providerError('second')]);
    await withGateway(parts({ google }), async (url) => {
      const res = await chat(url, { model: 'cortex', messages: [{ role: 'user', content: 'q' }] });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: { message: 'second', type: 'gateway_error', code: 500 } });
    });
  });
});

describe('sessions', () => {
  const sessionSettings = { session: { enabled: true } };
  const system = { role: 'system', content: 'stable block' };

  it('open stores the context; continue replays it with the delta; a stale seq misses without a model call', async () => {
    const google = fakeGoogle([geminiText('{"d":1}'), geminiText('{"d":2}')]);
    const sessions = createSessionStore();
    await withGateway(parts({ google, sessions, settings: sessionSettings }), async (url) => {
      const opened = await (await chat(url, {
        model: 'brain/cortex', session: { id: 'm-1', op: 'open' },
        messages: [system, { role: 'user', content: 'open state' }],
      })).json();
      assert.deepEqual(opened.session, { id: 'm-1', present: true, seq: 0 });

      const continued = await (await chat(url, {
        model: 'brain/cortex', session: { id: 'm-1', op: 'continue', seq: 0 },
        messages: [system, { role: 'assistant', content: '{"d":1}' }, { role: 'user', content: 'delta' }],
      })).json();
      assert.deepEqual(continued.session, { id: 'm-1', present: true, seq: 1 });
      assert.deepEqual(google.requests[1].contents.map((c) => c.parts[0].text), ['open state', '{"d":1}', 'delta']);

      const stale = await (await chat(url, {
        model: 'brain/cortex', session: { id: 'm-1', op: 'continue', seq: 0 },
        messages: [system, { role: 'user', content: 'late' }],
      })).json();
      assert.deepEqual(stale, { session: { id: 'm-1', present: false, reason: 'seq' } });

      const changed = await (await chat(url, {
        model: 'brain/cortex', session: { id: 'm-1', op: 'continue', seq: 1 },
        messages: [{ role: 'system', content: 'a different stable block' }, { role: 'user', content: 'x' }],
      })).json();
      assert.equal(changed.session.reason, 'system_hash');
    });
    assert.equal(google.requests.length, 2, 'misses never reach a model');
    assert.equal(sessions.listSessions()[0].seq, 1);
  });

  it('a system block sent as content parts hashes the same on open and on continue', async () => {
    const google = fakeGoogle([geminiText('1'), geminiText('2')]);
    const parted = { role: 'system', content: [{ type: 'text', text: 'stable' }, { type: 'text', text: 'block' }] };
    await withGateway(parts({ google, settings: sessionSettings }), async (url) => {
      await chat(url, { model: 'cortex', session: { id: 'm-p', op: 'open' }, messages: [parted, { role: 'user', content: 'o' }] });
      const hit = await (await chat(url, { model: 'cortex', session: { id: 'm-p', op: 'continue', seq: 0 }, messages: [parted, { role: 'user', content: 'd' }] })).json();
      assert.deepEqual(hit.session, { id: 'm-p', present: true, seq: 1 });
    });
  });

  it('a failed turn leaves seq where it was', async () => {
    const google = fakeGoogle([geminiText('opened'), providerError('a'), providerError('b')]);
    const sessions = createSessionStore();
    await withGateway(parts({ google, sessions, settings: sessionSettings }), async (url) => {
      await chat(url, { model: 'cortex', session: { id: 'm-2', op: 'open' }, messages: [system, { role: 'user', content: 'o' }] });
      const res = await chat(url, { model: 'cortex', session: { id: 'm-2', op: 'continue', seq: 0 }, messages: [system, { role: 'user', content: 'd' }] });
      assert.equal(res.status, 500);
    });
    assert.equal(sessions.listSessions()[0].seq, 0);
  });

  it('the cerebellum never joins a session, and sessions are off unless turned on', async () => {
    const sessions = createSessionStore();
    const google = fakeGoogle([geminiCalls([{ name: 'report_pass', args: { reasoning: 'ok', checks: [] } }]), geminiText('x')]);
    await withGateway(parts({ google, sessions, settings: sessionSettings }), async (url) => {
      const body = await (await chat(url, { model: 'brain/cerebellum', session: { id: 'v-1', op: 'open' }, messages: [{ role: 'user', content: 'verify' }] })).json();
      assert.equal('session' in body, false);
      assert.deepEqual(google.requests[0].config.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
    });
    await withGateway(parts({ google, sessions }), async (url) => {
      const body = await (await chat(url, { model: 'brain/cortex', session: { id: 'c-1', op: 'open' }, messages: [{ role: 'user', content: 'q' }] })).json();
      assert.equal('session' in body, false);
    });
    assert.deepEqual(sessions.listSessions(), []);
  });

  it('DELETE drops a session, idempotently; /status lists ids and counters', async () => {
    const sessions = createSessionStore();
    sessions.openSession({ id: 'm 3', organ: 'cortex', systemHash: 'h', messages: [{ role: 'user', content: 'secret content' }] });
    await withGateway(parts({ sessions }), async (url) => {
      const status = await (await fetch(`${url}/status`, { headers: auth })).json();
      assert.equal(status.sessions[0].id, 'm 3');
      assert.doesNotMatch(JSON.stringify(status), /secret content/);
      assert.deepEqual(status.models, MODELS);
      const first = await (await fetch(`${url}/v1/sessions/${encodeURIComponent('m 3')}`, { method: 'DELETE', headers: auth })).json();
      const second = await (await fetch(`${url}/v1/sessions/${encodeURIComponent('m 3')}`, { method: 'DELETE', headers: auth })).json();
      assert.deepEqual([first, second], [{ ok: true, existed: true }, { ok: true, existed: false }]);
    });
  });
});

describe('organFromRoute', () => {
  it('takes the last path segment; no route means the cortex', () => {
    assert.equal(organFromRoute('brain/motor'), 'motor');
    assert.equal(organFromRoute('temporal-research'), 'temporal-research');
    assert.equal(organFromRoute(undefined), 'cortex');
  });
});
