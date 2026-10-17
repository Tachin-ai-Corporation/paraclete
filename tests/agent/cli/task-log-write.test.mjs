// Tests for agent/cli/task-log-write.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/task-log-write.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const write = (argv, store) => run(main, argv, { runtime: fakeRuntime({ db: store }), now: () => NOW });

test('adds a delivery record to the envelope\'s history and changes nothing on the envelope', async () => {
  const db = fakeDb({ 'work/m-1': { type: 'M', status: 'complete', delivery_status: 'pending' } });
  const r = await write(['m-1', 'dashboard', 'delivered', '2026-10-17T11:59:00.000Z', '5200', '1234', 'external', "here's the report"], db);
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.deepEqual(db.docs.get('work/m-1'), { type: 'M', status: 'complete', delivery_status: 'pending' });
  assert.deepEqual(db.docs.get(`work/m-1/history/${NOW.getTime()}-delivery`), {
    seq: NOW.getTime(),
    prev_status: 'complete',
    new_status: 'complete',
    agent: 'task-log-write',
    timestamp: NOW.toISOString(),
    detail: "delivered via dashboard: 1234 chars in 5200 ms; here's the report",
    delivery: {
      status: 'delivered', channel: 'dashboard', classified: 'external', started_at: '2026-10-17T11:59:00.000Z',
      duration_ms: 5200, output_chars: 1234, error: null,
    },
  });
});

test('never fails the caller: a missing envelope, bad arguments or an outage are warnings', async () => {
  const db = fakeDb();
  let r = await write(['m-none', 'dashboard', 'error', '', 'x', '-3', 'unknown', '', 'boom'], db);
  assert.equal(r.code, 0);
  assert.match(r.err, /envelope m-none not found; nothing written/);
  assert.equal(db.docs.size, 0);
  r = await write([], db);
  assert.equal(r.code, 0);
  assert.match(r.err, /\[task-log-write\] WARN: Usage: task-log-write/);
  const down = fakeDb({ 'work/m-1': { status: 'complete' } });
  down.state.down = true;
  r = await write(['m-1', 'dashboard', 'timed_out'], down);
  assert.equal(r.code, 0);
  assert.match(r.err, /WARN: .*\(non-fatal\)/);
});
