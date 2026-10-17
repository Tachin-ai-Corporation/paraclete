// Tests for install/firestore.indexes.json: it holds exactly the composite indexes and the TTL policy
// the agent's queries need (docs/plan/OPEN_ITEMS.md, phase 5), on collections that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { repoRoot } from './harness.mjs';

const file = JSON.parse(readFileSync(join(repoRoot, 'install', 'firestore.indexes.json'), 'utf8'));
const signature = (index) => `${index.collectionGroup}(${index.fields.map((f) => `${f.fieldPath} ${f.order}`).join(', ')})`;

test("lists the composite indexes the agent's and the dashboard's queries need", () => {
  assert.deepEqual(file.indexes.map(signature), [
    'messages(thread_id ASCENDING, timestamp DESCENDING)',
    'messages(sender ASCENDING, timestamp DESCENDING)',
    'work(status ASCENDING, created_at DESCENDING)',
    'work(status ASCENDING, created_at ASCENDING)',
    'work(type ASCENDING, created_at DESCENDING)',
    'intake(status ASCENDING, created_at ASCENDING)',
  ]);
  for (const index of file.indexes) assert.equal(index.queryScope, 'COLLECTION');
});

test('lists the TTL policy on tool_results.expire_at', () => {
  assert.deepEqual(file.fieldOverrides.map((f) => [f.collectionGroup, f.fieldPath, f.ttl]), [['tool_results', 'expire_at', true]]);
});

test('every collection named is one the agent uses', () => {
  const known = new Set(Object.values(COLLECTIONS));
  for (const group of [...file.indexes, ...file.fieldOverrides].map((entry) => entry.collectionGroup)) {
    assert.ok(known.has(group), `${group} is not in agent/storage/collections.mjs`);
  }
});
