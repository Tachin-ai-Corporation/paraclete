// Tests for agent/services/brain/memory.mjs: recall (the candidates the brain gathers, the packet the
// memory organ builds from them, and its one escalation), the working-memory files, and the records
// a finished mission leaves: its working-memory line and its lessons, never a definition.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import {
  PRELOADED_END, PRELOADED_START, createMemory, createMemoryFiles, parseEscalation, parseResourceFact, renderCoreMemory,
} from '../../../../agent/services/brain/memory.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

function files(initial = '', hardCapChars = 8000) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-'));
  const wm = join(dir, 'memory', 'MEMORY.md');
  if (initial !== null) {
    createMemoryFiles({ workingMemoryFile: wm, deepTruthsFile: join(dir, 'memory', 'DEEP_TRUTHS.md') }).append(initial || ' ');
  }
  return { wm, f: createMemoryFiles({ workingMemoryFile: wm, deepTruthsFile: join(dir, 'memory', 'DEEP_TRUTHS.md'), hardCapChars }) };
}

/** A memory organ that records what it was asked and answers from a list. */
function organ(answers) {
  const calls = [];
  return {
    calls,
    callAgent: async (name, payload) => {
      calls.push({ name, payload });
      const a = answers.shift();
      return a === null ? { success: false, output: null, error: 'down' } : { success: true, output: a ?? 'No relevant context found.' };
    },
  };
}

test('Core Memory renders as cited candidate lines, and promoted ids parse back into the ledger shape', () => {
  assert.equal(renderCoreMemory([{ id: 'b', category: 'patterns', fact: 'x' }]), '- [patterns] (b) x');
  assert.deepEqual(parseResourceFact('drive_folder: "Reports" = 1AbCdEfGhIjK'), { kind: 'drive_folder', name: 'Reports', id: '1AbCdEfGhIjK' });
  assert.equal(parseResourceFact('just a fact'), null);
});

test('an escalation is recognized, and a packet is not one', () => {
  assert.deepEqual(parseEscalation('{"recall_escalate": true, "cues": ["deploy"], "reason": "older"}'), { cues: ['deploy'], reason: 'older' });
  assert.equal(parseEscalation('{"recall_escalate": false}'), null);
  assert.equal(parseEscalation('Here is the packet'), null);
});

test('working memory grows a line at a time, up to its hard cap, and is created when missing', () => {
  const { wm, f } = files(null, 60);
  assert.equal(existsSync(wm), false);
  assert.equal(f.append('- one line\n'), true);
  assert.equal(readFileSync(wm, 'utf8'), '- one line\n');
  assert.equal(f.append(`- ${'x'.repeat(80)}\n`), false, 'past the cap the line waits for the consolidation');
  assert.equal(f.workingMemory(), '- one line\n');
  assert.equal(f.deepTruths(), '');
});

test('recall hands the memory organ every layer between the markers, known resources first', async () => {
  const { f } = files('## Current Focus\nThe quarterly report\n');
  await db.write(`${COLLECTIONS.coreMemory}/cm-1`, { fact: 'Quarterly reports use the finance template', category: 'patterns', status: 'active', importance: 0.8, createdAt: '2026-10-10T00:00:00Z' });
  await db.write(`${COLLECTIONS.coreMemory}/cm-2`, { fact: 'drive_folder: "Quarterly Reports" = 1QrTlyRpts000000000', category: 'resources', status: 'active', createdAt: '2026-10-10T00:00:00Z' });
  await db.write(`${COLLECTIONS.work}/w-old`, { id: 'w-old', type: 'M', status: 'complete', title: 'Q2 quarterly report', instruction: 'Write the Q2 quarterly report', output: 'Done', created_at: '2026-10-15T00:00:00.000Z', completed_at: '2026-10-15T01:00:00.000Z' });
  const o = organ(['Packet: use the finance template; folder 1QrTlyRpts000000000.']);
  const memory = createMemory({ db, callAgent: o.callAgent, files: f, clock: () => NOW });
  const r = await memory.recall('Write the quarterly report', { resources: { 'doc:brief': { kind: 'doc', name: 'Brief', id: '1BriefDoc0000000000' } } });
  assert.equal(r.recalled, 'Packet: use the finance template; folder 1QrTlyRpts000000000.');
  const instruction = o.calls[0].payload.instruction;
  assert.equal(o.calls[0].name, 'temporal-memory');
  assert.equal(o.calls[0].payload._exec, undefined, 'recall runs the memory organ without its tools');
  const data = instruction.slice(instruction.indexOf(PRELOADED_START), instruction.indexOf(PRELOADED_END));
  assert.ok(data.indexOf('## Known Resources') < data.indexOf('## Working Memory'), 'known resources lead');
  for (const s of ['1BriefDoc0000000000', '1QrTlyRpts000000000', 'The quarterly report', 'finance template', 'Q2 quarterly report']) assert.ok(data.includes(s), s);
  assert.match(instruction, /recall_escalate/);
});

test('an escalation gets one deeper, construct-only pass; an escalation is never handed on as a packet', async () => {
  const { f } = files('');
  const o = organ(['{"recall_escalate": true, "cues": ["migration"], "reason": "older work"}', 'Deep packet']);
  const memory = createMemory({ db, callAgent: o.callAgent, files: f, clock: () => NOW });
  assert.deepEqual(await memory.recall('the migration'), { recalled: 'Deep packet' });
  assert.match(o.calls[1].payload.instruction, /no further escalation/);
  assert.match(o.calls[1].payload.instruction, /No older work matched/);
  // Fixed defect: with no deeper hits, the escalation JSON itself came back as the recalled context.
  const again = organ(['{"recall_escalate": true, "cues": [], "reason": "x"}', '{"recall_escalate": true}']);
  assert.deepEqual(await createMemory({ db, callAgent: again.callAgent, files: f, clock: () => NOW }).recall('x'), {});
});

test('a recall the memory organ cannot answer is empty, not an error', async () => {
  const { f } = files('');
  assert.deepEqual(await createMemory({ db, callAgent: organ([null]).callAgent, files: f, clock: () => NOW }).recall('x'), {});
  const thrower = async () => { throw new Error('boom'); };
  assert.deepEqual(await createMemory({ db, callAgent: thrower, files: f, clock: () => NOW }).recall('x'), {});
});

test('a finished mission leaves one working-memory line and is marked written; a consolidation leaves none', async () => {
  const { wm, f } = files('');
  const memory = createMemory({ db, callAgent: organ([]).callAgent, files: f, clock: () => NOW });
  await db.write(`${COLLECTIONS.work}/w-1`, { id: 'w-1', type: 'M' });
  await memory.writeMissionLine({ id: 'w-1', type: 'M', instruction: 'Write   the\nreport', output: 'The report is in report.md', source_meta: {} });
  assert.match(readFileSync(wm, 'utf8'), /- \[2026-10-17\] M: Write the report -> The report is in report\.md\n/);
  assert.equal((await db.read(`${COLLECTIONS.work}/w-1`)).memory_written, true);
  const before = readFileSync(wm, 'utf8');
  await memory.writeMissionLine({ id: 'w-2', type: 'M', instruction: 'Consolidate', source_meta: { effect_scope: 'memory' } });
  await memory.writeMissionLine({ id: 'w-3', type: 'M', instruction: 'x', source_meta: { responsibility_id: 'r-memory-consolidation' } });
  assert.equal(readFileSync(wm, 'utf8'), before);
});

test('lessons go to working memory, about the project and each playbook; no definition is written', async () => {
  const { wm, f } = files('');
  const o = organ(['{"lesson":"Deploys need a cache purge."}', '{"lesson":""}', '{"lesson":"Check the template id first."}']);
  const processes = { ensureLoaded: async () => {}, getProcess: (id) => ({ 'p-a': { id: 'p-a', name: 'A', narrative: 'n' }, 'p-b': { id: 'p-b', name: 'B', narrative: 'n' }, 'p-c': { id: 'p-c', status: 'deprecated' } })[id] };
  const memory = createMemory({ db, callAgent: o.callAgent, files: f, clock: () => NOW, getProject: () => ({ id: 'site', name: 'Site', context: {} }), processes });
  const writesBefore = firestore.requests.filter((r) => r.method !== 'GET').length;
  await memory.recordLessons({ id: 'w-9', type: 'M', status: 'complete', project_id: 'site', instruction: 'Deploy', output: 'Deployed', recalled_processes: ['p-a', 'p-b', 'p-c'] });
  const text = readFileSync(wm, 'utf8');
  assert.match(text, /lesson \(project site\): Deploys need a cache purge\./);
  assert.match(text, /lesson \(playbook p-b\): Check the template id first\./);
  assert.doesNotMatch(text, /p-a\)|p-c/, 'silence is a valid lesson, and a retired playbook is skipped');
  assert.equal(firestore.requests.filter((r) => r.method !== 'GET').length, writesBefore, 'nothing written to Firestore: no project, no playbook');
  const calls = o.calls.length;
  await memory.recordLessons({ id: 'w-10', type: 'M', status: 'complete', project_id: 'site', source_meta: { effect_scope: 'memory' } });
  assert.equal(o.calls.length, calls, 'a memory mission is not asked for lessons about itself');
});
