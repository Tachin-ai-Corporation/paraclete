// Tests for dashboard/lib/server/approvals.mjs, against the Firestore fake. The gates are raised with
// the agent's own code (buildApprovalRecord and the checker's create, agent/work/approvals.mjs), and a
// decision made here is then read by the agent's own approvals poller (createApprovalChecker) against
// the same fake: the dashboard and the agent must agree on the document, not just on a test double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { buildApprovalRecord, createApprovalChecker } from '../../../../agent/work/approvals.mjs';
import { firestoreEncode, StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { route, readBody } from '../../../../dashboard/lib/server/http.mjs';
import {
  countPending, listApprovals, resolveApproval, REASON_MAX_CHARS,
} from '../../../../dashboard/lib/server/approvals.mjs';

const T0 = '2027-01-15T08:00:00.000Z';
const NOW = new Date('2027-01-15T08:05:00.000Z');
const MEMBER = { email: 'member@example.com', role: 'member' };
const ADMIN = { email: 'admin@example.com', role: 'admin' };

/** A mission paused at its gate, as the checkpoint executor leaves it. */
const pausedMission = (id, approvalId, over = {}) => ({
  id,
  type: 'M',
  parent_id: null,
  status: 'awaiting_approval',
  intent: 'decide',
  title: 'Publish the quarterly report',
  instruction: 'Draft the quarterly report and publish it',
  accept_criteria: null,
  source_channel: 'dashboard',
  source_meta: {
    address: { channel: 'dashboard', thread: 'th-1' },
    sender: 'member@example.com',
    paused_approval_id: approvalId,
    paused_checkpoint_index: 1,
    paused_task_index: 0,
    paused_checkpoints: [{ instruction: 'Draft' }, { instruction: 'Publish', tasks: [{ agent: 'motor', task: 'Approve', step_type: 'approval_gate' }] }],
    paused_all_results: [],
  },
  _cp_spine: [{ n: 1, status: 'complete' }, { n: 2, status: 'pending' }],
  children: [],
  created_at: T0,
  updated_at: T0,
  iteration: 0,
  ...over,
});

/**
 * A dashboard runtime with one paused mission and its gate, raised by the agent's own code, plus the
 * agent's approvals poller over the same Firestore.
 */
async function gatedWorld(t, { missionOver = {}, approvalId = 'apr-1' } = {}) {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const mission = pausedMission('w-m1', approvalId, missionOver);
  await runtime.db.write(`work/${mission.id}`, mission);

  const resumed = [];
  const history = [];
  const checker = createApprovalChecker({
    db: runtime.db,
    firestoreRead: (collection, id) => runtime.db.read(`${collection}/${id}`),
    firestoreWrite: (collection, id, data) => runtime.db.write(`${collection}/${id}`, data),
    writeHistory: async (...args) => { history.push(args); },
    recallMemory: async () => null,
    resumeCheckpointPlan: async (envelope, memory, approval) => { resumed.push({ envelope, approval }); },
    logger: () => {},
    checkEvery: 1,
    clock: () => NOW.getTime() + 60_000,
  });
  const record = buildApprovalRecord({
    envelope: mission,
    checkpointId: 'w-c2',
    checkpointIndex: 1,
    taskIndex: 0,
    title: 'Approve publishing the report',
    description: 'If approved, this runs next: Publish the report to the shared drive.',
    projectName: 'General',
    requestedBy: 'member@example.com',
    now: T0,
  });
  assert.equal(await checker.create(approvalId, record), true);
  return { dash, runtime, mission, record, checker, resumed, history };
}

test('a pending gate is listed and counted, and once a member approves it the agent resumes the mission', async (t) => {
  const { dash, runtime, record, checker, resumed } = await gatedWorld(t);

  const before = await listApprovals(runtime);
  assert.equal(before.pending.length, 1);
  assert.deepEqual(before.resolved, []);
  const [gate] = before.pending;
  assert.equal(gate.id, 'apr-1');
  assert.equal(gate.live, true);
  assert.equal(gate.stale_reason, null);
  assert.equal(gate.title, 'Approve publishing the report');
  assert.equal(gate.description, 'If approved, this runs next: Publish the report to the shared drive.');
  assert.equal(gate.requested_by, 'member@example.com');
  assert.equal(gate.requested_at, T0);
  assert.equal(gate.checkpoint, 2);
  assert.equal(gate.project, 'General');
  assert.deepEqual(gate.mission, { id: 'w-m1', title: 'Publish the quarterly report', status: 'awaiting_approval' });
  assert.deepEqual(await countPending(runtime), { pending: 1 });

  const decided = await resolveApproval(runtime, { id: 'apr-1', decision: 'approved', user: MEMBER, now: NOW });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.resolved_by, 'member@example.com');
  assert.equal(decided.resolved_at, NOW.toISOString());

  // Only the resolution's fields were written, through a field mask; everything the agent wrote,
  // `_processed: false` above all, is as it was.
  assert.deepEqual(await dash.doc('approvals/apr-1'), {
    ...record, status: 'approved', resolvedBy: 'member@example.com', resolvedAt: NOW.toISOString(),
  });
  // A PATCH without a mask is the agent's own whole-document write that raised the gate.
  const patches = dash.firestore.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith('/approvals/apr-1') && r.query.includes('updateMask'));
  assert.equal(patches.length, 1);
  assert.deepEqual(new URLSearchParams(patches[0].query).getAll('updateMask.fieldPaths').sort(), ['resolvedAt', 'resolvedBy', 'status']);

  // The agent's own poller, on the same documents, acts on it.
  await checker.checkPending();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].envelope.id, 'w-m1');
  assert.equal(resumed[0].approval.status, 'approved');
  assert.equal(resumed[0].approval.resolvedBy, 'member@example.com');
  assert.equal((await dash.doc('approvals/apr-1'))._processed, true);

  assert.deepEqual(await countPending(runtime), { pending: 0 });
  const after = await listApprovals(runtime);
  assert.deepEqual(after.pending, []);
  assert.equal(after.resolved.length, 1);
  assert.equal(after.resolved[0].resolved_by, 'member@example.com');
  assert.equal(after.resolved[0].acted_on, true);
});

test('a rejection with a reason stops the mission, and the agent records the reason as its error', async (t) => {
  const { dash, runtime, checker, resumed, history } = await gatedWorld(t);
  await resolveApproval(runtime, { id: 'apr-1', decision: 'rejected', reason: '  Not before the board has seen the numbers.  ', user: ADMIN, now: NOW });

  const stored = await dash.doc('approvals/apr-1');
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.resolvedBy, 'admin@example.com');
  assert.equal(stored.reason, 'Not before the board has seen the numbers.');
  assert.equal(stored._processed, false);

  await checker.checkPending();
  assert.equal(resumed.length, 0);
  const mission = await dash.doc('work/w-m1');
  assert.equal(mission.status, 'rejected');
  assert.equal(mission.error, 'Not before the board has seen the numbers.');
  assert.match(mission.output, /Rejected at the approval gate .* by admin@example\.com/);
  assert.deepEqual(history.map(([id, from, to]) => [id, from, to]), [['w-m1', 'awaiting_approval', 'rejected']]);

  const { resolved } = await listApprovals(runtime);
  assert.equal(resolved[0].reason, 'Not before the board has seen the numbers.');
});

test('an approval is decided once: a second decision is refused, saying who decided it', async (t) => {
  const { dash, runtime } = await gatedWorld(t);
  await resolveApproval(runtime, { id: 'apr-1', decision: 'approved', user: MEMBER, now: NOW });
  const decided = await dash.doc('approvals/apr-1');
  await assert.rejects(
    resolveApproval(runtime, { id: 'apr-1', decision: 'rejected', user: ADMIN }),
    (err) => err.status === 409 && /already approved by member@example\.com/.test(err.message),
  );
  assert.deepEqual(await dash.doc('approvals/apr-1'), decided);
});

test('two people deciding at the same moment: the second is told, and the first decision stands', async (t) => {
  const { dash, runtime } = await gatedWorld(t);
  // Someone else's decision lands between this one's read and its write.
  const theirs = { status: 'rejected', resolvedAt: '2027-01-15T08:05:00.001Z', resolvedBy: 'other@example.com' };
  let raced = false;
  const racing = {
    ...runtime,
    db: {
      ...runtime.db,
      async readDoc(path) {
        const read = await runtime.db.readDoc(path);
        if (!raced && path === 'approvals/apr-1') {
          raced = true;
          await runtime.db.patch(path, Object.keys(theirs), firestoreEncode(theirs), { strict: true });
        }
        return read;
      },
    },
  };
  await assert.rejects(
    resolveApproval(racing, { id: 'apr-1', decision: 'approved', user: MEMBER, now: NOW }),
    (err) => err.status === 409 && /changed while you were deciding: it is now rejected by other@example\.com/.test(err.message),
  );
  const stored = await dash.doc('approvals/apr-1');
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.resolvedBy, 'other@example.com');
});

test('a gate whose mission moved on is shown as stale, is not counted, and cannot be decided', async (t) => {
  const { dash, runtime, record } = await gatedWorld(t, { missionOver: { status: 'cancelled', cancelled_at: T0 } });
  const { pending } = await listApprovals(runtime);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].live, false);
  assert.match(pending[0].stale_reason, /its mission is cancelled and no longer waiting for it/);
  assert.deepEqual(await countPending(runtime), { pending: 0 });
  await assert.rejects(
    resolveApproval(runtime, { id: 'apr-1', decision: 'approved', user: MEMBER }),
    (err) => err.status === 409 && /can no longer be decided: its mission is cancelled/.test(err.message),
  );
  assert.deepEqual(await dash.doc('approvals/apr-1'), record);
});

test('a gate is stale when its mission is gone or paused at a later gate', async (t) => {
  const later = await gatedWorld(t, { missionOver: { source_meta: { paused_approval_id: 'apr-2' } } });
  await assert.rejects(
    resolveApproval(later.runtime, { id: 'apr-1', decision: 'approved', user: MEMBER }),
    (err) => err.status === 409 && /waiting on a later approval/.test(err.message),
  );

  const gone = await gatedWorld(t);
  await gone.runtime.db.del('work/w-m1', { strict: true });
  assert.deepEqual(await countPending(gone.runtime), { pending: 0 });
  await assert.rejects(
    resolveApproval(gone.runtime, { id: 'apr-1', decision: 'approved', user: MEMBER }),
    (err) => err.status === 409 && /no longer exists/.test(err.message),
  );
});

test('refusals: an unknown gate, a decision that is not one, a malformed id, a reason that is not text', async (t) => {
  const { runtime } = await gatedWorld(t);
  await assert.rejects(resolveApproval(runtime, { id: 'apr-404', decision: 'approved', user: MEMBER }), (err) => err.status === 404);
  await assert.rejects(resolveApproval(runtime, { id: 'apr-1', decision: 'maybe', user: MEMBER }), (err) => err.status === 400);
  await assert.rejects(resolveApproval(runtime, { id: '../users/x', decision: 'approved', user: MEMBER }), (err) => err.status === 400);
  await assert.rejects(resolveApproval(runtime, { id: 'apr-1', decision: 'rejected', reason: { why: 1 }, user: MEMBER }), (err) => err.status === 400);
  assert.equal((await listApprovals(runtime)).pending[0].status, 'pending');
});

test('a long reason is cut to the limit; an empty one is not stored', async (t) => {
  const { dash, runtime } = await gatedWorld(t);
  await resolveApproval(runtime, { id: 'apr-1', decision: 'approved', reason: '   ', user: MEMBER, now: NOW });
  assert.equal('reason' in (await dash.doc('approvals/apr-1')), false);

  const other = await gatedWorld(t);
  await resolveApproval(other.runtime, { id: 'apr-1', decision: 'rejected', reason: 'x'.repeat(REASON_MAX_CHARS + 50), user: MEMBER, now: NOW });
  assert.equal((await other.dash.doc('approvals/apr-1')).reason.length, REASON_MAX_CHARS);
});

test('any dashboard user may decide, through the route: a member approves', async (t) => {
  const dash = await startDashboard({ env: { PARACLETE_DEV_USER: 'member@example.com' } });
  t.after(dash.stop);
  const { runtime } = dash;
  await dash.seed({ 'users/member@example.com': { email: 'member@example.com', role: 'member' } });
  const mission = pausedMission('w-m1', 'apr-1');
  await runtime.db.write('work/w-m1', mission);
  await runtime.db.write('approvals/apr-1', buildApprovalRecord({ envelope: mission, title: 'Approve', description: 'd', now: T0 }));

  // The same body as app/api/approvals/[id]/route.js.
  const handler = route(async ({ request, params, user, runtime: rt }) => {
    const { decision, reason } = await readBody(request);
    return resolveApproval(rt, { id: params.id, decision, reason, user });
  }, { runtime: () => runtime });
  const response = await handler(new Request('http://dashboard.test/api/approvals/apr-1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' }),
  }), { params: Promise.resolve({ id: 'apr-1' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'approved');
  assert.equal(body.resolved_by, 'member@example.com');
  assert.equal((await dash.doc('approvals/apr-1')).resolvedBy, 'member@example.com');
});

test('recent decisions come newest first, and pending gates that can be decided come before stale ones', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  const at = (minute) => `2027-01-15T08:${String(minute).padStart(2, '0')}:00.000Z`;
  await dash.seed({
    'work/w-live': pausedMission('w-live', 'apr-live'),
    'work/w-old': pausedMission('w-old', 'apr-old', { status: 'complete', completed_at: at(9) }),
    'approvals/apr-live': { envelopeId: 'w-live', title: 'Live', description: 'd', requestedBy: '', requestedAt: at(1), status: 'pending', _processed: false },
    'approvals/apr-old': { envelopeId: 'w-old', title: 'Stale', description: 'd', requestedBy: '', requestedAt: at(5), status: 'pending', _processed: false },
    'approvals/apr-a': { envelopeId: 'w-a', title: 'A', description: 'd', requestedBy: '', requestedAt: at(2), status: 'approved', resolvedBy: 'a@example.com', resolvedAt: at(30), _processed: true },
    'approvals/apr-b': { envelopeId: 'w-b', title: 'B', description: 'd', requestedBy: '', requestedAt: at(3), status: 'rejected', resolvedBy: 'b@example.com', resolvedAt: at(20), reason: 'no', _processed: false },
  });
  const { pending, resolved } = await listApprovals(runtime);
  assert.deepEqual(pending.map((a) => [a.id, a.live]), [['apr-live', true], ['apr-old', false]]);
  assert.deepEqual(resolved.map((a) => [a.id, a.status, a.acted_on]), [['apr-a', 'approved', true], ['apr-b', 'rejected', false]]);
});

test('a database that cannot answer is a 503, never an empty list', async () => {
  const failing = {
    collections: { approvals: 'approvals', work: 'work' },
    log: () => {},
    db: {
      async query() { throw new StoreUnavailable('query', 'approvals', 500, 'backend down'); },
      async read() { throw new StoreUnavailable('read', 'approvals/apr-1', 500, 'backend down'); },
      async readDoc() { throw new StoreUnavailable('read', 'approvals/apr-1', 500, 'backend down'); },
    },
  };
  await assert.rejects(listApprovals(failing), (err) => err.status === 503);
  await assert.rejects(countPending(failing), (err) => err.status === 503);
  await assert.rejects(resolveApproval(failing, { id: 'apr-1', decision: 'approved', user: MEMBER }), (err) => err.status === 503);
});
