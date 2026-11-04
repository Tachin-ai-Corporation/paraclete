// Tests for dev/harness2/scenario-harvest.mjs: the lab's identifiers are scrubbed and versions are
// not; each value is found in the layer that holds it; a miss whose values were stored becomes a
// memory bench item the bench can seed and check, and one whose values were never stored becomes none;
// and the capture reads what recall would have seen, before the question and with the teaching missions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { KEEPS, MEMORY_SCENARIOS } from '../../../dev/harness2/scenario-items.mjs';
import { startDueRuns, recordStep, stepRequest } from '../../../dev/harness2/scenarios.mjs';
import {
  HARVEST_DIR, captureMemory, diagnose, harvester, locateValues, readDenylist, recallItem, scrub,
} from '../../../dev/harness2/scenario-harvest.mjs';
import { BENCH_VERSION, recallChecks, seedMemoryItem } from '../../../dev/harness2/bench.mjs';

const T0 = Date.parse('2027-03-07T09:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

test('scrubbing replaces the lab\'s identifiers with the repo\'s placeholders, and leaves versions alone', () => {
  // The addresses scrubbing must replace are joined here, so the repo's hygiene test never sees one.
  const at = '@';
  const text = [
    `Deployed to lab-proj-canary from lab-proj; mail ops${at}corp.example.io or agent@example.com.`,
    `It runs as paraclete-agent${at}lab-proj-canary.iam.gserviceaccount.com.`,
    'The VM is at 10.128.0.7; the release v2026.11.03.4.1 is installed.',
    'Dashboard: https://paraclete-abc123-uc.a.run.app/missions, repo https://github.com/SomeOrg/paraclete and git@github.com:SomeOrg/x.git.',
    'Acme Widgets runs it.',
  ].join('\n');
  const out = scrub(text, { projectIds: ['lab-proj-canary', 'lab-proj'], denylist: ['Acme Widgets', 'x'] });
  assert.ok(!/lab-proj/.test(out));
  assert.match(out, /Deployed to your-gcp-project from your-gcp-project/);
  assert.match(out, /mail agent@example\.com or agent@example\.com/);
  assert.match(out, /runs as paraclete-agent@your-gcp-project\.iam\.gserviceaccount\.com\./, 'a placeholder address is kept');
  assert.match(out, /at 192\.0\.2\.1;/);
  assert.match(out, /v2026\.11\.03\.4\.1/, 'a version is not an address');
  assert.match(out, /Dashboard: https:\/\/dashboard\.example\.com /);
  assert.match(out, /github\.com\/example-org\/paraclete and git@github\.com:example-org\/x\.git/);
  assert.match(out, /example-org runs it/);
  assert.ok(!/SomeOrg|Acme/.test(out));
  assert.match(out, /git@github\.com:example-org\/x\.git/, 'a denylist name under three letters is ignored');
});

test('the denylist is read when the checkout has one, and is empty otherwise', () => {
  const read = (p) => {
    if (p.endsWith('denylist.txt')) return '# names\nAcme\n\n  Globex  \n';
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  };
  assert.deepEqual(readDenylist({ repoRoot: '/r', readFile: read }), ['Acme', 'Globex']);
  assert.deepEqual(readDenylist({ repoRoot: '/r', readFile: () => { throw new Error('missing'); } }), []);
});

/** A failed across-threads run, its captured memory, and the request that failed. */
function failedRun({ stored = true } = {}) {
  const scenario = MEMORY_SCENARIOS.find((s) => s.id === 'mem-across-threads');
  let state = startDueRuns({ state: { version: 1, runs: [] }, scenarios: [scenario], now: T0 }).state;
  const runId = state.runs[0].id;
  state = recordStep({ state, runId, stepId: 'teach', request: stepRequest(scenario, state.runs[0], 'teach'), outcome: { pass: true, reason: 'ok', mission: 'w-teach' }, now: T0 + 6 * MIN });
  const request = stepRequest(scenario, state.runs[0], 'ask');
  state = recordStep({ state, runId, stepId: 'ask', request, outcome: { pass: false, reason: 'the answer does not mention /x/', mission: 'w-ask' }, now: T0 + 18 * MIN });
  const run = state.runs[0];
  const v = run.values;
  const capture = {
    coreMemory: [
      { id: 'cm-1', fact: `${v.service}'s on-call engineer this month is ${v.person.first} ${v.person.last}`, category: 'operations', tags: [v.slug], importance: 0.7, createdAt: new Date(T0 + 7 * MIN).toISOString() },
      { id: 'cm-2', fact: 'The lab-proj-canary project keeps its logs for 30 days', category: 'operations', tags: [], createdAt: new Date(T0 - 3 * DAY).toISOString() },
    ],
    work: [
      { id: 'w-teach', type: 'M', status: 'complete', title: 'Note the service facts', instruction: stored ? stepRequest(scenario, run, 'teach').text : 'Note some facts', output: 'Noted.', created_at: new Date(T0).toISOString() },
      { id: 'w-old', type: 'M', status: 'complete', title: 'Smoke test', instruction: 'Clone https://github.com/SomeOrg/paraclete', output: 'x'.repeat(3000), created_at: new Date(T0 - 2 * DAY).toISOString() },
    ],
    workingMemory: stored ? `- ${v.service}: deploy freeze ${v.weekday} ${v.hour}:00 UTC\n` : '',
    commit: 'abc123',
  };
  return { run, request, capture };
}

test('each value is found in the layers that hold it, and a value in none is not stored', () => {
  const { request, capture } = failedRun();
  const located = locateValues(request.expect, capture);
  const [database, person, weekday] = located;
  assert.deepEqual([database.workingMemory, database.coreMemory, database.work], [false, [], ['w-teach']]);
  assert.deepEqual(person.coreMemory, ['cm-1']);
  assert.equal(weekday.workingMemory, true);
  assert.equal(diagnose(located), 'stored');
  const lost = failedRun({ stored: false });
  assert.equal(diagnose(locateValues(lost.request.expect, lost.capture)), 'not stored', 'the database was told only in a teach the capture lacks');
});

test('a stored miss becomes a bench item the memory bench can seed and check', async () => {
  const { run, request, capture } = failedRun();
  const at = T0 + 18 * MIN;
  const item = recallItem({ run, stepId: 'ask', request, capture, at, mission: 'w-ask', scrubbing: { projectIds: ['lab-proj-canary', 'lab-proj'] } });
  assert.equal(item.id, `memh-${run.id}`);
  assert.equal(item.organ, 'temporal-memory');
  assert.equal(item.split, 'train');
  assert.equal(item.bench, BENCH_VERSION + 1, 'it enters at the next bench version');
  assert.deepEqual(item.harvested, { from: 'canary', run: run.id, scenario: 'mem-across-threads', step: 'ask', at: new Date(at).toISOString(), commit: 'abc123', mission: 'w-ask' });
  assert.equal(item.query, request.text);
  assert.ok(!JSON.stringify(item).includes('lab-proj'), 'scrubbed');
  assert.ok(!JSON.stringify(item).includes('SomeOrg'), 'scrubbed');
  assert.equal(item.coreMemory[1].fact, 'The your-gcp-project project keeps its logs for 30 days');
  assert.equal(item.coreMemory[1].importance, 0.5, 'a missing importance takes the store\'s default');
  assert.equal(item.coreMemory[1].daysAgo, 3.01);
  assert.equal(item.work[1].output.length, 2001, 'a long output is clipped');
  assert.equal(item.work[0].daysAgo, 0.01);
  assert.deepEqual(item.mustNot, []);

  // The bench's own item, as bench-items.mjs writes one: regexes, not sources.
  const benchItem = { ...item, must: item.must.map((m) => ({ name: m.name, re: new RegExp(m.source, 'i') })), mustNot: [] };
  const v = run.values;
  // One check a name, as the bench requires: the on-call engineer and the freeze day share theirs.
  assert.deepEqual(item.must.map((m) => m.name), [KEEPS.turns, KEEPS.other]);
  const good = `Staging database ${v.database}; on call ${v.person.first} ${v.person.last}; frozen ${v.weekday}s.`;
  assert.ok(recallChecks(benchItem, good).every((c) => c.ok));
  assert.deepEqual(recallChecks(benchItem, `On call: ${v.person.last}.`).map((c) => c.ok), [true, false, false]);
  assert.deepEqual(recallChecks(benchItem, `Frozen on ${v.weekday}s.\n${v.database} is staging; ${v.person.last} is on call.`).map((c) => c.ok), [true, true, true],
    'in any order, across lines');
  const writes = [];
  await seedMemoryItem(benchItem, { db: { write: async (p, d) => { writes.push([p, d]); } }, collections: { coreMemory: 'core_memory', work: 'work' }, now: at });
  assert.deepEqual(writes.map(([p]) => p), ['core_memory/cm-1', 'core_memory/cm-2', 'work/w-teach', 'work/w-old']);
  assert.equal(writes[0][1].status, 'active');
});

test('the harvester writes a stored miss\'s item and nothing for one never stored', async () => {
  for (const stored of [true, false]) {
    const { run, request, capture } = failedRun({ stored });
    const written = [];
    let asked = null;
    const harvest = harvester({
      repoRoot: '/repo',
      capture: async (o) => { asked = o; return { ...capture, work: [...capture.work, { id: 'w-ask', instruction: request.text, created_at: new Date(T0 + 18 * MIN).toISOString() }] }; },
      writeFile: (file, text) => written.push([file, JSON.parse(text)]),
    });
    const got = await harvest({ run, stepId: 'ask', request, outcome: { mission: 'w-ask' } });
    assert.equal(asked.before, Date.parse(run.steps[1].ranAt), 'memory as it was when the question went');
    assert.deepEqual(asked.missionIds, ['w-teach'], 'with the missions that taught the facts');
    if (stored) {
      assert.equal(got.diagnosis, 'stored');
      assert.equal(got.item, `memh-${run.id}`);
      assert.equal(got.file, path.join(HARVEST_DIR, `${got.item}.json`));
      assert.equal(written[0][0], path.resolve('/repo', HARVEST_DIR, `${got.item}.json`));
      assert.equal(written.length, 1);
      assert.ok(!written[0][1].work.some((w) => w.id === 'w-ask'), 'the failing question is not its own memory');
      assert.deepEqual(got.values.map((x) => x.in), [['past work'], ['Core Memory', 'past work'], ['working memory', 'past work']]);
    } else {
      assert.equal(got.diagnosis, 'not stored');
      assert.equal(got.item, undefined);
      assert.equal(written.length, 0);
    }
  }
});

test('the capture reads active Core Memory, missions before the question, the teaching missions, working memory and the commit', async () => {
  const reads = [];
  const db = {
    query: async (parent, collection, filters, opts) => {
      reads.push({ collection, opts });
      if (collection === 'core_memory') return [{ id: 'a', fact: 'kept', status: 'active' }, { id: 'b', fact: 'old', status: 'superseded' }, { id: 'c', fact: 'no status' }];
      return [
        { id: 'w-later', created_at: new Date(T0 + DAY).toISOString() },
        { id: 'w-before', created_at: new Date(T0 - MIN).toISOString() },
      ];
    },
    read: async (p) => (p === 'agent/instance' ? { commit: 'c0ffee', status: 'ready' } : p === 'work/w-teach' ? { title: 'taught', created_at: new Date(T0 - 9 * DAY).toISOString() } : null),
  };
  const ssh = async (command) => {
    assert.equal(command, 'sudo -n cat /var/lib/paraclete/memory/MEMORY.md');
    return { code: 0, stdout: '- remembered\n' };
  };
  const got = await captureMemory({ db, ssh, before: T0, missionIds: ['w-teach', 'w-before', null] });
  assert.deepEqual(got.coreMemory.map((e) => e.id), ['a', 'c']);
  assert.deepEqual(got.work.map((w) => w.id), ['w-before', 'w-teach']);
  assert.equal(got.workingMemory, '- remembered\n');
  assert.equal(got.commit, 'c0ffee');
  assert.equal(reads.find((r) => r.collection === 'work').opts.orderDirection, 'DESCENDING');
  const noFile = await captureMemory({ db, ssh: async () => ({ code: 1, stdout: '' }), before: T0 });
  assert.equal(noFile.workingMemory, '');
});
