// Tests for agent/work/approvals.mjs: an approval gate asks the right question, records who asked
// and who answered, and its answer resumes or fails exactly the mission it paused.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApprovalRecord, approvalResolution, createApprovalChecker, scopeApprovalsToConversation,
  describeApprovalGate,
} from '../../../agent/work/approvals.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const T0 = '2026-10-17T10:00:00.000Z';
const USER = 'user@example.com';

// ── Fakes ─────────────────────────────────────────────────────────────

const plain = (v) => v.stringValue ?? v.booleanValue ?? v.integerValue;

/**
 * The approvals collection in memory, with the real query's paging: EQUAL and IN filters, a missing
 * field never matches, document-name order under noOrderBy, and the limit.
 */
function fakeApprovalsDb(approvals = {}) {
  const docs = new Map(Object.entries(approvals).map(([id, a]) => [`${COLLECTIONS.approvals}/${id}`, { ...a }]));
  const queries = [];
  return {
    docs,
    queries,
    async write(path, data) { docs.set(path, structuredClone(data)); return {}; },
    async patch(path, mask, fields) {
      const doc = docs.get(path) || {};
      for (const f of mask) doc[f] = plain(fields[f]);
      docs.set(path, doc);
      return {};
    },
    async query(parent, collection, filters, opts = {}) {
      queries.push({ parent, collection, filters, opts });
      return [...docs.entries()]
        .filter(([path]) => path.startsWith(`${collection}/`))
        .map(([path, d]) => ({ id: path.split('/').pop(), ...d }))
        .filter((d) => filters.every((f) => {
          if (!(f.field in d)) return false;
          if (f.op === 'EQUAL') return d[f.field] === plain(f.value);
          if (f.op === 'IN') return f.value.arrayValue.values.map(plain).includes(d[f.field]);
          throw new Error(`fake query: unsupported op ${f.op}`);
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, opts.limit || 300);
    },
  };
}

const pausedMission = (over = {}) => ({
  id: 'w-m1', type: 'M', parent_id: null, status: 'awaiting_approval', instruction: 'Publish the weekly briefing',
  _cp_spine: [{ status: 'complete' }, { status: 'pending' }],
  source_meta: { paused_checkpoint_index: 1, paused_task_index: 0 },
  ...over,
});

/** A checker over `approvals`, with one or more paused missions in the work collection. */
function world(approvals, envelopes = pausedMission(), overrides = {}) {
  const db = fakeApprovalsDb(approvals);
  const missions = new Map([envelopes].flat().map((envelope) => [envelope.id, envelope]));
  const resumed = [];
  const writes = [];
  const history = [];
  const checker = createApprovalChecker({
    db,
    firestoreRead: async (col, id) => (col === COLLECTIONS.work && missions.has(id) ? structuredClone(missions.get(id)) : null),
    firestoreWrite: async (col, id, doc) => { writes.push({ col, id, doc: structuredClone(doc) }); },
    writeHistory: async (...args) => { history.push(args); },
    recallMemory: async () => ({ recalled: true }),
    resumeCheckpointPlan: async (env, memory, approval) => { resumed.push({ id: env.id, memory, approval }); },
    logger: () => {},
    clock: () => Date.parse(T0),
    ...overrides,
  });
  const poll = async () => { for (let i = 0; i < 5; i++) await checker.checkPending(); };
  return { db, checker, resumed, writes, history, poll };
}

const resolved = (status, over = {}) => ({
  envelopeId: 'w-m1', status, _processed: false, resolvedBy: USER, resolvedAt: T0, ...over,
});

// ── Creating a gate ───────────────────────────────────────────────────

describe('buildApprovalRecord and create', () => {
  it('records the gate, who asked, and the conversation it came from', () => {
    const record = buildApprovalRecord({
      envelope: { id: 'w-m1', project_id: 'general', source_channel: 'dashboard', source_meta: { address: { channel: 'dashboard', thread: 'th-1' } } },
      checkpointId: 'w-c2', checkpointIndex: 1, taskIndex: 0,
      title: 'Approve the publish', description: 'If approved, this runs next: Publish.',
      projectName: 'General', requestedBy: USER, now: T0,
    });
    assert.deepEqual(record, {
      envelopeId: 'w-m1', checkpointId: 'w-c2', checkpointIndex: 1, taskIndex: 0,
      title: 'Approve the publish', description: 'If approved, this runs next: Publish.',
      projectName: 'General', project_id: 'general', source_channel: 'dashboard', source_thread: 'th-1',
      requestedBy: USER, requestedAt: T0, status: 'pending', _processed: false,
    });
  });

  it('clips the title and tolerates a mission with no address or project', () => {
    const record = buildApprovalRecord({ envelope: { id: 'w-m1' }, title: 'x'.repeat(500), description: 'd', now: T0 });
    assert.equal(record.title.length, 200);
    assert.equal(record.source_thread, '');
    assert.equal(record.project_id, '');
    assert.equal(record.requestedBy, '', 'scheduled work has no requester');
  });

  it('writes the record to the approvals collection', async () => {
    const { db, checker } = world({});
    const record = buildApprovalRecord({ envelope: { id: 'w-m1' }, title: 't', description: 'd', now: T0 });
    assert.equal(await checker.create('apr-1', record), true);
    assert.equal(db.docs.get(`${COLLECTIONS.approvals}/apr-1`).status, 'pending');
  });
});

describe('approvalResolution', () => {
  it('returns the fields a resolver patches, with who resolved it', () => {
    assert.deepEqual(approvalResolution({ decision: 'approved', resolvedBy: USER, now: T0 }),
      { status: 'approved', resolvedAt: T0, resolvedBy: USER });
    assert.deepEqual(approvalResolution({ decision: 'rejected', resolvedBy: USER, reason: 'Not this week.', now: T0 }),
      { status: 'rejected', resolvedAt: T0, resolvedBy: USER, reason: 'Not this week.' });
  });

  it('refuses a resolution that does not say who made it, or an unknown decision', () => {
    assert.throws(() => approvalResolution({ decision: 'approved' }), /resolvedBy is required/);
    assert.throws(() => approvalResolution({ decision: 'maybe', resolvedBy: USER }), /approved or rejected/);
  });
});

// ── The poller ────────────────────────────────────────────────────────

describe('checkPending', () => {
  it('acts only on every fifth call', async () => {
    const w = world({ 'apr-1': resolved('approved') });
    for (let i = 0; i < 4; i++) await w.checker.checkPending();
    assert.equal(w.db.queries.length, 0);
    await w.checker.checkPending();
    assert.equal(w.db.queries.length, 1);
    assert.equal(w.db.queries[0].parent, '', 'the approvals collection sits at the database root');
  });

  it('an approval resumes the plan once, after marking it processed', async () => {
    const w = world({ 'apr-1': resolved('approved') });
    await w.poll();
    assert.deepEqual(w.resumed.map((r) => r.id), ['w-m1']);
    assert.deepEqual(w.resumed[0].memory, { recalled: true });
    assert.equal(w.resumed[0].approval.resolvedBy, USER, 'the resume knows who approved');
    assert.equal(w.db.docs.get(`${COLLECTIONS.approvals}/apr-1`)._processed, true);
    await w.poll();
    assert.equal(w.resumed.length, 1, 'a processed approval is never resumed again');
  });

  it('a rejection ends the mission as rejected, records who rejected it, and tells the person', async () => {
    const w = world({ 'apr-1': resolved('rejected', { reason: 'Wrong week.' }) });
    await w.poll();
    assert.deepEqual(w.resumed, []);
    const failed = w.writes.find((x) => x.id === 'w-m1').doc;
    assert.equal(failed.status, 'rejected', 'awaiting_approval moves to rejected, the legal ending for a rejection');
    assert.equal(failed.error, 'Wrong week.');
    assert.match(failed.output, /Rejected at the approval gate \(approval apr-1\) by user@example\.com/);
    assert.equal(failed.delivery_status, 'pending', 'a top-level mission is delivered');
    assert.equal(failed.completed_at, T0);
    assert.deepEqual(w.history[0], ['w-m1', 'awaiting_approval', 'rejected', 'brain', `Approval rejected by ${USER}`]);
  });

  it('a rejected mission fired by a responsibility ends without a delivery of its own', async () => {
    const w = world({ 'apr-1': resolved('rejected') }, pausedMission({ parent_id: 'w-r1' }));
    await w.poll();
    const failed = w.writes.find((x) => x.id === 'w-m1').doc;
    assert.equal(failed.status, 'rejected');
    assert.equal(failed.error, `Approval rejected by ${USER}`);
    assert.equal('delivery_status' in failed, false);
  });

  it('a rejection never waits on resume state (it once left such a mission paused forever)', async () => {
    const w = world({ 'apr-1': resolved('rejected') }, pausedMission({ _cp_spine: [], source_meta: {} }));
    await w.poll();
    assert.equal(w.writes.find((x) => x.id === 'w-m1')?.doc.status, 'rejected');
  });

  it('an approval with no paused plan fails loudly instead of stranding the mission', async () => {
    const w = world({ 'apr-1': resolved('approved') }, pausedMission({ _cp_spine: [], source_meta: {} }));
    await w.poll();
    assert.deepEqual(w.resumed, []);
    const failed = w.writes.find((x) => x.id === 'w-m1').doc;
    assert.equal(failed.status, 'failed', 'an approved mission that cannot continue goes back to active, then fails');
    assert.ok(failed.started_at, 'the move through active is a real transition');
    assert.match(failed.error, /no paused plan/);
    assert.equal(w.db.docs.get(`${COLLECTIONS.approvals}/apr-1`)._processed, true);
  });

  it('a resume that throws fails the mission instead of leaving it paused, and the poll goes on', async () => {
    const resumedIds = [];
    const w = world(
      { 'apr-1': resolved('approved'), 'apr-2': resolved('approved', { envelopeId: 'w-m2' }) },
      [pausedMission(), pausedMission({ id: 'w-m2' })],
      {
        resumeCheckpointPlan: async (env) => {
          if (env.id === 'w-m1') throw new Error('plan store unreachable');
          resumedIds.push(env.id);
        },
      },
    );
    await w.poll();
    const failed = w.writes.find((x) => x.id === 'w-m1').doc;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /resume after approval failed: plan store unreachable/);
    assert.deepEqual(resumedIds, ['w-m2'], 'the next approval in the same poll still resumes');
  });

  it('an approval whose mission moved on is spent without touching the mission', async () => {
    const w = world({ 'apr-1': resolved('approved') }, pausedMission({ status: 'cancelled' }));
    await w.poll();
    assert.deepEqual(w.resumed, []);
    assert.deepEqual(w.writes, []);
    assert.equal(w.db.docs.get(`${COLLECTIONS.approvals}/apr-1`)._processed, true);
  });

  it('leaves pending approvals alone', async () => {
    const w = world({ 'apr-1': { envelopeId: 'w-m1', status: 'pending', _processed: false } });
    await w.poll();
    assert.deepEqual(w.resumed, []);
    assert.equal(w.db.docs.get(`${COLLECTIONS.approvals}/apr-1`)._processed, false);
  });

  it('a new approval is found however many resolved ones came before it', async () => {
    // Resolved approvals keep their status for good. The poller once queried by status alone, in
    // document-name order, with a window of 100: after 100 resolved gates the window held only spent
    // approvals, and a newly approved mission never resumed.
    const history = {};
    for (let i = 0; i < 150; i++) {
      history[`apr-${String(1000 + i)}`] = resolved('approved', { envelopeId: `w-old-${i}`, _processed: true });
    }
    history['apr-9999'] = resolved('approved');
    const w = world(history);
    await w.poll();
    assert.deepEqual(w.resumed.map((r) => r.id), ['w-m1']);
  });

  it('a store failure is logged and the next poll tries again', async () => {
    const w = world({ 'apr-1': resolved('approved') });
    const realQuery = w.db.query;
    w.db.query = async () => { throw new Error('HTTP 503'); };
    await w.poll();
    assert.deepEqual(w.resumed, []);
    w.db.query = realQuery;
    await w.poll();
    assert.deepEqual(w.resumed.map((r) => r.id), ['w-m1']);
  });
});

describe('createApprovalChecker', () => {
  it('refuses to start without a store or a way to resume, which would strand approved missions', () => {
    assert.throws(() => createApprovalChecker({ resumeCheckpointPlan: async () => {} }), /db is required/);
    assert.throws(() => createApprovalChecker({ db: fakeApprovalsDb() }), /resumeCheckpointPlan is required/);
  });
});

describe('startPolling and stopPolling', () => {
  it('starts one interval and stops it', () => {
    const { checker } = world({});
    checker.startPolling(60_000);
    checker.startPolling(60_000);
    checker.stopPolling();
    checker.stopPolling();
  });
});

// ── Which gates a chat reply resolves ─────────────────────────────────

describe('scopeApprovalsToConversation', () => {
  const A = (id, o = {}) => ({ id, source_thread: o.thread, project_id: o.project, source_channel: o.channel });

  it('the reply\'s thread wins: two gates in different conversations, keep the reply\'s own', () => {
    const pending = [A('here', { thread: 'th-1', channel: 'dashboard' }), A('elsewhere', { thread: 'th-2', channel: 'dashboard' })];
    const scoped = scopeApprovalsToConversation(pending, { thread: 'th-1', channel: 'dashboard' });
    assert.deepEqual(scoped.map((a) => a.id), ['here']);
  });

  it('the project refines when the reply carries no thread', () => {
    const pending = [A('p1', { project: 'acme-www' }), A('p2', { project: 'other-site' })];
    assert.deepEqual(scopeApprovalsToConversation(pending, { projectId: 'acme-www' }).map((a) => a.id), ['p1']);
  });

  it('never strands: a discriminator that matches none of the gates is skipped', () => {
    const pending = [A('g1', { channel: 'dashboard' }), A('g2', { channel: 'dashboard' })];
    const scoped = scopeApprovalsToConversation(pending, { thread: 'th-9', channel: 'dashboard' });
    assert.deepEqual(scoped.map((a) => a.id), ['g1', 'g2']);
  });

  it('a single pending gate is returned as is', () => {
    const scoped = scopeApprovalsToConversation([A('only', { thread: 'th-2' })], { thread: 'th-1' });
    assert.deepEqual(scoped.map((a) => a.id), ['only']);
  });

  it('empty or non-array input gives []', () => {
    assert.deepEqual(scopeApprovalsToConversation([], { thread: 'th-1' }), []);
    assert.deepEqual(scopeApprovalsToConversation(null), []);
    assert.deepEqual(scopeApprovalsToConversation(undefined, {}), []);
  });
});

// ── The gate's description ────────────────────────────────────────────

describe('describeApprovalGate', () => {
  it('says what runs once approved, in order', () => {
    const d = describeApprovalGate({ next: ['Trash today\'s earlier doc, then create the briefing.', 'Read it back.'] });
    assert.equal(d, 'If approved, this runs next: Trash today\'s earlier doc, then create the briefing. Then: Read it back.');
  });

  it('an explicit approval message wins', () => {
    assert.equal(describeApprovalGate({ message: 'Promote the site to production.', next: ['x'] }), 'Promote the site to production.');
  });

  it('a gate with nothing after it says so instead of going blank', () => {
    assert.match(describeApprovalGate({ next: [] }), /finishes and reports/);
    assert.match(describeApprovalGate(), /finishes and reports/);
  });

  it('is clipped, and marked when it is', () => {
    const d = describeApprovalGate({ next: ['y'.repeat(5000)], maxChars: 200 });
    assert.equal(d.length, 200);
    assert.ok(d.endsWith('…'));
  });
});
