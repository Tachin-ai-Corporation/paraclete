// Tests for agent/services/control/workspace-account.mjs and the two Workspace commands in
// commands.mjs, run through the real queue the way the service runs them: set_workspace_account
// writes /etc/paraclete/workspace.json and the instance record (on a fake file system that records
// every call, so nothing outside the two files can be written unnoticed), mirrors the record into
// Firestore, restarts the gateway, brain, ears and mouth and then control; it refuses bad addresses
// and roles without a Workspace account, changes nothing for the account it already has, and reports
// a Firestore or restart failure with what it did. workspace_check records its outcome for the
// dashboard. Google is workspace-fakes.mjs; Firestore, systemd and the gateway are fakes.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHandlers } from '../../../../agent/services/control/commands.mjs';
import { createCommandQueue } from '../../../../agent/services/control/command-queue.mjs';
import {
  WORKSPACE_FILE, INSTANCE_FILE, WRITABLE_FILES, SIGNER_ACCOUNT_ID, RESTARTED_SERVICES, checkWorkspaceAccount, signerFor,
} from '../../../../agent/services/control/workspace-account.mjs';
import { validateInstance, DEFAULT_INSTANCE_PATH } from '../../../../config/instance.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { fakeDb, fakeSystemd, fakeGatewayFetch, controlRuntime } from './fakes.mjs';
import { fakeGoogle, ACCOUNT, SIGNER, VM_TOKEN, PERSONAL } from './workspace-fakes.mjs';

const NOW = new Date('2026-10-18T09:00:00.000Z');
const SETTINGS = { readyTimeoutMs: 3_000, upgradeMaxSeconds: 900 };
const WORKSPACE_ROLE = 'executive-assistant';

/** The instance record as the bootstrap writes it, for a runtime's instance (with the VM's own roots). */
function instanceFileOf(instance, extra = {}) {
  const { workspace, endpoints, gateway_token_file: token, ...rest } = instance;
  return {
    ...rest, install_root: '/opt/paraclete', data_root: '/var/lib/paraclete', release: 'v2026.10.18.1.1', source_repo: 'your-org/paraclete', ...extra,
  };
}

/** A file system holding only /etc/paraclete's files, recording every call. */
function fakeFiles(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  return {
    files,
    calls,
    json: (path) => JSON.parse(files.get(path)),
    readFileSync(path) {
      calls.push(['read', path]);
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
      return files.get(path);
    },
    writeFileSync(path, text, options) {
      calls.push(['write', path, options?.mode]);
      files.set(path, String(text));
    },
    chmodSync(path, mode) {
      calls.push(['chmod', path, mode]);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

function harness({ role = WORKSPACE_ROLE, roleJson = { id: role, workspace: true }, systemd = fakeSystemd(), gateway = fakeGatewayFetch(), google = fakeGoogle(), instanceExtra = {} } = {}) {
  const db = fakeDb();
  const fetch = (url, init) => (String(url).startsWith('http://127.0.0.1:18789') ? gateway.fetch(url, init) : google.fetch(url, init));
  const runtime = { ...controlRuntime({ db, role, fetch }), getAccessToken: async () => VM_TOKEN };
  if (roleJson) writeFileSync(join(runtime.paths.role, 'role.json'), JSON.stringify(roleJson));
  const files = fakeFiles({ [INSTANCE_FILE]: `${JSON.stringify(instanceFileOf(runtime.instance, instanceExtra), null, 2)}\n` });
  let clock = NOW.getTime();
  const handlers = createHandlers({
    runtime, systemd, settings: SETTINGS, files, now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
  });
  const queue = createCommandQueue({ db, collections: runtime.collections, handlers, verifyCommand: async () => ({}), now: () => NOW });
  async function send(type, params, id = `c${db.paths('commands/').length + 1}`) {
    db.set(`commands/${id}`, { type, params, status: 'pending', requested_by: 'admin@example.com', created_at: NOW.toISOString() });
    await queue.tick();
    return db.get(`commands/${id}`);
  }
  return { db, runtime, systemd, files, google, send };
}

const restarts = (systemd) => systemd.calls.filter((c) => c[0] === 'restart').map((c) => [c[1], c[2]]);
const written = (files) => files.calls.filter((c) => c[0] !== 'read').map((c) => c.at(c[0] === 'rename' ? 2 : 1));

test('recording an account writes the two files, mirrors the record, and restarts the services, control last', async () => {
  const h = harness();
  const doc = await h.send('set_workspace_account', { account: ' Agent@Example.com ' });
  assert.equal(doc.status, 'done', doc.error);
  const signer = `paraclete-dwd@your-gcp-project.iam.gserviceaccount.com`;

  assert.deepEqual(h.files.json(WORKSPACE_FILE), {
    account: ACCOUNT, signer, recorded_at: NOW.toISOString(), recorded_by: 'admin@example.com',
  });
  const instance = h.files.json(INSTANCE_FILE);
  assert.deepEqual(instance, { ...instanceFileOf(h.runtime.instance), workspace: { account: ACCOUNT, signer } }, 'every other field is kept');
  assert.deepEqual(validateInstance(instance), []);
  assert.ok(h.files.files.get(INSTANCE_FILE).endsWith('}\n'));

  // Each file through a sibling renamed into place, mode 0644, and nothing else written.
  for (const path of WRITABLE_FILES) {
    assert.deepEqual(h.files.calls.filter((c) => c[0] !== 'read' && (c[1] === `${path}.control-next`)).map((c) => c[0]), ['write', 'chmod', 'rename']);
    assert.ok(h.files.calls.some((c) => c[0] === 'write' && c[1] === `${path}.control-next` && c[2] === 0o644));
  }
  assert.ok(written(h.files).every((path) => WRITABLE_FILES.includes(path) || WRITABLE_FILES.some((f) => path === `${f}.control-next`)));
  assert.ok(!h.files.files.has(`${WORKSPACE_FILE}.control-next`));

  assert.deepEqual(h.db.get('config/workspace_account'), {
    account: ACCOUNT, signer, recorded_at: NOW.toISOString(), recorded_by: 'admin@example.com',
  });
  assert.deepEqual(restarts(h.systemd), [['gateway', {}], ['brain', {}], ['ears', {}], ['mouth', {}], ['control', { noBlock: true }]],
    'the gateway first, control last and without blocking, after the command is recorded');
  assert.deepEqual(doc.result, {
    account: ACCOUNT,
    signer,
    previous: null,
    recorded_at: NOW.toISOString(),
    recorded_by: 'admin@example.com',
    files: [WORKSPACE_FILE, INSTANCE_FILE],
    restarted: [...RESTARTED_SERVICES],
    restarting: 'control',
    message: doc.result.message,
  });
  assert.match(doc.result.message, /agent@example\.com/);
});

test('the account it already has: the record is written again, and nothing restarts', async () => {
  const h = harness({ instanceExtra: { workspace: { account: ACCOUNT, signer: SIGNER } } });
  const doc = await h.send('set_workspace_account', { account: ACCOUNT });
  assert.equal(doc.status, 'done', doc.error);
  assert.deepEqual(doc.result.files, [WORKSPACE_FILE]);
  assert.deepEqual(doc.result.restarted, []);
  assert.equal(doc.result.previous, ACCOUNT);
  assert.equal('restarting' in doc.result, false);
  assert.deepEqual(restarts(h.systemd), []);
  assert.ok(!written(h.files).includes(INSTANCE_FILE));
  assert.match(doc.result.message, /as it already was/);
});

test('removing the account clears both files and the record, and restarts the services', async () => {
  const h = harness({ instanceExtra: { workspace: { account: ACCOUNT, signer: SIGNER } } });
  const doc = await h.send('set_workspace_account', { account: null });
  assert.equal(doc.status, 'done', doc.error);
  assert.deepEqual(h.files.json(WORKSPACE_FILE), { account: null, signer: null, recorded_at: NOW.toISOString(), recorded_by: 'admin@example.com' });
  assert.equal('workspace' in h.files.json(INSTANCE_FILE), false);
  assert.equal(doc.result.previous, ACCOUNT);
  assert.equal(h.db.get('config/workspace_account').account, null);
  assert.equal(restarts(h.systemd).length, 5);
});

test('a role without a Workspace account can have none recorded, but may always clear one', async () => {
  const h = harness({ role: 'generic', roleJson: { id: 'generic', workspace: false } });
  const doc = await h.send('set_workspace_account', { account: ACCOUNT });
  assert.equal(doc.status, 'failed');
  assert.match(doc.error, /the generic role has no Workspace account/);
  assert.deepEqual(written(h.files), []);
  assert.deepEqual(h.systemd.calls, []);
  assert.equal((await h.send('set_workspace_account', { account: null })).status, 'done');
});

test('bad params are refused before anything is read or written', async () => {
  const h = harness();
  for (const [params, reason] of [
    [{}, /params\.account is required/],
    [{ account: PERSONAL }, /personal Google account/],
    [{ account: SIGNER }, /service account/],
    [{ account: 'not an address' }, /not an email address/],
    [{ account: 42 }, /Workspace address/],
  ]) {
    const doc = await h.send('set_workspace_account', params);
    assert.equal(doc.status, 'failed', JSON.stringify(params));
    assert.match(doc.error, reason);
  }
  assert.deepEqual(h.files.calls, []);
  assert.deepEqual(h.systemd.calls, []);
  assert.equal(h.db.get('config/workspace_account'), null);
});

test('an unreadable instance record fails the command and writes nothing', async () => {
  const h = harness();
  h.files.files.set(INSTANCE_FILE, '{ not json');
  const doc = await h.send('set_workspace_account', { account: ACCOUNT });
  assert.equal(doc.status, 'failed');
  assert.match(doc.error, /\/etc\/paraclete\/instance\.json cannot be read/);
  assert.deepEqual(written(h.files), []);
});

test('a Firestore failure still leaves the VM consistent, and says to send the command again', async () => {
  const h = harness();
  h.db.failOnce('patch', new StoreUnavailable('patch', 'config/workspace_account', 503, 'unavailable'), 'config/workspace_account');
  const doc = await h.send('set_workspace_account', { account: ACCOUNT });
  assert.equal(doc.status, 'failed');
  assert.match(doc.error, /could not be written/);
  assert.match(doc.error, /again is safe/);
  assert.equal(h.files.json(INSTANCE_FILE).workspace.account, ACCOUNT);
  assert.deepEqual(doc.result.restarted, [...RESTARTED_SERVICES], 'the services still pick up the new record');
  assert.ok(!restarts(h.systemd).some(([service]) => service === 'control'), 'a failed command does not restart control');
});

test('a gateway that does not come back fails the command; the other services still restart', async () => {
  const h = harness({ gateway: fakeGatewayFetch({ down: true }) });
  const doc = await h.send('set_workspace_account', { account: ACCOUNT });
  assert.equal(doc.status, 'failed');
  assert.match(doc.error, /gateway: the gateway restarted but is not ready/);
  assert.deepEqual(doc.result.restarted, ['brain', 'ears', 'mouth']);
});

test('workspace_check answers with the check and records it, with who ran it, for the dashboard', async () => {
  const h = harness();
  const doc = await h.send('workspace_check', { account: ACCOUNT });
  assert.equal(doc.status, 'done', doc.error);
  assert.equal(doc.result.ready, true);
  assert.equal(doc.result.signer, SIGNER);
  assert.ok(h.google.of('signJwt').every((c) => c.headers.Authorization === `Bearer ${VM_TOKEN}`), 'signed with the VM\'s own token');
  const record = h.db.get('config/workspace_account');
  assert.deepEqual(record.last_check, { ...doc.result, checked_by: 'admin@example.com' });
  assert.deepEqual(h.files.calls, [], 'a check touches no file');
  assert.deepEqual(h.systemd.calls, []);

  // A check that cannot be recorded still answers.
  h.db.failOnce('patch', new StoreUnavailable('patch', 'config/workspace_account', 503, 'down'), 'config/workspace_account');
  const again = await h.send('workspace_check', { account: ACCOUNT });
  assert.equal(again.status, 'done');
  assert.ok(h.runtime.lines.some((l) => l.level === 'WARN' && /could not be recorded/.test(l.message)));

  const bad = await h.send('workspace_check', { account: PERSONAL });
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /personal Google account/);
});

test('the address rule, and the names other parts of the repo give the same things', () => {
  assert.equal(checkWorkspaceAccount('Ada.Lovelace+agent@Example.com'), 'ada.lovelace+agent@example.com');
  assert.throws(() => checkWorkspaceAccount('a@b'), /not an email address/);
  assert.throws(() => checkWorkspaceAccount(`${'a'.repeat(250)}@example.com`), /not an email address/);
  assert.equal(signerFor('your-gcp-project'), SIGNER);
  assert.throws(() => signerFor(''), /no project/);
  assert.equal(INSTANCE_FILE, DEFAULT_INSTANCE_PATH);
  const names = readFileSync(new URL('../../../../install/lib/names.sh', import.meta.url), 'utf8');
  assert.equal(/^DWD_ACCOUNT_ID=(.+)$/m.exec(names)[1], SIGNER_ACCOUNT_ID, 'install.sh creates the signer under this name');
});
