// dev/harness2/scenario-harvest.mjs: turns a recall the canary got wrong into a memory bench item
// (docs/plan/MODULAR_LOOPS.md, phase 5: the canary's failures arrive as bench items). Lab only:
// nothing here is in install/manifest.txt.
//
// When an `ask` step of a memory scenario fails (scenarios.mjs), this reads the canary's memory as
// recall would have seen it when the question was sent: its active Core Memory, its newest missions
// (and the ones that taught the run's facts), and its working memory file. It then finds each value
// the answer had to name in those layers:
//
// - **stored:** every value is somewhere in that memory, so the agent was told and kept it, and the
//   miss happened on the way to the answer. The captured memory and the question become a bench item
//   in the memory bench's shape (bench-items.mjs MEMORY_ITEMS, regexes as sources), scrubbed of the
//   lab's identifiers, and written to HARVEST_DIR. Whether recall itself drops the fact is what the
//   bench then measures.
// - **not stored:** a value is in none of them: what the agent was told never reached its memory (a
//   lesson or consolidation lost it). No bench item: recall cannot be asked for what is not there.
//
// A harvested item enters the bench only through a reviewed pull request, as any referee change does:
// this file writes candidates and changes no bench. A reviewer admits one by moving it into
// harvested-items/ (harvested-items.mjs, whose README says what to check). Called by scenarios.mjs, through
// `node dev/harness2/cli.mjs scenarios`.

import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { READINESS_DOC, VM_PATHS } from '../dev-env.mjs';
import { BENCH_VERSION } from './bench.mjs';

export const HARVEST_DIR = '.local/canary/harvested';
const WORKING_MEMORY = `${VM_PATHS.dataRoot}/memory/MEMORY.md`;
/** The newest missions read: about four days of a canary's work, as the recall digest's week holds fewer. */
const WORK_READ = 40;
const CORE_READ = 500;
const OUTPUT_KEPT = 2000;
const DAY_MS = 86_400_000;

const ms = (stamp) => Date.parse(stamp);
const clip = (text, n) => (String(text ?? '').length > n ? `${String(text).slice(0, n)}…` : String(text ?? ''));

/** An IPv4 address on its own, not the tail of a version such as v2026.11.03.4.1. */
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
/** What tests/repo/hygiene.test.mjs allows: the placeholder domains, and git@github.com. */
const KEPT_EMAIL = (address, domain) => address === 'git@github.com'
  || /^(example\.(com|org|net)|your-gcp-project\.iam\.gserviceaccount\.com)$/i.test(domain);
const RUN_URL = /https?:\/\/[A-Za-z0-9.-]+\.run\.app\S*/g;
const GITHUB_OWNER = /github\.com([/:])[A-Za-z0-9_.-]+\//g;

/**
 * Text with the lab's identifiers replaced by the repo's placeholders (DEVELOPING.md section 6): the
 * projects' ids, email addresses, IP addresses, Cloud Run URLs, the owner in a GitHub URL, and any
 * name on the private denylist. Pure.
 *
 * @param {string} text
 * @param {object} [o]
 * @param {string[]} [o.projectIds] the canary's project and the lab's
 * @param {string[]} [o.denylist] names that must never appear in the repo
 */
export function scrub(text, { projectIds = [], denylist = [] } = {}) {
  let out = String(text ?? '');
  for (const id of [...projectIds].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(id).join('your-gcp-project');
  out = out.replace(GITHUB_OWNER, 'github.com$1example-org/')
    .replace(EMAIL, (address, domain) => (KEPT_EMAIL(address, domain) ? address : 'agent@example.com'))
    .replace(IPV4, '192.0.2.1').replace(RUN_URL, 'https://dashboard.example.com');
  for (const name of [...denylist].filter((n) => n && n.trim().length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'example-org');
  }
  return out;
}

/** The names on `.local/denylist.txt`, one a line, when the checkout has one. */
export function readDenylist({ repoRoot = process.cwd(), readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  try {
    return readFile(path.join(repoRoot, '.local', 'denylist.txt')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * The canary's memory as recall saw it when `before` (ms) came: active Core Memory, the newest missions
 * created before then and the missions `missionIds` names (a run's teaching steps), and working memory.
 *
 * @param {object} o
 * @param {object} o.db  a Firestore client for the canary (dev-env.mjs devContext().db())
 * @param {Function} o.ssh (command) => {code, stdout}, on the canary's VM
 */
export async function captureMemory({ db, ssh, before, missionIds = [], collections = COLLECTIONS }) {
  const core = await db.query('', collections.coreMemory, [], { noOrderBy: true, limit: CORE_READ, strict: true });
  const newest = await db.query('', collections.work, [], { orderBy: 'created_at', orderDirection: 'DESCENDING', limit: WORK_READ, strict: true });
  const work = newest.filter((w) => ms(w.created_at) < before);
  for (const id of missionIds.filter(Boolean)) {
    if (work.some((w) => w.id === id)) continue;
    const doc = await db.read(`${collections.work}/${id}`, { strict: true });
    if (doc) work.push({ id, ...doc });
  }
  const memory = await ssh(`sudo -n cat ${WORKING_MEMORY}`);
  const instance = await db.read(READINESS_DOC, { strict: true });
  return {
    coreMemory: core.filter((e) => (e.status || 'active') === 'active'),
    work,
    workingMemory: memory.code === 0 ? String(memory.stdout || '') : '',
    commit: instance?.commit || null,
  };
}

/** Where each value the answer had to name is in the captured memory. Pure. */
export function locateValues(expect, capture) {
  return expect.map((e) => {
    const re = new RegExp(e.source, 'i');
    return {
      name: e.name,
      source: e.source,
      workingMemory: re.test(capture.workingMemory || ''),
      coreMemory: capture.coreMemory.filter((c) => re.test(String(c.fact || ''))).map((c) => c.id),
      work: capture.work.filter((w) => re.test(`${w.title || ''}\n${w.instruction || ''}\n${w.output || ''}`)).map((w) => w.id),
    };
  });
}

/** `stored` when every value is in some layer, `not stored` otherwise. Pure. */
export function diagnose(located) {
  const lost = located.filter((l) => !l.workingMemory && !l.coreMemory.length && !l.work.length);
  return lost.length ? 'not stored' : 'stored';
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * A bench item's checks from a step's values: one a name, as the bench requires (a lane's issue
 * quotes a failing check by its name). Values that share a name become one check that needs them all.
 * Pure.
 */
export function checksByName(expect) {
  return [...new Set(expect.map((e) => e.name))].map((name) => {
    const sources = expect.filter((e) => e.name === name).map((e) => e.source);
    return { name, source: sources.length === 1 ? sources[0] : `^${sources.map((s) => `(?=[\\s\\S]*?(?:${s}))`).join('')}` };
  });
}

/**
 * The memory bench item a stored miss becomes: the question, the memory captured, and its checks.
 * Regexes are kept as sources, as JSON holds them. `bench` is the version the item would enter the
 * bench at, the next one: harvested-items.mjs refuses it until BENCH_VERSION is raised to it. Pure.
 */
export function recallItem({ run, stepId, request, capture, at, mission = null, scrubbing = {} }) {
  const s = (text) => scrub(text, scrubbing);
  const daysAgo = (stamp) => {
    const t = ms(stamp);
    return Number.isFinite(t) ? Math.max(0, Math.round(((at - t) / DAY_MS) * 100) / 100) : 0;
  };
  return {
    id: `memh-${run.id}`,
    organ: 'temporal-memory',
    split: 'train',
    bench: BENCH_VERSION + 1,
    harvested: { from: 'canary', run: run.id, scenario: run.scenario, step: stepId, at: new Date(at).toISOString(), commit: capture.commit, mission },
    query: s(request.text),
    workingMemory: s(capture.workingMemory),
    coreMemory: capture.coreMemory.map((e) => ({
      id: e.id,
      fact: s(e.fact),
      category: e.category || 'facts',
      tags: (Array.isArray(e.tags) ? e.tags : []).map(s),
      importance: num(e.importance, 0.5),
      confidence: num(e.confidence, 0.9),
      daysAgo: daysAgo(e.createdAt || e.created_at),
    })),
    work: capture.work.map((w) => ({
      id: w.id,
      type: w.type || 'M',
      status: w.status || 'complete',
      title: s(w.title),
      instruction: s(w.instruction),
      output: s(clip(w.output, OUTPUT_KEPT)),
      daysAgo: daysAgo(w.created_at),
    })),
    must: checksByName(request.expect),
    mustNot: [],
  };
}

/**
 * The harvest scenarios.mjs calls for a failed recall: capture, locate, and, when the values were
 * stored, write the bench item. HARVEST_DIR sits beside the default state file; a call with another
 * state file keeps its items beside that one, so a throwaway checkout loses neither.
 *
 * @param {object} o
 * @param {Function} o.capture async ({before, missionIds}) => the captured memory (captureMemory, bound to the canary)
 * @param {string} [o.dir] where items are written, from `repoRoot` (beside the state file: scenarios.mjs harvestDirFor)
 * @param {Function} [o.writeFile]
 * @returns {Function} async ({run, stepId, request, outcome}) => {diagnosis, values, item?, file?}
 */
export function harvester({ capture, repoRoot = process.cwd(), dir = HARVEST_DIR, scrubbing = {}, now = Date.now, writeFile = null }) {
  const write = writeFile || ((file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  });
  return async ({ run, stepId, request, outcome }) => {
    const step = run.steps.find((st) => st.id === stepId);
    const sentAt = ms(step?.ranAt) || now();
    const taught = run.steps.filter((st) => st.kind === 'teach').map((st) => st.mission);
    const captured = await capture({ before: sentAt, missionIds: taught });
    // The failing question's own mission and any later one are not memory it could have used.
    captured.work = captured.work.filter((w) => w.id !== outcome.mission);
    const values = locateValues(request.expect, captured);
    const diagnosis = diagnose(values);
    const where = values.map((v) => ({
      source: v.source,
      in: [v.workingMemory && 'working memory', v.coreMemory.length && 'Core Memory', v.work.length && 'past work'].filter(Boolean),
    }));
    if (diagnosis !== 'stored') return { diagnosis, values: where };
    const item = recallItem({ run, stepId, request, capture: captured, at: sentAt, mission: outcome.mission || null, scrubbing });
    const file = path.join(dir, `${item.id}.json`);
    write(path.resolve(repoRoot, file), `${JSON.stringify(item, null, 2)}\n`);
    return { diagnosis, values: where, item: item.id, file };
  };
}
