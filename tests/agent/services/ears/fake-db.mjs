// tests/agent/services/ears/fake-db.mjs: an in-memory stand-in for the Firestore client in
// agent/storage/firestore.mjs (read, write, query, patch, del, readDoc, commit), shared by the ears'
// and the mouth's unit tests. Documents are kept decoded, after a round trip through the real
// encoder, so types come back as the real client returns them (a Date as its ISO string). query
// understands EQUAL, IN and the range operators on top-level fields, and orderBy. fail(op) makes
// that method throw StoreUnavailable until heal(op).
import { firestoreDecode, firestoreEncode, StoreConflict, StoreUnavailable } from '../../../../agent/storage/firestore.mjs';

const roundTrip = (data) => firestoreDecode(firestoreEncode(data));
const decodeValue = (value) => firestoreDecode({ v: value }).v;

function matches(actual, op, encoded) {
  const want = decodeValue(encoded);
  switch (op) {
    case 'EQUAL': return actual === want;
    case 'NOT_EQUAL': return actual !== want;
    case 'IN': return Array.isArray(want) && want.includes(actual);
    case 'LESS_THAN': return actual < want;
    case 'LESS_THAN_OR_EQUAL': return actual <= want;
    case 'GREATER_THAN': return actual > want;
    case 'GREATER_THAN_OR_EQUAL': return actual >= want;
    default: throw new Error(`fake-db: unsupported operator ${op}`);
  }
}

/**
 * @param {Record<string, object>} [initial] documents by path, e.g. { 'work/w-1': {...} }
 */
export function fakeDb(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([path, data]) => [path, roundTrip(data)]));
  const calls = [];
  const failing = new Set();

  function enter(op, path) {
    calls.push({ op, path });
    if (failing.has(op)) throw new StoreUnavailable(op, path, 503, 'fake outage');
  }

  return {
    docs,
    calls,
    fail(op) { failing.add(op); },
    heal(op) { failing.delete(op); },
    get(path) { return docs.has(path) ? structuredClone(docs.get(path)) : undefined; },

    async read(path) {
      enter('read', path);
      return docs.has(path) ? structuredClone(docs.get(path)) : null;
    },
    async write(path, data) {
      enter('write', path);
      docs.set(path, roundTrip(data));
      return { name: path };
    },
    async query(parent, collectionId, filters = [], opts = {}) {
      enter('query', `${parent}/${collectionId}`);
      const prefix = parent ? `${parent}/${collectionId}/` : `${collectionId}/`;
      let rows = [...docs.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, data]) => ({ ...structuredClone(data), id: path.slice(prefix.length) }));
      for (const f of filters) rows = rows.filter((row) => matches(row[f.field], f.op, f.value));
      if (!opts.noOrderBy) {
        const field = opts.orderBy || 'created_at';
        const sign = opts.orderDirection === 'DESCENDING' ? -1 : 1;
        rows.sort((a, b) => (a[field] < b[field] ? -sign : a[field] > b[field] ? sign : 0));
      }
      return rows.slice(0, opts.limit || 300);
    },
    async patch(path, fieldPaths, fields) {
      enter('patch', path);
      const current = docs.get(path) || {};
      const decoded = firestoreDecode(fields);
      for (const field of fieldPaths) {
        if (field in decoded) current[field] = decoded[field];
        else delete current[field];
      }
      docs.set(path, current);
      return { name: path };
    },
    async del(path) {
      enter('del', path);
      return docs.delete(path);
    },
    async readDoc(path) {
      enter('readDoc', path);
      return docs.has(path) ? { data: structuredClone(docs.get(path)), updateTime: '2026-10-17T00:00:00Z' } : null;
    },
    async commit(writes) {
      enter('commit', writes.map((w) => w.path).join(', '));
      for (const w of writes) {
        if (w.precondition?.exists === false && docs.has(w.path)) throw new StoreConflict(w.path, 'ALREADY_EXISTS');
      }
      for (const w of writes) docs.set(w.path, roundTrip(w.data));
      return {};
    },
  };
}
