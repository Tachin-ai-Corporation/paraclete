// Tests for agent/services/brain/actions/trigger-responsibility.mjs: running a scheduled
// responsibility now, at a person's request: only a triggerable one, at most once a turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTriggerResponsibility } from '../../../../../agent/services/brain/actions/trigger-responsibility.mjs';

function mockDeps(result = { ok: true }) {
  const fired = [];
  return {
    fired,
    deps: {
      log: () => {},
      responsibilities: {
        triggerable: () => [{ id: 'r-memory-consolidation', name: 'Nightly Memory Consolidation', purpose: 'p' }],
        fire: async (id, opts) => { fired.push({ id, opts }); return result; },
      },
    },
  };
}

test('an id outside the triggerable set is steered to planning, nothing fires', async () => {
  const { deps, fired } = mockDeps();
  const res = await handleTriggerResponsibility({ envelope: { id: 'm-1' }, decision: { responsibilityId: 'r-other' }, iteration: 2 }, deps);
  assert.match(res.priorResultsAppend[0].result, /triggerable set: r-memory-consolidation/);
  assert.equal(fired.length, 0);
});

test('a triggerable responsibility starts in the background and the cortex is steered to confirm', async () => {
  const { deps, fired } = mockDeps();
  const env = { id: 'm-1' };
  const res = await handleTriggerResponsibility({ envelope: env, decision: { responsibilityId: 'r-memory-consolidation' }, iteration: 2 }, deps);
  assert.deepEqual(fired, [{ id: 'r-memory-consolidation', opts: { bypassSpacing: true, source: 'agent' } }]);
  assert.match(res.priorResultsAppend[0].result, /has been started/);
  assert.deepEqual(res.activeGuard, { forbidden: 'trigger_responsibility', fallback: 'synthesize', injectedAt: 2 });
  const again = await handleTriggerResponsibility({ envelope: env, decision: { responsibilityId: 'r-memory-consolidation' }, iteration: 3 }, deps);
  assert.equal(fired.length, 1, 'never twice in a turn');
  assert.match(again.priorResultsAppend[0].result, /already started/);
});

test('a refused start is explained, never retried', async () => {
  const { deps } = mockDeps({ ok: false, skipped: true, error: 'a cycle is already in progress (w-9)' });
  const res = await handleTriggerResponsibility({ envelope: { id: 'm-1' }, decision: { responsibility_id: 'r-memory-consolidation' }, iteration: 2 }, deps);
  assert.match(res.priorResultsAppend[0].result, /Could not start 'Nightly Memory Consolidation': a cycle is already in progress \(w-9\) \(a cycle may already be running/);
  assert.equal(res.activeGuard.fallback, 'synthesize');
});
