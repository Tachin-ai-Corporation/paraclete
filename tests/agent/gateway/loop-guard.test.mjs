// Tests for agent/gateway/loop-guard.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, DEFAULT_LOOP_GUARD } from '../../../agent/gateway/loop-guard.mjs';

const run = (guard, calls) => calls.map(([name, args, result]) => guard.check(name, args, result).action);

describe('LoopGuard', () => {
  it('warns on the second byte-identical result and stops on the third', () => {
    const g = new LoopGuard();
    assert.deepEqual(run(g, [
      ['search', { q: 'x' }, '{"files":[],"count":0}'],
      ['search', { q: 'x' }, '{"files":[],"count":0}'],
      ['search', { q: 'x' }, '{"files":[],"count":0}'],
    ]), ['ok', 'nudge', 'terminate']);
    assert.equal(g.terminated, true);
  });

  it('leaves a repeat whose result changes (polling) to the looser duplicate bound', () => {
    const g = new LoopGuard();
    assert.deepEqual(run(g, [
      ['status', { id: 1 }, 'pending 1'],
      ['status', { id: 1 }, 'pending 2'],
      ['status', { id: 1 }, 'pending 3'],
      ['status', { id: 1 }, 'pending 4'],
    ]), ['ok', 'ok', 'nudge', 'terminate']);
  });

  it('warns after five consecutive errors and stops after eight; a success resets the run', () => {
    const g = new LoopGuard();
    const errors = Array.from({ length: 8 }, (_, i) => ['cmd', { n: i }, 'ERROR: nope']);
    const actions = run(g, errors);
    assert.equal(actions[4], 'nudge');
    assert.equal(actions[7], 'terminate');

    const h = new LoopGuard();
    run(h, errors.slice(0, 4));
    h.check('cmd', { n: 'ok' }, 'fine');
    assert.equal(h.consecutiveErrors, 0);
  });

  it('stops a tool called many times with varying arguments', () => {
    const g = new LoopGuard();
    const actions = run(g, Array.from({ length: 16 }, (_, i) => ['search', { q: i }, `result ${i}`]));
    assert.equal(actions[7], 'nudge');
    assert.equal(actions[15], 'terminate');
    assert.match(g.check('search', { q: 'z' }, 'r').action, /terminate/);
  });

  it('takes thresholds, ignoring invalid ones', () => {
    const g = new LoopGuard({ identicalTerminate: 2, duplicateNudge: 0, unknown: 1 });
    assert.equal(g.limits.identicalTerminate, 2);
    assert.equal(g.limits.duplicateNudge, DEFAULT_LOOP_GUARD.duplicateNudge);
    assert.deepEqual(run(g, [['a', {}, 'same'], ['a', {}, 'same']]), ['ok', 'terminate']);
  });

  it('reports a stuck report with the tool and its arguments', () => {
    const g = new LoopGuard();
    const [, , last] = [g.check('a', { k: 1 }, 'r'), g.check('a', { k: 1 }, 'r'), g.check('a', { k: 1 }, 'r')];
    assert.match(last.message, /\[STUCK REPORT\] \{"stuck_tool":"a","stuck_args":"\{\\"k\\":1\}"/);
    assert.deepEqual(g.getMetrics(), { totalCalls: 3, uniqueSignatures: 1, duplicateCalls: 3, consecutiveErrors: 0, terminated: true });
  });
});
