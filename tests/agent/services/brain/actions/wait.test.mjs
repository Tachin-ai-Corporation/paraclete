// Tests for agent/services/brain/actions/wait.mjs: a bounded pause with a resume time and a next step,
// and the notice a person gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWait, waitMinutes } from '../../../../../agent/services/brain/actions/wait.mjs';

const BOUNDS = { minMinutes: 1, maxMinutes: 1440, defaultMinutes: 5 };
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

test('the wait is the cortex\'s minutes, clamped to the bounds, the default when absent', () => {
  assert.equal(waitMinutes({ minutes: 10 }, BOUNDS), 10);
  assert.equal(waitMinutes({ wait_minutes: '30' }, BOUNDS), 30);
  assert.equal(waitMinutes({}, BOUNDS), 5);
  assert.equal(waitMinutes({ minutes: 'soon' }, BOUNDS), 5);
  assert.equal(waitMinutes({ minutes: 0 }, BOUNDS), 1);
  assert.equal(waitMinutes({ minutes: 100000 }, BOUNDS), 1440);
});

function mockDeps() {
  const calls = { statuses: [], writes: [] };
  return {
    calls,
    deps: {
      settings: { wait: BOUNDS },
      clock: () => NOW,
      addressFor: () => ({ channel: 'dashboard', thread: 'th-1' }),
      store: {
        newId: () => 'w-notice',
        iso: () => new Date(NOW).toISOString(),
        setStatus: async (env, to, detail, opts) => { calls.statuses.push({ to, detail, event: opts.event }); env.status = to; },
        firestoreWrite: async (collection, id, data) => { calls.writes.push({ collection, id, data }); },
      },
    },
  };
}

test('a top-level mission pauses with its resume time and next step, and the person is told', async () => {
  const { deps, calls } = mockDeps();
  const env = { id: 'm-1', parent_id: null, source_channel: 'dashboard', source_meta: { address: { channel: 'dashboard', thread: 'th-1' }, paused_task_index: 2 } };
  assert.deepEqual(await handleWait({ envelope: env, decision: { minutes: 10, reason: 'deploy settling', then: 'Check health' } }, deps), { exit: true });
  assert.deepEqual(calls.statuses[0].event, { resumeAt: '2026-10-17T12:10:00.000Z', resumeInstruction: 'Check health' });
  assert.match(calls.statuses[0].detail, /^Waiting 10m \(until 12:10Z\): deploy settling/);
  const notice = calls.writes[0].data;
  assert.equal(calls.writes[0].collection, 'work');
  assert.deepEqual([notice.type, notice.parent_id, notice.delivery_status, notice.source_meta.notification_type], ['T', 'm-1', 'pending', 'wait']);
  assert.equal(notice.source_meta.paused_task_index, undefined);
  assert.match(notice.output, /Pausing for 10 minutes — deploy settling/);
});

test('a scheduled mission pauses quietly', async () => {
  const { deps, calls } = mockDeps();
  await handleWait({ envelope: { id: 'm-2', parent_id: 'w-req' }, decision: {} }, deps);
  assert.equal(calls.statuses[0].event.resumeInstruction, 'Continue the mission');
  assert.equal(calls.writes.length, 0);
});
