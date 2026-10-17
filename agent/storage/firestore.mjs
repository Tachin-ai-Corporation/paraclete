// agent/storage/firestore.mjs: the Firestore REST client the agent reads and writes documents
// through, plus the value encoding Firestore's REST API uses. It knows nothing about what a document
// means: collection names come from collections.mjs, and what to store is decided by the callers in
// work/ and context/. The git artifact store keeps its own compare-and-swap calls in git-store.mjs.

import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';

/**
 * How long any single Firestore call may take. Without a limit a hung connection blocks the
 * caller's poll tick forever, which is worse than an error: an error at least ends.
 */
const DEFAULT_TIMEOUT_MS = 10_000; // default; callers pass the contracts value

/** Default page size for query(). */
const DEFAULT_QUERY_LIMIT = 300;

// Firestore refuses any document over 1 MiB, and a refused write loses every field in it, including
// status transitions. Two fields can grow without bound, so write() trims them as a last resort.
const MAX_OUTPUT_CHARS = 800_000;
const MAX_ACCUMULATED_CONTEXT_CHARS = 400_000;
const ACCUMULATED_CONTEXT_HEAD_CHARS = 50_000;

/**
 * Encodes a plain object into Firestore REST field format. Handles strings, numbers, booleans,
 * null and undefined (both stored as null), arrays, Dates and nested objects.
 *
 * @param {object} obj
 * @returns {object} Firestore `fields`
 */
export function firestoreEncode(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof value === 'string') {
      fields[key] = { stringValue: value };
    } else if (typeof value === 'number') {
      fields[key] = Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    } else if (typeof value === 'boolean') {
      fields[key] = { booleanValue: value };
    } else if (Array.isArray(value)) {
      fields[key] = { arrayValue: { values: value.map(encodeValue) } };
    } else if (value instanceof Date) {
      fields[key] = { timestampValue: value.toISOString() };
    } else if (typeof value === 'object') {
      fields[key] = { mapValue: { fields: firestoreEncode(value) } };
    }
  }
  return fields;
}

/** Encodes one array element. Anything without a Firestore type is stored as its string form. */
function encodeValue(item) {
  if (item === null || item === undefined) return { nullValue: null };
  if (typeof item === 'string') return { stringValue: item };
  if (typeof item === 'number') {
    return Number.isInteger(item) ? { integerValue: String(item) } : { doubleValue: item };
  }
  if (typeof item === 'boolean') return { booleanValue: item };
  if (Array.isArray(item)) return { arrayValue: { values: item.map(encodeValue) } };
  if (item instanceof Date) return { timestampValue: item.toISOString() };
  if (typeof item === 'object') return { mapValue: { fields: firestoreEncode(item) } };
  return { stringValue: String(item) };
}

/**
 * Decodes Firestore REST fields back into a plain object; the inverse of firestoreEncode.
 * Timestamps come back as their ISO strings. A field of a type this client never writes is skipped.
 *
 * @param {object} fields - Firestore `fields`
 * @returns {object}
 */
export function firestoreDecode(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const decoded = decodeValue(value);
    if (decoded !== undefined) obj[key] = decoded;
  }
  return obj;
}

/**
 * Decodes one Firestore value, recursing into arrays and maps at any depth. Returns undefined for a
 * type this client never writes.
 */
function decodeValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map((item) => {
      const decoded = decodeValue(item);
      return decoded === undefined ? '' : decoded;
    });
  }
  if ('mapValue' in value) return firestoreDecode(value.mapValue.fields || {});
  return undefined;
}

/**
 * A storage operation that did not complete, as distinct from one that completed and found
 * nothing.
 *
 * The distinction is the whole point. If a read returns null for a 404, a 500 and a 403 alike, an
 * outage looks exactly like an empty world, and a query that returns [] on failure reads as "no
 * matching documents". Callers then act on that: an unreadable piece of work is treated as a failed
 * one, and a person is told work failed when it was running fine. A caller that must tell "could not
 * look" from "not there" passes `{ strict: true }` and gets this error for every non-404 failure.
 */
export class StoreUnavailable extends Error {
  constructor(op, path, status, body) {
    super(`Firestore ${op} ${path}: HTTP ${status} ${String(body).slice(0, 200)}`);
    this.name = 'StoreUnavailable';
    this.status = status;
  }
}

/**
 * A write refused because its precondition no longer held: the document changed (or came into
 * existence) after the caller read it. Nothing was applied. The caller re-reads and decides again
 * rather than overwriting someone else's edit.
 */
export class StoreConflict extends Error {
  constructor(path, body) {
    super(`Firestore commit ${path}: the document changed since it was read: ${String(body).slice(0, 160)}`);
    this.name = 'StoreConflict';
  }
}

/**
 * Creates a Firestore REST client for one project's default database.
 *
 * Failure semantics. A 404 is an answer: read() returns null. Every other failure is a failure to
 * get an answer. With `{ strict: true }`, read, write, query, patch and del throw StoreUnavailable
 * for it. Without it they keep the permissive return (null, [] or false) and log a warning, for the
 * many callers where "nothing there" and "could not look" lead to the same harmless no-op. readDoc
 * and commit always fail closed, because a compare-and-swap caller that mistook an outage for
 * "absent" would create over the top of a document it could not see.
 *
 * @param {object}   config
 * @param {string}   config.projectId        GCP project id
 * @param {Function} [config.logger]         (level, ...args) logger; defaults to console.log
 * @param {number}   [config.timeoutMs]      per-call timeout
 * @param {Function} [config.getAccessToken] token source; defaults to the VM's metadata server
 * @param {Function} [config.fetch]          fetch implementation (injectable for tests)
 * @returns {{read: Function, write: Function, query: Function, patch: Function, del: Function,
 *   readDoc: Function, commit: Function}}
 */
export function createClient(config) {
  if (!config?.projectId) throw new Error('createClient: projectId is required');
  const docRoot = `projects/${config.projectId}/databases/(default)/documents`;
  const BASE = `https://firestore.googleapis.com/v1/${docRoot}`;
  const log = config.logger || ((...args) => console.log('[firestore]', ...args));
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const getAccessToken = config.getAccessToken || getVmAccessToken;
  const fetch = config.fetch || globalThis.fetch;
  const abort = () => AbortSignal.timeout(timeoutMs);

  /**
   * Reads one document.
   *
   * @param {string} path - document path, e.g. `work/w-123`
   * @param {{strict?: boolean}} [opts]
   * @returns {Promise<object|null>} the decoded document, or null if it does not exist
   */
  async function read(path, opts = {}) {
    const token = await getAccessToken();
    const resp = await fetch(`${BASE}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort(),
    });
    if (!resp.ok) {
      // A 404 is an answer: the document is not there. Every other status is a failure to get an
      // answer, and the two must not share a return value for a strict caller.
      if (resp.status === 404) return null;
      const text = await resp.text();
      if (opts.strict) throw new StoreUnavailable('read', path, resp.status, text);
      // Permissive callers keep the null, but the failure is logged: a silent null makes an outage
      // look exactly like a healthy, idle agent in the journal.
      log('WARN', `Firestore read failed: ${resp.status} ${path}; returning null, which callers may read as 'absent'`);
      return null;
    }
    const doc = await resp.json();
    return firestoreDecode(doc.fields || {});
  }

  /**
   * Writes (upserts) a whole document. Trims the two fields that can outgrow Firestore's 1 MiB
   * document limit, in place, so the caller's copy matches what was stored.
   *
   * @param {string} path - document path
   * @param {object} data - plain object to write
   * @param {{strict?: boolean}} [opts]
   * @returns {Promise<object|null>} the written document, or null on failure
   */
  async function write(path, data, opts = {}) {
    const token = await getAccessToken();
    if (data?.output && typeof data.output === 'string' && data.output.length > MAX_OUTPUT_CHARS) {
      const dropped = data.output.length - MAX_OUTPUT_CHARS;
      log('WARN', `write: truncating output from ${data.output.length} to ${MAX_OUTPUT_CHARS} chars for ${path}`);
      data.output = data.output.substring(0, MAX_OUTPUT_CHARS)
        + `\n\n[TRUNCATED at the Firestore document size limit: ${dropped} chars dropped]`;
    }
    // An oversized accumulated context made every write to its document fail, losing the step
    // ledger and status transitions with it. Keep the head (the mission's framing) and the most
    // recent tail.
    if (data?._accumulated_context && typeof data._accumulated_context === 'string') {
      const acc = data._accumulated_context;
      if (acc.length > MAX_ACCUMULATED_CONTEXT_CHARS) {
        log('WARN', `write: truncating _accumulated_context from ${acc.length} to ${MAX_ACCUMULATED_CONTEXT_CHARS} chars for ${path}`);
        data._accumulated_context = acc.substring(0, ACCUMULATED_CONTEXT_HEAD_CHARS)
          + `\n\n[--- ${acc.length - MAX_ACCUMULATED_CONTEXT_CHARS} chars elided at Firestore size guard ---]\n\n`
          + acc.substring(acc.length - (MAX_ACCUMULATED_CONTEXT_CHARS - ACCUMULATED_CONTEXT_HEAD_CHARS));
      }
    }
    const resp = await fetch(`${BASE}/${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: firestoreEncode(data) }),
      signal: abort(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore write failed: ${resp.status} ${text}`);
      if (opts.strict) throw new StoreUnavailable('write', path, resp.status, text);
      return null;
    }
    return await resp.json();
  }

  /**
   * Runs a structured query against one collection.
   *
   * @param {string} parentPath - parent document path; '' for a collection at the database root
   * @param {string} collectionId - collection to query, from COLLECTIONS or SUBCOLLECTIONS
   * @param {Array<{field: string, op: string, value: object}>} filters - ANDed; values already encoded
   * @param {object}  [opts]
   * @param {string}  [opts.orderBy='created_at']
   * @param {string}  [opts.orderDirection='ASCENDING']
   * @param {boolean} [opts.noOrderBy] - skip ordering (ordering plus several filters needs a composite index)
   * @param {number}  [opts.limit=300]
   * @param {boolean} [opts.strict]
   * @returns {Promise<Array<object>>} decoded documents, each with its document id as `id`
   */
  async function query(parentPath, collectionId, filters, opts = {}) {
    const token = await getAccessToken();
    const url = parentPath ? `${BASE}/${parentPath}:runQuery` : `${BASE}:runQuery`;
    // An unfiltered query must omit `where` entirely. A compositeFilter with an empty `filters` array
    // is not "match everything": Firestore rejects it, and a permissive caller would see an empty
    // result instead of an error.
    const conditions = (filters || []).map((f) => ({
      fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: f.value },
    }));
    const structuredQuery = {
      from: [{ collectionId }],
      ...(conditions.length ? { where: { compositeFilter: { op: 'AND', filters: conditions } } } : {}),
      limit: opts.limit || DEFAULT_QUERY_LIMIT,
    };
    if (!opts.noOrderBy) {
      structuredQuery.orderBy = [{
        field: { fieldPath: opts.orderBy || 'created_at' },
        direction: opts.orderDirection || 'ASCENDING',
      }];
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
      signal: abort(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore query failed: ${resp.status} ${text}`);
      // [] is the most dangerous failure value: it does not read as an error, it reads as a fact.
      // A duplicate guard that catches an exception can never fire if the query returns [] instead.
      if (opts.strict) throw new StoreUnavailable('query', `${parentPath}/${collectionId}`, resp.status, text);
      return [];
    }
    const results = await resp.json();
    return results
      .filter((r) => r.document)
      // The document path is the id: a stored field named `id` must never override it.
      .map((r) => ({ ...firestoreDecode(r.document.fields || {}), id: r.document.name.split('/').pop() }));
  }

  /**
   * Updates only the named fields of a document.
   *
   * @param {string} path - document path
   * @param {string[]} fieldPaths - the field mask
   * @param {object} fields - already-encoded Firestore fields to set
   * @param {{strict?: boolean}} [opts]
   * @returns {Promise<object|null>} the updated document, or null on failure
   */
  async function patch(path, fieldPaths, fields, opts = {}) {
    const token = await getAccessToken();
    const mask = fieldPaths.map((f) => `updateMask.fieldPaths=${f}`).join('&');
    const resp = await fetch(`${BASE}/${path}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      signal: abort(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore patch failed: ${resp.status} ${text}`);
      if (opts.strict) throw new StoreUnavailable('patch', path, resp.status, text);
      return null;
    }
    return await resp.json();
  }

  /**
   * Deletes a document.
   *
   * @param {string} path - document path
   * @param {{strict?: boolean}} [opts]
   * @returns {Promise<boolean>} true if Firestore accepted the delete
   */
  async function del(path, opts = {}) {
    const token = await getAccessToken();
    const resp = await fetch(`${BASE}/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: abort(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore delete failed: ${resp.status} ${text}`);
      if (opts.strict) throw new StoreUnavailable('del', path, resp.status, text);
      return false;
    }
    return true;
  }

  /**
   * Reads a document with its server `updateTime`, the version token a compare-and-swap write needs.
   * Null only for a 404; every other failure throws StoreUnavailable.
   *
   * @param {string} path
   * @returns {Promise<{data: object, updateTime: string}|null>}
   */
  async function readDoc(path) {
    const token = await getAccessToken();
    const resp = await fetch(`${BASE}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort(),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new StoreUnavailable('read', path, resp.status, await resp.text());
    const doc = await resp.json();
    return { data: firestoreDecode(doc.fields || {}), updateTime: doc.updateTime };
  }

  /**
   * Applies several whole-document writes atomically: all or none. Each write may carry a
   * precondition, `{ exists: false }` (create only) or `{ updateTime }` (only if unchanged since it
   * was read). A failed precondition throws StoreConflict; any other failure, StoreUnavailable.
   *
   * @param {Array<{path: string, data: object, precondition?: object}>} writes
   */
  async function commit(writes) {
    const token = await getAccessToken();
    const body = {
      writes: writes.map((w) => ({
        update: { name: `${docRoot}/${w.path}`, fields: firestoreEncode(w.data) },
        ...(w.precondition ? { currentDocument: w.precondition } : {}),
      })),
    };
    const resp = await fetch(`${BASE}:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      const where = writes.map((w) => w.path).join(', ');
      if (resp.status === 409 || /FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/.test(text)) {
        throw new StoreConflict(where, text);
      }
      throw new StoreUnavailable('commit', where, resp.status, text);
    }
    return resp.json();
  }

  return { read, write, query, patch, del, readDoc, commit };
}
