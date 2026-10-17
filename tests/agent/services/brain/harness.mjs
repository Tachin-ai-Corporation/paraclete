// tests/agent/services/brain/harness.mjs: a whole brain for tests, wired the way main.mjs wires it but
// against fakes: the in-memory Firestore server (tests/fakes/firestore-server.mjs) through the real
// Firestore client, the fake gateway (fake-gateway.mjs) through the real gateway client, the real
// utility-model client with no network (so schema enforcement and titles take their deterministic
// paths), a temporary data root, the repo itself as the install root (its prompts, skills and generic
// role), and a clock the test moves. Also a default script of organ answers a test overrides in part.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { createVertexText } from '../../../../agent/providers/vertex-text.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { dataPaths } from '../../../../config/instance.mjs';
import { buildBrain } from '../../../../agent/services/brain/main.mjs';
import { startFakeGateway, toolLog, verdict } from './fake-gateway.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');
export const START = Date.parse('2026-10-17T12:00:00.000Z');

/** A plan the prefrontal returns when a test does not give one. */
export const ONE_CHECKPOINT_PLAN = Object.freeze({
  checkpoints: [{
    instruction: 'Write the report',
    accept_criteria: 'report.md exists and covers the request',
    tasks: [{ agent: 'motor', task: 'Write report.md covering the request', accept_criteria: 'report.md is written' }],
  }],
});

/**
 * Default organ answers, each overridable.
 *
 * @param {object} [o]
 * @param {object} [o.classify]     the classification JSON
 * @param {Array}  [o.decisions]    the cortex's decide answers, in order (synthesize once they run out)
 * @param {object} [o.brief]
 * @param {object} [o.plan]
 * @param {Function} [o.task]       (turn) => the motor's answer
 * @param {Function} [o.verify]     (turn) => the cerebellum's answer
 * @param {string} [o.recall]
 * @param {string} [o.composed]     a respond_compose reply
 * @param {Function} [o.respond]    (turn) => an answer, or undefined to fall through to the defaults
 */
export function organScript(o = {}) {
  const decisions = [...(o.decisions || [])];
  return async (turn) => {
    if (o.respond) {
      const r = await o.respond(turn);
      if (r !== undefined) return r;
    }
    const { organ, user } = turn;
    if (organ === 'cortex') {
      if (user.includes('Acknowledge this message briefly')) return 'On it.';
      if (user.includes('"mode":"classify"')) {
        return JSON.stringify(o.classify ?? { classification: 'new_mission', reasoning: 'work to do', instruction: 'Write the quarterly report', accept_criteria: 'The report file exists and covers the quarter' });
      }
      if (user.includes('"mode":"respond_compose"')) return JSON.stringify({ reasoning: 'grounded', response: o.composed ?? 'Here is what I did this week.' });
      if (user.includes('"mode":"decide"')) {
        const next = decisions.shift();
        return typeof next === 'string' ? next : JSON.stringify(next ?? { action: 'synthesize', synthesis: 'Done: the report is written.', answer: 'The report is ready.' });
      }
      return '';
    }
    if (organ === 'prefrontal') {
      if (user.includes('"mode":"analyze"')) return JSON.stringify(o.brief ?? { objective: 'Write the report', parts: [{ id: 'p1', summary: 'Write it', risk: 'none' }] });
      if (user.includes('[PLAN STRUCTURING')) return JSON.stringify(o.plan ?? ONE_CHECKPOINT_PLAN);
      return '';
    }
    if (organ === 'motor' || organ === 'temporal-research') {
      return o.task ? o.task(turn) : `Wrote report.md with the quarter's numbers.${toolLog(['[TOOL] writeFile({"path":"report.md"}) → wrote 120 bytes to report.md'])}`;
    }
    if (organ === 'cerebellum') return o.verify ? o.verify(turn) : verdict(true);
    if (organ === 'temporal-memory') {
      if (user.includes('recording what a mission taught')) return '{"lesson":""}';
      if (o.memoryTask && user.includes('## Task') && !user.includes('PRE-LOADED')) return o.memoryTask(turn);
      return o.recall ?? 'No relevant context found.';
    }
    return '';
  };
}

/**
 * Starts a brain against fakes.
 *
 * @param {object} [opts]
 * @param {Function} [opts.respond]   the gateway's responder (default organScript())
 * @param {boolean}  [opts.sessions]  whether the fake gateway serves sessions
 * @param {object}   [opts.deps]      extra buildBrain deps
 * @returns {Promise<object>} { brain, db, firestore, gateway, root, logs, clock, advance, read, docs, stop }
 */
export async function startBrain({ respond = organScript(), sessions = true, deps = {}, contracts } = {}) {
  const firestore = await startFirestore();
  const gateway = await startFakeGateway({ respond, sessions });
  const root = mkdtempSync(join(tmpdir(), 'brain-'));
  let now = START;
  const clock = () => now;
  const logs = [];
  const db = createClient({
    projectId: firestore.projectId,
    firestoreHost: firestore.origin,
    getAccessToken: async () => 'test-token',
    logger: () => {},
  });
  const instance = {
    project: firestore.projectId, region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete', role: 'generic',
    install_root: REPO_ROOT, data_root: root, bucket: 'your-gcp-project-paraclete', workspace: null, endpoints: {},
    gateway_token_file: join(root, 'no-token-file'),
  };
  const runtime = {
    service: 'brain',
    contracts: contracts || loadContracts(),
    instance,
    log: (level, message, fields) => logs.push({ level, message: String(message), ...fields }),
    db,
    collections: COLLECTIONS,
    subcollections: SUBCOLLECTIONS,
    getAccessToken: async () => 'test-token',
    fetch: globalThis.fetch,
    firestoreHost: firestore.origin,
    storageHost: 'http://127.0.0.1:9',
    paths: {
      installRoot: REPO_ROOT,
      prompts: join(REPO_ROOT, 'prompts'),
      skills: join(REPO_ROOT, 'skills'),
      roles: join(REPO_ROOT, 'roles'),
      genericRole: join(REPO_ROOT, 'roles', 'generic'),
      role: join(REPO_ROOT, 'roles', 'generic'),
      data: dataPaths(instance),
    },
    gatewayUrl: gateway.url,
  };
  const vertexText = createVertexText({
    projectId: firestore.projectId,
    getAccessToken: async () => 'test-token',
    fetch: async () => { throw new Error('no network in tests'); },
    logger: () => {},
  });
  const brain = buildBrain(runtime, { vertexText, gatewayToken: gateway.token, artifacts: null, clock, ...deps });

  const read = (path) => db.read(path);
  /** Every document under a collection at the root, decoded, with its id. */
  const docs = async (collection) => db.query('', collection, [], { noOrderBy: true, limit: 300 });
  return {
    brain,
    runtime,
    db,
    firestore,
    gateway,
    root,
    logs,
    clock,
    advance: (ms) => { now += ms; },
    setNow: (ms) => { now = ms; },
    read,
    docs,
    async work() { return docs(COLLECTIONS.work); },
    async stop() {
      await gateway.stop();
      await firestore.stop();
    },
  };
}

/** Writes an intake document the way the ears do (agent/services/ears/intake.mjs buildIntake). */
export async function writeIntake(db, { id = 'i-dashboard-m1', text, thread = 'th-1', sender = 'person@example.com', at = '2026-10-17T12:00:00.000Z', source = 'dashboard', extra = {} }) {
  const intake = {
    id,
    text,
    source,
    status: 'pending',
    created_at: at,
    attachments: [],
    source_meta: {
      address: source === 'gchat' ? { channel: 'gchat', space: 'spaces/AAA', thread } : { channel: 'dashboard', thread },
      channel_msg_id: id.replace(/^i-[a-z]+-/, ''),
      raw_text: text,
      sender,
      sender_name: 'Person',
    },
    ...extra,
  };
  await db.write(`${COLLECTIONS.intake}/${id}`, intake);
  return intake;
}

/** Runs the runner until it finds nothing to run, or `max` missions. */
export async function drainRunner(brain, max = 5) {
  const ran = [];
  for (let i = 0; i < max; i++) {
    const id = await brain.parts.runner.tick();
    if (!id) break;
    ran.push(id);
  }
  return ran;
}

/** Waits until `check` returns truthy, polling; throws after `ms`. */
export async function eventually(check, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export { toolLog, verdict };
