// dashboard/lib/server/work.mjs: the agent's work as the dashboard shows it. Work lives in the `work`
// collection as envelopes the brain writes (shapes: agent/work/work-schema.mjs): a request (R), a
// mission (M), a mission's checkpoints (C) and each checkpoint's tasks (T). This module lists the
// missions and builds one envelope's detail: its plan (checkpoints, each with the verifier's verdict,
// and their tasks), the messages the agent sent about it, its step history (work/{id}/history), its
// approval gates, and what it is waiting for. Read-only: the dashboard never changes an envelope.
//
// Three things about the stored data shape what is read here:
//   - The archival sweep (agent/work/archival.mjs) rewrites finished envelopes to `archived`, keeping
//     what they were only in `archived_reason`. outcomeOf() maps those reasons back, so a mission
//     archived after it finished still reads as done or failed. The reasons are archival.mjs's.
//   - The verdict on a checkpoint is not one stored field. The checkpoint executor records it as the
//     checkpoint's status and output, `needs_review` when the verifier could not judge, the
//     mission's `_milestone_caveats` ("CP<n>: ...") for a pass with a caveat, and a line in the
//     checkpoint's `_cp_digest` ("Step <n>.verify (cerebellum): FAILED — ...") with the verifier's
//     summary. checkpointVerdict() reads them back.
//   - Every query is served by the indexes in install/firestore.indexes.json or by Firestore's
//     automatic single-field indexes: missions by `type` newest first (type + created_at), open work by
//     `status IN`, children by `parent_id`, history by `seq`.
//
// Answering the agent is not here: a mission asks a person through the chat, and the brain matches a
// chat reply to the waiting mission (agent/services/brain/intake-handlers.mjs). Deciding approvals is
// approvals.mjs.

import { StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { SUBCOLLECTIONS } from '../../../agent/storage/collections.mjs';
import { ENVELOPE_STATUSES, PAUSED_STATUSES, TERMINAL_STATUSES } from '../../../agent/work/work-transitions.mjs';
import { HttpError } from './errors.mjs';
import { approvalsForMission, checkDocId } from './approvals.mjs';

/** Statuses an envelope has not finished in. */
const OPEN_STATUSES = ENVELOPE_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status));

/**
 * The work list's views, by outcome (outcomeOf). `active` is work running or about to run, `waiting`
 * is work paused on a person or a timer, `failed` includes work that was stopped or never answered.
 */
export const WORK_VIEWS = Object.freeze({
  active: Object.freeze(OPEN_STATUSES.filter((status) => !PAUSED_STATUSES.includes(status))),
  waiting: Object.freeze([...PAUSED_STATUSES]),
  done: Object.freeze(['complete']),
  failed: Object.freeze(['failed', 'timed_out', 'rejected', 'cancelled', 'unanswered']),
});
export const LIST_VIEWS = Object.freeze(['all', ...Object.keys(WORK_VIEWS)]);

/** What an archived envelope was, by the archival sweep's `archived_reason`. */
const ARCHIVED_OUTCOMES = Object.freeze({
  child_complete: 'complete',
  delivered: 'complete',
  delivered_no_memory: 'complete',
  stale_failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  unanswered: 'unanswered',
});

/** The sender the agent's own messages carry (dashboard/README.md, message shape). */
const AGENT_SENDER = 'agent';

const LIST_LIMIT = 25;
const SCAN_PAGE = 100;
const SCAN_PAGES = 5;
const OPEN_LIMIT = 300;
const CHILD_LIMIT = 300;
const HISTORY_LIMIT = 200;
const IN_CHUNK = 30;

/** How much text each part of a detail carries. The envelope asked for gets the most. */
const TEXT = Object.freeze({
  ownOutput: 200_000,
  ownInstruction: 20_000,
  childOutput: 4_000,
  childInstruction: 1_000,
  message: 4_000,
  short: 300,
});

const instant = (value) => Date.parse(value || '') || 0;

/**
 * What an envelope ended as, or its status while it runs: `archived` envelopes read as what they were
 * when the sweep archived them (`unanswered` for a question nobody answered).
 *
 * @param {object} env
 * @returns {string}
 */
export function outcomeOf(env) {
  const status = env?.status || 'unknown';
  if (status !== 'archived') return status;
  return ARCHIVED_OUTCOMES[env.archived_reason] || 'archived';
}

/** The list view an outcome belongs to, or 'other' (shown only under all). */
export function viewOf(outcome) {
  return Object.keys(WORK_VIEWS).find((view) => WORK_VIEWS[view].includes(outcome)) || 'other';
}

/** Whether an envelope will change no more (the detail view polls it slowly). */
const isSettled = (env) => TERMINAL_STATUSES.includes(env?.status);

/** Text cut to `max` characters, '' for nothing. Objects (never expected) read as JSON. */
function text(value, max) {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A long text with how much of it was sent: `{ text, chars, clipped }`, or null for none. */
export function clipText(value, max) {
  if (value === undefined || value === null || value === '') return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { text: s.length > max ? s.slice(0, max) : s, chars: s.length, clipped: s.length > max };
}

/**
 * Who asked for the work: a person (the email or Chat sender the ears recorded), a responsibility the
 * scheduler fired, or nobody known.
 *
 * @param {object} env
 * @returns {{kind: 'person', id: string, name: string} | {kind: 'schedule', name: string} | null}
 */
export function requesterOf(env) {
  const meta = env?.source_meta || {};
  const sender = typeof meta.sender === 'string' ? meta.sender.trim() : '';
  if (sender && sender !== AGENT_SENDER) return { kind: 'person', id: sender, name: typeof meta.sender_name === 'string' ? meta.sender_name : '' };
  if (meta.responsibility_id) return { kind: 'schedule', name: String(meta.responsibility_name || meta.responsibility_id) };
  return null;
}

const titleOf = (env) => text(env.title || String(env.instruction || '').split('\n')[0] || env.intent || env.id, 200);

/** One line of what an open envelope is waiting for, for lists. */
function waitingLine(env) {
  switch (env.status) {
    case 'needs_input': return text(env.output, 240) || 'It has a question.';
    case 'blocked': return text(env.blocker || env.output, 240) || 'It is blocked.';
    case 'awaiting_approval': return 'It needs an approval to go on.';
    // A timed wait shows its resume time (wait_resume_at), formatted where it is shown.
    case 'waiting': return env.wait_resume_at ? '' : 'Paused, with no time set to resume.';
    default: return '';
  }
}

/** A mission as the work list shows it. */
export function missionSummary(env) {
  const outcome = outcomeOf(env);
  return {
    id: env.id,
    type: env.type,
    title: titleOf(env),
    status: env.status,
    outcome,
    view: viewOf(outcome),
    archived: env.status === 'archived',
    intent: env.intent || null,
    requested_by: requesterOf(env),
    channel: env.source_channel || null,
    project_id: env.project_id || null,
    stakes: env.stakes || null,
    created_at: env.created_at || null,
    started_at: env.started_at || null,
    completed_at: env.completed_at || null,
    updated_at: env.updated_at || null,
    needs_review: env.needs_review === true,
    waiting_for: waitingLine(env),
    error: text(env.error, TEXT.short) || null,
    wait_resume_at: env.wait_resume_at || null,
  };
}

/** A conversational reply the brain answered at once: a mission, but not work to follow. */
const isQuickReply = (env) => env.intent === 'respond';

/** Runs Firestore calls; an outage is a 503 the person can act on, with the details logged. */
async function guarded(runtime, what, call) {
  try {
    return await call();
  } catch (err) {
    if (err instanceof StoreUnavailable) {
      runtime.log('WARN', `${what}: ${err.message}`);
      throw new HttpError(503, 'the dashboard could not read its database just now; try again in a moment');
    }
    throw err;
  }
}

// ---- The work list ----

/** A list cursor: the last mission's created_at and id, so equal timestamps never skip a mission. */
export function encodeCursor(env) {
  return `${env.created_at}|${env.id}`;
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  const cut = s.lastIndexOf('|');
  const at = s.slice(0, cut);
  const id = s.slice(cut + 1);
  if (cut <= 0 || !Number.isFinite(Date.parse(at)) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new HttpError(400, 'that is not a position in the work list');
  }
  return { at, id };
}

/** Every open mission (running or paused), newest first. Open work is few envelopes, so one query. */
async function openMissions(runtime) {
  const docs = await guarded(runtime, 'work: open query', () => runtime.db.query('', runtime.collections.work, [
    { field: 'status', op: 'IN', value: { arrayValue: { values: OPEN_STATUSES.map((s) => ({ stringValue: s })) } } },
  ], { noOrderBy: true, limit: OPEN_LIMIT, strict: true }));
  return docs
    .filter((env) => env.type === 'M')
    .sort((a, b) => instant(b.created_at) - instant(a.created_at) || (a.id < b.id ? 1 : -1));
}

/**
 * The missions in one view, newest first, a page at a time.
 *
 * Running and waiting work is read whole (it is few envelopes). History (all, done, failed) pages
 * through the missions newest first, filtered by outcome, scanning at most SCAN_PAGES pages per call;
 * `next` continues from where this call stopped.
 *
 * Quick replies (the brain answering a chat message at once) are missions too, but not work to follow;
 * they are left out unless `replies` is set.
 *
 * @param {object}  runtime
 * @param {object}  [o]
 * @param {string}  [o.view='all']   one of LIST_VIEWS
 * @param {string}  [o.before]       `next` from the previous page
 * @param {boolean} [o.replies]      include quick replies
 * @param {number}  [o.limit]
 * @returns {Promise<{view: string, missions: object[], next: string|null, counts: {active: number, waiting: number}}>}
 */
export async function listWork(runtime, { view = 'all', before, replies = false, limit = LIST_LIMIT } = {}) {
  if (!LIST_VIEWS.includes(view)) throw new HttpError(400, `the view must be one of ${LIST_VIEWS.join(', ')}`);
  const cursor = decodeCursor(before);
  const keep = (env) => replies || !isQuickReply(env);

  const open = (await openMissions(runtime)).filter(keep).map(missionSummary);
  const counts = {
    active: open.filter((m) => m.view === 'active').length,
    waiting: open.filter((m) => m.view === 'waiting').length,
  };
  if (view === 'active' || view === 'waiting') {
    return { view, missions: open.filter((m) => m.view === view), next: null, counts };
  }

  const wanted = (summary) => view === 'all' || summary.view === view;
  const missions = [];
  let from = cursor;
  for (let page = 0; page < SCAN_PAGES; page++) {
    const filters = [{ field: 'type', op: 'EQUAL', value: { stringValue: 'M' } }];
    if (from) filters.push({ field: 'created_at', op: 'LESS_THAN_OR_EQUAL', value: { stringValue: from.at } });
    const docs = await guarded(runtime, 'work: mission page', () => runtime.db.query('', runtime.collections.work, filters, {
      orderBy: 'created_at', orderDirection: 'DESCENDING', limit: SCAN_PAGE, strict: true,
    }));
    // Missions created in the same millisecond come in descending id order; those up to the cursor
    // were on the previous page.
    const fresh = from ? docs.filter((env) => !(env.created_at === from.at && env.id >= from.id)) : docs;
    const exhausted = docs.length < SCAN_PAGE;
    for (let i = 0; i < fresh.length; i++) {
      const summary = missionSummary(fresh[i]);
      if (keep(fresh[i]) && wanted(summary)) missions.push(summary);
      if (missions.length >= limit) {
        const more = i < fresh.length - 1 || !exhausted;
        return { view, missions, next: more ? encodeCursor(fresh[i]) : null, counts };
      }
    }
    // The end of the missions, or a page with nothing new (more than a page created in one
    // millisecond, which the cursor cannot step past).
    if (exhausted || fresh.length === 0) return { view, missions, next: null, counts };
    const last = fresh[fresh.length - 1];
    from = { at: last.created_at, id: last.id };
  }
  // Scanned as far as one call may: the next call carries on from here.
  return { view, missions, next: encodeCursor({ created_at: from.at, id: from.id }), counts };
}

// ---- One envelope ----

/** The children of the given envelopes, by parent_id (an IN query per 30 parents). */
async function childrenOf(runtime, parentIds) {
  if (parentIds.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < parentIds.length; i += IN_CHUNK) chunks.push(parentIds.slice(i, i + IN_CHUNK));
  const pages = await Promise.all(chunks.map((ids) => guarded(runtime, 'work: children query', () => runtime.db.query('', runtime.collections.work, [
    ids.length === 1
      ? { field: 'parent_id', op: 'EQUAL', value: { stringValue: ids[0] } }
      : { field: 'parent_id', op: 'IN', value: { arrayValue: { values: ids.map((id) => ({ stringValue: id })) } } },
  ], { noOrderBy: true, limit: CHILD_LIMIT, strict: true }))));
  return pages.flat();
}

/** The envelope's step history, oldest first: the newest HISTORY_LIMIT records. */
async function historyOf(runtime, id) {
  const docs = await guarded(runtime, `work: history of ${id}`, () => runtime.db.query(`${runtime.collections.work}/${id}`, SUBCOLLECTIONS.workHistory, [], {
    orderBy: 'seq', orderDirection: 'DESCENDING', limit: HISTORY_LIMIT, strict: true,
  }));
  return {
    entries: docs.reverse().map((h) => ({
      id: h.id,
      at: h.timestamp || (Number.isFinite(h.seq) ? new Date(h.seq).toISOString() : null),
      from: h.prev_status ?? null,
      to: h.new_status ?? null,
      by: h.agent || null,
      detail: text(h.detail, 1000),
    })),
    truncated: docs.length >= HISTORY_LIMIT,
  };
}

const VERIFY_LINE = /^Step (\d+)\.verify \([^)]*\): (SUCCESS|FAILED) — (.*)$/gm;
const VERDICT_PREFIX = /^\[(?:CHECKPOINT VERIFICATION (?:FAILED|INCONCLUSIVE)|MILESTONE MET — WITH CAVEAT)\]\s*/;

/** The verifier's own words for checkpoint `n`, from the checkpoint's digest; '' when absent. */
function verifierSummary(cp, n) {
  let found = '';
  for (const m of String(cp._cp_digest || '').matchAll(VERIFY_LINE)) {
    if (Number(m[1]) === n) found = m[3].replace(VERDICT_PREFIX, '').trim();
  }
  return found;
}

/**
 * The verifier's verdict on one checkpoint, read back from what the checkpoint executor recorded.
 *
 *   met              the milestone passed verification
 *   met_with_caveat  it passed, with caveats the person should see
 *   not_met          the verifier judged it and it failed
 *   inconclusive     the verifier could not judge it (the work was not judged wrong)
 *   not_judged       a task failed, so the milestone was never put to the verifier
 *   skipped          no tasks were left to run (a resumed plan), so nothing new was judged
 *   pending          not judged yet
 *   none             it ended without a verdict (cancelled, timed out)
 *
 * @param {object} cp       the checkpoint envelope
 * @param {object} mission  its mission, for `_milestone_caveats`
 * @returns {{verdict: string, summary: string, caveats: string[]}}
 */
export function checkpointVerdict(cp, mission) {
  const n = cp?.source_meta?.checkpoint;
  const outcome = outcomeOf(cp);
  const output = String(cp?.output || '');
  const summary = Number.isInteger(n) ? verifierSummary(cp, n) : '';
  if (outcome === 'complete') {
    if (/^Skipped\b/.test(output)) return { verdict: 'skipped', summary: '', caveats: [] };
    const tag = `CP${n}: `;
    const caveats = (Array.isArray(mission?._milestone_caveats) ? mission._milestone_caveats : [])
      .filter((c) => typeof c === 'string' && c.startsWith(tag))
      .map((c) => c.slice(tag.length));
    return caveats.length > 0
      ? { verdict: 'met_with_caveat', summary, caveats }
      : { verdict: 'met', summary: '', caveats: [] };
  }
  if (outcome === 'failed') {
    if (!/milestone verification not passed/i.test(output)) return { verdict: 'not_judged', summary: output, caveats: [] };
    return { verdict: cp.needs_review === true ? 'inconclusive' : 'not_met', summary, caveats: [] };
  }
  if (OPEN_STATUSES.includes(outcome)) return { verdict: 'pending', summary: '', caveats: [] };
  return { verdict: 'none', summary: '', caveats: [] };
}

/** A checkpoint, task or message as a node of the tree. */
function nodeOf(env) {
  const meta = env.source_meta || {};
  return {
    id: env.id,
    type: env.type,
    title: titleOf(env),
    instruction: text(env.instruction, TEXT.childInstruction),
    status: env.status,
    outcome: outcomeOf(env),
    archived: env.status === 'archived',
    intent: env.intent || null,
    organ: typeof meta.agent === 'string' ? meta.agent : null,
    step: Number.isInteger(meta.task_step) ? meta.task_step : null,
    checkpoint: Number.isInteger(meta.checkpoint) ? meta.checkpoint : null,
    approval_id: typeof meta.approval_id === 'string' ? meta.approval_id : null,
    approval_step: Number.isInteger(meta.approval_task_index) ? meta.approval_task_index + 1 : null,
    accept_criteria: text(env.accept_criteria, TEXT.childInstruction) || null,
    output: clipText(env.output, TEXT.childOutput),
    error: text(env.error, TEXT.childInstruction) || null,
    needs_review: env.needs_review === true,
    created_at: env.created_at || null,
    started_at: env.started_at || null,
    completed_at: env.completed_at || null,
  };
}

const byCreated = (a, b) => instant(a.created_at) - instant(b.created_at) || (a.id < b.id ? -1 : 1);
const byStep = (a, b) => (a.source_meta?.task_step ?? Infinity) - (b.source_meta?.task_step ?? Infinity) || byCreated(a, b);
const isPlanCheckpoint = (env) => env.type === 'C' && Number.isInteger(env.source_meta?.checkpoint);

/**
 * The mission's plan: one entry per checkpoint number, from the checkpoint spine (which knows the
 * checkpoints not started yet) and the checkpoint envelopes (one per attempt), each attempt with its
 * verdict and its tasks.
 */
function planOf(mission, children, grandchildren) {
  const spine = Array.isArray(mission._cp_spine) ? mission._cp_spine.filter((s) => s && Number.isInteger(s.n)) : [];
  const tasksOf = new Map();
  for (const t of grandchildren) {
    if (!tasksOf.has(t.parent_id)) tasksOf.set(t.parent_id, []);
    tasksOf.get(t.parent_id).push(t);
  }
  const attemptsOf = new Map();
  for (const cp of children.filter(isPlanCheckpoint).sort(byCreated)) {
    const n = cp.source_meta.checkpoint;
    if (!attemptsOf.has(n)) attemptsOf.set(n, []);
    attemptsOf.get(n).push(cp);
  }
  const numbers = [...new Set([...spine.map((s) => s.n), ...attemptsOf.keys()])].sort((a, b) => a - b);
  const total = Math.max(spine.length, ...children.filter(isPlanCheckpoint).map((cp) => cp.source_meta.checkpoint_total || 0), 0);
  return numbers.map((n) => {
    const entry = spine.find((s) => s.n === n) || null;
    const attempts = (attemptsOf.get(n) || []).map((cp) => ({
      ...nodeOf(cp),
      verdict: checkpointVerdict(cp, mission),
      tasks: (tasksOf.get(cp.id) || []).sort(byStep).map(nodeOf),
    }));
    const latest = attempts[attempts.length - 1] || null;
    return {
      n,
      total: total || null,
      outcome: text(entry?.outcome || latest?.instruction || '', TEXT.childInstruction),
      accept_criteria: text(entry?.accept_criteria ?? latest?.accept_criteria ?? '', TEXT.childInstruction) || null,
      spine_status: entry?.status || null,
      planned_tasks: Array.isArray(entry?.tasks)
        ? entry.tasks.map((t) => ({ organ: typeof t?.agent === 'string' ? t.agent : null, text: text(t?.task || t?.instruction || '', 300), gate: (t?.step_type || t?._step_type || t?.type) === 'approval_gate' }))
        : [],
      attempts,
    };
  });
}

/**
 * What the agent sent the person about the mission: acknowledgments and other replies the brain wrote
 * as a checkpoint-and-task pair, and notifications (approval requests, pauses, status notes) written
 * as tasks directly under the mission. Oldest first.
 */
function messagesOf(children, grandchildren) {
  const out = [];
  for (const child of children) {
    if (child.type === 'T') out.push(child);
    else if (child.type === 'C' && !isPlanCheckpoint(child)) out.push(...grandchildren.filter((t) => t.parent_id === child.id));
  }
  return out.sort(byCreated).map((t) => ({
    id: t.id,
    title: titleOf(t),
    intent: t.intent || null,
    kind: t.source_meta?.notification_type || t.intent || null,
    text: clipText(t.output, TEXT.message),
    created_at: t.created_at || null,
    delivery_status: t.delivery_status || null,
    delivered_at: t.delivered_at || null,
    delivery_error: text(t.delivery_error, TEXT.short) || null,
  }));
}

/** What the envelope waits for, if it waits: an approval, an answer, a cleared blocker, or a timer. */
function waitingOf(env, approvals) {
  switch (env.status) {
    case 'awaiting_approval': {
      const gateId = env.source_meta?.paused_approval_id || env.source_meta?.approval_id || null;
      const approval = approvals.find((a) => a.id === gateId) || approvals.filter((a) => a.status === 'pending').pop() || null;
      return { kind: 'approval', approval_id: gateId, approval, since: env.updated_at || null };
    }
    case 'needs_input':
      return { kind: 'question', text: clipText(env.output, TEXT.message), since: env.updated_at || null };
    case 'blocked':
      return {
        kind: 'blocked',
        text: clipText(env.output || env.blocker, TEXT.message),
        blocker: text(env.blocker, TEXT.message) || null,
        blocker_type: env.blocker_type || null,
        since: env.blocked_at || env.updated_at || null,
      };
    case 'waiting':
      return { kind: 'timer', until: env.wait_resume_at || null, then: text(env.resume_instruction, TEXT.message) || null, since: env.updated_at || null };
    case 'needs_review':
      return { kind: 'review', text: clipText(env.review_reason || env.output, TEXT.message), since: env.updated_at || null };
    default:
      return null;
  }
}

/** The step ledger, the claim and the resume state: how the brain is keeping its place. */
function internalsOf(env) {
  const progress = env._cp_progress && typeof env._cp_progress === 'object' ? env._cp_progress : null;
  const ledger = env.step_ledger && typeof env.step_ledger === 'object' ? env.step_ledger : {};
  return {
    claimed_by: env.claimed_by || null,
    claimed_at: Number.isFinite(env.claimed_at_ms) && env.claimed_at_ms > 0 ? new Date(env.claimed_at_ms).toISOString() : null,
    iteration: Number.isInteger(env.iteration) ? env.iteration : 0,
    replans: Number.isInteger(env._replan_count) ? env._replan_count : 0,
    resume: progress ? {
      checkpoint: Number.isInteger(progress.checkpointIndex) ? progress.checkpointIndex + 1 : null,
      task: Number.isInteger(progress.taskIndex) ? progress.taskIndex + 1 : null,
      results: Array.isArray(progress.allResults) ? progress.allResults.length : 0,
    } : null,
    steps: Object.entries(ledger)
      .filter(([, entry]) => entry && typeof entry === 'object')
      .map(([key, entry]) => ({
        key,
        status: entry.status || null,
        checkpoint: Number.isInteger(entry.cp) ? entry.cp : null,
        duration_ms: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
        at: entry.timestamp || null,
        error: text(entry.error, TEXT.short) || null,
        ref: entry.ref || null,
      }))
      .sort((a, b) => instant(a.at) - instant(b.at)),
    platform_version: env.platform_version || null,
  };
}

/** The envelope asked for, in full. */
function detailOf(env) {
  return {
    ...missionSummary(env),
    instruction: text(env.instruction, TEXT.ownInstruction),
    request: text(env.source_text, TEXT.ownInstruction) || null,
    accept_criteria: text(env.accept_criteria, TEXT.ownInstruction) || null,
    output: clipText(env.output, TEXT.ownOutput),
    error: text(env.error, TEXT.ownInstruction) || null,
    job_to_be_done: text(env.job_to_be_done, TEXT.short) || null,
    review_reason: text(env.review_reason, TEXT.short) || null,
    milestone_caveats: (Array.isArray(env._milestone_caveats) ? env._milestone_caveats : []).map((c) => text(c, TEXT.message)),
    organ: typeof env.source_meta?.agent === 'string' ? env.source_meta.agent : null,
    checkpoint: Number.isInteger(env.source_meta?.checkpoint) ? env.source_meta.checkpoint : null,
    checkpoint_total: Number.isInteger(env.source_meta?.checkpoint_total) ? env.source_meta.checkpoint_total : null,
    step: Number.isInteger(env.source_meta?.task_step) ? env.source_meta.task_step : null,
    thread: env.source_meta?.address?.thread || null,
    blocker: text(env.blocker, TEXT.message) || null,
    blocker_type: env.blocker_type || null,
    blocked_at: env.blocked_at || null,
    resume_instruction: text(env.resume_instruction, TEXT.message) || null,
    cancelled_at: env.cancelled_at || null,
    cancelled_reason: text(env.cancelled_reason, TEXT.short) || null,
    archived_reason: env.archived_reason || null,
    delivery_status: env.delivery_status || null,
    delivered_at: env.delivered_at || null,
    delivered_channel: env.delivered_channel || null,
    delivery_error: text(env.delivery_error, TEXT.short) || null,
    settled: isSettled(env),
    internals: internalsOf(env),
  };
}

const parentBrief = (id, env) => (env ? { id, type: env.type || null, title: titleOf({ ...env, id }), status: env.status || null, outcome: outcomeOf(env) } : null);

/**
 * One envelope's detail. A mission comes with its plan (checkpoints, verdicts, tasks), its messages
 * and its approval gates; a checkpoint with its verdict and tasks; any envelope with its parent, its
 * children, its step history and what it waits for.
 *
 * @param {object} runtime
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getWork(runtime, id) {
  const workId = checkDocId(id, 'work id');
  const col = runtime.collections.work;
  const found = await guarded(runtime, `work: read ${workId}`, () => runtime.db.read(`${col}/${workId}`, { strict: true }));
  if (!found) throw new HttpError(404, 'there is no such work');
  const env = { ...found, id: workId };

  const parentId = typeof env.parent_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(env.parent_id) ? env.parent_id : null;
  const [parent, children, history, approvals] = await Promise.all([
    parentId ? guarded(runtime, `work: read ${parentId}`, () => runtime.db.read(`${col}/${parentId}`, { strict: true })) : null,
    childrenOf(runtime, [workId]),
    historyOf(runtime, workId),
    env.type === 'M' ? approvalsForMission(runtime, env) : [],
  ]);
  const grandchildren = env.type === 'M' ? await childrenOf(runtime, children.filter((c) => c.type === 'C').map((c) => c.id)) : [];

  return {
    envelope: detailOf(env),
    parent: parentBrief(parentId, parent),
    plan: env.type === 'M' ? planOf(env, children, grandchildren) : null,
    messages: env.type === 'M' ? messagesOf(children, grandchildren) : [],
    children: env.type === 'M' ? [] : [...children].sort(env.type === 'C' ? byStep : byCreated).map(nodeOf),
    verdict: env.type === 'C' ? checkpointVerdict(env, parent) : null,
    approvals,
    history: history.entries,
    history_truncated: history.truncated,
    waiting: waitingOf(env, approvals),
  };
}
