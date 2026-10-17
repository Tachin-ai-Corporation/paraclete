// Tests for agent/services/service-runtime.mjs: the runtime every service starts from, the admin
// settings reader the brain, the gateway and the control service share, and the skill directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import {
  ADMIN_SETTINGS_PATH, createServiceRuntime, createLogger, readAdminSettings, skillDirectories,
} from '../../../agent/services/service-runtime.mjs';

function instanceFile(over = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'runtime-')), 'instance.json');
  writeFileSync(path, JSON.stringify({
    project: 'your-gcp-project', region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete',
    role: 'generic', install_root: '/opt/paraclete', data_root: '/var/lib/paraclete',
    bucket: 'your-gcp-project-paraclete', ...over,
  }));
  return path;
}

test('the logger writes one JSON object per line, and its own keys win over fields', () => {
  const lines = [];
  const log = createLogger('brain', { write: (l) => lines.push(l), now: () => new Date('2026-10-17T12:00:00Z') });
  log('INFO', 'mission started', { mission: 'w-1', level: 'spoofed' });
  assert.deepEqual(JSON.parse(lines[0]), {
    mission: 'w-1', time: '2026-10-17T12:00:00.000Z', level: 'INFO', service: 'brain', message: 'mission started',
  });
});

test('a runtime carries the contracts, the instance, paths under the right roots, and the gateway address', () => {
  const runtime = createServiceRuntime({ service: 'brain', instancePath: instanceFile(), write: () => {} });
  assert.equal(runtime.contracts.brain.max_iterations > 0, true);
  assert.equal(runtime.instance.role, 'generic');
  assert.equal(runtime.paths.role.replace(/\\/g, '/'), '/opt/paraclete/roles/generic');
  assert.equal(runtime.paths.data.workingMemoryFile.replace(/\\/g, '/'), '/var/lib/paraclete/memory/MEMORY.md');
  assert.equal(runtime.gatewayUrl, 'http://127.0.0.1:18789');
  assert.equal(runtime.collections.work, 'work');
});

test('instance endpoints point the Firestore client and the gateway at local fakes', async () => {
  const calls = [];
  const runtime = createServiceRuntime({
    service: 'brain',
    instancePath: instanceFile({ endpoints: { firestore: 'http://127.0.0.1:8085', gateway: 'http://127.0.0.1:9999' } }),
    getAccessToken: async () => 'test-token',
    fetch: async (url) => { calls.push(url); return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; },
    write: () => {},
  });
  assert.equal(await runtime.db.read('work/w-1'), null);
  assert.match(calls[0], /^http:\/\/127\.0\.0\.1:8085\/v1\/projects\/your-gcp-project\/databases\/\(default\)\/documents\/work\/w-1$/);
  assert.equal(runtime.gatewayUrl, 'http://127.0.0.1:9999');
});

test('a service will not start on a bad instance record or without a name', () => {
  assert.throws(() => createServiceRuntime({ service: 'brain', instancePath: instanceFile({ bucket: '' }), write: () => {} }), /instance\.bucket is required/);
  assert.throws(() => createServiceRuntime({}), /service is required/);
});

/** A Firestore client stand-in holding the admin settings document, or failing every read. */
function settingsDb(doc, { fail = false } = {}) {
  const reads = [];
  return {
    reads,
    async read(path, opts) {
      reads.push({ path, opts });
      if (fail && opts?.strict) throw new StoreUnavailable('read', path, 503, 'down');
      return fail ? null : doc;
    },
  };
}

test('the admin settings live in config/settings and come back decoded, or as {} when absent', async () => {
  assert.equal(ADMIN_SETTINGS_PATH, 'config/settings');
  const db = settingsDb({ effort: 'high', claude_enabled: true });
  assert.deepEqual(await readAdminSettings(db, { strict: true }), { effort: 'high', claude_enabled: true });
  assert.deepEqual(db.reads[0], { path: 'config/settings', opts: { strict: true } });
  assert.deepEqual(await readAdminSettings(settingsDb(null), { strict: true }), {});
});

test('a strict read of unreadable settings throws, so a service keeps what it has or refuses to start', async () => {
  await assert.rejects(readAdminSettings(settingsDb(null, { fail: true }), { strict: true }), StoreUnavailable);
  const lenient = settingsDb(null, { fail: true });
  assert.deepEqual(await readAdminSettings(lenient), {}, 'not strict, a failure reads as no document');
  assert.deepEqual(lenient.reads[0].opts, { strict: false });
});

test('skill directories: base, generic role, the chosen role when it differs, then the agent-written skills', () => {
  const pathsFor = (role) => ({
    skills: '/opt/paraclete/skills',
    genericRole: '/opt/paraclete/roles/generic',
    role: `/opt/paraclete/roles/${role}`,
    data: { skills: '/var/lib/paraclete/skills' },
  });
  const norm = (dirs) => dirs.map((d) => d.replace(/\\/g, '/'));
  assert.deepEqual(norm(skillDirectories(pathsFor('generic'))), [
    '/opt/paraclete/skills', '/opt/paraclete/roles/generic/skills', '/var/lib/paraclete/skills',
  ]);
  assert.deepEqual(norm(skillDirectories(pathsFor('analyst'))), [
    '/opt/paraclete/skills', '/opt/paraclete/roles/generic/skills', '/opt/paraclete/roles/analyst/skills', '/var/lib/paraclete/skills',
  ]);
});
