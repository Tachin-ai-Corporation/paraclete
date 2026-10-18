// Tests for agent/services/control/drive-check.mjs: the drive_check result, built through the real Drive
// client (agent/providers/drive.mjs) against a fake Drive API. What is shared and which shared drives
// the agent belongs to are reported; the output folder's write test creates one file and trashes it;
// and every case that needs a person (nothing shared, the organization's sharing block, Drive
// unreachable, no output folder, a folder that takes no new files) gets its advice. Settings come from
// the control fakes' Firestore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDrive } from '../../../../agent/services/control/drive-check.mjs';
import { createDriveClient, FOLDER_MIME } from '../../../../agent/providers/drive.mjs';
import { fakeDb } from './fakes.mjs';

const SA_EMAIL = 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com';
const INSTANCE = Object.freeze({ project: 'your-gcp-project', workspace: null, endpoints: {} });
const WORKSPACE = Object.freeze({ ...INSTANCE, workspace: { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' } });
const FOLDER = '1OutputFolderAbCdEfGhIjKlMnOpQrSt';
const DRIVE_ID = '0AExampleSharedDrv9PVA';
const NEW_FILE = '1TestFileAbCdEfGhIjKlMnOpQrStUvWx';
const NOW = new Date('2026-10-18T12:34:56.789Z');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const googleError = (status, reason, message) => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

/**
 * A fake Drive API. `files` holds metadata by id; `shared` the files shared with the agent; `drives`
 * its shared drives. `about`, `create` and `trash` override those calls' answers.
 */
function fakeDriveApi({ shared = [], drives = [], files = {}, about, create, trash } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, params: u.searchParams, body: init.body, headers: init.headers || {} });
    if (u.pathname === '/drive/v3/about') return about ? about() : json({ user: { emailAddress: SA_EMAIL } });
    if (u.pathname === '/drive/v3/drives') return json({ drives });
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const size = Number(u.searchParams.get('pageSize'));
      return json({ files: shared.slice(0, size), ...(shared.length > size ? { nextPageToken: 'more' } : {}) });
    }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') return create ? create() : json({ id: NEW_FILE, name: 'test' });
    const id = u.pathname.split('/').pop();
    if (method === 'PATCH') return trash ? trash() : json({ id, trashed: true });
    return files[id] ? json(files[id]) : googleError(404, 'notFound', `File not found: ${id}.`);
  };
  return { fetch, calls };
}

function run(api, { instance = INSTANCE, settings = {}, getDwdToken } = {}) {
  const drive = createDriveClient({ instance, fetch: api.fetch, getAccessToken: async () => 'vm-token', ...(getDwdToken ? { getDwdToken } : { getDwdToken: async () => 'dwd-token' }) });
  const db = fakeDb({ 'config/settings': settings });
  return checkDrive({ drive, db, now: () => NOW });
}

const sharedFolder = (extra = {}) => ({
  [FOLDER]: { id: FOLDER, name: 'Agent output', mimeType: FOLDER_MIME, driveId: DRIVE_ID, capabilities: { canAddChildren: true }, ...extra },
});

test('a service account with nothing shared is told how to share, and about the sharing block and its three ways out', async () => {
  const api = fakeDriveApi();
  const result = await run(api);
  assert.deepEqual({ ...result, advice: undefined }, {
    identity: { kind: 'service_account', email: SA_EMAIL },
    reachable: true,
    error: null,
    shared_with_me: { count: 0, capped: false, sample: [] },
    shared_drives: [],
    output_folder: null,
    advice: undefined,
  });
  assert.equal(result.advice.length, 3);
  assert.match(result.advice[0], new RegExp(`^Nothing is shared with the agent yet\\. .*choose Share, and add ${SA_EMAIL.replace(/\./g, '\\.')} \\(Viewer`));
  assert.match(result.advice[1], /^Organizations that block sharing outside their domain also block sharing with a service account/);
  assert.match(result.advice[1], /three ways out: make .* a member of a shared drive.*have a Workspace admin allow sharing with .*install paraclete with a Workspace role/);
  assert.match(result.advice[2], /^Optional: set an output folder in Settings.*a folder in a shared drive .* as Content manager/);
  assert.equal(api.calls.some((c) => c.method !== 'GET'), false, 'nothing is written without an output folder');
  const list = api.calls.find((c) => c.path === '/drive/v3/files');
  assert.equal(list.params.get('q'), 'trashed = false and sharedWithMe = true');
  assert.equal(list.params.get('pageSize'), '100');
});

test("a Workspace account is told to share with its own address, with no word of a service account's block", async () => {
  const result = await run(fakeDriveApi(), { instance: WORKSPACE });
  assert.deepEqual(result.identity, { kind: 'workspace', email: 'agent@example.com' });
  assert.match(result.advice[0], /add agent@example\.com, the agent's own account/);
  assert.equal(result.advice.some((a) => /service account/.test(a)), false);
  assert.match(result.advice.at(-1), /without one it saves them to its own My Drive/);
});

test('what is shared, the shared drives and a writable output folder: the test file is created there and trashed', async () => {
  const shared = [
    { id: '1SharedAAbCdEfGhIjKlMnOpQrStUvWxy', name: 'Plan', mimeType: 'application/vnd.google-apps.document', owners: [{ displayName: 'Ann', emailAddress: 'ann@example.com' }] },
    { id: '1SharedBAbCdEfGhIjKlMnOpQrStUvWxy', name: 'Data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', owners: [{ displayName: 'Bo' }] },
    { id: '1SharedCAbCdEfGhIjKlMnOpQrStUvWxy', name: 'Team notes', mimeType: 'application/pdf' },
  ];
  const drives = [{ id: DRIVE_ID, name: 'Team', capabilities: { canAddChildren: true, canTrashChildren: true, canDeleteChildren: false } }];
  const api = fakeDriveApi({ shared, drives, files: sharedFolder() });
  const result = await run(api, { settings: { drive_output_folder: FOLDER } });
  assert.deepEqual(result.shared_with_me, {
    count: 3,
    capped: false,
    sample: [
      { id: shared[0].id, name: 'Plan', mime_type: 'application/vnd.google-apps.document', owner: 'ann@example.com' },
      { id: shared[1].id, name: 'Data.xlsx', mime_type: shared[1].mimeType, owner: 'Bo' },
      { id: shared[2].id, name: 'Team notes', mime_type: 'application/pdf', owner: null },
    ],
  });
  assert.deepEqual(result.shared_drives, [{ id: DRIVE_ID, name: 'Team', can_add_files: true }]);
  assert.deepEqual(result.output_folder, { id: FOLDER, name: 'Agent output', drive_id: DRIVE_ID, writable: true, error: null });
  assert.deepEqual(result.advice, []);
  assert.equal(result.error, null);

  const created = api.calls.find((c) => c.method === 'POST');
  const body = Buffer.from(created.body).toString();
  assert.match(body, /"name":"paraclete-drive-check-20261018T123456Z\.txt","parents":\["1OutputFolderAbCdEfGhIjKlMnOpQrSt"\]/);
  const trashed = api.calls.find((c) => c.method === 'PATCH');
  assert.equal(trashed.path, `/drive/v3/files/${NEW_FILE}`);
  assert.deepEqual(JSON.parse(trashed.body), { trashed: true });
  assert.equal(api.calls.some((c) => c.method === 'DELETE'), false, 'never deleted for good');
});

test('more shared files than the count stops at are reported as capped, with five named', async () => {
  const shared = Array.from({ length: 120 }, (_, i) => ({ id: `1Shared${String(i).padStart(3, '0')}AbCdEfGhIjKlMnOpQrSt`, name: `f${i}` }));
  const result = await run(fakeDriveApi({ shared }), { settings: { drive_output_folder: null } });
  assert.equal(result.shared_with_me.count, 100);
  assert.equal(result.shared_with_me.capped, true);
  assert.equal(result.shared_with_me.sample.length, 5);
  assert.equal(result.advice.some((a) => /Nothing is shared/.test(a)), false);
});

test("a service account's output folder in someone's My Drive is not writable, and the advice says to use a shared drive", async () => {
  const api = fakeDriveApi({
    files: { [FOLDER]: { id: FOLDER, name: 'Reports', mimeType: FOLDER_MIME, capabilities: { canAddChildren: true } } },
    create: () => googleError(403, 'storageQuotaExceeded', 'Service Accounts do not have storage quota.'),
  });
  const result = await run(api, { settings: { drive_output_folder: FOLDER } });
  assert.equal(result.output_folder.writable, false);
  assert.equal(result.output_folder.drive_id, null);
  assert.match(result.output_folder.error, /has no Drive storage of its own/);
  assert.match(result.advice.at(-1), new RegExp(`^The output folder "Reports" \\(${FOLDER}\\) is in someone's My Drive, where a service account cannot create files.*Choose a folder in a shared drive`));
  assert.equal(api.calls.some((c) => c.method === 'PATCH'), false);
});

test('an output folder the agent cannot see, cannot add to, or that is not a folder is reported without writing', async () => {
  const missing = await run(fakeDriveApi(), { settings: { drive_output_folder: FOLDER } });
  assert.deepEqual({ ...missing.output_folder, error: undefined }, { id: FOLDER, name: null, drive_id: null, writable: false, error: undefined });
  assert.match(missing.output_folder.error, /not shared with/);
  assert.match(missing.advice.at(-1), new RegExp(`^The output folder ${FOLDER} does not take new files from .*as Content manager`));

  const viewer = fakeDriveApi({ files: sharedFolder({ capabilities: { canAddChildren: false } }) });
  const readOnly = await run(viewer, { settings: { drive_output_folder: FOLDER } });
  assert.equal(readOnly.output_folder.writable, false);
  assert.match(readOnly.output_folder.error, /can open this folder but not add files to it/);
  assert.equal(viewer.calls.some((c) => c.method === 'POST'), false);

  const doc = await run(fakeDriveApi({ files: { [FOLDER]: { id: FOLDER, name: 'Plan', mimeType: 'application/vnd.google-apps.document' } } }), { settings: { drive_output_folder: FOLDER } });
  assert.equal(doc.output_folder.writable, false);
  assert.match(doc.advice.at(-1), /which is a Google Doc, not a folder\. Choose a folder\./);

  const workspace = await run(fakeDriveApi(), { instance: WORKSPACE, settings: { drive_output_folder: FOLDER } });
  assert.match(workspace.advice.at(-1), /Share it with agent@example\.com as Editor, or choose another folder\./);
});

test('a test file that cannot be trashed leaves the folder writable, names the file, and says to delete it', async () => {
  const api = fakeDriveApi({ files: sharedFolder(), trash: () => googleError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.') });
  const result = await run(api, { settings: { drive_output_folder: FOLDER } });
  assert.equal(result.output_folder.writable, true);
  assert.match(result.output_folder.error, new RegExp(`^the test file paraclete-drive-check-20261018T123456Z\\.txt \\(${NEW_FILE}\\) was created but could not be moved to the trash`));
  assert.match(result.advice.at(-1), /delete the test file by hand, or make .* a Content manager/);
});

test('Drive out of reach is reported with what to fix, and the output folder is not checked', async () => {
  const off = fakeDriveApi({ about: () => json({ error: { code: 403, message: 'Google Drive API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }, 403) });
  const result = await run(off, { settings: { drive_output_folder: FOLDER } });
  assert.equal(result.reachable, false);
  assert.match(result.error, /Drive API is turned off/);
  assert.deepEqual(result.advice, ['Turn on the Google Drive API for this project (Google Cloud console, APIs & Services); the installer normally turns it on.']);
  assert.deepEqual(result.output_folder, { id: FOLDER, name: null, drive_id: null, writable: false, error: 'not checked: Drive is unreachable' });
  assert.deepEqual(result.shared_with_me, { count: 0, capped: false, sample: [] });
  assert.equal(off.calls.length, 1, 'nothing after the first refusal');

  const noScope = fakeDriveApi({ about: () => json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, 403) });
  assert.match((await run(noScope)).advice[0], /VM runs without the Drive scope\. Re-run the installer/);

  const noGrant = await run(fakeDriveApi(), { instance: WORKSPACE, getDwdToken: async () => { throw new Error('Delegated token exchange failed: unauthorized_client'); } });
  assert.equal(noGrant.reachable, false);
  assert.match(noGrant.error, /unauthorized_client/);
  assert.match(noGrant.advice[0], /Check its domain-wide delegation grant in the Google Admin console/);
});

test('a step that fails after Drive answered is reported, and the rest still runs', async () => {
  const api = fakeDriveApi({ files: sharedFolder() });
  const flaky = async (url, init) => (new URL(url).pathname === '/drive/v3/drives' ? googleError(429, 'rateLimitExceeded', 'Rate Limit Exceeded') : api.fetch(url, init));
  const result = await run({ fetch: flaky }, { settings: { drive_output_folder: FOLDER } });
  assert.equal(result.reachable, true);
  assert.match(result.error, /limiting requests/);
  assert.ok(result.advice.some((a) => /^Listing the shared drives the agent belongs to failed: .*Run the check again/.test(a)));
  assert.equal(result.output_folder.writable, true);
});

test('settings that cannot be read fail the check instead of reading as "no output folder"', async () => {
  const api = fakeDriveApi();
  const drive = createDriveClient({ instance: INSTANCE, fetch: api.fetch, getAccessToken: async () => 'vm-token' });
  const db = fakeDb();
  db.failOnce('read', new Error('Firestore unavailable'), 'config/settings');
  await assert.rejects(checkDrive({ drive, db, now: () => NOW }), /Firestore unavailable/);
  assert.equal(api.calls.length, 0);
});
