// Tests for agent/context/history.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryWriter } from '../../../agent/context/history.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

function setup(times) {
  const writes = [];
  const clock = [...times];
  const history = createHistoryWriter({
    firestoreWrite: async (collection, id, data) => writes.push({ collection, id, data }),
    now: () => clock.shift(),
  });
  return { history, writes };
}

const T = Date.parse('2026-10-17T10:00:00Z');

test("writes a transition into the envelope's history subcollection", async () => {
  const { history, writes } = setup([T]);
  await history.write('m-1', 'queued', 'active', 'brain', 'Picked up');
  assert.deepEqual(writes, [{
    collection: `${COLLECTIONS.work}/m-1/history`,
    id: `${T}-0`,
    data: {
      seq: T,
      prev_status: 'queued',
      new_status: 'active',
      agent: 'brain',
      timestamp: '2026-10-17T10:00:00.000Z',
      detail: 'Picked up',
    },
  }]);
});

test('ids stay unique and ordered within one millisecond', async () => {
  const { history, writes } = setup([T, T, T + 1]);
  await history.write('m-1', null, 'queued', 'brain', 'a');
  await history.write('m-1', 'queued', 'active', 'brain', 'b');
  await history.write('m-1', 'active', 'complete', 'brain', 'c');
  assert.deepEqual(writes.map((w) => w.id), [`${T}-0`, `${T}-1`, `${T + 1}-0`]);
});

test('a clock that steps backwards never reuses an id', async () => {
  const { history, writes } = setup([T + 5, T, T + 5]);
  await history.write('m-1', null, 'queued', 'brain', 'a');
  await history.write('m-1', 'queued', 'active', 'brain', 'b');
  await history.write('m-1', 'active', 'complete', 'brain', 'c');
  const ids = writes.map((w) => w.id);
  assert.deepEqual(ids, [`${T + 5}-0`, `${T + 5}-1`, `${T + 5}-2`]);
});

test('a logical key is the id, so a replayed transition overwrites its record', async () => {
  const { history, writes } = setup([T, T + 1000]);
  await history.write('m-1', 'active', 'waiting', 'brain', 'Waiting', 'wait-1');
  await history.write('m-1', 'active', 'waiting', 'brain', 'Waiting', 'wait-1');
  assert.deepEqual(writes.map((w) => w.id), ['wait-1', 'wait-1']);
});

test('cuts the detail to 1000 characters and tolerates none', async () => {
  const { history, writes } = setup([T, T + 1]);
  await history.write('m-1', null, 'queued', 'brain', 'x'.repeat(5000));
  await history.write('m-1', 'queued', 'active', 'brain');
  assert.equal(writes[0].data.detail.length, 1000);
  assert.equal(writes[1].data.detail, '');
});
