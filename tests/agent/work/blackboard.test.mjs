// Tests for agent/work/blackboard.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBlackboard } from '../../../agent/work/blackboard.mjs';

const mission = {
  id: 'w-1700000000000-0a1b2c3d',
  instruction: 'Produce the weekly briefing as a Google Doc.',
  accept_criteria: 'The doc exists and every section has content.',
};

describe('renderBlackboard', () => {
  it('lays out goal, criteria, results and failures in that order', () => {
    const doc = renderBlackboard(mission, [
      { agent: 'motor', checkpoint_step: '1.1', summary: 'Saved four transcripts.', ref: 'w-task-1', success: true },
      { agent: 'motor', step: '2.1', result: 'The doc could not be created.', success: false },
    ], { iteration: 3 });
    const order = ['# Mission Blackboard — w-1700000000000-0a1b2c3d', '## Goal', '## Acceptance Criteria',
      '## Results & Decisions (chronological)', '## Open / Failures'].map((h) => doc.indexOf(h));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `sections in order: ${order}`);
    assert.match(doc, /- \*\*\[1\.1\] motor\*\*: Saved four transcripts\. _\(ref: w-task-1\)_/);
    assert.match(doc, /- \*\*\[2\.1\] motor\*\* ❌ FAILED: The doc could not be created\./);
    assert.match(doc, /## Open \/ Failures\n- \[2\.1\] motor: The doc could not be created\./);
    assert.match(doc, /iteration 3_$/);
  });

  it('says so when there is nothing yet, and omits criteria that were never set', () => {
    const doc = renderBlackboard({ id: 'w-2', goal: 'Answer a question' });
    assert.match(doc, /## Goal\nAnswer a question/);
    assert.ok(!doc.includes('## Acceptance Criteria'));
    assert.match(doc, /_\(none yet\)_/);
    assert.match(doc, /## Open \/ Failures\n_\(none\)_/);
  });

  it('clips each row and states the cut', () => {
    const doc = renderBlackboard(mission, [{ agent: 'motor', step: '1.1', result: 'x'.repeat(1000) }], { perRow: 50 });
    assert.match(doc, /x{50} …\[\+950 chars\]/);
  });

  it('bounds the whole document, keeping the head', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ agent: 'motor', step: `1.${i}`, result: 'y'.repeat(300) }));
    const doc = renderBlackboard(mission, many, { maxChars: 2000 });
    assert.ok(doc.startsWith('# Mission Blackboard'));
    assert.match(doc, /…\[blackboard truncated to 2000 chars\]$/);
    assert.ok(doc.length < 2100);
  });

  it('skips a missing row instead of failing the whole render', () => {
    // Fixed defect: one null row in the results threw and lost the blackboard for the iteration.
    const doc = renderBlackboard(mission, [null, { agent: 'motor', step: '1.1', result: 'ok' }, undefined]);
    assert.match(doc, /\[1\.1\] motor\*\*: ok/);
    assert.equal(renderBlackboard(null, null).includes('# Mission Blackboard — unknown'), true);
  });
});
