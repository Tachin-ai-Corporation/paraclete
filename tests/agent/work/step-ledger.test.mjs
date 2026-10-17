// Tests for agent/work/step-ledger.mjs. The pathology prevented: a resumed mission ran a finished task
// a second time, and a failed milestone's tasks were replayed as stubs instead of re-run, so the
// verifier judged the same work wrong forever.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveStepKey, completedStep, recordStep, clearCheckpointSteps,
} from '../../../agent/work/step-ledger.mjs';

describe('deriveStepKey', () => {
  it('is stable for the same step, and 16 hex characters', () => {
    const a = deriveStepKey('w-m1', 1, 'cp_task', '0.0.motor', 2);
    assert.equal(a, deriveStepKey('w-m1', 1, 'cp_task', '0.0.motor', 2));
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('differs by mission, checkpoint, position, organ and iteration', () => {
    const base = deriveStepKey('w-m1', 1, 'cp_task', '0.0.motor', 2);
    assert.notEqual(base, deriveStepKey('w-m2', 1, 'cp_task', '0.0.motor', 2));
    assert.notEqual(base, deriveStepKey('w-m1', 2, 'cp_task', '0.0.motor', 2));
    assert.notEqual(base, deriveStepKey('w-m1', 1, 'cp_task', '0.1.motor', 2));
    assert.notEqual(base, deriveStepKey('w-m1', 1, 'cp_task', '0.0.temporal-memory', 2));
    assert.notEqual(base, deriveStepKey('w-m1', 1, 'cp_task', '0.0.motor', 3), 'a new iteration (a re-plan) runs again');
  });

  it('leaves out an empty iteration', () => {
    assert.equal(deriveStepKey('w-m1', 1, 'cp_task', 't', 0), deriveStepKey('w-m1', 1, 'cp_task', 't'));
  });
});

describe('recordStep / completedStep', () => {
  it('records a success as complete, with its checkpoint and the task envelope that holds the output', () => {
    const ledger = recordStep(undefined, 'k1', { success: true, durationMs: 1200, cp: 2, ref: 'w-t9' }, 'T1');
    assert.deepEqual(ledger.k1, { status: 'complete', error: null, durationMs: 1200, timestamp: 'T1', cp: 2, ref: 'w-t9' });
    assert.equal(completedStep(ledger, 'k1').ref, 'w-t9');
  });

  it('a failed step is not complete, so it runs again', () => {
    const ledger = recordStep({}, 'k1', { success: false, error: 'boom', cp: 1 }, 'T1');
    assert.equal(ledger.k1.status, 'failed');
    assert.equal(completedStep(ledger, 'k1'), null);
  });

  it('does not mutate the input, and tolerates a missing ledger', () => {
    const before = { k0: { status: 'complete', cp: 1 } };
    const after = recordStep(before, 'k1', { success: true }, 'T');
    assert.equal('k1' in before, false);
    assert.ok(after.k0 && after.k1);
    assert.equal(completedStep(null, 'k1'), null);
    assert.equal(completedStep({}, 'missing'), null);
  });
});

describe('clearCheckpointSteps', () => {
  it('drops exactly the entries of one checkpoint', () => {
    const ledger = { a: { status: 'complete', cp: 1 }, b: { status: 'complete', cp: 2 }, c: { status: 'failed', cp: 2 }, d: { status: 'complete' } };
    const { ledger: next, cleared } = clearCheckpointSteps(ledger, 2);
    assert.equal(cleared, 2);
    assert.deepEqual(Object.keys(next).sort(), ['a', 'd']);
    assert.ok(ledger.b, 'input untouched');
  });

  it('is a no-op on an empty ledger', () => {
    assert.deepEqual(clearCheckpointSteps(undefined, 1), { ledger: {}, cleared: 0 });
  });
});
