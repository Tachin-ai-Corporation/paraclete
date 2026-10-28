// Tests for agent/services/brain/main.mjs and its unit, paraclete-brain.service: the whole brain,
// wired by buildBrain() against the Firestore fake and a fake gateway, through the paths a mission
// takes: a request that becomes a planned, executed, verified and delivered mission; a respond; an
// answer that continues a mission; an approval gate paused, approved and resumed; a crash resumed
// from saved progress; a timed wait resumed; a scheduled responsibility and a control trigger; and a
// memory-scoped mission. Every envelope the run writes is checked against the declared work schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { WORK_SCHEMA, APPROVAL_SCHEMA, PROJECT_SCHEMA } from '../../../../agent/work/work-schema.mjs';
import { validate, fieldPaths } from '../../../../agent/work/validate-schema.mjs';
import { createServiceRuntime } from '../../../../agent/services/service-runtime.mjs';
import { buildBrain } from '../../../../agent/services/brain/main.mjs';
import { startBrain, writeIntake, drainRunner, organScript, toolLog, eventually, REPO_ROOT, START } from './harness.mjs';

const posixPath = (p) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');

/** Every envelope in the work collection is a valid, declared record. */
async function assertWorkDeclared(t) {
  const work = await t.work();
  assert.ok(work.length > 0);
  const declared = new Set(fieldPaths(WORK_SCHEMA.spec));
  const problems = [];
  for (const env of work) {
    for (const key of Object.keys(env)) if (!declared.has(key)) problems.push(`${env.id}: ${key} is not declared`);
    for (const key of Object.keys(env.source_meta || {})) {
      if (!declared.has(`source_meta.${key}`)) problems.push(`${env.id}: source_meta.${key} is not declared`);
    }
    const { errors } = validate(WORK_SCHEMA, env);
    for (const e of errors) problems.push(`${env.id} (${env.type} ${env.intent}): ${e.path} ${e.message}`);
  }
  assert.deepEqual(problems, []);
  return work;
}

test('importing the service starts nothing, and it wires from a real service runtime', async () => {
  const mod = await import('../../../../agent/services/brain/main.mjs');
  assert.equal(typeof mod.buildBrain, 'function');
  assert.equal(typeof mod.main, 'function');

  const dir = mkdtempSync(join(tmpdir(), 'brain-runtime-'));
  const tokenFile = join(dir, 'gateway-token');
  writeFileSync(tokenFile, 'secret-token\n');
  const instancePath = join(dir, 'instance.json');
  writeFileSync(instancePath, JSON.stringify({
    project: 'your-gcp-project', region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete', role: 'generic',
    install_root: posixPath(REPO_ROOT), data_root: posixPath(join(dir, 'data')), bucket: 'your-gcp-project-paraclete',
    gateway_token_file: posixPath(tokenFile),
  }));
  const runtime = createServiceRuntime({ service: 'brain', instancePath, getAccessToken: async () => 't', fetch: async () => ({ ok: false }), write: () => {} });
  const brain = buildBrain(runtime);
  assert.equal(typeof brain.tickIntake, 'function');
  assert.equal(brain.parts.gateway.token, 'secret-token', 'the token comes from instance.gateway_token_file');
  assert.equal(brain.effort.level, 'medium', 'effort starts at contracts.effort.default for every instance');
});

test('a request becomes a mission that is planned, executed, verified and delivered', async () => {
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'checkpoint_plan', goal: 'Write the quarterly report' }] }) });
  try {
    await t.brain.init();
    await writeIntake(t.db, { text: 'Please write the quarterly report' });
    await t.brain.tickIntake();

    const intake = await t.read(`${COLLECTIONS.intake}/i-dashboard-m1`);
    assert.equal(intake.status, 'consumed');
    const queued = (await t.work()).find((w) => w.type === 'M');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.instruction, 'Write the quarterly report');
    assert.equal(queued.source_meta.sender, 'person@example.com');
    assert.equal(queued.project_id, 'general', 'a mission with no project goes to the default project');
    const ack = (await t.work()).find((w) => w.intent === 'ack');
    assert.equal(ack.delivery_status, 'pending');
    assert.deepEqual(ack.delivery_address, { channel: 'dashboard', thread: 'th-1' });
    assert.equal(intake.consumed_by, queued.id);
    const ackTurn = t.gateway.of('cortex').find((x) => x.user.includes('Acknowledge this message briefly'));
    assert.match(ackTurn.system[0], /Your personality:\n# Identity\n\nYou are a paraclete/, 'the acknowledgment speaks in the voice of prompts/identity.md');
    assert.ok(ackTurn.user.startsWith('[BRAIN-ORCHESTRATED]'));

    // The inbound turn is in the thread ledger.
    const turn = await t.read(`${COLLECTIONS.threads}/th-1/turns/m1`);
    assert.equal(turn.role, 'user');

    const ran = await drainRunner(t.brain);
    assert.deepEqual(ran, [queued.id]);
    const mission = await t.read(`${COLLECTIONS.work}/${queued.id}`);
    assert.equal(mission.status, 'complete');
    assert.equal(mission.delivery_status, 'pending', 'the mouth delivers it');
    assert.deepEqual(mission.delivery_address, { channel: 'dashboard', thread: 'th-1' });
    assert.match(mission.output, /The report is ready/);
    assert.equal(mission.claimed_by, null, 'the claim is released');
    assert.equal(mission._cp_spine[0].status, 'complete');
    assert.equal(mission.memory_written, true);

    const organs = t.gateway.turns.map((x) => x.organ);
    for (const o of ['prefrontal', 'motor', 'cerebellum']) assert.ok(organs.includes(o), `${o} ran`);
    const motor = t.gateway.of('motor')[0];
    assert.equal(motor.body.exec, true, 'a checkpoint task runs with its tools');
    assert.match(motor.user, /## Requester\nThe person who asked for this work: person@example.com/);
    assert.match(motor.user, /## Task\nWrite report\.md/);
    assert.match(readFileSync(t.runtime.paths.data.workingMemoryFile, 'utf8'), /M: Write the quarterly report -> The report is ready/);

    // The decide turns: the first opens the cortex's session, the next continues it with a delta.
    const decides = t.gateway.of('cortex').filter((x) => x.user.includes('"mode":"decide"'));
    assert.equal(decides[0].session.op, 'open');
    assert.equal(decides[1].session.op, 'continue');
    assert.match(decides[1].user, /WORKING STATE \(delta\)/);
    assert.ok(t.gateway.deletes.length > 0, 'the session is closed when the run ends');

    const health = JSON.parse(readFileSync(join(t.root, 'services', 'brain', 'health.json'), 'utf8'));
    assert.equal(health.service, 'brain');
    assert.equal(health.beat_at, new Date(START).toISOString());
    assert.equal(health.intake.handled, 1);

    await assertWorkDeclared(t);
    for (const p of await t.docs(COLLECTIONS.projects)) assert.deepEqual(validate(PROJECT_SCHEMA, p).errors, []);
  } finally {
    await t.stop();
  }
});

test("every envelope the brain creates carries the installed release's version; older envelopes keep what they had", async () => {
  const releaseFile = /[\\/]release\.json$/;
  const readText = (path) => (releaseFile.test(path)
    ? JSON.stringify({ version: 'v2026.10.18.1.1', commit: 'a'.repeat(40) })
    : readFileSync(path, 'utf8'));
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'checkpoint_plan', goal: 'Write the quarterly report' }] }), deps: { readText } });
  try {
    const older = {
      id: 'w-older', type: 'M', parent_id: null, status: 'complete', intent: 'decide', title: 'Older work', instruction: 'Older work',
      accept_criteria: null, children: [], source_channel: 'dashboard', source_meta: {}, project_id: 'general',
      created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:30:00.000Z', completed_at: '2026-10-01T09:30:00.000Z', iteration: 1,
    };
    await t.db.write(`${COLLECTIONS.work}/w-older`, older);
    await t.brain.init();
    await writeIntake(t.db, { text: 'Please write the quarterly report' });
    await t.brain.tickIntake();
    await drainRunner(t.brain);

    const created = (await t.work()).filter((w) => w.id !== 'w-older');
    assert.deepEqual([...new Set(created.map((w) => w.type))].sort(), ['C', 'M', 'T'], 'the mission, its checkpoints and its tasks');
    assert.deepEqual(created.filter((w) => w.platform_version !== 'v2026.10.18.1.1').map((w) => `${w.id} ${w.type} ${w.intent}`), []);

    await t.brain.parts.store.save({ ...(await t.brain.parts.store.read('w-older')), id: 'w-older', updated_at: new Date(START).toISOString() });
    assert.ok(!('platform_version' in (await t.read(`${COLLECTIONS.work}/w-older`))), 'an envelope from before the brain started is not attributed to it');
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }

  const unknown = await startBrain();
  try {
    await unknown.brain.init();
    await writeIntake(unknown.db, { text: 'Please write the quarterly report' });
    await unknown.brain.tickIntake();
    const work = await unknown.work();
    assert.ok(work.length > 0 && work.every((w) => w.platform_version === null), 'no release.json: every envelope says so with null');
    assert.equal(unknown.logs.filter((l) => /release\.json cannot be read/.test(l.message)).length, 1, 'said once, at start');
  } finally {
    await unknown.stop();
  }
});

test('a conversational turn is answered at once, grounded on the one read it asked for', async () => {
  const t = await startBrain({
    respond: organScript({ classify: { classification: 'respond', reasoning: 'a question about recent work', response: 'Draft', reads: ['recent_work'] }, composed: 'This week I wrote the report.' }),
  });
  try {
    await t.brain.init();
    await writeIntake(t.db, { text: 'What did you do this week?' });
    await t.brain.tickIntake();
    const work = await t.work();
    const reply = work.find((w) => w.intent === 'respond');
    assert.equal(reply.status, 'complete');
    assert.equal(reply.output, 'This week I wrote the report.');
    assert.equal(reply.delivery_status, 'pending');
    assert.equal(work.filter((w) => w.status === 'queued').length, 0, 'nothing is queued');
    const compose = t.gateway.of('cortex').find((x) => x.user.includes('"mode":"respond_compose"'));
    assert.match(compose.user, /\[TOOL RESULT: recent_work\]/);
    assert.deepEqual(await drainRunner(t.brain), []);
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

test('an answer to a mission that asked a question continues that mission', async () => {
  const decisions = [
    { action: 'needs_input', question: 'Which quarter?' },
    { action: 'synthesize', synthesis: 'Wrote the Q3 report.', answer: 'Q3 report ready.' },
  ];
  const t = await startBrain({
    respond: organScript({
      decisions,
      respond: (turn) => {
        if (turn.organ === 'cortex' && turn.user.includes('"mode":"classify"') && turn.user.includes('Q3 please')) {
          const id = turn.user.match(/"id":"(w-[^"]+)","type":"M","instruction":"Write the quarterly report","status":"needs_input"/)?.[1];
          return JSON.stringify({ classification: 'continue', reasoning: 'answers the question', continue_mission: id, instruction: 'Q3' });
        }
        return undefined;
      },
    }),
  });
  try {
    await t.brain.init();
    await writeIntake(t.db, { text: 'Write the quarterly report' });
    await t.brain.tickIntake();
    await drainRunner(t.brain);
    let mission = (await t.work()).find((w) => w.type === 'M');
    assert.equal(mission.status, 'needs_input');
    assert.equal(mission.output, 'Which quarter?');
    assert.equal(mission.delivery_status, 'pending');

    await writeIntake(t.db, { id: 'i-dashboard-m2', text: 'Q3 please', at: '2026-10-17T12:01:00.000Z' });
    await t.brain.tickIntake();
    mission = await t.read(`${COLLECTIONS.work}/${mission.id}`);
    assert.equal(mission.status, 'active', 'a resume moves the mission to active; the runner takes it');
    assert.equal(mission.context_forward, 'Q3 please');
    assert.equal(mission.delivery_status, 'internal', 'the earlier delivery is done; the next starts afresh');
    assert.equal((await t.work()).filter((w) => w.type === 'M').length, 1, 'no second mission');

    await drainRunner(t.brain);
    mission = await t.read(`${COLLECTIONS.work}/${mission.id}`);
    assert.equal(mission.status, 'complete');
    const lastDecide = t.gateway.of('cortex').filter((x) => x.user.includes('"mode":"decide"')).pop();
    assert.match(lastDecide.user, /Q3 please/, 'the answer reaches the cortex');
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

const GATED_PLAN = {
  action: 'checkpoint_plan',
  checkpoints: [{
    instruction: 'Publish the site',
    accept_criteria: 'The site is live',
    tasks: [
      { agent: 'motor', task: 'Build the site', accept_criteria: 'built' },
      { agent: 'motor', task: 'Approve the production deploy', step_type: 'approval_gate' },
      { agent: 'motor', task: 'Deploy the site to production', accept_criteria: 'live' },
    ],
  }],
};

test('an approval gate pauses the mission; "approve" resumes it at the task after the gate', async () => {
  const t = await startBrain({
    respond: organScript({
      decisions: [GATED_PLAN, { action: 'synthesize', synthesis: 'Built and deployed.', answer: 'The site is live.' }],
      task: (turn) => `${turn.user.includes('Deploy the site') ? 'Deployed to production' : 'Built the site'}.${toolLog(['[TOOL] runCommand({"command":"make"}) → wrote dist/index.html'])}`,
    }),
  });
  try {
    await t.brain.init();
    await writeIntake(t.db, { text: 'Publish the site' });
    await t.brain.tickIntake();
    await drainRunner(t.brain);

    let mission = (await t.work()).find((w) => w.type === 'M');
    assert.equal(mission.status, 'awaiting_approval');
    assert.equal(mission.source_meta.paused_task_index, 1);
    const [approval] = await t.docs(COLLECTIONS.approvals);
    assert.equal(approval.status, 'pending');
    assert.equal(approval.requestedBy, 'person@example.com');
    assert.equal(approval.source_thread, 'th-1');
    assert.deepEqual(validate(APPROVAL_SCHEMA, approval).errors, []);
    const request = (await t.work()).find((w) => w.source_meta?.notification_type === 'approval_gate');
    assert.equal(request.delivery_status, 'pending');
    assert.equal(t.gateway.of('motor').length, 1, 'nothing past the gate ran');

    await writeIntake(t.db, { id: 'i-dashboard-m2', text: 'approve', at: '2026-10-17T12:02:00.000Z' });
    await t.brain.tickIntake();
    const resolved = await t.read(`${COLLECTIONS.approvals}/${approval.id}`);
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.resolvedBy, 'person@example.com');
    assert.equal(resolved._processed, true, 'the poller acted on it at once');
    assert.deepEqual(validate(APPROVAL_SCHEMA, { ...resolved, id: approval.id }).errors, []);
    assert.equal((await t.read(`${COLLECTIONS.intake}/i-dashboard-m2`)).status, 'resolved_approval');
    const receipt = (await t.work()).find((w) => w.title === 'Approval approved');
    assert.match(receipt.output, /Approved: Approve the production deploy/);
    assert.equal(receipt.parent_id, mission.id);
    mission = await t.read(`${COLLECTIONS.work}/${mission.id}`);
    assert.equal(mission.status, 'active');

    await drainRunner(t.brain);
    mission = await t.read(`${COLLECTIONS.work}/${mission.id}`);
    assert.equal(mission.status, 'complete');
    const motorTasks = t.gateway.of('motor').map((x) => x.user.match(/## Task\n(.*)/)[1]);
    assert.deepEqual(motorTasks, ['Build the site', 'Deploy the site to production'], 'the deploy ran once, after the gate; the build did not repeat');
    assert.equal(mission.source_meta.paused_approval_id, undefined, 'the paused state is cleared');
    const decides = t.gateway.of('cortex').filter((x) => x.user.includes('"mode":"decide"'));
    assert.match(decides[decides.length - 1].user, /COMPLETED on resume; SYNTHESIZE/);
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

test('a mission the brain was running when it restarted resumes from its saved progress', async () => {
  const t = await startBrain();
  try {
    const at = new Date(START).toISOString();
    const plan = [
      { instruction: 'Gather the numbers', accept_criteria: 'numbers gathered', tasks: [{ agent: 'motor', task: 'Gather the numbers' }] },
      { instruction: 'Write the report', accept_criteria: 'report written', tasks: [{ agent: 'motor', task: 'Write the report from the numbers' }] },
    ];
    await t.db.write(`${COLLECTIONS.work}/w-crashed`, {
      id: 'w-crashed', type: 'M', parent_id: null, status: 'active', intent: 'decide', title: 'Quarterly report',
      instruction: 'Write the quarterly report', accept_criteria: 'The report exists', context_summary: null, output: null,
      children: [], context_forward: null, error: null, source_channel: 'dashboard',
      source_meta: { address: { channel: 'dashboard', thread: 'th-9' }, sender: 'person@example.com' },
      project_id: 'general', created_at: at, started_at: at, completed_at: null, updated_at: at, iteration: 1,
      memory_context: { recalled: 'Nothing relevant.' }, delivery_status: 'internal',
      claimed_by: 'claim-from-a-gone-process', claimed_at_ms: START,
      _cp_spine: [
        { n: 1, outcome: 'Gather the numbers', accept_criteria: 'numbers gathered', tasks: plan[0].tasks, status: 'complete' },
        { n: 2, outcome: 'Write the report', accept_criteria: 'report written', tasks: plan[1].tasks, status: 'pending' },
      ],
      _cp_progress: { checkpointIndex: 1, taskIndex: 0, allResults: [{ step: '1.1', agent: 'motor', result: 'Numbers: 42', success: true }], checkpoints: plan },
    });
    await t.brain.init();
    assert.equal((await t.read(`${COLLECTIONS.work}/w-crashed`)).claimed_by, null, 'startup releases a gone process\'s claim');
    await drainRunner(t.brain);
    const mission = await t.read(`${COLLECTIONS.work}/w-crashed`);
    assert.equal(mission.status, 'complete');
    const tasks = t.gateway.of('motor').map((x) => x.user.match(/## Task\n(.*)/)[1]);
    assert.deepEqual(tasks, ['Write the report from the numbers'], 'only the checkpoint left to run ran');
    assert.equal(mission._cp_progress, null);
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

test('a timed wait pauses the mission and the brain resumes it when the time comes', async () => {
  const t = await startBrain({
    respond: organScript({
      decisions: [
        { action: 'wait', minutes: 5, reason: 'letting the deploy settle', then: 'Check the deploy is healthy' },
        { action: 'synthesize', synthesis: 'The deploy is healthy.' },
      ],
    }),
  });
  try {
    await t.brain.init();
    await writeIntake(t.db, { text: 'Deploy and check it' });
    await t.brain.tickIntake();
    await drainRunner(t.brain);
    let mission = (await t.work()).find((w) => w.type === 'M');
    assert.equal(mission.status, 'waiting');
    assert.equal(mission.wait_resume_at, new Date(START + 5 * 60_000).toISOString());
    const notice = (await t.work()).find((w) => w.source_meta?.notification_type === 'wait');
    assert.match(notice.output, /Pausing for 5 minutes/);
    assert.equal(notice.parent_id, mission.id);

    t.advance(4 * 60_000);
    await t.brain.tickIntake();
    assert.equal((await t.read(`${COLLECTIONS.work}/${mission.id}`)).status, 'waiting', 'not before its time');

    t.advance(2 * 60_000);
    await t.brain.tickIntake();
    mission = await t.read(`${COLLECTIONS.work}/${mission.id}`);
    assert.equal(mission.status, 'active');
    assert.equal(mission.wait_resume_at, null);
    assert.match(mission.context_forward, /\[RESUMED AFTER WAIT\]\nCheck the deploy is healthy/);

    await drainRunner(t.brain);
    assert.equal((await t.read(`${COLLECTIONS.work}/${mission.id}`)).status, 'complete');
    const last = t.gateway.of('cortex').filter((x) => x.user.includes('"mode":"decide"')).pop();
    assert.match(last.user, /RESUMED AFTER WAIT/);
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

test('a control trigger is claimed once and fires its responsibility into the queue', async () => {
  const t = await startBrain();
  try {
    await t.brain.init();
    t.brain.parts.responsibilities.scheduler.loadResponsibilities();
    await t.db.write(`${COLLECTIONS.responsibilityTriggers}/cmd-1`, {
      responsibility_id: 'r-git-gc', status: 'pending', bypass_spacing: true,
      requested_by: 'admin@example.com', requested_at: '2026-10-17T11:59:00.000Z', command_id: 'cmd-1',
    });
    // Two passes at once: the compare-and-swap claim lets exactly one fire it.
    const [a, b] = await Promise.all([
      t.brain.parts.responsibilities.checkTriggers(),
      t.brain.parts.responsibilities.checkTriggers(),
    ]);
    assert.equal(a.length + b.length, 1);
    const trigger = await t.read(`${COLLECTIONS.responsibilityTriggers}/cmd-1`);
    assert.equal(trigger.status, 'fired');
    assert.equal(trigger.detail, 'Weekly Git Artifact Cleanup');
    assert.equal(trigger.fired_at, new Date(START).toISOString());

    const mission = await eventually(async () => (await t.work()).find((w) => w.type === 'M' && w.status === 'queued'));
    assert.equal(mission.source_meta.responsibility_id, 'r-git-gc');
    const request = (await t.work()).find((w) => w.type === 'R');
    assert.equal(mission.parent_id, request.id);
    await t.brain.tickIntake();
    assert.equal((await t.work()).filter((w) => w.type === 'M').length, 1, 'a claimed trigger never fires again');
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

test('a scheduled responsibility fires at its time and its mission runs from the queue', async () => {
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'synthesize', synthesis: 'Consolidated every repository.' }] }) });
  try {
    await t.brain.init();
    const { scheduler } = t.brain.parts.responsibilities;
    scheduler.loadResponsibilities();
    scheduler.start(new Date(START));
    scheduler.stop();
    const next = scheduler.getNextFires()['r-git-gc'];
    await scheduler.tick(next);
    const mission = (await t.work()).find((w) => w.type === 'M');
    assert.equal(mission.status, 'queued', 'the scheduler hands the mission to the runner, it does not run it');
    assert.equal(mission.source_meta.responsibility_id, 'r-git-gc');
    await drainRunner(t.brain);
    const done = await t.read(`${COLLECTIONS.work}/${mission.id}`);
    assert.equal(done.status, 'complete');
    assert.equal(done.delivery_status, 'internal', 'a scheduled mission is not delivered to a person');
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

test('a memory-scoped mission runs as one pass on the memory organ and writes no memory line about itself', async () => {
  const t = await startBrain({
    respond: organScript({
      decisions: [{ action: 'checkpoint_plan', goal: 'Consolidate memory' }, { action: 'synthesize', synthesis: 'Consolidated: 2 retired, 1 promoted.' }],
      memoryTask: () => `Consolidated memory.${toolLog(['[TOOL] writeMemoryFile({"path":"consolidation_report.md"}) → wrote 300 bytes'])}`,
    }),
  });
  try {
    await t.brain.init();
    t.brain.parts.responsibilities.scheduler.loadResponsibilities();
    const fired = await t.brain.parts.responsibilities.fire('r-memory-consolidation', { bypassSpacing: true });
    assert.equal(fired.ok, true);
    const mission = await eventually(async () => (await t.work()).find((w) => w.type === 'M' && w.status === 'queued'));
    assert.equal(mission.source_meta.effect_scope, 'memory');
    await drainRunner(t.brain);
    const done = await t.read(`${COLLECTIONS.work}/${mission.id}`);
    assert.equal(done.status, 'complete');
    assert.equal(t.gateway.of('prefrontal').filter((x) => x.user.includes('[PLAN STRUCTURING')).length, 0, 'code plans a memory mission');
    const tasks = t.gateway.of('temporal-memory').filter((x) => x.body.exec === true);
    assert.equal(tasks.length, 1, 'one pass, with the memory tools');
    assert.equal(t.gateway.of('motor').length, 0);
    assert.notEqual(done.memory_written, true, 'a consolidation writes no line about itself into the memory it maintains');
    assert.ok(!existsSync(t.runtime.paths.data.workingMemoryFile) || !/Consolidat/.test(readFileSync(t.runtime.paths.data.workingMemoryFile, 'utf8')));
    await assertWorkDeclared(t);
  } finally {
    await t.stop();
  }
});

test('a skill scan that comes back empty is a failed scan: the capability map it had is kept', async () => {
  const t = await startBrain({ respond: organScript({ decisions: [{ action: 'synthesize', synthesis: 'Done.' }] }) });
  try {
    await t.brain.init();
    const empty = mkdtempSync(join(tmpdir(), 'no-skills-'));
    Object.assign(t.runtime.paths, { skills: empty, genericRole: empty, role: empty });
    t.brain.refreshCapabilities('a scan that read nothing');
    assert.ok(t.logs.some((l) => /skill scan came back empty .*keeping the previous capability map/.test(l.message)));
    await t.db.write(`${COLLECTIONS.work}/w-1`, {
      id: 'w-1', type: 'M', parent_id: null, status: 'queued', intent: 'decide', instruction: 'Say hi', accept_criteria: null,
      source_channel: 'dashboard', source_meta: {}, children: [], created_at: new Date(START).toISOString(), updated_at: new Date(START).toISOString(), iteration: 0,
    });
    await drainRunner(t.brain);
    const decide = t.gateway.of('cortex').find((x) => x.user.includes('"mode":"decide"'));
    assert.match(decide.user, /Checkpoint Plan Structuring/, 'an agent never loses its skills to a scan glitch');
  } finally {
    await t.stop();
  }
});

test('the unit follows the services rules', () => {
  const unit = readFileSync(new URL('../../../../agent/services/brain/paraclete-brain.service', import.meta.url), 'utf8');
  for (const line of [
    'User=paraclete', 'ProtectSystem=strict', 'ReadOnlyPaths=/opt/paraclete /etc/paraclete', 'ReadWritePaths=/var/lib/paraclete',
    'PrivateTmp=yes', 'NoNewPrivileges=yes', 'Restart=always', 'ExecStart=/usr/bin/node /opt/paraclete/agent/services/brain/main.mjs',
    'CapabilityBoundingSet=',
  ]) assert.ok(unit.split('\n').includes(line), `unit has ${line}`);
  assert.match(unit, /After=.*paraclete-gateway\.service/);
});


test('a task message names the mission tree, unless the brain is built with none (deps.missionDir null)', async () => {
  const taskMessage = async (deps) => {
    const messages = [];
    const h = await startBrain({
      deps,
      respond: organScript({
        decisions: [{ action: 'checkpoint_plan' }],
        task: (turn) => {
          messages.push(turn.user);
          return `Done.${toolLog(['[TOOL] readFile({"path":"output.json"}) → {"ok":true}'])}`;
        },
      }),
    });
    try {
      await h.brain.init();
      await writeIntake(h.db, { text: 'Summarize the local dataset into output.json' });
      await h.brain.tickIntake();
      await drainRunner(h.brain);
      return messages[0] || '';
    } finally {
      await h.stop();
    }
  };
  assert.match(await taskMessage({}), /## Mission Tree\nThis mission's id is `w-/, 'an instance writes the work into its mission tree');
  const none = await taskMessage({ missionDir: null });
  assert.doesNotMatch(none, /## Mission Tree/, 'a brain without one, as a harness rollout, names none');
  assert.match(none, /## Task/);
});
