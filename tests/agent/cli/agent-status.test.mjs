// Tests for agent/cli/agent-status.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, SERVICES } from '../../../agent/cli/agent-status.mjs';
import { fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');

function systemctl(stdout, code = 0) {
  const calls = [];
  return { calls, run: async (file, args) => { calls.push([file, ...args]); return { code, stdout, stderr: '' }; } };
}

const status = (argv, { instance = {}, sys = systemctl('active\nactive\nactive\nactive\nactive\n') } = {}) =>
  run(main, argv, { runtime: fakeRuntime({ instance }), now: () => NOW, run: sys.run }).then((r) => ({ ...r, sys }));

test('reports the instance and each service\'s systemd state as JSON', async () => {
  const r = await status([], {
    instance: { role: 'devops', release: 'v2026.10.17.1.0' },
    sys: systemctl('active\nactive\nfailed\nactive\nactivating\n', 3),
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), {
    agent_name: 'Paraclete',
    role: 'devops',
    project: 'your-gcp-project',
    release: 'v2026.10.17.1.0',
    workspace_account: null,
    services: { brain: 'active', ears: 'active', mouth: 'failed', control: 'active', gateway: 'activating' },
    checked_at: NOW.toISOString(),
  });
  assert.deepEqual(r.sys.calls[0], ['systemctl', 'is-active', ...SERVICES.map((s) => `paraclete-${s}.service`)]);
});

test('get --field prints one field; release is empty when the record names none', async () => {
  let r = await status(['get', '--field', 'role']);
  assert.equal(r.out, 'generic\n');
  r = await status(['--field', 'release']);
  assert.equal(r.out, '\n');
  r = await status(['--field', 'services']);
  assert.equal(JSON.parse(r.out).brain, 'active');
  r = await status(['--field', 'state']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Unknown field: state/);
});

test('without systemctl every service is unknown; set is gone', async () => {
  let r = await status([], { sys: systemctl('', 127) });
  assert.deepEqual(Object.values(JSON.parse(r.out).services), SERVICES.map(() => 'unknown'));
  r = await status(['set', 'idle']);
  assert.equal(r.code, 1);
  assert.match(r.err, /agent-status set is gone/);
});
