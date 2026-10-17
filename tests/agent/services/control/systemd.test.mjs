// Tests for agent/services/control/systemd.mjs: only allowlisted services and upgrade units are ever
// named to systemd, arguments go to the program as an array, and `systemctl show` output is read into
// the state the dashboard shows. A fake runner records each call; one test runs a real child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICES, serviceUnit, upgradeUnit, parseShow, unitState, createSystemd, execFileRunner,
} from '../../../../agent/services/control/systemd.mjs';

function fakeRunner(outputs = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    const out = outputs[`${file} ${args[0]}`];
    if (out instanceof Error) throw out;
    return { stdout: out ?? '', stderr: '' };
  };
  return { run, calls };
}

const SHOW = [
  'LoadState=loaded', 'ActiveState=active', 'SubState=running', 'Result=success', 'MainPID=4242',
  'NRestarts=3', 'ExecMainStatus=0', 'ActiveEnterTimestamp=Sat 2026-10-17 12:00:00 UTC', '',
].join('\n');

test('only the five paraclete services have units', () => {
  assert.deepEqual([...SERVICES], ['gateway', 'brain', 'ears', 'mouth', 'control']);
  assert.equal(serviceUnit('brain'), 'paraclete-brain.service');
  for (const bad of ['sshd', 'ears; reboot', '../brain', 'Brain', '', undefined, 'paraclete-brain']) {
    assert.throws(() => serviceUnit(bad), /is not a paraclete service/, String(bad));
  }
});

test('an upgrade unit name keeps only letters and digits of the command id', () => {
  assert.equal(upgradeUnit('a1B2-c3_d4'), 'paraclete-upgrade-a1B2c3d4.service');
  assert.equal(upgradeUnit('x'.repeat(90)), `paraclete-upgrade-${'x'.repeat(64)}.service`);
  assert.throws(() => upgradeUnit('../;'), /no upgrade unit name/);
  assert.throws(() => upgradeUnit(undefined), /no upgrade unit name/);
});

test('systemctl show output becomes the dashboard state, with empty numbers as null', () => {
  assert.deepEqual(unitState(parseShow(SHOW)), {
    load: 'loaded', active: 'active', sub: 'running', result: 'success', main_pid: 4242, restarts: 3, exit_status: 0,
    since: 'Sat 2026-10-17 12:00:00 UTC',
  });
  assert.deepEqual(unitState(parseShow('LoadState=not-found\nActiveState=inactive\nSubState=dead\nExecMainStatus=\nActiveEnterTimestamp=\n')), {
    load: 'not-found', active: 'inactive', sub: 'dead', result: null, main_pid: null, restarts: null, exit_status: null, since: null,
  });
});

test('service state and restarts name the allowlisted unit', async () => {
  const { run, calls } = fakeRunner({ 'systemctl show': SHOW });
  const systemd = createSystemd({ run });
  const state = await systemd.serviceState('gateway');
  assert.equal(state.unit, 'paraclete-gateway.service');
  assert.equal(state.active, 'active');
  await systemd.restart('brain');
  await systemd.restart('control', { noBlock: true });
  assert.deepEqual(calls, [
    ['systemctl', 'show', 'paraclete-gateway.service', '--property=LoadState,ActiveState,SubState,Result,MainPID,NRestarts,ExecMainStatus,ActiveEnterTimestamp'],
    ['systemctl', 'restart', 'paraclete-brain.service'],
    ['systemctl', 'restart', '--no-block', 'paraclete-control.service'],
  ]);
  await assert.rejects(systemd.restart('sshd'), /is not a paraclete service/);
  assert.equal(calls.length, 3);
});

test('an upgrade runs in a transient unit that outlives control and keeps its outcome', async () => {
  const { run, calls } = fakeRunner({ 'journalctl --unit=paraclete-upgrade-c1.service': 'done\n' });
  const systemd = createSystemd({ run });
  await systemd.startUpgrade('paraclete-upgrade-c1.service', ['/opt/paraclete/install/upgrade.sh', '--ref', 'v2026.10.17.1.1'], {
    description: 'paraclete upgrade to v2026.10.17.1.1', maxSeconds: 1800,
  });
  assert.deepEqual(calls[0], [
    'systemd-run', '--unit=paraclete-upgrade-c1.service', '--description=paraclete upgrade to v2026.10.17.1.1',
    '--property=RemainAfterExit=yes', '--property=RuntimeMaxSec=1800', '--',
    '/opt/paraclete/install/upgrade.sh', '--ref', 'v2026.10.17.1.1',
  ]);
  assert.equal(await systemd.upgradeLog('paraclete-upgrade-c1.service', 50), 'done\n');
  assert.deepEqual(calls[1], ['journalctl', '--unit=paraclete-upgrade-c1.service', '--no-pager', '--output=cat', '--lines=50']);
});

test('upgrade calls refuse any unit that is not an upgrade unit', async () => {
  const { run, calls } = fakeRunner();
  const systemd = createSystemd({ run });
  for (const unit of ['paraclete-brain.service', 'sshd.service', 'paraclete-upgrade-a;b.service', 'paraclete-upgrade-.service']) {
    await assert.rejects(systemd.startUpgrade(unit, ['/bin/true'], { description: 'x', maxSeconds: 1 }), /is not an upgrade unit/);
    await assert.rejects(systemd.upgradeState(unit), /is not an upgrade unit/);
    await assert.rejects(systemd.upgradeLog(unit, 10), /is not an upgrade unit/);
    await assert.rejects(systemd.releaseUpgrade(unit), /is not an upgrade unit/);
  }
  assert.equal(calls.length, 0);
});

test('releasing an upgrade unit stops and resets it, and tolerates a unit already gone', async () => {
  const { run, calls } = fakeRunner({ 'systemctl stop': new Error('Unit not loaded') });
  await createSystemd({ run }).releaseUpgrade('paraclete-upgrade-c1.service');
  assert.deepEqual(calls, [
    ['systemctl', 'stop', 'paraclete-upgrade-c1.service'],
    ['systemctl', 'reset-failed', 'paraclete-upgrade-c1.service'],
  ]);
});

test('the runner passes arguments without a shell and reports stderr when a program fails', async () => {
  const run = execFileRunner();
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); ls']);
  assert.equal(stdout, '$(echo injected); ls');
  await assert.rejects(
    run(process.execPath, ['-e', 'process.stderr.write("Unit sshd.service not allowed\\n"); process.exit(3)']),
    (err) => /failed: Unit sshd\.service not allowed$/.test(err.message) && err.code === 3,
  );
});
