// Tests for skills/drive/drive-put.mjs: a mission's file goes up as a new Drive file in the folder
// given, else the admin's output folder, and the command prints its id and link; --convert makes a
// Google file; it only ever creates (one upload, never an update, move or delete); a service account
// with no folder is refused with the reason; files outside the data root, credentials, oversized files
// and bad arguments never reach Drive. Drive is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as drivePut from '../../../skills/drive/drive-put.mjs';
import { createDriveClient } from '../../../agent/providers/drive.mjs';
import { fakeDriveFetch, driveRuntime, run, googleError, SA_EMAIL, WORKSPACE } from './fakes.mjs';

const OUTPUT = '1OutputFolderAbCdEfGhIjKlMnOpQrSt';
const OTHER = '1OtherFolderBcDeFgHiJkLmNoPqRsTuV';
const CREATED = '1CreatedAbCdEfGhIjKlMnOpQrStUvWx';

/** A runtime with report.md (and anything in `extra`) written into mission w-1's tree. */
function setup({ api = fakeDriveFetch(), settings = { drive_output_folder: OUTPUT }, extra = {}, files } = {}) {
  const runtime = driveRuntime({ api, settings, ...(files ? { files } : {}) });
  const tree = join(runtime.instance.data_root, 'missions', 'w-1');
  mkdirSync(join(tree, 'out'), { recursive: true });
  writeFileSync(join(tree, 'out', 'report.md'), '# Report\n');
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(tree, name), text);
  return { runtime, tree };
}

/** The JSON metadata part of a multipart upload. */
const metadataOf = (call) => JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(Buffer.from(call.body).toString())[1]);

test('--help prints the usage', async () => {
  const r = await run(drivePut, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: drive-put --mission <mission id> <path> /);
});

test("a file from the mission tree goes to the admin's output folder as a new file, with its id and link printed", async () => {
  const api = fakeDriveFetch();
  const { runtime } = setup({ api });
  const r = await run(drivePut, ['--mission', 'w-1', 'out/report.md'], { runtime });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    `Created "created" (text/markdown) in Drive folder ${OUTPUT}`,
    `id: ${CREATED}`,
    `link: https://drive.google.com/file/d/${CREATED}/view`,
    '',
  ].join('\n'));
  assert.deepEqual(runtime.db.reads, [{ path: 'config/settings', opts: { strict: true } }]);
  assert.equal(api.calls.length, 1, 'one upload and nothing else');
  assert.equal(api.calls[0].method, 'POST');
  assert.equal(api.calls[0].params.get('uploadType'), 'multipart');
  assert.deepEqual(metadataOf(api.calls[0]), { name: 'report.md', parents: [OUTPUT] });
});

test('--folder and --name override the defaults; --convert makes a Google Doc without the extension', async () => {
  const api = fakeDriveFetch();
  const { runtime } = setup({ api });
  assert.equal((await run(drivePut, ['--mission', 'w-1', 'out/report.md', '--folder', `https://drive.google.com/drive/folders/${OTHER}`, '--name', 'Final.md'], { runtime })).code, 0);
  assert.deepEqual(metadataOf(api.calls[0]), { name: 'Final.md', parents: [OTHER] });
  assert.deepEqual(runtime.db.reads, [], 'the setting is not read when a folder is given');
  const converted = await run(drivePut, ['--mission', 'w-1', 'out/report.md', '--convert', '--json'], { runtime });
  assert.equal(converted.code, 0, converted.err);
  assert.deepEqual(metadataOf(api.calls[1]), { name: 'report', parents: [OUTPUT], mimeType: 'application/vnd.google-apps.document' });
  assert.deepEqual(JSON.parse(converted.out), { id: CREATED, name: 'created', mime_type: null, link: `https://drive.google.com/file/d/${CREATED}/view`, folder_id: OUTPUT });
});

test('a service account with no folder is refused with why, before any upload', async () => {
  const api = fakeDriveFetch();
  const { runtime } = setup({ api, settings: {} });
  const r = await run(drivePut, ['--mission', 'w-1', 'out/report.md'], { runtime });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`no folder given and no Drive output folder is set\\. ${SA_EMAIL.replace(/\./g, '\\.')} is a service account with no Drive storage of its own`));
  assert.equal(api.calls.length, 0);
});

test('a Workspace account with no folder creates in its own My Drive', async () => {
  const api = fakeDriveFetch();
  const { runtime } = setup({ api, settings: {} });
  const drive = createDriveClient({ instance: { project: 'your-gcp-project', workspace: WORKSPACE }, fetch: api.fetch, getDwdToken: async () => 'dwd' });
  const r = await run(drivePut, ['--mission', 'w-1', 'out/report.md'], { runtime, drive });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(metadataOf(api.calls[0]), { name: 'report.md' });
  assert.match(r.out, /in the My Drive of agent@example\.com/);
});

test("Drive's refusal reaches the agent in plain words", async () => {
  const api = fakeDriveFetch({ create: () => googleError(403, 'storageQuotaExceeded', 'Service Accounts do not have storage quota.') });
  const { runtime } = setup({ api });
  const r = await run(drivePut, ['--mission', 'w-1', 'out/report.md'], { runtime });
  assert.equal(r.code, 1);
  assert.match(r.err, /^drive-put: .* is a service account and has no Drive storage of its own/);
});

test('files outside the data root, credentials, missing, oversized and unconvertible files never reach Drive', async () => {
  const api = fakeDriveFetch();
  const { runtime } = setup({ api, extra: { '.env': 'X=1', 'scan.pdf': '%PDF' } });
  const outside = join(runtime.instance.data_root, '..', 'outside.txt');
  writeFileSync(outside, 'secret');
  const cases = [
    [[outside], /outside the agent's data directory/],
    [['.env'], /holds credentials/],
    [['missing.md'], /does not exist \(a relative path starts from the mission tree/],
    [['out'], /is not a file/],
    [['scan.pdf', '--convert'], /cannot become a Google file/],
  ];
  for (const [args, pattern] of cases) {
    const r = await run(drivePut, ['--mission', 'w-1', ...args], { runtime });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, pattern);
  }
  const small = setup({ api, files: { max_mb: 1 / 1048576 } });
  const big = await run(drivePut, ['--mission', 'w-1', join(small.tree, 'out', 'report.md')], { runtime: small.runtime });
  assert.equal(big.code, 1);
  assert.match(big.err, /more than the 0 MB a file sent to Drive may be/);
  assert.equal(api.calls.length, 0);
});

test('a settings read that fails is an error that names --folder, not "no folder set"', async () => {
  const api = fakeDriveFetch();
  const { runtime } = setup({ api, settings: new Error('Firestore unavailable') });
  const r = await run(drivePut, ['--mission', 'w-1', 'out/report.md'], { runtime });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot read the Drive output folder setting \(Firestore unavailable\); pass --folder/);
  assert.equal(api.calls.length, 0);
});

test('bad arguments are usage errors', async () => {
  const { runtime } = setup();
  for (const argv of [['out/report.md'], ['--mission', 'w-1'], ['--mission', '../x', 'a'], ['--mission', 'w-1', 'a', '--folder', 'nope'], ['--mission', 'w-1', 'a', 'b']]) {
    const r = await run(drivePut, argv, { runtime });
    assert.equal(r.code, 2, argv.join(' '));
  }
});
