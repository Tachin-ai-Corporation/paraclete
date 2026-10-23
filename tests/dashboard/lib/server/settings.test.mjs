// Tests for dashboard/lib/server/settings.mjs: the effort setting reads the way the brain reads it,
// only admins change it, only known levels are stored, and the write touches nothing but its own
// fields of config/settings, which the control service's Claude switch shares. The Drive output
// folder follows the same rules: admins only, a folder id or nothing, its own fields only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import {
  AUTO_UPDATE_FIELDS, DRIVE_FIELDS, EFFORT_FIELDS, autoUpdateEnabled, defaultEffort, readAutoUpdate, readDriveSettings, readEffort,
  setAutoUpdate, setDriveOutputFolder, setEffort,
} from '../../../../dashboard/lib/server/settings.mjs';
import { route } from '../../../../dashboard/lib/server/http.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { readAdminSettings } from '../../../../agent/services/service-runtime.mjs';
import { adminEffort } from '../../../../agent/services/brain/settings.mjs';
import { readSettingsView, setClaude } from '../../../../agent/services/control/models.mjs';
import { fakeSystemd, fakeGatewayFetch, GATEWAY_TOKEN } from '../../../agent/services/control/fakes.mjs';

const NOW = new Date('2027-01-15T08:00:00.000Z');
const admin = { email: 'admin@example.com', role: 'admin' };
const member = { email: 'member@example.com', role: 'member' };

async function dashboard(t) {
  const dash = await startDashboard();
  t.after(dash.stop);
  return dash;
}

test('with nothing stored, the effort is the contracts default and every level is offered with its factor', async (t) => {
  const { runtime } = await dashboard(t);
  assert.equal(defaultEffort(runtime), runtime.contracts.effort.default);
  assert.deepEqual(await readEffort(runtime), {
    effort: runtime.contracts.effort.default,
    stored: null,
    unknown: false,
    default: runtime.contracts.effort.default,
    levels: [{ id: 'low', scale: 0.5 }, { id: 'medium', scale: 1 }, { id: 'high', scale: 1.4 }, { id: 'max', scale: 1.8 }],
    updated_at: null,
    updated_by: null,
  });
});

test('an admin sets the effort; the brain reads the same level, and the Claude fields stay as they were', async (t) => {
  const dash = await dashboard(t);
  const { runtime } = dash;
  await dash.seed({ 'config/settings': { claude_enabled: true, claude_updated_at: '2027-01-01T00:00:00.000Z', claude_updated_by: 'owner@example.com' } });

  const view = await setEffort(runtime, { effort: 'high', user: admin, now: NOW });
  assert.equal(view.effort, 'high');
  assert.equal(view.stored, 'high');
  assert.equal(view.updated_by, 'admin@example.com');
  assert.equal(view.updated_at, NOW.toISOString());
  assert.deepEqual(await dash.doc('config/settings'), {
    claude_enabled: true, claude_updated_at: '2027-01-01T00:00:00.000Z', claude_updated_by: 'owner@example.com',
    effort: 'high', effort_updated_at: NOW.toISOString(), effort_updated_by: 'admin@example.com',
  });
  assert.deepEqual(EFFORT_FIELDS, ['effort', 'effort_updated_at', 'effort_updated_by']);

  const settings = await readAdminSettings(runtime.db, { strict: true });
  assert.equal(adminEffort(settings, runtime.contracts.effort.default), 'high');
  assert.equal((await readSettingsView({ db: runtime.db, contracts: runtime.contracts })).effort, 'high');
});

test("the Claude switch, written after the effort, leaves the dashboard's fields alone", async (t) => {
  const dash = await dashboard(t);
  const { runtime } = dash;
  await setEffort(runtime, { effort: 'low', user: admin, now: NOW });
  const m = runtime.contracts.vertex.models;
  let clock = 0;
  await setClaude({
    enabled: true, actor: 'admin@example.com', db: runtime.db, contracts: runtime.contracts, systemd: fakeSystemd(),
    gateway: {
      url: 'http://127.0.0.1:18789', token: GATEWAY_TOKEN, readyTimeoutMs: 1000,
      fetch: fakeGatewayFetch({ models: { cortex: m.claude, strong: m.claude, fast: m.fast, fallback: m.claude_fallback } }).fetch,
      sleep: async (ms) => { clock += ms; }, now: () => clock,
    },
    nowIso: () => '2027-01-16T00:00:00.000Z',
  });
  const stored = await dash.doc('config/settings');
  assert.equal(stored.claude_enabled, true);
  assert.deepEqual([stored.effort, stored.effort_updated_by, stored.effort_updated_at], ['low', 'admin@example.com', NOW.toISOString()]);
  assert.equal((await readEffort(runtime)).effort, 'low');
});

test('members cannot change the effort, and nothing is written', async (t) => {
  const dash = await dashboard(t);
  await assert.rejects(setEffort(dash.runtime, { effort: 'max', user: member }), (err) => err.status === 403);
  await assert.rejects(setEffort(dash.runtime, { effort: 'max', user: null }), (err) => err.status === 403);
  assert.equal(await dash.doc('config/settings'), null);
});

test('only the levels the brain knows are stored', async (t) => {
  const dash = await dashboard(t);
  for (const bad of ['MAX', 'extreme', '', null, undefined, 3, ['high']]) {
    await assert.rejects(setEffort(dash.runtime, { effort: bad, user: admin }), (err) => err.status === 400 && /low, medium, high, max/.test(err.message));
  }
  assert.equal(await dash.doc('config/settings'), null);
});

test('a stored value the brain does not know reads as medium, the way the brain reads it', async (t) => {
  const dash = await dashboard(t);
  await dash.seed({ 'config/settings': { effort: 'turbo' } });
  const view = await readEffort(dash.runtime);
  assert.deepEqual([view.effort, view.stored, view.unknown], ['medium', 'turbo', true]);
  assert.equal(adminEffort(await readAdminSettings(dash.runtime.db), dash.runtime.contracts.effort.default), 'medium');
});

test("with nothing stored, a different contracts default is the brain's level too", async (t) => {
  const dash = await dashboard(t);
  const runtime = { ...dash.runtime, contracts: { ...dash.runtime.contracts, effort: { default: 'high' } } };
  const view = await readEffort(runtime);
  assert.deepEqual([view.effort, view.default], ['high', 'high']);
  assert.equal(adminEffort({}, 'high'), view.effort);
});

test('an outage is an error, never the default', async (t) => {
  const dash = await dashboard(t);
  const down = new StoreUnavailable('read', 'config/settings', 503, 'unavailable');
  // A store that answers "absent" unless asked strictly, the storage client's permissive default.
  const db = {
    read: async (path, opts = {}) => { if (opts.strict) throw down; return null; },
    patch: async (path, mask, fields, opts = {}) => { if (opts.strict) throw down; return null; },
  };
  const runtime = { ...dash.runtime, db };
  await assert.rejects(readEffort(runtime), StoreUnavailable);
  await assert.rejects(setEffort(runtime, { effort: 'high', user: admin }), StoreUnavailable);
});

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

test('with nothing stored there is no Drive output folder', async (t) => {
  const { runtime } = await dashboard(t);
  assert.deepEqual(await readDriveSettings(runtime), { drive_output_folder: null, invalid: false, updated_at: null, updated_by: null });
});

test('an admin sets and clears the output folder; only its own fields of config/settings change', async (t) => {
  const dash = await dashboard(t);
  const { runtime } = dash;
  await setEffort(runtime, { effort: 'high', user: admin, now: NOW });
  await dash.seed({ 'config/settings': { ...(await dash.doc('config/settings')), claude_enabled: true } });

  const view = await setDriveOutputFolder(runtime, { folder: FOLDER, user: admin, now: NOW });
  assert.deepEqual(view, { drive_output_folder: FOLDER, invalid: false, updated_at: NOW.toISOString(), updated_by: 'admin@example.com' });
  assert.deepEqual(await dash.doc('config/settings'), {
    effort: 'high', effort_updated_at: NOW.toISOString(), effort_updated_by: 'admin@example.com', claude_enabled: true,
    drive_output_folder: FOLDER, drive_output_folder_updated_at: NOW.toISOString(), drive_output_folder_updated_by: 'admin@example.com',
  });
  assert.deepEqual(DRIVE_FIELDS, ['drive_output_folder', 'drive_output_folder_updated_at', 'drive_output_folder_updated_by']);
  // The write was field-masked to exactly those fields.
  const patch = dash.firestore.requests.filter((r) => r.method === 'PATCH').pop();
  assert.deepEqual(new URLSearchParams(patch.query).getAll('updateMask.fieldPaths'), DRIVE_FIELDS);

  const later = new Date(NOW.getTime() + 60_000);
  for (const cleared of [null, '', undefined]) {
    const view2 = await setDriveOutputFolder(runtime, { folder: cleared, user: admin, now: later });
    assert.deepEqual([view2.drive_output_folder, view2.updated_at], [null, later.toISOString()]);
  }
  assert.equal((await dash.doc('config/settings')).drive_output_folder, null);
  assert.equal((await dash.doc('config/settings')).effort, 'high');
});

test('members cannot change the output folder, and only folder ids are stored', async (t) => {
  const dash = await dashboard(t);
  await assert.rejects(setDriveOutputFolder(dash.runtime, { folder: FOLDER, user: member }), (err) => err.status === 403);
  for (const bad of ['https://drive.google.com/drive/folders/' + FOLDER, 'short', 'has space in it ok', 'a/b/c/d/e/f/g', 42, ['x'], { id: FOLDER }]) {
    await assert.rejects(setDriveOutputFolder(dash.runtime, { folder: bad, user: admin }), (err) => err.status === 400, String(bad));
  }
  assert.equal(await dash.doc('config/settings'), null);
});

test('a stored value that is not a folder id reads as none, flagged for an admin to replace', async (t) => {
  const dash = await dashboard(t);
  await dash.seed({ 'config/settings': { drive_output_folder: 'not a folder' } });
  const view = await readDriveSettings(dash.runtime);
  assert.deepEqual([view.drive_output_folder, view.invalid], [null, true]);
});

test('the drive setting route: every user reads it, only admins change it', async (t) => {
  const dash = await startDashboard({ env: { PARACLETE_DEV_USER: 'member@example.com' } });
  t.after(dash.stop);
  const { runtime } = dash;
  await dash.seed({ 'users/member@example.com': { email: 'member@example.com', role: 'member' } });
  const get = route(async () => readDriveSettings(runtime), { runtime: () => runtime });
  const patch = route(async ({ request, user }) => setDriveOutputFolder(runtime, { folder: (await request.json()).drive_output_folder, user }), {
    admin: true, runtime: () => runtime,
  });
  const read = await get(new Request('http://dashboard.example.com/api/settings/drive'));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).drive_output_folder, null);
  const refused = await patch(new Request('http://dashboard.example.com/api/settings/drive', { method: 'PATCH', body: JSON.stringify({ drive_output_folder: FOLDER }) }));
  assert.equal(refused.status, 403);
  assert.equal(await dash.doc('config/settings'), null);
});

test('automatic updates: on with nothing stored (the contracts default); an admin turns them off and on, field-masked', async (t) => {
  const dash = await dashboard(t);
  const { runtime } = dash;
  assert.equal(runtime.contracts.auto_update.enabled_by_default, true);
  assert.deepEqual(await readAutoUpdate(runtime), { enabled: true, stored: null, default: true, updated_at: null, updated_by: null });
  await setEffort(runtime, { effort: 'high', user: admin, now: NOW });

  const off = await setAutoUpdate(runtime, { enabled: false, user: admin, now: NOW });
  assert.deepEqual(off, { enabled: false, stored: false, default: true, updated_at: NOW.toISOString(), updated_by: 'admin@example.com' });
  const patch = dash.firestore.requests.filter((r) => r.method === 'PATCH').pop();
  assert.deepEqual(new URLSearchParams(patch.query).getAll('updateMask.fieldPaths'), [...AUTO_UPDATE_FIELDS]);
  assert.equal((await dash.doc('config/settings')).effort, 'high', 'the effort stays');
  assert.equal((await setAutoUpdate(runtime, { enabled: true, user: admin, now: NOW })).enabled, true);
});

test('automatic updates: members cannot change them, only true or false is stored, and anything else reads as the default', async (t) => {
  const dash = await dashboard(t);
  const { runtime } = dash;
  await assert.rejects(setAutoUpdate(runtime, { enabled: false, user: member, now: NOW }), (err) => err.status === 403);
  await assert.rejects(setAutoUpdate(runtime, { enabled: 'no', user: admin, now: NOW }), (err) => err.status === 400);
  assert.equal(await dash.doc('config/settings'), null, 'nothing was written');
  assert.equal(autoUpdateEnabled(runtime, { auto_update: 'false' }), true);
  assert.equal(autoUpdateEnabled(runtime, { auto_update: false }), false);
  assert.equal(autoUpdateEnabled({ contracts: { auto_update: { enabled_by_default: false } } }, {}), false);
});
