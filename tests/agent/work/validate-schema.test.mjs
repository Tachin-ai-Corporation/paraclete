// Tests for agent/work/validate-schema.mjs. The schemas here are local fixtures, so the validator is
// tested apart from any record shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValid, coerce, fieldPaths } from '../../../agent/work/validate-schema.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;

const PLAYBOOK = {
  id: 'playbook',
  version: 1,
  spec: {
    type: 'object',
    properties: {
      id: { type: 'string', required: true, pattern: ID },
      name: { type: 'string', required: true, minLength: 1 },
      narrative: { type: 'string', required: true, minLength: 40 },
      keywords: { type: 'array', required: true, minLength: 1, items: { type: 'string' } },
      enabled: { type: 'boolean', default: true },
      evidence: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, default: [] } },
      },
      steps: {
        type: 'array',
        items: { type: 'object', properties: { symptom: { type: 'string' }, retries: { type: 'integer', default: 0 } } },
      },
    },
  },
};

const goodPlaybook = () => ({
  id: 'p-deploy',
  name: 'Staged deploy',
  narrative: 'A site change lands on a preview channel first and is promoted only after review.',
  keywords: ['deploy', 'staging'],
});

test('validate accepts a well-formed record', () => {
  const { valid, errors } = validate(PLAYBOOK, goodPlaybook());
  assert.equal(valid, true, JSON.stringify(errors));
});

test('validate reports every problem at once, each with a path', () => {
  const { valid, errors } = validate(PLAYBOOK, {
    id: 'Not A Valid Id',
    narrative: 'too short',
    keywords: [],
  });
  assert.equal(valid, false);
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes('id'), 'bad id reported');
  assert.ok(paths.includes('narrative'), 'short narrative reported');
  assert.ok(paths.includes('keywords'), 'empty keywords reported');
  assert.ok(errors.some((e) => e.path === 'name' && e.message === 'is required'), 'missing required field reported');
  assert.ok(errors.length >= 4, 'errors accumulate rather than short-circuiting');
});

test('validate points into nested objects and arrays', () => {
  const { errors } = validate(PLAYBOOK, { ...goodPlaybook(), keywords: ['ok', 7], steps: [{ retries: 1.5 }] });
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes('keywords[1]'));
  assert.ok(paths.includes('steps[0].retries'));
});

test('validate rejects undeclared fields', () => {
  const { valid, errors } = validate(PLAYBOOK, { ...goodPlaybook(), sneaky_field: 'x' });
  assert.equal(valid, false);
  assert.equal(errors[0].path, 'sneaky_field');
  assert.match(errors[0].message, /not a declared field/);
});

test('validate ignores leading-underscore runtime scratch fields', () => {
  const { valid } = validate(PLAYBOOK, { ...goodPlaybook(), _files: [], _cp_spine: {} });
  assert.equal(valid, true, 'runtime scratch is threaded in flight, never persisted');
});

test('validate distinguishes integer from number', () => {
  const int = { type: 'object', properties: { n: { type: 'integer', required: true } } };
  assert.equal(validate({ id: 't', version: 1, spec: int }, { n: 3 }).valid, true);
  assert.equal(validate({ id: 't', version: 1, spec: int }, { n: 3.5 }).valid, false);
});

test('validate honors nullable independently of required', () => {
  const spec = {
    type: 'object',
    properties: {
      a: { type: 'string', required: true, nullable: true },
      b: { type: 'string', required: true },
    },
  };
  const schema = { id: 't', version: 1, spec };
  assert.equal(validate(schema, { a: null, b: 'x' }).valid, true);
  assert.equal(validate(schema, { a: 'x', b: null }).valid, false);
});

test('validate refuses a record that is not an object', () => {
  for (const bad of [null, [], 'x', 3]) {
    const { valid, errors } = validate(PLAYBOOK, bad);
    assert.equal(valid, false);
    assert.match(errors[0].message, /expected an object/);
  }
});

test('a schema-level check reports at the root', () => {
  const schema = { id: 't', version: 1, spec: { type: 'object', properties: {}, check: () => 'always wrong' } };
  assert.deepEqual(validate(schema, {}).errors, [{ path: '', message: 'always wrong' }]);
});

test('assertValid throws with every error in one message', () => {
  assert.throws(
    () => assertValid(PLAYBOOK, { id: 'ok' }, 'playbook/ok'),
    (err) => /playbook\/ok/.test(err.message) && /is required/.test(err.message),
  );
  const good = goodPlaybook();
  assert.equal(assertValid(PLAYBOOK, good), good, 'a valid record comes back as is');
});

test('coerce applies defaults without mutating its input', () => {
  // A nested default is applied only inside a parent that is present; an absent object is not
  // conjured.
  const draft = { ...goodPlaybook(), evidence: {}, steps: [{ symptom: 'x' }] };
  const out = coerce(PLAYBOOK, draft);
  assert.equal(out.enabled, true, 'top-level default applied');
  assert.deepEqual(out.evidence.ids, [], 'nested default applied inside a present parent');
  assert.equal(out.steps[0].retries, 0, 'array-of-object defaults applied');
  assert.equal(draft.enabled, undefined, 'input untouched');
  assert.deepEqual(draft.evidence, {}, 'and the nested input object is untouched too');
  assert.equal(coerce(PLAYBOOK, goodPlaybook()).evidence, undefined, 'an absent parent is not conjured');
});

test('validate never mutates the record it judges', () => {
  const draft = { id: 'p-x' };
  const before = JSON.stringify(draft);
  validate(PLAYBOOK, draft);
  assert.equal(JSON.stringify(draft), before);
});

test('fieldPaths enumerates nested and array-of-object paths', () => {
  const paths = fieldPaths(PLAYBOOK.spec);
  assert.ok(paths.includes('evidence'));
  assert.ok(paths.includes('evidence.ids'));
  assert.ok(paths.includes('steps[].symptom'));
  assert.deepEqual(paths.slice(0, 3), ['id', 'name', 'narrative'], 'declaration order');
});
