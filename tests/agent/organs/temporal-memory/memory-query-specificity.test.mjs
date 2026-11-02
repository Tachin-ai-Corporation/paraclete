// Tests for agent/organs/temporal-memory/core-memory-rank.mjs and agent/organs/temporal-memory/memory.mjs:
// specific multi-term query matches stay separated from single-term entity overlap, query terms from
// cues are deduplicated without dropping words past the fourth cue, and recall asks the organ to
// silently omit unrelated or sibling candidates.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { countTermMatches, rankCoreMemory, selectQueryMatches } from '../../../../agent/organs/temporal-memory/core-memory-rank.mjs';
import { PRELOADED_END, PRELOADED_START, createMemory, createMemoryFiles } from '../../../../agent/organs/temporal-memory/memory.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

let firestore;
let db;
let scratch;

before(async () => {
  firestore = await startFirestore();
  db = createClient({
    projectId: firestore.projectId,
    firestoreHost: firestore.origin,
    getAccessToken: async () => 't',
    logger: () => {},
  });
  scratch = mkdtempSync(join(tmpdir(), 'memory-query-specificity-'));
});

after(async () => {
  await firestore.stop();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => firestore.reset());

test('countTermMatches and rankCoreMemory deduplicate repeated search terms', () => {
  const entry = { id: 'e-1', fact: 'Northwind security alerts go to the pager channel', tags: ['northwind', 'security'] };
  assert.equal(countTermMatches(entry, ['northwind', 'Northwind', 'security']), 2);
  const sibling = { id: 'e-2', fact: 'Northwind design reviews happen on Tuesdays', tags: ['northwind', 'design'], importance: 0.9 };
  const target = { id: 'e-3', fact: 'Northwind security alerts go to the pager channel', tags: ['northwind', 'security'], importance: 0.7 };
  assert.deepEqual(rankCoreMemory([sibling, target], ['northwind', 'northwind', 'security']).map((e) => e.id), ['e-3', 'e-2']);
});

test('selectQueryMatches keeps multi-term matches when present and falls back to single-term matches otherwise', () => {
  const entries = [
    { id: 'sec', fact: 'Northwind security incidents route to the on-call lead', tags: ['northwind', 'security', 'incidents'], importance: 0.8 },
    { id: 'hr', fact: 'Northwind recruiting questions route to talent ops', tags: ['northwind', 'recruiting', 'hiring'], importance: 0.8 },
  ];
  assert.deepEqual(selectQueryMatches(entries, ['northwind', 'security', 'incidents']).map((e) => e.id), ['sec']);
  assert.deepEqual(selectQueryMatches(entries, ['northwind']).map((e) => e.id), ['sec', 'hr']);
  assert.deepEqual(selectQueryMatches(entries, []), []);
});

test('recall separates multi-term query matches from single-term sibling entries and keeps fifth-plus cue words', async () => {
  const dir = mkdtempSync(join(scratch, 'case-'));
  const files = createMemoryFiles({ workingMemoryFile: join(dir, 'MEMORY.md'), deepTruthsFile: join(dir, 'DEEP_TRUTHS.md') });
  await db.write(`${COLLECTIONS.coreMemory}/cm-sec`, {
    fact: 'Northwind security alerts go to the pager rotation',
    category: 'operations',
    tags: ['northwind', 'security', 'pager'],
    status: 'active',
    importance: 0.8,
    createdAt: '2026-10-10T00:00:00Z',
  });
  await db.write(`${COLLECTIONS.coreMemory}/cm-hr`, {
    fact: 'Northwind recruiting updates go to the talent channel',
    category: 'operations',
    tags: ['northwind', 'recruiting', 'talent'],
    status: 'active',
    importance: 0.8,
    createdAt: '2026-10-10T00:00:00Z',
  });
  const calls = [];
  const callAgent = async (name, payload) => {
    calls.push({ name, payload });
    return { success: true, output: 'Route Northwind security alerts to the pager rotation (cm-sec).' };
  };
  const memory = createMemory({ db, callAgent, files, clock: () => NOW });
  await memory.recall('Where should urgent Northwind production security pager alerts go?');

  assert.equal(calls.length, 1);
  const { instruction, accept_criteria: acceptCriteria } = calls[0].payload;
  const data = instruction.slice(instruction.indexOf(PRELOADED_START), instruction.indexOf(PRELOADED_END));
  const queryHeader = /## Core Memory \(query: ([^)]+)\)/.exec(data);
  assert.ok(queryHeader, 'query block is present');
  const queryTerms = queryHeader[1].split(' ');
  assert.ok(queryTerms.includes('pager') && queryTerms.includes('alerts'), 'terms past the fourth cue are preserved');
  assert.equal(new Set(queryTerms).size, queryTerms.length, 'query terms are deduplicated');

  const recentPos = data.indexOf('## Core Memory (recent 30d)');
  assert.ok(recentPos > 0, 'single-term sibling falls through to recent 30d');
  assert.ok(data.indexOf('cm-sec') < recentPos, 'multi-term match stays in the query block');
  assert.ok(data.indexOf('cm-hr') > recentPos, 'single-term sibling is in the recent block, not the query block');
  assert.match(acceptCriteria, /silently omitting unrelated or sibling candidates without naming them/);
});
