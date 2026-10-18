// Tests for skills/drive/drive-find.mjs: a search becomes the right Drive query and prints each match
// plainly (or as JSON); --whoami names the identity people share with; --drives lists the shared
// drives and whether files can be added to each; bad arguments are refused before Drive is asked.
// Drive is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as driveFind from '../../../skills/drive/drive-find.mjs';
import { createDriveClient } from '../../../agent/providers/drive.mjs';
import { fakeDriveFetch, driveRuntime, run, json, googleError, SA_EMAIL, WORKSPACE } from './fakes.mjs';

const DOC_ID = '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const FOLDER_ID = '1FolderBcDeFgHiJkLmNoPqRsTuVwXyz01';
const PLAN = {
  id: DOC_ID, name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T09:00:00.000Z',
  owners: [{ displayName: 'Ann', emailAddress: 'ann@example.com' }], webViewLink: `https://docs.google.com/document/d/${DOC_ID}/edit`,
};

test('--help prints the usage', async () => {
  const r = await run(driveFind, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: drive-find /);
});

test('a search prints each match with its type, id, date, owner and link', async () => {
  const api = fakeDriveFetch({ list: () => json({ files: [PLAN], nextPageToken: 'more' }) });
  const r = await run(driveFind, ['budget', 'review', '--name', "Q3 'final'", '--type', 'doc', '--folder', `https://drive.google.com/drive/folders/${FOLDER_ID}`, '--limit', '1'], { runtime: driveRuntime({ api }) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    `1 file that ${SA_EMAIL} can see:`,
    `1. Plan | Google Doc | id ${DOC_ID} | modified 2026-10-01 | owner Ann <ann@example.com>`,
    `   https://docs.google.com/document/d/${DOC_ID}/edit`,
    'More files match: narrow the search, or raise --limit (at most 200).',
    '',
  ].join('\n'));
  const { params } = api.calls[0];
  assert.equal(params.get('q'), `trashed = false and fullText contains 'budget review' and name contains 'Q3 \\'final\\'' and mimeType = 'application/vnd.google-apps.document' and '${FOLDER_ID}' in parents`);
  assert.equal(params.get('pageSize'), '1');
});

test('no match says the file may not be shared, naming the address', async () => {
  const r = await run(driveFind, ['--shared-with-me', '--type', 'pdf'], { runtime: driveRuntime() });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`^No files found that ${SA_EMAIL.replace(/\./g, '\\.')} can see\\. A file that exists but is not listed has not been shared with`));
});

test('--json prints the identity, the files and the flags', async () => {
  const api = fakeDriveFetch({ list: () => json({ files: [PLAN] }) });
  const r = await run(driveFind, ['--json'], { runtime: driveRuntime({ api }) });
  const out = JSON.parse(r.out);
  assert.deepEqual(out.identity, { kind: 'service_account', email: SA_EMAIL });
  assert.equal(out.files[0].id, DOC_ID);
  assert.equal(out.capped, false);
});

test('--whoami names the service account, or the Workspace account', async () => {
  const sa = await run(driveFind, ['--whoami'], { runtime: driveRuntime() });
  assert.match(sa.out, new RegExp(`^You act on Drive as the service account ${SA_EMAIL.replace(/\./g, '\\.')}\\. People share files and folders with that address; you create new files only inside a shared drive`));
  const drive = createDriveClient({ instance: { project: 'your-gcp-project', workspace: WORKSPACE }, fetch: fakeDriveFetch().fetch, getDwdToken: async () => 't' });
  const ws = await run(driveFind, ['--whoami', '--json'], { drive });
  assert.deepEqual(JSON.parse(ws.out), { kind: 'workspace', email: 'agent@example.com' });
});

test('--drives lists the shared drives and whether files can be added to each', async () => {
  const api = fakeDriveFetch({ drives: [
    { id: '0AExampleSharedDrv9PVA', name: 'Team', capabilities: { canAddChildren: true } },
    { id: '0BExampleSharedDrv9PVA', name: 'Archive', capabilities: { canAddChildren: false } },
  ] });
  const r = await run(driveFind, ['--drives'], { runtime: driveRuntime({ api }) });
  assert.equal(r.out, [
    `${SA_EMAIL} is a member of 2 shared drives:`,
    '- Team | id 0AExampleSharedDrv9PVA | can add files',
    '- Archive | id 0BExampleSharedDrv9PVA | read only: cannot add files',
    '',
  ].join('\n'));
  const none = await run(driveFind, ['--drives'], { runtime: driveRuntime() });
  assert.equal(none.out, `${SA_EMAIL} is a member of no shared drive.\n`);
});

test("Drive's refusal is a plain error and exit 1", async () => {
  const api = fakeDriveFetch({ list: () => googleError(403, 'accessNotConfigured', 'Google Drive API has not been used in project 1 before or it is disabled.') });
  const r = await run(driveFind, ['x'], { runtime: driveRuntime({ api }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /^drive-find: The Google Drive API is turned off in this project/);
});

test('bad arguments are usage errors, and Drive is never asked', async () => {
  const api = fakeDriveFetch();
  for (const argv of [['--type', 'spreadsheetz'], ['--limit', '0'], ['--limit', '201'], ['--folder', 'nope'], ['--bogus']]) {
    const r = await run(driveFind, argv, { runtime: driveRuntime({ api }) });
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.equal(api.calls.length, 0);
});

test('--type takes short names, extensions and MIME types', () => {
  assert.equal(driveFind.mimeTypeFor('sheet'), 'application/vnd.google-apps.spreadsheet');
  assert.equal(driveFind.mimeTypeFor('folder'), 'application/vnd.google-apps.folder');
  assert.equal(driveFind.mimeTypeFor('PDF'), 'application/pdf');
  assert.equal(driveFind.mimeTypeFor('xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(driveFind.mimeTypeFor('text/csv'), 'text/csv');
  assert.equal(driveFind.mimeTypeFor('bogus'), null);
});
