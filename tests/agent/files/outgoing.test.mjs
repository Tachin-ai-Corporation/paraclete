// Tests for agent/files/outgoing.mjs: the `files` records of outgoing files, written and listed against
// the Firestore fake, and a reply's attachments built from them.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../../fakes/firestore-server.mjs';
import { createClient } from '../../../agent/storage/firestore.mjs';
import {
  listOutgoing, MAX_ATTACHMENTS, outgoingFileId, outgoingRecord, recordOutgoing, replyAttachments,
} from '../../../agent/files/outgoing.mjs';

const NOW = Date.parse('2026-10-18T09:00:00.000Z');
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

const upload = (name, over = {}) => ({ name, size: 10, gcsPath: `files/out/w-1/${name}`, contentType: 'application/pdf', sha256: 'ab'.repeat(32), ...over });

test('a record id is deterministic: out-<mission>-<name with odd characters as _>', () => {
  assert.equal(outgoingFileId('w-1', 'Q3 report (final).docx'), 'out-w-1-Q3_report__final__docx');
  assert.equal(outgoingFileId('w-1', 'a.md'), outgoingFileId('w-1', 'a.md'));
});

test('a record has the contract shape', () => {
  assert.deepEqual(outgoingRecord({ missionId: 'w-1', file: upload('a.pdf'), source: 'file-share', createdBy: 'agent@example.com', at: '2026-10-18T09:00:00.000Z', drive: { file_id: 'd1', link: 'https://drive.example.com/d1', folder_id: 'f1' } }), {
    direction: 'out', mission_id: 'w-1', name: 'a.pdf', size: 10, content_type: 'application/pdf', gcs_path: 'files/out/w-1/a.pdf',
    sha256: 'ab'.repeat(32), source: 'file-share', created_at: '2026-10-18T09:00:00.000Z', created_by: 'agent@example.com',
    drive: { file_id: 'd1', link: 'https://drive.example.com/d1', folder_id: 'f1' }, expires_at: null,
  });
  assert.equal(outgoingRecord({ missionId: 'w-1', file: upload('b.md', { sha256: undefined }), source: 'artifact', createdBy: 'a@example.com', at: 'x' }).sha256, null);
});

test('records are written, re-sharing a name overwrites its record, and listing returns only the mission\'s outgoing files', async () => {
  const written = await recordOutgoing(db, { missionId: 'w-1', files: [upload('a.pdf'), upload('b.csv')], source: 'artifact', createdBy: 'agent@example.com', now: () => NOW });
  assert.deepEqual(written.map((w) => w.id), ['out-w-1-a_pdf', 'out-w-1-b_csv']);
  await recordOutgoing(db, { missionId: 'w-1', files: [upload('a.pdf', { size: 99 })], source: 'file-share', createdBy: 'agent@example.com', now: () => NOW + 1000 });
  await recordOutgoing(db, { missionId: 'w-2', files: [upload('c.pdf')], source: 'file-share', createdBy: 'agent@example.com', now: () => NOW });
  // An upload the mission took: an 'in' record with the same mission id is not an outgoing file.
  await db.write('files/u-1-aaaaaaaa', { direction: 'in', mission_id: 'w-1', name: 'in.pdf', gcs_path: 'files/in/u-1-aaaaaaaa/in.pdf', created_at: '2026-10-18T08:00:00.000Z' });

  const rows = await listOutgoing(db, 'w-1');
  assert.deepEqual(rows.map((r) => [r.id, r.size, r.source]), [['out-w-1-b_csv', 10, 'artifact'], ['out-w-1-a_pdf', 99, 'file-share']]);
  assert.equal(rows[0].created_at, '2026-10-18T09:00:00.000Z');
});

test('the artifact export of a file the agent shared keeps it marked shared, with its Drive copy', async () => {
  const drive = { file_id: 'drive-file-1', link: 'https://drive.google.com/file/d/drive-file-1/view', folder_id: 'folder-1' };
  await recordOutgoing(db, { missionId: 'w-1', files: [upload('summary.docx')], source: 'file-share', createdBy: 'agent@example.com', drive, now: () => NOW });
  await recordOutgoing(db, { missionId: 'w-1', files: [upload('summary.docx', { size: 12 }), upload('notes.md')], source: 'artifact', createdBy: 'agent@example.com', now: () => NOW + 60_000 });
  const shared = await db.read('files/out-w-1-summary_docx');
  assert.equal(shared.source, 'file-share');
  assert.deepEqual(shared.drive, drive);
  assert.equal(shared.size, 12, 'the latest upload of the object wins');
  const exported = await db.read('files/out-w-1-notes_md');
  assert.equal(exported.source, 'artifact');
  assert.equal(exported.drive, null);
});

test('a failed write is logged and the rest are written, unless strict', async () => {
  const logs = [];
  const flaky = { write: async (path, data, opts) => (path.endsWith('a_pdf') ? (opts.strict ? Promise.reject(new Error('unavailable')) : null) : db.write(path, data, opts)) };
  const written = await recordOutgoing(flaky, { missionId: 'w-3', files: [upload('a.pdf'), upload('b.pdf')], source: 'artifact', createdBy: 'x@example.com', log: (l, m) => logs.push(`${l} ${m}`) });
  assert.deepEqual(written.map((w) => w.id), ['out-w-3-b_pdf']);
  assert.match(logs[0], /WARN files record out-w-3-a_pdf not written/);
  await assert.rejects(recordOutgoing(flaky, { missionId: 'w-3', files: [upload('a.pdf')], source: 'file-share', createdBy: 'x@example.com', strict: true }), /unavailable/);
});

test('listing is strict: an outage throws rather than reading as "no files"', async () => {
  const broken = createClient({ projectId: 'p', firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {}, fetch: async () => new Response('down', { status: 503 }) });
  await assert.rejects(listOutgoing(broken, 'w-1'));
});

test('reply attachments: one per object, shared files first, records winning, capped', () => {
  const records = [
    { name: 'export.md', size: 1, gcs_path: 'files/out/w-1/export.md', source: 'artifact', created_at: '1' },
    { name: 'report.docx', size: 2, gcs_path: 'files/out/w-1/report.docx', source: 'file-share', created_at: '2' },
  ];
  const existing = [{ name: 'export.md', size: 0, gcsPath: 'files/out/w-1/export.md', contentType: 'text/markdown' }, { name: 'old.csv', size: 3, gcsPath: 'files/out/w-1/old.csv' }, { name: 'nopath' }];
  assert.deepEqual(replyAttachments(records, existing), [
    { name: 'report.docx', size: 2, gcsPath: 'files/out/w-1/report.docx' },
    { name: 'export.md', size: 1, gcsPath: 'files/out/w-1/export.md' },
    { name: 'old.csv', size: 3, gcsPath: 'files/out/w-1/old.csv' },
  ]);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, size: 1, gcs_path: `files/out/w-1/f${i}`, source: 'file-share' }));
  assert.equal(replyAttachments(many).length, MAX_ATTACHMENTS);
  assert.deepEqual(replyAttachments([], []), []);
});
