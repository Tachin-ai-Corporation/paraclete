// Tests for agent/services/brain/envelope-runner.mjs, through a whole brain against fakes: which
// mission runs next, a cancel honored at the next decision, errors retried and then failed (a storage
// or gateway outage is not a verdict), an approval that could not be raised retried, the decide loop's
// guards and nudges, results fetched by ref, a session reopened after a miss, capabilities refreshed at
// a mission boundary, and effort applied to every organ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { resumeContext } from '../../../../agent/services/brain/envelope-runner.mjs';
import { startBrain, writeIntake, drainRunner, organScript, toolLog, verdict, START } from './harness.mjs';

const at = new Date(START).toISOString();
const missionDoc = (id, status, over = {}) => ({
  id, type: 'M', parent_id: null, status, intent: 'decide', title: `Mission ${id}`, instruction: `Do ${id}`, accept_criteria: null,
  context_summary: null, output: null, children: [], context_forward: null, error: null, source_channel: 'dashboard',
  source_meta: { address: { channel: 'dashboard', thread: 'th-1' }, sender: 'person@example.com' }, project_id: 'general',
  created_at: at, started_at: status === 'queued' ? null : at, completed_at: null, updated_at: at, iteration: 0,
  memory_context: { recalled: 'Nothing relevant.' }, delivery_status: 'internal', ...over,
});
const decides = (t) => t.gateway.of('cortex').filter((x) => x.user.includes('"mode":"decide"'));

test('the context a resumed plan hands the cortex says what happened, with each result at the preview budget', () => {
  const rows = [{ step: '1.1', agent: 'motor', success: true, result: `Deployed. ${'x'.repeat(2000)} HTTP 200 from production` }];
  const done = resumeContext(rows, false, 3000);
  assert.match(done, /^\[CHECKPOINT PLAN RESULTS — every step COMPLETED on resume; SYNTHESIZE the deliverable[\s\S]*Do NOT re-plan or re-request an approval already granted/);
  assert.match(done, /HTTP 200 from production/, 'the outcome is not cut away');
  assert.match(resumeContext(rows, true, 3000), /a step FAILED on resume; use synthesize_with_failure or needs_input/);
});

test('a mission ready to continue runs before a queued one; a held one and one waiting on a dependency do not run', async () => {
  const t = await startBrain();
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-queued-old`, missionDoc('w-queued-old', 'queued', { created_at: '2026-10-17T10:00:00.000Z' }));
    await t.db.write(`${COLLECTIONS.work}/w-queued-new`, missionDoc('w-queued-new', 'queued', { created_at: '2026-10-17T11:00:00.000Z' }));
    await t.db.write(`${COLLECTIONS.work}/w-blocked-dep`, missionDoc('w-blocked-dep', 'queued', { created_at: '2026-10-17T09:00:00.000Z', depends_on: ['w-queued-new'] }));
    await t.db.write(`${COLLECTIONS.work}/w-resumed`, missionDoc('w-resumed', 'active', { context_forward: 'Q3' }));
    await t.db.write(`${COLLECTIONS.work}/w-held`, missionDoc('w-held', 'active', { claimed_by: 'claim-live', claimed_at_ms: START }));
    const ran = await drainRunner(t.brain, 3);
    assert.deepEqual(ran, ['w-resumed', 'w-queued-old', 'w-queued-new']);
    assert.equal((await t.read(`${COLLECTIONS.work}/w-held`)).status, 'active', 'never two processors on one mission');
    await drainRunner(t.brain, 1);
    assert.equal((await t.read(`${COLLECTIONS.work}/w-blocked-dep`)).status, 'complete', 'its dependency done, it runs');
  } finally {
    await t.stop();
  }
});

test('a cancel for the running mission stops it at its next decision, with its children', async () => {
  const t = await startBrain();
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued', { children: ['w-c'] }));
    await t.db.write(`${COLLECTIONS.work}/w-c`, { ...missionDoc('w-c', 'active'), type: 'C', parent_id: 'w-1' });
    t.brain.parts.runner.requestCancel('w-1', 'the person said stop');
    await drainRunner(t.brain);
    const m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.deepEqual([m.status, m.cancelled_reason], ['cancelled', 'the person said stop']);
    assert.equal((await t.read(`${COLLECTIONS.work}/w-c`)).status, 'cancelled');
    assert.equal(decides(t).length, 0, 'no decision was made after the cancel');
    const note = (await t.work()).find((w) => w.intent === 'notification');
    assert.match(note.output, /Cancelled mission: "Mission w-1"/);
  } finally {
    await t.stop();
  }
});

test('a gateway that cannot answer is retried later, not a verdict; an error that persists fails the mission with its reason', async () => {
  const t = await startBrain({ respond: organScript({ respond: (turn) => (turn.user.includes('"mode":"decide"') ? { status: 500, error: 'both models failed' } : undefined) }) });
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain, 1);
    let m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.deepEqual([m.status, m.claimed_by], ['active', null], 'still active, released for another try');
    assert.deepEqual(await drainRunner(t.brain), [], 'not before the retry delay');
    t.advance(61_000);
    await drainRunner(t.brain, 1);
    t.advance(61_000);
    await drainRunner(t.brain, 1);
    m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.equal(m.status, 'failed');
    assert.match(m.output, /hit the same error 3 times[\s\S]*the cortex could not be reached: HTTP 500/);
  } finally {
    await t.stop();
  }
});

test('an approval gate that could not be written is retried later from the saved plan, never failed', async () => {
  const gated = { action: 'checkpoint_plan', checkpoints: [{ instruction: 'Ship', accept_criteria: 'shipped', tasks: [
    { agent: 'motor', task: 'Approve shipping', step_type: 'approval_gate' }, { agent: 'motor', task: 'Ship it' },
  ] }] };
  const t = await startBrain({ respond: organScript({ decisions: [gated] }) });
  try {
    await t.brain.init();
    const create = t.brain.parts.approvals.create;
    t.brain.parts.approvals.create = async () => false;
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain, 1);
    let m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.equal(m.status, 'active');
    assert.equal(m._cp_progress.checkpointIndex, 0);
    assert.equal((await t.docs(COLLECTIONS.approvals)).length, 0);
    t.brain.parts.approvals.create = create;
    t.advance(61_000);
    await drainRunner(t.brain, 1);
    m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.equal(m.status, 'awaiting_approval', 'the second attempt raised the gate from the saved plan');
    assert.equal(decides(t).length, 1, 'no new plan was made for the retry');
  } finally {
    await t.stop();
  }
});

test('a reply that cannot be read is asked again; an unknown move is named and the legal ones listed', async () => {
  const c = structuredClone(loadContracts());
  c.session.enabled = false;
  const t = await startBrain({ contracts: c, respond: organScript({ decisions: ['I think we should plan', { action: 'retask' }, { action: 'synthesize', synthesis: 'Done.' }] }) });
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain);
    assert.equal((await t.read(`${COLLECTIONS.work}/w-1`)).status, 'complete');
    const d = decides(t);
    assert.match(d[1].user, /could not be parsed as JSON/);
    assert.match(d[2].user, /Invalid action \\"retask\\"\. Valid actions: checkpoint_plan, synthesize, synthesize_with_failure, needs_input, blocked, status_update, wait, trigger_responsibility/);
  } finally {
    await t.stop();
  }
});

test('a mission that reaches its decision limit fails, saying so', async () => {
  const c = structuredClone(loadContracts());
  c.brain.max_iterations = 3;
  const t = await startBrain({ contracts: c, respond: organScript({ decisions: Array(5).fill({ action: 'status_update', message: 'still going' }) }) });
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain);
    const m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.equal(m.status, 'failed');
    assert.match(m.output, /limit of 3 decisions/);
  } finally {
    await t.stop();
  }
});

test('a result the cortex asks for by ref comes back in full before it decides again', async () => {
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'synthesize', request_context: ['tool_results/tr-9'] }, { action: 'synthesize', synthesis: 'The list has 40 rows.' }] }) });
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.toolResults}/tr-9`, { result: 'ROW-1 ... ROW-40' });
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain);
    assert.equal((await t.read(`${COLLECTIONS.work}/w-1`)).status, 'complete');
    assert.match(decides(t)[1].user, /FULL CONTENT ref=tool_results\/tr-9.*ROW-1 \.\.\. ROW-40/);
    assert.deepEqual((await t.read(`${COLLECTIONS.work}/w-1`))._hydrated_refs, ['tool_results/tr-9']);
  } finally {
    await t.stop();
  }
});

test('a synthesis the verifier failed cannot be repeated: the move is turned into an honest failure', async () => {
  const t = await startBrain({
    respond: organScript({
      decisions: [
        { action: 'checkpoint_plan', goal: 'Write the report' },
        { action: 'synthesize', synthesis: 'Everything reconciled.' },
        { action: 'synthesize', synthesis: 'Everything reconciled, really.' },
      ],
      verify: (turn) => (turn.user.includes('mission synthesis') ? verdict(false, { reasoning: 'nothing shows the reconciliation' }) : verdict(true)),
    }),
  });
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued', { accept_criteria: 'The report reconciles revenue and costs' }));
    await drainRunner(t.brain);
    const m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.equal(m._swf_state, 'unblock_attempted', 'the repeated synthesize was forced to synthesize_with_failure, which checked once before accepting');
    assert.equal(m.status, 'complete', 'the work had succeeded: the honest synthesis is delivered');
    const synthesisChecks = t.gateway.of('cerebellum').filter((x) => x.user.includes('mission synthesis')).length;
    assert.ok(synthesisChecks <= 3, `a judged answer is not re-verified in a loop (${synthesisChecks} checks)`);
  } finally {
    await t.stop();
  }
});

test('a session the gateway lost is reopened with the full context in the same turn', async () => {
  let t;
  t = await startBrain({
    respond: organScript({
      decisions: [{ action: 'status_update', message: 'starting' }, { action: 'status_update', message: 'midway' }, { action: 'status_update', message: 'again' }, { action: 'synthesize', synthesis: 'Done.' }],
      respond: (turn) => { if (turn.user.includes('midway')) t.gateway.sessions.clear(); return undefined; },
    }),
  });
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain);
    assert.equal((await t.read(`${COLLECTIONS.work}/w-1`)).status, 'complete');
    const ops = t.gateway.turns.filter((x) => x.organ === 'cortex' && x.session).map((x) => (x.miss ? `miss:${x.miss}` : x.session.op));
    assert.deepEqual(ops, ['open', 'continue', 'continue', 'miss:absent', 'open']);
    assert.equal((await t.read(`${COLLECTIONS.work}/w-1`))._session.generation, 2);
  } finally {
    await t.stop();
  }
});

test('a skill the agent wrote is in the next mission\'s capability map', async () => {
  const t = await startBrain();
  try {
    await t.brain.init();
    const dir = join(t.runtime.paths.data.skills, 'invoice-filing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill.json'), JSON.stringify({ id: 'invoice-filing', name: 'Invoice Filing', when_to_use: 'Filing invoices into the ledger', organs: ['motor'] }));
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain);
    assert.match(decides(t)[0].user, /Invoice Filing — Filing invoices into the ledger/);
  } finally {
    await t.stop();
  }
});

test('effort, every instance\'s admin setting, warms every organ the brain calls', async () => {
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'checkpoint_plan', goal: 'x' }] }) });
  try {
    await t.db.write(`${COLLECTIONS.config}/settings`, { effort: 'high' });
    await t.brain.init();
    await t.brain.tickIntake();
    assert.equal(t.brain.effort.level, 'high');
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'queued'));
    await drainRunner(t.brain);
    const temp = (organ) => t.gateway.of(organ)[0].body.temperature;
    assert.ok(Math.abs(temp('cortex') - 0.56) < 1e-9);
    assert.ok(Math.abs(temp('motor') - 0.42) < 1e-9);
    assert.ok(Math.abs(temp('cerebellum') - 0.14) < 1e-9);
  } finally {
    await t.stop();
  }
});

test('an approved mission whose paused plan is gone decides again instead of stranding', async () => {
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'synthesize', synthesis: 'Picked up where it stood.' }] }) });
  try {
    await t.brain.init();
    await t.db.write(`${COLLECTIONS.work}/w-1`, missionDoc('w-1', 'active', { source_meta: { address: { channel: 'dashboard', thread: 'th-1' }, paused_approval_id: 'apr-1' } }));
    await drainRunner(t.brain);
    const m = await t.read(`${COLLECTIONS.work}/w-1`);
    assert.equal(m.status, 'complete');
    assert.equal(m.source_meta.paused_approval_id, undefined);
  } finally {
    await t.stop();
  }
});

test('startup recovery queues a responsibility\'s mission a restart left pending', async () => {
  const t = await startBrain();
  try {
    await t.db.write(`${COLLECTIONS.work}/w-r`, { ...missionDoc('w-r', 'pending'), parent_id: 'w-req', source_meta: { responsibility_id: 'r-git-gc' } });
    await t.db.write(`${COLLECTIONS.work}/w-dep`, { ...missionDoc('w-dep', 'pending'), parent_id: 'w-req', source_meta: { responsibility_id: 'r-x' }, depends_on: ['w-other'] });
    await t.brain.init();
    assert.equal((await t.read(`${COLLECTIONS.work}/w-r`)).status, 'queued');
    assert.equal((await t.read(`${COLLECTIONS.work}/w-dep`)).status, 'pending', 'one waiting on a dependency is left to it');
  } finally {
    await t.stop();
  }
});

test('the motor\'s tool record survives into the next decision as a packet with its ref', async () => {
  const t = await startBrain({
    respond: organScript({
      decisions: [{ action: 'checkpoint_plan', goal: 'List the files' }],
      task: () => `Listed 3 files: a.txt, b.txt, c.txt.${toolLog(['[TOOL] runCommand({"command":"ls"}) → a.txt b.txt c.txt'])}`,
    }),
  });
  try {
    await t.brain.init();
    await writeIntake(t.db, { text: 'List the files' });
    await t.brain.tickIntake();
    await drainRunner(t.brain);
    const second = decides(t)[1].user;
    assert.match(second, /"checkpoint_step":"1\.1"/);
    assert.match(second, /"ref":"w-/);
    assert.match(second, /PASSED verification/);
  } finally {
    await t.stop();
  }
});
