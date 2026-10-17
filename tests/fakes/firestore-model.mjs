// tests/fakes/firestore-model.mjs: Firestore's data model as the Firestore fake needs it: the error
// shape, value validation, field paths, the cross-type value order, document sizes and server
// times. Pure functions over Firestore's typed REST values ({ stringValue: 'x' }, ...); it never
// decodes them to plain JavaScript. It holds no state and serves no HTTP: firestore-server.mjs
// does, and is its only caller.

const MAX_DOCUMENT_BYTES = 1_048_576;
const VALUE_TYPES = ['nullValue', 'booleanValue', 'integerValue', 'doubleValue', 'timestampValue', 'stringValue',
  'bytesValue', 'referenceValue', 'geoPointValue', 'arrayValue', 'mapValue'];
// Firestore orders values of different types: null < boolean < number < timestamp < string < bytes <
// reference < geopoint < array < map. Integers and doubles are one type, compared numerically.
export const TYPE_RANK = { nullValue: 0, booleanValue: 1, integerValue: 2, doubleValue: 2, timestampValue: 3,
  stringValue: 4, bytesValue: 5, referenceValue: 6, geoPointValue: 7, arrayValue: 8, mapValue: 9 };
const TIMESTAMP_RE = /^(\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?([Zz]|[+-]\d\d:\d\d)$/;
const SIMPLE_SEGMENT = /^[A-Za-z_][A-Za-z_0-9]*$/;
export const RESERVED = /^__.*__$/;

/** An error the fake answers with, in Firestore's { error: { code, message, status } } shape. */
export class ApiError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const invalid = (message) => new ApiError(400, 'INVALID_ARGUMENT', message);
export const unimplemented = (what) =>
  new ApiError(501, 'UNIMPLEMENTED', `The Firestore fake does not implement ${what}. See tests/fakes/README.md.`);

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);
export const utf8Length = (text) => Buffer.byteLength(text, 'utf8');
const byteCompare = (a, b) => Math.sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
export const typeOf = (value) => Object.keys(value)[0];
export const isNull = (value) => value !== undefined && typeOf(value) === 'nullValue';
export const isNaNValue = (value) => typeOf(value) === 'doubleValue' && Number.isNaN(Number(value.doubleValue));
const sortedKeys = (_key, v) => (isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => byteCompare(a, b))) : v);
/** A stable text form of typed fields, to tell whether a write changed a document. */
export const canonical = (value) => JSON.stringify(value, sortedKeys);

export function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw invalid(`Invalid JSON payload received. Unknown name "${key}" at '${where}': Cannot find field.`);
    }
  }
}

/** An RFC 3339 timestamp as [seconds, nanos], or null if the text is not one. */
export function parseTimestamp(text) {
  const m = typeof text === 'string' && TIMESTAMP_RE.exec(text);
  if (!m) return null;
  const ms = Date.parse(`${m[1].toUpperCase()}${m[3].toUpperCase()}`);
  if (Number.isNaN(ms)) return null;
  return [Math.floor(ms / 1000), Number((m[2] || '').padEnd(9, '0'))];
}

/** Server times: RFC 3339 with microseconds, strictly increasing across every call. */
export function createClock() {
  let last = 0;
  return () => {
    last = Math.max(Date.now() * 1000, last + 1);
    const seconds = new Date(Math.floor(last / 1000)).toISOString().slice(0, 19);
    return `${seconds}.${String(last % 1_000_000).padStart(6, '0')}Z`;
  };
}

/** A field path ('a.b', '`odd-name`.c') as its segments. Unquoted segments must be identifiers. */
export function parseFieldPath(text, where) {
  if (typeof text !== 'string' || !text) throw invalid(`Invalid field path at '${where}': it must be a non-empty string.`);
  const bad = () => invalid(`Invalid field path "${text}" at '${where}': quote any segment that is not an identifier with backticks.`);
  const segments = [];
  let i = 0;
  while (i < text.length) {
    let segment = '';
    if (text[i] === '`') {
      for (i += 1; i < text.length && text[i] !== '`'; i += 1) {
        if (text[i] === '\\') i += 1;
        segment += text[i] ?? '';
      }
      if (text[i] !== '`' || !segment) throw bad();
      i += 1;
    } else {
      const end = text.indexOf('.', i);
      segment = text.slice(i, end === -1 ? text.length : end);
      if (!SIMPLE_SEGMENT.test(segment)) throw bad();
      i += segment.length;
    }
    segments.push(segment);
    if (i < text.length) {
      if (text[i] !== '.' || i === text.length - 1) throw bad();
      i += 1;
    }
  }
  return segments;
}

export const isName = (path) => path.length === 1 && path[0] === '__name__';

export function getField(fields, segments) {
  let value = { mapValue: { fields } };
  for (const segment of segments) {
    value = own(value.mapValue?.fields, segment);
    if (value === undefined) return undefined;
  }
  return value;
}

export function setField(fields, segments, value) {
  let target = fields;
  for (const segment of segments.slice(0, -1)) {
    if (!own(target, segment)?.mapValue) target[segment] = { mapValue: { fields: {} } };
    target[segment].mapValue.fields ??= {};
    target = target[segment].mapValue.fields;
  }
  target[segments.at(-1)] = value;
}

export function deleteField(fields, segments) {
  let target = fields;
  for (const segment of segments.slice(0, -1)) {
    target = own(target, segment)?.mapValue?.fields;
    if (!target) return;
  }
  delete target[segments.at(-1)];
}

/** Every leaf field of a document as segments; a map with no fields counts as a leaf. */
export function leafPaths(fields, prefix = []) {
  return Object.entries(fields).flatMap(([key, value]) => (Object.keys(value.mapValue?.fields || {}).length
    ? leafPaths(value.mapValue.fields, [...prefix, key])
    : [[...prefix, key]]));
}

const VALUE_CHECKS = {
  nullValue: (v) => v === null || v === 'NULL_VALUE',
  booleanValue: (v) => typeof v === 'boolean',
  integerValue: (v) => (typeof v === 'string' && /^-?\d+$/.test(v)) || Number.isSafeInteger(v),
  doubleValue: (v) => typeof v === 'number' || ['NaN', 'Infinity', '-Infinity'].includes(v),
  timestampValue: (v) => parseTimestamp(v) !== null,
  stringValue: (v) => typeof v === 'string',
  bytesValue: (v) => typeof v === 'string' && /^[A-Za-z0-9+/_-]*={0,2}$/.test(v),
  referenceValue: (v) => typeof v === 'string' && /^projects\/[^/]+\/databases\/[^/]+\/documents\/./.test(v),
  geoPointValue: (v) => isObject(v),
  arrayValue: (v) => isObject(v) && (v.values === undefined || Array.isArray(v.values)),
  mapValue: (v) => isObject(v),
};

/** Rejects a Value the real API would refuse: no type or two, a malformed scalar, an array in an array. */
export function checkValue(value, where, inArray = false) {
  if (!isObject(value)) throw invalid(`Invalid value at '${where}': expected a Value object.`);
  checkKeys(value, VALUE_TYPES, where);
  const types = Object.keys(value);
  if (types.length !== 1) throw invalid(`Invalid value at '${where}': a Value has exactly one type, this one has ${types.length}.`);
  const [type] = types;
  const v = value[type];
  if (!VALUE_CHECKS[type](v)) throw invalid(`Invalid value at '${where}' (${type}): ${String(JSON.stringify(v)).slice(0, 80)}`);
  if (type === 'integerValue' && (BigInt(v) >= 2n ** 63n || BigInt(v) < -(2n ** 63n))) {
    throw invalid(`Invalid value at '${where}' (integerValue): out of the int64 range.`);
  }
  if (type === 'arrayValue') {
    if (inArray) throw invalid(`Cannot convert an array value in an array value (at '${where}').`);
    checkKeys(v, ['values'], where);
    (v.values || []).forEach((item, i) => checkValue(item, `${where}.values[${i}]`, true));
  }
  if (type === 'mapValue') {
    checkKeys(v, ['fields'], where);
    if (v.fields !== undefined) checkFields(v.fields, `${where}.fields`);
  }
}

export function checkFields(fields, where) {
  if (!isObject(fields)) throw invalid(`Invalid value at '${where}': expected a map of fields.`);
  for (const [name, value] of Object.entries(fields)) {
    if (!name || RESERVED.test(name) || utf8Length(name) > 1500) throw invalid(`Invalid field name "${name}" at '${where}'.`);
    checkValue(value, `${where}.${name}`);
  }
}

export function checkDocument(doc, where) {
  if (!isObject(doc)) throw invalid(`Invalid value at '${where}': expected a Document object.`);
  checkKeys(doc, ['name', 'fields', 'createTime', 'updateTime'], where);
  if (doc.fields !== undefined) checkFields(doc.fields, `${where}.fields`);
}

function compareNumbers(a, b) {
  if (typeOf(a) === 'integerValue' && typeOf(b) === 'integerValue') {
    const x = BigInt(a.integerValue);
    const y = BigInt(b.integerValue);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = Number(a.integerValue ?? a.doubleValue);
  const y = Number(b.integerValue ?? b.doubleValue);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(y) - Number.isNaN(x); // NaN sorts first
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Orders document paths, or any segment lists, segment by segment in UTF-8 byte order. */
export function compareNames(xs, ys) {
  for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
    const r = byteCompare(xs[i], ys[i]);
    if (r) return r;
  }
  return Math.sign(xs.length - ys.length);
}

/** Firestore's total order over values: by type rank, then within the type. */
export function compareValues(a, b) {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (TYPE_RANK[ta] !== TYPE_RANK[tb]) return Math.sign(TYPE_RANK[ta] - TYPE_RANK[tb]);
  const x = a[ta];
  const y = b[tb];
  switch (ta) {
    case 'nullValue': return 0;
    case 'booleanValue': return Math.sign(x - y);
    case 'integerValue': case 'doubleValue': return compareNumbers(a, b);
    case 'timestampValue': {
      const [s1, n1] = parseTimestamp(x);
      const [s2, n2] = parseTimestamp(y);
      return Math.sign(s1 - s2 || n1 - n2);
    }
    case 'stringValue': return byteCompare(x, y);
    case 'bytesValue': return Math.sign(Buffer.compare(Buffer.from(x, 'base64'), Buffer.from(y, 'base64')));
    case 'referenceValue': return compareNames(x.split('/'), y.split('/'));
    case 'geoPointValue': return Math.sign((x.latitude ?? 0) - (y.latitude ?? 0) || (x.longitude ?? 0) - (y.longitude ?? 0));
    case 'arrayValue': {
      const xs = x.values || [];
      const ys = y.values || [];
      for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
        const r = compareValues(xs[i], ys[i]);
        if (r) return r;
      }
      return Math.sign(xs.length - ys.length);
    }
    default: {
      const xf = x.fields || {};
      const yf = y.fields || {};
      const xk = Object.keys(xf).sort(byteCompare);
      const yk = Object.keys(yf).sort(byteCompare);
      for (let i = 0; i < Math.min(xk.length, yk.length); i += 1) {
        const r = byteCompare(xk[i], yk[i]) || compareValues(xf[xk[i]], yf[yk[i]]);
        if (r) return r;
      }
      return Math.sign(xk.length - yk.length);
    }
  }
}

/** A value's stored size, by Firestore's documented storage-size rules. */
function valueSize(value) {
  const type = typeOf(value);
  const v = value[type];
  switch (type) {
    case 'stringValue': case 'referenceValue': return utf8Length(v) + 1;
    case 'bytesValue': return Buffer.from(v, 'base64').length;
    case 'booleanValue': case 'nullValue': return 1;
    case 'geoPointValue': return 16;
    case 'arrayValue': return (v.values || []).reduce((n, item) => n + valueSize(item), 0);
    case 'mapValue': return fieldsSize(v.fields || {});
    default: return 8;
  }
}
const fieldsSize = (fields) => Object.entries(fields).reduce((n, [k, v]) => n + utf8Length(k) + 1 + valueSize(v), 0);

/** Rejects a document over Firestore's 1 MiB limit (name + fields + 32 bytes), with the real message. */
export function checkDocumentSize(name, path, fields) {
  const size = path.split('/').reduce((n, s) => n + utf8Length(s) + 1, 16) + fieldsSize(fields) + 32;
  if (size > MAX_DOCUMENT_BYTES) {
    throw invalid(`Document '${name}' cannot be written because its size (${size.toLocaleString('en-US')} bytes) exceeds the maximum allowed size of 1,048,576 bytes.`);
  }
}
