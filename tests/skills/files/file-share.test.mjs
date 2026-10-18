// Tests for skills/files/file-share.mjs: a file handed back is uploaded under the mission's downloads
// and recorded in `files`; with --drive it is also saved to Drive, always as a new file. Against the
// Firestore and Cloud Storage fakes, with a fake Drive client.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { start as startFirestore } from '../../fakes/firestore-server.mjs';
import { start as startStorage } from '../../fakes/gcs-server.mjs';
import { loadContracts } from '../../../config/contracts.mjs';
import { createClient } from '../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';
import * as fileShare from '../../../skills/files/file-share.mjs';
import { runCommand, scratch } from '../../agent/files/helpers.mjs';

const BUCKET = 'your-gcp-project-paraclete';
const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const dir = scratch('file-share-test-');
const contracts = loadContracts();
const missions = dir.dir('missions');
let firestore;
let storage;
let db;
before(async () => {
  firestore = await startFirestore();
  storage = await startStorage({ bucket: BUCKET });
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(async () => { await firestore.stop(); await storage.stop(); dir.cleanup(); });
beforeEach(() => { firestore.reset(); storage.reset(); });

function runtime(over = {}) {
  return {
    contracts: { ...contracts, files: { ...contracts.files, ...over.files } },
    instance: { project: 'your-gcp-project', bucket: BUCKET, endpoints: {} },
    paths: { data: { missions } },
    db,
    collections: COLLECTIONS,
    identity: { name: 'agent', email: 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com' },
    getAccessToken: async () => 'tok',
    fetch: globalThis.fetch,
    storageHost: storage.origin,
  };
}

function fakeDrive({ kind = 'service_account', fail = null } = {}) {
  const created = [];
  return {
    created,
    identity: () => ({ kind, email: kind === 'workspace' ? 'agent@example.com' : 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com' }),
    create: async (o) => {
      if (fail) throw new Error(fail);
      created.push(o);
      return { id: `d-${created.length}`, webViewLink: `https://drive.google.com/file/d/d-${created.length}/view` };
    },
  };
}

const run = (argv, deps = {}) => runCommand(fileShare, argv, { runtime: runtime(), now: () => NOW, cwd: dir.root, ...deps });

test('arguments: --drive takes a folder only when one follows; bad arguments exit 2', async () => {
  const folder = '0AbCdEfGhIjKlMnOpQrStUv';
  assert.deepEqual(fileShare.parseArgs(['--mission', 'w-1', 'r.pdf', '--drive', folder], { exists: () => false }), { mission: 'w-1', path: 'r.pdf', name: undefined, drive: true, folder });
  assert.equal(fileShare.parseArgs(['--mission', 'w-1', '--drive', 'r.pdf'], { exists: () => true }).folder, null);
  const lookalike = fileShare.parseArgs(['--drive', 'report_final_version_two'], { exists: (p) => p === 'report_final_version_two' });
  assert.deepEqual([lookalike.path, lookalike.folder], ['report_final_version_two', null], 'a file that exists is the file, even when it looks like a Drive id');
  assert.equal(fileShare.parseArgs([`--drive=https://drive.google.com/drive/folders/${folder}`, 'r.pdf']).folder, folder);
  assert.match(fileShare.parseArgs(['--drive=nope', 'r.pdf']).error, /not a Drive folder link or id/);
  for (const argv of [[], ['a', 'b'], ['--mission'], ['x', '--zip']]) assert.equal((await run(argv)).code, 2, argv.join(' '));
  assert.match((await run(['--help'])).out, /^Usage: file-share --mission/);
  const noMission = await run([dir.file('elsewhere.md', 'x')]);
  assert.deepEqual([noMission.code, /--mission <mission id> is required/.test(noMission.err)], [2, true]);
});

test('a file is uploaded as a download on the mission and recorded', async () => {
  dir.dir('missions/w-1');
  const path = dir.file('missions/w-1/out/Q3 report.docx', 'docx bytes');
  const { code, out, err } = await run(['--mission', 'w-1', path]);
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(out), { name: 'Q3 report.docx', size: 10, gcs_path: 'files/out/w-1/Q3 report.docx', file_id: 'out-w-1-Q3_report_docx', drive: null });
  assert.equal(storage.dump()['files/out/w-1/Q3 report.docx'].data.toString(), 'docx bytes');
  const record = await db.read(`${COLLECTIONS.files}/out-w-1-Q3_report_docx`);
  assert.deepEqual(record, {
    direction: 'out', mission_id: 'w-1', name: 'Q3 report.docx', size: 10,
    content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    gcs_path: 'files/out/w-1/Q3 report.docx', sha256: createHash('sha256').update('docx bytes').digest('hex'),
    source: 'file-share', created_at: '2026-10-18T10:00:00.000Z',
    created_by: 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com', drive: null, expires_at: null,
  });

  // The mission is read from the path; --name renames the download; sharing a name again replaces it.
  const again = await run([path, '--name', 'Final.docx']);
  assert.equal(JSON.parse(again.out).gcs_path, 'files/out/w-1/Final.docx');
});

test('credentials, oversized files and unknown missions are refused', async () => {
  dir.dir('missions/w-2');
  const env = await run(['--mission', 'w-2', dir.file('missions/w-2/.env', 'SECRET=1')]);
  assert.deepEqual([env.code, /not shared: .*\.env is a credential/.test(env.err)], [1, true]);
  const big = await runCommand(fileShare, ['--mission', 'w-2', dir.file('missions/w-2/big.bin', 'x'.repeat(2048))], {
    runtime: runtime({ files: { max_mb: 0.001 } }), cwd: dir.root,
  });
  assert.deepEqual([big.code, /more than the 1 KB a shared file may be/.test(big.err)], [1, true]);
  const gone = await run(['--mission', 'w-404', dir.file('x.md', 'x')]);
  assert.deepEqual([gone.code, /there is no running mission 'w-404'/.test(gone.err)], [2, true]);
  assert.deepEqual(Object.keys(storage.dump()), [], 'nothing uploaded');
});

test('--drive saves a new Drive file in the given folder, or the admin\'s output folder, and records it', async () => {
  dir.dir('missions/w-3');
  const path = dir.file('missions/w-3/plan.pdf', '%PDF-1.7');
  const drive = fakeDrive();
  const given = await run(['--mission', 'w-3', path, '--drive', '0AbCdEfGhIjKlMnOpQrStUv'], { drive });
  assert.equal(given.code, 0, given.err);
  assert.deepEqual(drive.created[0], { name: 'plan.pdf', parentId: '0AbCdEfGhIjKlMnOpQrStUv', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7') });
  const shown = JSON.parse(given.out).drive;
  assert.deepEqual(shown, { file_id: 'd-1', link: 'https://drive.google.com/file/d/d-1/view', folder_id: '0AbCdEfGhIjKlMnOpQrStUv' });
  assert.deepEqual((await db.read(`${COLLECTIONS.files}/out-w-3-plan_pdf`)).drive, shown);

  await db.write(`${COLLECTIONS.config}/settings`, { drive_output_folder: 'OutputFolder00000000000' });
  const fromSettings = await run(['--mission', 'w-3', path, '--drive'], { drive });
  assert.equal(fromSettings.code, 0);
  assert.equal(drive.created[1].parentId, 'OutputFolder00000000000');
  assert.equal(drive.created.length, 2, 'sharing again makes another new Drive file; nothing is replaced');
});

test('--drive as a service account with no folder refuses before uploading; a Drive failure keeps the download', async () => {
  dir.dir('missions/w-4');
  const path = dir.file('missions/w-4/notes.md', '# Notes');
  const refused = await run(['--mission', 'w-4', path, '--drive'], { drive: fakeDrive() });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /nothing was shared: no folder given and no Drive output folder is set.*share the file without --drive/);
  assert.deepEqual(Object.keys(storage.dump()), []);

  const workspace = fakeDrive({ kind: 'workspace' });
  assert.equal((await run(['--mission', 'w-4', path, '--drive'], { drive: workspace })).code, 0, 'a Workspace account creates in its own My Drive');
  assert.equal(workspace.created[0].parentId, undefined);

  const broken = await run(['--mission', 'w-4', path, '--drive', '0AbCdEfGhIjKlMnOpQrStUv'], { drive: fakeDrive({ fail: 'The service account is not a member of that shared drive.' }) });
  assert.equal(broken.code, 1);
  assert.match(broken.err, /shared as a download, but saving it to Drive failed: The service account is not a member/);
  assert.equal(JSON.parse(broken.out).drive, null);
  assert.equal((await db.read(`${COLLECTIONS.files}/out-w-4-notes_md`)).drive, null, 'the download is recorded');
});

test('a record that cannot be written is a failure that says the file is uploaded', async () => {
  dir.dir('missions/w-5');
  const path = dir.file('missions/w-5/a.csv', 'a,b');
  const brokenDb = { ...db, write: async () => { throw new Error('Firestore unavailable'); } };
  const result = await runCommand(fileShare, ['--mission', 'w-5', path], { runtime: { ...runtime(), db: brokenDb }, cwd: dir.root });
  assert.equal(result.code, 1);
  assert.match(result.err, /the file is uploaded \(gs:\/\/your-gcp-project-paraclete\/files\/out\/w-5\/a\.csv\), but its record was not written.*Run file-share again/);
});
