// Tests for agent/services/control/drive-check.mjs when drive_output_folder is set to the root of a
// shared drive: files.get returns name "Drive" and driveId equal to the root folder id, and checkDrive
// uses the shared drive's name from drives.list for output_folder.name and in non-writable advice,
// falling back to meta.name when the shared drive's name is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDrive } from '../../../../agent/services/control/drive-check.mjs';
import { createDriveClient, FOLDER_MIME } from '../../../../agent/providers/drive.mjs';
import { fakeDb } from './fakes.mjs';

const SA_EMAIL = 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com';
const INSTANCE = Object.freeze({ project: 'your-gcp-project', workspace: null, endpoints: {} });
const WORKSPACE = Object.freeze({ ...INSTANCE, workspace: { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' } });
const DRIVE_ID = '0AExampleSharedDrv9PVA';
const NEW_FILE = '1TestFileAbCdEfGhIjKlMnOpQrStUvWx';
const NOW = new Date('2026-10-18T12:34:56.789Z');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeDriveApi({ shared = [], drives = [], files = {} } = {}) {
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    if (u.pathname === '/drive/v3/about') return json({ user: { emailAddress: SA_EMAIL } });
    if (u.pathname === '/drive/v3/drives') return json({ drives });
    if (u.pathname === '/drive/v3/files' && method === 'GET') return json({ files: shared });
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') return json({ id: NEW_FILE, name: 'test' });
    const id = u.pathname.split('/').pop();
    if (method === 'PATCH') return json({ id, trashed: true });
    return json(files[id]);
  };
  return { fetch };
}

function run(api, { instance = INSTANCE, settings = { drive_output_folder: DRIVE_ID } } = {}) {
  const drive = createDriveClient({
    instance,
    fetch: api.fetch,
    getAccessToken: async () => 'vm-token',
    getDwdToken: async () => 'dwd-token',
  });
  const db = fakeDb({ 'config/settings': settings });
  return checkDrive({ drive, db, now: () => NOW });
}

test('output_folder set to a shared drive root uses the shared drive name from drives.list instead of "Drive"', async () => {
  const api = fakeDriveApi({
    drives: [{ id: DRIVE_ID, name: 'Team Shared Drive', capabilities: { canAddChildren: true } }],
    files: {
      [DRIVE_ID]: { id: DRIVE_ID, name: 'Drive', mimeType: FOLDER_MIME, driveId: DRIVE_ID, capabilities: { canAddChildren: true } },
    },
  });
  const result = await run(api);
  assert.deepEqual(result.output_folder, {
    id: DRIVE_ID,
    name: 'Team Shared Drive',
    drive_id: DRIVE_ID,
    writable: true,
    error: null,
  });
});

test('non-writable advice for a shared drive root uses the shared drive name from drives.list instead of "Drive"', async () => {
  const api = fakeDriveApi({
    drives: [{ id: DRIVE_ID, name: 'Team Shared Drive', capabilities: { canAddChildren: false } }],
    files: {
      [DRIVE_ID]: { id: DRIVE_ID, name: 'Drive', mimeType: FOLDER_MIME, driveId: DRIVE_ID, capabilities: { canAddChildren: false } },
    },
  });
  const saResult = await run(api);
  assert.equal(saResult.output_folder.name, 'Team Shared Drive');
  assert.equal(saResult.output_folder.writable, false);
  assert.equal(
    saResult.advice.at(-1).startsWith(`The output folder "Team Shared Drive" (${DRIVE_ID}) does not take new files from ${SA_EMAIL}:`),
    true,
  );
  assert.doesNotMatch(saResult.advice.at(-1), /"Drive"/);

  const wsResult = await run(api, { instance: WORKSPACE });
  assert.equal(wsResult.output_folder.name, 'Team Shared Drive');
  assert.equal(wsResult.output_folder.writable, false);
  assert.equal(
    wsResult.advice.at(-1).startsWith(`The output folder "Team Shared Drive" (${DRIVE_ID}) does not take new files from agent@example.com:`),
    true,
  );
});

test('falls back to meta.name when the shared drive is not in shared_drives or has no name', async () => {
  const missingDrive = fakeDriveApi({
    drives: [],
    files: {
      [DRIVE_ID]: { id: DRIVE_ID, name: 'Drive', mimeType: FOLDER_MIME, driveId: DRIVE_ID, capabilities: { canAddChildren: false } },
    },
  });
  const result = await run(missingDrive);
  assert.equal(result.output_folder.name, 'Drive');
  assert.equal(
    result.advice.at(-1).startsWith(`The output folder "Drive" (${DRIVE_ID}) does not take new files`),
    true,
  );

  const namelessDrive = fakeDriveApi({
    drives: [{ id: DRIVE_ID, name: null, capabilities: { canAddChildren: true } }],
    files: {
      [DRIVE_ID]: { id: DRIVE_ID, name: 'Drive', mimeType: FOLDER_MIME, driveId: DRIVE_ID, capabilities: { canAddChildren: true } },
    },
  });
  const namelessResult = await run(namelessDrive);
  assert.equal(namelessResult.output_folder.name, 'Drive');
});
