// dev/harness2/bench.mjs: the organ benches, tier 1 of the measurement in docs/plan/MODULAR_LOOPS.md.
// A bench calls one organ directly, through one side's real gateway and that side's own organ code, on
// the items of bench-items.mjs, and scores each answer by code: the cerebellum's verdict on a
// checkpoint (does it pass the clean work and fail the defective), the memory organ's recall packet
// (does it hold what matters and leave out what does not). An item takes one organ turn or two, where
// a model-suite task takes a whole mission, so a lane learns in minutes whether its organ got better.
//
// Each item runs as one rollout of runTier1Evaluation (substrate.mjs), so a bench run is capped,
// retried and scored as any real-model run is, and its runs compare in promotion evidence
// (evidence.mjs) as tasks do: each item's capability is the share of its checks that passed.
//
// It writes nothing outside the run's temporary directories. Called by cli.mjs `bench`. This file is
// the referee's: no lane changes it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContracts } from '../../config/contracts.mjs';
import { start as startFirestoreFake } from '../../tests/fakes/firestore-server.mjs';
import { CEREBELLUM_ITEMS, DAY_MS, MEMORY_ITEMS } from './bench-items.mjs';

/** The items' version: a bench's results compare only with results of the same version. */
export const BENCH_VERSION = 1;

/** The benches, by the organ each judges. */
export const BENCHES = Object.freeze({ cerebellum: CEREBELLUM_ITEMS, 'temporal-memory': MEMORY_ITEMS });

/**
 * The side's code a bench calls, beside the product loadSideProduct imports (model-runs.mjs): the
 * brain's gateway client, and the organ's own entry point. As there, these are the harness's port
 * into the product: a side that renames one cannot be benched, and says which.
 */
export const BENCH_PORTS = Object.freeze({
  client: Object.freeze({ path: 'agent/services/brain/gateway-client.mjs', exports: Object.freeze(['createGatewayClient']) }),
  cerebellum: Object.freeze({ path: 'agent/organs/cerebellum/verify.mjs', exports: Object.freeze(['verifyMilestone']) }),
  'temporal-memory': Object.freeze({ path: 'agent/organs/temporal-memory/memory.mjs', exports: Object.freeze(['createMemory']) }),
});

const BENCH_PROJECT = 'paraclete-bench';

/**
 * The items of one organ's bench, by split or by id.
 *
 * @param {object} o
 * @param {string} o.organ
 * @param {string} [o.split]   'train' or 'holdout'
 * @param {string[]} [o.ids]
 * @returns {object[]}
 */
export function selectBenchItems({ organ, split, ids } = {}) {
  const items = BENCHES[organ];
  if (!items) return [];
  return items.filter((i) => (!split || i.split === split) && (!ids || ids.includes(i.id)));
}

/**
 * The gateway client and the organ's entry point, imported from the side's root.
 *
 * @param {string} sideRoot
 * @param {string} organ
 * @param {object} [o]
 * @param {Function} [o.importModule]
 * @returns {Promise<object>}
 */
export async function loadBenchPorts(sideRoot, organ, { importModule = (url) => import(url) } = {}) {
  if (!BENCH_PORTS[organ]) throw new Error(`there is no bench for the organ ${organ}`);
  const ports = {};
  for (const { path: rel, exports } of [BENCH_PORTS.client, BENCH_PORTS[organ]]) {
    const file = path.join(sideRoot, rel);
    if (!fs.existsSync(file)) throw new Error(`the side at ${sideRoot} has no ${rel}`);
    const mod = await importModule(pathToFileURL(file).href);
    for (const name of exports) {
      if (typeof mod[name] !== 'function') throw new Error(`the side's ${rel} does not export ${name}`);
      ports[name] = mod[name];
    }
  }
  return ports;
}

/**
 * The checks of a verification: the verdict the item expects, given decisively. A clean item passes
 * when the milestone passes, with a caveat or without; a defective one fails only on a verdict of
 * not met that is not inconclusive (a verifier that never answered caught nothing).
 *
 * @returns {Array<{ name: string, ok: boolean, detail?: string }>}
 */
export function verificationChecks(item, result) {
  const got = result?.inconclusive ? 'no verdict' : result?.passed ? 'pass' : 'fail';
  const ok = item.expect === 'pass' ? got === 'pass' : got === 'fail';
  return [{ name: `the verifier's verdict is ${item.expect}${item.flaw ? ` (${item.flaw})` : ''}`, ok, ...(ok ? {} : { detail: `got ${got}` }) }];
}

/**
 * The checks of a recall packet: it holds something, each fact the item names, and none of its
 * distractors.
 *
 * @returns {Array<{ name: string, ok: boolean, detail?: string }>}
 */
export function recallChecks(item, recalled) {
  const text = String(recalled || '');
  const clip = text.replace(/\s+/g, ' ').slice(0, 200);
  return [
    { name: 'recall returns a packet', ok: text.trim().length > 0 },
    ...item.must.map((m) => ({ name: m.name, ok: m.re.test(text), ...(m.re.test(text) ? {} : { detail: clip || '(empty)' }) })),
    ...item.mustNot.map((m) => ({ name: m.name, ok: !m.re.test(text), ...(m.re.test(text) ? { detail: clip } : {}) })),
  ];
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Writes a memory item's stored state into the rollout's Firestore: its Core Memory entries and its
 * past work, each dated `daysAgo` before `now`.
 */
export async function seedMemoryItem(item, { db, collections, now }) {
  for (const e of item.coreMemory || []) {
    const at = iso(now - e.daysAgo * DAY_MS);
    await db.write(`${collections.coreMemory}/${e.id}`, {
      id: e.id, fact: e.fact, category: e.category, tags: e.tags, confidence: e.confidence, importance: e.importance,
      source: 'bench', supersededBy: null, createdAt: at, lastRecalledAt: at, recallCount: 0, status: 'active',
    });
  }
  for (const w of item.work || []) {
    const at = iso(now - w.daysAgo * DAY_MS);
    await db.write(`${collections.work}/${w.id}`, {
      id: w.id, type: w.type, status: w.status, title: w.title, instruction: w.instruction, output: w.output,
      created_at: at, updated_at: at, completed_at: at,
    });
  }
}

const tokensOf = (usage) => Number(usage?.total_tokens ?? usage?.totalTokenCount ?? (Number(usage?.prompt_tokens || 0) + Number(usage?.completion_tokens || 0))) || 0;

/**
 * One bench item, once: its stored state seeded into a Firestore of its own, the side's gateway
 * started for it, and the organ asked through the side's own gateway client and organ code. Returns
 * a rollout as runTier1Evaluation takes one: measured, with its check score and checks.
 *
 * @param {object} item
 * @param {object} o
 * @param {string} o.sideRoot
 * @param {object} o.product   loadSideProduct()'s result for the side
 * @param {object} o.ports     loadBenchPorts()'s result
 * @param {object} o.realModel createModelRunContext()'s result
 * @param {Function} [o.callAgent]  a fake organ, in tests: no gateway is started
 * @param {Function} [o.clock]
 * @param {Function} [o.log]
 */
export async function runBenchItem(item, { sideRoot, product, ports, realModel, callAgent = null, clock = Date.now, log = () => {} }) {
  realModel.meter.startRollout();
  const firestore = await startFirestoreFake({ projectId: BENCH_PROJECT });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `paraclete-bench-${item.id}-`));
  let gateway = null;
  try {
    const db = product.createClient({ projectId: BENCH_PROJECT, firestoreHost: firestore.origin, getAccessToken: async () => 'test-token', logger: () => {} });
    const now = clock();
    if (item.organ === 'temporal-memory') await seedMemoryItem(item, { db, collections: product.COLLECTIONS, now });
    let ask = callAgent;
    if (!ask) {
      gateway = await realModel.startGateway({
        sideRoot,
        role: 'generic',
        contracts: loadContracts({ path: path.join(sideRoot, 'config', 'contracts.json') }),
        dataRoot,
        db,
        project: realModel.access.project,
        accessToken: await realModel.access.getAccessToken(),
        product,
      });
      const client = ports.createGatewayClient({
        url: gateway.url, token: gateway.token, onUsage: (_mission, _organ, usage) => realModel.meter.addTokens(tokensOf(usage)),
      });
      ask = client.callAgent;
    }
    let checks;
    if (item.organ === 'cerebellum') {
      const result = await ports.verifyMilestone({
        callAgent: ask,
        missionId: `bench-${item.id}`,
        cpNum: 1,
        instruction: item.instruction,
        acceptCriteria: item.acceptCriteria,
        rows: item.rows,
        fullOutputs: item.rows.map((r) => ({ step: r.step, agent: r.agent, output: r.result })),
        stakes: 'routine',
        log,
      });
      checks = verificationChecks(item, result);
    } else {
      const memory = ports.createMemory({
        db,
        callAgent: ask,
        files: { workingMemory: () => item.workingMemory || '', deepTruths: () => '', append: () => false },
        log,
        clock: () => now,
      });
      const out = await memory.recall(item.query);
      checks = recallChecks(item, out?.recalled);
    }
    const passed = checks.filter((c) => c.ok).length;
    return {
      measured: true,
      scripted: false,
      checkScore: Number((passed / checks.length).toFixed(4)),
      fixtureVerification: { ok: passed === checks.length, summary: `${passed}/${checks.length} checks passed`, checks },
    };
  } finally {
    if (gateway) await gateway.stop().catch(() => {});
    await firestore.stop().catch(() => {});
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}
