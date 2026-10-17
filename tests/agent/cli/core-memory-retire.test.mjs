// Tests for agent/cli/core-memory-retire.mjs. Ported from the memory-boundary case: a retire reason
// with an apostrophe once failed every retire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/core-memory-retire.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.123Z');
const retire = (argv, db) => run(main, argv, { runtime: fakeRuntime({ db }), now: () => NOW });

test('retires an active entry with its reason and time, and keeps it', async () => {
  const db = fakeDb({ 'core_memory/mem-1': { fact: 'old', status: 'active' } });
  const r = await retire(['--id', 'mem-1', '--reason', "the team's process changed"], db);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(db.docs.get('core_memory/mem-1'), {
    fact: 'old', status: 'retired', retiredAt: '2026-10-17T12:00:00Z', retireReason: "the team's process changed",
  });
  assert.equal(r.out, [
    '✅ Core memory retired: mem-1',
    "  Reason: the team's process changed",
    '  Retired at: 2026-10-17T12:00:00Z',
    '  Previous status: active',
    '',
  ].join('\n'));
});

test('without a reason, the nightly consolidation reason is recorded', async () => {
  const db = fakeDb({ 'core_memory/mem-1': { status: 'active' } });
  await retire(['--id', 'mem-1'], db);
  assert.equal(db.docs.get('core_memory/mem-1').retireReason, 'Retired during nightly consolidation');
});

test('an entry already retired or superseded is left alone', async () => {
  const db = fakeDb({ 'core_memory/r': { status: 'retired' }, 'core_memory/s': { status: 'superseded' } });
  let r = await retire(['--id', 'r'], db);
  assert.deepEqual([r.code, r.out], [0, 'Already retired: r\n']);
  r = await retire(['--id', 's'], db);
  assert.deepEqual([r.code, r.out], [0, 'Already superseded: s — skipping retirement\n']);
  assert.equal(db.docs.get('core_memory/s').status, 'superseded');
});

test('a missing entry, a missing id or an outage fails', async () => {
  let r = await retire(['--id', 'mem-none'], fakeDb());
  assert.deepEqual([r.code, r.err], [1, '❌ Entry not found: mem-none\n']);
  r = await retire([], fakeDb());
  assert.equal(r.code, 1);
  assert.match(r.err, /^Usage: core-memory-retire --id <entry-id>/);
  const down = fakeDb({ 'core_memory/mem-1': { status: 'active' } });
  down.state.down = true;
  r = await retire(['--id', 'mem-1'], down);
  assert.equal(r.code, 1);
  assert.match(r.err, /Failed to retire entry/);
});

test('--help prints the usage', async () => {
  const r = await run(main, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: core-memory-retire --id <entry-id> --reason "<reason>"\n/);
});
