// Tests for dev/harness2/harvested-items.mjs: an item the harvester wrote reads back as a bench item
// that keeps the bench's rules, but only once BENCH_VERSION is raised to the version it names; a
// malformed file is refused with the reason; and the admitted items are in the memory bench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MEMORY_SCENARIOS } from '../../../dev/harness2/scenario-items.mjs';
import { recordStep, startDueRuns, stepRequest } from '../../../dev/harness2/scenarios.mjs';
import { harvester } from '../../../dev/harness2/scenario-harvest.mjs';
import { BENCHES, BENCH_VERSION, recallChecks, seedMemoryItem } from '../../../dev/harness2/bench.mjs';
import { RECALL_KEEPS } from '../../../dev/harness2/bench-items.mjs';
import { HARVESTED_ITEMS_DIR, loadHarvestedItems, readHarvestedItem } from '../../../dev/harness2/harvested-items.mjs';

const T0 = Date.parse('2027-03-07T09:00:00Z');
const MIN = 60_000;

/** The file the harvester writes for a failed next-day recall whose facts were stored. */
async function harvestedFile() {
  const scenario = MEMORY_SCENARIOS.find((s) => s.id === 'mem-next-day');
  let state = startDueRuns({ state: { version: 1, runs: [] }, scenarios: [scenario], now: T0 }).state;
  const runId = state.runs[0].id;
  const teach = stepRequest(scenario, state.runs[0], 'teach');
  state = recordStep({ state, runId, stepId: 'teach', request: teach, outcome: { pass: true, reason: 'ok', mission: 'w-teach' }, now: T0 + 5 * MIN });
  const request = stepRequest(scenario, state.runs[0], 'ask');
  const asked = T0 + 26 * 60 * MIN;
  state = recordStep({ state, runId, stepId: 'ask', request, outcome: { pass: false, reason: 'the answer does not mention /x/', mission: 'w-ask' }, now: asked });
  const run = state.runs[0];
  const written = [];
  const harvest = harvester({
    repoRoot: '/repo',
    capture: async () => ({
      coreMemory: [{ id: 'cm-1', fact: teach.text, category: 'operations', tags: [], createdAt: new Date(T0 + 8 * 60 * MIN).toISOString() }],
      work: [{ id: 'w-teach', type: 'M', status: 'complete', title: 'Note the facts', instruction: teach.text, output: 'Noted.', created_at: new Date(T0).toISOString() }],
      workingMemory: '',
      commit: 'abc123',
    }),
    writeFile: (file, text) => written.push({ file, text }),
  });
  const got = await harvest({ run, stepId: 'ask', request, outcome: { mission: 'w-ask' } });
  assert.equal(got.diagnosis, 'stored');
  return { run, file: path.basename(written[0].file), text: written[0].text, at: asked };
}

test('an item the harvester wrote reads back as a bench item that keeps the bench\'s rules, once the version is raised', async () => {
  const { run, file, text, at } = await harvestedFile();
  assert.throws(() => readHarvestedItem(text, { file, version: BENCH_VERSION }), /enters at bench version \d+, and the bench is at \d+: raise BENCH_VERSION/);
  const item = readHarvestedItem(text, { file, version: BENCH_VERSION + 1 });
  assert.equal(item.id, `memh-${run.id}`);
  assert.equal(item.organ, 'temporal-memory');
  assert.ok(item.must.every((m) => m.re instanceof RegExp && RECALL_KEEPS.includes(m.name)));
  const names = item.must.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, 'one check a name');
  const v = run.values;
  const good = `Its error budget is ${v.minutes} minutes; dashboard ${v.dashboard}; ${v.person.first} approves alert changes.`;
  assert.ok(recallChecks(item, good).every((c) => c.ok));
  assert.ok(!recallChecks(item, `Its error budget is ${v.minutes}0 minutes.`)[1].ok, 'a number inside a longer one is not the number');
  const writes = [];
  await seedMemoryItem(item, { db: { write: async (p) => { writes.push(p); } }, collections: { coreMemory: 'core_memory', work: 'work' }, now: at });
  assert.deepEqual(writes, ['core_memory/cm-1', 'work/w-teach']);
});

test('a malformed file is refused, and says why', async () => {
  const { file, text } = await harvestedFile();
  const version = BENCH_VERSION + 1;
  const edit = (change) => JSON.stringify(change(JSON.parse(text)));
  const refusals = [
    ['{', /not JSON/],
    [edit((i) => ({ ...i, id: 'memh-other' })), /its id must be its file's name/],
    [edit((i) => ({ ...i, organ: 'cortex' })), /no bench takes harvested items for the organ cortex/],
    [edit((i) => ({ ...i, split: 'test' })), /train or holdout/],
    [edit(({ harvested, ...i }) => i), /what it was harvested from/],
    [edit(({ bench, ...i }) => i), /must name the bench version/],
    [edit((i) => ({ ...i, must: [] })), /a check it must keep/],
    [edit((i) => ({ ...i, coreMemory: [{ id: 'x', fact: 'f' }] })), /Core Memory entries with an id, a fact and daysAgo/],
    [edit((i) => ({ ...i, must: [{ name: i.must[0].name, source: '(' }] })), /is not a regex/],
    [edit((i) => ({ ...i, mustNot: [{ name: 'x' }] })), /a check needs a name and a source/],
  ];
  for (const [bad, reason] of refusals) assert.throws(() => readHarvestedItem(bad, { file, version }), reason);

  // A cerebellum item is judged on its checkpoint: an instruction, the criteria, rows and a verdict.
  const cb = { id: 'cbh-x-defect', organ: 'cerebellum', split: 'train', bench: version, harvested: { run: 'x' }, expect: 'fail', kind: 'a wrong total',
    flaw: 'the total is short', instruction: 'Total the claims', acceptCriteria: 'The total is the sum of the nine claims', rows: [{ step: '1.1', agent: 'motor', result: 'Total: 10.00' }] };
  const cbFile = 'cbh-x-defect.json';
  assert.deepEqual(readHarvestedItem(JSON.stringify(cb), { file: cbFile, version }).rows, cb.rows, 'a cerebellum item is read as it is');
  for (const [change, reason] of [
    [{ rows: [] }, /rows with a step, an agent and a result/],
    [{ expect: 'maybe' }, /an expected verdict, pass or fail/],
    [{ flaw: '' }, /the flaw a defective item holds/],
    [{ acceptCriteria: ' ' }, /the criteria its verifier judged against/],
  ]) assert.throws(() => readHarvestedItem(JSON.stringify({ ...cb, ...change }), { file: cbFile, version }), reason);
  assert.ok(readHarvestedItem(JSON.stringify({ ...cb, id: 'cbh-x-clean', expect: 'pass', flaw: undefined }), { file: 'cbh-x-clean.json', version }), 'a clean twin needs no flaw');
});

test('the items load by organ from the directory\'s JSON files, and none is no error', async () => {
  const { file, text } = await harvestedFile();
  const dir = '/items';
  const files = { [file]: text, 'README.md': '# not an item' };
  const got = loadHarvestedItems({
    version: BENCH_VERSION + 1,
    dir,
    readdir: (d) => { assert.equal(d, dir); return Object.keys(files); },
    readFile: (p) => files[path.basename(p)],
  });
  assert.deepEqual(Object.keys(got), ['cerebellum', 'temporal-memory']);
  assert.deepEqual(got.cerebellum, []);
  assert.deepEqual(got['temporal-memory'].map((i) => i.id), [file.replace(/\.json$/, '')]);
  const none = loadHarvestedItems({ version: BENCH_VERSION, readdir: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.deepEqual(none, { cerebellum: [], 'temporal-memory': [] });
});

test('every admitted item loads at the bench\'s version and is in the memory bench', () => {
  const admitted = loadHarvestedItems({ version: BENCH_VERSION, dir: HARVESTED_ITEMS_DIR });
  for (const [organ, items] of Object.entries(admitted)) {
    const ids = new Set(BENCHES[organ].map((i) => i.id));
    for (const item of items) assert.ok(ids.has(item.id), `${organ}: ${item.id}`);
  }
});
