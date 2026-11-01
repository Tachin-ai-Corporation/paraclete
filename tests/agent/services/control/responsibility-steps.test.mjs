// Tests for agent/services/control/responsibilities.mjs: listResponsibilities() returns the full
// untruncated instruction past 200 characters and the steps array from context.process (including
// overrides), and returns an empty steps array when a responsibility has no context.process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listResponsibilities } from '../../../../agent/services/control/responsibilities.mjs';
import { fakeDb, controlRuntime } from './fakes.mjs';

const LONG_INSTRUCTION = 'Run the full weekly operational review across every active project: '
  + 'collect completed missions, inspect unresolved blockers, verify artifact bundle integrity, '
  + 'reconcile project context entries against recent findings, and deliver a concise summary report '
  + 'with concrete next actions for the team.';

const WITH_STEPS = {
  id: 'r-weekly-review',
  name: 'Weekly review',
  schedule: '0 9 * * 1',
  timezone: 'UTC',
  enabled: true,
  instruction: LONG_INSTRUCTION,
  success_criteria: 'The weekly review report was delivered.',
  context: {
    purpose: 'Keep projects aligned each week.',
    process: [
      'List all active projects.',
      'Summarize missions completed in the past 7 days.',
      'Write and deliver the weekly report.',
    ],
  },
};

const PLAYBOOK_ONLY = {
  id: 'r-playbook-only',
  name: 'Playbook check',
  schedule: '0 10 * * *',
  timezone: 'UTC',
  enabled: true,
  processRef: 'p-check',
  instruction: 'Run the daily check following its playbook.',
  success_criteria: 'The daily check completed.',
};

const NO_PROCESS = {
  id: 'r-bare-event',
  name: 'On complete notice',
  event: 'on_complete',
  enabled: true,
  instruction: 'Record a completion note when a mission finishes.',
  success_criteria: 'The completion note was recorded.',
};

const NOW = new Date('2026-10-17T12:00:00.000Z');

function setup(db = fakeDb()) {
  const runtime = controlRuntime({ db });
  writeFileSync(
    join(runtime.paths.genericRole, 'responsibilities.json'),
    JSON.stringify({ version: 1, responsibilities: [WITH_STEPS, PLAYBOOK_ONLY, NO_PROCESS] }),
  );
  return {
    db,
    store: {
      db,
      contracts: runtime.contracts,
      paths: runtime.paths,
      instance: runtime.instance,
      log: runtime.log,
      now: () => NOW,
    },
  };
}

test('listResponsibilities returns the full instruction past 200 characters and the steps from context.process', async () => {
  assert.ok(LONG_INSTRUCTION.length > 200, 'test instruction must exceed 200 characters');
  const { store } = setup();
  const { responsibilities, issues, store_error } = await listResponsibilities(store);
  assert.equal(store_error, null);
  assert.deepEqual(issues, []);

  const byId = Object.fromEntries(responsibilities.map((r) => [r.id, r]));

  assert.equal(byId['r-weekly-review'].instruction, LONG_INSTRUCTION);
  assert.equal(byId['r-weekly-review'].instruction.length, LONG_INSTRUCTION.length);
  assert.equal(byId['r-weekly-review'].has_process, true);
  assert.equal(byId['r-weekly-review'].process_steps, 3);
  assert.deepEqual(byId['r-weekly-review'].steps, [
    'List all active projects.',
    'Summarize missions completed in the past 7 days.',
    'Write and deliver the weekly report.',
  ]);

  assert.equal(byId['r-playbook-only'].has_process, true);
  assert.equal(byId['r-playbook-only'].process_steps, 0);
  assert.deepEqual(byId['r-playbook-only'].steps, []);

  assert.equal(byId['r-bare-event'].has_process, false);
  assert.equal(byId['r-bare-event'].process_steps, 0);
  assert.deepEqual(byId['r-bare-event'].steps, []);
});

test('listResponsibilities returns overridden steps and long instructions from the store', async () => {
  const { db, store } = setup();
  const overriddenInstruction = `${LONG_INSTRUCTION} Include a dedicated section for incidents and follow-ups.`;
  const overriddenSteps = [
    'Gather active projects and recent incidents.',
    'Cross-check unresolved blockers.',
    'Publish the expanded weekly review.',
    'Record follow-up tasks.',
  ];
  db.set('responsibilities/r-weekly-review', {
    id: 'r-weekly-review',
    mode: 'override',
    patch: {
      instruction: overriddenInstruction,
      context: { process: overriddenSteps },
    },
    revision: 3,
    status: 'active',
    updated_by: 'admin@example.com',
  });

  const { responsibilities, issues } = await listResponsibilities(store);
  assert.deepEqual(issues, []);
  const byId = Object.fromEntries(responsibilities.map((r) => [r.id, r]));

  assert.equal(byId['r-weekly-review'].origin, 'override');
  assert.equal(byId['r-weekly-review'].instruction, overriddenInstruction);
  assert.equal(byId['r-weekly-review'].has_process, true);
  assert.equal(byId['r-weekly-review'].process_steps, 4);
  assert.deepEqual(byId['r-weekly-review'].steps, overriddenSteps);
});
