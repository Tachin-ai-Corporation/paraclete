// agent/work/work-schema.mjs: the shapes of the runtime records work moves: the work envelope
// (request, mission, checkpoint or task), the approval request and the project. Which status changes
// are legal lives in work-transitions.mjs, and the validator that reads these schemas in
// validate-schema.mjs. Used by work-transitions.mjs and by whatever validates a record before it
// is written.
//
// These records are written by the agent's code, never authored by hand. A shape that only one
// reader declares is a shape the writers can silently drift from, so it is declared once, here.

import { ID_PATTERN, DIGEST_PATTERN } from './work-ids.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const schema = (id, version, properties, check) => ({
  id, version, spec: { type: 'object', properties, check },
});

// ── Work envelope ──────────────────────────────────────────────────────

/** Request → Mission → Checkpoint → Task. The only work hierarchy there is. */
export const ENVELOPE_TYPES = ['R', 'M', 'C', 'T'];

export const ENVELOPE_STATUSES = [
  'pending', 'planned', 'queued', 'active', 'waiting', 'awaiting_approval',
  'needs_input', 'needs_review', 'blocked', 'complete', 'failed', 'rejected',
  'timed_out', 'cancelled', 'archived',
];

/** Statuses from which no further transition is legal, except archiving. */
export const TERMINAL_STATUSES = ['complete', 'failed', 'rejected', 'timed_out', 'cancelled', 'archived'];

export const WORK_SCHEMA = schema('work', 1, {
  id: { type: 'string', required: true, minLength: 1 },
  type: { type: 'string', required: true, enum: ENVELOPE_TYPES },
  parent_id: { type: 'string', nullable: true },
  status: { type: 'string', required: true, enum: ENVELOPE_STATUSES },
  intent: { type: 'string', required: true },
  title: { type: 'string' },
  instruction: { type: 'string', required: true },
  accept_criteria: { type: 'string', required: true, describe: 'What the deliverable must observably do, never a tool-runtime detail' },
  context_summary: { type: 'string', nullable: true },
  output: { type: 'string', nullable: true },
  error: { type: 'string', nullable: true },
  children: { type: 'array', items: { type: 'string' }, default: [] },
  depends_on: { type: 'array', items: { type: 'string' }, default: [] },
  source_channel: { type: 'string', required: true },
  source_meta: { type: 'object', open: true, default: {} },
  source_text: { type: 'string', nullable: true, describe: 'Verbatim request text, carried on missions only' },

  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  started_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  completed_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  updated_at: { type: 'string', required: true, pattern: ISO_DATE },
  iteration: { type: 'integer', required: true, min: 0, default: 0 },

  blocker: { type: 'string', nullable: true },
  blocker_type: { type: 'string', nullable: true },
  blocked_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  cancelled_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  cancelled_reason: { type: 'string', nullable: true },

  project_id: { type: 'string', nullable: true, describe: 'Set on every mission in practice' },
  // `internal` marks work that is never delivered outside the agent: a checkpoint or task, or a
  // mission demoted by plan-utils.mjs enforceMissionParentInvariant.
  delivery_status: { type: 'string', nullable: true, enum: ['pending', 'delivered', 'failed', 'internal'] },
  delivery_attempts: { type: 'integer', min: 0 },
  next_delivery_attempt_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  delivery_error: { type: 'string', nullable: true },

  // The paraclete release or commit that created the envelope. Stamped at creation and kept for
  // the envelope's whole life, so a mission can be attributed to the code that ran it.
  platform_version: { type: 'string', nullable: true },

  step_ledger: { type: 'object', open: true, describe: 'Idempotency keys for replay-safe dispatch' },
  claimed_by: { type: 'string', nullable: true },
  claimed_at_ms: { type: 'number', nullable: true },
  wait_resume_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  resume_instruction: { type: 'string', nullable: true },
}, (env) => {
  // Missions never nest, and the hierarchy has exactly one shape. The one parented mission is the
  // one a responsibility fires: its request (R) envelope is the mission's parent.
  if (env.type === 'M' && env.parent_id) {
    const meta = env.source_meta || {};
    if (!meta.responsibility_id) return 'a mission may not nest under another envelope';
  }
  if (env.type === 'T' && !env.parent_id) return 'a task must belong to a checkpoint';
  if (env.type === 'C' && !env.parent_id) return 'a checkpoint must belong to a mission';
  if (env.status === 'complete' && !env.completed_at) return 'a complete envelope must carry completed_at';
  return null;
});

// ── Approval ───────────────────────────────────────────────────────────

export const APPROVAL_SCHEMA = schema('approval', 1, {
  id: { type: 'string', required: true, minLength: 1 },
  schema_version: { type: 'integer', min: 1 },
  envelope_id: { type: 'string', required: true, describe: 'The work this gates' },
  conversation_id: { type: 'string', nullable: true, describe: 'The conversation the approval belongs to' },
  requested_at: { type: 'string', required: true, pattern: ISO_DATE },
  requested_by: { type: 'string', required: true },
  action_summary: { type: 'string', required: true, minLength: 5, describe: 'What is about to happen, in the approver\'s terms' },
  action_digest: {
    type: 'string', required: true, pattern: DIGEST_PATTERN,
    describe: 'Binds the approval to the exact action. An approval for one action cannot authorize another.',
  },
  stakes: { type: 'string', required: true, enum: ['routine', 'consequential', 'destructive_or_public'] },
  scope: { type: 'string', required: true, enum: ['once', 'conversation', 'mission'], default: 'once' },
  expires_at: { type: 'string', required: true, pattern: ISO_DATE },
  status: { type: 'string', required: true, enum: ['pending', 'approved', 'rejected', 'expired', 'consumed'], default: 'pending' },
  resolved_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  resolved_by: { type: 'string', nullable: true },
  consumed_at: { type: 'string', nullable: true, pattern: ISO_DATE, describe: 'An approval is consumed once' },
}, (a) => {
  if (a.status === 'approved' && !a.resolved_by) return 'an approved request must record who approved it';
  if (a.status === 'consumed' && !a.consumed_at) return 'a consumed approval must record when';
  return null;
});

// ── Project ────────────────────────────────────────────────────────────

export const PROJECT_SCHEMA = schema('project', 1, {
  id: { type: 'string', required: true, pattern: ID_PATTERN, describe: 'Equals the document id' },
  schema_version: { type: 'integer', min: 1 },
  name: { type: 'string', required: true, minLength: 1, maxLength: 120 },
  description: { type: 'string', required: true, minLength: 1 },
  goal: { type: 'string', default: '' },
  status: { type: 'string', required: true, enum: ['active', 'complete', 'archived'], default: 'active' },
  parent_id: { type: 'string', nullable: true, describe: 'Projects may nest, up to four levels deep' },
  depends_on: { type: 'array', items: { type: 'string' }, default: [] },
  standardProcesses: { type: 'array', items: { type: 'string' }, default: [] },
  context: { type: 'object', open: true, nullable: true, default: {} },
  deploy: { type: 'object', open: true, nullable: true },
  missionCount: { type: 'integer', min: 0, default: 0 },
  completedMissions: { type: 'integer', min: 0, default: 0 },
  created_by: { type: 'string', default: 'agent' },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  updated_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  completed_at: { type: 'string', nullable: true, pattern: ISO_DATE },
}, (p) => {
  if (p.parent_id === p.id) return 'a project cannot be its own parent';
  if (Array.isArray(p.depends_on) && p.depends_on.includes(p.id)) return 'a project cannot depend on itself';
  return null;
});
