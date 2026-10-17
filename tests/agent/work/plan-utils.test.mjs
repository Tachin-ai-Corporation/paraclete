// Tests for agent/work/plan-utils.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCheckpoints, enforceMissionParentInvariant } from '../../../agent/work/plan-utils.mjs';

const logger = () => {
  const lines = [];
  const log = (level, message) => lines.push({ level, message });
  return { log, lines };
};

describe('extractCheckpoints', () => {
  it('reads a structured plan', () => {
    const cps = extractCheckpoints({
      checkpoints: [{ instruction: 'Deploy service', tasks: [{ agent: 'motor', task: 'Run deploy script' }] }],
    });
    assert.equal(cps.length, 1);
    assert.equal(cps[0].tasks[0].agent, 'motor');
    assert.equal(cps[0].tasks[0].task, 'Run deploy script');
    assert.equal(cps[0].accept_criteria, '');
  });

  it('keeps every valid organ of an inline plan, in order', () => {
    const cps = extractCheckpoints({
      checkpoints: [{
        instruction: 'Checkpoint 1',
        tasks: [{ agent: 'motor', task: 'Run commands' }, { agent: 'temporal-research', task: 'Search web' }],
      }],
    });
    assert.deepEqual(cps[0].tasks.map((t) => t.agent), ['motor', 'temporal-research']);
  });

  it('finds the checkpoints under plan or checkpoint_plan', () => {
    const cp = { instruction: 'Do', tasks: [{ agent: 'motor', task: 'x' }] };
    assert.equal(extractCheckpoints({ plan: { checkpoints: [cp] } }).length, 1);
    assert.equal(extractCheckpoints({ checkpoint_plan: { checkpoints: [cp] } }).length, 1);
  });

  it('returns null when there is no plan', () => {
    assert.equal(extractCheckpoints({}), null);
    assert.equal(extractCheckpoints({ checkpoints: [] }), null);
    assert.equal(extractCheckpoints({ checkpoints: 'nope' }), null);
  });

  it('normalizes steps to tasks and finds task text under any key', () => {
    const cps = extractCheckpoints({
      checkpoints: [{
        title: 'Test',
        steps: [
          { agent: 'motor', task: 'Do thing' },
          { agent: 'motor', instruction: 'Do the next thing' },
          { agent: 'motor', description: 'Describe the last thing' },
        ],
      }],
    });
    assert.equal(cps[0].instruction, 'Test');
    assert.deepEqual(cps[0].tasks.map((t) => t.task), ['Do thing', 'Do the next thing', 'Describe the last thing']);
  });

  it('turns a non-string task into text', () => {
    const cps = extractCheckpoints({ checkpoints: [{ tasks: [{ agent: 'motor', task: { instruction: 'nested text' } }] }] });
    assert.equal(cps[0].tasks[0].task, 'nested text');
    assert.equal(cps[0].instruction, 'Checkpoint 1');
  });

  it('drops a task with no agent, with a warning, and a checkpoint left empty', () => {
    const { log, lines } = logger();
    const cps = extractCheckpoints({
      checkpoints: [
        { instruction: 'A', tasks: [{ task: 'no organ' }, { agent: 'motor', task: 'ok' }] },
        { instruction: 'B', tasks: [{ type: 'handoff', task: 'no organ either' }] },
      ],
    }, log);
    assert.equal(cps.length, 1, 'the checkpoint with no dispatchable task is dropped');
    assert.deepEqual(cps[0].tasks.map((t) => t.task), ['ok']);
    assert.equal(lines.filter((l) => l.level === 'WARN').length, 2);
    assert.match(lines[0].message, /Checkpoint 1: skipping task without agent field/);
  });

  it('wraps a flat array of tasks in one checkpoint, normalized like any other', () => {
    const cps = extractCheckpoints({
      goal: 'Ship it',
      checkpoints: [{ agent: 'motor', instruction: 'Build' }, { agent: 'motor', task: 'Deploy' }, { task: 'orphan' }],
    });
    assert.equal(cps.length, 1);
    assert.equal(cps[0].instruction, 'Ship it');
    assert.deepEqual(cps[0].tasks.map((t) => t.task), ['Build', 'Deploy'], 'task text set and the agentless task dropped');
  });

  it('skips a null checkpoint or task instead of throwing', () => {
    // Fixed defect: a null entry in a model's plan was dereferenced and crashed the planning step.
    const { log } = logger();
    const cps = extractCheckpoints({
      checkpoints: [null, { instruction: 'Real', tasks: [null, { agent: 'motor', task: 'work' }] }],
    }, log);
    assert.equal(cps.length, 1);
    assert.equal(cps[0].instruction, 'Real');
    assert.deepEqual(cps[0].tasks.map((t) => t.task), ['work']);
  });
});

// Missions never nest. The guard used to demote every parented mission, so a routine-fired mission
// (parented to its request envelope) rendered as a checkpoint under a checkpoint.
describe('enforceMissionParentInvariant', () => {
  it('demotes a parented mission with no responsibility origin to a checkpoint', () => {
    const env = { id: 'w1', type: 'M', parent_id: 'p1', source_meta: {} };
    assert.equal(enforceMissionParentInvariant(env), true);
    assert.equal(env.type, 'C');
    assert.equal(env.delivery_status, 'internal');
  });

  it('exempts a mission a responsibility fired (R → M), which keeps type M', () => {
    const env = {
      id: 'w2', type: 'M', parent_id: 'r-routine',
      source_meta: { responsibility_id: 'resp-nightly-memory' },
    };
    assert.equal(enforceMissionParentInvariant(env), false);
    assert.equal(env.type, 'M');
    assert.equal(env.delivery_status, undefined, 'untouched (delivery is gated on parent_id elsewhere)');
  });

  it('leaves a top-level mission alone', () => {
    const env = { id: 'w3', type: 'M', parent_id: null, source_meta: {} };
    assert.equal(enforceMissionParentInvariant(env), false);
    assert.equal(env.type, 'M');
  });

  it('ignores other envelope types (a checkpoint under a mission is normal)', () => {
    const env = { id: 'w4', type: 'C', parent_id: 'm1' };
    assert.equal(enforceMissionParentInvariant(env), false);
    assert.equal(env.type, 'C');
  });

  it('handles null or missing source_meta without throwing', () => {
    const nullMeta = { id: 'w5', type: 'M', parent_id: 'x', source_meta: null };
    assert.equal(enforceMissionParentInvariant(nullMeta), true);
    assert.equal(nullMeta.type, 'C');

    const noMeta = { id: 'w6', type: 'M', parent_id: 'x' };
    assert.equal(enforceMissionParentInvariant(noMeta), true);
    assert.equal(noMeta.type, 'C');
  });

  it('is a no-op on null or garbage input', () => {
    assert.equal(enforceMissionParentInvariant(null), false);
    assert.equal(enforceMissionParentInvariant(undefined), false);
    assert.equal(enforceMissionParentInvariant({}), false);
  });
});
