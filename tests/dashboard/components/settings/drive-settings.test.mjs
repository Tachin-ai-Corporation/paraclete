// Tests for dashboard/components/settings/drive-settings.js: a pasted Drive folder link becomes the id
// the server stores, and the drive_check result reads as plain sentences with its problems marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveCheckView, folderLink, parseDriveFolder } from '../../../../dashboard/components/settings/drive-settings.js';
import { DRIVE_ID } from '../../../../dashboard/lib/server/settings.mjs';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const SHARED_DRIVE_ROOT = '0ABcDeFgHiJkLmNoPQ9';

test('a folder link in any of its usual shapes, or a bare id, gives the folder id the server accepts', () => {
  const links = [
    ID,
    `  ${ID}  `,
    `https://drive.google.com/drive/folders/${ID}`,
    `https://drive.google.com/drive/folders/${ID}?usp=sharing`,
    `https://drive.google.com/drive/u/1/folders/${ID}?resourcekey=0-abc`,
    `https://drive.google.com/drive/mobile/folders/${ID}`,
    `drive.google.com/drive/folders/${ID}`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/folderview?id=${ID}`,
  ];
  for (const link of links) {
    assert.deepEqual(parseDriveFolder(link), { id: ID, error: null }, link);
    assert.match(parseDriveFolder(link).id, DRIVE_ID);
  }
  assert.deepEqual(parseDriveFolder(`https://drive.google.com/drive/folders/${SHARED_DRIVE_ROOT}`), { id: SHARED_DRIVE_ROOT, error: null });
  assert.equal(folderLink(ID), `https://drive.google.com/drive/folders/${ID}`);
});

test('empty input clears the setting; files, other sites and nonsense are refused with why', () => {
  assert.deepEqual(parseDriveFolder(''), { id: null, error: null });
  assert.deepEqual(parseDriveFolder('   '), { id: null, error: null });
  assert.deepEqual(parseDriveFolder(undefined), { id: null, error: null });
  const refusals = {
    [`https://drive.google.com/file/d/${ID}/view`]: /a file, not a folder/,
    [`https://docs.google.com/document/d/${ID}/edit`]: /a file, not a folder/,
    [`https://example.com/drive/folders/${ID}`]: /not a Google Drive link/,
    'https://drive.google.com/drive/my-drive': /No folder id/,
    'my folder': /Drive folder link or a folder id/,
    'short': /Drive folder link or a folder id/,
  };
  for (const [input, why] of Object.entries(refusals)) {
    const parsed = parseDriveFolder(input);
    assert.equal(parsed.id, null, input);
    assert.match(parsed.error, why, input);
  }
});

const healthy = () => ({
  identity: { kind: 'service_account', email: 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com' },
  reachable: true,
  error: null,
  shared_with_me: {
    count: 2,
    capped: false,
    sample: [
      { id: 'f1', name: 'Q3 plan', mime_type: 'application/vnd.google-apps.document', owner: 'ada@example.com' },
      { id: 'f2', name: 'Team drive file', mime_type: 'application/pdf', owner: null },
    ],
  },
  shared_drives: [{ id: SHARED_DRIVE_ROOT, name: 'Reports', can_add_files: true }],
  output_folder: { id: ID, name: 'Agent output', drive_id: SHARED_DRIVE_ROOT, writable: true, error: null },
  advice: [],
});

test('a healthy check reads as who the agent is, what it sees, and that the output folder takes files', () => {
  const view = driveCheckView(healthy());
  assert.equal(view.ok, true);
  assert.equal(view.headline, 'It reaches Drive as its service account, paraclete-agent@your-gcp-project.iam.gserviceaccount.com. 2 files and folders are shared with it.');
  assert.deepEqual(view.lines.map((line) => [line.label, line.text, line.problem]), [
    ['Identity', 'It reaches Drive as its service account, paraclete-agent@your-gcp-project.iam.gserviceaccount.com.', false],
    ['Shared with it', '2 files and folders are shared with it.', false],
    ['Shared drives', 'It is a member of 1 shared drive: Reports.', false],
    ['Output folder', 'The output folder "Agent output" in a shared drive can be written to.', false],
  ]);
  assert.deepEqual(view.sample, [
    { id: 'f1', name: 'Q3 plan', owner: 'ada@example.com' },
    { id: 'f2', name: 'Team drive file', owner: null },
  ]);
  assert.deepEqual(view.advice, []);
  assert.equal(driveCheckView(null), null);
});

test('nothing shared and no output folder are not problems; the advice is passed on', () => {
  const view = driveCheckView({
    ...healthy(),
    identity: { kind: 'workspace', email: 'agent@example.com' },
    shared_with_me: { count: 0, capped: false, sample: [] },
    shared_drives: [],
    output_folder: null,
    advice: ['Share a file with agent@example.com to try it.', '  ', 7],
  });
  assert.equal(view.ok, true);
  assert.deepEqual(view.lines.map((line) => line.text), [
    'It reaches Drive as its Google Workspace account, agent@example.com.',
    'Nothing is shared with it yet.',
    'It is not a member of any shared drive.',
    'No output folder is set.',
  ]);
  assert.deepEqual(view.advice, ['Share a file with agent@example.com to try it.']);
  assert.equal(driveCheckView({ ...healthy(), shared_with_me: { count: 100, capped: true, sample: [] } }).lines[1].text,
    'At least 100 files and folders are shared with it.');
  assert.equal(driveCheckView({ ...healthy(), shared_with_me: { count: 1, capped: false, sample: [] } }).lines[1].text,
    '1 file or folder is shared with it.');
});

test('Drive not answering, or an output folder that takes no files, is a problem', () => {
  const down = driveCheckView({ ...healthy(), reachable: false, error: 'the Drive API is not enabled in this project', advice: ['Turn on the Drive API.'] });
  assert.equal(down.ok, false);
  assert.match(down.headline, /^It could not reach Drive as its service account, .*: the Drive API is not enabled in this project$/);
  assert.deepEqual(down.lines.map((line) => line.problem), [true]);
  assert.deepEqual(down.advice, ['Turn on the Drive API.']);

  const myDrive = driveCheckView({ ...healthy(), output_folder: { id: ID, name: null, drive_id: null, writable: false, error: 'service accounts have no storage' } });
  assert.equal(myDrive.ok, false);
  assert.equal(myDrive.headline, `The output folder ${ID} cannot be written to: service accounts have no storage`);
  assert.equal(myDrive.lines[3].problem, true);

  const leftover = driveCheckView({ ...healthy(), output_folder: { ...healthy().output_folder, error: 'the test file could not be trashed' } });
  assert.equal(leftover.ok, true);
  assert.match(leftover.lines[3].text, /can be written to \(the test file could not be trashed\)\.$/);
  assert.equal(driveCheckView({ ...healthy(), shared_drives: [{ id: 'd', name: 'Archive', can_add_files: false }] }).lines[2].text,
    'It is a member of 1 shared drive: Archive (cannot add files).');
});
