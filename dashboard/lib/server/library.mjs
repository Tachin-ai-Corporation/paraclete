// dashboard/lib/server/library.mjs: what the agent knows how to do and what it works within, as the
// Library page shows it: its process playbooks (the root `processes` collection), its projects (the
// root `projects` collection), and the "run now" triggers a dashboard admin starts. Read-only: the
// agent writes playbooks and projects with its own commands (agent/cli/process-ops.mjs,
// project-manage.mjs), and the brain's projects registry writes promotion candidates
// (agent/work/projects.mjs). The responsibilities themselves come from the VM through the
// `responsibilities` command, because the list the scheduler runs merges installed files the
// dashboard cannot see.
//
// Shapes, as the agent writes them:
//   processes/{id}            { id, name, description, narrative, status: 'active' | 'deprecated',
//                               version?, intent_keywords?, scope?: { project_id, tags }, updated_by,
//                               updated_at, created_at }
//   processes/{id}/revisions/{r}   earlier versions of a playbook (declared in
//                               agent/storage/collections.mjs; read as whatever fields they carry)
//   projects/{id}             { id, name, description, goal, status: 'active' | 'complete' | 'paused' |
//                               'archived', parent_id, depends_on[], context: { <key>: { kind, ref?,
//                               url?, name?, summary?, updatedAt?, updatedBy? } }, canon?: { authority[],
//                               entries: [{ key, text, updated_at, updated_by }] }, standardProcesses?[],
//                               deploy?, auto_complete?, created_by, created_at, updated_at,
//                               completed_at? }
//   projects/{id}/promotions/{p}  { key, entry, source_mission_id, suggested_at, status: 'pending' }
//   responsibility_triggers/{command id}  { responsibility_id, status: 'pending' | 'firing' | 'fired' |
//                               'skipped' | 'error', bypass_spacing, requested_by, requested_at,
//                               command_id, claimed_at?, detail?, fired_at? }
//
// Only what is stored in Firestore is here. The installed playbooks of the role packages are files on
// the VM; a stored playbook with the same id overrides one, and the rest are not in the collection.

import { SUBCOLLECTIONS } from '../../../agent/storage/collections.mjs';
import { normalizeDeployDescriptor } from '../../../agent/work/deploy-target.mjs';
import { HttpError } from './errors.mjs';

/** The most documents one listing reads, as the agent's own registries do. */
export const LIBRARY_LIMIT = 300;
const SUBCOLLECTION_LIMIT = 200;

/** A trigger's statuses once the brain has handled it. */
export const TRIGGER_FINISHED = Object.freeze(['fired', 'skipped', 'error']);

const PROJECT_STATUS_ORDER = ['active', 'paused', 'complete', 'archived'];

// A stored document id the dashboard will look up: letters, digits, dots, dashes and underscores,
// starting with a letter or digit (so never '.', '..' or a reserved __name__). The agent's own ids are
// narrower (lowercase kebab-case); this also opens an older record written another way.
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const COMMAND_ID = /^[A-Za-z0-9]{1,64}$/;

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strings = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x !== 'object').map(String) : []);
const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const instant = (v) => {
  const at = Date.parse(v);
  return Number.isFinite(at) ? at : -Infinity;
};
const newestFirst = (field) => (a, b) => instant(b[field]) - instant(a[field]);

function checkDocId(id, what) {
  if (typeof id !== 'string' || !DOC_ID.test(id)) throw new HttpError(400, `'${text(id)}' is not a ${what} id`);
}

// ---- Process playbooks ----

function processSummary(doc) {
  const scope = isMap(doc.scope) ? { project_id: text(doc.scope.project_id) || null, tags: strings(doc.scope.tags) } : null;
  return {
    id: doc.id,
    name: text(doc.name) || doc.id,
    description: text(doc.description),
    status: text(doc.status) || 'active',
    version: typeof doc.version === 'number' ? doc.version : null,
    intent_keywords: strings(doc.intent_keywords),
    scope,
    has_narrative: Boolean(text(doc.narrative).trim()),
    updated_by: text(doc.updated_by) || null,
    updated_at: doc.updated_at ?? null,
    created_at: doc.created_at ?? null,
  };
}

function revisionShape(doc) {
  const number = typeof doc.revision === 'number' ? doc.revision : typeof doc.version === 'number' ? doc.version : null;
  return {
    id: doc.id,
    revision: number,
    name: text(doc.name) || null,
    description: text(doc.description) || null,
    narrative: text(doc.narrative) || null,
    status: text(doc.status) || null,
    updated_by: text(doc.updated_by) || null,
    updated_at: doc.updated_at ?? null,
  };
}

/** Highest revision number first; without numbers, newest first. */
function byRevision(a, b) {
  if (a.revision !== null && b.revision !== null && a.revision !== b.revision) return b.revision - a.revision;
  return instant(b.updated_at) - instant(a.updated_at);
}

/**
 * The stored process playbooks: active first, then by name.
 *
 * @param {object} runtime
 * @returns {Promise<{processes: object[], limited: boolean}>}
 */
export async function listProcesses(runtime) {
  const docs = await runtime.db.query('', runtime.collections.processes, [], { noOrderBy: true, limit: LIBRARY_LIMIT, strict: true });
  const processes = docs.map(processSummary).sort((a, b) => {
    const rank = (p) => (p.status === 'deprecated' ? 1 : 0);
    return (rank(a) - rank(b)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
  return { processes, limited: docs.length >= LIBRARY_LIMIT };
}

/**
 * One stored playbook with its narrative and its earlier versions, newest first.
 *
 * @param {object} runtime
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getProcess(runtime, id) {
  checkDocId(id, 'playbook');
  const path = `${runtime.collections.processes}/${id}`;
  const doc = await runtime.db.read(path, { strict: true });
  if (!doc) {
    throw new HttpError(404, `there is no stored playbook '${id}': it may be one of the role's installed playbooks, which are stored only once changed`);
  }
  const revisions = await runtime.db.query(path, SUBCOLLECTIONS.processRevisions, [], {
    noOrderBy: true, limit: SUBCOLLECTION_LIMIT, strict: true,
  });
  return {
    ...processSummary({ ...doc, id }),
    narrative: text(doc.narrative),
    revisions: revisions.map(revisionShape).sort(byRevision),
  };
}

// ---- Projects ----

function projectSummary(doc) {
  const canon = isMap(doc.canon) ? doc.canon : {};
  return {
    id: doc.id,
    name: text(doc.name) || doc.id,
    description: text(doc.description),
    goal: text(doc.goal),
    status: text(doc.status) || 'active',
    parent_id: text(doc.parent_id) || null,
    depends_on: strings(doc.depends_on),
    auto_complete: doc.auto_complete === true,
    context_count: isMap(doc.context) ? Object.keys(doc.context).length : 0,
    canon_count: Array.isArray(canon.entries) ? canon.entries.length : 0,
    created_by: text(doc.created_by) || null,
    created_at: doc.created_at ?? null,
    updated_at: doc.updated_at ?? null,
    completed_at: doc.completed_at ?? null,
  };
}

/** One context entry: a resource packet, or a value written before packets existed. */
function contextEntry(key, value) {
  if (isMap(value) && (value.kind || value.ref || value.url || value.summary)) {
    return {
      key,
      kind: text(value.kind) || null,
      name: text(value.name) || null,
      ref: text(value.ref) || null,
      url: text(value.url) || null,
      summary: text(value.summary) || null,
      updated_at: value.updatedAt ?? value.updated_at ?? null,
      updated_by: text(value.updatedBy ?? value.updated_by) || null,
      value: null,
    };
  }
  return {
    key, kind: null, name: null, ref: null, url: null, summary: null, updated_at: null, updated_by: null,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  };
}

function canonShape(raw) {
  const canon = isMap(raw) ? raw : {};
  return {
    authority: strings(canon.authority),
    entries: (Array.isArray(canon.entries) ? canon.entries : [])
      .filter(isMap)
      .map((e) => ({ key: text(e.key), text: text(e.text), updated_at: e.updated_at ?? null, updated_by: text(e.updated_by) || null })),
  };
}

function promotionShape(doc) {
  const entry = isMap(doc.entry) ? doc.entry : {};
  return {
    id: doc.id,
    key: text(doc.key),
    kind: text(entry.kind) || null,
    name: text(entry.name) || null,
    ref: text(entry.ref) || null,
    url: text(entry.url) || null,
    summary: text(entry.summary) || null,
    source_mission_id: text(doc.source_mission_id) || null,
    suggested_at: doc.suggested_at ?? null,
    status: text(doc.status) || 'pending',
  };
}

/**
 * Every stored project, archived ones included: by status (active, paused, complete, archived),
 * then by name. The page builds the parent and child tree from `parent_id`.
 *
 * @param {object} runtime
 * @returns {Promise<{projects: object[], limited: boolean}>}
 */
export async function listProjects(runtime) {
  const docs = await runtime.db.query('', runtime.collections.projects, [], { noOrderBy: true, limit: LIBRARY_LIMIT, strict: true });
  const rank = (p) => {
    const i = PROJECT_STATUS_ORDER.indexOf(p.status);
    return i === -1 ? PROJECT_STATUS_ORDER.length : i;
  };
  const projects = docs.map(projectSummary).sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { projects, limited: docs.length >= LIBRARY_LIMIT };
}

/**
 * One project: its summary, context entries (by key), canon, linked playbooks, deploy target, and the
 * context its missions suggested (pending first, then newest).
 *
 * @param {object} runtime
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getProject(runtime, id) {
  checkDocId(id, 'project');
  const path = `${runtime.collections.projects}/${id}`;
  const doc = await runtime.db.read(path, { strict: true });
  if (!doc) throw new HttpError(404, `there is no project '${id}'`);
  const promotions = await runtime.db.query(path, SUBCOLLECTIONS.projectPromotions, [], {
    noOrderBy: true, limit: SUBCOLLECTION_LIMIT, strict: true,
  });
  const pendingFirst = (a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1);
  return {
    ...projectSummary({ ...doc, id }),
    context: Object.entries(isMap(doc.context) ? doc.context : {})
      .map(([key, value]) => contextEntry(key, value))
      .sort((a, b) => a.key.localeCompare(b.key)),
    canon: canonShape(doc.canon),
    standard_processes: strings(doc.standardProcesses),
    deploy: normalizeDeployDescriptor(doc.deploy),
    promotions: promotions.map(promotionShape).sort((a, b) => pendingFirst(a, b) || newestFirst('suggested_at')(a, b)),
  };
}

// ---- "Run now" triggers ----

/**
 * One "run now" trigger, as the brain's scheduler left it. The run_responsibility command names it
 * by `trigger_id` (the command's own id); the page follows it until the brain fires it, skips it, or
 * fails it.
 *
 * @param {object} runtime
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function readTrigger(runtime, id) {
  if (!COMMAND_ID.test(text(id))) throw new HttpError(400, 'not a trigger id');
  const doc = await runtime.db.read(`${runtime.collections.responsibilityTriggers}/${id}`, { strict: true });
  if (!doc) throw new HttpError(404, 'no such trigger');
  const status = text(doc.status) || 'pending';
  return {
    id,
    responsibility_id: text(doc.responsibility_id) || null,
    status,
    finished: TRIGGER_FINISHED.includes(status),
    detail: text(doc.detail) || null,
    requested_by: text(doc.requested_by) || null,
    requested_at: doc.requested_at ?? null,
    claimed_at: doc.claimed_at ?? null,
    fired_at: doc.fired_at ?? null,
  };
}
