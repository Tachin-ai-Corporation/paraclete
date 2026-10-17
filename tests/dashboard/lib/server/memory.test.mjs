// Tests for dashboard/lib/server/memory.mjs: Core Memory as the agent's own commands write it
// (core-memory-write, core-memory-retire), read back by status, most valuable first, and an outage
// that reads as an error rather than an empty memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { listCoreMemory, CORE_MEMORY_LIMIT } from '../../../../dashboard/lib/server/memory.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { main as writeMemory } from '../../../../agent/cli/core-memory-write.mjs';
import { main as retireMemory } from '../../../../agent/cli/core-memory-retire.mjs';
import { fakeRuntime, run } from '../../../agent/cli/fakes.mjs';

async function setup(t) {
  const dash = await startDashboard();
  t.after(dash.stop);
  // The agent's commands, writing through the same Firestore the dashboard reads.
  const agent = fakeRuntime({ db: dash.runtime.db });
  let n = 0;
  const write = async (argv, at) => {
    const r = await run(writeMemory, argv, { runtime: agent, now: () => new Date(at), randomHex: () => `0000000${n += 1}`.slice(-8) });
    assert.equal(r.code, 0, r.err);
    return /written: (\S+)/.exec(r.out)[1];
  };
  const retire = async (id, at) => {
    const r = await run(retireMemory, ['--id', id, '--reason', 'no longer true'], { runtime: agent, now: () => new Date(at) });
    assert.equal(r.code, 0, r.err);
  };
  return { dash, write, retire };
}

test('entries come back as the agent wrote them, most valuable first and newest first on a tie', async (t) => {
  const { dash, write } = await setup(t);
  const low = await write(['--fact', 'The weekly report goes out on Mondays', '--category', 'operations', '--importance', '0.2'], '2027-01-10T09:00:00.000Z');
  const old = await write(['--fact', 'Reports use the shared template', '--category', 'patterns', '--tags', 'reports, templates'], '2027-01-01T09:00:00.000Z');
  const recent = await write(['--fact', 'folder: "templates" = 1AbC', '--category', 'resources'], '2027-01-12T09:00:00.000Z');
  const top = await write(['--fact', 'Never email customers directly', '--category', 'decisions', '--importance', '1', '--confidence', '1', '--source', 'user', '--source-detail', 'said in chat'], '2027-01-05T09:00:00.000Z');

  const { status, entries, categories, limited, limit } = await listCoreMemory(dash.runtime);
  assert.equal(status, 'active');
  assert.deepEqual(entries.map((e) => e.id), [top, recent, old, low]);
  assert.deepEqual(categories, ['decisions', 'operations', 'patterns', 'resources']);
  assert.deepEqual([limited, limit], [false, CORE_MEMORY_LIMIT]);

  assert.deepEqual(entries[0], {
    id: top,
    fact: 'Never email customers directly',
    category: 'decisions',
    tags: [],
    importance: 1,
    confidence: 1,
    value: 1,
    source: 'user',
    sourceDetail: 'said in chat',
    status: 'active',
    supersedes: null,
    supersededBy: null,
    createdAt: '2027-01-05T09:00:00Z',
    lastRecalledAt: '2027-01-05T09:00:00Z',
    recallCount: 0,
    retiredAt: null,
    retireReason: null,
  });
  assert.deepEqual(entries[2].tags, ['reports', 'templates']);
});

test('superseded and retired entries are read by their status, and `all` reads every one', async (t) => {
  const { dash, write, retire } = await setup(t);
  const first = await write(['--fact', 'The office is in Lisbon', '--category', 'operations'], '2027-01-01T09:00:00.000Z');
  const second = await write(['--fact', 'The office is in Porto', '--category', 'operations', '--supersedes', first], '2027-01-02T09:00:00.000Z');
  const gone = await write(['--fact', 'The team uses the old tracker', '--category', 'operations'], '2027-01-03T09:00:00.000Z');
  await retire(gone, '2027-01-04T09:00:00.000Z');

  assert.deepEqual((await listCoreMemory(dash.runtime)).entries.map((e) => e.id), [second]);
  const [superseded] = (await listCoreMemory(dash.runtime, { status: 'superseded' })).entries;
  assert.deepEqual([superseded.id, superseded.supersededBy], [first, second]);
  const [retired] = (await listCoreMemory(dash.runtime, { status: 'retired' })).entries;
  assert.deepEqual([retired.id, retired.retiredAt, retired.retireReason], [gone, '2027-01-04T09:00:00Z', 'no longer true']);
  const all = await listCoreMemory(dash.runtime, { status: 'all' });
  assert.deepEqual(all.entries.map((e) => e.id).sort(), [first, second, gone].sort());
});

test('an entry written before importance and confidence existed ranks as 0.5 x 0.9; dates compare as instants', async (t) => {
  const { dash } = await setup(t);
  await dash.seed({
    'core_memory/mem-old': { fact: 'An early fact', category: 'patterns', status: 'active', createdAt: '2027-01-02T00:00:00Z' },
    // Same value, written later in the day but with milliseconds: newer as an instant.
    'core_memory/mem-new': { fact: 'A later fact', category: 'patterns', status: 'active', importance: 0.5, confidence: 0.9, createdAt: '2027-01-02T10:00:00.000Z' },
    'core_memory/mem-odd': { fact: 42, tags: 'not-a-list', status: 'active', importance: 'high', createdAt: 'yesterday' },
  });
  const { entries } = await listCoreMemory(dash.runtime);
  assert.deepEqual(entries.map((e) => e.id), ['mem-new', 'mem-old', 'mem-odd']);
  assert.equal(entries[1].value, 0.45);
  assert.deepEqual([entries[2].fact, entries[2].tags, entries[2].importance, entries[2].category], ['42', [], null, null]);
});

test('an unknown status is refused', async (t) => {
  const { dash } = await setup(t);
  await assert.rejects(listCoreMemory(dash.runtime, { status: 'deleted' }), (err) => err.status === 400);
});

test('an outage is an error, never an empty memory', async (t) => {
  const { dash } = await setup(t);
  const db = { query: async (parent, collection, filters, opts = {}) => { if (opts.strict) throw new StoreUnavailable('query', collection, 503, 'unavailable'); return []; } };
  await assert.rejects(listCoreMemory({ ...dash.runtime, db }), StoreUnavailable);
});
