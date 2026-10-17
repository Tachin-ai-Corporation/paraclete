// Tests for agent/services/control/models.mjs: the Claude switch writes only its own fields of
// config/settings, restarts the gateway and checks the restarted gateway runs the cortex model the
// switch implies; the settings are read strictly; and the model view shows the contracts' tiers beside
// what the gateway runs. Fake Firestore, systemd and gateway.
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
    claude_enabled: false, effort: contracts.effort.default, claude_updated_at: null, claude_updated_by: null,
  });
  const db = fakeDb({ 'config/settings': { claude_enabled: true, effort: 'high' } });
  const settings = await readSettingsView({ db, contracts });
  assert.equal(settings.claude_enabled, true);
  assert.equal(settings.effort, 'high');
  assert.deepEqual(db.calls[0].opts, { strict: true });
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
  assert.match(err.message, /^Claude is on in the settings, but the restarted gateway is not ready\. Check that Anthropic's terms are accepted/);
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
