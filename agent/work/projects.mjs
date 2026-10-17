// agent/work/projects.mjs: the agent's project registry. Loads the root `projects` collection, keeps
// the parent-child index, renders a project's context for the agent's prompts (context packets,
// canon, deploy target, shared Drive folder), gates missions on their dependencies (depends_on),
// completes a project when its work is done, and promotes durable context from a finished mission
// to its project. What a project's context may hold is decided by project-context.mjs, and the
// deploy target's shape by deploy-target.mjs. Used by the brain and the scheduler (the default
// project).

import { COLLECTIONS, SUBCOLLECTIONS } from '../storage/collections.mjs';
import { firestoreEncode, StoreConflict } from '../storage/firestore.mjs';
import { withCanonicalId } from '../storage/entity-id.mjs';
import { validateContextEntry } from './project-context.mjs';
import { renderDeployBlock } from './deploy-target.mjs';
import { ENVELOPE_STATUSES, TERMINAL_STATUSES } from './work-schema.mjs';

/** The project work goes to when it names no other. Created on first start. */
export const DEFAULT_PROJECT_ID = 'general';

const DEFAULT_REFRESH_MS = 60_000; // default; callers pass the contracts value
const DEFAULT_MAX_DEPTH = 4; // default; callers pass the contracts value
const QUERY_LIMIT = 300;

/** Mission statuses that still hold a project open. */
const OPEN_STATUSES = ENVELOPE_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

// Mission-scoped working structures that are never project context and must not be reported as
// promotion failures on every mission. The resource ledger is the clear case: a name-to-id map the
// mission builds as it works, holding converted temporary docs and one-off file ids. Its durable
// path is memory, not the project.
const NOT_PROJECT_CONTEXT = new Set(['resources']);

/** Two context packets merged by key; the child wins a collision. */
function mergeContextPackets(parentCtx, childCtx) {
  return { ...(parentCtx || {}), ...(childCtx || {}) };
}

/**
 * A context packet as text for the agent's prompt. Handles rich entries (kind, ref, summary) and
 * plain values.
 */
function renderContextPacket(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines = [];
  for (const [key, entry] of Object.entries(ctx)) {
    if (!entry) continue;
    if (typeof entry === 'object' && (entry.kind || entry.summary)) {
      lines.push(`${key} (${entry.kind || 'unknown'}): ${entry.name || key}`);
      const details = [];
      if (entry.ref) details.push(`ID: ${entry.ref}`);
      if (entry.url) details.push(`URL: ${entry.url}`);
      if (entry.updatedAt) {
        const dateStr = typeof entry.updatedAt === 'string' ? entry.updatedAt.substring(0, 10) : '';
        details.push(`Updated: ${dateStr}${entry.updatedBy ? ` by ${entry.updatedBy}` : ''}`);
      }
      if (details.length > 0) lines.push(`  ${details.join(' | ')}`);
      if (entry.summary) lines.push(`  ${entry.summary}`);
    } else if (Array.isArray(entry)) {
      if (entry.every((v) => v === null || typeof v !== 'object')) lines.push(`${key}: ${entry.join(', ')}`);
    } else if (typeof entry !== 'object') {
      lines.push(`${key}: ${String(entry)}`);
    }
    // Any other object is the mission's working state (resources, git bookkeeping), not context.
  }
  return lines.join('\n');
}

const fileLine = (f) => `- ${f.name} — ${f.url || `driveId: ${f.driveId}`}`;

/**
 * Creates the project registry.
 *
 * @param {object}   deps
 * @param {object}   deps.db              - a client from agent/storage/firestore.mjs
 * @param {Function} [deps.logger]        - (level, msg) => void
 * @param {Function} [deps.generateId]    - (prefix) => id, for promotion candidates
 * @param {Function} [deps.writeHistory]  - async (envelopeId, prev, next, actor, detail) => void
 * @param {boolean}  [deps.promotionAuto] - promote mission context straight into the project instead of
 *                                          writing candidates for a person to approve
 * @param {number}   [deps.refreshMs]     - how long a load stays fresh for ensureLoaded()
 * @param {number}   [deps.maxDepth]      - deepest project nesting allowed
 * @param {Function} [deps.clock]         - () => ms (injectable for tests)
 * @returns {object} the registry API
 */
export function createProjectRegistry(deps) {
  const {
    db,
    generateId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    writeHistory,
    promotionAuto = false,
    refreshMs = DEFAULT_REFRESH_MS,
    maxDepth = DEFAULT_MAX_DEPTH,
    clock = Date.now,
  } = deps;
  const log = deps.logger || ((level, msg) => console.log(`[projects] ${level}: ${msg}`));
  const now = () => new Date(clock()).toISOString();
  const projectPath = (id) => `${COLLECTIONS.projects}/${id}`;

  // Every entry's `id` equals its key. Listings read ids from here, so none can come out blank.
  let projects = {};
  let children = {}; // parent_id -> [child ids]
  let defaultProjectId = null;
  let loadedAt = -Infinity;

  /**
   * Loads every project that is not archived. A failed read keeps the projects last loaded: an
   * outage must not read as "there are no projects", which would make ensureDefault() think the
   * default project is missing.
   */
  async function load() {
    let docs;
    try {
      docs = await db.query('', COLLECTIONS.projects, [], { noOrderBy: true, strict: true, limit: QUERY_LIMIT });
    } catch (e) {
      log('WARN', `Failed to load projects (${e.message}); keeping the ${Object.keys(projects).length} last loaded`);
      return;
    }
    const next = {};
    const childIndex = {};
    for (const doc of docs) {
      // The client takes each document's id from its path, so a project stored without `id` in its
      // body still loads under its document id. A record with no id at all cannot be listed.
      if (!doc.id) {
        log('WARN', 'A stored project has no id; skipped');
        continue;
      }
      if (doc.status === 'archived') continue;
      const p = withCanonicalId(doc.id, {
        ...doc,
        goal: doc.goal || '',
        parent_id: doc.parent_id || null,
        depends_on: Array.isArray(doc.depends_on) ? doc.depends_on : [],
        context: doc.context || null,
      });
      next[p.id] = p;
      if (p.parent_id) (childIndex[p.parent_id] ||= []).push(p.id);
    }
    projects = next;
    children = childIndex;
    loadedAt = clock();
    if (Object.keys(next).length > 0) log('INFO', `Projects loaded: ${Object.keys(next).join(', ')}`);
  }

  /** Loads when the last load is older than the refresh interval. */
  async function ensureLoaded() {
    if (clock() - loadedAt > refreshMs) await load();
  }

  /**
   * Makes sure the default project exists and returns its id. It is created only if absent, with a
   * create-only precondition: an earlier version wrote it whenever it was missing from the loaded
   * list, so a failed load overwrote the real default project, and its context, with a blank one.
   *
   * @returns {Promise<string>}
   */
  async function ensureDefault() {
    defaultProjectId = DEFAULT_PROJECT_ID;
    if (projects[DEFAULT_PROJECT_ID]) return DEFAULT_PROJECT_ID;
    const at = now();
    const doc = withCanonicalId(DEFAULT_PROJECT_ID, {
      name: 'General',
      goal: 'General workspace for unscoped work',
      description: 'The default project, for work that names no other project',
      status: 'active',
      parent_id: null,
      depends_on: [],
      created_by: 'agent',
      created_at: at,
      updated_at: at,
    });
    try {
      await db.commit([{ path: projectPath(DEFAULT_PROJECT_ID), data: doc, precondition: { exists: false } }]);
      log('INFO', `Default project created: ${DEFAULT_PROJECT_ID}`);
    } catch (e) {
      if (e instanceof StoreConflict) log('DEBUG', `Default project ${DEFAULT_PROJECT_ID} already exists`);
      else log('WARN', `Failed to create the default project: ${e.message}`);
    }
    await load();
    return DEFAULT_PROJECT_ID;
  }

  /**
   * The projects as a listing, sorted by id. Every entry carries its real id, so whoever reads the
   * listing never has to guess which project an entry means.
   *
   * @returns {Array<{id: string, name: string, status: string, description: string, parent_id: string|null}>}
   */
  function list() {
    return Object.keys(projects).sort().map((id) => {
      const p = projects[id];
      return {
        id,
        name: p.name || id,
        status: p.status || 'active',
        description: p.description || '',
        parent_id: p.parent_id || null,
      };
    });
  }

  /**
   * A project's context accumulated along its parent chain, root first; the most specific project
   * wins a key. Different from buildContext(), which renders text for a prompt.
   *
   * @param {string} projectId
   * @returns {{chain: Array<{id: string, name: string}>, context: object}}
   */
  function getAccumulatedContext(projectId) {
    const chain = [];
    let current = projectId;
    const visited = new Set();
    while (current && projects[current] && !visited.has(current)) {
      visited.add(current);
      chain.unshift(current);
      current = projects[current].parent_id;
    }
    const merged = { documentation: [], processes: [], configuration: {} };
    for (const pid of chain) {
      const ctx = projects[pid]?.context;
      if (!ctx) continue;
      if (ctx.documentation) merged.documentation = [...merged.documentation, ...ctx.documentation];
      if (ctx.processes) merged.processes = [...merged.processes, ...ctx.processes];
      if (ctx.configuration) merged.configuration = { ...merged.configuration, ...ctx.configuration };
    }
    return { chain: chain.map((id) => ({ id, name: projects[id]?.name || id })), context: merged };
  }

  /**
   * Refuses nesting a project deeper than maxDepth under `parentId`.
   *
   * @param {string} parentId
   * @returns {boolean} true when within the limit
   * @throws {Error} when the nesting would be too deep
   */
  function validateDepth(parentId) {
    let depth = 0;
    let current = parentId;
    const visited = new Set();
    while (current && projects[current] && !visited.has(current)) {
      visited.add(current);
      depth++;
      current = projects[current].parent_id;
    }
    if (depth >= maxDepth) throw new Error(`Project nesting depth exceeds maximum of ${maxDepth}`);
    return true;
  }

  /**
   * Completes a project that opted in (auto_complete) once its sub-projects, its missions and its
   * dependencies are all done, then checks its parent the same way. An active project is an ongoing
   * work stream: finishing its current missions does not mean it is done, so only opted-in projects
   * complete themselves.
   *
   * @param {string} projectId
   */
  async function checkCompletion(projectId) {
    const project = projects[projectId];
    if (!project || project.status !== 'active' || !project.auto_complete) return;
    try {
      for (const childId of children[projectId] || []) {
        const child = projects[childId];
        if (child && child.status !== 'complete' && child.status !== 'archived') return;
      }
      const open = await db.query('', COLLECTIONS.work, [
        { field: 'project_id', op: 'EQUAL', value: { stringValue: projectId } },
        { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
        { field: 'status', op: 'IN', value: { arrayValue: { values: OPEN_STATUSES.map((s) => ({ stringValue: s })) } } },
      ], { noOrderBy: true, strict: true, limit: 1 });
      if (open.length > 0) return;
      for (const depId of project.depends_on || []) {
        const dep = projects[depId];
        if (dep && dep.status !== 'complete' && dep.status !== 'archived') return;
      }

      log('INFO', `Project ${projectId}: all work complete, completing it`);
      const at = now();
      project.status = 'complete';
      project.updated_at = at;
      project.completed_at = at;
      await db.patch(projectPath(projectId), ['status', 'updated_at', 'completed_at'], firestoreEncode({
        status: 'complete', updated_at: at, completed_at: at,
      }), { strict: true });
      if (project.parent_id) await checkCompletion(project.parent_id);
    } catch (e) {
      log('WARN', `checkCompletion error for ${projectId}: ${e.message}`);
    }
  }

  /**
   * Whether `targetId` already depends, directly or not, on `sourceId`, so that adding it as a
   * dependency of `sourceId` would close a cycle.
   *
   * @param {string} sourceId
   * @param {string} targetId
   * @param {object} [envelopes] - id -> {depends_on}
   * @returns {boolean}
   */
  function hasCircularDep(sourceId, targetId, envelopes = {}) {
    const visited = new Set();
    const stack = [targetId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === sourceId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const env = envelopes[current];
      if (env && Array.isArray(env.depends_on)) stack.push(...env.depends_on);
    }
    return false;
  }

  /**
   * Gives a mission with no project the default project, loudly.
   *
   * @param {object} envelope
   * @returns {object} the same envelope
   */
  function validateMissionProject(envelope) {
    if (envelope.type === 'M' && !envelope.project_id) {
      log('WARN', `Mission ${envelope.id} missing project_id; assigning the default`);
      envelope.project_id = defaultProjectId;
    }
    return envelope;
  }

  /**
   * A project's context for the agent's prompt: description, canon, deploy target, context packets
   * (the envelope's merged over the project's) and its shared Drive folder.
   *
   * @param {string} projectId
   * @param {object} [envelopeContext] - context packets from the envelope; they win a key
   * @returns {string|null} null when the project is unknown or has nothing to say
   */
  function buildContext(projectId, envelopeContext = null) {
    const p = projectId ? projects[projectId] : null;
    if (!p) return null;
    const mergedCtx = mergeContextPackets(p.context, envelopeContext);

    const header = [`## Project Context: ${p.name || p.id} (${p.id})`];
    if (p.description) header.push(`Description: ${p.description}`);

    // Canon first: authoritative facts that override all other context.
    const canon = p.canon?.entries || [];
    if (canon.length > 0) {
      header.push('');
      header.push('### ⚠️ CANON (Authoritative Project Facts — Do NOT Contradict)');
      for (const entry of canon) {
        if (entry.key && entry.text) header.push(`- **${entry.key}**: ${entry.text}`);
      }
    }

    // The deploy target is a top-level field, not a context packet, so its structured fields
    // survive: the agent reads the site from here instead of inferring it from the project's name.
    const deployBlock = renderDeployBlock(p.deploy);
    if (deployBlock) {
      header.push('');
      header.push(deployBlock);
    }
    header.push('');

    const rendered = renderContextPacket(mergedCtx);
    if (!rendered && !p.description && canon.length === 0 && !deployBlock) return null;
    let result = header.join('\n') + rendered;

    const driveFolder = mergedCtx.drive_folder;
    const files = mergedCtx.artifacts?.files || [];
    if (driveFolder?.ref) {
      const folderUrl = driveFolder.url || `https://drive.google.com/drive/folders/${driveFolder.ref}`;
      const lines = ['\n\n## Shared Workspace (Google Drive)'];
      lines.push(`📁 **Shared Workspace**: ${folderUrl}`);
      lines.push(`📂 **Folder ID**: \`${driveFolder.ref}\``);
      lines.push('');
      lines.push('This Drive folder is the **persistent shared workspace** for this project.');
      lines.push('Read the files you need from it, work on them locally, and publish results back into it with the drive skill.');
      if (files.length > 0) {
        lines.push('');
        lines.push('**Existing files from prior work:**');
        lines.push(...files.map(fileLine));
      }
      result += lines.join('\n');
    } else if (files.length > 0) {
      const lines = ['\n\n## Project Artifacts (Google Drive)'];
      if (mergedCtx.artifacts.drive_url) lines.push(`📁 Project folder: ${mergedCtx.artifacts.drive_url}`);
      lines.push('');
      lines.push('Prior work has produced these artifacts:');
      lines.push(...files.map(fileLine));
      lines.push('');
      lines.push('To use a prior artifact, fetch it with the drive skill.');
      result += lines.join('\n');
    }
    return result;
  }

  // ---- Dependencies ----

  /**
   * Whether every envelope in `envelope.depends_on` is complete or archived. A dependency that is
   * not found does not block, and a read failure fails open: a mission held forever by an outage is
   * worse than one that starts early.
   *
   * @param {object} envelope
   * @returns {Promise<boolean>}
   */
  async function checkDependencies(envelope) {
    const deps_ = envelope.depends_on;
    if (!Array.isArray(deps_) || deps_.length === 0) return true;
    try {
      for (const depId of deps_) {
        const dep = await db.read(`${COLLECTIONS.work}/${depId}`);
        if (!dep) continue;
        if (dep.status !== 'complete' && dep.status !== 'archived') return false;
      }
      return true;
    } catch (e) {
      log('WARN', `checkDependencies error: ${e.message}`);
      return true;
    }
  }

  /**
   * Activates the pending missions that were waiting on a mission that just completed, once all of
   * their dependencies are met.
   *
   * @param {string} completedMissionId
   */
  async function activateDependents(completedMissionId) {
    try {
      const waiting = await db.query('', COLLECTIONS.work, [
        { field: 'depends_on', op: 'ARRAY_CONTAINS', value: { stringValue: completedMissionId } },
        { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
      ], { noOrderBy: true, strict: true, limit: QUERY_LIMIT });
      for (const env of waiting) {
        if (env.type !== 'M') continue;
        if (!(await checkDependencies(env))) continue;
        log('INFO', `Dependency met: activating mission ${env.id} (was waiting on ${completedMissionId})`);
        const at = now();
        env.status = 'active';
        env.started_at = at;
        env.updated_at = at;
        await db.write(`${COLLECTIONS.work}/${env.id}`, env);
        if (writeHistory) await writeHistory(env.id, 'pending', 'active', 'brain', 'Dependencies cleared — auto-activated');
      }
    } catch (e) {
      log('WARN', `activateDependents error: ${e.message}`);
    }
  }

  // ---- Context promotion ----

  /**
   * Offers a finished mission's new context entries to its project. Each entry passes the
   * project-context validator first: a mission's context accumulates working notes, and only durable
   * resource references belong in a project. With promotionAuto the entries merge straight into the
   * project; otherwise they are written as candidates for a person to approve in the dashboard.
   *
   * @param {object} envelope - the completed mission
   */
  async function suggestContextPromotions(envelope) {
    if (!envelope.project_id || !envelope.context) return;
    try {
      const project = projects[envelope.project_id];
      if (!project) return;
      const projectContext = project.context || {};

      const newEntries = {};
      for (const [key, entry] of Object.entries(envelope.context || {})) {
        if (projectContext[key] || NOT_PROJECT_CONTEXT.has(key)) continue;
        const { ok, reason } = validateContextEntry(key, entry);
        if (!ok) { log('INFO', `Context promotion: skipped '${key}': ${reason}`); continue; }
        newEntries[key] = entry;
      }
      const count = Object.keys(newEntries).length;
      if (count === 0) return;
      log('INFO', `Context promotion: ${count} new entries from mission ${envelope.id} for project ${envelope.project_id}`);

      if (promotionAuto) {
        // The whole merged map is written with every field of every entry: an earlier encoder kept
        // only kind, ref, name and summary, so each promotion stripped the URLs and update stamps
        // from the project's existing entries.
        const merged = mergeContextPackets(projectContext, newEntries);
        await db.patch(projectPath(envelope.project_id), ['context'], firestoreEncode({ context: merged }), { strict: true });
        project.context = merged;
        log('INFO', `Auto-promoted ${count} context entries to project ${envelope.project_id}`);
      } else {
        for (const [key, entry] of Object.entries(newEntries)) {
          const promoId = generateId('promo');
          await db.write(`${projectPath(envelope.project_id)}/${SUBCOLLECTIONS.projectPromotions}/${promoId}`, {
            key,
            entry,
            source_mission_id: envelope.id,
            suggested_at: now(),
            status: 'pending',
          });
        }
        log('INFO', `Wrote ${count} promotion candidates for project ${envelope.project_id}`);
      }
    } catch (e) {
      log('WARN', `Context promotion error: ${e.message}`);
    }
  }

  return {
    /** Load every project from Firestore. */
    load,
    /** Load if the last load is stale. */
    ensureLoaded,
    /** Make sure the default project exists; returns its id. */
    ensureDefault,
    /** One project by id, or undefined. */
    get: (projectId) => projects[projectId],
    /** Every project, keyed by id. */
    getAll: () => projects,
    /** The projects as a listing, each with its real id. */
    list,
    /** The default project's id, once ensureDefault() has run. */
    getDefaultId: () => defaultProjectId,
    getAccumulatedContext,
    buildContext,
    validateDepth,
    validateMissionProject,
    hasCircularDep,
    checkCompletion,
    checkDependencies,
    activateDependents,
    suggestContextPromotions,
    /**
     * Updates a project in the cache only (not written to Firestore). The id always stays the key:
     * an update carrying a blank or different id once left a cached project that listed without one.
     *
     * @param {string} projectId
     * @param {object} data - fields to merge in
     */
    update(projectId, data) {
      if (!projects[projectId]) projects[projectId] = { ...data, id: projectId };
      else Object.assign(projects[projectId], data, { id: projectId });
    },
    /** The parent -> children index. */
    getChildren: () => children,
  };
}
