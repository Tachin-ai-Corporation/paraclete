// Tests for agent/work/checkpoint-spine.mjs. The pathology prevented: a checkpoint passed its
// milestone, the next checkpoint failed, the whole plan was re-derived, and the verifier then failed
// the checkpoint that had already passed. A failure in CP2 must never cost CP1 its verdict.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpine, firstIncompleteIndex, markCheckpoint, applyReplan, rebuildFromSpine, spineSummary,
  finalizeBlockedBySpine, passedThisRun, isVerified,
} from '../../../agent/work/checkpoint-spine.mjs';

const PLAN = [
  { instruction: 'Gather all required information', accept_criteria: 'Template + contracts read', tasks: [{ agent: 'motor', task: 'read template' }] },
  { instruction: 'Create and fill the addendums', accept_criteria: 'Three drafts exist', tasks: [{ agent: 'motor', task: 'clone template' }] },
  { instruction: 'File them', accept_criteria: 'All three in In Progress', tasks: [{ agent: 'motor', task: 'move' }] },
];

describe('buildSpine', () => {
  it('captures outcome, criteria and tasks, all pending', () => {
    const s = buildSpine(PLAN, { now: 'T0' });
    assert.equal(s.length, 3);
    assert.deepEqual(s.map((x) => x.n), [1, 2, 3]);
    assert.equal(s[0].outcome, 'Gather all required information');
    assert.equal(s[1].accept_criteria, 'Three drafts exist');
    assert.equal(s[0].tasks.length, 1);
    assert.ok(s.every((x) => x.status === 'pending' && x.criteria_revisions === 0));
  });

  it('tolerates a malformed plan', () => {
    assert.deepEqual(buildSpine(null), []);
    assert.deepEqual(buildSpine([]), []);
    const s = buildSpine([{}], { now: 'T' });
    assert.equal(s[0].outcome, 'Checkpoint 1');
    assert.deepEqual(s[0].tasks, []);
  });
});

describe('firstIncompleteIndex / rebuildFromSpine', () => {
  it('starts at 0 on a fresh spine', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    assert.equal(firstIncompleteIndex(s), 0);
    assert.equal(rebuildFromSpine(s).startCpIndex, 0);
  });

  it('skips completed checkpoints by starting past them', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    assert.equal(firstIncompleteIndex(s), 1, 'CP1 done: resume at CP2');
    const { checkpoints, startCpIndex, allComplete } = rebuildFromSpine(s);
    assert.equal(startCpIndex, 1);
    assert.equal(checkpoints.length, 3, 'the whole plan is still described');
    assert.equal(allComplete, false);
  });

  it('reports allComplete when every checkpoint passed', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    for (let i = 0; i < 3; i++) s = markCheckpoint(s, i, 'complete', { now: 'T' });
    assert.equal(firstIncompleteIndex(s), -1);
    const r = rebuildFromSpine(s);
    assert.equal(r.allComplete, true);
    assert.equal(r.startCpIndex, 3);
  });

  it('round-trips the executor shape', () => {
    const { checkpoints } = rebuildFromSpine(buildSpine(PLAN, { now: 'T' }));
    assert.deepEqual(checkpoints, PLAN.map((cp) => ({
      instruction: cp.instruction, accept_criteria: cp.accept_criteria, tasks: cp.tasks,
    })));
  });

  it('treats a missing spine as done and empty', () => {
    assert.equal(firstIncompleteIndex(null), -1);
    assert.deepEqual(rebuildFromSpine(null), { checkpoints: [], startCpIndex: 0, allComplete: false });
  });
});

describe('markCheckpoint', () => {
  it('does not mutate the input', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const out = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    assert.equal(s[0].status, 'pending', 'original untouched');
    assert.equal(out[0].status, 'complete');
    assert.equal(out[0].completed_at, 'T1');
  });

  it('stamps failed_at on a failure', () => {
    const out = markCheckpoint(buildSpine(PLAN, { now: 'T' }), 1, 'failed', { now: 'T2' });
    assert.equal(out[1].failed_at, 'T2');
  });

  it('ignores an out-of-range index instead of throwing', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    assert.equal(markCheckpoint(s, 99, 'complete').length, 3);
    assert.equal(markCheckpoint(s, -1, 'complete').length, 3);
  });
});

describe('applyReplan: re-plan one checkpoint, keep the rest', () => {
  it('re-tasks one checkpoint and preserves a passed verdict', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });          // CP1 passed
    s = markCheckpoint(s, 1, 'failed', { now: 'T2' });            // CP2 failed
    const { spine } = applyReplan(s, 1, [{ agent: 'motor', task: 'docs-clone-template' }], { now: 'T3' });

    assert.equal(spine[0].status, 'complete', 'CP1 keeps its verdict: the regression under test');
    assert.equal(spine[0].tasks[0].task, 'read template', 'CP1 tasks untouched');
    assert.equal(spine[1].status, 'pending', 'CP2 is runnable again');
    assert.equal(spine[1].tasks[0].task, 'docs-clone-template', 'CP2 got the new tasks');
    assert.equal(spine[2].tasks[0].task, 'move', 'CP3 untouched');
    assert.equal(firstIncompleteIndex(spine), 1, 'execution resumes at CP2, not CP1');
  });

  it('pins criteria by default, allowing exactly one refinement', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const first = applyReplan(s, 0, [], { newCriteria: 'Reworded once', now: 'T1' });
    assert.equal(first.criteriaChanged, true);
    assert.equal(first.spine[0].accept_criteria, 'Reworded once');
    assert.equal(first.spine[0].criteria_revisions, 1);

    const second = applyReplan(first.spine, 0, [], { newCriteria: 'Reworded twice', now: 'T2' });
    assert.equal(second.criteriaChanged, false, 'second rewording refused');
    assert.equal(second.revisionRefused, true, 'and reported, not silent');
    assert.equal(second.spine[0].accept_criteria, 'Reworded once', 'pinned wording holds');
  });

  it('does not count a no-op restatement as a revision', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const r = applyReplan(s, 0, [], { newCriteria: '  Template + contracts read  ', now: 'T1' });
    assert.equal(r.criteriaChanged, false);
    assert.equal(r.spine[0].criteria_revisions, 0);
  });

  it('honours pinCriteria:false as a full escape', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    s = applyReplan(s, 0, [], { newCriteria: 'A', now: 'T' }).spine;
    const r = applyReplan(s, 0, [], { newCriteria: 'B', pinCriteria: false, now: 'T' });
    assert.equal(r.spine[0].accept_criteria, 'B');
    assert.equal(r.revisionRefused, false);
  });

  it('keeps existing tasks when the re-plan yields none', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const r = applyReplan(s, 1, [], { now: 'T' });
    assert.equal(r.spine[1].tasks[0].task, 'clone template', 'an empty re-plan must not blank the checkpoint');
  });

  it('is a no-op on an out-of-range index', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    assert.deepEqual(applyReplan(s, 9, [{ agent: 'motor', task: 'x' }], { now: 'T' }).spine, s);
  });
});

describe('spineSummary', () => {
  it('counts states for the telemetry line', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    assert.match(spineSummary(s), /3cp done=0 failed=0 pending=3/);
    s = markCheckpoint(s, 0, 'complete', { now: 'T' });
    s = markCheckpoint(s, 1, 'failed', { now: 'T' });
    assert.match(spineSummary(s), /3cp done=1 failed=1 pending=1/);
    assert.equal(spineSummary([]), 'none');
    assert.equal(spineSummary(null), 'none');
  });
});

describe('finalizeBlockedBySpine: the false-complete guard', () => {
  it('allows finalize when there is no spine (an answer-only mission)', () => {
    assert.equal(finalizeBlockedBySpine(null), null);
    assert.equal(finalizeBlockedBySpine([]), null);
  });

  it('blocks when the deliverable (last) checkpoint is unmet', () => {
    // CP1 done; CP2, CP3 and CP4 pending: the delivery never finished.
    let s = buildSpine(PLAN.concat([{ instruction: 'Report the staging URL', accept_criteria: 'URL posted', tasks: [] }]), { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    const gate = finalizeBlockedBySpine(s);
    assert.ok(gate, 'a synthesize-to-complete here is a false green and must be blocked');
    assert.equal(gate.terminal.n, 4, 'the deliverable is the last checkpoint');
    assert.equal(gate.unmet.length, 3, 'CP2, CP3 and CP4 are named as outstanding');
    assert.deepEqual(gate.unmet.map((u) => u.n), [2, 3, 4]);
  });

  it('allows finalize once the deliverable checkpoint is complete, even if earlier ones are not', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    s = markCheckpoint(s, 2, 'complete', { now: 'T' });
    assert.equal(finalizeBlockedBySpine(s), null);
  });

  it('blocks a fully pending spine and names every checkpoint', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const gate = finalizeBlockedBySpine(s);
    assert.ok(gate);
    assert.equal(gate.unmet.length, 3);
    assert.equal(gate.unmet[0].status, 'pending');
  });
});

describe('a skipped checkpoint must advance the spine', () => {
  // A resumed mission skips checkpoints whose tasks all completed. When the skip did not mark the
  // spine, the spine read [pending, pending, failed] although the edit and deploy were done;
  // firstIncompleteIndex returned 0, the scoped re-plan re-targeted the edit, and the executor
  // restarted the whole mission, re-running finished work forever. These tests lock the spine
  // contract that makes marking the skip correct.
  const THREE = [
    { instruction: 'Edit the hero headline', accept_criteria: 'headline updated', tasks: [] },
    { instruction: 'Deploy to staging', accept_criteria: 'staging serves it', tasks: [] },
    { instruction: 'Report the staging URL', accept_criteria: 'URL posted', tasks: [] },
  ];

  it('the bug shape: skipped checkpoints left pending point the restart at the first one', () => {
    let s = buildSpine(THREE, { now: 'T' });
    s = markCheckpoint(s, 2, 'failed', { now: 'T' });                 // only the terminal was marked
    assert.equal(firstIncompleteIndex(s), 0, 'the reset loop: resume restarts from the edit');
    assert.equal(rebuildFromSpine(s).startCpIndex, 0);
  });

  it('skips marked complete: the re-plan scopes to the terminal only', () => {
    let s = buildSpine(THREE, { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });              // the skip advanced the edit
    s = markCheckpoint(s, 1, 'complete', { now: 'T2' });              // and the deploy
    s = markCheckpoint(s, 2, 'failed', { now: 'T3' });                // the terminal genuinely failed
    assert.equal(firstIncompleteIndex(s), 2, 'only the failed terminal is re-planned');
    assert.equal(rebuildFromSpine(s).startCpIndex, 2, 'the executor resumes at the terminal, not the edit');
    const { spine } = applyReplan(s, 2, [{ agent: 'motor', task: 'report the url' }], { now: 'T4' });
    assert.equal(spine[0].status, 'complete', 'edit verdict preserved');
    assert.equal(spine[1].status, 'complete', 'deploy verdict preserved');
    assert.equal(spine[2].status, 'pending', 'only the terminal is made runnable again');
  });

  it('once the terminal checkpoint is complete, finalize is allowed', () => {
    let s = buildSpine(THREE.slice(0, 2), { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    s = markCheckpoint(s, 1, 'complete', { now: 'T2' });
    assert.equal(firstIncompleteIndex(s), -1, 'whole spine done');
    assert.equal(finalizeBlockedBySpine(s), null, 'deliverable met: finalize allowed');
  });
});

// A briefing mission passed every checkpoint, then its cortex planned the whole mission again, four
// times, because a plain plan request on an all-complete spine was never treated as a re-plan.
// passedThisRun is the state in which a new plan can only re-shape verified work.
describe('passedThisRun', () => {
  const done = () => PLAN.map((_, i) => ({ n: i + 1, status: 'complete' }));
  const work = (step) => ({ agent: 'motor', checkpoint_step: step, success: true, result: 'ok' });

  it('every checkpoint passed in this loop, nothing new from a person: true', () => {
    assert.equal(passedThisRun(done(), [work('1.1'), work('2.1'), work('3.1'), { agent: 'system', result: 'nudge' }]), true);
  });

  it('a checkpoint still pending or failed: false (that is a scoped re-plan)', () => {
    const s = done(); s[2].status = 'pending';
    assert.equal(passedThisRun(s, [work('1.1')]), false);
    s[2].status = 'failed';
    assert.equal(passedThisRun(s, [work('1.1')]), false);
  });

  it('the spine passed before the mission paused, and a person has answered since: false', () => {
    assert.equal(passedThisRun(done(), [{ agent: 'human', result: 'also add the board deck' }]), false);
    assert.equal(passedThisRun(done(), [work('3.1'), { agent: 'human', result: 'one more thing' }]), false);
  });

  it('no checkpoint work in this loop (a fresh decide loop over an old spine): false', () => {
    assert.equal(passedThisRun(done(), []), false);
    assert.equal(passedThisRun(done(), [{ agent: 'system', result: 'hydrated context' }]), false);
  });

  it('no spine: false', () => {
    assert.equal(passedThisRun(null, [work('1.1')]), false);
    assert.equal(passedThisRun([], [work('1.1')]), false);
  });

  it('a checkpoint only proceeded past (milestone unconfirmed) is not verified work: false', () => {
    const s = done();
    s[0].milestone_unconfirmed = true;
    assert.equal(passedThisRun(s, [work('1.1'), work('2.1'), work('3.1')]), false);
  });
});

describe('markCheckpoint: complete is not the same as verified', () => {
  const fresh = () => buildSpine(PLAN, { now: 'T0' });

  it('records a milestone the executor proceeded past without confirming', () => {
    const s = markCheckpoint(fresh(), 0, 'complete', { now: 'T1', unconfirmed: true });
    assert.equal(s[0].status, 'complete');
    assert.equal(s[0].milestone_unconfirmed, true);
    assert.equal(isVerified(s[0]), false);
  });

  it('a later verified pass clears the mark', () => {
    let s = markCheckpoint(fresh(), 0, 'complete', { now: 'T1', unconfirmed: true });
    s = markCheckpoint(s, 0, 'complete', { now: 'T2', unconfirmed: false });
    assert.equal(s[0].milestone_unconfirmed, false);
    assert.equal(isVerified(s[0]), true);
  });

  it('a re-mark with no verdict (the skip of a checkpoint whose tasks completed) keeps the mark', () => {
    let s = markCheckpoint(fresh(), 0, 'complete', { now: 'T1', unconfirmed: true });
    s = markCheckpoint(s, 0, 'complete', { now: 'T2' });
    assert.equal(s[0].milestone_unconfirmed, true, 'a skip cannot launder an unconfirmed milestone');
  });

  it('isVerified is false for anything not complete, and for nothing at all', () => {
    assert.equal(isVerified({ status: 'pending' }), false);
    assert.equal(isVerified({ status: 'failed' }), false);
    assert.equal(isVerified(null), false);
    assert.equal(isVerified({ status: 'complete' }), true);
  });
});
