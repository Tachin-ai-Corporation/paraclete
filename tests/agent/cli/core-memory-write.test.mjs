// Tests for agent/cli/core-memory-write.mjs. Ported from the memory-boundary cases: free text with
// quotes, apostrophes or shell characters reaches the store word for word (the shell versions once
// broke on an apostrophe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/core-memory-write.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:34:56.789Z');

function write(argv, db = fakeDb(), hex = 'a1b2c3d4') {
  return run(main, argv, { runtime: fakeRuntime({ db }), now: () => NOW, randomHex: () => hex }).then((r) => ({ ...r, db }));
}

test('writes a new active entry with every field, and says what it wrote', async () => {
  const r = await write(['--fact', 'Reports go to the finance folder', '--category', 'operations', '--tags', 'drive, reports,', '--confidence', '0.8']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.db.docs.get('core_memory/mem-20261017-a1b2c3d4'), {
    id: 'mem-20261017-a1b2c3d4',
    fact: 'Reports go to the finance folder',
    category: 'operations',
    tags: ['drive', 'reports'],
    confidence: 0.8,
    importance: 0.5,
    source: 'observation',
    supersededBy: null,
    createdAt: '2026-10-17T12:34:56Z',
    lastRecalledAt: '2026-10-17T12:34:56Z',
    recallCount: 0,
    status: 'active',
  });
  assert.equal(r.out, [
    '✅ Core memory written: mem-20261017-a1b2c3d4',
    '  Category: operations',
    '  Fact: Reports go to the finance folder',
    '  Confidence: 0.8',
    '  Source: observation',
    '',
  ].join('\n'));
});

test('quotes, apostrophes and shell characters are stored word for word', async () => {
  const fact = 'drive_folder: "weekly notes" = 1OYwJJ; it\'s $(not) `run` | ever';
  const r = await write(['--fact', fact, '--category', 'resources', '--source-detail', "the owner's note"]);
  const doc = r.db.docs.get('core_memory/mem-20261017-a1b2c3d4');
  assert.equal(doc.fact, fact);
  assert.equal(doc.sourceDetail, "the owner's note");
});

test('--supersedes marks the old entry superseded and links the two', async () => {
  const db = fakeDb({ 'core_memory/mem-old': { id: 'mem-old', fact: 'old id', status: 'active' } });
  const r = await write(['--fact', 'folder: "x" = 2', '--category', 'resources', '--supersedes', 'mem-old'], db);
  assert.equal(r.code, 0);
  assert.match(r.out, /  Superseded: mem-old\n$/);
  assert.equal(db.docs.get('core_memory/mem-20261017-a1b2c3d4').supersedes, 'mem-old');
  assert.deepEqual(db.docs.get('core_memory/mem-old'), { id: 'mem-old', fact: 'old id', status: 'superseded', supersededBy: 'mem-20261017-a1b2c3d4' });
});

test('superseding a missing entry warns and creates no stray record', async () => {
  const db = fakeDb();
  const r = await write(['--fact', 'f', '--category', 'resources', '--supersedes', 'mem-typo'], db);
  assert.equal(r.code, 0);
  assert.match(r.err, /Warning: could not update superseded entry mem-typo/);
  assert.equal(db.docs.has('core_memory/mem-typo'), false);
});

test('a new entry never overwrites an existing one', async () => {
  const db = fakeDb({ 'core_memory/mem-20261017-a1b2c3d4': { fact: 'kept' } });
  const r = await write(['--fact', 'f', '--category', 'errors'], db);
  assert.equal(r.code, 1);
  assert.match(r.err, /❌ Failed to write core memory/);
  assert.equal(db.docs.get('core_memory/mem-20261017-a1b2c3d4').fact, 'kept');
});

test('a fact and a category are required; weights are numbers from 0 to 1', async () => {
  let r = await write(['--fact', 'no category']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^Usage: core-memory-write --fact "<text>" --category <category>/);
  assert.equal(r.db.docs.size, 0);
  r = await write(['--fact', 'f', '--category', 'errors', '--confidence', 'high']);
  assert.match(r.err, /--confidence must be a number from 0 to 1/);
  r = await write(['--fact', 'f', '--category', 'errors', '--agent', 'other']);
  assert.match(r.err, /Unknown option: --agent/);
});
