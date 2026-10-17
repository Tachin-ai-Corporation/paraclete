// Tests for agent/services/brain/actions/checkpoint-plan.mjs: settling a plan (the cortex's own, or
// the prefrontal's), the pinned checkpoint spine and its scoped re-plans, the refusal to re-plan work
// that already passed, a memory mission planned by code as one pass, ids repaired before they are
// pinned, and turning the executor's results into the next decision's input.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalNotRaised } from '../../../../../agent/work/checkpoint-executor.mjs';
import { handleCheckpointPlan, repairPlan, MAX_REPLANS } from '../../../../../agent/services/brain/actions/checkpoint-plan.mjs';

const SETTINGS = { maxCriteriaRevisions: 1, resourceLedger: { max: 200, recallLimit: 40 } };

function mockDeps({ planAnswer = null, executorResult = { success: true, results: [] }, executor: exec = null } = {}) {
  const calls = { log: [], callAgent: [], executeCheckpoints: [], saves: 0 };
  const deps = {
    log: (level, msg) => calls.log.push({ level, msg }),
    store: { iso: () => '2026-10-17T12:00:00.000Z', save: async () => { calls.saves += 1; } },
    callAgent: async (organ, payload) => {
      calls.callAgent.push({ organ, payload });
      return { success: true, output: JSON.stringify(planAnswer ?? { checkpoints: [{ instruction: 'Valid fallback plan', tasks: [{ agent: 'motor', task: 'Do fallback' }] }] }) };
    },
    enforceSchema: async (raw) => JSON.parse(raw),
    executor: exec || {
      executeCheckpoints: async (checkpoints, run) => {
        calls.executeCheckpoints.push({ checkpoints, run });
        return typeof executorResult === 'function' ? executorResult(checkpoints, run) : executorResult;
      },
    },
    processes: { getAllProcesses: () => ({}) },
    projects: { buildContext: () => '## Project Context: Site' },
    capabilityMap: () => '## motor\n- Shell',
    planSkill: () => 'PLAN SKILL TEXT',
    settings: SETTINGS,
  };
  return { deps, calls };
}

const ctxFor = (envelope, decision, priorResults = [], iteration = 1) => ({ envelope, decision, priorResults, iteration });

describe('the cortex\'s plan, or the prefrontal\'s', () => {
  it('runs the cortex\'s inline plan when every task names an organ that runs tasks', async () => {
    const { deps, calls } = mockDeps();
    const res = await handleCheckpointPlan(ctxFor({ id: 'm-1', instruction: 'Do the task' }, {
      checkpoints: [{ instruction: 'Checkpoint 1', tasks: [{ agent: 'motor', task: 'Run commands' }, { agent: 'temporal-research', task: 'Search the web' }] }],
    }), deps);
    assert.equal(calls.callAgent.length, 0, 'no planner call');
    assert.deepEqual(calls.executeCheckpoints[0].checkpoints[0].tasks.map((t) => t.agent), ['motor', 'temporal-research']);
    assert.ok(res.continue);
  });

  it('refuses an inline plan naming an organ that cannot run tasks, and asks the prefrontal with the skill', async () => {
    const { deps, calls } = mockDeps();
    const envelope = { id: 'm-1', instruction: 'Do the task', project_id: 'site', source_text: 'please' };
    await handleCheckpointPlan(ctxFor(envelope, {
      checkpoints: [{ instruction: 'C1', tasks: [{ agent: 'motor', task: 'Run' }, { agent: 'cerebellum', task: 'Verify' }] }],
    }), deps);
    const planner = calls.callAgent.filter((c) => c.organ === 'prefrontal');
    assert.equal(planner.length, 1);
    assert.match(planner[0].payload.instruction, /^\[PLAN STRUCTURING\]/);
    assert.match(planner[0].payload.instruction, /PLAN SKILL TEXT/);
    assert.equal(planner[0].payload._projectContext, '## Project Context: Site');
    assert.deepEqual(calls.executeCheckpoints[0].checkpoints[0].tasks.map((t) => t.agent), ['motor']);
    assert.ok(calls.log.some((l) => l.level === 'WARN' && /'cerebellum'/.test(l.msg)));
    assert.equal(envelope._cp_spine.length, 1, 'the first plan pins the spine');
  });

  it('a plan no one can produce is a nudge, not a run', async () => {
    const { deps, calls } = mockDeps({ planAnswer: { checkpoints: [] } });
    const res = await handleCheckpointPlan(ctxFor({ id: 'm-1', instruction: 'x' }, { goal: 'x' }), deps);
    assert.equal(calls.executeCheckpoints.length, 0);
    assert.match(res.priorResultsAppend[0].result, /produced no valid plan/);
  });
});

// A weekly briefing's mission passed every checkpoint, then its cortex read a digested read-back as
// "truncated" and returned a plain checkpoint_plan, which ran the whole mission again, four times.
describe('a plan that passed is delivered, not re-planned', () => {
  const READBACK_REF = 'tool_results/tr-1790894607596-c2524ae5';
  const passedSpine = () => [1, 2, 3].map((n) => ({ n, outcome: `CP${n}`, accept_criteria: '', tasks: [], status: 'complete' }));
  const thisRun = () => [
    { agent: 'motor', task: 'Gather', result: 'Saved four transcripts.', success: true, checkpoint_step: '1.1', ref: 'w-task-1' },
    { agent: 'motor', task: 'Write', result: 'Wrote the content JSON.', success: true, checkpoint_step: '2.1', ref: 'w-task-2' },
    {
      agent: 'motor', task: 'Deliver', success: true, checkpoint_step: '3.1', ref: 'w-task-3',
      result: `Created the doc and read it back.\n---\n[TOOL EXECUTION LOG]\n[TOOL] readFile({"path":"readback.txt"}) → [digest of 5336 chars — full result: ${READBACK_REF}]\nSections: Sources, State of the Week…\n[END TOOL LOG]`,
    },
    { agent: 'system', result: '[SYSTEM] All 3 checkpoint(s) PASSED verification — the work is DONE.' },
  ];
  const run = async ({ decision, priorResults, spine = passedSpine() }) => {
    const { deps, calls } = mockDeps();
    const res = await handleCheckpointPlan(ctxFor({ id: 'm-brief', instruction: 'Produce this week\'s briefing', _cp_spine: spine }, decision, priorResults, 3), deps);
    return { res, calls };
  };

  it('a plain checkpoint_plan after every checkpoint passed is refused', async () => {
    const { res, calls } = await run({ decision: { action: 'checkpoint_plan', goal: 'Produce the briefing again' }, priorResults: thisRun() });
    assert.equal(calls.executeCheckpoints.length, 0, 'the passed mission does not run again');
    assert.equal(calls.callAgent.length, 0, 'nothing is structured');
    assert.match(res.priorResultsAppend[0].result, /Re-plan refused: the checkpoints run so far all PASSED verification/);
    assert.deepEqual({ forbidden: res.activeGuard?.forbidden, fallback: res.activeGuard?.fallback, injectedAt: res.activeGuard?.injectedAt },
      { forbidden: 'checkpoint_plan', fallback: 'synthesize', injectedAt: 3 });
    assert.ok(calls.log.some((l) => /full_replan_refused .*implicit=true/.test(l.msg)));
  });

  it('the refusal names the stored full result behind a digest, and the task refs', async () => {
    const { res } = await run({ decision: { action: 'checkpoint_plan' }, priorResults: thisRun() });
    const steer = res.priorResultsAppend[0].result;
    assert.ok(steer.includes(READBACK_REF));
    assert.match(steer, /a DIGEST of a stored result, not a cut/);
    assert.match(steer, /w-task-3/);
  });

  it('an explicit mission-scope re-shape of passed work is refused too', async () => {
    const { res, calls } = await run({ decision: { action: 'checkpoint_plan', replan_scope: 'mission', replan_reason: 'start over' }, priorResults: thisRun() });
    assert.equal(calls.executeCheckpoints.length, 0);
    assert.equal(res.activeGuard?.fallback, 'synthesize');
    assert.ok(calls.log.some((l) => /full_replan_refused .*implicit=false/.test(l.msg)));
  });

  it('a spine that passed before a person answered stays plannable: the answer may ask for more', async () => {
    const { res, calls } = await run({
      decision: { action: 'checkpoint_plan', checkpoints: [{ instruction: 'Add the board deck', tasks: [{ agent: 'motor', task: 'Build the deck' }] }] },
      priorResults: [{ agent: 'human', result: 'Thanks, also add the board deck.', success: true }],
    });
    assert.equal(calls.executeCheckpoints.length, 1);
    assert.equal(res.activeGuard, undefined);
  });

  it('a failed checkpoint is re-tasked alone, against its pinned outcome, with what was unmet', async () => {
    const spine = passedSpine();
    spine[2].status = 'failed';
    spine[2].tasks = [{ agent: 'motor', task: 'Deliver to folder 1AbCdEfGhIjKlMnOpQrStUvWxYz1' }];
    const envelope = {
      id: 'm-brief', instruction: 'Produce the briefing', _cp_spine: spine,
      context: { resources: { 'drive_folder:briefings': { kind: 'drive_folder', name: 'Briefings', id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0' } } },
      _cp_progress: { allResults: [{ step: '1.1', agent: 'motor', result: 'ok', success: true }, { step: '3.1', agent: 'motor', result: 'x', success: false }] },
    };
    const { deps, calls } = mockDeps({ planAnswer: { checkpoints: [{ instruction: 'ignored', accept_criteria: 'reworded', tasks: [{ agent: 'motor', task: 'Deliver to folder 1AbCdEfGhIjKlMnOpQrStUvWxYz1' }] }] } });
    await handleCheckpointPlan(ctxFor(envelope, { action: 'checkpoint_plan' }, [
      { agent: 'cerebellum', checkpoint_step: '3.verify', result: '[CHECKPOINT VERIFICATION FAILED] - the doc is not in the folder', success: false },
    ], 4), deps);
    const scoped = calls.callAgent.find((c) => c.payload.instruction.includes('SINGLE CHECKPOINT'));
    assert.ok(scoped, 'the failed checkpoint gets a scoped re-plan');
    assert.match(scoped.payload.instruction, /the doc is not in the folder/);
    assert.match(scoped.payload.instruction, /## Known Resources[\s\S]*1AbCdEfGhIjKlMnOpQrStUvWxYz0[\s\S]*## Tasks that were tried/);
    const { run: started, checkpoints } = calls.executeCheckpoints[0];
    assert.equal(started.startCpIndex, 2, 'the passed checkpoints are not run again');
    assert.deepEqual(started.savedResults.map((r) => r.step), ['1.1'], 'their results are banked for the verifier');
    assert.equal(checkpoints[2].tasks[0].task, 'Deliver to folder 1AbCdEfGhIjKlMnOpQrStUvWxYz0', 'the mistyped id is repaired before it is pinned');
    assert.equal(envelope._cp_spine[2].status, 'pending');
    assert.equal(envelope._cp_spine[2].accept_criteria, 'reworded', 'one criteria refinement is allowed');
    assert.ok(calls.log.some((l) => /id_repair .*from=1AbCdEfGhIjKlMnOpQrStUvWxYz1 to=1AbCdEfGhIjKlMnOpQrStUvWxYz0/.test(l.msg)));
  });

  it('the pass nudge offers the stored full results behind any digests', async () => {
    const { deps } = mockDeps({ executorResult: { success: true, results: [{ step: '1.1', agent: 'motor', task: 'Deliver', success: true, ref: 'w-task-9', result: thisRun()[2].result }] } });
    const res = await handleCheckpointPlan(ctxFor({ id: 'm-fresh', instruction: 'Produce the briefing' }, {
      checkpoints: [{ instruction: 'Deliver', tasks: [{ agent: 'motor', task: 'Create and read back the doc' }] }],
    }), deps);
    const nudge = res.priorResultsAppend.find((r) => r.agent === 'system' && /PASSED verification/.test(r.result));
    assert.ok(nudge);
    assert.ok(nudge.result.includes(READBACK_REF));
    assert.ok(nudge.result.includes('w-task-9'));
    assert.equal(res.priorResultsAppend[0].checkpoint_step, '1.1');
  });
});

// A nightly consolidation's plan split the cycle into four checkpoints handing their triage forward
// through a plan file that the memory organ may not write, and blocked with memory untouched.
describe('a memory-scoped mission is planned by code, as one pass', () => {
  const memoryEnvelope = (extra = {}) => ({
    id: 'm-consolidate',
    instruction: 'Execute the nightly memory consolidation cycle.',
    accept_criteria: 'MEMORY.md contains only active context; a structured report is produced.',
    context_summary: 'PROCESS:\n1. STEP 1 - GATHER WORKING MEMORY\n2. STEP 2 - GATHER SESSIONS',
    source_meta: { effect_scope: 'memory', responsibility_id: 'r-memory-consolidation' },
    ...extra,
  });
  const fourCheckpointPlan = {
    action: 'checkpoint_plan',
    checkpoints: [
      { instruction: 'Gather all memory', tasks: [{ agent: 'motor', task: 'Read all memory layers' }] },
      { instruction: 'Plan', tasks: [{ agent: 'motor', task: 'Write the plan to consolidation_plan.json' }] },
      { instruction: 'Execute the plan', tasks: [{ agent: 'motor', task: 'Apply consolidation_plan.json' }] },
      { instruction: 'Report', tasks: [{ agent: 'motor', task: 'Write consolidation_report.md from consolidation_plan.json' }] },
    ],
  };

  it('a four-checkpoint plan-file plan is replaced by ONE temporal-memory task', async () => {
    const { deps, calls } = mockDeps();
    const envelope = memoryEnvelope();
    await handleCheckpointPlan(ctxFor(envelope, fourCheckpointPlan), deps);
    assert.equal(calls.callAgent.length, 0, 'no planner');
    const cps = calls.executeCheckpoints[0].checkpoints;
    assert.equal(cps.length, 1);
    assert.equal(cps[0].tasks.length, 1);
    assert.equal(cps[0].tasks[0].agent, 'temporal-memory');
    assert.doesNotMatch(cps[0].tasks[0].task, /consolidation_plan\.json/);
    assert.match(cps[0].tasks[0].task, /STEP 2 - GATHER SESSIONS/);
    assert.equal(cps[0].accept_criteria, envelope.accept_criteria);
    assert.equal(envelope._cp_spine?.length, 1);
    assert.ok(calls.log.some((l) => /plan_structuring: .*"source":"memory_scope"/.test(l.msg)));
  });

  it('with no plan from the cortex at all, it still calls no planner', async () => {
    const { deps, calls } = mockDeps();
    await handleCheckpointPlan(ctxFor(memoryEnvelope(), { action: 'checkpoint_plan', goal: 'consolidate' }), deps);
    assert.equal(calls.callAgent.length, 0);
    assert.equal(calls.executeCheckpoints[0].checkpoints[0].tasks[0].agent, 'temporal-memory');
  });

  it('a failed pass is retried as the same pass, told which clauses were unmet', async () => {
    const spine = [{ n: 1, outcome: 'Execute the nightly memory consolidation cycle.', accept_criteria: 'MEMORY.md contains only active context; a structured report is produced.', tasks: [], status: 'failed', criteria_revisions: 0 }];
    const { deps, calls } = mockDeps();
    const envelope = memoryEnvelope({ _cp_spine: spine });
    await handleCheckpointPlan(ctxFor(envelope, { action: 'checkpoint_plan' }, [
      { agent: 'system', result: '[CHECKPOINT VERIFICATION FAILED] - The report omits the final MEMORY.md character count.' },
    ]), deps);
    assert.equal(calls.callAgent.length, 0);
    const task = calls.executeCheckpoints[0].checkpoints[0].tasks[0];
    assert.equal(task.agent, 'temporal-memory');
    assert.match(task.task, /The report omits the final MEMORY\.md character count\./);
    assert.equal(envelope._cp_spine[0].status, 'pending');
    assert.equal(envelope._cp_spine[0].accept_criteria, spine[0].accept_criteria, 'criteria stay pinned');
  });

  it('a mission that is not memory-scoped is planned as given', async () => {
    const { deps, calls } = mockDeps();
    await handleCheckpointPlan(ctxFor({ id: 'm-other', instruction: 'Do the task' }, fourCheckpointPlan), deps);
    assert.equal(calls.executeCheckpoints[0].checkpoints.length, 4);
  });
});

describe('guards around a run', () => {
  it('a destructive part without an approval gate is pointed out once, then the plan proceeds', async () => {
    const { deps, calls } = mockDeps();
    const envelope = { id: 'm-1', instruction: 'Deploy', _brief: { parts: [{ id: 'p1', risk: 'destructive_or_public' }] } };
    const decision = { checkpoints: [{ instruction: 'Deploy', tasks: [{ agent: 'motor', task: 'Deploy to production' }] }] };
    const first = await handleCheckpointPlan(ctxFor(envelope, decision), deps);
    assert.match(first.priorResultsAppend[0].result, /\[IRREVERSIBILITY WARNING\].*p1/);
    assert.equal(calls.executeCheckpoints.length, 0);
    await handleCheckpointPlan(ctxFor(envelope, decision, first.priorResultsAppend), deps);
    assert.equal(calls.executeCheckpoints.length, 1, 'bounded: once warned, the plan runs');
  });

  it('a playbook the goal matches is shown to the planner and remembered for the lesson', async () => {
    const { deps, calls } = mockDeps();
    deps.processes = { getAllProcesses: () => ({ 'p-release': { id: 'p-release', name: 'Release', narrative: 'Gate, then deploy.', intent_keywords: ['release'] } }) };
    const envelope = { id: 'm-1', instruction: 'Cut the release', recalled_processes: ['p-from-schedule'] };
    await handleCheckpointPlan(ctxFor(envelope, { goal: 'Cut the release' }), deps);
    assert.match(calls.callAgent[0].payload.instruction, /\[PROCESS PLAYBOOKS\][\s\S]*p-release: Release — Gate, then deploy\./);
    assert.deepEqual(envelope.recalled_processes, ['p-from-schedule', 'p-release']);
  });

  it('repeated failures run out of re-plans', async () => {
    const { deps } = mockDeps({ executorResult: { success: false, results: [{ step: '1.1', agent: 'motor', result: '[ERROR] Command failed', success: false }] } });
    const envelope = { id: 'm-1', instruction: 'x', _replan_count: MAX_REPLANS - 1 };
    const res = await handleCheckpointPlan(ctxFor(envelope, { checkpoints: [{ instruction: 'C', tasks: [{ agent: 'motor', task: 't' }] }] }), deps);
    assert.match(res.priorResultsAppend.at(-1).result, /failed 3 times\. You MUST use "synthesize_with_failure" or "needs_input"/);
    assert.equal(res.priorResultsAppend[0].failure_type, 'tool_error');
  });

  it('a plan whose every task was replayed forces a synthesis', async () => {
    const { deps } = mockDeps({ executorResult: { success: true, results: [{ step: '1.1', agent: 'motor', result: '[REPLAYED] Step already completed', success: true }] } });
    const res = await handleCheckpointPlan(ctxFor({ id: 'm-1', instruction: 'x' }, { checkpoints: [{ instruction: 'C', tasks: [{ agent: 'motor', task: 't' }] }] }, [], 5), deps);
    assert.equal(res.activeGuard.forbidden, 'checkpoint_plan');
    assert.match(res.priorResultsAppend.at(-1).result, /already completed earlier/);
  });

  it('a gate whose approval could not be written pauses nothing: the mission keeps its place and tries again later', async () => {
    const { deps, calls } = mockDeps({ executor: { executeCheckpoints: async () => { throw new ApprovalNotRaised('apr-1', 'm-1'); } } });
    const envelope = { id: 'm-1', instruction: 'x' };
    const res = await handleCheckpointPlan(ctxFor(envelope, { checkpoints: [{ instruction: 'C', tasks: [{ agent: 'motor', task: 'gate', step_type: 'approval_gate' }] }] }), deps);
    assert.deepEqual(res, { exit: true, retryLater: true });
    assert.equal(envelope._cp_progress.checkpointIndex, 0);
    assert.equal(envelope._cp_progress.checkpoints.length, 1);
    assert.equal(calls.saves, 1);
  });

  it('a paused plan ends the run', async () => {
    const { deps } = mockDeps({ executorResult: { paused: true, approvalId: 'apr-1', results: [] } });
    assert.deepEqual(await handleCheckpointPlan(ctxFor({ id: 'm-1', instruction: 'x' }, { checkpoints: [{ instruction: 'C', tasks: [{ agent: 'motor', task: 't' }] }] }), deps), { exit: true });
  });
});

describe('repairPlan', () => {
  it('repairs only a unique one-character typo against a known id, in place', () => {
    const ledger = { 'doc:template': { kind: 'doc', name: 'Template', id: '1TmPlAtE00000000000000000000' } };
    const cps = [{ instruction: 'Use 1TmPlAtE00000000000000000001', tasks: [{ task: 'Copy 1TmPlAtE00000000000000000001 and 1ZzZzZzZzZzZzZzZzZzZzZzZzZzZz' }] }];
    const { repairs, unknown } = repairPlan(cps, ledger);
    assert.equal(repairs.length, 2);
    assert.equal(cps[0].tasks[0].task, 'Copy 1TmPlAtE00000000000000000000 and 1ZzZzZzZzZzZzZzZzZzZzZzZzZzZz');
    assert.ok(unknown.includes('1ZzZzZzZzZzZzZzZzZzZzZzZzZzZz'));
    assert.deepEqual(repairPlan(cps, {}), { repairs: [], unknown: [] });
  });
});
