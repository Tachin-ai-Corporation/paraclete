// dev/harness2/bench.mjs: the organ benches, tier 1 of the measurement in docs/plan/MODULAR_LOOPS.md.
// A bench calls one organ directly, through one side's real gateway and that side's own organ code, on
// the items of bench-items.mjs, and scores each answer by code: the cerebellum's verdict on a
// checkpoint (does it pass the clean work and fail the defective), the memory organ's recall packet
// (does it hold what matters and leave out what does not), the prefrontal's Brief (are its risks,
// premise, parts and unknowns the ones its rules give). An item takes one organ turn or two, where
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
import { createVertexText } from '../../agent/providers/vertex-text.mjs';
import { start as startFirestoreFake } from '../../tests/fakes/firestore-server.mjs';
import { BRIEF_CHECKS, CEREBELLUM_ITEMS, DAY_MS, MEMORY_ITEMS, PLAN_CHECKS, PREFRONTAL_ITEMS } from './bench-items.mjs';

/**
 * The items' version: a bench's results compare only with results of the same version. The
 * prefrontal's bench arrived within version 3: it had no results to compare, and a new version would
 * have made the other two benches measure again for nothing.
 */
export const BENCH_VERSION = 3;

/**
 * Items a version retired: defined, and run only when named. Version 2 retired version 1's
 * cerebellum pairs and memory items that every run of the first bench baseline judged right
 * (2026-11-02), keeping two pairs and two items as the floor a change must not break. Version 3
 * retired, the same way, what both lanes' version 2 baselines (main at ca57f5b, 2026-11-02) judged
 * right in every run: every training pair and item but two of each, and three held-out pairs, for
 * harder ones of its own.
 */
export const RETIRED_BENCH_ITEMS = Object.freeze([
  ...['cb-regions-csv', 'cb-invite-date', 'cb-backup-exit', 'cb-summary-path', 'cb-five-incidents', 'cb-invoice-total',
    'cb-config-untouched', 'cb-word-limit', 'cb-sorted-contacts'].flatMap((id) => [`${id}-clean`, `${id}-defect`]),
  'mem-client-format', 'mem-deploy-window', 'mem-board-folder', 'mem-copy-review', 'mem-release-freeze', 'mem-key-rotation', 'mem-vendor-renewal',
  ...['cb2-report-sections', 'cb2-march-export', 'cb2-leap-year-test', 'cb2-timeout-unit', 'cb2-deploy-target', 'cb2-backup-first',
    'cb2-column-order', 'cb2-no-duplicates', 'cb-meeting-zone'].flatMap((id) => [`${id}-clean`, `${id}-defect`]),
  'mem2-carrier-among-many', 'mem2-two-facts', 'mem2-moved-office', 'mem-legacy-readonly',
]);

/** The benches, by the organ each judges. */
export const BENCHES = Object.freeze({ cerebellum: CEREBELLUM_ITEMS, 'temporal-memory': MEMORY_ITEMS, prefrontal: PREFRONTAL_ITEMS });

/**
 * The side's code a bench calls, beside the product loadSideProduct imports (model-runs.mjs): the
 * brain's gateway client, and the organ's own entry point. As there, these are the harness's port
 * into the product: a side that renames one cannot be benched, and says which.
 */
export const BENCH_PORTS = Object.freeze({
  client: Object.freeze({ path: 'agent/services/brain/gateway-client.mjs', exports: Object.freeze(['createGatewayClient']) }),
  cerebellum: Object.freeze({ path: 'agent/organs/cerebellum/verify.mjs', exports: Object.freeze(['verifyMilestone']) }),
  'temporal-memory': Object.freeze({ path: 'agent/organs/temporal-memory/memory.mjs', exports: Object.freeze(['createMemory']) }),
  // The brain asks the prefrontal for the Brief and for a plan with these requests; the gateway puts
  // the side's prompts/prefrontal.md before them, the capability map is built from the side's skills,
  // and a plan is read with the organ's own extractor.
  prefrontal: Object.freeze([
    Object.freeze({ path: 'agent/services/brain/prompt-assembly.mjs', exports: Object.freeze(['analyzeRequest', 'planInstruction', 'capabilityMap', 'readSkills']) }),
    Object.freeze({ path: 'agent/work/plan-utils.mjs', exports: Object.freeze(['extractCheckpoints']) }),
  ]),
});

const BENCH_PROJECT = 'paraclete-bench';

/**
 * How a structured reply (a Brief, a plan) is read: an instance's schema check
 * (agent/providers/vertex-text.mjs) on its deterministic path, which parses the reply as JSON. An
 * instance would ask a utility model to restructure a reply that does not fit the schema; the bench
 * keeps the reply as parsed, and one that is no JSON at all fails the item's first check.
 */
const replyParser = createVertexText({
  projectId: BENCH_PROJECT,
  getAccessToken: async () => 'test-token',
  fetch: async () => { throw new Error('the bench reads a reply without a utility model'); },
  logger: () => {},
});
const readReply = (raw, mode) => replyParser.enforceSchema(raw, mode);

/**
 * The items of one organ's bench, by split or by id; a retired item only by its id.
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
  return items.filter((i) => (!split || i.split === split) && (ids ? ids.includes(i.id) : !RETIRED_BENCH_ITEMS.includes(i.id)));
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
  for (const { path: rel, exports } of [BENCH_PORTS.client, ...[BENCH_PORTS[organ]].flat()]) {
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
 * not met that is not inconclusive (a verifier that never answered caught nothing). The check is named
 * for the kind of work it judges, never for the item's own flaw (bench-items.mjs says why). A wrong
 * verdict's detail carries the verifier's own reason, for whoever reads the run: a lane's issue
 * quotes a check's name, never its detail (dev/loop/planner.mjs benchIssueBody).
 *
 * @returns {Array<{ name: string, ok: boolean, detail?: string }>}
 */
export function verificationChecks(item, result) {
  const got = result?.inconclusive ? 'no verdict' : result?.passed ? 'pass' : 'fail';
  const ok = item.expect === 'pass' ? got === 'pass' : got === 'fail';
  const name = item.expect === 'pass' ? 'the verdict on work that meets its criteria' : `the verdict on work with ${item.kind}`;
  const reason = String(result?.summary || result?.caveats?.join(' ') || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return [{ name, ok, ...(ok ? {} : { detail: `got ${got}${reason ? `: ${reason}` : ''}` }) }];
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

const RISK_RANK = Object.freeze({ none: 0, mutating: 1, destructive_or_public: 2 });

/**
 * The checks of a Brief: it is well formed, and it keeps each rule its item tests (bench-items.mjs
 * PREFRONTAL_ITEMS). A part's risk outside the three tiers counts as no risk given, so a Brief whose
 * parts give none fails any risk check.
 *
 * @returns {Array<{ name: string, ok: boolean, detail?: string }>}
 */
export function briefChecks(item, brief) {
  const want = item.brief;
  const parts = Array.isArray(brief?.parts) && !brief.error ? brief.parts.filter((p) => p && typeof p === 'object') : null;
  if (!parts) return [{ name: BRIEF_CHECKS.wellFormed, ok: false, detail: brief?.error ? `the analysis failed: ${brief.error}` : 'no parts array' }];
  const checks = [{ name: BRIEF_CHECKS.wellFormed, ok: true }];
  const check = (name, ok, detail) => checks.push({ name, ok, ...(ok ? {} : { detail }) });
  const riskiest = parts.reduce((top, p) => (RISK_RANK[p.risk] > (RISK_RANK[top] ?? -1) ? p.risk : top), null);
  const risks = parts.map((p) => String(p.risk ?? 'none given')).join(', ') || 'no parts';
  if (want.risk) check(BRIEF_CHECKS.risk[want.risk], riskiest === want.risk, `the parts' risks: ${risks}`);
  if (want.riskAtMost) check(BRIEF_CHECKS.noGate, parts.length > 0 && parts.every((p) => RISK_RANK[p.risk] <= RISK_RANK[want.riskAtMost]), `the parts' risks: ${risks}`);
  if (want.premise) {
    const flawed = brief.premise === 'flawed';
    check(BRIEF_CHECKS.premise[want.premise], want.premise === 'flawed' ? flawed : !flawed,
      `premise ${brief.premise || 'not given'}${brief.premise_note ? `: ${String(brief.premise_note).slice(0, 200)}` : ''}`);
  }
  if (want.maxParts) check(BRIEF_CHECKS.onePart, parts.length >= 1 && parts.length <= want.maxParts, `${parts.length} parts`);
  if (want.minParts) check(BRIEF_CHECKS.parts, parts.length >= want.minParts, `${parts.length} part(s)`);
  if (want.dependsOn) {
    const ids = new Set(parts.map((p) => String(p.id)));
    const linked = parts.some((p) => (Array.isArray(p.depends_on) ? p.depends_on : []).some((d) => ids.has(String(d)) && String(d) !== String(p.id)));
    check(BRIEF_CHECKS.dependsOn, linked, 'no part depends on another part of the Brief');
  }
  const named = parts.flatMap((p) => (Array.isArray(p.unknowns) ? p.unknowns : []).map(String).filter((u) => u.trim()));
  if (want.unknowns === true) check(BRIEF_CHECKS.unknown, named.length > 0, 'no part names an unknown');
  if (want.unknowns === false) check(BRIEF_CHECKS.noUnknown, named.length === 0, `unknowns: ${named.join('; ').slice(0, 200)}`);
  if (want.noTool) {
    const text = JSON.stringify(parts);
    const hit = text.match(want.noTool);
    check(BRIEF_CHECKS.byOutcome, !hit, `a part names ${hit?.[0]}`);
  }
  return checks;
}

const TASK_AGENTS = Object.freeze(['motor', 'temporal-research', 'temporal-memory']);
// What only the motor can do, and what nothing in a plan may do for a person (the mouth sends): a verb
// that opens a clause or follows "and", so a purpose ("to add to the notes") or a refusal ("do not
// send it") is not read as the step.
const CLAUSE = String.raw`(?:^|[.;:]\s*|\band (?:then )?)`;
const WRITES = new RegExp(`${CLAUSE}(save|write|create|upload|deploy|modify|edit|add|put|store|update)\\b`, 'i');
const SENDS = new RegExp(`${CLAUSE}(send|deliver|forward|notify|post it to|share it with)\\b|\\be-?mail (it|them|this|the [\\w-]+( [\\w-]+)?) to\\b`, 'i');
const REPORTS = /\b(report|send|share|return|provide|give|reply)\b[^.]*\b(link|url|address)\b/i;
const BACK_REFERENCE = /\b(previous|prior|earlier|above|first) (task|step)\b|\bfrom step \d|\b(identified|found|located) (above|earlier|before|in (the )?(previous|prior|earlier|first) (task|step))\b/i;
const PLACEHOLDER = /placeholder|\bTBD\b|to be filled|\[[A-Z _-]{3,}\]|\{\{[^}]*\}\}|<[a-z][a-z _-]{2,}>/i;
const ORGAN_NAMES = /\b(motor|cortex|prefrontal|cerebellum|temporal-memory|temporal-research)\b/i;
const CLONE = /\bclone\b|\bcheck ?out (the )?(main|master|repository|repo|branch)\b/i;
const MISSION_END = /\b(is|are|was|been|gets?) merged\b|\bmerged (in)?to (the )?main\b|\b(is|are|lands?|landed) on (the )?main\b/i;
const ID_SHAPE = /\b[A-Za-z0-9_-]{25,}\b/g;

/**
 * The checks of a plan: it is well formed, and it keeps each rule of skills/plan-structuring its item
 * tests (bench-items.mjs plan items). A check reads the plan as the brain runs it: its checkpoints'
 * criteria and its tasks' agents, step types and text, in order.
 *
 * @param {object} item
 * @param {object[]|null} checkpoints  extractCheckpoints' result
 * @param {string} [failure]  why there is no plan, when there is none
 * @returns {Array<{ name: string, ok: boolean, detail?: string }>}
 */
export function planChecks(item, checkpoints, failure = '') {
  const want = item.plan;
  if (!Array.isArray(checkpoints) || !checkpoints.length) return [{ name: PLAN_CHECKS.wellFormed, ok: false, detail: failure || 'no checkpoints' }];
  const checks = [{ name: PLAN_CHECKS.wellFormed, ok: true }];
  const check = (name, ok, detail) => checks.push({ name, ok, ...(ok ? {} : { detail: String(detail).slice(0, 400) }) });
  const tasks = checkpoints.flatMap((cp) => cp.tasks || []);
  const text = (t) => String(t.task || '');
  // A detail shows the text around what broke the rule, for whoever reads the run.
  const around = (re, s) => {
    const at = s.search(re);
    return at < 0 ? s : `${at > 80 ? '…' : ''}${s.slice(Math.max(0, at - 80), at + 150)}`;
  };
  const criteria = checkpoints.map((cp) => String(cp.accept_criteria || '')).join(' | ');
  const first = (pred) => tasks.find(pred);
  if (want.agents) {
    const bad = first((t) => !TASK_AGENTS.includes(t.agent) || (t.agent !== 'motor' && WRITES.test(text(t))));
    check(PLAN_CHECKS.agents, !bad, bad && `${bad.agent}: ${text(bad)}`);
  }
  if (want.outbound) {
    const bad = first((t) => t.agent === 'motor' && t.step_type !== 'approval_gate' && SENDS.test(text(t)));
    check(PLAN_CHECKS.outbound, !bad, bad && around(SENDS, text(bad)));
  }
  if (want.gateBefore) {
    // The step is the task that takes it, not one that names it as a purpose ("ready to publish").
    const takes = new RegExp(`${CLAUSE}(?:${want.gateBefore.source})`, 'i');
    const step = tasks.findIndex((t) => t.step_type !== 'approval_gate' && takes.test(text(t)));
    const gate = tasks.findIndex((t) => t.step_type === 'approval_gate');
    const order = tasks.map((t) => `${t.step_type === 'approval_gate' ? 'GATE' : t.agent}: ${text(t).slice(0, 60)}`).join(' / ');
    check(PLAN_CHECKS.gate, step >= 0 && gate >= 0 && gate < step,
      `${step < 0 ? 'no task takes the step' : gate < 0 ? 'no approval gate' : 'the gate comes after the step'}; the tasks: ${order}`);
  }
  if (want.oneCheckpoint) check(PLAN_CHECKS.oneCheckpoint, checkpoints.length === 1, `${checkpoints.length} checkpoints`);
  if (want.noReport) {
    const last = checkpoints.at(-1);
    const reportsOnly = checkpoints.length > 1 && REPORTS.test(String(last.instruction || '')) && (last.tasks || []).every((t) => REPORTS.test(text(t)) || SENDS.test(text(t)));
    check(PLAN_CHECKS.noReport, !reportsOnly, `the last checkpoint: ${last.instruction}`);
  }
  if (want.maxTasks) check(PLAN_CHECKS.fewTasks, tasks.length <= want.maxTasks, `${tasks.length} tasks`);
  if (want.ids) {
    const all = tasks.map(text).join('\n');
    const known = new Set(item.resources.map((r) => r.id));
    const unknown = (all.match(ID_SHAPE) || []).filter((id) => !known.has(id) && /\d/.test(id) && /[A-Z]/.test(id));
    const missing = want.ids.need.filter((id) => !all.includes(id));
    const wrong = want.ids.avoid.filter((id) => all.includes(id));
    check(PLAN_CHECKS.ids, !unknown.length && !missing.length && !wrong.length,
      unknown.length ? `an id not among the known resources: ${unknown[0]}` : missing.length ? 'the id the task needs is not copied' : 'the id of another resource is used');
  }
  if (want.noBackReference) {
    const bad = first((t) => BACK_REFERENCE.test(text(t)));
    check(PLAN_CHECKS.noBackReference, !bad, bad && text(bad));
  }
  if (want.noPlaceholder) {
    const bad = first((t) => PLACEHOLDER.test(text(t)));
    check(PLAN_CHECKS.noPlaceholder, !bad, bad && text(bad));
  }
  if (want.criteriaOnArtifact) check(PLAN_CHECKS.criteriaOnArtifact, !ORGAN_NAMES.test(criteria), criteria);
  if (want.noClone) {
    const bad = first((t) => CLONE.test(text(t)));
    check(PLAN_CHECKS.noClone, !bad, bad && text(bad));
  }
  if (want.reachable) check(PLAN_CHECKS.reachable, !MISSION_END.test(criteria), criteria);
  return checks;
}

/** The Known Resources block the brain puts in a plan request (checkpoint-plan.mjs), for an item's resources. */
function knownResources(resources) {
  if (!resources.length) return '';
  return `## Known Resources (already resolved — do NOT search for these again)\n${resources.map((r) => `- ${r.kind}: "${r.name}" = ${r.id}`).join('\n')}\n`
    + 'Every id above was read back from a tool result. When a task needs one of these resources, COPY the id from this block character for character. '
    + 'Never retype one from memory or from an earlier task, and never invent one: if a resource you need is not listed, name it and let the executing organ resolve it.';
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
 * @param {Function} [o.askJson]    a fake structured turn (the prefrontal's), in tests: likewise
 * @param {Function} [o.clock]
 * @param {Function} [o.log]
 */
export async function runBenchItem(item, { sideRoot, product, ports, realModel, callAgent = null, askJson = null, clock = Date.now, log = () => {} }) {
  realModel.meter.startRollout();
  const firestore = await startFirestoreFake({ projectId: BENCH_PROJECT });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `paraclete-bench-${item.id}-`));
  let gateway = null;
  try {
    const db = product.createClient({ projectId: BENCH_PROJECT, firestoreHost: firestore.origin, getAccessToken: async () => 'test-token', logger: () => {} });
    const now = clock();
    if (item.organ === 'temporal-memory') await seedMemoryItem(item, { db, collections: product.COLLECTIONS, now });
    let ask = callAgent;
    let askStructured = askJson;
    if (!ask && !askStructured) {
      gateway = await realModel.startGateway({
        sideRoot,
        role: 'generic',
        contracts: loadContracts({ path: path.join(sideRoot, 'config', 'contracts.json') }),
        dataRoot,
        db,
        project: realModel.access.project,
        // None on the VM, whose own credentials the model clients refresh (model-runs.mjs modelAccess).
        accessToken: await (realModel.access.gatewayToken || realModel.access.getAccessToken)(),
        product,
      });
      const client = ports.createGatewayClient({
        url: gateway.url, token: gateway.token, onUsage: (_mission, _organ, usage) => realModel.meter.addTokens(tokensOf(usage)),
      });
      ask = client.callAgent;
      askStructured = client.askJson;
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
    } else if (item.organ === 'prefrontal' && item.mode === 'plan') {
      // As the brain asks when the cortex gives a goal and leaves the plan to the prefrontal
      // (checkpoint-plan.mjs): the side's plan-structuring skill, its capability map, the known
      // resources' block, and the organ's own extractor. The brain's id repair is not the organ's.
      const skillsRoot = path.join(sideRoot, 'skills');
      const skills = ports.readSkills([skillsRoot, path.join(sideRoot, 'roles', 'generic', 'skills')]);
      const skillFile = path.join(skillsRoot, 'plan-structuring', 'SKILL.md');
      const res = await ask('prefrontal', {
        instruction: ports.planInstruction({
          goal: item.goal,
          skillDoc: fs.existsSync(skillFile) ? fs.readFileSync(skillFile, 'utf8') : '',
          capabilityMap: ports.capabilityMap(skills),
          idRule: knownResources(item.resources),
          constraints: item.constraints,
        }),
        _missionId: `bench-${item.id}`,
      });
      const checkpoints = res?.success && res.output ? ports.extractCheckpoints(await readReply(res.output, 'plan') || {}) : null;
      checks = planChecks(item, checkpoints, res?.success ? 'no checkpoints in the plan' : `the plan request failed: ${res?.error || 'no answer'}`);
    } else if (item.organ === 'prefrontal') {
      const skills = ports.readSkills([path.join(sideRoot, 'skills'), path.join(sideRoot, 'roles', 'generic', 'skills')]);
      const req = ports.analyzeRequest({
        envelope: { instruction: item.instruction, context_summary: item.context },
        memory: item.recalled ? { recalled: item.recalled } : {},
        capabilityMap: ports.capabilityMap(skills),
      });
      const analyzed = await askStructured({
        organ: 'prefrontal', mode: 'analyze', system: req.system, user: req.user, enforceSchema: readReply, missionId: `bench-${item.id}`,
      });
      checks = briefChecks(item, analyzed);
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
