// Tests for dev/harness2/verification-harvest.mjs: the mission behind a failed step is read as its
// verifiers saw it; wrong work a checkpoint passed becomes a defective cerebellum item the bench can
// run, and right work answered wrongly, work the cerebellum caught, or work no checkpoint saw becomes
// none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { VERIFICATION_SCENARIOS } from '../../../dev/harness2/scenario-items.mjs';
import { recordStep, startDueRuns, stepRequest } from '../../../dev/harness2/scenarios.mjs';
import { BENCH_VERSION, verificationChecks } from '../../../dev/harness2/bench.mjs';
import { DEFECT_KINDS } from '../../../dev/harness2/bench-items.mjs';
import { readHarvestedItem } from '../../../dev/harness2/harvested-items.mjs';
import {
  VERIFICATION_HARVEST_DIR, captureMission, diagnoseMission, judgedCriteria, verificationHarvester, verificationItem,
} from '../../../dev/harness2/verification-harvest.mjs';

const T0 = Date.parse('2027-03-07T09:00:00Z');
const MIN = 60_000;
// The address scrubbing must replace is joined here, so the repo's hygiene test never sees one.
const AT = '@';

/** A failed run of the day-count scenario, and the request its answer missed. */
function failedRun() {
  const scenario = VERIFICATION_SCENARIOS.find((s) => s.id === 'ver-day-count');
  let state = startDueRuns({ state: { version: 1, runs: [] }, scenarios: [scenario], now: T0 }).state;
  const runId = state.runs[0].id;
  const request = stepRequest(scenario, state.runs[0], 'work');
  state = recordStep({ state, runId, stepId: 'work', request, outcome: { pass: false, reason: 'the answer does not mention /x/', mission: 'w-m' }, now: T0 + 9 * MIN });
  return { run: state.runs[0], request };
}

/** A mission's work documents: two checkpoints, the second judged on what its task left. */
function missionDocs({ second = 'complete', answer }) {
  return [
    { id: 'w-m', type: 'M', status: 'complete', output: `It is ${answer} days.` },
    { id: 'w-c1', type: 'C', parent_id: 'w-m', status: 'complete', instruction: 'Find the dates', accept_criteria: 'Both dates are read from the request', source_meta: { checkpoint: 1 }, created_at: '2027-03-07T09:01:00Z' },
    { id: 'w-c2', type: 'C', parent_id: 'w-m', status: second, instruction: 'Count the days, both ends included', accept_criteria: '', source_meta: { checkpoint: 2 }, created_at: '2027-03-07T09:03:00Z' },
    { id: 'w-t1', type: 'T', parent_id: 'w-c1', output: `Start and end dates noted. Connect at agent${AT}lab-proj.example.io.`, source_meta: { task_step: 1, agent: 'motor' }, created_at: '2027-03-07T09:01:30Z' },
    { id: 'w-t3', type: 'T', parent_id: 'w-c2', output: `[TOOL] runCommand(python3 count.py) → ${answer}\nThe range is ${answer} days.`, source_meta: { task_step: 2, agent: 'motor' }, created_at: '2027-03-07T09:04:00Z' },
    { id: 'w-t2', type: 'T', parent_id: 'w-c2', output: 'Wrote count.py.', source_meta: { task_step: 1, agent: 'motor' }, created_at: '2027-03-07T09:03:30Z' },
    { id: 'w-x', type: 'T', parent_id: 'w-other', output: 'not this mission' },
  ];
}

const fakeDb = (docs) => ({
  query: async (parent, collection, filters) => {
    assert.equal(collection, 'work');
    const [{ field, op, value }] = filters;
    assert.deepEqual([field, op], ['parent_id', 'EQUAL']);
    assert.deepEqual(Object.keys(value), ['stringValue'], 'the filter value is encoded, as Firestore takes it');
    return docs.filter((d) => d.parent_id === value.stringValue);
  },
  read: async (p) => (p === 'agent/instance' ? { commit: 'c0ffee' } : docs.find((d) => `work/${d.id}` === p) || null),
});

test('the mission is read as its verifiers saw it: checkpoints in order, each with its criteria and its tasks as rows', async () => {
  const got = await captureMission({ db: fakeDb(missionDocs({ answer: 41 })), missionId: 'w-m' });
  assert.equal(got.commit, 'c0ffee');
  assert.equal(got.mission.status, 'complete');
  assert.deepEqual(got.checkpoints.map((c) => [c.n, c.status]), [[1, 'complete'], [2, 'complete']]);
  assert.deepEqual(got.checkpoints[1].rows.map((r) => r.step), ['2.1', '2.2']);
  assert.equal(got.checkpoints[1].acceptCriteria, judgedCriteria({ instruction: 'Count the days, both ends included' }), 'a checkpoint planned without criteria is judged on its outcome');
  assert.match(got.checkpoints[1].acceptCriteria, /stated outcome is achieved: "Count the days/);
});

test('a checkpoint that passed work lacking the right value is the cerebellum\'s miss; right work, a caught one, or none is not', async () => {
  const { request, run } = failedRun();
  const right = run.values.range.days;
  const capture = async (docs) => captureMission({ db: fakeDb(docs), missionId: 'w-m' });
  const missed = diagnoseMission(await capture(missionDocs({ answer: right - 1 })), request.expect);
  assert.equal(missed.diagnosis, 'verified wrong work');
  assert.equal(missed.checkpoint.n, 2, 'the last checkpoint that passed without the value');
  assert.equal(diagnoseMission(await capture(missionDocs({ answer: right })), request.expect).diagnosis, 'right work, wrong answer');
  const caught = missionDocs({ second: 'failed', answer: right - 1 }).map((d) => (d.id === 'w-c1' ? { ...d, status: 'failed' } : d));
  assert.equal(diagnoseMission(await capture(caught), request.expect).diagnosis, 'caught');
  assert.equal(diagnoseMission(await capture([{ id: 'w-m', type: 'M' }]), request.expect).diagnosis, 'no checkpoint');
  // When the answer's words are in the evidence of wrong work too (a failed fetch's own error), rows
  // that hold them prove nothing, and the last checkpoint that passed is the miss.
  const fetched = diagnoseMission(await capture(missionDocs({ answer: right })), request.expect, { answerInRows: false });
  assert.deepEqual([fetched.diagnosis, fetched.checkpoint.n], ['verified wrong work', 2]);
});

test('the miss becomes a defective cerebellum item the bench can run, scrubbed, once the version is raised', async () => {
  const { run, request } = failedRun();
  const written = [];
  const harvest = verificationHarvester({
    repoRoot: '/repo',
    capture: async ({ missionId }) => captureMission({ db: fakeDb(missionDocs({ answer: run.values.range.days - 1 })), missionId }),
    scrubbing: { projectIds: ['lab-proj'] },
    writeFile: (file, text) => written.push([file, text]),
  });
  const got = await harvest({ run, stepId: 'work', request, outcome: { mission: 'w-m' } });
  assert.equal(got.diagnosis, 'verified wrong work');
  assert.equal(got.item, `cbh-${run.id}-defect`);
  assert.equal(got.file, path.join(VERIFICATION_HARVEST_DIR, `${got.item}.json`));
  assert.equal(written[0][0], path.resolve('/repo', VERIFICATION_HARVEST_DIR, `${got.item}.json`));
  const raw = JSON.parse(written[0][1]);
  assert.deepEqual(raw.harvested, { from: 'canary', run: run.id, scenario: 'ver-day-count', step: 'work', at: new Date(T0 + 9 * MIN).toISOString(), commit: 'c0ffee', mission: 'w-m', checkpoint: 2 });
  assert.ok(!written[0][1].includes('lab-proj'), 'scrubbed');
  assert.ok(DEFECT_KINDS.includes(raw.kind), raw.kind);
  assert.equal(raw.bench, BENCH_VERSION + 1);

  const item = readHarvestedItem(written[0][1], { file: path.basename(got.file), version: BENCH_VERSION + 1 });
  assert.deepEqual([item.organ, item.expect, item.split], ['cerebellum', 'fail', 'train']);
  assert.ok(item.acceptCriteria.length > 20 && item.rows.every((r) => r.step && r.agent && r.result));
  assert.deepEqual(verificationChecks(item, { passed: false }).map((c) => [c.name, c.ok]), [[`the verdict on work with ${raw.kind}`, true]], 'a verifier that fails it catches it');
  assert.deepEqual(verificationChecks(item, { passed: true }).map((c) => c.ok), [false]);

  for (const outcome of [{ mission: null }, {}]) {
    assert.deepEqual(await harvest({ run, stepId: 'work', request, outcome }), { diagnosis: 'not captured', reason: 'the step named no mission' });
  }
});

test('a long task output is clipped in its row', () => {
  const { run, request } = failedRun();
  const checkpoint = { n: 1, instruction: 'Count', acceptCriteria: 'The count includes both ends of the range', rows: [{ step: '1.1', agent: 'motor', result: 'x'.repeat(9000) }] };
  const item = verificationItem({ run, stepId: 'work', request, checkpoint, at: T0 });
  assert.equal(item.rows[0].result.length, 6001);
});
