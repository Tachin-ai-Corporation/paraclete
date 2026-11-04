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
  BENCHES, BENCH_PORTS, BENCH_VERSION, RETIRED_BENCH_ITEMS, briefChecks, loadBenchPorts, recallChecks, runBenchItem, selectBenchItems, verificationChecks,
} from '../../../dev/harness2/bench.mjs';
import { BRIEF_CHECKS, DEFECT_KINDS, RECALL_KEEPS, RECALL_LEAVES } from '../../../dev/harness2/bench-items.mjs';
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
  // A check is named for the kind of mistake it catches, never for its item's facts: a lane's issue
  // quotes failing checks by name.
  for (const item of cb) assert.ok(DEFECT_KINDS.includes(item.kind), `${item.id}: ${item.kind}`);
  for (const item of BENCHES['temporal-memory']) {
    assert.ok(item.must.every((m) => RECALL_KEEPS.includes(m.name)) && item.mustNot.every((m) => RECALL_LEAVES.includes(m.name)), item.id);
    const names = [...item.must, ...item.mustNot].map((m) => m.name);
    assert.equal(new Set(names).size, names.length, `${item.id}: one check a name`);
  }
  assert.deepEqual(selectBenchItems({ organ: 'cerebellum', ids: ['cb-tests-pass-clean'] }).map((i) => i.id), ['cb-tests-pass-clean']);
  assert.ok(selectBenchItems({ organ: 'cerebellum', split: 'holdout' }).every((i) => i.split === 'holdout'));
  assert.deepEqual(selectBenchItems({ organ: 'cortex' }), []);
  // Versions 2 and 3 retired what every run judged right; a retired item runs only when named.
  assert.equal(BENCH_VERSION, 3);
  for (const id of RETIRED_BENCH_ITEMS) assert.ok(Object.values(BENCHES).flat().some((i) => i.id === id), `${id} is defined`);
  assert.ok(selectBenchItems({ organ: 'cerebellum' }).every((i) => !RETIRED_BENCH_ITEMS.includes(i.id)));
  assert.deepEqual(selectBenchItems({ organ: 'cerebellum', ids: ['cb-regions-csv-defect'] }).map((i) => i.id), ['cb-regions-csv-defect']);
  assert.deepEqual(['cerebellum', 'temporal-memory', 'prefrontal'].map((organ) => selectBenchItems({ organ }).length), [36, 12, 28]);
  for (const organ of Object.keys(BENCHES)) {
    const active = selectBenchItems({ organ });
    assert.ok(active.some((i) => i.split === 'train') && active.some((i) => i.split === 'holdout'), `${organ}: both splits still run`);
  }
});

test("version 3's cerebellum pairs hold the facts their flaws name: one difference each, and the clean side right", () => {
  const item = (id) => BENCHES.cerebellum.find((i) => i.id === id);
  const out = (id, n = 0) => item(id).rows[n].result;
  const cell = (text, re) => text.match(re)?.[1];
  // Each pair's two sides differ, and only in the evidence: one checkpoint, two outcomes.
  for (const clean of BENCHES.cerebellum.filter((i) => i.id.startsWith('cb3-') && i.expect === 'pass')) {
    const defect = item(clean.id.replace(/-clean$/, '-defect'));
    assert.notDeepEqual(clean.rows, defect.rows, clean.id);
    assert.equal(clean.instruction, defect.instruction, clean.id);
  }
  // The nine amounts sum to the clean total; the defect's leaves the taxi out.
  const amounts = out('cb3-expense-sum-clean').split('\n').slice(1).map((l) => Number(l.split(',').pop())).filter(Number.isFinite);
  assert.equal(amounts.length, 9);
  const sum = amounts.reduce((a, b) => a + b, 0);
  assert.equal(sum.toFixed(2), out('cb3-expense-sum-clean', 1).match(/→ (\S+)/)[1]);
  assert.equal((sum - 47.2).toFixed(2), out('cb3-expense-sum-defect', 1).match(/→ (\S+)/)[1]);
  // Twelve stores, each with a row on the clean side, in another order; the defect lacks S-09 only.
  const stores = out('cb3-store-rows-clean').split('→ ')[1].split('\n');
  const rows = (id) => out(id, 1).split('\n').filter((l) => /^S-\d\d,/.test(l)).map((l) => l.split(',')[0]);
  assert.equal(stores.length, 12);
  assert.deepEqual([...rows('cb3-store-rows-clean')].sort(), stores);
  assert.notDeepEqual(rows('cb3-store-rows-clean'), stores, 'the clean rows are in another order, which the criteria allow');
  assert.deepEqual(stores.filter((s) => !rows('cb3-store-rows-defect').includes(s)), ['S-09']);
  // The clean ranking sorts the shortlist by number, largest first; the defect's sorts it as text.
  const shortlist = out('cb3-top-balances-clean').split('→ ')[1].split('\n');
  const ranked = (id) => out(id, 1).split('→ ')[1].split('\n').filter((l) => /^A-\d\d \d+$/.test(l));
  const by = (cmp) => [...shortlist].sort((a, b) => cmp(a.split(' ')[1], b.split(' ')[1]));
  assert.deepEqual(ranked('cb3-top-balances-clean'), by((a, b) => Number(b) - Number(a)));
  assert.deepEqual(ranked('cb3-top-balances-defect'), by((a, b) => b.localeCompare(a)));
  // Churn is the lost over the customers at the start, to one decimal; the defect divides by the end.
  const m = JSON.parse(out('cb3-churn-base-clean').split('→ ')[1]);
  assert.equal(cell(out('cb3-churn-base-clean', 1), /Churn: ([\d.]+)%/), (100 * m.customers_lost / m.customers_start).toFixed(1));
  assert.equal(cell(out('cb3-churn-base-defect', 1), /Churn: ([\d.]+)%/), (100 * m.customers_lost / m.customers_end).toFixed(1));
  assert.notEqual((100 * m.customers_lost / m.customers_start).toFixed(1), (100 * m.customers_lost / m.customers_end).toFixed(1));
  // The clean upload's checksums match; the defect's differ.
  const md5s = (id) => [cell(out(id, 1), /\n([0-9a-f]{32}) {2}archive/), cell(out(id, 1), /hash_md5: ([0-9a-f]{32})/)];
  const [local, remote] = md5s('cb3-upload-checksum-defect');
  assert.deepEqual(new Set(md5s('cb3-upload-checksum-clean')).size, 1);
  assert.ok(local && remote && local !== remote);
  // 30 March 2027 is after Europe/Berlin moved to summer time, so 16:00 there is 14:00 UTC.
  const berlin = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  assert.equal(berlin.format(new Date('2027-03-30T14:00:00Z')), '16:00');
  assert.match(out('cb3-summer-time-call-clean'), /16:00 Berlin time \(14:00 UTC\)/);
  assert.equal(new Date('2027-03-30T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }), 'Tuesday');
  // The stale report's clean side regenerates it from 4 March's load, after that load; the defect's
  // from 1 March's.
  assert.match(out('cb2-stale-report-clean'), /--data data\/loads\/2027-03-04\.csv[\s\S]*2027-03-04 09:00 data\/loads\/2027-03-04\.csv[\s\S]*2027-03-04 10:31 report\.pdf/);
  assert.match(out('cb2-stale-report-defect'), /Read [\d,]+ rows from data\/loads\/2027-03-01\.csv/);
  // The checks of state. The clean dump is 4 March's and over 2 GB; the defect's is 4 March's and far
  // under it.
  const dump = (id) => out(id).split('\n').map((l) => l.match(/ (\d+) (2027-03-04) (\d\d:\d\d) orders-2027-03-04\.dump$/)).find(Boolean);
  assert.ok(Number(dump('cb3-backup-check-clean')[1]) >= 2e9 && dump('cb3-backup-check-clean')[3] > '02:00');
  assert.ok(Number(dump('cb3-backup-check-defect')[1]) < 2e8 && dump('cb3-backup-check-defect')[3] > '02:00');
  // The certificate served on the clean side was issued on or after 1 March and lasts past 31 May; the
  // defect's was issued before 1 March; both sides' certbot rows agree.
  const served = (id) => ['notBefore', 'notAfter'].map((k) => Date.parse(`${cell(out(id, 1), new RegExp(`${k}=(.+)`)).replace(/ GMT$/, '')} UTC`));
  const [cleanFrom, cleanTo] = served('cb3-cert-served-clean');
  assert.ok(cleanFrom >= Date.parse('2027-03-01T00:00:00Z') && cleanTo >= Date.parse('2027-05-31T23:59:59Z'));
  assert.ok(served('cb3-cert-served-defect')[0] < Date.parse('2027-03-01T00:00:00Z'));
  assert.equal(out('cb3-cert-served-clean'), out('cb3-cert-served-defect'));
  // The clean SPF record includes the host the criteria name; the defect's names another domain.
  const spf = (id) => cell(out(id), /"(v=spf1[^"]*)"/).split(' ');
  assert.ok(spf('cb3-mail-records-clean').includes('include:_spf.mailhost.example.net'));
  assert.ok(!spf('cb3-mail-records-defect').includes('include:_spf.mailhost.example.net'));
  // The clean version is the release itself; the defect's only starts with it.
  const version = (id) => JSON.parse(cell(out(id), /→ (\{.*\})/)).version;
  assert.deepEqual([version('cb3-version-live-clean'), version('cb3-version-live-defect')], ['2.4.1', '2.4.1-rc.2']);
});

test('a verdict passes its check only when it is the expected one, given decisively', () => {
  const clean = { expect: 'pass', kind: 'a row missing' };
  const defect = { expect: 'fail', kind: 'a row missing', flaw: 'West is missing' };
  assert.equal(verificationChecks(clean, { passed: true, verdict: 'met_with_caveat' })[0].ok, true, 'a pass with a caveat is a pass');
  assert.deepEqual(verificationChecks(clean, { passed: false })[0], { name: 'the verdict on work that meets its criteria', ok: false, detail: 'got fail' });
  assert.equal(verificationChecks(defect, { passed: false, inconclusive: false })[0].ok, true);
  assert.deepEqual(verificationChecks(defect, { passed: false, inconclusive: true })[0], {
    name: 'the verdict on work with a row missing', ok: false, detail: 'got no verdict',
  }, 'a verifier that never answered caught nothing; the flaw itself is not named');
  // A wrong verdict's detail carries the verifier's own reason: its fail summary, or its caveat.
  assert.equal(verificationChecks(clean, { passed: false, summary: 'No  evidence\nof the load.' })[0].detail, 'got fail: No evidence of the load.');
  assert.equal(verificationChecks(defect, { passed: true, caveats: ['One region looks short.'] })[0].detail, 'got pass: One region looks short.');
  assert.equal(verificationChecks(clean, { passed: false, summary: 'x'.repeat(500) })[0].detail.length, 'got fail: '.length + 240);
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
      if (item.deep && asked.length === 1) return { success: true, output: JSON.stringify({ recall_escalate: true, cues: item.deepCues, reason: 'older work' }) };
      return { success: true, output: payload.instruction };
    };
    const res = await runBenchItem(item, { sideRoot: REPO, product, ports, realModel: meterOnly, callAgent: echo });
    const checks = res.fixtureVerification.checks;
    const must = checks.filter((c) => item.must.some((m) => m.name === c.name));
    const mustNot = checks.filter((c) => item.mustNot.some((m) => m.name === c.name));
    assert.ok(must.every((c) => c.ok), `${item.id}: ${must.filter((c) => !c.ok).map((c) => c.name).join(', ')} never reach the organ`);
    assert.ok(mustNot.every((c) => !c.ok), `${item.id}: a distractor that never reaches the organ tests nothing`);
    assert.equal(asked.length, item.deep ? 2 : 1, item.id);
    assert.equal(Boolean(item.deep), Array.isArray(item.deepCues) && item.deepCues.length > 0, `${item.id}: a deep item names the cues it escalates with`);
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
  assert.deepEqual(Object.keys(BENCH_PORTS).sort(), ['cerebellum', 'client', 'prefrontal', 'temporal-memory']);
  assert.deepEqual(Object.keys(await loadBenchPorts(REPO, 'prefrontal')).sort(), ['analyzeRequest', 'capabilityMap', 'createGatewayClient', 'readSkills']);
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
  assert.match(noOrgan.reason, /there is no bench for cortex; name one with --organ: cerebellum, temporal-memory, prefrontal/);
});

// A Brief that keeps every rule a prefrontal item tests, or breaks every one of them.
const RISKS = ['none', 'mutating', 'destructive_or_public'];
function briefFor(item, { keep }) {
  const want = item.brief;
  const count = keep ? (want.minParts || (want.dependsOn ? 2 : 1)) : (want.maxParts ? 3 : 1);
  const risk = keep
    ? (want.risk || want.riskAtMost || 'mutating')
    : (want.risk ? RISKS.find((r) => r !== want.risk && r !== 'mutating') : 'destructive_or_public');
  const parts = Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    summary: keep ? `outcome ${i + 1} is reached` : 'run gsutil cp, values.append and dig to do it',
    risk: i === 0 || !keep ? risk : 'none',
    depends_on: keep && want.dependsOn && i > 0 ? ['p1'] : [],
    unknowns: (want.unknowns === true) === keep && i === 0 ? ['what the agent has no access to'] : [],
  }));
  const premise = keep ? (want.premise || 'sound') : (want.premise === 'flawed' ? 'sound' : 'flawed');
  return { objective: item.instruction, parts, premise };
}

test("every prefrontal item tests a rule its Brief can keep or break, and its checks are named for the rule", () => {
  const names = [BRIEF_CHECKS.wellFormed, ...Object.values(BRIEF_CHECKS.risk), BRIEF_CHECKS.noGate, ...Object.values(BRIEF_CHECKS.premise),
    BRIEF_CHECKS.onePart, BRIEF_CHECKS.parts, BRIEF_CHECKS.dependsOn, BRIEF_CHECKS.unknown, BRIEF_CHECKS.noUnknown, BRIEF_CHECKS.byOutcome];
  for (const item of BENCHES.prefrontal) {
    assert.ok(item.instruction && Object.keys(item.brief).length > 0, item.id);
    const kept = briefChecks(item, briefFor(item, { keep: true }));
    assert.ok(kept.length >= 2 && kept.every((c) => c.ok), `${item.id}: ${JSON.stringify(kept.filter((c) => !c.ok))}`);
    const broken = briefChecks(item, briefFor(item, { keep: false }));
    assert.ok(broken.slice(1).every((c) => !c.ok), `${item.id} catches every broken rule: ${JSON.stringify(broken.filter((c) => c.ok))}`);
    assert.ok(kept.every((c) => names.includes(c.name)), item.id);
    assert.equal(new Set(kept.map((c) => c.name)).size, kept.length, `${item.id}: one check a name`);
    if (item.brief.noTool) assert.equal(item.brief.noTool.test(`${item.instruction} ${item.context}`), false, `${item.id}: the request itself names no tool`);
  }
  // Both kinds of premise item, and risk items on both sides of the gate, are in each split.
  for (const split of ['train', 'holdout']) {
    const items = BENCHES.prefrontal.filter((i) => i.split === split);
    assert.ok(items.some((i) => i.brief.premise === 'flawed') && items.some((i) => i.brief.premise === 'sound'), split);
    assert.ok(items.some((i) => i.brief.risk === 'destructive_or_public') && items.some((i) => i.brief.riskAtMost || i.brief.risk === 'mutating'), split);
  }
  assert.deepEqual(briefChecks(BENCHES.prefrontal[0], { error: 'parse_failed' }), [{ name: BRIEF_CHECKS.wellFormed, ok: false, detail: 'the analysis failed: parse_failed' }]);
  assert.equal(briefChecks(BENCHES.prefrontal[0], { parts: [{ id: 'p1', summary: 's', risk: 'high' }] })[1].ok, false, 'a risk outside the tiers is none given');
});

test("the prefrontal's bench asks the side's own analyze request, with its capability map and what the agent recalled", async () => {
  const product = await loadSideProduct(REPO);
  const ports = await loadBenchPorts(REPO, 'prefrontal');
  const item = BENCHES.prefrontal.find((i) => i.recalled && i.brief.premise === 'sound');
  const asked = [];
  const askJson = async (req) => { asked.push(req); return briefFor(item, { keep: true }); };
  const res = await runBenchItem(item, { sideRoot: REPO, product, ports, realModel: meterOnly, askJson });
  assert.deepEqual([res.measured, res.checkScore], [true, 1]);
  assert.deepEqual([asked[0].organ, asked[0].mode, typeof asked[0].enforceSchema], ['prefrontal', 'analyze', 'function']);
  const user = JSON.parse(asked[0].user.slice(asked[0].user.indexOf('{')));
  assert.deepEqual([user.mode, user.instruction, user.context_summary, user.memory.recalled], ['analyze', item.instruction, item.context, item.recalled]);
  assert.ok(asked[0].system.some((s) => s.includes('[CAPABILITY MAP') && s.includes('Checkpoint Plan Structuring')), 'the map lists the side\'s skills');
  // The reply is read as an instance reads it: JSON, possibly fenced.
  const fenced = await asked[0].enforceSchema(`\`\`\`json\n${JSON.stringify(briefFor(item, { keep: true }))}\n\`\`\``, 'analyze');
  assert.equal(fenced.parts.length, 1);

  // A planner that gates everything, splits nothing, and never names an unknown scores in between.
  let total = 0;
  for (const each of BENCHES.prefrontal) {
    const gateAll = async () => ({ objective: each.instruction, parts: [{ id: 'p1', summary: 'do it', risk: 'destructive_or_public', depends_on: [], unknowns: [] }], premise: 'sound' });
    total += (await runBenchItem(each, { sideRoot: REPO, product, ports, realModel: meterOnly, askJson: gateAll })).checkScore;
  }
  const mean = total / BENCHES.prefrontal.length;
  assert.ok(mean > 0.3 && mean < 0.8, `a careless planner scores ${mean}`);
});

test('the bench command runs the prefrontal\'s items with a scripted Brief', async () => {
  const context = () => createModelRunContext({
    repoRoot: REPO,
    access: { project: 'your-gcp-project', getAccessToken: async () => 'token' },
    sides: { forPatches: () => ({ root: REPO, key: 'k' }), prepareRole: (s, role) => ({ role }), cleanupAll() {} },
    startGateway: async () => { throw new Error('no gateway in a test'); },
  });
  const item = BENCHES.prefrontal.find((i) => i.id === 'pf-staging-wipe');
  const res = await runCli(['bench', '--real-model', '--organ', 'prefrontal', '--item', item.id], {
    repoRoot: REPO, createModelRunContext: context, benchAskJson: async () => briefFor(item, { keep: true }), stderr: quiet,
  });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.trajectories.map((t) => [t.taskId, t.measured, t.checkScore]), [['pf-staging-wipe', true, 1]]);
});
