// Tests for agent/work/work-schema.mjs: the work envelope, approval and project shapes, checked
// through validate-schema.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_SCHEMA, APPROVAL_SCHEMA, PROJECT_SCHEMA, ENVELOPE_STATUSES, TERMINAL_STATUSES, STAKES,
} from '../../../agent/work/work-schema.mjs';
import { buildApprovalRecord, approvalResolution } from '../../../agent/work/approvals.mjs';
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

test('an approval is declared in the shape the gate writes it and a resolver patches it', () => {
  const record = buildApprovalRecord({
    envelope: { id: 'w-1', project_id: 'general', source_channel: 'dashboard', source_meta: { address: { channel: 'dashboard', thread: 'th-1' } } },
    checkpointId: 'w-c1', checkpointIndex: 0, taskIndex: 1, title: 'Promote the site to production',
    description: 'If approved, this runs next: deploy', projectName: 'General', requestedBy: 'person@example.com', now: AT,
  });
  assert.deepEqual(validate(APPROVAL_SCHEMA, record).errors, [], 'the record as written validates');
  const resolved = { ...record, ...approvalResolution({ decision: 'approved', resolvedBy: 'person@example.com', now: AT }) };
  assert.deepEqual(validate(APPROVAL_SCHEMA, resolved).errors, []);
  const rejected = { ...record, ...approvalResolution({ decision: 'rejected', resolvedBy: 'person@example.com', reason: 'Not now', now: AT }) };
  assert.deepEqual(validate(APPROVAL_SCHEMA, rejected).errors, []);
  assert.equal(validate(APPROVAL_SCHEMA, { ...record, status: 'approved' }).valid, false, 'a resolution records who resolved it');
  const { _processed, ...rewritten } = resolved;
  assert.equal(validate(APPROVAL_SCHEMA, rewritten).valid, false, 'a whole-document rewrite that drops _processed is caught');
  assert.equal(validate(APPROVAL_SCHEMA, { ...record, action_digest: 'sha256:x' }).valid, false, 'the schema is closed');
});

test('one stakes scale: routine, consequential, irreversible', () => {
  assert.deepEqual(STAKES, ['routine', 'consequential', 'irreversible']);
  for (const s of STAKES) assert.equal(validate(WORK_SCHEMA, envelope({ stakes: s })).valid, true);
  assert.equal(validate(WORK_SCHEMA, envelope({ stakes: 'destructive_or_public' })).valid, false,
    'destructive_or_public is a risk level of a Brief part, not a stakes level');
});

test('a mission with the fields the brain and the executor keep on it validates', () => {
  const mission = envelope({
    id: 'w-m1', type: 'M', parent_id: null, intent: 'decide', accept_criteria: null,
    context_forward: '[RESUMED AFTER WAIT] Check the deploy', context: { resources: {} }, stakes: 'consequential',
    job_to_be_done: 'ship it', memory_context: { recalled: 'Earlier: the site deploys from main.' }, memory_written: true,
    recalled_processes: ['p-deploy'], conversation_context: '## Conversation', thread_key: 'th-1', needs_review: false,
    delivery_status: 'pending', delivery_address: { channel: 'dashboard', thread: 'th-1' }, delivered_at: AT, delivered_channel: 'dashboard',
    archived_reason: null, wait_resume_at: null, claimed_by: null,
    source_meta: {
      address: { channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/BBB' }, sender: 'person@example.com', sender_name: 'Person',
      channel_msg_id: 'm1', raw_text: 'Deploy it', paused_approval_id: 'apr-1', paused_checkpoint_index: 0, paused_task_index: 1,
      paused_checkpoints: [{ instruction: 'Deploy', tasks: [{ agent: 'motor', task: 'deploy' }] }], paused_all_results: [],
    },
    _cp_spine: [{ n: 1, outcome: 'Deploy', status: 'pending' }], _cp_progress: null, _milestone_caveats: ['CP1: a note'],
    _brief: { objective: 'x', parts: [] }, _accumulated_context: '--- Iteration 1 ---', _session: { id: null, seq: null, generation: 1 },
    _swf_state: 'awaiting_unblock', _replan_count: 1,
  });
  assert.deepEqual(validate(WORK_SCHEMA, mission).errors, []);
});

test('source_meta is closed: a key no writer declares is an error', () => {
  const { valid, errors } = validate(WORK_SCHEMA, envelope({ source_meta: { owner: 'someone' } }));
  assert.equal(valid, false);
  assert.match(errors[0].path, /source_meta\.owner/);
  assert.equal(validate(WORK_SCHEMA, envelope({ source_meta: { address: { channel: 'carrier-pigeon' } } })).valid, false);
});

test('a project may be paused, and carries its canon and its auto-complete switch', () => {
  const project = { id: 'site', name: 'Site', description: 'The website', status: 'paused', created_at: AT,
    canon: { authority: ['person@example.com'], entries: [{ key: 'deploy', text: 'Deploys go through staging first.' }] },
    auto_complete: true };
  assert.deepEqual(validate(PROJECT_SCHEMA, project).errors, []);
  assert.equal(validate(PROJECT_SCHEMA, { ...project, status: 'frozen' }).valid, false);
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
