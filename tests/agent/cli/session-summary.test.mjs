// Tests for agent/cli/session-summary.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/session-summary.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00Z');

const mission = (id, over = {}) => [`work/${id}`, {
  type: 'M', status: 'complete', intent: 'task', title: `Mission ${id}`, instruction: `Do ${id}`, output: `Did ${id}`,
  created_at: '2026-10-17T08:00:00.000Z', completed_at: '2026-10-17T09:00:00.000Z', ...over,
}];

const summarize = (argv, db) => run(main, argv, { runtime: fakeRuntime({ db }), now: () => NOW });

test('summarizes the missions completed in the window, newest first, with their digests', async () => {
  const db = fakeDb(Object.fromEntries([
    mission('m-early', { completed_at: '2026-10-17T07:00:00.000Z' }),
    mission('m-late', {
      completed_at: '2026-10-17T11:00:00.000Z',
      _compaction: { seq: 2, covered: '1-14', durable_learnings: ['Exports need the finance role'] },
    }),
    mission('m-chat', { intent: 'respond', title: '', instruction: 'hello there', output: 'x'.repeat(150) }),
    mission('m-stale', { completed_at: '2026-10-15T09:00:00.000Z' }),
    mission('m-running', { status: 'active', completed_at: null }),
    ['work/t-1', { type: 'T', status: 'complete', created_at: '2026-10-17T08:00:00.000Z', completed_at: '2026-10-17T10:00:00.000Z' }],
  ]));
  const r = await summarize([], db);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    '--- Mission 1: Mission m-late ---',
    '  Completed: 2026-10-17T11:00:00.000Z',
    '  Request: Do m-late',
    '  Result: Did m-late',
    '  Digest: compaction seq 2, iterations 1-14',
    '    - learning: Exports need the finance role',
    '',
    '--- Mission 2: [chat] hello there ---',
    '  Completed: 2026-10-17T09:00:00.000Z',
    '  Request: hello there',
    `  Result: ${'x'.repeat(100)}`,
    '',
    '--- Mission 3: Mission m-early ---',
    '  Completed: 2026-10-17T07:00:00.000Z',
    '  Request: Do m-early',
    '  Result: Did m-early',
    '',
    '--- 3 completed missions in the last 24 hours ---',
    '',
  ].join('\n'));
});

test('recent work is found however many older complete missions there are', async () => {
  // Asking for "complete missions, limit 20" with no order returned an arbitrary twenty, often the
  // oldest, so the last day's work went missing from consolidation.
  const older = Array.from({ length: 40 }, (_, i) => mission(`m-old-${i}`, {
    created_at: `2026-10-1${i % 5}T00:00:00.000Z`, completed_at: '2026-10-14T00:00:00.000Z',
  }));
  const db = fakeDb(Object.fromEntries([...older, mission('zz-new', { created_at: '2026-10-17T10:00:00.000Z', completed_at: '2026-10-17T10:30:00.000Z' })]));
  const r = await summarize(['--limit', '20'], db);
  assert.match(r.out, /Mission zz-new/);
  assert.deepEqual(db.calls[0].filters, [{ field: 'type', op: 'EQUAL', value: { stringValue: 'M' } }]);
  assert.equal(db.calls[0].opts.orderDirection, 'DESCENDING');
});

test('--exclude-intent, --hours and --limit narrow the summary', async () => {
  const db = fakeDb(Object.fromEntries([
    mission('m-1', { intent: 'memory_consolidation' }),
    mission('m-2', { completed_at: '2026-10-17T10:00:00.000Z' }),
    mission('m-3', { completed_at: '2026-10-17T11:00:00.000Z' }),
  ]));
  let r = await summarize(['--exclude-intent', 'memory_consolidation', '--limit', '1'], db);
  assert.match(r.out, /Mission 1: Mission m-3/);
  assert.match(r.out, /--- 1 completed missions in the last 24 hours ---/);
  r = await summarize(['--hours', '0.5'], db);
  assert.equal(r.out, 'No recent completed missions found.\n');
});

test('an outage is an error, not a quiet day', async () => {
  const db = fakeDb();
  db.state.down = true;
  const r = await summarize([], db);
  assert.equal(r.code, 1);
  assert.match(r.err, /This is an outage, not a quiet day/);
});
