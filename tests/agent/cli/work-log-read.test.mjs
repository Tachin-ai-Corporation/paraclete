// Tests for agent/cli/work-log-read.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/work-log-read.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const env = (over) => ({ status: 'complete', intent: 'task', created_at: '2026-10-17T10:00:00.000Z', ...over });

function work() {
  return fakeDb({
    'work/m-1': env({
      type: 'M', title: 'Build the report', instruction: 'Build the quarterly report', status: 'failed', error: 'checkpoint 2 failed',
      children: ['c-1', 'c-gone'], completed_at: '2026-10-17T10:05:30.000Z',
      step_ledger: {
        a: { status: 'complete', timestamp: '2026-10-17T10:01:00Z', durationMs: 1200 },
        b: { status: 'failed', timestamp: '2026-10-17T10:04:00Z', error: 'sheet not shared' },
      },
    }),
    'work/c-1': env({ type: 'C', title: 'Gather data', children: ['t-1'], created_at: '2026-10-17T10:01:00.000Z' }),
    'work/t-1': env({ type: 'T', title: 'Read the sheet', status: 'failed', error: 'permission denied', output: 'tried twice', created_at: '2026-10-17T10:02:00.000Z' }),
    'work/m-old': env({ type: 'M', title: 'Old mission', created_at: '2026-10-10T10:00:00.000Z' }),
  });
}

const read = (argv, db = work()) => run(main, argv, { runtime: fakeRuntime({ db }), now: () => NOW }).then((r) => ({ ...r, db }));

test('lists the window\'s envelopes newest first, with children and duration, and no owner column', async () => {
  const r = await read([]);
  assert.equal(r.code, 0, r.err);
  const rows = r.out.split('\n').filter((l) => /^[mct]-/.test(l));
  assert.deepEqual(rows.map((l) => l.split(/\s+/)[0]), ['t-1', 'c-1', 'm-1']);
  assert.match(r.out, /ID +TYPE STATUS +CHILDREN +DURATION +TITLE/);
  assert.doesNotMatch(r.out, /OWNER/);
  assert.match(rows[2], /^m-1 +M +❌ failed +2 +330s +Build the report$/);
  assert.match(r.out, /3 envelope\(s\) shown\.\n$/);
  assert.deepEqual(r.db.calls[0].filters, [{ field: 'created_at', op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-10-16T12:00:00.000Z' } }]);
  assert.equal(r.db.calls[0].collection, 'work');
});

test('one equality filter goes to Firestore with the window; with both, status is applied here', async () => {
  let r = await read(['--type', 'T', '--status', 'failed', '--verbose']);
  assert.deepEqual(r.db.calls[0].filters.map((f) => f.field), ['created_at', 'type']);
  assert.match(r.out, /t-1 .*Read the sheet\n {3}└─ Output: tried twice/);
  r = await read(['--status', 'complete']);
  assert.deepEqual(r.db.calls[0].filters.map((f) => f.field), ['created_at', 'status']);
  assert.match(r.out, /1 envelope\(s\) shown/);
});

test('--recent N means the last N missions over 30 days; --min-steps keeps envelopes with children', async () => {
  let r = await read(['--recent', '5', '--json']);
  const ids = JSON.parse(r.out).map((e) => e.id);
  assert.deepEqual(ids, ['m-1', 'm-old']);
  assert.equal(r.db.calls[0].opts.limit, 5);
  r = await read(['--min-steps', '2', '--json']);
  assert.deepEqual(JSON.parse(r.out).map((e) => e.id), ['m-1']);
});

test('--json trims instruction and output unless --verbose', async () => {
  const db = fakeDb({ 'work/m-1': env({ type: 'M', instruction: 'x'.repeat(250), output: 'y'.repeat(400) }) });
  let r = await read(['--json'], db);
  const [e] = JSON.parse(r.out);
  assert.equal(e.instruction, `${'x'.repeat(200)}...`);
  assert.equal(e.output, `${'y'.repeat(300)}...`);
  assert.equal(e.childCount, 0);
  r = await read(['--json', '--verbose'], db);
  assert.equal(JSON.parse(r.out)[0].output.length, 400);
});

test('--mission drills the tree, marks a missing child, and shows the step ledger', async () => {
  const r = await read(['--mission', 'm-1']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    '',
    'MISSION m-1  [failed]',
    '  Build the report',
    '  instruction: Build the quarterly report',
    '  error: checkpoint 2 failed',
    `  ${'─'.repeat(60)}`,
    '      [✅] C task :: Gather data',
    '          [❌] T task :: Read the sheet',
    '                error: permission denied',
    '      [  ] ?  :: ',
    '',
    '  STEP LEDGER — per-task attempts (richest failure detail):',
    '    [✅] complete  2026-10-17T10:01:00Z  (1200ms)',
    '    [❌] failed  2026-10-17T10:04:00Z',
    '        error: sheet not shared',
    '',
    '4 node(s) in mission tree.',
    '',
  ].join('\n'), 'a child that cannot be read is listed, not dropped');
  const missing = await read(['--mission', 'm-none']);
  assert.deepEqual([missing.code, missing.err], [1, 'Mission not found or inaccessible.\n']);
});

test('nothing in the window, an outage, and the options that selected other agents', async () => {
  let r = await read(['--hours', '0.01']);
  assert.equal(r.out, 'No work envelopes found matching criteria.\n');
  const db = work();
  db.state.down = true;
  r = await read([], db);
  assert.equal(r.code, 1);
  for (const gone of ['--owner', '--self']) {
    r = await read([gone, 'x']);
    assert.match(r.err, new RegExp(`Unknown option: ${gone}`));
  }
});
