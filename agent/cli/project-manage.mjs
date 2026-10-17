#!/usr/bin/env node
// agent/cli/project-manage.mjs: the project-manage command. Lists, reads, creates and updates the
// agent's projects (the root projects collection): status changes, canon entries (authoritative
// project facts), context entries and linked process playbooks. Each change rereads the project and
// is written only if nobody changed it meanwhile.
//
// What a project's context may hold is decided by agent/work/project-context.mjs, and how deep
// projects may nest by agent/work/projects.mjs; this command applies both. A listed project's id is
// always its document id, never a stored field: reading a stored field once printed a placeholder
// dash instead of the id, and the agent had to guess which project was meant.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StoreConflict, StoreUnavailable } from '../storage/firestore.mjs';
import { withCanonicalId } from '../storage/entity-id.mjs';
import { validateContextEntry } from '../work/project-context.mjs';
import { createProjectRegistry } from '../work/projects.mjs';
import { ID_PATTERN } from '../work/work-ids.mjs';
import { CliError, checkDocId, createCliRuntime, readStdin } from './cli-runtime.mjs';

const LIST_LIMIT = 300;
const STATUSES = ['active', 'complete', 'paused', 'archived'];
const REQUIRED = ['id', 'name', 'description', 'context', 'goal'];
/** Fields a project never carries: one project belongs to one agent, and has no team or owner. */
const NOT_PROJECT_FIELDS = ['owner', 'team', 'ownerAgent', 'participants'];

const USAGE = `Usage: project-manage <command> [args]

Commands:
  list                                             List all projects
  get '<id>'                                       Get full project details as JSON
  create '<json>' [--processes <ids>]              Create a new project
  update '<id>' '<json>' [--processes <ids>]       Update a project (deep merge on context)
  complete '<id>'                                  Set status to 'complete'
  pause '<id>'                                     Set status to 'paused'
  archive '<id>'                                   Set status to 'archived'
  canon-set <id> <key> <text...>|--stdin           Set a canon entry (authoritative fact)
  canon-list <id>                                  List all canon entries
  canon-remove <id> <key>                          Remove a canon entry
  canon-authority <id> <email1> [email2...]        Set canon authority list
  add-context <id> <key> '<json-or-string>'|--stdin  Add/update a single context key
  add-process <id> <process-id>                    Link a process to standardProcesses

A '<json>' argument may also be the path of a file holding the JSON.

Canon entries are authoritative project facts injected prominently into all agent context.
Only addresses in the authority list can modify canon entries.

The create JSON MUST include:
  id, name, description, context, goal
  id is lowercase letters, digits and dashes.

Optional create fields (in JSON):
  parent_id      Parent project ID (validated: must exist, max depth 4)
  depends_on     Array of project IDs this project depends on

Status values: active | complete | paused | archived

Optional flags (create/update):
  --processes <comma-separated-ids>   Set standardProcesses array (e.g. 'proc1,proc2')
  --processes ""                      Clear the standardProcesses list

Update supports changing: goal, parent_id, depends_on, status, name, description, context
  When parent_id is changed, existence and max depth (4) are validated.

Context entries are resource packets, one per key:
  { "key": { "kind": "drive_folder|doc|sheet|slides|url|repo|git|resource|convention",
             "ref": "id", "url": "https://...", "name": "...", "summary": "..." } }
  A key names a durable resource, never history, state, a task or a process.`;

/** A list the way the agent saw it before: ['a', 'b']. */
const pyList = (items) => `[${items.map((s) => `'${s}'`).join(', ')}]`;

const fail = (message) => { throw new CliError(`ERROR: ${message}`); };

/** JSON from an argument that is either the JSON itself or the path of a file holding it. */
function jsonArg(raw, what) {
  const text = existsSync(raw) ? readFileSync(raw, 'utf8') : raw;
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    fail(`${what} is not valid JSON (${e.message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be one JSON object`);
  return value;
}

/** --processes <ids> among the arguments after the JSON: { set: false } when absent. */
function parseProcesses(rest) {
  const out = { set: false, ids: [] };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--processes') throw new CliError(`Unknown option: ${rest[i]}`);
    if (i + 1 >= rest.length) throw new CliError('--processes needs a value');
    out.set = true;
    out.ids = rest[i += 1].split(',').map((p) => p.trim()).filter(Boolean);
  }
  return out;
}

function checkContext(context) {
  for (const [key, value] of Object.entries(context || {})) {
    const { ok, reason } = validateContextEntry(key, value);
    if (!ok) fail(`context key "${key}": ${reason}`);
  }
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr, now, readStdin
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  const stdin = deps.readStdin || readStdin;
  const [cmd = 'help', ...args] = argv;
  const print = (lines) => stdout.write(`${[].concat(lines).join('\n')}\n`);

  if (['help', '--help', '-h'].includes(cmd)) { print(USAGE); return 0; }

  try {
    const handlers = {
      list, get, create, update,
      complete: (a) => setStatus(a, 'complete', 'Completed'),
      pause: (a) => setStatus(a, 'paused', 'Paused'),
      archive: (a) => setStatus(a, 'archived', 'Archived'),
      'canon-set': canonSet, 'canon-list': canonList, 'canon-remove': canonRemove, 'canon-authority': canonAuthority,
      'add-context': addContext, 'add-process': addProcess,
    };
    if (!Object.hasOwn(handlers, cmd)) { print(USAGE); return 1; }
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { db, collections, identity } = runtime;
    const projectPath = (id) => `${collections.projects}/${id}`;
    const stamp = () => now().toISOString();

    /** Every project, each with its document id as `id`. */
    async function loadAll() {
      return db.query('', collections.projects, [], { noOrderBy: true, strict: true, limit: LIST_LIMIT });
    }

    /** One project and its version, or an error naming it. */
    async function readProject(id) {
      checkDocId(id, 'project id');
      const found = await db.readDoc(projectPath(id));
      if (!found) fail(`Project "${id}" not found`);
      return { project: withCanonicalId(id, found.data), updateTime: found.updateTime };
    }

    /** Writes the whole project, only if it is unchanged since it was read. */
    async function saveProject(id, project, updateTime) {
      await db.commit([{ path: projectPath(id), data: withCanonicalId(id, project), precondition: { updateTime } }]);
    }

    /** The parent must exist, must not be the project itself, and must not nest it too deep. */
    async function checkParent(id, parentId) {
      if (!parentId) return;
      if (parentId === id) fail('a project cannot be its own parent');
      const docs = await loadAll();
      if (!docs.some((d) => d.id === parentId)) fail(`parent_id "${parentId}" not found.`);
      const registry = createProjectRegistry({ db: { query: async () => docs }, logger: () => {} });
      await registry.load();
      try {
        registry.validateDepth(parentId);
      } catch (e) {
        fail(`${e.message}.`);
      }
    }

    function withoutForeignFields(body) {
      const dropped = NOT_PROJECT_FIELDS.filter((f) => Object.hasOwn(body, f));
      if (dropped.length) stderr.write(`Ignored ${dropped.join(', ')}: projects have no owner or team.\n`);
      return Object.fromEntries(Object.entries(body).filter(([k]) => !NOT_PROJECT_FIELDS.includes(k)));
    }

    async function list() {
      const docs = (await loadAll()).sort((a, b) => a.id.localeCompare(b.id));
      if (!docs.length) { print('No projects found.'); return 0; }
      const lines = [];
      for (const p of docs) {
        lines.push(`  ${p.id}`);
        lines.push(`    Name:        ${p.name || '—'}`);
        lines.push(`    Status:      ${p.status || '—'}`);
        lines.push(`    Description: ${String(p.description || ' ').slice(0, 120)}`);
        if (p.goal) lines.push(`    Goal:        ${String(p.goal).slice(0, 120)}`);
        if (p.parent_id) lines.push(`    Parent:      ${p.parent_id}`);
        if (Array.isArray(p.depends_on) && p.depends_on.length) lines.push(`    Depends on:  ${p.depends_on.length} project(s)`);
        if (Array.isArray(p.standardProcesses) && p.standardProcesses.length) lines.push(`    Processes:   ${p.standardProcesses.join(', ')}`);
        lines.push('');
      }
      lines.push(`Total: ${docs.length} projects`);
      if (docs.length >= LIST_LIMIT) lines.push(`(Listed the first ${LIST_LIMIT} projects, the most one read covers.)`);
      print(lines);
      return 0;
    }

    async function get([id]) {
      if (!id) fail('get requires a project id');
      const { project } = await readProject(id);
      print(JSON.stringify(project, null, 2));
      return 0;
    }

    async function create([input, ...rest]) {
      if (!input) fail('create requires a JSON string or file path');
      const processes = parseProcesses(rest);
      const body = withoutForeignFields(jsonArg(input, 'the project JSON'));
      const missing = REQUIRED.filter((f) => !Object.hasOwn(body, f));
      if (missing.length) fail(`Missing required fields: ${pyList(missing)}`);
      if (typeof body.id !== 'string' || !ID_PATTERN.test(body.id)) fail(`project id "${body.id}" must be lowercase letters, digits and dashes`);
      if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) fail('context must be a JSON object/map.');
      checkContext(body.context);
      if (body.status !== undefined && !STATUSES.includes(body.status)) fail(`Invalid status "${body.status}". Must be one of: ${pyList(STATUSES)}`);
      if (processes.set) body.standardProcesses = processes.ids;
      await checkParent(body.id, body.parent_id);

      const at = stamp();
      const project = {
        parent_id: null,
        depends_on: [],
        status: 'active',
        created_by: 'agent',
        ...body,
        created_at: at,
        updated_at: at,
      };
      try {
        // Create only: an existing project is changed with update, never overwritten here.
        await db.commit([{ path: projectPath(body.id), data: withCanonicalId(body.id, project), precondition: { exists: false } }]);
      } catch (e) {
        if (e instanceof StoreConflict) fail(`Project "${body.id}" already exists; use update to change it.`);
        throw e;
      }
      const lines = [
        `Created project '${body.id}'.`,
        `  Name:        ${project.name}`,
        `  Status:      ${project.status}`,
        `  Description: ${String(project.description).slice(0, 120)}`,
        `  Goal:        ${String(project.goal).slice(0, 120)}`,
      ];
      if (project.parent_id) lines.push(`  Parent:      ${project.parent_id}`);
      if (project.standardProcesses?.length) lines.push(`  Processes:   ${project.standardProcesses.join(', ')}`);
      print(lines);
      return 0;
    }

    async function update([id, input, ...rest]) {
      if (!id) fail('update requires a project id');
      if (!input) fail('update requires a JSON string of partial updates or file path');
      const processes = parseProcesses(rest);
      const updates = withoutForeignFields(jsonArg(input, 'the update JSON'));
      delete updates.id;
      const { project, updateTime } = await readProject(id);

      if (Object.hasOwn(updates, 'context')) {
        if (!updates.context || typeof updates.context !== 'object' || Array.isArray(updates.context)) fail('context must be a JSON object/map.');
        checkContext(updates.context);
        const existing = project.context && typeof project.context === 'object' && !Array.isArray(project.context) ? project.context : {};
        project.context = { ...existing, ...updates.context };
        delete updates.context;
      }
      if (Object.hasOwn(updates, 'status') && !STATUSES.includes(updates.status)) {
        fail(`Invalid status "${updates.status}". Must be one of: ${pyList(STATUSES)}`);
      }
      Object.assign(project, updates);
      if (updates.parent_id) await checkParent(id, updates.parent_id);
      if (processes.set) {
        if (processes.ids.length) project.standardProcesses = processes.ids;
        else {
          delete project.standardProcesses;
          stderr.write('Cleared standardProcesses.\n');
        }
      }
      project.updated_at = stamp();
      await saveProject(id, project, updateTime);
      print(`Updated project '${id}'.`);
      return 0;
    }

    async function setStatus([id], status, verb) {
      if (!id) fail(`${verb.toLowerCase().replace(/d$/, '')} requires a project id`);
      const { project, updateTime } = await readProject(id);
      const at = stamp();
      project.status = status;
      project.updated_at = at;
      if (status === 'complete') project.completed_at = at;
      await saveProject(id, project, updateTime);
      print(`${verb} project '${id}'.`);
      return 0;
    }

    function canonOf(project) {
      const canon = project.canon && typeof project.canon === 'object' && !Array.isArray(project.canon) ? project.canon : {};
      return {
        ...canon,
        authority: Array.isArray(canon.authority) ? canon.authority : [],
        entries: Array.isArray(canon.entries) ? canon.entries : [],
      };
    }

    function checkAuthority(canon) {
      if (canon.authority.length && !canon.authority.includes(identity.email)) {
        fail(`${identity.email} is not in the canon authority list: ${pyList(canon.authority)}`);
      }
    }

    async function canonSet([id, key, ...words]) {
      if (!id) fail('canon-set requires a project id');
      if (!key) fail('canon-set requires a key');
      let text = words.join(' ');
      // --stdin (or -): the text comes from stdin, safe for apostrophes, quotes and newlines.
      if (text === '-' || text === '--stdin') text = stdin();
      if (!text) fail('canon-set requires text after the key (or --stdin)');
      const { project, updateTime } = await readProject(id);
      const canon = canonOf(project);
      checkAuthority(canon);
      const at = stamp();
      const entry = canon.entries.find((e) => e && typeof e === 'object' && e.key === key);
      if (entry) Object.assign(entry, { text, updated_at: at, updated_by: identity.email });
      else canon.entries.push({ key, text, updated_at: at, updated_by: identity.email });
      if (!canon.authority.length) canon.authority = [identity.email];
      project.canon = canon;
      project.updated_at = at;
      await saveProject(id, project, updateTime);
      print([
        `${entry ? 'Updated' : 'Added'} canon entry "${key}" on project "${id}"`,
        `  Key: ${key}`,
        text.length > 100 ? `  Text: ${text.slice(0, 100)}...` : `  Text: ${text}`,
        `  By: ${identity.email}`,
      ]);
      return 0;
    }

    async function canonList([id]) {
      if (!id) fail('canon-list requires a project id');
      const { project } = await readProject(id);
      const canon = canonOf(project);
      if (!canon.entries.length) { print(`Project "${id}" has no canon entries.`); return 0; }
      const lines = [`Canon for project "${id}" (${canon.entries.length} entries):`, `Authority: ${pyList(canon.authority)}`, ''];
      canon.entries.forEach((e, i) => {
        if (!e || typeof e !== 'object') return;
        lines.push(`  [${i + 1}] ${e.key ?? '?'}`, `      ${e.text ?? ''}`, `      (by ${e.updated_by ?? '?'} at ${e.updated_at ?? '?'})`, '');
      });
      print(lines);
      return 0;
    }

    async function canonRemove([id, key]) {
      if (!id) fail('canon-remove requires a project id');
      if (!key) fail('canon-remove requires a key');
      const { project, updateTime } = await readProject(id);
      const canon = canonOf(project);
      checkAuthority(canon);
      const kept = canon.entries.filter((e) => !(e && typeof e === 'object' && e.key === key));
      if (kept.length === canon.entries.length) { print(`Canon entry "${key}" not found on project "${id}".`); return 0; }
      project.canon = { ...canon, entries: kept };
      project.updated_at = stamp();
      await saveProject(id, project, updateTime);
      print(`Removed canon entry "${key}" from project "${id}"`);
      return 0;
    }

    async function canonAuthority([id, ...emails]) {
      if (!id) fail('canon-authority requires a project id');
      const authority = emails.flatMap((e) => e.split(/\s+/)).filter(Boolean);
      if (!authority.length) fail('canon-authority requires space-separated email list');
      const { project, updateTime } = await readProject(id);
      project.canon = { ...canonOf(project), authority };
      project.updated_at = stamp();
      await saveProject(id, project, updateTime);
      print([`Updated canon authority for project "${id}":`, ...authority.map((a) => `  - ${a}`)]);
      return 0;
    }

    async function addContext([id, key, raw]) {
      if (!id) fail('add-context requires a project id');
      if (!key) fail('add-context requires a context key');
      if (raw === undefined || raw === '') fail('add-context requires a value (JSON packet or plain string, or --stdin)');
      // --stdin (or -): the value comes from stdin, safe for apostrophes, quotes and newlines.
      const value = raw === '-' || raw === '--stdin' ? stdin() : raw;
      let packet;
      try {
        const parsed = JSON.parse(value);
        packet = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.kind ? parsed : null;
      } catch { /* plain text */ }
      // Plain text is a working convention: a durable fact about the area, in words.
      packet ||= { kind: 'convention', summary: value };
      const { ok, reason } = validateContextEntry(key, packet);
      if (!ok) fail(`context key "${key}": ${reason}`);
      const { project, updateTime } = await readProject(id);
      const at = stamp();
      const context = project.context && typeof project.context === 'object' && !Array.isArray(project.context) ? project.context : {};
      project.context = { ...context, [key]: { ...packet, updatedAt: at, updatedBy: 'agent' } };
      project.updated_at = at;
      await saveProject(id, project, updateTime);
      print(`Added context key "${key}" to project "${id}".`);
      return 0;
    }

    async function addProcess([id, processId]) {
      if (!id) fail('add-process requires a project id');
      if (!processId) fail('add-process requires a process id');
      const { project, updateTime } = await readProject(id);
      const processes = Array.isArray(project.standardProcesses) ? project.standardProcesses : [];
      if (processes.includes(processId)) {
        print(`Already linked: process "${processId}" is already in project "${id}".`);
        return 0;
      }
      project.standardProcesses = [...processes, processId];
      project.updated_at = stamp();
      await saveProject(id, project, updateTime);
      print(`Linked process "${processId}" to project "${id}".`);
      return 0;
    }

    return await handlers[cmd](args);
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreConflict) {
      stderr.write('ERROR: the project changed while this command ran; nothing was written. Run the command again.\n');
      return 1;
    }
    if (e instanceof StoreUnavailable) {
      stderr.write(`ERROR: the projects could not be reached: ${e.message}\n`);
      return 1;
    }
    stderr.write(`ERROR: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
