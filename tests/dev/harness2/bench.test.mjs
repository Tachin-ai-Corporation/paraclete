// Tests for dev/harness2/bench.mjs and its items, bench-items.mjs: the items are well formed and
// balanced; the scoring gives a verdict and a packet their checks; every memory item is fair (the
// facts it asks for and the distractors it tests reach the organ's candidates, through the product's
// own recall); a verifier that passes everything scores half the cerebellum's bench, and one that is
// always right scores all of it; and the `bench` command runs an organ's items as measured runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCHES, BENCH_PORTS, loadBenchPorts, recallChecks, runBenchItem, selectBenchItems, verificationChecks,
} from '../../../dev/harness2/bench.mjs';
import { runCli } from '../../../dev/harness2/cli.mjs';
import { createModelRunContext, loadSideProduct } from '../../../dev/harness2/model-runs.mjs';
import { verdict } from '../../agent/services/brain/fake-gateway.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const quiet = { write() {} };
const meterOnly = { meter: { startRollout() {}, addTokens() {} } };

test('the items are well formed: unique ids, both splits, and the cerebellum\'s in clean and defective pairs', () => {
  for (const [organ, items] of Object.entries(BENCHES)) {
    assert.ok(items.length >= 10, organ);
    assert.equal(new Set(items.map((i) => i.id)).size, items.length, `${organ}: unique ids`);
    assert.ok(items.every((i) => i.organ === organ && ['train', 'holdout'].includes(i.split)), organ);
    assert.ok(items.some((i) => i.split === 'train') && items.some((i) => i.split === 'holdout'), `${organ}: both splits`);
  }
  const cb = BENCHES.cerebellum;
  for (const item of cb) {
    assert.ok(item.rows.length > 0 && item.rows.every((r) => r.step && r.agent && r.result), item.id);
    assert.ok(item.acceptCriteria.length > 20, item.id);
  }
  const ids = new Set(cb.map((i) => i.id));
  for (const item of cb.filter((i) => i.expect === 'fail')) {
    const clean = cb.find((i) => i.id === item.id.replace(/-defect$/, '-clean'));
    assert.ok(clean && ids.has(clean.id), `${item.id} has a clean twin`);
    assert.deepEqual([clean.split, clean.acceptCriteria], [item.split, item.acceptCriteria], `${item.id}: one checkpoint, two outcomes`);
    assert.ok(item.flaw, `${item.id} says what is wrong`);
  }
  assert.equal(cb.filter((i) => i.expect === 'pass').length, cb.filter((i) => i.expect === 'fail').length, 'as many clean as defective');
  for (const item of BENCHES['temporal-memory']) {
    assert.ok(item.query && item.must.length > 0, item.id);
    assert.ok([...item.must, ...item.mustNot].every((m) => m.name && m.re instanceof RegExp), item.id);
  }
  assert.deepEqual(selectBenchItems({ organ: 'cerebellum', ids: ['cb-tests-pass-clean'] }).map((i) => i.id), ['cb-tests-pass-clean']);
  assert.ok(selectBenchItems({ organ: 'cerebellum', split: 'holdout' }).every((i) => i.split === 'holdout'));
  assert.deepEqual(selectBenchItems({ organ: 'cortex' }), []);
});

test('a verdict passes its check only when it is the expected one, given decisively', () => {
  const clean = { expect: 'pass' };
  const defect = { expect: 'fail', flaw: 'West is missing' };
  assert.equal(verificationChecks(clean, { passed: true, verdict: 'met_with_caveat' })[0].ok, true, 'a pass with a caveat is a pass');
  assert.deepEqual(verificationChecks(clean, { passed: false })[0], { name: "the verifier's verdict is pass", ok: false, detail: 'got fail' });
  assert.equal(verificationChecks(defect, { passed: false, inconclusive: false })[0].ok, true);
  assert.deepEqual(verificationChecks(defect, { passed: false, inconclusive: true })[0], {
    name: "the verifier's verdict is fail (West is missing)", ok: false, detail: 'got no verdict',
  }, 'a verifier that never answered caught nothing');
  const item = { must: [{ name: 'says PDF', re: /pdf/i }], mustNot: [{ name: 'leaves out Globex', re: /globex/i }] };
  assert.deepEqual(recallChecks(item, 'Acme wants PDF.').map((c) => c.ok), [true, true, true]);
  assert.deepEqual(recallChecks(item, 'Acme wants PDF; Globex wants Excel.').map((c) => c.ok), [true, true, false]);
  assert.deepEqual(recallChecks(item, '').map((c) => c.ok), [false, false, true]);
});

test("every memory item is fair: what it asks for, and what it tests leaving out, reach the organ's candidates", async () => {
  const product = await loadSideProduct(REPO);
  const ports = await loadBenchPorts(REPO, 'temporal-memory');
  for (const item of BENCHES['temporal-memory']) {
    const asked = [];
    // An organ that hands back its candidates as its packet, asking for the deeper history first when
    // the item needs it.
    const echo = async (organ, payload) => {
      asked.push(payload.instruction);
      if (item.deep && asked.length === 1) return { success: true, output: JSON.stringify({ recall_escalate: true, cues: ['certificate', 'api.example.com'], reason: 'older work' }) };
      return { success: true, output: payload.instruction };
    };
    const res = await runBenchItem(item, { sideRoot: REPO, product, ports, realModel: meterOnly, callAgent: echo });
    const checks = res.fixtureVerification.checks;
    const must = checks.filter((c) => item.must.some((m) => m.name === c.name));
    const mustNot = checks.filter((c) => item.mustNot.some((m) => m.name === c.name));
    assert.ok(must.every((c) => c.ok), `${item.id}: ${must.filter((c) => !c.ok).map((c) => c.name).join(', ')} never reach the organ`);
    assert.ok(mustNot.every((c) => !c.ok), `${item.id}: a distractor that never reaches the organ tests nothing`);
    assert.equal(asked.length, item.deep ? 2 : 1, item.id);
    if (item.deep) assert.ok(!item.must.every((m) => m.re.test(asked[0])), `${item.id}: only the deeper history holds its facts`);
  }
});

test("the cerebellum's bench: a verifier that passes everything scores half, and one that is always right scores all", async () => {
  const product = await loadSideProduct(REPO);
  const ports = await loadBenchPorts(REPO, 'cerebellum');
  const run = async (answer) => {
    let total = 0;
    for (const item of BENCHES.cerebellum) {
      const res = await runBenchItem(item, { sideRoot: REPO, product, ports, realModel: meterOnly, callAgent: async () => ({ success: true, output: answer(item) }) });
      total += res.checkScore;
    }
    return total / BENCHES.cerebellum.length;
  };
  assert.equal(await run(() => verdict(true)), 0.5);
  assert.equal(await run((item) => verdict(item.expect === 'pass')), 1);
  assert.equal(await run(() => 'I looked at the files.'), 0, 'no verdict is never right');
});

test("a bench's ports come from the side's root, and a side without them cannot be benched", async () => {
  assert.deepEqual(Object.keys(BENCH_PORTS).sort(), ['cerebellum', 'client', 'temporal-memory']);
  const ports = await loadBenchPorts(REPO, 'cerebellum');
  assert.deepEqual(Object.keys(ports).sort(), ['createGatewayClient', 'verifyMilestone']);
  await assert.rejects(loadBenchPorts(REPO, 'cortex'), /there is no bench for the organ cortex/);
  await assert.rejects(loadBenchPorts(path.join(REPO, 'docs'), 'cerebellum'), /has no agent\/services\/brain\/gateway-client\.mjs/);
});

test('the bench command runs an organ\'s items as measured runs, and refuses without the real model or an organ', async () => {
  const context = () => createModelRunContext({
    repoRoot: REPO,
    access: { project: 'your-gcp-project', getAccessToken: async () => 'token' },
    sides: { forPatches: () => ({ root: REPO, key: 'k' }), prepareRole: (s, role) => ({ role }), cleanupAll() {} },
    startGateway: async () => { throw new Error('no gateway in a test'); },
  });
  // A scripted verifier that passes the work only when West's row is in its evidence.
  const westOrFail = async (organ, payload) => ({ success: true, output: verdict(/West,88\.00/.test(payload.instruction)) });
  const res = await runCli(['bench', '--real-model', '--organ', 'cerebellum', '--item', 'cb-regions-csv-clean,cb-regions-csv-defect', '--trials', '2'], {
    repoRoot: REPO, createModelRunContext: context, benchCallAgent: westOrFail, stderr: quiet,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.organ, 'cerebellum');
  assert.deepEqual(res.trajectories.map((t) => [t.taskId, t.trial, t.measured, t.checkScore]), [
    ['cb-regions-csv-clean', 1, true, 1], ['cb-regions-csv-defect', 1, true, 1],
    ['cb-regions-csv-clean', 2, true, 1], ['cb-regions-csv-defect', 2, true, 1],
  ]);
  const noModel = await runCli(['bench', '--organ', 'cerebellum'], { repoRoot: REPO, stderr: quiet });
  assert.deepEqual([noModel.ok, noModel.reason], [false, 'a bench asks the real model: pass --real-model']);
  const noOrgan = await runCli(['bench', '--real-model', '--organ', 'cortex'], { repoRoot: REPO, createModelRunContext: context, stderr: quiet });
  assert.match(noOrgan.reason, /there is no bench for cortex; name one with --organ: cerebellum, temporal-memory/);
});
