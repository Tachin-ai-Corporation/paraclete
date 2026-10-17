// Tests for agent/cli/core-memory-read.mjs. Ported from the memory-boundary cases: `--category all`
// reads every category, and an empty filtered read says it was filtered, so a consolidation never
// mistakes a bad filter for an empty memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/core-memory-read.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00Z');

const entry = (id, over = {}) => ({
  id, fact: `fact ${id}`, category: 'operations', tags: [], confidence: 0.9, importance: 0.5,
  source: 'observation', status: 'active', createdAt: '2026-10-01T00:00:00Z', ...over,
});

function memory(entries) {
  return fakeDb(Object.fromEntries(entries.map((e) => [`core_memory/${e.id}`, e])));
}

const read = (argv, db) => run(main, argv, { runtime: fakeRuntime({ db }), now: () => NOW });

test('prints each entry with its category, id, confidence, source, status and date', async () => {
  const db = memory([entry('mem-1', { fact: 'Deploys go through the devops skill', confidence: 1 })]);
  const r = await read([], db);
  assert.equal(r.code, 0);
  assert.equal(r.out, [
    '[operations] (mem-1) Deploys go through the devops skill',
    '  confidence: 1.0 | source: observation | status: active',
    '  created: 2026-10-01T00:00:00Z',
    '',
    '--- 1 entries ---',
    '',
  ].join('\n'));
  assert.deepEqual(db.calls[0].filters, [{ field: 'status', op: 'EQUAL', value: { stringValue: 'active' } }]);
  assert.equal(db.calls[0].collection, 'core_memory', 'Core Memory is the root collection');
});

test('--category all (or *) reads every category instead of filtering on a category named "all"', async () => {
  const db = memory([entry('mem-1'), entry('mem-2', { category: 'resources' })]);
  for (const all of ['all', '*']) {
    const r = await read(['--category', all], db);
    assert.match(r.out, /--- 2 entries ---/);
    assert.ok(!db.calls.at(-1).filters.some((f) => f.field === 'category'));
  }
});

test('an empty filtered read says it was filtered; an empty unfiltered one does not', async () => {
  const db = memory([entry('mem-1')]);
  let r = await read(['--category', 'iam', '--query', 'oauth'], db);
  assert.equal(r.code, 0);
  assert.match(r.out, /No core memory entries matched \(category 'iam', query 'oauth', status 'active'\)\./);
  assert.match(r.out, /This read was FILTERED — it does not mean memory is empty\./);
  r = await read([], memory([]));
  assert.equal(r.out, "No core memory entries matched (status 'active').\n");
});

test('--query matches fact and tags, drops entries that match nothing, and ranks by value', async () => {
  const db = memory([
    entry('mem-low', { fact: 'drive folder for reports', importance: 0.2 }),
    entry('mem-high', { fact: 'drive folder ids live in resources', importance: 0.9 }),
    entry('mem-tag', { fact: 'unrelated text', tags: ['drive'], importance: 0.5 }),
    entry('mem-none', { fact: 'nothing to see' }),
  ]);
  const r = await read(['--query', 'Drive folder'], db);
  const ids = [...r.out.matchAll(/\((mem-[a-z]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['mem-high', 'mem-tag', 'mem-low']);
});

test('the limit applies after ranking: a match among many entries is still found', async () => {
  // The read used to cut to --limit in Firestore and search only what came back.
  const entries = Array.from({ length: 30 }, (_, i) => entry(`mem-${String(i).padStart(2, '0')}`));
  entries.push(entry('mem-target', { fact: 'the billing export runs at 06:00' }));
  const db = memory(entries);
  const r = await read(['--query', 'billing', '--limit', '3'], db);
  assert.match(r.out, /\(mem-target\) the billing export runs at 06:00/);
  assert.match(r.out, /--- 1 entries ---/);
  assert.ok(db.calls[0].opts.limit >= 300, 'the read covers every entry, not just --limit of them');
});

test('--since sends only the time range to Firestore and filters status and category here', async () => {
  const db = memory([
    entry('mem-recent', { createdAt: '2026-10-15T00:00:00Z' }),
    entry('mem-retired', { createdAt: '2026-10-15T00:00:00Z', status: 'retired' }),
    entry('mem-old', { createdAt: '2026-08-01T00:00:00Z' }),
  ]);
  const r = await read(['--since', '7d'], db);
  assert.deepEqual(db.calls[0].filters, [{ field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-10-10T12:00:00Z' } }]);
  assert.match(r.out, /mem-recent/);
  assert.doesNotMatch(r.out, /mem-retired|mem-old/);
  const bad = await read(['--since', 'last week'], db);
  assert.match(bad.err, /Warning: could not parse --since 'last week', ignoring time filter/);
});

test('an outage fails the command instead of reading as an empty memory', async () => {
  const db = memory([entry('mem-1')]);
  db.state.down = true;
  const r = await read([], db);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /This is an outage, not an empty memory/);
});

test('an unknown option or a bad limit is refused', async () => {
  assert.equal((await read(['--agent', 'x'], memory([]))).code, 1);
  assert.match((await read(['--limit', 'ten'], memory([]))).err, /--limit must be a positive whole number/);
});
