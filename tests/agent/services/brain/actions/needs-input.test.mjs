// Tests for agent/services/brain/actions/needs-input.mjs: the mission stops to ask a question, keeping
// its tree and its memory line for the real end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleNeedsInput } from '../../../../../agent/services/brain/actions/needs-input.mjs';

test('the question goes out and the mission keeps what it needs to resume', async () => {
  const calls = [];
  const deps = { completeEnvelope: async (env, opts) => { calls.push(opts); return { ok: true }; } };
  assert.deepEqual(await handleNeedsInput({ envelope: { id: 'm-1' }, decision: { question: 'Which quarter?', what_is_needed: 'the quarter' } }, deps), { exit: true });
  assert.deepEqual(calls[0], {
    status: 'needs_input', output: 'Which quarter?', historyDetail: 'Needs: the quarter',
    skipArtifacts: true, skipMemory: true, skipCleanup: true,
  });
  await handleNeedsInput({ envelope: { id: 'm-1' }, decision: {} }, deps);
  assert.equal(calls[1].output, 'I need more information to proceed.');
});
