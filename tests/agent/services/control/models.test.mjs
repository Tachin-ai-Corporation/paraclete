// Tests for agent/services/control/models.mjs: the Claude switch writes only its own fields of
// config/settings, stores a Claude model only when the contracts list it, restarts the gateway and
// checks the restarted gateway runs the cortex and strong-tier model the switch implies (the gateway's
// own rule, a stored choice included); the settings are read strictly; and the model view shows the
// contracts' tiers beside what the gateway runs. Fake Firestore, systemd and gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContracts } from '../../../../config/contracts.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { readSettingsView, setClaude, readBrainConfig } from '../../../../agent/services/control/models.mjs';
import { fakeDb, fakeSystemd, fakeGatewayFetch, GATEWAY_TOKEN } from './fakes.mjs';

const contracts = loadContracts();
const m = contracts.vertex.models;
const GEMINI = { cortex: m.cortex, strong: m.strong, fast: m.fast, fallback: m.fallback };
const CLAUDE = { cortex: m.claude, strong: m.claude, fast: m.fast, fallback: m.claude_fallback };
const nowIso = () => '2026-10-17T12:00:00.000Z';

function gatewayFor(fetch) {
  let clock = 0;
  return {
    url: 'http://127.0.0.1:18789', token: GATEWAY_TOKEN, readyTimeoutMs: 3_000, fetch,
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  };
}

test('the settings view: no document means Claude off and the default effort; read strictly', async () => {
  assert.deepEqual(await readSettingsView({ db: fakeDb(), contracts }), {
    claude_enabled: false, claude_model: m.claude, claude_model_ignored: null,
    effort: contracts.effort.default, claude_updated_at: null, claude_updated_by: null,
  });
  const db = fakeDb({ 'config/settings': { claude_enabled: true, effort: 'high' } });
  const settings = await readSettingsView({ db, contracts });
  assert.equal(settings.claude_enabled, true);
  assert.equal(settings.effort, 'high');
  assert.deepEqual(db.calls[0].opts, { strict: true });
});

test('the settings view names the Claude model that runs: a listed choice, else the contracts one with the choice set aside', async () => {
  const newest = m.claude_candidates[0];
  const chosen = await readSettingsView({ db: fakeDb({ 'config/settings': { claude_enabled: true, claude_model: newest } }), contracts });
  assert.deepEqual([chosen.claude_model, chosen.claude_model_ignored], [newest, null]);
  const dropped = await readSettingsView({ db: fakeDb({ 'config/settings': { claude_enabled: true, claude_model: 'vertex-anthropic/claude-opus-1' } }), contracts });
  assert.deepEqual([dropped.claude_model, dropped.claude_model_ignored], [m.claude, 'vertex-anthropic/claude-opus-1']);
});

test('turning Claude on writes only the Claude fields, restarts the gateway and confirms the Claude cortex', async () => {
  const db = fakeDb({ 'config/settings': { effort: 'high', other: 'kept' } });
  const systemd = fakeSystemd();
  const result = await setClaude({
    enabled: true, actor: 'admin@example.com', db, contracts, systemd,
    gateway: gatewayFor(fakeGatewayFetch({ models: CLAUDE }).fetch), nowIso,
  });
  assert.deepEqual(db.get('config/settings'), {
    effort: 'high', other: 'kept', claude_enabled: true, claude_updated_at: nowIso(), claude_updated_by: 'admin@example.com',
  });
  const patch = db.calls.find((c) => c.op === 'patch');
  assert.deepEqual(patch.fieldPaths, ['claude_enabled', 'claude_updated_at', 'claude_updated_by']);
  assert.deepEqual(systemd.calls, [['restart', 'gateway', {}]]);
  assert.equal(result.claude_enabled, true);
  assert.equal(result.expected_cortex, m.claude);
  assert.deepEqual(result.gateway.models, CLAUDE);
});

test('turning Claude off expects the Gemini cortex back', async () => {
  const db = fakeDb({ 'config/settings': { claude_enabled: true } });
  const result = await setClaude({
    enabled: false, db, contracts, systemd: fakeSystemd(),
    gateway: gatewayFor(fakeGatewayFetch({ models: GEMINI }).fetch), nowIso,
  });
  assert.equal(db.get('config/settings').claude_enabled, false);
  assert.equal(db.get('config/settings').claude_updated_by, null);
  assert.equal(result.expected_cortex, m.cortex);
});

test('a switch that is not a boolean is refused before anything is written or restarted', async () => {
  const db = fakeDb();
  const systemd = fakeSystemd();
  for (const enabled of ['true', 1, undefined, null]) {
    await assert.rejects(setClaude({ enabled, db, contracts, systemd, gateway: gatewayFor(fakeGatewayFetch().fetch) }),
      /params\.claude_enabled must be true or false/);
  }
  assert.equal(db.calls.length, 0);
  assert.equal(systemd.calls.length, 0);
});

test('a restarted gateway that is not ready fails the switch, pointing at the terms when Claude was turned on', async () => {
  const err = await setClaude({
    enabled: true, db: fakeDb(), contracts, systemd: fakeSystemd(),
    gateway: gatewayFor(fakeGatewayFetch({ ready: false }).fetch), nowIso,
  }).catch((e) => e);
  assert.ok(err.message.startsWith(`Claude is on (${m.claude}) in the settings, but the restarted gateway is not ready. Check in Settings, Models that the model passes Test`), err.message);
  assert.equal(err.result.claude_enabled, true);
  assert.equal(err.result.gateway.ready, false);
});

test('a gateway still on the old cortex model fails the switch', async () => {
  const err = await setClaude({
    enabled: true, db: fakeDb(), contracts, systemd: fakeSystemd(),
    gateway: gatewayFor(fakeGatewayFetch({ models: GEMINI }).fetch), nowIso,
  }).catch((e) => e);
  assert.match(err.message, new RegExp(`the gateway runs ${m.cortex} for the cortex, not ${m.claude}`.replace(/[.]/g, '\\.')));
});

test('turning Claude on with a tested model stores it and checks the gateway runs it for the cortex and the strong tier', async () => {
  const newest = m.claude_candidates[0];
  const db = fakeDb({ 'config/settings': { effort: 'high' } });
  const running = { cortex: newest, strong: newest, fast: m.fast, fallback: m.claude_fallback };
  const result = await setClaude({
    enabled: true, model: newest, actor: 'admin@example.com', db, contracts, systemd: fakeSystemd(),
    gateway: gatewayFor(fakeGatewayFetch({ models: running }).fetch), nowIso,
  });
  assert.deepEqual(db.get('config/settings'), {
    effort: 'high', claude_enabled: true, claude_model: newest, claude_updated_at: nowIso(), claude_updated_by: 'admin@example.com',
  });
  assert.deepEqual(db.calls.find((c) => c.op === 'patch').fieldPaths, ['claude_enabled', 'claude_updated_at', 'claude_updated_by', 'claude_model']);
  assert.equal(db.calls.some((c) => c.op === 'read'), false, 'the model named is the expectation: nothing to read');
  assert.deepEqual([result.claude_model, result.expected_cortex], [newest, newest]);

  // The gateway on the contracts' Claude model, not the chosen one, fails the switch.
  const err = await setClaude({
    enabled: true, model: newest, db: fakeDb(), contracts, systemd: fakeSystemd(),
    gateway: gatewayFor(fakeGatewayFetch({ models: CLAUDE }).fetch), nowIso,
  }).catch((e) => e);
  assert.ok(err.message.includes(`the gateway runs ${m.claude} for the cortex, not ${newest}`), err.message);
});

test('a strong tier left behind fails the switch even when the cortex moved', async () => {
  const err = await setClaude({
    enabled: true, db: fakeDb(), contracts, systemd: fakeSystemd(),
    gateway: gatewayFor(fakeGatewayFetch({ models: { ...CLAUDE, strong: m.strong } }).fetch), nowIso,
  }).catch((e) => e);
  assert.ok(err.message.includes(`the gateway runs ${m.strong} for the strong tier, not ${m.claude}`), err.message);
});

test('without a model named, turning Claude on expects the stored choice; turning it off keeps the choice and expects Gemini', async () => {
  const chosen = m.claude_candidates[1];
  const running = { cortex: chosen, strong: chosen, fast: m.fast, fallback: m.claude_fallback };
  const db = fakeDb({ 'config/settings': { claude_enabled: false, claude_model: chosen } });
  const on = await setClaude({ enabled: true, db, contracts, systemd: fakeSystemd(), gateway: gatewayFor(fakeGatewayFetch({ models: running }).fetch), nowIso });
  assert.deepEqual([on.claude_model, on.expected_cortex], [chosen, chosen]);
  assert.deepEqual(db.calls.find((c) => c.op === 'read').opts, { strict: true });

  const off = await setClaude({ enabled: false, db, contracts, systemd: fakeSystemd(), gateway: gatewayFor(fakeGatewayFetch({ models: GEMINI }).fetch), nowIso });
  assert.deepEqual([off.claude_model, off.expected_cortex], [null, m.cortex]);
  assert.equal(db.get('config/settings').claude_model, chosen, 'the choice stays for the next time Claude is turned on');
});

test('a Claude model the contracts do not list is refused before anything is read, written or restarted', async () => {
  const db = fakeDb();
  const systemd = fakeSystemd();
  for (const model of ['vertex-anthropic/claude-opus-1', 'claude-opus-5-5', m.cortex, null, 5, ['x']]) {
    await assert.rejects(setClaude({ enabled: true, model, db, contracts, systemd, gateway: gatewayFor(fakeGatewayFetch().fetch) }),
      /^Error: params\.claude_model must be one of vertex-anthropic\/claude-opus-5-5, /);
  }
  assert.equal(db.calls.length, 0);
  assert.equal(systemd.calls.length, 0);
});

test('a settings write that fails stops the switch before the gateway restarts', async () => {
  const db = fakeDb();
  db.failOnce('patch', new StoreUnavailable('patch', 'config/settings', 403, 'denied'));
  const systemd = fakeSystemd();
  await assert.rejects(setClaude({ enabled: true, db, contracts, systemd, gateway: gatewayFor(fakeGatewayFetch().fetch), nowIso }), /HTTP 403/);
  assert.equal(systemd.calls.length, 0);
});

test('the model view: settings, the contracts tiers, and what the running gateway reports', async () => {
  const db = fakeDb({ 'config/settings': { claude_enabled: false, effort: 'low' } });
  const view = await readBrainConfig({ db, contracts, gateway: gatewayFor(fakeGatewayFetch({ models: GEMINI }).fetch) });
  assert.equal(view.settings.effort, 'low');
  assert.deepEqual(view.tiers, { ...m });
  assert.deepEqual(view.locations, { google: contracts.vertex.location, anthropic: contracts.vertex.anthropic_location });
  assert.deepEqual(view.running.models, GEMINI);
  assert.equal(view.organ_max_steps, contracts.organs.max_steps);
  assert.deepEqual(view.service_models, { utility: contracts.utility.model, ears_preprocess: contracts.ears.preprocess.model, mouth: contracts.mouth.model });
});

test('the model view still answers when the gateway is down', async () => {
  const view = await readBrainConfig({ db: fakeDb(), contracts, gateway: gatewayFor(fakeGatewayFetch({ down: true }).fetch) });
  assert.equal(view.running.reachable, false);
  assert.equal(view.settings.claude_enabled, false);
});
