// Tests for agent/work/finalization.mjs. The pathology prevented: every task of a mission
// succeeded and a complete flyer PDF existed, but one checkpoint's milestone verdict failed and the
// mission ended `blocked`, its own success summary in the blocker field. A milestone verdict judges
// a checkpoint, not the deliverable; on its own it must never make finished work look failed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMilestoneVerdict, isWorkRow, isRealTaskFailure, isRealTaskSuccess,
  deliverableStandsDespiteMilestone, articulateBlocker, renderCaveatSection,
} from '../../../agent/work/finalization.mjs';
import { extractFailRecommendation } from '../../../agent/work/verdict.mjs';

// Rows as the checkpoint executor pushes them.
const taskOK       = { step: '1.1', agent: 'motor', success: true };
const taskOK2      = { step: '1.2', agent: 'motor', success: true };
const taskFail     = { step: '2.1', agent: 'motor', success: false, error: 'wrong arg' };
const taskTimeout  = { step: '2.2', agent: 'motor', success: false, timedOut: true };
const verifyFail   = { step: '1.verify', agent: 'cerebellum', success: false };
const verifyInconc = { step: '1.verify', agent: 'cerebellum', success: false, inconclusive: true };
const sysNudge     = { agent: 'system', result: '[SYSTEM] Synthesize blocked: ...' };

describe('isMilestoneVerdict', () => {
  it('is true only for a *.verify pseudo-step', () => {
    assert.equal(isMilestoneVerdict(verifyFail), true);
    assert.equal(isMilestoneVerdict(taskOK), false);
    assert.equal(isMilestoneVerdict(sysNudge), false);
    assert.equal(isMilestoneVerdict({ step: 'noverify' }), false);
    assert.equal(isMilestoneVerdict(null), false);
  });
});

describe('isWorkRow', () => {
  it('excludes system, human, and milestone-verdict rows', () => {
    assert.equal(isWorkRow(taskOK), true);
    assert.equal(isWorkRow(verifyFail), false);
    assert.equal(isWorkRow(sysNudge), false);
    assert.equal(isWorkRow({ agent: 'human', success: true }), false);
    assert.equal(isWorkRow(null), false);
  });
});

describe('isRealTaskFailure', () => {
  it('is true for a hard-failed task', () => {
    assert.equal(isRealTaskFailure(taskFail), true);
  });
  it('is false for milestone-verdict, inconclusive and timed-out rows', () => {
    assert.equal(isRealTaskFailure(verifyFail), false, 'a verdict is not failed work');
    assert.equal(isRealTaskFailure(verifyInconc), false, 'could not see it is not wrong');
    assert.equal(isRealTaskFailure(taskTimeout), false, 'unknown is not wrong');
    assert.equal(isRealTaskFailure(taskOK), false);
  });
});

describe('isRealTaskSuccess', () => {
  it('is true only for a real task that succeeded', () => {
    assert.equal(isRealTaskSuccess(taskOK), true);
    assert.equal(isRealTaskSuccess(taskFail), false);
    assert.equal(isRealTaskSuccess({ step: '1.verify', agent: 'cerebellum', success: true }), false,
      'a *.verify PASS is a verdict about work, not work');
  });
});

describe('deliverableStandsDespiteMilestone', () => {
  it('true for the flyer case: tasks all succeeded, only the milestone verdict failed', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, taskOK2, verifyFail]), true);
  });
  it('true when an inconclusive verdict sits over succeeded tasks', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, verifyInconc]), true);
  });
  it('true when a timed-out (outcome unknown) row sits beside a real success', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, taskTimeout]), true);
  });
  it('false when any real task hard-failed: a genuine failure must still own the outcome', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, taskFail, verifyFail]), false);
  });
  it('false when no real task succeeded (nothing was actually delivered)', () => {
    assert.equal(deliverableStandsDespiteMilestone([verifyFail]), false);
    assert.equal(deliverableStandsDespiteMilestone([sysNudge]), false);
    assert.equal(deliverableStandsDespiteMilestone([]), false);
    assert.equal(deliverableStandsDespiteMilestone(null), false);
  });
});

// A mission asked to create a Google Sheet tried three commands, read its own skill instructions,
// and concluded correctly that no tool creates a spreadsheet. Its report_fail said so. The mission
// then ended `blocked` with "Unknown blocker": the diagnosis was produced and discarded.
describe('articulateBlocker', () => {
  const failRow = (rec) => ({
    step: '1.2', agent: 'motor', success: false,
    result: `[TOOL] report_fail({"checks":[],"recommendation":"${rec}"}) → ok`,
  });

  it("recovers the failing task's own recommendation", () => {
    const r = articulateBlocker([failRow('Provide a tool that creates Google Sheets')], extractFailRecommendation);
    assert.equal(r.detail, 'Provide a tool that creates Google Sheets');
    assert.equal(r.step, '1.2');
    assert.equal(r.agent, 'motor');
  });

  it('takes the last failure, because a re-plan supersedes earlier attempts', () => {
    const r = articulateBlocker([failRow('first thing tried'), failRow('what is actually missing')], extractFailRecommendation);
    assert.equal(r.detail, 'what is actually missing');
  });

  it('falls back to the first substantive line when there is no report_fail', () => {
    const r = articulateBlocker(
      [{ step: '1.1', agent: 'motor', success: false, result: '[FAILED]\n\n---\nThe calendar API rejected the token as expired.' }],
      extractFailRecommendation,
    );
    // The [FAILED] marker and the rule are structure; the sentence is the reason.
    assert.equal(r.detail, 'The calendar API rejected the token as expired.');
  });

  it('returns null rather than inventing when there is nothing to say', () => {
    assert.equal(articulateBlocker([], extractFailRecommendation), null);
    assert.equal(articulateBlocker(null, extractFailRecommendation), null);
    assert.equal(
      articulateBlocker([{ step: '1.1', agent: 'motor', success: false, result: '[FAILED]' }], extractFailRecommendation),
      null,
      'a bare marker is not an explanation: the caller must say so, not paper over it',
    );
  });

  it('ignores milestone verdicts and inconclusive rows, like every other predicate here', () => {
    const milestone = { step: '1.verify', agent: 'cerebellum', success: false, result: 'FAIL: could not see the artifact' };
    const inconclusive = { step: '1.1', agent: 'motor', success: false, inconclusive: true, result: 'no verdict returned at all' };
    assert.equal(articulateBlocker([milestone], extractFailRecommendation), null);
    assert.equal(articulateBlocker([inconclusive], extractFailRecommendation), null);
  });

  it('caps the detail so a blocker field cannot become a transcript', () => {
    const r = articulateBlocker(
      [{ step: '1.1', agent: 'motor', success: false, result: `x${'y'.repeat(2000)}` }],
      extractFailRecommendation,
    );
    assert.ok(r.detail.length <= 601, `detail was ${r.detail.length} chars`);
    assert.ok(r.detail.endsWith('…'));
  });

  it('survives a malformed tool log instead of losing the row', () => {
    const r = articulateBlocker(
      [{ step: '1.1', agent: 'motor', success: false, result: '[TOOL] report_fail({"recommendation": → broken\nThe sheet could not be created.' }],
      extractFailRecommendation,
    );
    assert.ok(r && r.detail.length > 0, 'a broken log degrades to the text, not to null');
  });

  it('survives an extractor that throws', () => {
    const r = articulateBlocker(
      [{ step: '1.1', agent: 'motor', success: false, result: 'The export command was refused by the API.' }],
      () => { throw new Error('boom'); },
    );
    assert.equal(r.detail, 'The export command was refused by the API.');
  });
});

describe('renderCaveatSection', () => {
  it('is empty when there is nothing to say, so a clean completion is unchanged', () => {
    assert.equal(renderCaveatSection([]), '');
    assert.equal(renderCaveatSection(undefined), '');
    assert.equal(renderCaveatSection(['', '   ', null]), '');
  });

  it('formats a bullet block, deduped and trimmed', () => {
    const s = renderCaveatSection([
      'CP2: two folders resolve at runtime',
      '  CP2: two folders resolve at runtime  ',
      'CP3: optional summary chart deferred',
    ]);
    assert.ok(s.includes('— Caveats (noted, non-blocking) —'), 'header');
    assert.ok(s.includes('• CP2: two folders resolve at runtime'));
    assert.ok(s.includes('• CP3: optional summary chart deferred'));
    assert.equal((s.match(/•/g) || []).length, 2, 'duplicates collapse after trimming');
    assert.ok(s.startsWith('\n\n'), 'the section appends after a blank line');
  });
});
