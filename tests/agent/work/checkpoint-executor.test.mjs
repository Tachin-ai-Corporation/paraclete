// Tests for agent/work/checkpoint-executor.mjs, driven end to end with fakes: a Firestore client in
// memory, a callAgent that returns canned organ outputs with tool logs, and recording approvals and
// history. The pathologies prevented: a resumed mission re-ran finished work or skipped a checkpoint
// nobody verified; work proceeded past a failed milestone; an approval gate asked the wrong question,
// went undelivered, or lost who asked; a memory mission reached beyond memory; a status moved along
// a transition the state machine forbids.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCheckpointExecutor, requesterOf, ApprovalNotRaised, VALID_TASK_ORGANS,
} from '../../../agent/work/checkpoint-executor.mjs';
import { CAVEATS } from '../../../agent/work/checkpoint-verify.mjs';
import { canTransition } from '../../../agent/work/work-transitions.mjs';
import { buildSpine } from '../../../agent/work/checkpoint-spine.mjs';
import { deriveStepKey } from '../../../agent/work/step-ledger.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const ISO0 = new Date(T0).toISOString();
const USER = 'user@example.com';
const REF = `${COLLECTIONS.toolResults}/tr-1`;

// ── Canned organ replies ──────────────────────────────────────────────

const toolLog = (...lines) => `\n\n---\n[TOOL EXECUTION LOG]\n${lines.join('\n')}\n[END TOOL LOG]`;
const done = (text, ...extra) => ({
  success: true,
  output: `${text}${toolLog('[TOOL] writeFile({"path":"out.md"}) → ok', ...extra)}`,
  durationMs: 20000,
  finishReason: 'STOP',
});
const broken = (error = 'HTTP 500') => ({ success: false, output: null, error, durationMs: 100 });
const pass = (caveat) => ({
  success: true,
  output: `Judged.${toolLog(`[TOOL] report_pass(${JSON.stringify({ reasoning: 'met', checks: [], ...(caveat ? { caveat } : {}) })}) → {"verdict":"PASS"}`)}`,
});
const fail = (evidence, recommendation = 'Add the missing region.') => ({
  success: true,
  output: `Judged.${toolLog(`[TOOL] report_fail(${JSON.stringify({ reasoning: evidence, checks: [{ criterion: 'Every region is covered', pass: false, evidence }], recommendation })}) → {"verdict":"FAIL"}`)}`,
});
const empty = () => ({ success: true, output: '', finishReason: 'STOP' });

// ── Fakes ─────────────────────────────────────────────────────────────

/** A Firestore client in memory: whole-document reads and writes, with every write recorded. */
function fakeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([path, doc]) => [path, structuredClone(doc)]));
  const writes = [];
  let refuse = () => false;
  return {
    docs,
    writes,
    refuseWrites(fn) { refuse = fn; },
    async read(path) { return docs.has(path) ? structuredClone(docs.get(path)) : null; },
    async write(path, data, opts = {}) {
      if (refuse(path, data)) return null;
      docs.set(path, structuredClone(data));
      writes.push({ path, data: structuredClone(data), opts });
      return {};
    },
    work(id) { return docs.get(`${COLLECTIONS.work}/${id}`); },
    ofType(type) {
      return [...docs.entries()]
        .filter(([path, d]) => path.startsWith(`${COLLECTIONS.work}/`) && d.type === type)
        .map(([, d]) => d);
    },
  };
}

/** Organs that answer from a script: an array of replies per organ, or a function. */
function organs(script = {}) {
  const calls = [];
  const callAgent = async (organ, payload) => {
    calls.push({ organ, payload });
    const s = script[organ];
    const next = typeof s === 'function' ? s(payload) : Array.isArray(s) ? s.shift() : undefined;
    if (next instanceof Error) throw next;
    return next || { success: false, output: null, error: `no scripted reply for ${organ}`, durationMs: 0 };
  };
  return { callAgent, calls, of: (organ) => calls.filter((c) => c.organ === organ) };
}

function mission(over = {}) {
  return {
    id: 'w-m1',
    type: 'M',
    parent_id: null,
    status: 'active',
    intent: 'mission',
    instruction: 'Write the quarterly regional report',
    accept_criteria: 'report.md covers every region',
    source_channel: 'dashboard',
    source_meta: { sender: USER, address: { channel: 'dashboard', thread: 'th-1' } },
    children: [],
    iteration: 1,
    created_at: ISO0,
    started_at: ISO0,
    updated_at: ISO0,
    ...over,
  };
}

function world({ envelope = mission(), script = {}, settings = {}, approvalsOk = true, seed = {}, deps = {} } = {}) {
  const db = fakeDb({ [`${COLLECTIONS.work}/${envelope.id}`]: envelope, ...seed });
  const agents = organs(script);
  const history = [];
  const approvals = [];
  let n = 0;
  const executor = createCheckpointExecutor({
    db,
    callAgent: agents.callAgent,
    writeHistory: async (...args) => { history.push(args); },
    approvals: { create: async (id, record) => { approvals.push({ id, record }); return approvalsOk; } },
    generateId: (prefix) => `${prefix}-${++n}`,
    settings,
    logger: () => {},
    clock: () => T0,
    ...deps,
  });
  const run = (plan, opts = {}) => executor.executeCheckpoints(plan, { envelope, ...opts });
  return { envelope, db, agents, history, approvals, executor, run };
}

/** Every recorded status change is one the state machine allows. */
function assertLegalHistory(history) {
  for (const [id, from, to] of history) {
    if (from === null) continue; // a creation, not a change
    assert.ok(canTransition(from, to).allowed, `${id}: ${from} → ${to} is not a legal move`);
  }
}

const PLAN = [
  {
    instruction: 'Gather the regional figures',
    accept_criteria: 'figures.csv holds figures for all four regions',
    tasks: [{ agent: 'motor', task: 'Collect the regional figures into figures.csv' }],
  },
  {
    instruction: 'Write the report',
    accept_criteria: 'report.md covers every region',
    tasks: [
      { agent: 'motor', task: 'Draft report.md from figures.csv' },
      { agent: 'motor', task: 'Proofread report.md' },
    ],
  },
];

// ── The construction contract ─────────────────────────────────────────

describe('createCheckpointExecutor', () => {
  it('names each missing required dependency', () => {
    assert.throws(() => createCheckpointExecutor({}), /deps\.db is required/);
    const ok = { db: fakeDb(), callAgent: async () => ({}), writeHistory: async () => {}, approvals: { create: async () => true }, generateId: () => 'x' };
    for (const name of ['callAgent', 'writeHistory', 'approvals', 'generateId']) {
      assert.throws(() => createCheckpointExecutor({ ...ok, [name]: undefined }), new RegExp(`deps\\.${name} is required`));
    }
    assert.doesNotThrow(() => createCheckpointExecutor(ok));
  });

  it('requires the mission envelope', async () => {
    const { executor } = world();
    await assert.rejects(() => executor.executeCheckpoints(PLAN, {}), /run\.envelope/);
  });

  it('runs tasks only on the organs that execute', () => {
    assert.deepEqual([...VALID_TASK_ORGANS], ['motor', 'temporal-research', 'temporal-memory']);
  });
});

// ── A plan from start to finish ───────────────────────────────────────

describe('a plan runs to completion', () => {
  it('runs every task, verifies every milestone, and records it all', async () => {
    const w = world({
      envelope: mission({ _cp_spine: buildSpine(PLAN, { now: ISO0 }) }),
      script: { motor: [done('Collected.'), done('Drafted.'), done('Proofread.')], cerebellum: [pass(), pass()] },
    });
    const out = await w.run(PLAN);

    assert.equal(out.success, true);
    assert.deepEqual(out.results.map((r) => r.step), ['1.1', '2.1', '2.2'], 'a clean pass adds no verdict row');
    assert.ok(out.results.every((r) => r.success && r.summary && r.ref && r.shape), 'each row carries its result packet');
    assert.equal(w.agents.of('motor').length, 3);
    assert.equal(w.agents.of('cerebellum').length, 2, 'one verification per checkpoint');

    assert.deepEqual(w.envelope._cp_spine.map((s) => s.status), ['complete', 'complete']);
    assert.equal(w.envelope._cp_progress, null, 'progress is cleared at the end');
    assert.equal(w.envelope.status, 'active', 'finishing the mission is the brain\'s job');
    assert.deepEqual(w.db.work('w-m1')._cp_spine.map((s) => s.status), ['complete', 'complete'], 'saved, not only in memory');

    const cps = w.db.ofType('C');
    assert.equal(cps.length, 2);
    assert.ok(cps.every((c) => c.status === 'complete' && c.completed_at && c.parent_id === 'w-m1'));
    assert.deepEqual(cps.map((c) => c.source_meta.checkpoint), [1, 2]);
    assert.match(cps[0]._cp_digest, /\[CHECKPOINT 1 DIGEST/);
    assert.deepEqual(w.envelope.children, cps.map((c) => c.id));

    const tasks = w.db.ofType('T');
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((t) => t.status === 'complete' && t.source_meta.agent === 'motor'));
    assertLegalHistory(w.history);
  });

  it('sends each task the mission context, prior work and tool access', async () => {
    const w = world({
      envelope: mission({ source_text: 'Please write the Q3 report.', memory_context: 'Reports go in /reports.' }),
      script: { motor: [done('Collected.'), done('Drafted.'), done('Proofread.')], cerebellum: [pass(), pass()] },
      deps: { projects: { get: () => ({ name: 'Reporting' }), buildContext: (id) => `Project ${id} context` } },
    });
    w.envelope.project_id = 'reporting';
    await w.run(PLAN);
    const [first, second] = w.agents.of('motor').map((c) => c.payload);
    assert.equal(first._exec, true);
    assert.equal(first._missionId, 'w-m1');
    assert.equal(first._projectContext, 'Project reporting context');
    assert.doesNotMatch(first.instruction, /PROJECT CONTEXT/, 'the project context travels once, not twice');
    assert.equal(first._sourceText, 'Please write the Q3 report.');
    assert.equal(first._requester, USER);
    assert.equal('_sourceMeta' in first, false, 'no consumer: the whole source_meta (a paused plan included) is not sent');
    assert.equal(first.memory_context, 'Reports go in /reports.');
    assert.match(first.instruction, /^Collect the regional figures into figures\.csv/);
    assert.match(first.accept_criteria, /The task's stated outcome is achieved/);
    assert.equal(first.prior_results_context, null, 'nothing before the first task');
    assert.match(second.prior_results_context, /\[CHECKPOINT 1 DIGEST/, 'finished checkpoints travel as digests');
  });

  it('commits the mission tree after each checkpoint that passes', async () => {
    const commits = [];
    const w = world({
      envelope: mission({ project_id: 'reporting' }),
      script: { motor: [done('Collected.'), done('Drafted.'), done('Proofread.')], cerebellum: [pass(), pass()] },
      deps: { artifacts: { commitAndSync: async (...args) => { commits.push(args); return { committed: true, synced: true, sha: 'abc' }; } } },
    });
    await w.run(PLAN);
    assert.deepEqual(commits.map((c) => c[2]), [
      'v2026.10.17.1.1: Gather the regional figures',
      'v2026.10.17.1.2: Write the report',
    ]);
    assert.equal(w.envelope.context.git_checkpoint_count, 2, 'the publish step continues the version from here');
  });

  it('keeps each task transcript under missions/<id>/steps in the mission tree', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'cp-exec-'));
    try {
      const w = world({
        script: { motor: [done(`Collected. ${'figures '.repeat(40)}`)], cerebellum: [pass()] },
        deps: { missionDir: () => tree },
      });
      await w.run(PLAN.slice(0, 1));
      assert.deepEqual(readdirSync(join(tree, 'missions', 'w-m1', 'steps')), ['1.1-collect-the-regional-figures-into-figures-csv.md']);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

// ── The step ledger ───────────────────────────────────────────────────

describe('the step ledger', () => {
  const ONE = [{
    instruction: 'Gather the regional figures',
    accept_criteria: 'figures.csv holds figures for all four regions',
    tasks: [
      { agent: 'motor', task: 'Collect the regional figures into figures.csv' },
      { agent: 'motor', task: 'Check the totals' },
    ],
  }];

  it('replays a task that already completed, with the output its task envelope recorded', async () => {
    const key = deriveStepKey('w-m1', 1, 'cp_task', '0.0.motor', 1);
    const w = world({
      envelope: mission({ step_ledger: { [key]: { status: 'complete', cp: 1, ref: 'w-t-old', durationMs: 5 } } }),
      seed: { [`${COLLECTIONS.work}/w-t-old`]: { id: 'w-t-old', type: 'T', status: 'complete', output: 'Collected figures for north, south, east and west.' } },
      script: { motor: [done('Totals check out.')], cerebellum: [pass()] },
    });
    const out = await w.run(ONE);
    assert.equal(out.success, true);
    assert.equal(w.agents.of('motor').length, 1, 'only the unfinished task runs');
    assert.match(w.agents.of('motor')[0].payload.instruction, /^Check the totals/);
    const replayed = out.results.find((r) => r.step === '1.1');
    assert.equal(replayed.replayed, true);
    assert.match(replayed.result, /^\[REPLAYED\][\s\S]*north, south, east and west/);
    assert.match(w.agents.of('cerebellum')[0].payload.instruction, /north, south, east and west/, 'the verifier sees the real result, not a stub');
  });

  it('a replay with no recorded output says so', async () => {
    const key = deriveStepKey('w-m1', 1, 'cp_task', '0.0.motor', 1);
    const w = world({
      envelope: mission({ step_ledger: { [key]: { status: 'complete', cp: 1 } } }),
      script: { motor: [done('Totals check out.')], cerebellum: [pass()] },
    });
    const out = await w.run(ONE);
    assert.equal(out.results[0].result, '[REPLAYED] Step already completed (complete)');
  });

  it('a failed entry runs again', async () => {
    const key = deriveStepKey('w-m1', 1, 'cp_task', '0.0.motor', 1);
    const w = world({
      envelope: mission({ step_ledger: { [key]: { status: 'failed', cp: 1 } } }),
      script: { motor: [done('Collected.'), done('Totals check out.')], cerebellum: [pass()] },
    });
    await w.run(ONE);
    assert.equal(w.agents.of('motor').length, 2);
  });

  it('records each task with the task envelope that holds its output', async () => {
    const w = world({ script: { motor: [done('Collected.'), done('Totals.')], cerebellum: [pass()] } });
    await w.run(ONE);
    const entries = Object.values(w.envelope.step_ledger);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.status === 'complete' && e.cp === 1 && w.db.work(e.ref)?.type === 'T'));
  });

  it('after the last task, progress points back at it, so a crash before the verdict verifies instead of skipping', async () => {
    const w = world({ script: { motor: [done('Collected.'), done('Totals.')], cerebellum: [pass()] } });
    await w.run(ONE);
    const progress = w.db.writes
      .filter((x) => x.path === `${COLLECTIONS.work}/w-m1` && x.data._cp_progress?.checkpointIndex === 0)
      .map((x) => x.data._cp_progress.taskIndex);
    assert.deepEqual(progress, [1, 1], 'after task 1: resume at task 2; after task 2 (the last): resume at task 2, replayed');

    // The crash: the mission as saved after its last task, before the verdict, its checkpoint open.
    const crashed = w.db.writes.filter((x) => x.path === `${COLLECTIONS.work}/w-m1` && x.data._cp_progress?.taskIndex === 1).pop().data;
    const seed = Object.fromEntries([...w.db.docs.entries()].filter(([path]) => path !== `${COLLECTIONS.work}/w-m1`));
    const [cpPath] = Object.keys(seed).filter((path) => seed[path].type === 'C');
    seed[cpPath] = { ...seed[cpPath], status: 'active', completed_at: null };
    const again = world({ envelope: structuredClone(crashed), seed, script: { cerebellum: [pass()] } });
    const out = await again.run(crashed._cp_progress.checkpoints, {
      startCpIndex: crashed._cp_progress.checkpointIndex,
      startTaskIndex: crashed._cp_progress.taskIndex,
      savedResults: crashed._cp_progress.allResults,
    });
    assert.equal(again.agents.of('motor').length, 0, 'the finished task is replayed, not re-run');
    assert.equal(again.agents.of('cerebellum').length, 1, 'and the milestone is judged');
    const prompt = again.agents.of('cerebellum')[0].payload.instruction;
    assert.match(prompt, /## Combined Task Outputs[\s\S]*Collected\.[\s\S]*Totals\./, 'on both tasks\' recorded outputs, as this checkpoint\'s own evidence');
    assert.doesNotMatch(prompt, /Previously Established/, 'not as already-verified earlier work');
    assert.deepEqual(out.results.map((r) => r.step), ['1.1', '1.2'], 'no row doubled');
    assert.equal(out.success, true);
    assert.equal(again.db.ofType('C').length, 1, 'the open checkpoint is resumed, not duplicated');
    assert.equal(again.db.ofType('C')[0].status, 'complete');
  });
});

// ── Failure halts ─────────────────────────────────────────────────────

describe('a failed task', () => {
  it('is retried once, then fails its checkpoint and halts the plan, unverified', async () => {
    const w = world({
      envelope: mission({ _cp_spine: buildSpine(PLAN, { now: ISO0 }) }),
      script: { motor: [broken('HTTP 500'), broken('HTTP 500')] },
    });
    const out = await w.run(PLAN);
    assert.equal(out.success, false);
    const motor = w.agents.of('motor');
    assert.equal(motor.length, 2, 'one retry, and nothing from checkpoint 2');
    assert.match(motor[1].payload.instruction, /\[RETRY\] Previous attempt failed: HTTP 500\. Read the governing SKILL\.md/);
    assert.match(motor[1].payload.prior_results_context, /\[PREVIOUS ATTEMPT FAILED\] HTTP 500/);
    assert.equal(w.agents.of('cerebellum').length, 0, 'a failed task is not verified');

    assert.deepEqual(out.results.map((r) => [r.step, r.success]), [['1.1', false]]);
    assert.match(out.results[0].result, /^\[FAILED\] HTTP 500/);
    const [task] = w.db.ofType('T');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, 'HTTP 500');
    const [cp] = w.db.ofType('C');
    assert.equal(cp.status, 'failed');
    assert.equal(cp.output, 'Checkpoint failed at task 1/1');
    assert.deepEqual(w.envelope._cp_spine.map((s) => s.status), ['failed', 'pending']);
    assert.deepEqual(w.envelope.step_ledger, {}, 'its ledger entries are cleared so the next attempt re-runs it');
    assertLegalHistory(w.history);
  });

  it('a retry that succeeds carries the checkpoint on', async () => {
    const w = world({ script: { motor: [broken('HTTP 500'), done('Collected.')], cerebellum: [pass()] } });
    const out = await w.run(PLAN.slice(0, 1));
    assert.equal(out.success, true);
  });

  it('an optional task is not retried', async () => {
    const w = world({ script: { motor: [broken('HTTP 500')] } });
    await w.run([{ instruction: 'x', accept_criteria: 'y', tasks: [{ agent: 'motor', task: 'Try the optional enrichment', _optional: true }] }]);
    assert.equal(w.agents.of('motor').length, 1);
  });

  it('an organ that cannot run tasks fails without creating a task envelope', async () => {
    const w = world();
    const out = await w.run([{ instruction: 'x', accept_criteria: 'y', tasks: [{ agent: 'cortex', task: 'Plan more' }] }]);
    assert.equal(out.success, false);
    assert.match(out.results[0].result, /Invalid task organ "cortex"/);
    assert.equal(w.db.ofType('T').length, 0, 'no task envelope left active forever');
    assert.equal(w.agents.calls.length, 0);
  });

  it('a task with no organ is skipped and the rest of the checkpoint runs', async () => {
    const w = world({ script: { motor: [done('Collected.')], cerebellum: [pass()] } });
    const out = await w.run([{ instruction: 'x', accept_criteria: 'y', tasks: [{ task: 'No organ here' }, { agent: 'motor', task: 'Collect' }] }]);
    assert.match(out.results[0].result, /^\[SKIPPED\]/);
    assert.equal(w.agents.of('motor').length, 1);
  });

  it('a recovered sub-command error is annotated for the verifier, not failed', async () => {
    const answer = 'Found 14 service accounts and 3 instances across the project. '.repeat(5);
    const w = world({
      script: {
        motor: [done(answer, '[TOOL] runCommand({"command":"count"}) → [ERROR] command failed', '[TOOL] runCommand({"command":"list"}) → ok')],
        cerebellum: [pass()],
      },
    });
    const out = await w.run([{ instruction: 'Inventory', accept_criteria: 'All accounts listed', tasks: [{ agent: 'motor', task: 'Inventory the service accounts' }] }]);
    assert.equal(out.success, true);
    assert.equal(w.agents.of('motor').length, 1, 'not retried');
    assert.match(out.results[0].result, /\[EVIDENCE WARNING: a tool call reported "Command failed"/);
  });

  it('a reply cut at the token limit is retried with the file-then-summarize nudge', async () => {
    const w = world({ script: { motor: [{ ...done('partial'), finishReason: 'length' }, done('Wrote it to dump.json.')], cerebellum: [pass()] } });
    await w.run(PLAN.slice(0, 1));
    assert.match(w.agents.of('motor')[1].payload.instruction, /\[TRUNCATION\]/);
  });

  it('a timeout is retried as an unknown outcome, and a final timeout is marked so on its row', async () => {
    const w = world({ script: { motor: [broken('The operation timed out after 300s'), { ...broken('The operation timed out after 300s'), timedOut: true }] } });
    const out = await w.run(PLAN.slice(0, 1));
    assert.match(w.agents.of('motor')[1].payload.instruction, /\[TIMEOUT\][\s\S]*UNKNOWN, not failed/);
    assert.equal(out.results[0].timedOut, true, 'finalization does not count an unknown outcome as failed work');
  });

  it('a callAgent that throws is a failed turn, not a crash', async () => {
    const w = world({ script: { motor: [new Error('socket hang up'), done('Collected.')], cerebellum: [pass()] } });
    const out = await w.run(PLAN.slice(0, 1));
    assert.equal(out.success, true);
    assert.match(w.agents.of('motor')[1].payload.instruction, /Previous attempt failed: socket hang up/);
  });
});

describe('a failed milestone halts the mission', () => {
  it('nothing proceeds past it: the next checkpoint never runs', async () => {
    const w = world({
      envelope: mission({ _cp_spine: buildSpine(PLAN, { now: ISO0 }) }),
      script: { motor: [done('Collected north and south.')], cerebellum: [fail('east and west are missing')] },
    });
    const out = await w.run(PLAN);
    assert.equal(out.success, false);
    assert.equal(w.agents.of('motor').length, 1, 'checkpoint 2 never ran');
    const verdict = out.results.find((r) => r.step === '1.verify');
    assert.equal(verdict.success, false);
    assert.match(verdict.result, /^\[CHECKPOINT VERIFICATION FAILED\][\s\S]*east and west are missing\nRecommendation: Add the missing region\./);
    assert.deepEqual(w.envelope._cp_spine.map((s) => s.status), ['failed', 'pending']);
    const [cp] = w.db.ofType('C');
    assert.equal(cp.status, 'failed');
    assert.equal(cp.output, 'Checkpoint failed: milestone verification not passed (1/1 tasks ran)');
    assert.deepEqual(w.envelope.step_ledger, {}, 'its tasks re-run on the next attempt');
    assertLegalHistory(w.history);
  });

  it('an inconclusive milestone halts too, flagged for review and not called failed work', async () => {
    const w = world({ script: { motor: [done('Collected.')], cerebellum: [empty(), empty(), empty()] } });
    const out = await w.run(PLAN);
    assert.equal(out.success, false);
    assert.equal(w.agents.of('motor').length, 1);
    const verdict = out.results.find((r) => r.step === '1.verify');
    assert.equal(verdict.inconclusive, true);
    assert.equal(w.db.ofType('C')[0].needs_review, true);
  });

  it('a verification that cannot run fails closed', async () => {
    const unreadable = { success: true, get output() { throw new Error('malformed reply'); } };
    const w = world({ script: { motor: [done('Collected.')], cerebellum: [unreadable] } });
    const out = await w.run(PLAN);
    assert.equal(out.success, false);
    assert.match(out.results.find((r) => r.step === '1.verify').result, /^\[CHECKPOINT VERIFICATION INCONCLUSIVE\] Verification could not run \(malformed reply\)/);
  });

  it('a checkpoint planned without criteria is still judged, on its stated outcome', async () => {
    const w = world({ script: { motor: [done('Collected.')], cerebellum: [pass()] } });
    await w.run([{ instruction: 'Gather the regional figures', tasks: [{ agent: 'motor', task: 'Collect' }] }]);
    assert.match(w.agents.of('cerebellum')[0].payload.instruction, /The checkpoint's stated outcome is achieved: "Gather the regional figures"/);
  });
});

// ── Verification through the executor ────────────────────────────────

describe('milestone verification', () => {
  it('a pass on compact evidence is re-verified on the complete evidence, and the complete verdict wins', async () => {
    const MIDDLE = 'WEST-REGION-TABLE-EMPTY';
    const long = `Wrote report.md.\n${'north row\n'.repeat(60)}${MIDDLE}\n${'south row\n'.repeat(60)}`;
    const w = world({
      settings: { ctxAgentStep: 400 },
      script: { motor: [{ success: true, output: long, durationMs: 20000 }], cerebellum: [pass(), fail('the west table is empty')] },
    });
    const out = await w.run(PLAN.slice(0, 1));
    const prompts = w.agents.of('cerebellum').map((c) => c.payload.instruction);
    assert.doesNotMatch(prompts[0], new RegExp(MIDDLE), 'the first look saw a cut row');
    assert.match(prompts[1], /## Complete Evidence/);
    assert.match(prompts[1], new RegExp(MIDDLE));
    assert.equal(out.success, false, 'the pass on the partial view did not stand');
  });

  it('a pass whose adversarial check is inconclusive stands only as met with a caveat, surfaced on the mission', async () => {
    const w = world({
      envelope: mission({ stakes: 'consequential' }),
      script: { motor: [done('Collected.')], cerebellum: [pass(), empty()] },
    });
    const out = await w.run(PLAN.slice(0, 1));
    assert.equal(out.success, true, 'met with a caveat is a pass');
    assert.match(w.agents.of('cerebellum')[1].payload.instruction, /Now try to overturn it \(stakes: consequential\)/);
    const verdict = out.results.find((r) => r.step === '1.verify');
    assert.equal(verdict.success, true);
    assert.match(verdict.result, /^\[MILESTONE MET — WITH CAVEAT\]/);
    assert.deepEqual(w.envelope._milestone_caveats, [`CP1: ${CAVEATS.attackInconclusive}`]);
    assert.deepEqual(w.db.work('w-m1')._milestone_caveats, w.envelope._milestone_caveats);
  });

  it('the complete-evidence re-check reads stored tool results back through the client', async () => {
    const stored = `STORED-SHEET-ROWS ${'r'.repeat(200)}`;
    const out = `Read it back.${toolLog(`[TOOL] runCommand({"command":"sheet-read"}) → [digest of ${stored.length} chars — full result: ${REF}]\nfour regions, totals match`)}`;
    const w = world({
      seed: { [REF]: { result: stored } },
      script: { motor: [{ success: true, output: out, durationMs: 20000 }], cerebellum: [pass(), pass()] },
    });
    await w.run(PLAN.slice(0, 1));
    assert.match(w.agents.of('cerebellum')[1].payload.instruction, /STORED-SHEET-ROWS/);
  });
});

// ── A skip ────────────────────────────────────────────────────────────

describe('a checkpoint with no tasks left to run', () => {
  it('is marked complete on the spine, every time, and the plan moves on', async () => {
    const w = world({
      envelope: mission({ _cp_spine: buildSpine(PLAN, { now: ISO0 }) }),
      script: { motor: [done('Drafted.'), done('Proofread.')], cerebellum: [pass()] },
    });
    const out = await w.run(PLAN, { startCpIndex: 0, startTaskIndex: 1 });
    assert.equal(out.success, true);
    assert.deepEqual(w.envelope._cp_spine.map((s) => s.status), ['complete', 'complete']);
    assert.equal(w.envelope._cp_spine[0].completed_at, ISO0);
    assert.deepEqual(w.agents.of('motor').map((c) => c.payload.instruction.split('\n')[0]), ['Draft report.md from figures.csv', 'Proofread report.md']);
    const [first] = w.db.ofType('C');
    assert.equal(first.status, 'complete');
    assert.equal(first.output, 'Skipped: no tasks left to run');
  });

  it('a checkpoint paused at a gate that ended it is completed through active, legally', async () => {
    const cp = {
      id: 'w-c1', type: 'C', parent_id: 'w-m1', status: 'awaiting_approval', intent: 'checkpoint', instruction: 'Approve the draft',
      accept_criteria: 'Approval granted.', children: [], source_meta: { checkpoint: 1, approval_id: 'apr-0' }, created_at: ISO0, started_at: ISO0, updated_at: ISO0, iteration: 0,
    };
    const w = world({
      envelope: mission({ status: 'awaiting_approval', children: ['w-c1'], _cp_spine: buildSpine(PLAN, { now: ISO0 }) }),
      seed: { [`${COLLECTIONS.work}/w-c1`]: cp },
      script: { motor: [done('Drafted.'), done('Proofread.')], cerebellum: [pass()] },
    });
    await w.run(PLAN, { startCpIndex: 0, startTaskIndex: 1 });
    assert.equal(w.db.work('w-c1').status, 'complete');
    assert.equal(w.db.ofType('C').length, 2, 'the paused checkpoint was reused, not duplicated');
    assert.deepEqual(w.history.filter(([id]) => id === 'w-c1').map(([, from, to]) => [from, to]), [['awaiting_approval', 'active'], ['active', 'complete']]);
    assertLegalHistory(w.history);
  });
});

// ── Approval gates ────────────────────────────────────────────────────

describe('an approval gate', () => {
  // A weekly briefing: checkpoint 1 already ran (its result is banked), checkpoint 2 opens on a gate.
  const GATED = [
    {
      instruction: "Gather this week's notes and write the briefing",
      accept_criteria: 'A draft briefing exists',
      tasks: [{ agent: 'motor', task: 'Gather and synthesize.' }],
    },
    {
      instruction: 'Publish and verify the briefing',
      accept_criteria: 'The branded doc exists and reads back',
      tasks: [
        { agent: 'motor', type: 'approval_gate', task: "Trash any existing copy of today's briefing and create a new one. Approve to proceed.", accept_criteria: 'Approval granted.' },
        { agent: 'motor', task: "Trash today's earlier copy, create the branded doc, and read it back." },
      ],
    },
  ];
  const PRIOR = [{ step: '1.1', agent: 'motor', success: true, result: 'Saved four transcripts from this week and drafted the briefing.' }];

  async function raise(plan, { envelope = mission(), startCpIndex = 1, savedResults = PRIOR, deps = {} } = {}) {
    const notified = [];
    const w = world({
      envelope,
      deps: { summarizeForDelivery: async (type, raw, ctx) => { notified.push({ type, raw, ctx }); return raw; }, ...deps },
    });
    const out = await w.run(plan, { startCpIndex, savedResults });
    const notification = w.db.ofType('T').find((t) => t.intent === 'notification');
    return { ...w, out, notified, notification, approval: w.approvals[0] };
  }

  it('pauses the mission without running the gated work', async () => {
    const { out, agents, envelope, db } = await raise(GATED);
    assert.equal(out.paused, true);
    assert.equal(out.approvalId, 'apr-2');
    assert.equal(agents.calls.length, 0, 'nothing may run before the gate is approved');
    assert.equal(envelope.status, 'awaiting_approval');
    assert.equal(db.work('w-m1').status, 'awaiting_approval');
    const [cp] = db.ofType('C');
    assert.equal(cp.status, 'awaiting_approval');
    assert.equal(cp.source_meta.approval_id, 'apr-2');
    assert.equal(cp.source_meta.approval_task_index, 0);
  });

  it('records who asked and the conversation it came from', async () => {
    const { approval } = await raise(GATED);
    assert.equal(approval.record.requestedBy, USER);
    assert.equal(approval.record.source_thread, 'th-1');
    assert.equal(approval.record.envelopeId, 'w-m1');
    assert.equal(approval.record.checkpointIndex, 1);
    assert.equal(approval.record.taskIndex, 0);
    assert.equal(approval.record.status, 'pending');
    assert.equal(approval.record._processed, false, 'the poller only finds approvals stamped unprocessed');
  });

  it('stores the resume state the approval poller continues from', async () => {
    const { envelope } = await raise(GATED);
    const meta = envelope.source_meta;
    assert.equal(meta.paused_approval_id, 'apr-2');
    assert.equal(meta.paused_checkpoint_index, 1);
    assert.equal(meta.paused_task_index, 0);
    assert.deepEqual(meta.paused_checkpoints, GATED);
    assert.deepEqual(meta.paused_all_results.map((r) => r.step), ['1.1']);
    assert.equal(meta.sender, USER, 'the rest of source_meta is kept');
  });

  it("describes what runs once approved, never the gate's own pass condition", async () => {
    const { approval } = await raise(GATED);
    assert.notEqual(approval.record.description, 'Approval granted.');
    assert.equal(approval.record.description, "If approved, this runs next: Trash today's earlier copy, create the branded doc, and read it back.");
  });

  it('a gate that ends its checkpoint describes the next checkpoint', async () => {
    const { approval } = await raise([
      { instruction: 'Draft the briefing', tasks: [{ agent: 'motor', type: 'approval_gate', task: 'Approve the draft.', accept_criteria: 'Approval granted.' }] },
      { instruction: 'Publish the briefing to the output folder', tasks: [{ agent: 'motor', task: 'Publish.' }] },
    ], { startCpIndex: 0, savedResults: [] });
    assert.equal(approval.record.description, 'If approved, this runs next: Publish the briefing to the output folder');
  });

  it("a scheduled mission's gate is delivered, not internal, and records that no person asked", async () => {
    const { notification, approval } = await raise(GATED, {
      envelope: mission({ parent_id: 'w-r1', source_channel: 'scheduler', source_meta: { responsibility_id: 'r-weekly-briefing' } }),
    });
    assert.equal(notification.delivery_status, 'pending');
    assert.deepEqual(notification.delivery_address, { channel: 'dashboard', thread: null });
    assert.equal(notification.parent_id, 'w-m1');
    assert.equal(approval.record.requestedBy, '');
    assert.equal(approval.record.source_thread, '');
  });

  it("a person's gate is delivered to the conversation it came from", async () => {
    const { notification } = await raise(GATED);
    assert.equal(notification.delivery_status, 'pending');
    assert.deepEqual(notification.delivery_address, { channel: 'dashboard', thread: 'th-1' });
    assert.equal(notification.source_meta.approval_id, 'apr-2');
    assert.equal(notification.status, 'complete');
  });

  it('a Google Chat request is answered in its space and thread', async () => {
    const { notification } = await raise(GATED, {
      envelope: mission({ source_channel: 'gchat', source_meta: { sender: USER, address: { channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/T1' } } }),
    });
    assert.deepEqual(notification.delivery_address, { channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/T1' });
  });

  it("the brain's own address resolver wins when it passes one", async () => {
    const { notification } = await raise(GATED, { deps: { addressFromMeta: () => ({ channel: 'dashboard', thread: 'resolved' }) } });
    assert.deepEqual(notification.delivery_address, { channel: 'dashboard', thread: 'resolved' });
  });

  it('the notification writer gets the work done so far and what runs next', async () => {
    const { notified, notification } = await raise(GATED);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].type, 'approval_request');
    assert.match(notified[0].ctx.customMessage, /^If approved, this runs next:/);
    assert.deepEqual(notified[0].ctx.steps.map((s) => s.step), ['1.1'], 'a gate that opens its checkpoint still reports the earlier work');
    assert.equal((notification.output.match(/Approval needed/g) || []).length, 1, 'framed once, not twice');
    assert.match(notification.output, /Reply `approve` or `reject` here, or use the dashboard\.$/);
  });

  it('every status change on the way to the pause is legal', async () => {
    const { history } = await raise(GATED);
    assertLegalHistory(history);
    assert.ok(history.some(([id, from, to]) => id === 'w-m1' && from === 'active' && to === 'awaiting_approval'));
  });

  it('an approval that cannot be written raises nothing and pauses nothing', async () => {
    const w = world({ approvalsOk: false });
    await assert.rejects(() => w.run(GATED, { startCpIndex: 1, savedResults: PRIOR }), (e) => e instanceof ApprovalNotRaised && e.missionId === 'w-m1');
    assert.equal(w.envelope.status, 'active', 'a mission paused on an approval nobody can see would wait forever');
    assert.equal(w.db.work('w-m1').status, 'active');
    assert.equal(w.db.ofType('C')[0].status, 'active');
    assert.equal(w.db.ofType('T').length, 0, 'no notification for a gate that does not exist');
  });

  it('resumed after approval, the plan continues at the task after the gate', async () => {
    const paused = await raise(GATED);
    const meta = paused.envelope.source_meta;
    const w = world({
      envelope: structuredClone(paused.envelope),
      seed: Object.fromEntries([...paused.db.docs.entries()].filter(([path]) => path !== `${COLLECTIONS.work}/w-m1`)),
      script: { motor: [done('Created the branded doc and read it back.')], cerebellum: [pass()] },
    });
    const out = await w.run(meta.paused_checkpoints, {
      startCpIndex: meta.paused_checkpoint_index,
      startTaskIndex: meta.paused_task_index + 1,
      savedResults: meta.paused_all_results,
    });
    assert.equal(out.success, true);
    assert.equal(w.agents.of('motor').length, 1);
    assert.match(w.agents.of('motor')[0].payload.instruction, /^Trash today's earlier copy/);
    assert.equal(w.envelope.status, 'active');
    assert.equal(w.db.ofType('C').length, 1, 'the paused checkpoint is resumed, not duplicated');
    assert.equal(w.db.ofType('C')[0].status, 'complete');
    assert.ok(w.history.some(([id, from, to]) => id === 'w-m1' && from === 'awaiting_approval' && to === 'active'));
    assert.match(w.agents.of('cerebellum')[0].payload.instruction, /## Previously Established[\s\S]*Saved four transcripts/, 'checkpoint 1 is earlier, established work');
    assertLegalHistory(w.history);
  });

  it("a gate inside a checkpoint: after approval, the work before the gate is judged as that checkpoint's own", async () => {
    const plan = [{
      instruction: 'Draft, approve and publish the briefing',
      accept_criteria: 'The briefing is drafted and published',
      tasks: [
        { agent: 'motor', task: 'Draft the briefing' },
        { agent: 'motor', type: 'approval_gate', task: 'Approve publishing the draft' },
        { agent: 'motor', task: 'Publish the briefing' },
      ],
    }];
    const first = world({ script: { motor: [done('DRAFT-WRITTEN')] } });
    const paused = await first.run(plan);
    assert.equal(paused.paused, true);
    const meta = first.envelope.source_meta;
    assert.deepEqual(meta.paused_all_results.map((r) => r.step), ['1.1']);

    const w = world({
      envelope: structuredClone(first.envelope),
      seed: Object.fromEntries([...first.db.docs.entries()].filter(([path]) => path !== `${COLLECTIONS.work}/w-m1`)),
      script: { motor: [done('PUBLISHED')], cerebellum: [pass()] },
    });
    const out = await w.run(meta.paused_checkpoints, {
      startCpIndex: meta.paused_checkpoint_index,
      startTaskIndex: meta.paused_task_index + 1,
      savedResults: meta.paused_all_results,
    });
    assert.equal(out.success, true);
    assert.deepEqual(out.results.map((r) => r.step), ['1.1', '1.3']);
    const prompt = w.agents.of('cerebellum')[0].payload.instruction;
    assert.match(prompt, /## Combined Task Outputs[\s\S]*DRAFT-WRITTEN[\s\S]*PUBLISHED/);
    assert.doesNotMatch(prompt, /Previously Established/, 'unverified work is never presented as verified');
  });
});

describe('requesterOf', () => {
  it('is the sender the ears recorded, or empty', () => {
    assert.equal(requesterOf({ source_meta: { sender: ` ${USER} ` } }), USER);
    assert.equal(requesterOf({ source_meta: {} }), '');
    assert.equal(requesterOf({ source_meta: { sender: 'agent' } }), '', 'never the agent itself');
    assert.equal(requesterOf(null), '');
  });
});

// ── The memory boundary ───────────────────────────────────────────────

describe('a memory-scoped mission', () => {
  it('runs its tasks on the memory organ and refuses a gate', async () => {
    const w = world({
      envelope: mission({ source_meta: { effect_scope: 'memory', responsibility_id: 'r-memory-consolidation' } }),
      script: { 'temporal-memory': [{ success: true, output: 'Consolidated; wrote consolidation_report.md.', durationMs: 30000 }], cerebellum: [pass()] },
    });
    const out = await w.run([{
      instruction: 'Consolidate memory',
      accept_criteria: 'consolidation_report.md lists every change',
      tasks: [
        { agent: 'motor', task: 'Rewrite MEMORY.md and the project context' },
        { agent: 'motor', type: 'approval_gate', task: 'Approve the consolidation' },
      ],
    }]);
    assert.equal(out.paused, undefined, 'a memory mission never pauses on a gate');
    assert.equal(out.success, true);
    assert.deepEqual(w.agents.calls.map((c) => c.organ), ['temporal-memory', 'cerebellum'], 'motor never runs');
    assert.equal(w.agents.of('temporal-memory')[0].payload._exec, true, 'the memory organ gets its memory tools');
    assert.equal(w.approvals.length, 0);
    const refused = out.results.find((r) => r.step === '1.2');
    assert.equal(refused.agent, 'system');
    assert.match(refused.result, /^\[REFUSED\] a memory-scoped mission may not open an approval gate/);
  });
});

// ── State and bookkeeping ─────────────────────────────────────────────

describe('envelope status changes go through the transition table', () => {
  it('a finished mission cannot be run', async () => {
    const w = world({ envelope: mission({ status: 'complete', completed_at: ISO0 }) });
    await assert.rejects(() => w.run(PLAN), /illegal envelope transition/);
    assert.equal(w.agents.calls.length, 0);
  });

  it('a queued mission is made active first', async () => {
    const w = world({ envelope: mission({ status: 'queued', started_at: null }), script: { motor: [done('Collected.')], cerebellum: [pass()] } });
    await w.run(PLAN.slice(0, 1));
    assert.deepEqual(w.history.find(([id]) => id === 'w-m1').slice(1, 3), ['queued', 'active']);
    assert.equal(w.envelope.started_at, ISO0);
  });

  it('under the observe guard an illegal move is logged and applied', async () => {
    const w = world({ envelope: mission({ status: 'complete', completed_at: ISO0 }), settings: { transitionGuard: 'observe' }, script: { motor: [done('Collected.')], cerebellum: [pass()] } });
    const out = await w.run(PLAN.slice(0, 1));
    assert.equal(out.success, true);
  });
});

describe('the resource ledger', () => {
  it('seeds ids the request states, captures ids from tool output, and hands both to the next task', async () => {
    const created = '{"status":"created","name":"Q3 Regional Report","id":"1Q3REPORTDOC0000000000000009","mimeType":"application/vnd.google-apps.document"}';
    const w = world({
      envelope: mission({ instruction: 'Write the report and file it in the In Progress folder (1INPROGRESSFOLDER0000000000000009).' }),
      script: {
        motor: [done('Created the doc.', `[TOOL] runCommand({"command":"drive-put"}) → ${created}`), done('Filed it.')],
        cerebellum: [pass(), pass()],
      },
    });
    await w.run([
      { instruction: 'Create the report', accept_criteria: 'the doc exists', tasks: [{ agent: 'motor', task: 'Create the Q3 Regional Report doc' }] },
      { instruction: 'File the report', accept_criteria: 'the doc is in In Progress', tasks: [{ agent: 'motor', task: 'Move the Q3 Regional Report doc into the In Progress folder' }] },
    ]);
    const ledger = w.envelope.context.resources;
    assert.equal(Object.values(ledger).find((r) => r.name === 'In Progress').id, '1INPROGRESSFOLDER0000000000000009');
    assert.equal(Object.values(ledger).find((r) => r.name === 'Q3 Regional Report').source, '1.1');
    const second = w.agents.of('motor')[1].payload.instruction;
    assert.match(second, /## Known Resources[\s\S]*1Q3REPORTDOC0000000000000009/);
    assert.match(second, /1INPROGRESSFOLDER0000000000000009/);
    assert.match(second, /PRECEDENCE, strongest first/);
  });
});
