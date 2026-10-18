// Tests for agent/services/control/main.mjs: timings come from the contracts with defaults, ticks
// never overlap and survive a store outage, SIGTERM waits for the command in progress, and the unit
// runs as root inside a sandbox that can write nothing. Fake timers, Firestore and systemd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { controlSettings, buildControl, main, DEFAULT_CONTROL_SETTINGS } from '../../../../agent/services/control/main.mjs';
import { fakeDb, fakeSystemd, controlRuntime } from './fakes.mjs';

/** Timers that run only when the test says so. */
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    async fire() { const t = pending.shift(); t.fn(); await new Promise((r) => setImmediate(r)); },
  };
}

const settle = () => new Promise((r) => setImmediate(r));
/** Accepts every command, as the real check does for one the dashboard signed. */
const acceptSigned = async () => ({});

test('timings default when the contracts have no control section, and a set value overrides', () => {
  assert.deepEqual(controlSettings({}), { ...DEFAULT_CONTROL_SETTINGS });
  assert.deepEqual(controlSettings({ control: { poll_ms: 2000, upgrade_max_seconds: 600, gateway_ready_timeout_ms: -1 } }), {
    pollMs: 2000, readyTimeoutMs: DEFAULT_CONTROL_SETTINGS.readyTimeoutMs, upgradeMaxSeconds: 600,
  });
});

test('the service ticks at once, then every pollMs after the last tick ends', async () => {
  const db = fakeDb({ 'commands/c1': { type: 'status', status: 'pending', created_at: '2026-10-17T11:00:00.000Z' } });
  const runtime = controlRuntime({ db });
  const timers = manualTimers();
  const control = buildControl(runtime, { verifyCommand: acceptSigned, systemd: fakeSystemd(), ...timers });
  control.start();
  await settle();
  assert.equal(db.get('commands/c1').status, 'done');
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, DEFAULT_CONTROL_SETTINGS.pollMs);

  db.set('commands/c2', { type: 'skills', status: 'pending', created_at: '2026-10-17T11:01:00.000Z' });
  await timers.fire();
  await settle();
  assert.equal(db.get('commands/c2').status, 'done');
  await control.stop();
  assert.equal(timers.pending.length, 0);
});

test('a store outage is logged and the next tick tries again', async () => {
  const db = fakeDb();
  db.failOnce('query', new StoreUnavailable('query', 'commands', 503, 'unavailable'));
  const runtime = controlRuntime({ db });
  const timers = manualTimers();
  const control = buildControl(runtime, { verifyCommand: acceptSigned, systemd: fakeSystemd(), ...timers });
  control.start();
  await settle();
  assert.ok(runtime.lines.some((l) => l.level === 'ERROR' && /command poll failed: .*HTTP 503.*trying again/.test(l.message)));
  assert.equal(timers.pending.length, 1, 'polling continues');
  await control.stop();
});

test('stop waits for the command in progress and schedules nothing after it', async () => {
  const db = fakeDb({ 'commands/c1': { type: 'restart_service', params: { service: 'brain' }, status: 'pending', created_at: 'a' } });
  const runtime = controlRuntime({ db });
  const timers = manualTimers();
  let release;
  const systemd = fakeSystemd();
  systemd.restart = () => new Promise((resolve) => { release = resolve; });
  const control = buildControl(runtime, { verifyCommand: acceptSigned, systemd, ...timers });
  control.start();
  await settle();
  assert.equal(db.get('commands/c1').status, 'running');
  const stopped = control.stop();
  release();
  await stopped;
  assert.equal(db.get('commands/c1').status, 'done');
  assert.equal(timers.pending.length, 0);
});

test('main starts polling and exits cleanly on SIGTERM', async () => {
  const runtime = controlRuntime();
  const timers = manualTimers();
  const proc = new EventEmitter();
  const exited = new Promise((resolve) => { proc.exit = resolve; });
  main({ createRuntime: () => runtime, processRef: proc, systemd: fakeSystemd(), ...timers });
  await settle();
  assert.ok(runtime.lines.some((l) => l.message === `polling commands every ${DEFAULT_CONTROL_SETTINGS.pollMs}ms`));
  proc.emit('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(timers.pending.length, 0);
});

test('the unit runs as root, sandboxed so that it can write on disk only /etc/paraclete', () => {
  const unit = readFileSync(new URL('../../../../agent/services/control/paraclete-control.service', import.meta.url), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/paraclete\/agent\/services\/control\/main\.mjs$/m);
  assert.match(unit, /^User=root$/m);
  for (const line of ['ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'Restart=always',
    'ReadOnlyPaths=/opt/paraclete', 'ReadWritePaths=/etc/paraclete']) {
    assert.match(unit, new RegExp(`^${line}$`, 'm'), line);
  }
  assert.equal(unit.match(/^ReadWritePaths=/gm).length, 1, 'set_workspace_account writes in /etc/paraclete; nothing else is writable');
  assert.doesNotMatch(unit, /^KillMode=/m, 'an upgrade survives control restarts by running in its own unit, not by KillMode');
});

test('by default only commands signed by the dashboard account run: an unsigned one is refused', async () => {
  const db = fakeDb({ 'commands/c1': { type: 'status', status: 'pending', created_at: '2026-10-17T11:00:00.000Z', requested_by: 'admin@example.com' } });
  const runtime = controlRuntime({ db });
  const timers = manualTimers();
  const control = buildControl(runtime, { systemd: fakeSystemd(), ...timers });
  control.start();
  await settle();
  await control.stop();
  assert.equal(db.get('commands/c1').status, 'failed');
  assert.equal(db.get('commands/c1').error, 'refused: the command is not signed');
});
