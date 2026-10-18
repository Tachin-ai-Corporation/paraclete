// Tests for dashboard/lib/server/workspace.mjs, against the Firestore fake. The record is written the
// way the VM's control service writes it (its own writeAccountRecord and writeLastCheck, with a real
// check against the fake Google of the control tests), so the two sides read the same shape. Covered:
// a role without a Workspace account; the state every user sees, with only admins seeing errors and
// fixes; the setup an admin reads, with the signer's client ID from IAM and the reason when IAM
// refuses; the suggested address; the names shared with the installer and the control service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startDashboard } from '../../harness.mjs';
import {
  readWorkspace, readWorkspaceSetup, suggestAccount, signerOf, ADMIN_LINKS, SIGNER_ACCOUNT_ID, WORKSPACE_RECORD_DOC,
} from '../../../../dashboard/lib/server/workspace.mjs';
import { settingsFromEnv } from '../../../../dashboard/lib/server/runtime.mjs';
import { ADMIN_COMMANDS } from '../../../../dashboard/lib/server/commands.mjs';
import * as control from '../../../../agent/services/control/workspace-account.mjs';
import { checkWorkspace, DELEGATION_PAGE } from '../../../../agent/services/control/workspace-check.mjs';
import { WORKSPACE_SCOPES } from '../../../../agent/auth/workspace-scopes.mjs';
import { fakeGoogle, CLIENT_ID, SIGNER } from '../../../agent/services/control/workspace-fakes.mjs';

const admin = { email: 'admin@example.com', role: 'admin' };
const member = { email: 'ada@example.com', role: 'member' };
const WORKSPACE_ENV = { PARACLETE_WORKSPACE_ROLE: 'true', PARACLETE_ROLE: 'executive-assistant', PARACLETE_AGENT_NAME: 'Ada Lovelace' };

/** IAM, answering the signer's client ID (or a status), recording each call. */
function fakeIam({ status = 200, body = { oauth2ClientId: CLIENT_ID } } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return new Response(JSON.stringify(status === 200 ? body : { error: { code: status, message: 'nope' } }), { status });
  };
  return { fetch, calls };
}

test('a role without a Workspace account: nothing to set up, and no record is read', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  assert.deepEqual(await readWorkspace(dash.runtime, admin), { needed: false, role: 'generic' });
  await assert.rejects(readWorkspaceSetup(dash.runtime, admin), (err) => err.status === 404 && /generic role has no Workspace account/.test(err.message));
});

test('the state on a Workspace role: none yet, then the account the VM recorded and its last check', async (t) => {
  const dash = await startDashboard({ env: WORKSPACE_ENV });
  t.after(dash.stop);
  assert.deepEqual(await readWorkspace(dash.runtime, member), {
    needed: true, role: 'executive-assistant', signer: SIGNER, account: null, removed: null, last_check: null,
  });

  // Written as the control service writes it: the record, then a check with two APIs failing.
  await control.writeAccountRecord(dash.runtime.db, dash.runtime.collections, {
    account: 'agent@example.com', signer: SIGNER, recorded_at: '2026-10-18T09:00:00.000Z', recorded_by: 'admin@example.com',
  });
  const granted = WORKSPACE_SCOPES.filter((s) => !s.endsWith('/calendar') && !s.endsWith('/gmail.readonly'));
  const result = await checkWorkspace({
    account: 'agent@example.com', project: 'your-gcp-project', fetch: fakeGoogle({ granted }).fetch, getVmAccessToken: async () => 'vm', now: () => new Date('2026-10-18T09:05:00.000Z'),
  });
  await control.writeLastCheck(dash.runtime.db, dash.runtime.collections, { ...result, checked_by: 'admin@example.com' });

  const forAdmin = await readWorkspace(dash.runtime, admin);
  assert.deepEqual(forAdmin.account, { account: 'agent@example.com', signer: SIGNER, recorded_at: '2026-10-18T09:00:00.000Z', recorded_by: 'admin@example.com' });
  assert.equal(forAdmin.last_check.account, 'agent@example.com');
  assert.equal(forAdmin.last_check.ready, false);
  assert.equal(forAdmin.last_check.checked_by, 'admin@example.com');
  assert.equal(forAdmin.last_check.client_id, CLIENT_ID);
  assert.equal(forAdmin.last_check.missing_scopes.length, 2);
  const calendar = forAdmin.last_check.apis.find((a) => a.api === 'calendar');
  assert.equal(calendar.ok, false);
  assert.ok(calendar.fix.includes(DELEGATION_PAGE));
  assert.ok(calendar.error);

  const forMember = await readWorkspace(dash.runtime, member);
  assert.deepEqual(forMember.last_check.apis.find((a) => a.api === 'calendar'), { api: 'calendar', name: 'Google Calendar', ok: false });
  assert.ok(!('fix' in forMember.last_check.apis[0]) && !('missing_scopes' in forMember.last_check), 'members see the state, not what to change');

  // A removal leaves who removed it, and no account.
  await control.writeAccountRecord(dash.runtime.db, dash.runtime.collections, {
    account: null, signer: null, recorded_at: '2026-10-18T10:00:00.000Z', recorded_by: 'admin@example.com',
  });
  const removed = await readWorkspace(dash.runtime, admin);
  assert.equal(removed.account, null);
  assert.deepEqual(removed.removed, { recorded_at: '2026-10-18T10:00:00.000Z', recorded_by: 'admin@example.com' });
  assert.equal(removed.last_check.account, 'agent@example.com', 'the last check stays');
});

test('a Firestore outage is an error, never "no account yet"', async (t) => {
  const dash = await startDashboard({ env: WORKSPACE_ENV });
  t.after(dash.stop);
  const db = { read: async (path, opts = {}) => { if (opts.strict) throw new Error('Firestore is unavailable'); return null; } };
  await assert.rejects(readWorkspace({ ...dash.runtime, db }, admin), (err) => err.status === 503 && /could not be read: Firestore is unavailable/.test(err.message));
});

test("the setup: the signer's client ID read from IAM as the dashboard, the scopes, the links and a suggested address", async (t) => {
  const iam = fakeIam();
  const dash = await startDashboard({ env: WORKSPACE_ENV, fetch: iam.fetch });
  t.after(dash.stop);
  const setup = await readWorkspaceSetup(dash.runtime, admin);
  assert.equal(setup.signer, SIGNER);
  assert.equal(setup.client_id, CLIENT_ID);
  assert.equal(setup.client_id_error, null);
  assert.deepEqual(setup.scopes, [...WORKSPACE_SCOPES]);
  assert.equal(setup.scopes_text, WORKSPACE_SCOPES.join(','));
  assert.deepEqual(setup.apis.find((a) => a.api === 'chat'), { api: 'chat', name: 'Google Chat', scopes: ['chat.messages', 'chat.messages.readonly', 'chat.spaces.readonly'] });
  assert.deepEqual(setup.links, { users: 'https://admin.google.com/ac/users', delegation: 'https://admin.google.com/ac/owl/domainwidedelegation' });
  assert.equal(setup.links.delegation, DELEGATION_PAGE, 'the wizard and the check send admins to the same page');
  assert.equal(setup.suggested_account, 'ada.lovelace@example.com');
  assert.equal(iam.calls.length, 1);
  assert.equal(iam.calls[0].url, `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER)}?fields=oauth2ClientId`);
  assert.equal(iam.calls[0].headers.Authorization, 'Bearer dashboard-token');

  await assert.rejects(readWorkspaceSetup(dash.runtime, member), (err) => err.status === 403);
});

test('when IAM will not say the client ID, the setup says why and what fixes it', async (t) => {
  for (const [iam, reason] of [
    [fakeIam({ status: 403 }), /may not read paraclete-dwd@.*Service Account Viewer/],
    [fakeIam({ status: 404 }), /does not exist\. Run install\/install\.sh again/],
    [fakeIam({ status: 500 }), /IAM answered 500: nope/],
    [fakeIam({ body: {} }), /no client ID/],
    [{ fetch: async () => { throw new Error('offline'); } }, /could not be reached: offline/],
  ]) {
    const dash = await startDashboard({ env: WORKSPACE_ENV, fetch: iam.fetch });
    t.after(dash.stop);
    const setup = await readWorkspaceSetup(dash.runtime, admin);
    assert.equal(setup.client_id, null);
    assert.match(setup.client_id_error, reason);
    assert.deepEqual(setup.scopes, [...WORKSPACE_SCOPES], 'the rest of the setup still shows');
  }
});

test('the suggested address', () => {
  assert.equal(suggestAccount('Paraclete', 'admin@example.com'), 'paraclete@example.com');
  assert.equal(suggestAccount("Zoë O'Brien", 'admin@Example.org'), 'zoe.obrien@example.org');
  assert.equal(suggestAccount('  ', 'admin@example.com'), 'agent@example.com');
  assert.equal(suggestAccount('Ada', 'admin'), null);
  assert.equal(suggestAccount('Ada', ''), null);
});

test('the role flag, the commands and the names the dashboard shares with the VM and the installer', () => {
  assert.equal(settingsFromEnv({ PARACLETE_WORKSPACE_ROLE: 'true' }).workspaceRole, true);
  for (const value of [undefined, '', 'false', 'TRUE', '1']) assert.equal(settingsFromEnv({ PARACLETE_WORKSPACE_ROLE: value }).workspaceRole, false, String(value));
  assert.ok(ADMIN_COMMANDS.includes('workspace_check') && ADMIN_COMMANDS.includes('set_workspace_account'), 'admins only');
  assert.equal(SIGNER_ACCOUNT_ID, control.SIGNER_ACCOUNT_ID);
  assert.equal(WORKSPACE_RECORD_DOC, control.WORKSPACE_RECORD_DOC);
  const names = readFileSync(new URL('../../../../install/lib/names.sh', import.meta.url), 'utf8');
  assert.equal(/^DWD_ACCOUNT_ID=(.+)$/m.exec(names)[1], SIGNER_ACCOUNT_ID);
  assert.equal(signerOf({ settings: { project: '' } }), '');
  assert.equal(ADMIN_LINKS.delegation, DELEGATION_PAGE);
});
