// tests/agent/cli/fakes.mjs: fakes the command-line tool tests share. An in-memory Firestore behind
// the client interface of agent/storage/firestore.mjs, a runtime shaped like createCliRuntime()'s
// around it, and a sink that collects what a command writes.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContracts } from '../../../config/contracts.mjs';
import { firestoreDecode, StoreConflict, StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from '../../../agent/storage/collections.mjs';
import { agentIdentity } from '../../../config/instance.mjs';
import { instancePaths } from '../../../agent/cli/cli-runtime.mjs';

const plain = (v) => firestoreDecode({ v }).v;
const clone = (v) => structuredClone(v);

function matches(doc, f) {
  const v = doc[f.field];
  const want = plain(f.value);
  switch (f.op) {
    case 'EQUAL': return v === want;
    case 'GREATER_THAN_OR_EQUAL': return v !== undefined && v !== null && v >= want;
    case 'IN': return want.includes(v);
    case 'ARRAY_CONTAINS': return Array.isArray(v) && v.includes(want);
    default: throw new Error(`fake query: unsupported op ${f.op}`);
  }
}

/**
 * A Firestore in memory: documents by path, each with an update time. `down` makes every call fail
 * the way an outage does (strict callers get StoreUnavailable). `calls` records every query.
 *
 * @param {Record<string, object>} [initial] - path -> document
 */
export function fakeDb(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([path, data]) => [path, clone(data)]));
  const times = new Map([...docs.keys()].map((p) => [p, 't0']));
  let tick = 0;
  const state = { down: false };
  const calls = [];
  const set = (path, data) => { docs.set(path, clone(data)); times.set(path, `t${++tick}`); };
  const outage = (op, path, opts, empty) => {
    if (!state.down) return false;
    if (opts?.strict || op === 'readDoc' || op === 'commit') throw new StoreUnavailable(op, path, 503, 'unavailable');
    return { value: empty };
  };

  return {
    docs,
    state,
    calls,
    async read(path, opts = {}) {
      const o = outage('read', path, opts, null);
      if (o) return o.value;
      return docs.has(path) ? clone(docs.get(path)) : null;
    },
    async write(path, data, opts = {}) {
      const o = outage('write', path, opts, null);
      if (o) return o.value;
      set(path, data);
      return {};
    },
    async patch(path, mask, fields, opts = {}) {
      const o = outage('patch', path, opts, null);
      if (o) return o.value;
      const doc = docs.get(path) || {};
      const decoded = firestoreDecode(fields);
      for (const f of mask) doc[f] = decoded[f];
      set(path, doc);
      return {};
    },
    async del(path) { docs.delete(path); return true; },
    async query(parent, collection, filters = [], opts = {}) {
      calls.push({ parent, collection, filters: clone(filters), opts: { ...opts } });
      const o = outage('query', collection, opts, []);
      if (o) return o.value;
      const prefix = parent ? `${parent}/${collection}/` : `${collection}/`;
      let out = [...docs.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, d]) => ({ ...clone(d), id: path.slice(prefix.length) }))
        .filter((d) => filters.every((f) => matches(d, f)));
      if (!opts.noOrderBy) {
        const field = opts.orderBy || 'created_at';
        const dir = opts.orderDirection === 'DESCENDING' ? -1 : 1;
        out = out.filter((d) => d[field] !== undefined)
          .sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0));
      }
      return out.slice(0, opts.limit || 300);
    },
    async readDoc(path) {
      outage('readDoc', path, {}, null);
      return docs.has(path) ? { data: clone(docs.get(path)), updateTime: times.get(path) } : null;
    },
    async commit(writes) {
      outage('commit', writes.map((w) => w.path).join(', '), {}, null);
      for (const w of writes) {
        const p = w.precondition;
        if (p?.exists === false && docs.has(w.path)) throw new StoreConflict(w.path, 'ALREADY_EXISTS');
        if (p?.exists === true && !docs.has(w.path)) throw new StoreConflict(w.path, 'NOT_FOUND');
        if (p?.updateTime && times.get(w.path) !== p.updateTime) throw new StoreConflict(w.path, 'FAILED_PRECONDITION');
      }
      for (const w of writes) set(w.path, w.data);
      return {};
    },
  };
}

/** The instance record the tests run as. */
export function testInstance(over = {}) {
  return Object.freeze({
    project: 'your-gcp-project',
    region: 'us-central1',
    zone: 'us-central1-a',
    agent_name: 'Paraclete',
    role: 'generic',
    install_root: '/opt/paraclete',
    data_root: mkdtempSync(join(tmpdir(), 'cli-data-')),
    bucket: 'your-gcp-project-paraclete',
    workspace: null,
    endpoints: {},
    ...over,
  });
}

/**
 * A runtime shaped like createCliRuntime()'s, around a fake Firestore and the real contracts.
 *
 * @param {object} [o]
 * @param {object} [o.db]       default: an empty fakeDb()
 * @param {object} [o.instance] fields over testInstance()
 */
export function fakeRuntime({ db = fakeDb(), instance = {} } = {}) {
  const inst = testInstance(instance);
  return {
    contracts: loadContracts(),
    instance: inst,
    db,
    collections: COLLECTIONS,
    subcollections: SUBCOLLECTIONS,
    paths: instancePaths(inst),
    identity: agentIdentity(inst),
    getAccessToken: async () => 'test-token',
    fetch: async () => { throw new Error('no network in tests'); },
    firestoreHost: 'http://127.0.0.1:1',
    storageHost: 'http://127.0.0.1:1',
  };
}

/** Collects what a command writes to stdout or stderr. */
export function sink() {
  const s = { text: '', write(chunk) { s.text += chunk; return true; } };
  return s;
}

/**
 * Runs a command's main() with a runtime and fresh sinks.
 *
 * @returns {Promise<{code: number, out: string, err: string}>}
 */
export async function run(main, argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout, stderr, ...deps });
  return { code, out: stdout.text, err: stderr.text };
}
