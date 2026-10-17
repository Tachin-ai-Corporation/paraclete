// Tests for agent/services/control/upgrade.mjs: only a release tag or a full commit id reaches the
// upgrade script; a missing script fails clearly; the unit is recorded before it starts; and how the
// unit ended (success, failure, a timeout, a stop, or a unit systemd no longer knows) is read back
// without ever reporting an unknown outcome as success. systemd is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContracts } from '../../../../config/contracts.mjs';
import { checkRef, upgradeScript, startUpgrade, upgradeOutcome } from '../../../../agent/services/control/upgrade.mjs';
import { fakeSystemd } from './fakes.mjs';

const releasePattern = loadContracts().versioning.canonical_regex;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const RECORD = { unit: 'paraclete-upgrade-c1.service', ref: 'v2026.10.17.1.1', kind: 'release' };

test('a release tag or a full commit id passes; anything else is refused', () => {
  assert.deepEqual(checkRef('v2026.10.17.1.1', { releasePattern }), { ok: true, kind: 'release', ref: 'v2026.10.17.1.1' });
  assert.deepEqual(checkRef('v2026.10.17.12.3', { releasePattern }), { ok: true, kind: 'release', ref: 'v2026.10.17.12.3' });
  assert.deepEqual(checkRef(COMMIT, { releasePattern }), { ok: true, kind: 'commit', ref: COMMIT });
  const refused = [
    'main', 'feature/x', '0123456', COMMIT.toUpperCase(), `${COMMIT}0`, 'v2026.10.17.1', 'v2026.10.17.1.1x',
    'v2026.10.17.1.1 extra', 'v2026.10.17.1.1;reboot', '--ref=v2026.10.17.1.1', '-v2026.10.17.1.1', '../v2026.10.17.1.1',
    'v2026.10.17.1.1\n', '', undefined, null, 42,
  ];
  for (const ref of refused) {
    const check = checkRef(ref, { releasePattern });
    assert.equal(check.ok, false, JSON.stringify(ref));
    assert.match(check.reason, /release tag such as v2026\.10\.17\.1\.1, or a full 40-character commit id/);
  }
});

test('a loose release pattern cannot let an option or a path through', () => {
  assert.equal(checkRef('--help', { releasePattern: '.*' }).ok, false);
  assert.equal(checkRef('a/b', { releasePattern: '.*' }).ok, false);
  assert.equal(checkRef('v1', { releasePattern: '.*' }).ok, true);
});

test('the upgrade script is install/upgrade.sh under the install root', () => {
  assert.equal(upgradeScript('/opt/paraclete').replace(/\\/g, '/'), '/opt/paraclete/install/upgrade.sh');
});

test('an upgrade records its unit first, then starts the script with the checked ref', async () => {
  const systemd = fakeSystemd();
  const order = [];
  const record = async (detached) => { order.push(['record', detached]); };
  const original = systemd.startUpgrade;
  systemd.startUpgrade = async (...args) => { order.push(['start']); return original(...args); };
  const detached = await startUpgrade({
    commandId: 'c1', ref: 'v2026.10.17.1.1', installRoot: '/opt/paraclete', releasePattern, systemd, record,
    exists: () => true, maxSeconds: 900, now: () => '2026-10-17T12:00:00.000Z',
  });
  assert.deepEqual(detached, { ...RECORD, started_at: '2026-10-17T12:00:00.000Z' });
  assert.deepEqual(order.map((o) => o[0]), ['record', 'start']);
  const [, unit, argv, opts] = systemd.calls.find((c) => c[0] === 'startUpgrade');
  assert.equal(unit, 'paraclete-upgrade-c1.service');
  assert.deepEqual(argv.map((a) => a.replace(/\\/g, '/')), ['/opt/paraclete/install/upgrade.sh', '--ref', 'v2026.10.17.1.1']);
  assert.deepEqual(opts, { description: 'paraclete upgrade to v2026.10.17.1.1', maxSeconds: 900 });
});

test('a bad ref or a missing upgrade script fails before anything is recorded or started', async () => {
  const systemd = fakeSystemd();
  const records = [];
  const base = { commandId: 'c1', installRoot: '/opt/paraclete', releasePattern, systemd, record: async (d) => records.push(d) };
  await assert.rejects(startUpgrade({ ...base, ref: 'main', exists: () => true }), /'main' is not a release tag/);
  await assert.rejects(startUpgrade({ ...base, ref: 'v2026.10.17.1.1', exists: () => false }),
    /upgrade script .*upgrade\.sh is not installed, so this instance cannot upgrade itself/);
  assert.deepEqual(records, []);
  assert.deepEqual(systemd.calls, []);
});

test('a running upgrade is not finished, and its unit is left alone', async () => {
  const systemd = fakeSystemd({ upgradeStates: [{ active: 'active', sub: 'running' }] });
  assert.deepEqual(await upgradeOutcome(RECORD, { systemd }), { finished: false });
  assert.equal(systemd.calls.some((c) => c[0] === 'releaseUpgrade'), false);
});

test('a successful upgrade reports its output and unloads the unit', async () => {
  const systemd = fakeSystemd({ upgradeStates: [{ active: 'active', sub: 'exited', exit_status: 0, result: 'success' }], log: 'installed v2026.10.17.1.1\n' });
  const outcome = await upgradeOutcome(RECORD, { systemd });
  assert.equal(outcome.finished, true);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { ...RECORD, exit_status: 0, outcome: 'success', output: 'installed v2026.10.17.1.1\n' });
  assert.deepEqual(systemd.calls.slice(-2).map((c) => c[0]), ['upgradeLog', 'releaseUpgrade']);
});

test('a failed, timed-out or stopped upgrade fails with its exit status and output', async () => {
  const failed = await upgradeOutcome(RECORD, { systemd: fakeSystemd({ upgradeStates: [{ active: 'failed', sub: 'failed', result: 'exit-code', exit_status: 2 }] }) });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /upgrade to v2026\.10\.17\.1\.1 failed \(exit-code, exit status 2\)/);
  assert.equal(failed.result.output, 'step 1\nstep 2\n');

  const timedOut = await upgradeOutcome(RECORD, { systemd: fakeSystemd({ upgradeStates: [{ active: 'failed', sub: 'failed', result: 'timeout' }] }) });
  assert.match(timedOut.error, /failed \(timeout\)/);

  const stopped = await upgradeOutcome(RECORD, { systemd: fakeSystemd({ upgradeStates: [{ active: 'inactive', sub: 'dead', result: 'success' }] }) });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /was stopped before it finished/);
});

test('an upgrade unit systemd no longer knows is a failure with an unknown outcome, never a success', async () => {
  const systemd = fakeSystemd({ upgradeStates: [{ load: 'not-found', active: 'inactive', sub: 'dead' }] });
  const outcome = await upgradeOutcome(RECORD, { systemd });
  assert.equal(outcome.finished, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /is gone, so how the upgrade to v2026\.10\.17\.1\.1 ended is unknown/);
});

test('a long log keeps its tail, and an unreadable log is said so', async () => {
  const long = `${'x'.repeat(20_000)}THE END`;
  const outcome = await upgradeOutcome(RECORD, { systemd: fakeSystemd({ upgradeStates: [{ active: 'active', sub: 'exited', exit_status: 0 }], log: long }) });
  assert.ok(outcome.result.output.endsWith('THE END'));
  assert.match(outcome.result.output, /^\[… \d+ earlier characters omitted …\]/);
  assert.ok(outcome.result.output.length < 16_100);

  const systemd = fakeSystemd({ upgradeStates: [{ active: 'active', sub: 'exited', exit_status: 0 }] });
  systemd.upgradeLog = async () => { throw new Error('journal unavailable'); };
  const unreadable = await upgradeOutcome(RECORD, { systemd });
  assert.equal(unreadable.ok, true);
  assert.match(unreadable.result.output, /could not be read: journal unavailable/);
});
