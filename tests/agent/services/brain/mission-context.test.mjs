// Tests for agent/services/brain/mission-context.mjs: the context a mission carries between decisions:
// its accumulated blocks and their prune, the bound on results, rolling compaction into a validated
// digest, fetching a result's full content by ref, and the blackboard in the mission tree.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import { brainSettings } from '../../../../agent/services/brain/settings.mjs';
import { accumulateContext, boundPriorResults, createMissionContext, PRIOR_RESULTS_MAX } from '../../../../agent/services/brain/mission-context.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const settings = brainSettings(loadContracts());
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

test('each iteration adds a block naming the latest result; a person\'s input is kept', () => {
  const first = accumulateContext({ priorResults: [{ agent: 'human', result: 'Use Q3' }], memory: { recalled: 'Q2 was in /reports' }, iteration: 1, timestamp: 'T1', tokenBudget: 1000, sliceChars: 2000 });
  assert.equal(first.text, '--- Iteration 1 (T1) ---\nHuman input: Use Q3\nMemory: Q2 was in /reports');
  const second = accumulateContext({ accumulated: first.text, priorResults: [{ agent: 'motor', task: 'Write', result: 'long', summary: 'Wrote report.md' }], iteration: 2, timestamp: 'T2', tokenBudget: 1000, sliceChars: 2000 });
  assert.match(second.text, /--- Iteration 2 \(T2\) ---\nDecision: dispatch to motor\nTask: Write\nResult: Wrote report\.md$/);
  assert.equal(accumulateContext({ accumulated: 'x', priorResults: [{ agent: 'system', result: 'nudge' }], iteration: 3, timestamp: 'T3', tokenBudget: 1000, sliceChars: 10 }).text, 'x', 'a system note adds nothing');
});

test('over budget, the true middle is pruned: the framing and the recent half are kept', () => {
  let text = '';
  for (let i = 1; i <= 20; i++) text = accumulateContext({ accumulated: text, priorResults: [{ agent: 'motor', result: 'r'.repeat(100) }], iteration: i, timestamp: `T${i}`, tokenBudget: 100_000, sliceChars: 10 }).text;
  const pruned = accumulateContext({ accumulated: text, priorResults: [{ agent: 'motor', result: 'last' }], iteration: 21, timestamp: 'T21', tokenBudget: 500, sliceChars: 10 });
  assert.equal(pruned.pruned, 21 - 2 - 10);
  assert.match(pruned.text, /^--- Iteration 1 \(T1\)/);
  assert.match(pruned.text, /\[9 iterations pruned for context budget\]/);
  assert.match(pruned.text, /--- Iteration 21 \(T21\) ---[\s\S]*Result: last$/);
});

test('results past the maximum fold into one summary entry', () => {
  const results = Array.from({ length: PRIOR_RESULTS_MAX + 1 }, (_, i) => ({ agent: 'motor', result: `r${i}` }));
  assert.equal(boundPriorResults(results), true);
  assert.equal(results.length, Math.floor(PRIOR_RESULTS_MAX * 0.6) + 1);
  assert.match(results[0].result, /^\[PRIOR WORK SUMMARY\]\nmotor: r0/);
  assert.equal(boundPriorResults(results), false);
});

function context({ digest = null } = {}) {
  const store = createEnvelopeStore({ db, clock: () => NOW });
  const vertexText = { calls: 0, async transform() { this.calls += 1; return digest; } };
  const missionsRoot = mkdtempSync(join(tmpdir(), 'mc-'));
  const mc = createMissionContext({ store, vertexText, settings, missionDir: (id) => join(missionsRoot, id) });
  return { store, vertexText, mc, missionsRoot };
}

const bigContext = () => Array.from({ length: 12 }, (_, i) => `--- Iteration ${i + 1} (T) ---\nResult: ${'x'.repeat(4000)}`).join('\n\n');

test('compaction folds the middle iterations into a validated digest and keeps the recent ones', async () => {
  const digest = JSON.stringify({ covered_iterations: '1..7', decisions: [{ iteration: 1, action: 'checkpoint_plan' }], claims: [{ text: 'report.md written', bin: 'verified' }], open_questions: [], durable_learnings: ['Use the shared template'] });
  const { store, mc, vertexText } = context({ digest });
  const env = { id: 'w-1', type: 'M', status: 'active', instruction: 'Write the report', accept_criteria: 'covers Q3', iteration: 12, _accumulated_context: bigContext() };
  await store.save({ ...env, source_channel: 'dashboard', intent: 'decide', created_at: '2026-10-17T11:00:00.000Z', updated_at: '2026-10-17T11:00:00.000Z' });
  const seq = await mc.compact(env, { lastPromptTokens: 90_000 });
  assert.equal(seq, 1);
  assert.equal(vertexText.calls, 1);
  assert.match(env._accumulated_context, /\[CONTEXT COMPACTED — seq 1 — iterations 1\.\.7\]\nMission instruction \(verbatim\): Write the report\nAccept criteria \(verbatim\): covers Q3/);
  assert.equal((env._accumulated_context.match(/--- Iteration /g) || []).length, 6, 'the framing block and the five recent iterations are kept word for word');
  assert.deepEqual(env._compaction.durable_learnings, ['Use the shared template']);
  const saved = await store.read('w-1');
  assert.equal(saved._compaction.seq, 1);
  assert.equal(saved.instruction, 'Write the report', 'the splice is field-masked');
});

test('below its threshold, or with a digest that fails validation, nothing is spliced', async () => {
  const { mc } = context({ digest: '{"action":"synthesize"}' });
  const env = { id: 'w-2', instruction: 'x', _accumulated_context: bigContext() };
  assert.equal(await mc.compact({ ...env, _accumulated_context: 'short' }), 0);
  assert.equal(await mc.compact(env, { lastPromptTokens: 90_000 }), 0);
  assert.equal(env._compaction, undefined);
});

test('the full content of a ref: a stored tool result, or a task\'s output with its digests restored', async () => {
  const { mc, store } = context();
  await db.write(`${COLLECTIONS.toolResults}/tr-1`, { result: 'FULL LISTING' });
  await db.write(`${COLLECTIONS.work}/w-task`, { output: 'Listed.\n---\n[TOOL EXECUTION LOG]\n[TOOL] ls({}) → [digest of 12 chars — full result: tool_results/tr-1]\na listing\n[END TOOL LOG]' });
  const env = { id: 'w-1' };
  const results = [];
  assert.equal(await mc.hydrate(env, ['tool_results/tr-1', 'w-task'], results), 'fetched');
  assert.equal(results[0].result, '[FULL CONTENT ref=tool_results/tr-1]\nFULL LISTING');
  assert.match(results[1].result, /\[full result, 12 chars — tool_results\/tr-1\]\nFULL LISTING/);
  assert.equal(await mc.hydrate(env, ['w-task'], results), 'nothing_new', 'each ref once per mission');
  assert.match(results.at(-1).result, /already provided/);
  env._hydrated_refs = Array.from({ length: settings.hydrate.maxRefs }, (_, i) => `x${i}`);
  assert.equal(await mc.hydrate(env, ['w-new'], results), 'nothing_new', 'past the per-mission cap');
  assert.ok(store);
});

test('the blackboard is written into the mission tree, never fatally', () => {
  const { mc, missionsRoot } = context();
  mc.writeBlackboard({ id: 'w-1', type: 'M', instruction: 'Write the report' }, [{ agent: 'motor', checkpoint_step: '1.1', summary: 'Wrote it', ref: 'w-t' }], 2);
  const text = readFileSync(join(missionsRoot, 'w-1', 'MISSION.md'), 'utf8');
  assert.match(text, /Write the report/);
  assert.match(text, /\[1\.1\] motor/);
  mc.writeBlackboard({ id: 'w-2', type: 'C' }, [], 1);
  assert.equal(existsSync(join(missionsRoot, 'w-2')), false, 'only a mission has one');
});
