// Tests for agent/cli/task-log-read.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/task-log-read.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const task = (n, over = {}) => ({
  type: 'T', parent_id: 'c-1', status: 'complete', intent: 'execute', title: `Task ${n}`,
  created_at: `2026-10-17T10:0${n}:00.000Z`, started_at: `2026-10-17T10:0${n}:00.000Z`, completed_at: `2026-10-17T10:0${n}:30.000Z`,
  output: 'x'.repeat(n * 10), ...over,
});

const db = () => fakeDb({
  'work/t-1': task(1),
  'work/t-2': task(2),
  'work/t-3': task(3, { status: 'failed', error: 'timed out', completed_at: null, output: null }),
  'work/m-1': { type: 'M', status: 'active', created_at: '2026-10-17T10:09:00.000Z' },
  'work/t-1/history/1-0': { seq: 1, prev_status: null, new_status: 'queued', agent: 'brain' },
  'work/t-1/history/2-0': { seq: 2, prev_status: 'queued', new_status: 'complete', agent: 'brain' },
});

const read = (argv, store = db()) => run(main, argv, { runtime: fakeRuntime({ db: store }) });

test('lists the last N tasks, newest first, as JSON records', async () => {
  const r = await read(['--last', '2']);
  assert.equal(r.code, 0, r.err);
  const records = JSON.parse(r.out);
  assert.deepEqual(records.map((t) => t.taskId), ['t-3', 't-2']);
  assert.deepEqual(records[1], {
    taskId: 't-2', type: 'T', parentId: 'c-1', status: 'complete', intent: 'execute', text: 'Task 2',
    startedAt: '2026-10-17T10:02:00.000Z', completedAt: '2026-10-17T10:02:30.000Z', durationMs: 30_000, outputChars: 20, error: null,
  });
  assert.equal(records[0].error, 'timed out');
});

test('--task reads one envelope with its history in order', async () => {
  const r = await read(['--task', 't-1']);
  const [record] = JSON.parse(r.out);
  assert.equal(record.taskId, 't-1');
  assert.deepEqual(record.history.map((h) => h.new_status), ['queued', 'complete']);
  assert.equal((await read(['--task', 't-none'])).out, '[]\n');
});

test('an outage is an error, and --agent is gone', async () => {
  const down = db();
  down.state.down = true;
  let r = await read([], down);
  assert.equal(r.code, 1);
  assert.match(r.err, /\[task-log-read\] ERROR: the work records could not be read/);
  r = await read(['--agent', 'x']);
  assert.match(r.err, /\[task-log-read\] ERROR: Unknown arg: --agent/);
});
