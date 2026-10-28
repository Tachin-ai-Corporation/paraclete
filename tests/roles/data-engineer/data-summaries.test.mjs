// Tests for roles/data-engineer/prompts/ and agent/services/brain/main.mjs: the data-engineer organ
// prompts include the rules for deterministic local data file transformations and JSON summary
// read-back verification, and buildBrain omits the Mission Tree path from task messages when
// artifacts are disabled so the motor works in its seeded workspace directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadOrganPrompt } from '../../../agent/gateway/organs.mjs';
import { drainRunner, organScript, REPO_ROOT, startBrain, toolLog, writeIntake } from '../../agent/services/brain/harness.mjs';

const dirs = {
  promptsDir: join(REPO_ROOT, 'prompts'),
  rolePromptsDir: join(REPO_ROOT, 'roles', 'data-engineer', 'prompts'),
};

test('data-engineer organ prompts cover reproducible local data summaries and read-back verification', () => {
  const cortex = loadOrganPrompt('cortex', dirs);
  const motor = loadOrganPrompt('motor', dirs);
  const cerebellum = loadOrganPrompt('cerebellum', dirs);

  assert.match(cortex, /Local data files and summaries stay reproducible/);
  assert.match(cortex, /Capability-First Artifact Protocol/);
  assert.match(motor, /When transforming local data files \(CSV, TSV, JSON\) into a summary or output file/);
  assert.match(motor, /read it back with `readFile` and parse it to confirm[\s\S]+valid syntax/);
  assert.match(cerebellum, /\*\*A data file or JSON summary:\*\* read the written output file with `readFile`, parse it,[\s\S]+re-derive/);
});

test('buildBrain omits Mission Tree from task messages when artifacts are disabled', async () => {
  const taskMessages = [];
  const h = await startBrain({
    respond: organScript({
      decisions: [{ action: 'checkpoint_plan' }],
      task: (turn) => {
        taskMessages.push(turn.user);
        return `Completed data transformation.${toolLog(['[TOOL] readFile({"path":"output.json"}) → {"ok":true}'])}`;
      },
    }),
  });
  try {
    await h.brain.init();
    await writeIntake(h.db, { text: 'Summarize the local dataset into output.json' });
    await h.brain.tickIntake();
    await drainRunner(h.brain);
    assert.equal(taskMessages.length, 1);
    assert.doesNotMatch(taskMessages[0], /## Mission Tree/);
    assert.match(taskMessages[0], /## Task/);
  } finally {
    await h.stop();
  }
});
