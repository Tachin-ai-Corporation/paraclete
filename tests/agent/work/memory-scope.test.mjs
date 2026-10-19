// Tests for agent/work/memory-scope.mjs. Memory is a closed set of three layers, and a mission whose
// job is memory dispatches no other hand. Several nightly consolidations in a row planned "write
// the plan to a file, then execute it" across checkpoints; memory may not write that file, every
// later checkpoint found nothing, and the mission blocked. A memory mission is one pass.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_SCOPE, isMemoryScoped, fenceMemoryTask, memoryMissionPlan, contrastiveConsolidationGuidance } from '../../../agent/work/memory-scope.mjs';

describe('a memory-scoped mission dispatches no other hand', () => {
  it('recognizes the scope stamp', () => {
    assert.equal(MEMORY_SCOPE, 'memory');
    assert.equal(isMemoryScoped({ source_meta: { effect_scope: 'memory' } }), true);
    assert.equal(isMemoryScoped({ source_meta: { effect_scope: 'world' } }), false);
    assert.equal(isMemoryScoped({}), false);
    assert.equal(isMemoryScoped(null), false);
  });

  it('allows the memory organs, reroutes motor to temporal-memory, refuses gates and other steps', () => {
    assert.deepEqual(fenceMemoryTask({ stepType: 'standard', taskAgent: 'temporal-memory' }), { action: 'allow' });
    assert.deepEqual(fenceMemoryTask({ stepType: 'standard', taskAgent: 'temporal-research' }), { action: 'allow' });
    for (const agent of ['motor', undefined]) {
      const f = fenceMemoryTask({ stepType: 'standard', taskAgent: agent });
      assert.equal(f.action, 'reroute');
      assert.equal(f.agent, 'temporal-memory');
    }
    for (const stepType of ['approval_gate', 'something_new']) {
      assert.equal(fenceMemoryTask({ stepType, taskAgent: 'motor' }).action, 'refuse', stepType);
    }
    assert.match(fenceMemoryTask({ stepType: 'approval_gate' }).reason, /nothing to approve/);
  });

  it('treats a missing step type as a standard task', () => {
    assert.equal(fenceMemoryTask({ taskAgent: 'motor' }).action, 'reroute');
    assert.equal(fenceMemoryTask().action, 'reroute');
  });
});

describe('a memory mission is one pass by the memory authority', () => {
  const mission = () => ({
    instruction: 'Execute the nightly memory consolidation cycle.',
    accept_criteria: 'MEMORY.md contains only active context; a structured report is produced.',
    context_summary: 'PURPOSE: keep memory lean.\n\nPROCESS:\n1. STEP 1 — GATHER WORKING MEMORY\n2. STEP 2 — GATHER SESSIONS: Run `session-summary --hours 24 --limit 20`',
    source_meta: { effect_scope: 'memory' },
  });

  it('is one checkpoint with one task, run by temporal-memory, which the fence allows', () => {
    const plan = memoryMissionPlan(mission());
    assert.equal(plan.length, 1);
    assert.equal(plan[0].tasks.length, 1);
    assert.equal(plan[0].tasks[0].agent, 'temporal-memory');
    assert.deepEqual(fenceMemoryTask({ stepType: 'standard', taskAgent: plan[0].tasks[0].agent }), { action: 'allow' });
  });

  it("the task carries the whole process, because a task does not see the mission's context", () => {
    const { task } = memoryMissionPlan(mission())[0].tasks[0];
    assert.match(task, /Execute the nightly memory consolidation cycle\./);
    assert.match(task, /session-summary --hours 24 --limit 20/, 'the process steps travel with the task');
    assert.match(task, /writes only MEMORY\.md and consolidation_report\.md/);
    assert.match(task, /never in a file of your own/, 'no plan file to hand forward');
    assert.match(task, /contrast checkpoints that passed on the first attempt/, 'carries causal contrastive guidance');
    assert.match(task, /Changing nothing is a valid outcome/);
    assert.match(contrastiveConsolidationGuidance(), /helped.*hurt.*confounded/);
  });

  it("the checkpoint is judged on the mission's own success criteria, not a planner's", () => {
    assert.equal(memoryMissionPlan(mission())[0].accept_criteria, mission().accept_criteria);
  });

  it('a retry is the same pass, told what the verifier found unmet', () => {
    const { task } = memoryMissionPlan(mission(), { unmet: '[CHECKPOINT VERIFICATION FAILED] the report omits the MEMORY.md character count' })[0].tasks[0];
    assert.match(task, /Address every one of these this time:\n\[CHECKPOINT VERIFICATION FAILED\] the report omits/);
    assert.match(task, /session-summary --hours 24/, 'and still carries the process');
  });

  it('has a usable plan for a bare envelope', () => {
    const [cp] = memoryMissionPlan(null);
    assert.equal(cp.instruction, 'Consolidate memory.');
    assert.equal(cp.accept_criteria, '');
    assert.doesNotMatch(cp.tasks[0].task, /Address every one/);
  });
});
