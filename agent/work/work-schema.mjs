// agent/work/work-schema.mjs: the shapes of the runtime records work moves: the work envelope
// (request, mission, checkpoint or task), the approval request and the project. Which status changes
// are legal lives in work-transitions.mjs, and the validator that reads these schemas in
// validate-schema.mjs. Used by work-transitions.mjs and by whatever validates a record before it
// is written.
//
// These records are written by the agent's code, never authored by hand. A shape that only one
// reader declares is a shape the writers can silently drift from, so it is declared once, here.

import { ID_PATTERN } from './work-ids.mjs';

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

/** How much a mission's outcome is worth getting right; it decides how hard the work is verified. */
export const STAKES = ['routine', 'consequential', 'irreversible'];

const ISO = { type: 'string', pattern: ISO_DATE };
const NULLABLE_ISO = { ...ISO, nullable: true };

/** An Address (agent/providers/channel.mjs): where a reply goes. */
const ADDRESS = {
  type: 'object',
  properties: {
    channel: { type: 'string', required: true, enum: ['dashboard', 'gchat'] },
    space: { type: 'string', nullable: true },
    thread: { type: 'string', nullable: true },
  },
};

/**
 * Where an envelope came from and what it carries about its origin, in one closed list of each
 * writer's keys: the ears (the Address and the person), the scheduler (the responsibility), the
 * checkpoint executor (its numbering, an approval gate, the paused plan), the brain (an idempotency
 * key, a notification's kind).
 */
const SOURCE_META = {
  type: 'object',
  default: {},
  properties: {
    // The ears, on every intake: the Address, the channel's message id, the person's own words.
    address: ADDRESS,
    channel_msg_id: { type: 'string' },
    raw_text: { type: 'string' },
    sender: { type: 'string', describe: "The person who asked: a dashboard user's email, or the Chat sender" },
    sender_name: { type: 'string' },
    // The scheduler, on a responsibility's request and mission.
    responsibility_id: { type: 'string' },
    responsibility_name: { type: 'string', nullable: true },
    responsibility_origin: { type: 'string' },
    responsibility_revision: { type: 'integer', min: 0 },
    schedule: { type: 'string', nullable: true },
    fired_at: ISO,
    fired_by_event: { type: 'string', nullable: true },
    process_ref: { type: 'string' },
    effect_scope: { type: 'string', enum: ['memory'], describe: 'A memory-scoped mission writes only memory' },
    // The checkpoint executor, on checkpoints, tasks and approval requests.
    dispatched_by: { type: 'string' },
    checkpoint: { type: 'integer', min: 1 },
    checkpoint_total: { type: 'integer', min: 0 },
    task_step: { type: 'integer', min: 1 },
    step_type: { type: 'string' },
    agent: { type: 'string', nullable: true },
    approval_id: { type: 'string' },
    approval_task_index: { type: 'integer', min: 0 },
    notification_type: { type: 'string' },
    // The checkpoint executor, on a mission paused at an approval gate; cleared when it resumes.
    paused_approval_id: { type: 'string' },
    paused_checkpoint_index: { type: 'integer', min: 0 },
    paused_task_index: { type: 'integer', min: 0 },
    paused_checkpoints: { type: 'array', items: { type: 'object', open: true } },
    paused_all_results: { type: 'array', items: { type: 'object', open: true } },
    // The brain: a checkpoint and task pair it wrote once, by key.
    ct_key: { type: 'string' },
  },
};

export const WORK_SCHEMA = schema('work', 1, {
  id: { type: 'string', required: true, minLength: 1 },
  type: { type: 'string', required: true, enum: ENVELOPE_TYPES },
  parent_id: { type: 'string', nullable: true },
  status: { type: 'string', required: true, enum: ENVELOPE_STATUSES },
  intent: { type: 'string', required: true },
  title: { type: 'string' },
  instruction: { type: 'string', required: true },
  // Null when nothing stated criteria: a responsibility without success criteria, a mission the
  // classifier gave none. A checkpoint is still judged, on its stated outcome.
  accept_criteria: { type: 'string', required: true, nullable: true, describe: 'What the deliverable must observably do, never a tool-runtime detail' },
  context_summary: { type: 'string', nullable: true },
  output: { type: 'string', nullable: true },
  error: { type: 'string', nullable: true },
  children: { type: 'array', items: { type: 'string' }, default: [] },
  depends_on: { type: 'array', items: { type: 'string' }, default: [] },
  source_channel: { type: 'string', required: true },
  source_meta: SOURCE_META,
  source_text: { type: 'string', nullable: true, describe: 'Verbatim request text, carried on missions only' },

  created_at: { ...ISO, required: true },
  started_at: NULLABLE_ISO,
  completed_at: NULLABLE_ISO,
  updated_at: { ...ISO, required: true },
  iteration: { type: 'integer', required: true, min: 0, default: 0 },

  blocker: { type: 'string', nullable: true },
  blocker_type: { type: 'string', nullable: true },
  blocked_at: NULLABLE_ISO,
  cancelled_at: NULLABLE_ISO,
  cancelled_reason: { type: 'string', nullable: true },
  archived_reason: { type: 'string', nullable: true, describe: 'Why the archival sweep archived it' },

  project_id: { type: 'string', nullable: true, describe: 'Set on every mission in practice' },
  // What the mission works with: its resource ledger (resources), its git version index and
  // checkpoint count, its artifacts and their manifest, files it received and files it exports.
  context: { type: 'object', open: true, nullable: true },
  context_forward: { type: 'string', nullable: true, describe: "What a resumed mission decides from first: an answer, a wait's next step, a resumed plan's results" },
  conversation_context: { type: 'string', nullable: true, describe: 'The conversation the request came from, as a block' },
  thread_key: { type: 'string', nullable: true, describe: 'The conversation thread in the thread ledger' },
  memory_context: { type: 'object', open: true, nullable: true, describe: 'The memory recalled for the mission: { recalled }' },
  memory_written: { type: 'boolean', describe: 'Its working-memory line is written; the archival sweep waits for it' },
  recalled_processes: { type: 'array', items: { type: 'string' }, describe: 'Playbooks the mission drew on, for the lesson after it' },
  stakes: { type: 'string', nullable: true, enum: STAKES },
  job_to_be_done: { type: 'string', nullable: true },
  needs_review: { type: 'boolean', describe: 'A verification could not judge it; a person should look' },
  review_reason: { type: 'string', nullable: true },

  // `internal` marks work that is never delivered outside the agent: a checkpoint or task, or a
  // mission demoted by plan-utils.mjs enforceMissionParentInvariant.
  delivery_status: { type: 'string', nullable: true, enum: ['pending', 'delivered', 'failed', 'internal'] },
  delivery_address: { ...ADDRESS, nullable: true },
  delivery_attempts: { type: 'integer', min: 0 },
  next_delivery_attempt_at: NULLABLE_ISO,
  delivery_error: { type: 'string', nullable: true },
  delivered_at: NULLABLE_ISO,
  delivered_channel: { type: 'string', nullable: true },

  // The paraclete release or commit that created the envelope. Stamped at creation and kept for
  // the envelope's whole life, so a mission can be attributed to the code that ran it.
  platform_version: { type: 'string', nullable: true },

  step_ledger: { type: 'object', open: true, describe: 'Idempotency keys for replay-safe dispatch' },
  claimed_by: { type: 'string', nullable: true },
  claimed_at_ms: { type: 'number', nullable: true },
  wait_resume_at: NULLABLE_ISO,
  resume_instruction: { type: 'string', nullable: true },

  // Working state the brain and the checkpoint executor keep on a mission between turns. The leading
  // underscore marks runtime state, not something the mission produced.
  _cp_spine: { type: 'array', nullable: true, items: { type: 'object', open: true }, describe: "The checkpoint spine: each checkpoint's outcome, criteria, tasks and verified status" },
  _cp_progress: { type: 'object', open: true, nullable: true, describe: 'Where a running plan stands, for a resume after a crash' },
  _cp_digest: { type: 'string', describe: "A checkpoint's digest, for observability" },
  _milestone_caveats: { type: 'array', items: { type: 'string' } },
  _brief: { type: 'object', open: true, nullable: true, describe: "The prefrontal's analysis of the work" },
  _accumulated_context: { type: 'string', describe: 'One block per decide iteration' },
  _compaction: { type: 'object', open: true, describe: 'The latest compaction of the accumulated context' },
  _session: { type: 'object', open: true, describe: "The cortex session's ids and counters, never its content" },
  _lastDecision: { type: 'object', open: true },
  _hydrated_refs: { type: 'array', items: { type: 'string' } },
  _swf_state: { type: 'string', nullable: true, enum: ['awaiting_unblock', 'unblock_attempted'] },
  _failure_synthesis: { type: 'string', nullable: true },
  _replan_count: { type: 'integer', min: 0 },
  _synth_grace_used: { type: 'boolean' },
  _blocked_mislabel_averted: { type: 'boolean' },
  _responsibility_triggered: { type: 'string' },
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

/**
 * An approval gate's document, in the shape agent/work/approvals.mjs writes it (buildApprovalRecord)
 * and a resolver patches it (approvalResolution). The document id is the approval's id.
 */
export const APPROVAL_SCHEMA = schema('approval', 2, {
  id: { type: 'string', minLength: 1, describe: 'The document id; readers add it, the record does not carry it' },
  envelopeId: { type: 'string', required: true, minLength: 1, describe: 'The mission this gates' },
  checkpointId: { type: 'string', nullable: true, describe: 'The checkpoint paused at the gate' },
  checkpointIndex: { type: 'integer', min: 0 },
  taskIndex: { type: 'integer', min: 0, describe: 'The gate task; the plan resumes at the task after it' },
  title: { type: 'string', required: true, describe: 'The gate task, in the plan\'s words' },
  description: { type: 'string', required: true, describe: 'What runs once it is approved' },
  projectName: { type: 'string' },
  project_id: { type: 'string' },
  source_channel: { type: 'string' },
  source_thread: { type: 'string', describe: 'The conversation the gate came from; a chat reply resolves gates of its own conversation' },
  requestedBy: { type: 'string', required: true, describe: "The person whose request the mission serves; '' for scheduled work" },
  requestedAt: { ...ISO, required: true },
  status: { type: 'string', required: true, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  resolvedAt: NULLABLE_ISO,
  resolvedBy: { type: 'string', nullable: true, describe: 'Who approved or rejected it' },
  reason: { type: 'string', nullable: true, describe: 'Why it was rejected' },
  _processed: {
    type: 'boolean', required: true, default: false,
    describe: 'Set once the poller acted on the resolution; the poller queries it, so it is written false at creation',
  },
}, (a) => {
  if (a.status !== 'pending' && !a.resolvedBy) return 'a resolved approval must record who resolved it';
  if (a.status !== 'pending' && !a.resolvedAt) return 'a resolved approval must record when';
  return null;
});

// ── Project ────────────────────────────────────────────────────────────

export const PROJECT_SCHEMA = schema('project', 1, {
  id: { type: 'string', required: true, pattern: ID_PATTERN, describe: 'Equals the document id' },
  schema_version: { type: 'integer', min: 1 },
  name: { type: 'string', required: true, minLength: 1, maxLength: 120 },
  description: { type: 'string', required: true, minLength: 1 },
  goal: { type: 'string', default: '' },
  status: { type: 'string', required: true, enum: ['active', 'paused', 'complete', 'archived'], default: 'active' },
  parent_id: { type: 'string', nullable: true, describe: 'Projects may nest, up to four levels deep' },
  depends_on: { type: 'array', items: { type: 'string' }, default: [] },
  standardProcesses: { type: 'array', items: { type: 'string' }, default: [] },
  context: { type: 'object', open: true, nullable: true, default: {} },
  deploy: { type: 'object', open: true, nullable: true },
  canon: {
    type: 'object', nullable: true, describe: 'Authoritative entries, changed only by the addresses in its authority list',
    properties: {
      authority: { type: 'array', items: { type: 'string' }, default: [] },
      entries: { type: 'array', items: { type: 'object', open: true }, default: [] },
    },
  },
  auto_complete: { type: 'boolean', describe: 'The project completes itself when all its work is done' },
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
