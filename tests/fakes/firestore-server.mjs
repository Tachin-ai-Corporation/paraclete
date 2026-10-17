// tests/fakes/firestore-server.mjs: an in-memory stand-in for the Firestore REST API (v1), served by
// node:http on 127.0.0.1 so integration tests can point the agent's Firestore clients at it with
// `firestoreHost`. It is faithful for the subset the clients in agent/ use: get, list, create, patch
// (field masks and preconditions), delete, :runQuery and :commit. A feature outside that subset
// answers 501 UNIMPLEMENTED rather than guessing, so a client that starts using one finds out. It
// does not enforce composite indexes, security rules, quotas or transactions. Value validation and
// ordering live in firestore-model.mjs. tests/fakes/README.md lists what it supports and what it
// deliberately doesn't. Used by integration tests, and checked against the real clients by
// tests/fakes/firestore-server.test.mjs.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  ApiError, invalid, unimplemented, isObject, utf8Length, typeOf, isNull, isNaNValue, canonical, checkKeys,
  parseTimestamp, createClock, parseFieldPath, isName, getField, setField, deleteField, leafPaths, checkValue,
  checkDocument, compareNames, compareValues, checkDocumentSize, TYPE_RANK, RESERVED,
} from './firestore-model.mjs';

const MAX_COMMIT_WRITES = 500;
const IGNORED_PARAMS = new Set(['alt', 'prettyPrint', '$.xgafv']);
const RANGE_OPS = { LESS_THAN: (r) => r < 0, LESS_THAN_OR_EQUAL: (r) => r <= 0, GREATER_THAN: (r) => r > 0,
  GREATER_THAN_OR_EQUAL: (r) => r >= 0 };
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Starts the fake on a free port on 127.0.0.1.
 *
 * @param {object} [options]
 * @param {string} [options.projectId='your-gcp-project'] the only project it serves
 * @returns {Promise<{origin: string, url: string, projectId: string, requests: Array<object>,
 *   dump: Function, reset: Function, stop: Function}>} `origin` is what clients take as
 *   `firestoreHost`; `url` is the documents base URL; `requests` records { method, path, query, token }
 */
export async function start({ projectId = 'your-gcp-project' } = {}) {
  const docRoot = `projects/${projectId}/databases/(default)/documents`;
  const docs = new Map(); // 'work/w-1' -> { fields, createTime, updateTime }
  const requests = [];
  const now = createClock();
  const nameOf = (path) => `${docRoot}/${path}`;
  const toDocument = (path, rec) => ({
    name: nameOf(path),
    ...(Object.keys(rec.fields).length ? { fields: structuredClone(rec.fields) } : {}),
    createTime: rec.createTime,
    updateTime: rec.updateTime,
  });

  function checkId(segment) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || RESERVED.test(segment)
      || utf8Length(segment) > 1500) {
      throw invalid(`Resource id "${segment}" is invalid: ids are 1-1500 bytes, without '/', not '.', '..' or __reserved__.`);
    }
  }

  function splitPath(rest) {
    if (!rest) return [];
    return rest.split('/').map((raw) => {
      let segment;
      try { segment = decodeURIComponent(raw); } catch { throw invalid(`Invalid percent-encoding in "${raw}".`); }
      checkId(segment);
      return segment;
    });
  }

  function pathFromName(name, where) {
    if (typeof name !== 'string' || !name.startsWith(`${docRoot}/`)) {
      throw invalid(`Invalid resource name at '${where}': "${name}" is not a document of ${docRoot}.`);
    }
    const segments = name.slice(docRoot.length + 1).split('/');
    segments.forEach(checkId);
    if (segments.length % 2) throw invalid(`Invalid resource name at '${where}': "${name}" names a collection, not a document.`);
    return segments.join('/');
  }

  function checkParams(params, supported, unsupported = []) {
    for (const key of new Set(params.keys())) {
      if (supported.includes(key) || IGNORED_PARAMS.has(key)) continue;
      if (unsupported.includes(key)) throw unimplemented(`the ${key} parameter`);
      throw invalid(`Invalid JSON payload received. Unknown name "${key}": Cannot bind query parameter. Field '${key}' could not be found in request message.`);
    }
  }

  function checkPrecondition(pre, path, current, where) {
    if (pre === undefined) return;
    if (!isObject(pre)) throw invalid(`Invalid value at '${where}': expected a Precondition object.`);
    checkKeys(pre, ['exists', 'updateTime'], where);
    if ('exists' in pre && 'updateTime' in pre) throw invalid(`Invalid JSON payload received. Oneof field 'condition_type' is already set at '${where}'.`);
    if ('exists' in pre) {
      if (typeof pre.exists !== 'boolean') throw invalid(`Invalid value at '${where}.exists': expected a boolean.`);
      if (pre.exists && !current) throw new ApiError(404, 'NOT_FOUND', `No document to update: ${nameOf(path)}`);
      if (!pre.exists && current) throw new ApiError(409, 'ALREADY_EXISTS', `Document already exists: ${nameOf(path)}`);
    } else if ('updateTime' in pre) {
      const want = parseTimestamp(pre.updateTime);
      if (!want) throw invalid(`Invalid value at '${where}.update_time': ${pre.updateTime}`);
      const have = current && parseTimestamp(current.updateTime);
      if (!have || have[0] !== want[0] || have[1] !== want[1]) {
        throw new ApiError(400, 'FAILED_PRECONDITION',
          `the stored version (${current?.updateTime ?? 'none'}) does not match the required base version (${pre.updateTime})`);
      }
    }
  }

  function parseMask(fieldPaths, where) {
    if (!Array.isArray(fieldPaths)) throw invalid(`Invalid value at '${where}': expected a list of field paths.`);
    return fieldPaths.map((text, i) => {
      const segments = parseFieldPath(text, `${where}[${i}]`);
      if (segments.some((s) => RESERVED.test(s))) throw invalid(`Field path "${text}" at '${where}' uses a reserved name.`);
      return segments;
    });
  }

  /** Writes one document into `store` (whole, or only the masked fields) and returns its record. */
  function applyUpdate(store, path, document, mask, time) {
    const current = store.get(path);
    const incoming = document.fields || {};
    let fields;
    if (mask) {
      for (const leaf of leafPaths(incoming)) {
        if (!mask.some((m) => m.length <= leaf.length && m.every((s, i) => s === leaf[i]))) {
          throw invalid(`The fake refuses field "${leaf.join('.')}": it is in the document but not in the update mask (see tests/fakes/README.md).`);
        }
      }
      fields = structuredClone(current?.fields || {});
      for (const segments of mask) {
        const value = getField(incoming, segments);
        if (value === undefined) deleteField(fields, segments);
        else setField(fields, segments, structuredClone(value));
      }
    } else {
      fields = structuredClone(incoming);
    }
    checkDocumentSize(nameOf(path), path, fields);
    // A write that changes nothing keeps the document's updateTime, as the real API does.
    const unchanged = current && canonical(current.fields) === canonical(fields);
    const rec = { fields, createTime: current?.createTime ?? time, updateTime: unchanged ? current.updateTime : time };
    store.set(path, rec);
    return rec;
  }

  function fieldOf(field, where) {
    if (!isObject(field)) throw invalid(`Invalid value at '${where}': expected a field reference.`);
    checkKeys(field, ['fieldPath'], where);
    return parseFieldPath(field.fieldPath, `${where}.field_path`);
  }

  /** Compiles a filter into a predicate over a document's fields; records inequality fields. */
  function compileFilter(filter, where, inequalities) {
    if (!isObject(filter)) throw invalid(`Invalid value at '${where}': expected a Filter object.`);
    checkKeys(filter, ['compositeFilter', 'fieldFilter', 'unaryFilter'], where);
    if (Object.keys(filter).length !== 1) throw invalid(`Invalid filter at '${where}': set exactly one of compositeFilter, fieldFilter, unaryFilter.`);
    if (filter.compositeFilter) {
      const { op, filters } = filter.compositeFilter;
      checkKeys(filter.compositeFilter, ['op', 'filters'], `${where}.composite_filter`);
      if (op !== 'AND' && op !== 'OR') throw invalid(`Invalid value at '${where}.composite_filter.op': "${op}"`);
      if (!Array.isArray(filters) || filters.length === 0) {
        throw invalid(`Invalid filter at '${where}.composite_filter': a composite filter must contain at least one filter.`);
      }
      const parts = filters.map((f, i) => compileFilter(f, `${where}.composite_filter.filters[${i}]`, inequalities));
      return op === 'AND' ? (fields) => parts.every((p) => p(fields)) : (fields) => parts.some((p) => p(fields));
    }
    const kind = filter.unaryFilter ? 'unary_filter' : 'field_filter';
    const spec = filter.unaryFilter || filter.fieldFilter;
    if (!isObject(spec)) throw invalid(`Invalid value at '${where}.${kind}'.`);
    checkKeys(spec, filter.unaryFilter ? ['op', 'field'] : ['op', 'field', 'value'], `${where}.${kind}`);
    const path = fieldOf(spec.field, `${where}.${kind}.field`);
    if (isName(path)) throw unimplemented('filters on __name__');
    const read = (fields) => getField(fields, path);
    const { op, value } = spec;
    if (filter.unaryFilter) {
      if (op === 'IS_NULL') return (fields) => isNull(read(fields));
      if (op === 'IS_NOT_NULL') {
        inequalities.push(path);
        return (fields) => read(fields) !== undefined && !isNull(read(fields));
      }
      if (op === 'IS_NAN' || op === 'IS_NOT_NAN') throw unimplemented(`unaryFilter ${op}`);
      throw invalid(`Invalid value at '${where}.unary_filter.op': "${op}"`);
    }
    checkValue(value, `${where}.field_filter.value`);
    const equal = (a, b) => compareValues(a, b) === 0;
    const list = () => {
      const max = op === 'NOT_IN' ? 10 : 30;
      const values = value.arrayValue?.values;
      if (!values?.length || values.length > max) throw invalid(`Invalid query: '${op}' needs an array value of 1 to ${max} elements.`);
      return values;
    };
    if (RANGE_OPS[op]) {
      if (isNull(value) || isNaNValue(value)) throw invalid(`Invalid query: '${op}' cannot compare with null or NaN.`);
      inequalities.push(path);
      return (fields) => {
        const v = read(fields);
        return v !== undefined && TYPE_RANK[typeOf(v)] === TYPE_RANK[typeOf(value)] && !isNaNValue(v)
          && RANGE_OPS[op](compareValues(v, value));
      };
    }
    switch (op) {
      case 'EQUAL': return (fields) => read(fields) !== undefined && equal(read(fields), value);
      case 'NOT_EQUAL':
        inequalities.push(path);
        return (fields) => read(fields) !== undefined && !isNull(read(fields)) && !equal(read(fields), value);
      case 'IN': {
        const values = list();
        return (fields) => read(fields) !== undefined && values.some((x) => equal(read(fields), x));
      }
      case 'NOT_IN': {
        const values = list();
        inequalities.push(path);
        return (fields) => read(fields) !== undefined && !isNull(read(fields)) && !values.some((x) => equal(read(fields), x));
      }
      case 'ARRAY_CONTAINS': return (fields) => (read(fields)?.arrayValue?.values || []).some((x) => equal(x, value));
      case 'ARRAY_CONTAINS_ANY': {
        const values = list();
        return (fields) => (read(fields)?.arrayValue?.values || []).some((x) => values.some((y) => equal(x, y)));
      }
      default: throw invalid(`Invalid value at '${where}.field_filter.op': "${op}"`);
    }
  }

  function runQuery(parentSegments, body) {
    if (!isObject(body)) throw invalid('Invalid JSON payload received: expected an object.');
    checkKeys(body, ['structuredQuery', 'transaction', 'newTransaction', 'readTime', 'explainOptions'], 'request');
    for (const key of ['transaction', 'newTransaction', 'readTime', 'explainOptions']) {
      if (key in body) throw unimplemented(`runQuery ${key}`);
    }
    const q = body.structuredQuery;
    if (!isObject(q)) throw invalid('runQuery needs a structuredQuery.');
    checkKeys(q, ['select', 'from', 'where', 'orderBy', 'startAt', 'endAt', 'offset', 'limit', 'findNearest'], 'structured_query');
    for (const key of ['select', 'startAt', 'endAt', 'offset', 'findNearest']) {
      if (key in q) throw unimplemented(`structuredQuery.${key}`);
    }
    if (!Array.isArray(q.from) || q.from.length !== 1 || !isObject(q.from[0])) {
      throw invalid("Invalid value at 'structured_query.from': name exactly one collection.");
    }
    checkKeys(q.from[0], ['collectionId', 'allDescendants'], 'structured_query.from[0]');
    const { collectionId, allDescendants = false } = q.from[0];
    if (typeof collectionId !== 'string' || !collectionId) throw invalid("Invalid value at 'structured_query.from[0].collection_id'.");
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 0)) throw invalid("Invalid value at 'structured_query.limit'.");
    if (q.orderBy !== undefined && !Array.isArray(q.orderBy)) throw invalid("Invalid value at 'structured_query.order_by'.");

    const inequalities = [];
    const matches = q.where === undefined ? () => true : compileFilter(q.where, 'structured_query.where', inequalities);
    const explicit = (q.orderBy || []).map((o, i) => {
      const where = `structured_query.order_by[${i}]`;
      if (!isObject(o)) throw invalid(`Invalid value at '${where}'.`);
      checkKeys(o, ['field', 'direction'], where);
      if (![undefined, 'ASCENDING', 'DESCENDING', 'DIRECTION_UNSPECIFIED'].includes(o.direction)) {
        throw invalid(`Invalid value at '${where}.direction': "${o.direction}"`);
      }
      return { path: fieldOf(o.field, `${where}.field`), desc: o.direction === 'DESCENDING' };
    });
    // Real ordering: the explicit orders, then any inequality field not already ordered (by field
    // path), then the document name, each extra one in the direction of the last explicit order.
    const desc = explicit.at(-1)?.desc ?? false;
    const key = (path) => path.join('\u0000');
    const ordered = new Set(explicit.map((o) => key(o.path)));
    const implicit = [...new Map(inequalities.map((p) => [key(p), p])).values()]
      .filter((p) => !ordered.has(key(p)))
      .sort((a, b) => compareNames(a, b))
      .map((path) => ({ path, desc }));
    const orders = [...explicit, ...implicit];
    if (!orders.some((o) => isName(o.path))) orders.push({ path: ['__name__'], desc });

    const parent = parentSegments.join('/');
    const rows = [];
    for (const [path, rec] of docs) {
      const segments = path.split('/');
      if (segments.at(-2) !== collectionId) continue;
      const docParent = segments.slice(0, -2).join('/');
      const inScope = allDescendants
        ? !parent || docParent === parent || docParent.startsWith(`${parent}/`)
        : docParent === parent;
      // A document missing an ordered field is not in the result, as in the real API.
      if (!inScope || !matches(rec.fields)) continue;
      if (!orders.every((o) => isName(o.path) || getField(rec.fields, o.path) !== undefined)) continue;
      rows.push({ path, segments, rec });
    }
    rows.sort((a, b) => {
      for (const o of orders) {
        const r = isName(o.path)
          ? compareNames(a.segments, b.segments)
          : compareValues(getField(a.rec.fields, o.path), getField(b.rec.fields, o.path));
        if (r) return o.desc ? -r : r;
      }
      return 0;
    });
    const readTime = now();
    const page = rows.slice(0, q.limit ?? rows.length);
    return page.length ? page.map((r) => ({ document: toDocument(r.path, r.rec), readTime })) : [{ readTime }];
  }

  function commit(body) {
    if (!isObject(body)) throw invalid('Invalid JSON payload received: expected an object.');
    checkKeys(body, ['writes', 'transaction'], 'request');
    if ('transaction' in body) throw unimplemented('transactions');
    const writes = body.writes ?? [];
    if (!Array.isArray(writes)) throw invalid("Invalid value at 'writes': expected a list.");
    if (writes.length > MAX_COMMIT_WRITES) throw invalid(`A commit holds at most ${MAX_COMMIT_WRITES} writes.`);
    const time = now();
    const working = new Map(docs); // all or nothing: applied to a copy, swapped in only if every write succeeds
    const writeResults = writes.map((w, i) => {
      const where = `writes[${i}]`;
      if (!isObject(w)) throw invalid(`Invalid value at '${where}'.`);
      checkKeys(w, ['update', 'delete', 'updateMask', 'currentDocument', 'updateTransforms', 'transform'], where);
      if ('updateTransforms' in w || 'transform' in w) throw unimplemented('field transforms');
      if (('update' in w) === ('delete' in w)) throw invalid(`Invalid write at '${where}': set exactly one of update or delete.`);
      if ('delete' in w) {
        if ('updateMask' in w) throw invalid(`Invalid write at '${where}': a delete has no update mask.`);
        const path = pathFromName(w.delete, `${where}.delete`);
        checkPrecondition(w.currentDocument, path, working.get(path), `${where}.current_document`);
        working.delete(path);
        return {};
      }
      checkDocument(w.update, `${where}.update`);
      const path = pathFromName(w.update.name, `${where}.update.name`);
      let mask = null;
      if (w.updateMask !== undefined) {
        if (!isObject(w.updateMask)) throw invalid(`Invalid value at '${where}.update_mask'.`);
        checkKeys(w.updateMask, ['fieldPaths'], `${where}.update_mask`);
        mask = parseMask(w.updateMask.fieldPaths ?? [], `${where}.update_mask.field_paths`);
      }
      checkPrecondition(w.currentDocument, path, working.get(path), `${where}.current_document`);
      return { updateTime: applyUpdate(working, path, w.update, mask, time).updateTime };
    });
    docs.clear();
    for (const [path, rec] of working) docs.set(path, rec);
    return { ...(writeResults.length ? { writeResults } : {}), commitTime: time };
  }

  function listDocuments(segments, params) {
    checkParams(params, ['pageSize', 'pageToken'], ['orderBy', 'mask.fieldPaths', 'showMissing', 'transaction', 'readTime']);
    const rawSize = params.get('pageSize') ?? '0';
    if (!/^\d+$/.test(rawSize)) throw invalid(`Invalid value at 'page_size' (TYPE_INT32), "${rawSize}"`);
    const pageSize = Number(rawSize) || Infinity; // 0 or absent: no page limit
    const parent = segments.slice(0, -1).join('/');
    const all = [...docs.keys()]
      .filter((p) => { const s = p.split('/'); return s.at(-2) === segments.at(-1) && s.slice(0, -2).join('/') === parent; })
      .sort((a, b) => compareNames(a.split('/'), b.split('/')));
    let start = 0;
    const token = params.get('pageToken');
    if (token) {
      const after = Buffer.from(token, 'base64url').toString('utf8');
      if (Buffer.from(after, 'utf8').toString('base64url') !== token) throw invalid('Invalid page token.');
      start = all.findIndex((p) => compareNames(p.split('/'), after.split('/')) > 0);
      if (start === -1) start = all.length;
    }
    const page = all.slice(start, start + pageSize);
    return {
      ...(page.length ? { documents: page.map((p) => toDocument(p, docs.get(p))) } : {}),
      ...(start + page.length < all.length ? { nextPageToken: Buffer.from(page.at(-1), 'utf8').toString('base64url') } : {}),
    };
  }

  function preconditionParams(params) {
    const pre = {};
    if (params.has('currentDocument.exists')) {
      const raw = params.get('currentDocument.exists');
      if (raw !== 'true' && raw !== 'false') throw invalid(`Invalid value at 'current_document.exists' (TYPE_BOOL), "${raw}"`);
      pre.exists = raw === 'true';
    }
    if (params.has('currentDocument.updateTime')) pre.updateTime = params.get('currentDocument.updateTime');
    return Object.keys(pre).length ? pre : undefined;
  }

  function parseBody(raw) {
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch (e) {
      throw invalid(`Invalid JSON payload received. ${e.message}`);
    }
  }

  function route(method, rawPath, params, raw) {
    const m = /^\/v1\/projects\/([^/]+)\/databases\/([^/]+)\/documents(.*)$/.exec(rawPath);
    if (!m) throw new ApiError(404, 'NOT_FOUND', `The fake serves only /v1/${docRoot}.`);
    const [project, database] = [m[1], m[2]].map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    if (project !== projectId || database !== '(default)') {
      throw new ApiError(404, 'NOT_FOUND', `The database ${database} does not exist for project ${project}.`);
    }
    const verb = method === 'POST' && /^((?:\/[^/:]+)*):([A-Za-z]+)$/.exec(m[3]);
    if (verb) {
      const segments = splitPath(verb[1].slice(1));
      checkParams(params, []);
      if (verb[2] === 'runQuery') {
        if (segments.length % 2) throw invalid('A runQuery parent must be a document or the database root.');
        return runQuery(segments, parseBody(raw));
      }
      if (verb[2] === 'commit' && !segments.length) return commit(parseBody(raw));
      throw unimplemented(`:${verb[2]}`);
    }
    const segments = splitPath(m[3].slice(1));
    if (!segments.length) throw new ApiError(404, 'NOT_FOUND', `${method} on the database root is not an API call.`);
    const isDocument = segments.length % 2 === 0;
    const path = segments.join('/');
    if (method === 'GET' && !isDocument) return listDocuments(segments, params);
    if (method === 'POST') {
      if (isDocument) throw invalid(`Create needs a collection path; "${path}" names a document.`);
      checkParams(params, ['documentId'], ['mask.fieldPaths']);
      const body = parseBody(raw);
      checkDocument(body, 'document');
      const id = params.get('documentId') || Array.from(randomBytes(20), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
      checkId(id);
      const docPath = `${path}/${id}`;
      if (docs.has(docPath)) throw new ApiError(409, 'ALREADY_EXISTS', `Document already exists: ${nameOf(docPath)}`);
      return toDocument(docPath, applyUpdate(docs, docPath, body, null, now()));
    }
    if (!isDocument) throw invalid(`Document name "${nameOf(path)}" has an odd number of segments; it names a collection.`);
    if (method === 'GET') {
      checkParams(params, [], ['mask.fieldPaths', 'transaction', 'readTime']);
      if (!docs.has(path)) throw new ApiError(404, 'NOT_FOUND', `Document "${nameOf(path)}" not found.`);
      return toDocument(path, docs.get(path));
    }
    if (method === 'PATCH') {
      checkParams(params, ['updateMask.fieldPaths', 'currentDocument.exists', 'currentDocument.updateTime'], ['mask.fieldPaths']);
      const body = parseBody(raw);
      checkDocument(body, 'document');
      const mask = params.has('updateMask.fieldPaths') ? parseMask(params.getAll('updateMask.fieldPaths'), 'update_mask.field_paths') : null;
      checkPrecondition(preconditionParams(params), path, docs.get(path), 'current_document');
      return toDocument(path, applyUpdate(docs, path, body, mask, now()));
    }
    if (method === 'DELETE') {
      checkParams(params, ['currentDocument.exists', 'currentDocument.updateTime']);
      checkPrecondition(preconditionParams(params), path, docs.get(path), 'current_document');
      docs.delete(path);
      return {};
    }
    throw unimplemented(`${method} on a document`);
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const cut = req.url.indexOf('?');
      const rawPath = cut === -1 ? req.url : req.url.slice(0, cut);
      const query = cut === -1 ? '' : req.url.slice(cut + 1);
      const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      requests.push({ method: req.method, path: rawPath, query, token: auth ? auth[1] : null });
      let status = 200;
      let payload;
      try {
        payload = route(req.method, rawPath, new URLSearchParams(query), Buffer.concat(chunks));
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', `Firestore fake bug: ${err.stack}`);
        const error = { error: { code: e.code, message: e.message, status: e.status } };
        status = e.code;
        // :runQuery streams, and a streamed error arrives as a one-element array.
        payload = req.method === 'POST' && rawPath.endsWith(':runQuery') ? [error] : error;
      }
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    url: `${origin}/v1/${docRoot}`,
    projectId,
    requests,
    /** Every stored document by path, typed values exactly as sent: { 'work/w-1': { fields, createTime, updateTime } }. */
    dump: () => Object.fromEntries([...docs.keys()].sort().map((p) => [p, structuredClone(docs.get(p))])),
    /** Forgets every document and recorded request. */
    reset() {
      docs.clear();
      requests.length = 0;
    },
    stop: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
