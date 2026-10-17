// Tests for agent/work/work-schema.mjs: the work envelope, approval and project shapes, checked
// through validate-schema.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_SCHEMA, APPROVAL_SCHEMA, PROJECT_SCHEMA, ENVELOPE_STATUSES, TERMINAL_STATUSES,
} from '../../../agent/work/work-schema.mjs';
import { validate, fieldPaths } from '../../../agent/work/validate-schema.mjs';
import { enforceMissionParentInvariant } from '../../../agent/work/plan-utils.mjs';

const AT = '2026-08-15T12:00:00Z';

const envelope = (over = {}) => ({
  id: 'w-1', type: 'T', parent_id: 'c-1', status: 'active',
  intent: 'do', instruction: 'do the thing', accept_criteria: 'the thing is done',
  source_channel: 'chat', created_at: AT, updated_at: AT, iteration: 0, ...over,
});

test('a well-formed task envelope validates', () => {
  const { valid, errors } = validate(WORK_SCHEMA, envelope());
  assert.equal(valid, true, JSON.stringify(errors));
});

test('a mission may not nest under another envelope', () => {
  const { valid, errors } = validate(WORK_SCHEMA, envelope({ type: 'M', parent_id: 'm-0' }));
  assert.equal(valid, false);
  assert.match(errors.map((e) => e.message).join(' '), /may not nest/);
});

test('a mission a responsibility fired may point at its request envelope', () => {
  const { valid } = validate(WORK_SCHEMA, envelope({
    type: 'M', parent_id: 'r-1', source_meta: { responsibility_id: 'r-memory-consolidation' },
  }));
  assert.equal(valid, true, 'R → M is the one parented mission');
});

test('tasks and checkpoints require a parent', () => {
  assert.equal(validate(WORK_SCHEMA, envelope({ type: 'T', parent_id: null })).valid, false);
  assert.equal(validate(WORK_SCHEMA, envelope({ type: 'C', parent_id: null })).valid, false);
});

test('a complete envelope must record when it completed', () => {
  assert.equal(validate(WORK_SCHEMA, envelope({ status: 'complete' })).valid, false);
  assert.equal(validate(WORK_SCHEMA, envelope({ status: 'complete', completed_at: AT })).valid, true);
});

test('terminal statuses are a subset of the declared status set', () => {
  for (const s of TERMINAL_STATUSES) assert.ok(ENVELOPE_STATUSES.includes(s), `${s} must be a declared status`);
});

test('internal delivery status is declared, so a demoted mission still validates', () => {
  // Fixed defect: enforceMissionParentInvariant (and checkpoint and task creation) write
  // delivery_status 'internal', which the schema's enum did not list.
  const nested = envelope({ type: 'M', parent_id: 'm-0' });
  assert.equal(enforceMissionParentInvariant(nested), true);
  const { valid, errors } = validate(WORK_SCHEMA, nested);
  assert.equal(valid, true, JSON.stringify(errors));
  assert.equal(validate(WORK_SCHEMA, envelope({ delivery_status: 'sideways' })).valid, false);
});

test('a runtime scratch field on an envelope in flight is not a schema error', () => {
  assert.equal(validate(WORK_SCHEMA, envelope({ _cp_spine: [], _files: [] })).valid, true);
});

test('an approval binds to an action digest and is consumed once', () => {
  const paths = fieldPaths(APPROVAL_SCHEMA.spec);
  for (const f of ['action_digest', 'scope', 'expires_at', 'consumed_at']) {
    assert.ok(paths.includes(f), `approval must carry ${f}`);
  }
  const digest = 'sha256:' + 'f'.repeat(64);
  const base = {
    id: 'ap-1', envelope_id: 'w-1', requested_at: AT, requested_by: 'agent',
    action_summary: 'Promote the site to production', action_digest: digest,
    stakes: 'destructive_or_public', scope: 'once', expires_at: AT,
  };
  assert.equal(validate(APPROVAL_SCHEMA, { ...base, status: 'approved' }).valid, false, 'approved requires a resolver');
  assert.equal(validate(APPROVAL_SCHEMA, { ...base, status: 'approved', resolved_by: 'person@example.com' }).valid, true);
  assert.equal(validate(APPROVAL_SCHEMA, { ...base, status: 'consumed' }).valid, false, 'consumed requires a timestamp');
  assert.equal(validate(APPROVAL_SCHEMA, { ...base, status: 'pending', action_digest: 'abc' }).valid, false,
    'a digest must name its algorithm');
});

test('a project id is a kebab-case id, and a project cannot point at itself', () => {
  const project = (over = {}) => ({
    id: 'general', name: 'General', description: 'Unscoped work', status: 'active', created_at: AT, ...over,
  });
  assert.equal(validate(PROJECT_SCHEMA, project()).valid, true);
  assert.equal(validate(PROJECT_SCHEMA, project({ id: 'Not An Id' })).valid, false);
  assert.match(validate(PROJECT_SCHEMA, project({ parent_id: 'general' })).errors[0].message, /its own parent/);
  assert.match(validate(PROJECT_SCHEMA, project({ depends_on: ['general'] })).errors[0].message, /depend on itself/);
});
