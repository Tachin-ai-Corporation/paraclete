// Tests for agent/services/brain/actions/status-update.mjs: a progress note for the mouth, recorded so
// the next decision does not send it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleStatusUpdate } from '../../../../../agent/services/brain/actions/status-update.mjs';

test('a status update is written for the mouth and recorded in the turn\'s results', async () => {
  const sent = [];
  const deps = { log: () => {}, writeStatusUpdate: async (id, message) => sent.push([id, message]) };
  const res = await handleStatusUpdate({ envelope: { id: 'm-1' }, decision: { message: 'Halfway there.' } }, deps);
  assert.deepEqual(sent, [['m-1', 'Halfway there.']]);
  assert.equal(res.continue, true);
  assert.match(res.priorResultsAppend[0].result, /Status update sent to the person: "Halfway there\."\. Do not send it again/);
  await handleStatusUpdate({ envelope: { id: 'm-1' }, decision: {} }, deps);
  assert.equal(sent[1][1], 'Working on it...');
});
