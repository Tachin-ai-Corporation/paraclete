// Tests for agent/services/control/commands.mjs: the command set is closed and matches the README;
// restart_service names only allowlisted services, restarts control only after recording the command,
// and waits for a restarted gateway; set_model, run_responsibility and upgrade reach their modules with
// the command's id and requester. Run through the real queue against fake Firestore, systemd and
// gateway, the way the service runs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHandlers, COMMAND_TYPES } from '../../../../agent/services/control/commands.mjs';
import { createCommandQueue } from '../../../../agent/services/control/command-queue.mjs';
import { fakeDb, fakeSystemd, fakeGatewayFetch, controlRuntime, GATEWAY_TOKEN } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const SETTINGS = { readyTimeoutMs: 3_000, upgradeMaxSeconds: 900 };

function harness({ systemd = fakeSystemd(), gateway = fakeGatewayFetch(), exists, role } = {}) {
  const db = fakeDb();
  const runtime = controlRuntime({ db, fetch: gateway.fetch, role });
  let clock = NOW.getTime();
  const handlers = createHandlers({
    runtime, systemd, settings: SETTINGS, now: () => new Date(clock), sleep: async (ms) => { clock += ms; }, ...(exists ? { exists } : {}),
  });
  const queue = createCommandQueue({ db, collections: runtime.collections, handlers, verifyCommand: async () => ({}), now: () => NOW });
  /** Sends one command through the queue and returns its document afterwards. */
  async function send(type, params, id = `c${db.paths('commands/').length + 1}`) {
    db.set(`commands/${id}`, { type, params, status: 'pending', requested_by: 'admin@example.com', created_at: NOW.toISOString() });
    await queue.tick();
    return db.get(`commands/${id}`);
  }
  return { db, runtime, systemd, gateway, handlers, queue, send };
}

test('the command set is closed, and the README documents every command', () => {
  const { handlers } = harness();
  assert.deepEqual(Object.keys(handlers), [...COMMAND_TYPES]);
  const readme = readFileSync(new URL('../../../../agent/services/control/README.md', import.meta.url), 'utf8');
  for (const type of COMMAND_TYPES) assert.match(readme, new RegExp(`### \`${type}\``), `README.md documents ${type}`);
  for (const dropped of ['discover_models', 'run_command', 'exec', 'shell', 'deploy']) {
    assert.equal(Object.hasOwn(handlers, dropped), false, dropped);
  }
});

test('restart_service refuses anything off the allowlist without touching systemd', async () => {
  const { send, systemd } = harness();
  for (const service of ['sshd', 'brain; reboot', '../brain', 'paraclete-brain', undefined, ['brain']]) {
    const doc = await send('restart_service', { service });
    assert.equal(doc.status, 'failed');
    assert.match(doc.error, /^params\.service must be one of gateway, brain, ears, mouth, control/);
  }
  assert.deepEqual(systemd.calls, []);
});

test('restart_service restarts a service and reports its state; a unit that does not come back fails', async () => {
  const { send, systemd } = harness();
  const doc = await send('restart_service', { service: 'brain' });
  assert.equal(doc.status, 'done');
  assert.deepEqual(systemd.calls.slice(0, 2), [['restart', 'brain', {}], ['state', 'brain']]);
  assert.equal(doc.result.unit, 'paraclete-brain.service');
  assert.equal(doc.result.state.active, 'active');

  const failing = harness({ systemd: fakeSystemd({ states: { ears: { active: 'activating', sub: 'auto-restart' } } }) });
  const ears = await failing.send('restart_service', { service: 'ears' });
  assert.equal(ears.status, 'failed');
  assert.match(ears.error, /paraclete-ears\.service is activating \(auto-restart\) after the restart/);
  assert.equal(ears.result.state.sub, 'auto-restart');
});

test('restarting the gateway waits until it is ready again', async () => {
  const ok = harness({ gateway: fakeGatewayFetch({ readyAfter: 2, models: { cortex: 'vertex-google/gemini-4-argon' } }) });
  const doc = await ok.send('restart_service', { service: 'gateway' });
  assert.equal(doc.status, 'done');
  assert.equal(doc.result.gateway.ready, true);
  assert.deepEqual(doc.result.gateway.models, { cortex: 'vertex-google/gemini-4-argon' });

  const down = harness({ gateway: fakeGatewayFetch({ down: true }) });
  const failed = await down.send('restart_service', { service: 'gateway' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /the gateway restarted but is not ready \(the gateway did not answer/);
});

test('control restarts itself only after the command is recorded as done', async () => {
  const systemd = fakeSystemd();
  const h = harness({ systemd });
  let statusAtRestart;
  systemd.restart = async (service, opts) => {
    systemd.calls.push(['restart', service, opts]);
    statusAtRestart = h.db.get('commands/self').status;
  };
  const doc = await h.send('restart_service', { service: 'control' }, 'self');
  assert.equal(doc.status, 'done');
  assert.equal(doc.result.restarting, true);
  assert.equal(statusAtRestart, 'done');
  assert.deepEqual(systemd.calls, [['restart', 'control', { noBlock: true }]]);
});

test('set_model records who switched Claude on and checks the gateway with the token', async () => {
  const { send, db, gateway, runtime } = harness({ gateway: fakeGatewayFetch({ models: { cortex: 'vertex-anthropic/claude-opus-4-6' } }) });
  const contractsClaude = runtime.contracts.vertex.models.claude;
  assert.equal(contractsClaude, 'vertex-anthropic/claude-opus-4-6', 'this test assumes the contracts Claude model');
  const doc = await send('set_model', { claude_enabled: true });
  assert.equal(doc.status, 'done', doc.error);
  assert.equal(db.get('config/settings').claude_enabled, true);
  assert.equal(db.get('config/settings').claude_updated_by, 'admin@example.com');
  assert.ok(gateway.calls.some((c) => c.headers.Authorization === `Bearer ${GATEWAY_TOKEN}`));

  const refused = await send('set_model', { claude_enabled: 'yes' });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /params\.claude_enabled must be true or false/);
});

test('run_responsibility queues a trigger keyed by the command id', async () => {
  const { send, db, runtime } = harness();
  writeFileSync(join(runtime.paths.genericRole, 'responsibilities.json'), JSON.stringify([{
    id: 'r-weekly-digest', name: 'Weekly digest', schedule: '0 9 * * 1', enabled: true,
    instruction: 'Write the weekly digest of finished work.', success_criteria: 'A digest was delivered to the owner.',
  }]));
  const doc = await send('run_responsibility', { id: 'r-weekly-digest' }, 'cmdrun');
  assert.equal(doc.status, 'done', doc.error);
  assert.equal(doc.result.trigger_id, 'cmdrun');
  assert.equal(db.get('responsibility_triggers/cmdrun').requested_by, 'admin@example.com');
});

test('upgrade records its unit, starts the installed script, and finishes when the unit does', async () => {
  const systemd = fakeSystemd({ upgradeStates: [{ active: 'active', sub: 'running' }, { active: 'active', sub: 'exited', exit_status: 0, result: 'success' }] });
  const h = harness({ systemd, exists: () => true });
  const running = await h.send('upgrade', { ref: 'v2026.10.17.1.1' }, 'up1');
  assert.equal(running.status, 'running');
  assert.deepEqual(running.detached, { unit: 'paraclete-upgrade-up1.service', ref: 'v2026.10.17.1.1', kind: 'release', started_at: NOW.toISOString() });
  const start = systemd.calls.find((c) => c[0] === 'startUpgrade');
  assert.equal(start[2][0].replace(/\\/g, '/'), `${h.runtime.paths.installRoot.replace(/\\/g, '/')}/install/upgrade.sh`);
  assert.deepEqual(start[2].slice(1), ['--ref', 'v2026.10.17.1.1']);
  assert.equal(start[3].maxSeconds, SETTINGS.upgradeMaxSeconds);

  await h.queue.tick();
  assert.equal(h.db.get('commands/up1').status, 'running');
  await h.queue.tick();
  const done = h.db.get('commands/up1');
  assert.equal(done.status, 'done');
  assert.equal(done.result.exit_status, 0);
  assert.equal(done.result.output, 'step 1\nstep 2\n');
});

test('upgrade fails clearly while the upgrade script is not installed, and refuses a bad ref', async () => {
  const h = harness();
  const missing = await h.send('upgrade', { ref: 'v2026.10.17.1.1' });
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /upgrade\.sh is not installed, so this instance cannot upgrade itself/);

  mkdirSync(join(h.runtime.paths.installRoot, 'install'), { recursive: true });
  writeFileSync(join(h.runtime.paths.installRoot, 'install', 'upgrade.sh'), '#!/usr/bin/env bash\n');
  const branch = await h.send('upgrade', { ref: 'main' });
  assert.equal(branch.status, 'failed');
  assert.match(branch.error, /'main' is not a release tag/);
  assert.equal(h.systemd.calls.length, 0);
});

test('the read-only views answer through the queue', async () => {
  const { send, runtime } = harness({ gateway: fakeGatewayFetch({ models: { cortex: 'vertex-google/gemini-4-argon' } }) });
  writeFileSync(join(runtime.paths.installRoot, 'release.json'), JSON.stringify({ version: 'v2026.10.17.1.1' }));

  const status = await send('status', {});
  assert.equal(status.status, 'done');
  assert.deepEqual(Object.keys(status.result.services), ['gateway', 'brain', 'ears', 'mouth', 'control']);
  assert.deepEqual(status.result.gateway.models, { cortex: 'vertex-google/gemini-4-argon' });
  assert.deepEqual(status.result.release, { version: 'v2026.10.17.1.1' });

  const config = await send('config', {});
  assert.equal(config.result.settings.claude_enabled, false);
  assert.equal(config.result.release.version, 'v2026.10.17.1.1');

  for (const type of ['skills', 'workspace', 'brain_config', 'responsibilities']) {
    const doc = await send(type, {});
    assert.equal(doc.status, 'done', `${type}: ${doc.error}`);
  }
});
