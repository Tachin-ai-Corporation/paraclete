// Tests for agent/storage/entity-id.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docIdFromName, reconcileEntityId, withCanonicalId } from '../../../agent/storage/entity-id.mjs';

const DOC_BASE = 'projects/your-gcp-project/databases/(default)/documents';

test('docIdFromName extracts the trailing segment of a REST resource name', () => {
  assert.equal(docIdFromName(`${DOC_BASE}/projects/quarterly-report`), 'quarterly-report');
  assert.equal(docIdFromName(`${DOC_BASE}/processes/p-plan`), 'p-plan');
  assert.equal(docIdFromName(`${DOC_BASE}/processes/p-plan/revisions/r-3`), 'r-3');
});

test('docIdFromName tolerates trailing slashes and bare ids', () => {
  assert.equal(docIdFromName(`${DOC_BASE}/projects/quarterly-report/`), 'quarterly-report');
  assert.equal(docIdFromName('bare-id'), 'bare-id');
});

test('docIdFromName returns an empty string for non-string or empty input', () => {
  assert.equal(docIdFromName(''), '');
  assert.equal(docIdFromName(null), '');
  assert.equal(docIdFromName(undefined), '');
  assert.equal(docIdFromName(42), '');
});

test('reconcileEntityId recovers a record whose body omits id', () => {
  const stored = { name: 'Quarterly report', description: 'Numbers for the quarter', status: 'active' };
  const { entity, id, mismatch } = reconcileEntityId(stored, `${DOC_BASE}/projects/quarterly-report`);
  assert.equal(id, 'quarterly-report');
  assert.equal(entity.id, 'quarterly-report');
  assert.equal(entity.name, 'Quarterly report');
  assert.equal(mismatch, null);
});

test('reconcileEntityId leaves an agreeing body untouched', () => {
  const stored = { id: 'p-plan', name: 'Plan', narrative: 'When we plan work well...' };
  const { entity, id, mismatch } = reconcileEntityId(stored, `${DOC_BASE}/processes/p-plan`);
  assert.equal(id, 'p-plan');
  assert.equal(entity.id, 'p-plan');
  assert.equal(mismatch, null);
});

test('reconcileEntityId reports a body/path disagreement and trusts the path', () => {
  const stored = { id: 'copied-from-elsewhere', name: 'Plan' };
  const { entity, id, mismatch } = reconcileEntityId(stored, `${DOC_BASE}/processes/p-plan`);
  assert.equal(id, 'p-plan', 'the document path is authoritative');
  assert.equal(entity.id, 'p-plan');
  assert.equal(mismatch, 'copied-from-elsewhere', 'the disagreement is surfaced, not swallowed');
});

test('reconcileEntityId falls back to the body id when the path is unusable', () => {
  const { entity, id } = reconcileEntityId({ id: 'from-body' }, '');
  assert.equal(id, 'from-body');
  assert.equal(entity.id, 'from-body');
});

test('reconcileEntityId yields no entity when neither path nor body has an id', () => {
  const { entity, id } = reconcileEntityId({ name: 'orphan' }, '');
  assert.equal(entity, null);
  assert.equal(id, '');
});

test('withCanonicalId stamps the id without mutating the input', () => {
  const body = { name: 'Plan' };
  const stamped = withCanonicalId('p-plan', body);
  assert.equal(stamped.id, 'p-plan');
  assert.equal(stamped.name, 'Plan');
  assert.equal(body.id, undefined, 'input is not mutated');
});

test('withCanonicalId overrides an id a caller tried to smuggle in', () => {
  const stamped = withCanonicalId('p-plan', { id: 'attacker-chosen', name: 'Plan' });
  assert.equal(stamped.id, 'p-plan');
});
