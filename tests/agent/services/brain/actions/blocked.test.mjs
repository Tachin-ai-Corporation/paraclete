// Tests for agent/services/brain/actions/blocked.mjs: a blocked handback is honest. A finished mission
// is not blocked because a milestone verdict failed, and the handback always says what is in the way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBlocked, REAL_BLOCKER_TYPES } from '../../../../../agent/services/brain/actions/blocked.mjs';

function mockDeps() {
  const calls = { completions: [], saves: 0, logs: [] };
  return {
    calls,
    deps: {
      settings: { maxIterations: 50 },
      log: (level, msg) => calls.logs.push(msg),
      store: { save: async () => { calls.saves += 1; } },
      completeEnvelope: async (env, opts) => { calls.completions.push(opts); return { ok: true }; },
    },
  };
}

const ctx = (decision, priorResults = [], over = {}) => ({ envelope: { id: 'm-1', type: 'M', instruction: 'Send the report by email', ...over }, decision, priorResults, iteration: 3 });

test('a mission whose tasks all succeeded is not blocked by a milestone verdict: it is re-routed once to synthesize', async () => {
  const { deps, calls } = mockDeps();
  const c = ctx({ action: 'blocked', blocker: 'Delivered the two-page PDF to the folder.' }, [
    { agent: 'motor', success: true, result: 'PDF written' },
    { agent: 'cerebellum', checkpoint_step: '1.verify', step: '1.verify', success: false, result: '[CHECKPOINT VERIFICATION FAILED] layout' },
  ]);
  assert.deepEqual(await handleBlocked(c, deps), { nextAction: 'synthesize' });
  assert.equal(c.decision.synthesis, 'Delivered the two-page PDF to the folder.');
  assert.equal(c.envelope._blocked_mislabel_averted, true);
  assert.equal(calls.saves, 1);
  assert.deepEqual(await handleBlocked(c, deps), { exit: true }, 'once: a cortex that insists still ends');
});

test('a named outside obstacle is trusted', async () => {
  assert.ok(REAL_BLOCKER_TYPES.has('permission'));
  const { deps, calls } = mockDeps();
  await handleBlocked(ctx({ blocker: 'No access to the shared drive', blocker_type: 'permission', escalation_message: 'Please share the drive.' }, [{ agent: 'motor', success: true }]), deps);
  assert.deepEqual([calls.completions[0].status, calls.completions[0].blocker, calls.completions[0].blockerType, calls.completions[0].output],
    ['blocked', 'No access to the shared drive', 'permission', 'Please share the drive.']);
});

test('when the cortex says nothing, the failing task\'s own report says what is in the way', async () => {
  const { deps, calls } = mockDeps();
  const failing = 'Could not create the sheet.\n---\n[TOOL EXECUTION LOG]\n[TOOL] report_fail({"reasoning":"x","recommendation":"Give the motor a tool that creates Google Sheets"}) → recorded\n[END TOOL LOG]';
  await handleBlocked(ctx({ action: 'blocked' }, [{ agent: 'motor', step: '1.1', success: false, result: failing }]), deps);
  assert.equal(calls.completions[0].blocker, 'Give the motor a tool that creates Google Sheets');
  assert.match(calls.completions[0].output, /^Blocked \(step 1\.1, motor\): Give the motor a tool/);
});

test('a stop decided while planning, with nothing stated, says exactly that and what was asked', async () => {
  const { deps, calls } = mockDeps();
  await handleBlocked(ctx({ action: 'blocked' }, []), deps);
  assert.match(calls.completions[0].output, /Blocked before any work was dispatched[\s\S]*The request was: Send the report by email/);
  assert.match(calls.completions[0].blocker, /stopped while planning/);
  assert.equal(calls.completions[0].blockerType, 'other');
});
