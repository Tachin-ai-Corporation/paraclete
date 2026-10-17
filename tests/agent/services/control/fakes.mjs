// tests/agent/services/control/fakes.mjs: fakes for the control service tests. fakeDb stands in for
// the Firestore client in agent/storage/firestore.mjs at the level control uses it: decoded documents,
// equality queries, field-masked patches, and commits whose preconditions fail with StoreConflict.
// Every write goes through the client's own encoding, so values come back the way Firestore returns
// them (a Date as its ISO string). A scripted failure makes one call throw. fakeSystemd has the shape
// of createSystemd() in agent/services/control/systemd.mjs.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreEncode, firestoreDecode, StoreConflict } from '../../../../agent/storage/firestore.mjs';
import { loadContracts } from '../../../../config/contracts.mjs';
import { dataPaths } from '../../../../config/instance.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from '../../../../agent/storage/collections.mjs';

const roundTrip = (data) => firestoreDecode(firestoreEncode(data));

// Every temp tree a test makes lives under one root, removed when the test process exits.
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'control-tests-'));
process.on('exit', () => rmSync(TEMP_ROOT, { recursive: true, force: true }));

/**
 * @param {Record<string, object>} [initial] documents by path, e.g. { 'commands/c1': {...} }
 */
export function fakeDb(initial = {}) {
  const docs = new Map();
  const calls = [];
  const failures = [];
  let version = 0;
  const stamp = () => `2026-10-17T00:00:00.${String(++version).padStart(6, '0')}Z`;
  const put = (path, data) => docs.set(path, { data: roundTrip(data), updateTime: stamp() });
  for (const [path, data] of Object.entries(initial)) put(path, data);

  function maybeFail(op, path) {
    const i = failures.findIndex((f) => f.op === op && (!f.path || f.path === path));
    if (i >= 0) throw failures.splice(i, 1)[0].error;
  }

  return {
    calls,
    /** The decoded document at a path, or null. */
    get: (path) => (docs.has(path) ? structuredClone(docs.get(path).data) : null),
    /** Writes a document directly, as another writer would. */
    set: (path, data) => put(path, data),
    /** The paths under a collection prefix. */
    paths: (prefix) => [...docs.keys()].filter((p) => p.startsWith(prefix)).sort(),
    /** Makes the next matching call throw. */
    failOnce: (op, error, path) => failures.push({ op, error, path }),

    async read(path, opts = {}) {
      calls.push({ op: 'read', path, opts });
      maybeFail('read', path);
      return docs.has(path) ? structuredClone(docs.get(path).data) : null;
    },
    async write(path, data) {
      calls.push({ op: 'write', path });
      maybeFail('write', path);
      put(path, data);
      return {};
    },
    async query(parentPath, collectionId, filters = [], opts = {}) {
      calls.push({ op: 'query', collectionId, filters, opts });
      maybeFail('query', collectionId);
      const prefix = parentPath ? `${parentPath}/${collectionId}/` : `${collectionId}/`;
      const value = (v) => v.stringValue ?? v.booleanValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : undefined);
      const out = [];
      for (const [path, { data }] of docs) {
        if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
        if (!filters.every((f) => f.op === 'EQUAL' && data[f.field] === value(f.value))) continue;
        out.push({ ...structuredClone(data), id: path.slice(prefix.length) });
      }
      return out.slice(0, opts.limit || 300);
    },
    async patch(path, fieldPaths, fields, opts = {}) {
      calls.push({ op: 'patch', path, fieldPaths, opts });
      maybeFail('patch', path);
      const decoded = firestoreDecode(fields);
      const data = docs.has(path) ? structuredClone(docs.get(path).data) : {};
      for (const f of fieldPaths) {
        if (Object.hasOwn(decoded, f)) data[f] = decoded[f];
        else delete data[f];
      }
      docs.set(path, { data, updateTime: stamp() });
      return {};
    },
    async del(path) {
      calls.push({ op: 'del', path });
      docs.delete(path);
      return true;
    },
    async readDoc(path) {
      calls.push({ op: 'readDoc', path });
      maybeFail('readDoc', path);
      const doc = docs.get(path);
      return doc ? { data: structuredClone(doc.data), updateTime: doc.updateTime } : null;
    },
    async commit(writes) {
      calls.push({ op: 'commit', paths: writes.map((w) => w.path) });
      maybeFail('commit', writes[0]?.path);
      for (const w of writes) {
        const doc = docs.get(w.path);
        if (w.precondition?.exists === false && doc) throw new StoreConflict(w.path, 'ALREADY_EXISTS');
        if (w.precondition?.updateTime && doc?.updateTime !== w.precondition.updateTime) throw new StoreConflict(w.path, 'FAILED_PRECONDITION');
      }
      for (const w of writes) put(w.path, w.data);
      return {};
    },
  };
}

/** A fake of createSystemd()'s shape: scripted unit states, and a record of every call. */
export function fakeSystemd({ states = {}, upgradeStates = [], log = 'step 1\nstep 2\n', failRestart = null } = {}) {
  const calls = [];
  const state = (service) => ({
    service,
    unit: `paraclete-${service}.service`,
    load: 'loaded', active: 'active', sub: 'running', result: 'success', main_pid: 100, restarts: 0, exit_status: null, since: null,
    ...(states[service] || {}),
  });
  return {
    calls,
    async serviceState(service) {
      calls.push(['state', service]);
      if (states[service] instanceof Error) throw states[service];
      return state(service);
    },
    async restart(service, opts = {}) {
      calls.push(['restart', service, opts]);
      if (failRestart) throw failRestart;
    },
    async startUpgrade(unit, argv, opts) {
      calls.push(['startUpgrade', unit, argv, opts]);
    },
    async upgradeState(unit) {
      calls.push(['upgradeState', unit]);
      const next = upgradeStates.length > 1 ? upgradeStates.shift() : upgradeStates[0];
      return { load: 'loaded', active: 'active', sub: 'running', result: 'success', exit_status: null, ...(next || {}) };
    },
    async upgradeLog(unit, lines) {
      calls.push(['upgradeLog', unit, lines]);
      return log;
    },
    async releaseUpgrade(unit) {
      calls.push(['releaseUpgrade', unit]);
    },
  };
}

export const GATEWAY_TOKEN = 'test-gateway-token-0123456789';

/**
 * A fetch that answers as the gateway would: /ready (503 until `readyAfter` probes have been made, or
 * always when `ready` is false) and /status behind the token. `down` refuses every connection.
 */
export function fakeGatewayFetch({ ready = true, readyAfter = 0, models = null, down = false, statusCode = 200 } = {}) {
  const calls = [];
  let readyProbes = 0;
  const answer = (status, body) => ({ status, ok: status < 400, json: async () => body });
  const fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:18789');
    const path = new URL(url).pathname;
    if (path === '/ready') {
      readyProbes += 1;
      const ok = ready && readyProbes > readyAfter;
      return answer(ok ? 200 : 503, {
        ready: ok,
        providers: { 'vertex-google': { available: true, location: 'global' }, 'vertex-anthropic': { available: ok, location: null } },
        required: ['vertex-google'],
      });
    }
    if (path === '/status') {
      if (init.headers?.Authorization !== `Bearer ${GATEWAY_TOKEN}`) return answer(401, { error: { message: 'Unauthorized' } });
      return answer(statusCode, { uptime_sec: 3, requests: 2, sessions: [{ id: 'm-1' }], providers: {}, models });
    }
    return answer(404, {});
  };
  return { fetch, calls };
}

/**
 * A control service runtime, shaped like createServiceRuntime()'s, over a fresh temp install root and
 * data root with the gateway token written. Log lines are collected in `lines`.
 */
export function controlRuntime({ db = fakeDb(), role = 'generic', fetch = fakeGatewayFetch().fetch, contracts = loadContracts() } = {}) {
  const base = mkdtempSync(join(TEMP_ROOT, 'instance-'));
  const installRoot = join(base, 'opt');
  const instance = Object.freeze({
    project: 'your-gcp-project', region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete', role,
    install_root: installRoot, data_root: join(base, 'data'), bucket: 'your-gcp-project-paraclete',
    workspace: null, endpoints: {}, gateway_token_file: join(base, 'gateway-token'),
  });
  writeFileSync(instance.gateway_token_file, `${GATEWAY_TOKEN}\n`);
  const paths = {
    installRoot,
    prompts: join(installRoot, 'prompts'),
    skills: join(installRoot, 'skills'),
    roles: join(installRoot, 'roles'),
    genericRole: join(installRoot, 'roles', 'generic'),
    role: join(installRoot, 'roles', role),
    data: dataPaths(instance),
  };
  for (const dir of [paths.prompts, paths.skills, paths.genericRole, paths.role, paths.data.memory, paths.data.workspace, paths.data.skills]) {
    mkdirSync(dir, { recursive: true });
  }
  const lines = [];
  return {
    base,
    lines,
    contracts,
    instance,
    paths,
    db,
    collections: COLLECTIONS,
    subcollections: SUBCOLLECTIONS,
    log: (level, message, fields) => lines.push({ level, message, ...fields }),
    fetch,
    gatewayUrl: 'http://127.0.0.1:18789',
  };
}
