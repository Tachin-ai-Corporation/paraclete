// agent/work/validate-schema.mjs: a small structural validator for record schemas such as those in
// work-schema.mjs: validate, assert, apply defaults, list field paths. It knows no schema itself.
// Called wherever a record crosses a trust boundary: the brain, the CLIs and migrations.
//
// Not JSON Schema. That would need an npm dependency on the VM, which installs none, and brings a
// vocabulary far wider than these records need. This covers exactly what the schemas use; anything
// it cannot express belongs in a `check` function beside the schema rather than in a bigger
// vocabulary.
//
// Errors accumulate: a caller gets every problem at once, each with a JSON-path pointer, because a
// validator that reports one error per run turns a ten-field mistake into ten round trips.

/**
 * @typedef {object} FieldSpec
 * @property {string} type            - 'string'|'number'|'integer'|'boolean'|'object'|'array'|'any'
 * @property {boolean} [required]     - absent or undefined fails
 * @property {boolean} [nullable]     - null is accepted even when required
 * @property {*} [default]            - applied by `coerce`, never by `validate`
 * @property {string[]} [enum]        - allowed values
 * @property {RegExp} [pattern]       - for strings
 * @property {number} [minLength]     - strings and arrays
 * @property {number} [maxLength]     - strings and arrays
 * @property {number} [min]           - numbers
 * @property {number} [max]           - numbers
 * @property {FieldSpec} [items]      - element spec for arrays
 * @property {Record<string,FieldSpec>} [properties] - for objects
 * @property {boolean} [open]         - object accepts unknown keys (default: false)
 * @property {(value:*, root:*) => (string|null)} [check] - custom rule; returns a message or null
 * @property {string} [describe]      - human intent, surfaced in generated docs
 */

/** @typedef {{ path: string, message: string }} ValidationError */

const TYPE_OF = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

function typeMatches(spec, value) {
  switch (spec.type) {
    case 'any': return true;
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return TYPE_OF(value) === spec.type;
  }
}

function validateField(spec, value, path, root, errors) {
  const fail = (message) => errors.push({ path, message });

  if (value === null) {
    if (!spec.nullable) fail(`expected ${spec.type}, got null`);
    return;
  }
  if (!typeMatches(spec, value)) {
    fail(`expected ${spec.type}, got ${TYPE_OF(value)}`);
    return; // further checks would only produce noise
  }

  if (spec.enum && !spec.enum.includes(value)) {
    fail(`must be one of: ${spec.enum.join(', ')} (got ${JSON.stringify(value)})`);
  }
  if (spec.pattern && typeof value === 'string' && !spec.pattern.test(value)) {
    fail(`does not match ${spec.pattern}`);
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      fail(`length ${value.length} is below the minimum ${spec.minLength}`);
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      fail(`length ${value.length} exceeds the maximum ${spec.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (spec.min !== undefined && value < spec.min) fail(`${value} is below the minimum ${spec.min}`);
    if (spec.max !== undefined && value > spec.max) fail(`${value} exceeds the maximum ${spec.max}`);
  }

  if (spec.type === 'array' && spec.items) {
    value.forEach((el, i) => validateField(spec.items, el, `${path}[${i}]`, root, errors));
  }

  if (spec.type === 'object' && spec.properties) {
    validateObject(spec, value, path, root, errors);
  }

  if (spec.check) {
    const message = spec.check(value, root);
    if (message) fail(message);
  }
}

function validateObject(spec, value, path, root, errors) {
  const props = spec.properties || {};
  for (const [key, fieldSpec] of Object.entries(props)) {
    const childPath = path ? `${path}.${key}` : key;
    const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
    if (!present) {
      if (fieldSpec.required) errors.push({ path: childPath, message: 'is required' });
      continue;
    }
    validateField(fieldSpec, value[key], childPath, root, errors);
  }

  if (!spec.open) {
    for (const key of Object.keys(value)) {
      // A leading underscore marks a runtime-only scratch field threaded onto a record in flight
      // (_files, _cp_spine). It is not part of any persisted shape and is never validated.
      if (key.startsWith('_')) continue;
      if (!props[key]) {
        errors.push({ path: path ? `${path}.${key}` : key, message: 'is not a declared field' });
      }
    }
  }
}

/**
 * Validate a record against a schema.
 *
 * @param {{ id: string, version: number, spec: FieldSpec }} schema
 * @param {object} record
 * @returns {{ valid: boolean, errors: ValidationError[] }}
 */
export function validate(schema, record) {
  const errors = [];
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: [{ path: '', message: `expected an object, got ${TYPE_OF(record)}` }] };
  }
  validateObject(schema.spec, record, '', record, errors);
  if (schema.spec.check) {
    const message = schema.spec.check(record, record);
    if (message) errors.push({ path: '', message });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate, or throw with every error in one message.
 *
 * For trust boundaries, where continuing with a malformed record is worse than failing.
 */
export function assertValid(schema, record, label = '') {
  const { valid, errors } = validate(schema, record);
  if (valid) return record;
  const where = label ? ` for ${label}` : '';
  const detail = errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n');
  throw new Error(`${schema.id} v${schema.version} validation failed${where}:\n${detail}`);
}

/**
 * Apply declared defaults to absent fields, recursively.
 *
 * Kept separate from `validate` on purpose: validation must never mutate the thing it is judging,
 * or "it validated" stops meaning "it was already correct". A nested default is applied only
 * inside a parent object that is present; an absent object is not conjured.
 */
export function coerce(schema, record) {
  return applyDefaults(schema.spec, record);
}

function applyDefaults(spec, value) {
  if (spec.type !== 'object' || !spec.properties) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

  const out = { ...value };
  for (const [key, fieldSpec] of Object.entries(spec.properties)) {
    if (out[key] === undefined && fieldSpec.default !== undefined) {
      out[key] = typeof fieldSpec.default === 'function' ? fieldSpec.default() : structuredClone(fieldSpec.default);
    } else if (out[key] !== undefined && out[key] !== null) {
      if (fieldSpec.type === 'object') {
        out[key] = applyDefaults(fieldSpec, out[key]);
      } else if (fieldSpec.type === 'array' && fieldSpec.items?.type === 'object' && Array.isArray(out[key])) {
        out[key] = out[key].map((el) => applyDefaults(fieldSpec.items, el));
      }
    }
  }
  return out;
}

/** Every field path a schema declares, in declaration order. Used for generated docs. */
export function fieldPaths(spec, prefix = '') {
  if (spec.type !== 'object' || !spec.properties) return [];
  const out = [];
  for (const [key, fieldSpec] of Object.entries(spec.properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    if (fieldSpec.type === 'object') out.push(...fieldPaths(fieldSpec, path));
    else if (fieldSpec.type === 'array' && fieldSpec.items?.type === 'object') {
      out.push(...fieldPaths(fieldSpec.items, `${path}[]`));
    }
  }
  return out;
}
