// Tests for agent/services/gateway/main.mjs: the gateway refuses to start without its token, reads
// the admin's Claude switch strictly, builds its model clients, organs and tools from the contracts and
// the instance's paths, serves on loopback, and closes cleanly on SIGTERM. Fake model clients and a
// fake Firestore; real HTTP on an ephemeral loopback port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContracts } from '../../../../config/contracts.mjs';
import { dataPaths } from '../../../../config/instance.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { buildGateway, readGatewayToken, main, EXIT_CONFIG } from '../../../../agent/services/gateway/main.mjs';

const TOKEN = 'test-gateway-token-0123456789';
const contracts = loadContracts();
const quiet = () => {};

let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'gateway-main-')); });
after(() => rmSync(root, { recursive: true, force: true }));

/** A runtime of the shape createServiceRuntime returns, rooted in a fresh temp directory. */
function fakeRuntime({ settings = null, readFails = false, token = TOKEN, role = 'generic', port } = {}) {
  const base = mkdtempSync(join(root, 'instance-'));
  const installRoot = join(base, 'opt');
  const instance = {
    project: 'your-gcp-project', role, install_root: installRoot, data_root: join(base, 'data'),
    gateway_token_file: join(base, 'gateway-token'),
  };
  if (token !== null) writeFileSync(instance.gateway_token_file, `${token}\n`);
  const paths = {
    installRoot,
    prompts: join(installRoot, 'prompts'),
    skills: join(installRoot, 'skills'),
    roles: join(installRoot, 'roles'),
    genericRole: join(installRoot, 'roles', 'generic'),
    role: join(installRoot, 'roles', role),
    data: dataPaths(instance),
  };
  mkdirSync(paths.prompts, { recursive: true });
  writeFileSync(join(paths.prompts, 'motor.md'), 'You are the motor organ.');
  const reads = [];
  const db = {
    async read(path, opts) {
      reads.push({ path, opts });
      if (readFails) throw new Error('Firestore read config/settings: HTTP 503');
      return settings;
    },
  };
  const lines = [];
  return {
    reads,
    lines,
    runtime: {
      contracts: port === undefined ? contracts : { ...contracts, gateway: { ...contracts.gateway, port } },
      instance,
      paths,
      log: (level, message, fields) => lines.push({ level, message, ...fields }),
      db,
      collections: COLLECTIONS,
    },
  };
}

/** A createModelClients stand-in that records what it was asked for. */
function fakeClients() {
  const calls = [];
  const create = (options) => {
    calls.push(options);
    return {
      project: options.project,
      googleLocation: options.googleLocation,
      anthropicLocation: options.anthropicLocation || null,
      google: { models: {}, caches: {} },
      anthropic: options.anthropicLocation ? { messages: {} } : null,
    };
  };
  return { create, calls };
}

async function withServer(gateway, fn) {
  const { port } = await gateway.listen({ port: 0, host: '127.0.0.1' });
  try { return await fn(`http://127.0.0.1:${port}`); } finally { await gateway.close(); }
}

test('the token is read from the instance token file and trimmed; missing or empty refuses to start', () => {
  const file = join(root, 'token-ok');
  writeFileSync(file, '  abc-123\n');
  assert.equal(readGatewayToken(file, (p) => readFileSync(p, 'utf8')), 'abc-123');

  const missing = () => readGatewayToken(join(root, 'no-such-token'), (p) => readFileSync(p, 'utf8'));
  assert.throws(missing, (err) => err.exitCode === EXIT_CONFIG && /refusing to serve an unauthenticated gateway/.test(err.message));
  const empty = join(root, 'token-empty');
  writeFileSync(empty, '\n');
  assert.throws(() => readGatewayToken(empty, (p) => readFileSync(p, 'utf8')), /is empty; refusing/);
});

test('without a token the gateway never reads Firestore or builds a client', async () => {
  const { runtime, reads } = fakeRuntime({ token: null });
  const clients = fakeClients();
  await assert.rejects(buildGateway(runtime, { createClients: clients.create }), /refusing to serve an unauthenticated gateway/);
  assert.equal(reads.length, 0);
  assert.equal(clients.calls.length, 0);
});

test('Claude off: Gemini tiers from the contracts, no Anthropic client, served behind the token', async () => {
  const { runtime, reads, lines } = fakeRuntime({ settings: { effort: 'high' } });
  const clients = fakeClients();
  const gateway = await buildGateway(runtime, { createClients: clients.create, env: { PATH: '/usr/bin' } });

  assert.deepEqual(reads, [{ path: 'config/settings', opts: { strict: true } }]);
  assert.equal(gateway.claudeEnabled, false);
  assert.deepEqual(clients.calls, [{ project: 'your-gcp-project', googleLocation: contracts.vertex.location, logger: runtime.log }]);
  assert.ok(lines.some((l) => l.message.startsWith('models: claude off') && l.claude_enabled === false));
  assert.equal(JSON.stringify(lines).includes(TOKEN), false, 'the token is never logged');

  await withServer(gateway, async (url) => {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/status`)).status, 401);
    const status = await (await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    const m = contracts.vertex.models;
    assert.deepEqual(status.models, { cortex: m.cortex, strong: m.strong, fast: m.fast, fallback: m.fallback });
    assert.equal(status.providers['vertex-anthropic'].available, false);
    assert.equal((await fetch(`${url}/ready`)).status, 200);
  });
});

test('Claude on: the cortex and strong tier run Claude, with an Anthropic client in the contracts region', async () => {
  const { runtime } = fakeRuntime({ settings: { claude_enabled: true } });
  const clients = fakeClients();
  const gateway = await buildGateway(runtime, { createClients: clients.create });
  assert.equal(gateway.claudeEnabled, true);
  assert.equal(clients.calls[0].anthropicLocation, contracts.vertex.anthropic_location);
  await withServer(gateway, async (url) => {
    const status = await (await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    const m = contracts.vertex.models;
    assert.deepEqual(status.models, { cortex: m.claude, strong: m.claude, fast: m.fast, fallback: m.claude_fallback });
    assert.equal(status.providers['vertex-anthropic'].available, true);
    assert.equal((await fetch(`${url}/ready`)).status, 200);
  });
});

test('Claude on with a chosen model: the cortex and strong tier run it; an unlisted choice runs the contracts model, logged once', async () => {
  const m = contracts.vertex.models;
  const newest = m.claude_candidates[0];
  const chosen = await buildGateway(fakeRuntime({ settings: { claude_enabled: true, claude_model: newest } }).runtime, { createClients: fakeClients().create });
  assert.deepEqual(chosen.models, { cortex: newest, strong: newest, fast: m.fast, fallback: m.claude_fallback });

  const { runtime, lines } = fakeRuntime({ settings: { claude_enabled: true, claude_model: 'vertex-anthropic/claude-opus-1' } });
  const unlisted = await buildGateway(runtime, { createClients: fakeClients().create });
  assert.deepEqual(unlisted.models, { cortex: m.claude, strong: m.claude, fast: m.fast, fallback: m.claude_fallback });
  const warnings = lines.filter((l) => l.level === 'WARN' && l.message.includes('claude_candidates'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, `the stored Claude model "vertex-anthropic/claude-opus-1" is not one of the contracts' claude_candidates; running ${m.claude} instead`);

  // With Claude off the choice does not matter, and nothing is said about it.
  const off = fakeRuntime({ settings: { claude_enabled: false, claude_model: 'vertex-anthropic/claude-opus-1' } });
  const gemini = await buildGateway(off.runtime, { createClients: fakeClients().create });
  assert.equal(gemini.models.cortex, m.cortex);
  assert.equal(off.lines.some((l) => l.level === 'WARN'), false);
});

test('an unreadable settings document stops startup instead of guessing the models', async () => {
  const { runtime } = fakeRuntime({ readFails: true });
  const clients = fakeClients();
  await assert.rejects(buildGateway(runtime, { createClients: clients.create }), /HTTP 503/);
  assert.equal(clients.calls.length, 0);
});

test('the skill catalog shows the Workspace skills only when the instance record names a Workspace account', async () => {
  const { runtime } = fakeRuntime();
  mkdirSync(join(runtime.paths.skills, 'workspace-calendar'), { recursive: true });
  writeFileSync(join(runtime.paths.skills, 'workspace-calendar', 'skill.json'), JSON.stringify({
    id: 'workspace-calendar', name: 'Google Calendar', when_to_use: 'Calendars.', organs: ['motor'], requires: ['workspace'],
  }));
  mkdirSync(join(runtime.paths.skills, 'files'), { recursive: true });
  writeFileSync(join(runtime.paths.skills, 'files', 'skill.json'), JSON.stringify({ id: 'files', name: 'Files', when_to_use: 'Files.', organs: ['motor'] }));

  const without = await buildGateway(runtime, { createClients: fakeClients().create });
  assert.match(without.skillCatalog, /\(files\)/);
  assert.doesNotMatch(without.skillCatalog, /workspace-calendar/);

  const workspace = { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' };
  const withAccount = await buildGateway({ ...runtime, instance: { ...runtime.instance, workspace } }, { createClients: fakeClients().create });
  assert.match(withAccount.skillCatalog, /- Google Calendar \(workspace-calendar\): Calendars\./);
});

test('the workspace and memory directories exist before the first command runs', async () => {
  const { runtime } = fakeRuntime();
  const gateway = await buildGateway(runtime, { createClients: fakeClients().create });
  assert.ok(existsSync(runtime.paths.data.workspace));
  assert.ok(existsSync(runtime.paths.data.memory));
  await gateway.close();
});

test('main listens on the contracts address and closes cleanly on SIGTERM', async () => {
  const { runtime, lines } = fakeRuntime({ port: 0 });
  const proc = new EventEmitter();
  const exited = new Promise((resolve) => { proc.exit = resolve; });
  const gateway = await main({ createRuntime: () => runtime, processRef: proc, createClients: fakeClients().create });
  const { port, address } = gateway.server.address();
  assert.equal(address, contracts.gateway.bind);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  assert.ok(lines.some((l) => l.message === `listening on ${address}:${port}`));

  proc.emit('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(gateway.server.listening, false);
});

test('the unit runs the entry point as the paraclete user, sandboxed to the data root', () => {
  const unit = readFileSync(new URL('../../../../agent/services/gateway/paraclete-gateway.service', import.meta.url), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/paraclete\/agent\/services\/gateway\/main\.mjs$/m);
  assert.match(unit, /^User=paraclete$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/paraclete$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^Restart=always$/m);
});
