// Tests for agent/services/brain/actions/index.mjs: the legal moves agree with the schema the cortex's
// output is held to and with the moves the cortex's prompt teaches. A prompt that names a move the
// brain rejects costs a wasted turn every time; a move the brain handles that the schema drops can
// never be chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_HANDLERS, ACTION_NAMES } from '../../../../../agent/services/brain/actions/index.mjs';
import { CORTEX_SCHEMAS } from '../../../../../agent/providers/vertex-text.mjs';
import { REPO_ROOT } from '../harness.mjs';

/** Moves that existed once and are gone. Naming one anywhere the cortex reads is a defect. */
const RETIRED = ['delegate', 'project_bootstrap', 'follow_process', 'execute_process', 'run_process', 'simple_dispatch'];

test('the legal moves are exactly the schema\'s, each with a handler', () => {
  assert.deepEqual([...ACTION_NAMES].sort(), [...CORTEX_SCHEMAS.decide.properties.action.enum].sort());
  for (const name of ACTION_NAMES) assert.equal(typeof ACTION_HANDLERS[name], 'function', name);
  for (const retired of RETIRED) assert.ok(!ACTION_NAMES.includes(retired), `${retired} is not a move`);
});

test('the cortex\'s prompt teaches exactly the legal moves, and the classifications the brain acts on', () => {
  const prompt = readFileSync(join(REPO_ROOT, 'prompts', 'cortex.md'), 'utf8');
  const section = prompt.slice(prompt.indexOf('## Choosing a move'), prompt.indexOf('### Route by outcome'));
  const taught = [...section.matchAll(/^- \*\*([a-z_]+)\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(taught.sort(), [...ACTION_NAMES].sort());
  const classifying = prompt.slice(prompt.indexOf('## Classifying what comes in'), prompt.indexOf('## The request under the request'));
  const classes = [...classifying.matchAll(/\*\*([a-z_]+)\*\*/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(classes)].sort(), [...CORTEX_SCHEMAS.classify.properties.classification.enum].sort());
  for (const retired of RETIRED) assert.doesNotMatch(prompt, new RegExp(`\\b${retired}\\b`), `${retired} is not taught`);
});
