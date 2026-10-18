// Tests for agent/services/brain/completion.mjs: how a mission's run ends. A deliverable that is never
// empty, the status moved through the transition table, the delivery addressed, the mission record
// and artifacts, then the records and effects that follow, each best effort.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { addressFor, createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import { completionEvent, createCompletion, missionDirIn } from '../../../../agent/services/brain/completion.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

function setup({ artifacts = null, settings = {}, outgoingFiles = null } = {}) {
  const store = createEnvelopeStore({ db, clock: () => NOW, defaultProjectId: () => 'general' });
  const calls = { lines: [], lessons: [], events: [], dependents: [], completions: [], promotions: [] };
  const memory = {
    writeMissionLine: async (e) => { calls.lines.push(e.id); },
    recordLessons: async (e) => { calls.lessons.push(e.id); },
  };
  const projects = {
    activateDependents: async (id) => { calls.dependents.push(id); },
    checkCompletion: async (id) => { calls.completions.push(id); },
    suggestContextPromotions: async (e) => { calls.promotions.push(e.id); },
  };
  const missionsRoot = mkdtempSync(join(tmpdir(), 'missions-'));
  const usage = { summary: () => ({ calls: 3, input: 30, output: 3, cached: 0, cacheWrites: 0 }), drop: () => {} };
  const completion = createCompletion({
    store, memory, projects, artifacts, fireEvent: async (type, ctx) => { calls.events.push([type, ctx]); },
    addressFor, missionDir: missionDirIn(missionsRoot), usage, outgoingFiles, settings,
  });
  return { store, calls, completion, missionsRoot };
}

const mission = (over = {}) => ({
  id: 'w-1', type: 'M', parent_id: null, status: 'active', intent: 'decide', title: 'Quarterly report', instruction: 'Write the quarterly report',
  accept_criteria: 'The report exists', source_channel: 'dashboard', source_meta: { address: { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/T' }, responsibility_id: undefined },
  project_id: 'site', children: [], created_at: '2026-10-17T11:00:00.000Z', started_at: '2026-10-17T11:00:00.000Z', updated_at: '2026-10-17T11:00:00.000Z', iteration: 2,
  ...over,
});

test('the event a run\'s end fires: complete and failure only; a question is not an end', () => {
  assert.equal(completionEvent('complete'), 'on_complete');
  assert.equal(completionEvent('failed'), 'on_failure');
  assert.equal(completionEvent('blocked'), 'on_failure');
  assert.equal(completionEvent('needs_input'), null);
});

test('a completed mission: delivered to where the request came from, recorded, and its effects fired', async () => {
  const { store, calls, completion, missionsRoot } = setup();
  const env = mission();
  await store.save(env);
  assert.deepEqual(await completion.completeEnvelope(env, { status: 'complete', output: 'The report is ready.', historyDetail: 'Synthesized' }), { ok: true });
  const saved = await store.read('w-1');
  assert.equal(saved.status, 'complete');
  assert.equal(saved.completed_at, new Date(NOW).toISOString());
  assert.equal(saved.output, 'The report is ready.');
  assert.equal(saved.delivery_status, 'pending');
  assert.deepEqual(saved.delivery_address, { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/T' });
  assert.ok(existsSync(join(missionsRoot, 'w-1', 'missions', 'output.md')) === false, 'no mission tree, no record');
  assert.deepEqual(calls.lines, ['w-1']);
  assert.deepEqual(calls.lessons, ['w-1']);
  assert.deepEqual(calls.dependents, ['w-1']);
  assert.deepEqual(calls.completions, ['site']);
  assert.equal(calls.events[0][0], 'on_complete');
  const hist = await db.query(`${COLLECTIONS.work}/w-1`, 'history', [], { noOrderBy: true });
  assert.deepEqual(hist.map((h) => [h.prev_status, h.new_status, h.detail]), [['active', 'complete', 'Synthesized']]);
});

test('an empty synthesis becomes a summary composed from mission state, headed by the ending status', async () => {
  const { store, completion } = setup();
  const env = mission();
  await store.save(env);
  await completion.completeEnvelope(env, { status: 'blocked', output: '', blocker: 'No access to the drive', priorResults: [{ agent: 'motor', task: 'Open the drive', result: 'permission denied', success: false }] });
  const saved = await store.read('w-1');
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.blocker, 'No access to the drive');
  // Fixed defect: the summary was composed before the status changed, so it was headed "Active: ...".
  assert.match(saved.output, /^Blocked: Quarterly report\./);
  assert.match(saved.output, /Blocker: No access to the drive/);
});

test('a question is not an end: no event, no dependents, no cleanup, the mission tree kept', async () => {
  const cleaned = [];
  const { store, calls, completion } = setup({ artifacts: { publish: async () => null, cleanupWorkspace: async (id) => cleaned.push(id) } });
  const env = mission();
  await store.save(env);
  await completion.completeEnvelope(env, { status: 'needs_input', output: 'Which quarter?', skipArtifacts: true, skipMemory: true, skipCleanup: true });
  const saved = await store.read('w-1');
  assert.equal(saved.status, 'needs_input');
  assert.equal(saved.delivery_status, 'pending', 'the question goes to the person');
  assert.deepEqual([calls.events, calls.dependents, calls.lines, cleaned], [[], [], [], []]);
});

test('a scheduled mission is not delivered; its learnings feed the responsibility\'s next run', async () => {
  const { store, calls, completion } = setup({ settings: { learningsMaxEntries: 3 } });
  await db.write(`${COLLECTIONS.responsibilityState}/r-weekly`, { id: 'r-weekly', prior_learnings: '- [2026-10-01] one\n- [2026-10-08] two' });
  const env = mission({
    parent_id: 'w-req', source_meta: { responsibility_id: 'r-weekly' },
    _compaction: { seq: 1, durable_learnings: ['Use the shared template', 'Post by noon', 'a third, never fed'] },
  });
  await store.save(env);
  await completion.completeEnvelope(env, { status: 'complete', output: 'Weekly done.' });
  const saved = await store.read('w-1');
  assert.equal(saved.delivery_status, 'internal');
  assert.equal(calls.events[0][1].responsibility_id, 'r-weekly', 'an event responsibility never fires from its own mission');
  const overlay = await db.read(`${COLLECTIONS.responsibilityState}/r-weekly`);
  assert.equal(overlay.prior_learnings, '- [2026-10-08] two\n- [2026-10-17] Use the shared template\n- [2026-10-17] Post by noon');
});

test('an illegal ending is refused, and nothing is written', async () => {
  const { store, completion } = setup();
  const env = mission({ status: 'complete', completed_at: '2026-10-17T11:30:00.000Z', output: 'first' });
  await store.save(env);
  const r = await completion.completeEnvelope(env, { status: 'failed', output: 'second' });
  assert.equal(r.ok, false);
  assert.match(r.error, /terminal/);
  assert.equal((await store.read('w-1')).output, 'first');
});

test('a completed project mission writes its record into the mission tree and publishes its artifacts', async () => {
  const published = [];
  const artifacts = {
    publish: async (e) => { published.push(e.id); return { kind: 'artifact_manifest', repo: 'site', branch: 'main', commit: 'abcdef1234567', files: [{ path: 'report.md' }] }; },
    cleanupWorkspace: async () => {},
  };
  const { store, completion, missionsRoot } = setup({ artifacts });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(missionsRoot, 'w-1'), { recursive: true });
  const env = mission();
  await store.save(env);
  await completion.completeEnvelope(env, { status: 'complete', output: 'Report written.' });
  const saved = await store.read('w-1');
  assert.deepEqual(published, ['w-1']);
  assert.match(saved.output, /Report written\.\n\n📎 Artifacts: site@main abcdef12 — 1 file\(s\)/);
  assert.equal(saved.context.artifact_status, 'ok');
  assert.deepEqual(saved.context.mission_record, ['missions/output.md', 'missions/result.json']);
  assert.match(readFileSync(join(missionsRoot, 'w-1', 'missions', 'output.md'), 'utf8'), /Quarterly report/);
});

test('a failed publish degrades, it does not fail the completion', async () => {
  const { store, completion } = setup({ artifacts: { publish: async () => { throw new Error('push rejected'); }, cleanupWorkspace: async () => {} } });
  const env = mission();
  await store.save(env);
  assert.equal((await completion.completeEnvelope(env, { status: 'complete', output: 'ok' })).ok, true);
  assert.equal((await store.read('w-1')).context.artifact_status, 'degraded: push rejected');
});

test('the reply carries every file the mission handed back: its outgoing records, shared ones first', async () => {
  const artifacts = {
    publish: async (e) => {
      e.context = { ...(e.context || {}), attachments_export: [{ name: 'export.md', size: 4, gcsPath: 'files/out/w-1/export.md', contentType: 'text/markdown' }] };
      return null;
    },
    cleanupWorkspace: async () => {},
  };
  const asked = [];
  const outgoingFiles = async (id) => {
    asked.push(id);
    return [
      { id: 'out-w-1-export_md', direction: 'out', name: 'export.md', size: 5, gcs_path: 'files/out/w-1/export.md', source: 'artifact', created_at: '2026-10-17T11:59:00.000Z' },
      { id: 'out-w-1-report_docx', direction: 'out', name: 'report.docx', size: 900, gcs_path: 'files/out/w-1/report.docx', source: 'file-share', created_at: '2026-10-17T11:58:00.000Z' },
    ];
  };
  const { store, completion } = setup({ artifacts, outgoingFiles });
  const env = mission();
  await store.save(env);
  await completion.completeEnvelope(env, { status: 'complete', output: 'Done.' });
  assert.deepEqual(asked, ['w-1']);
  assert.deepEqual((await store.read('w-1')).context.attachments_export, [
    { name: 'report.docx', size: 900, gcsPath: 'files/out/w-1/report.docx' },
    { name: 'export.md', size: 5, gcsPath: 'files/out/w-1/export.md' },
  ]);
});

test('a mission that only shared files, with no project, still attaches them; a failed listing keeps what was exported', async () => {
  const shared = setup({ outgoingFiles: async () => [{ name: 'chart.png', size: 3, gcs_path: 'files/out/w-1/chart.png', source: 'file-share' }] });
  const env = mission({ project_id: null });
  await shared.store.save(env);
  await shared.completion.completeEnvelope(env, { status: 'needs_input', output: 'Is this chart right?' });
  assert.deepEqual((await shared.store.read('w-1')).context.attachments_export, [{ name: 'chart.png', size: 3, gcsPath: 'files/out/w-1/chart.png' }]);

  const logs = [];
  const store = createEnvelopeStore({ db, clock: () => NOW, defaultProjectId: () => 'general' });
  const completion = createCompletion({
    store, memory: { writeMissionLine: async () => {}, recordLessons: async () => {} }, addressFor,
    outgoingFiles: async () => { throw new Error('Firestore unavailable'); }, log: (level, msg) => logs.push(`${level} ${msg}`),
  });
  const kept = mission({ id: 'w-2', context: { attachments_export: [{ name: 'a.md', size: 1, gcsPath: 'files/out/w-2/a.md' }] } });
  await store.save(kept);
  assert.equal((await completion.completeEnvelope(kept, { status: 'complete', output: 'ok' })).ok, true);
  assert.deepEqual((await store.read('w-2')).context.attachments_export, [{ name: 'a.md', size: 1, gcsPath: 'files/out/w-2/a.md' }]);
  assert.ok(logs.some((l) => /WARN outgoing files of w-2 could not be listed/.test(l)));
});
