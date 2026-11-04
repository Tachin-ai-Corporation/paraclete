// dev/harness2/harvested-items.mjs: the bench items the canary harvested and a reviewer admitted
// (docs/plan/MODULAR_LOOPS.md, phase 5: the canary's failures arrive as bench items). Each is one JSON
// file in harvested-items/, as scenario-harvest.mjs (a memory item, its checks' regexes held as
// sources) or verification-harvest.mjs (a cerebellum item, with the clean twin its reviewer wrote) wrote
// it. This reads them into the shape bench-items.mjs gives its own items, and refuses a file that
// is malformed, or that names a bench version newer than the bench's: an item changes what the bench
// measures, so it enters only with BENCH_VERSION raised to the version it names, and the loop then
// measures its baselines again at once.
//
// It does not harvest (scenario-harvest.mjs), and does not choose which items run (bench.mjs
// selectBenchItems retires a harvested item as it does any other). Called by bench.mjs, where BENCHES
// is built. This file, and the items it reads, are the referee's: no lane changes them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARVESTED_ITEMS_DIR = fileURLToPath(new URL('./harvested-items/', import.meta.url));

/** The organs a harvested item may judge, and what each one's item must hold. */
const SHAPES = Object.freeze({
  cerebellum: (item) => [
    typeof item.instruction === 'string' && item.instruction.trim() ? null : 'an instruction',
    typeof item.acceptCriteria === 'string' && item.acceptCriteria.trim() ? null : 'the criteria its verifier judged against',
    Array.isArray(item.rows) && item.rows.length && item.rows.every((r) => r && r.step && r.agent && typeof r.result === 'string') ? null : 'rows with a step, an agent and a result',
    ['pass', 'fail'].includes(item.expect) ? null : 'an expected verdict, pass or fail',
    typeof item.kind === 'string' && item.kind ? null : 'the kind of work it judges',
    item.expect !== 'fail' || (typeof item.flaw === 'string' && item.flaw) ? null : 'the flaw a defective item holds',
  ].filter(Boolean),
  'temporal-memory': (item) => [
    typeof item.query === 'string' && item.query.trim() ? null : 'a query',
    typeof item.workingMemory === 'string' ? null : 'working memory as text',
    Array.isArray(item.coreMemory) && item.coreMemory.every((e) => e.id && typeof e.fact === 'string' && Number.isFinite(e.daysAgo)) ? null : 'Core Memory entries with an id, a fact and daysAgo',
    Array.isArray(item.work) && item.work.every((w) => w.id && Number.isFinite(w.daysAgo)) ? null : 'past work with an id and daysAgo',
    Array.isArray(item.must) && item.must.length ? null : 'a check it must keep',
    Array.isArray(item.mustNot) ? null : 'a list of what it must leave out',
  ].filter(Boolean),
});

const regex = (check, file) => {
  if (!check || typeof check.name !== 'string' || typeof check.source !== 'string') throw new Error(`${file}: a check needs a name and a source`);
  try {
    return { name: check.name, re: new RegExp(check.source, 'i') };
  } catch (err) {
    throw new Error(`${file}: the check "${check.name}" is not a regex: ${err.message}`);
  }
};

/**
 * One harvested item, read from its file's text into a bench item. Throws on anything the bench could
 * not run or compare.
 *
 * @param {string} text the file's JSON
 * @param {object} o
 * @param {string} o.file   the file's name, `<id>.json`
 * @param {number} o.version BENCH_VERSION
 */
export function readHarvestedItem(text, { file, version }) {
  let item;
  try {
    item = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not JSON: ${err.message}`);
  }
  if (!item || typeof item.id !== 'string' || `${item.id}.json` !== file) throw new Error(`${file}: its id must be its file's name`);
  const shape = SHAPES[item.organ];
  if (!shape) throw new Error(`${file}: no bench takes harvested items for the organ ${item.organ}`);
  if (!['train', 'holdout'].includes(item.split)) throw new Error(`${file}: its split must be train or holdout`);
  if (!item.harvested || typeof item.harvested.run !== 'string') throw new Error(`${file}: it must say what it was harvested from`);
  if (!Number.isInteger(item.bench) || item.bench < 1) throw new Error(`${file}: it must name the bench version it enters at`);
  if (item.bench > version) {
    throw new Error(`${file}: it enters at bench version ${item.bench}, and the bench is at ${version}: raise BENCH_VERSION as the item enters`);
  }
  const missing = shape(item);
  if (missing.length) throw new Error(`${file}: it needs ${missing.join(', ')}`);
  if (item.organ !== 'temporal-memory') return item;
  return { ...item, must: item.must.map((m) => regex(m, file)), mustNot: item.mustNot.map((m) => regex(m, file)) };
}

/**
 * Every admitted item, by organ: each organ that takes harvested items has a list, empty or not.
 *
 * @param {object} o
 * @param {number} o.version BENCH_VERSION
 * @param {string} [o.dir]
 * @returns {Record<string, object[]>}
 */
export function loadHarvestedItems({ version, dir = HARVESTED_ITEMS_DIR, readdir = fs.readdirSync, readFile = (p) => fs.readFileSync(p, 'utf8') }) {
  const byOrgan = Object.fromEntries(Object.keys(SHAPES).map((organ) => [organ, []]));
  let files = [];
  try {
    files = readdir(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const file of files) {
    const item = readHarvestedItem(readFile(path.join(dir, file)), { file, version });
    byOrgan[item.organ].push(item);
  }
  return byOrgan;
}
