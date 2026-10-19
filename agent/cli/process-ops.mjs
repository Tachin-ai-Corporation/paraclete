#!/usr/bin/env node
// agent/cli/process-ops.mjs: the process-ops command. Lists, reads, writes and retires the agent's
// process playbooks. A playbook is a name, a one-line description and a narrative ("how this kind of
// work has gone well before") that the agent recalls into its own checkpoint plan; it is never run as
// steps. The library is the role packages' installed playbooks plus the root processes collection,
// where a stored playbook overrides an installed one with the same id; agent/work/process-registry.mjs
// merges the two, as it does for the brain. Writes go to the collection only, never to an installed
// file. Retiring marks a playbook deprecated; nothing is deleted.

import { pathToFileURL } from 'node:url';
import { firestoreEncode, StoreUnavailable } from '../storage/firestore.mjs';
import { createProcessRegistry } from '../work/process-registry.mjs';
import { ID_PATTERN } from '../work/work-ids.mjs';
import { readInstalledProcesses } from '../work/role-packages.mjs';
import { CliError, createCliRuntime, readStdin } from './cli-runtime.mjs';

/** Who a stored playbook names as its last writer when this command wrote it. */
const ACTOR = 'agent';
const READ_LIMIT = 300;

const USAGE = `process-ops — the agent's process playbook library (name + short description + narrative).
  process-ops list
  process-ops get <id>
  process-ops write <id> --name "<name>" --description "<one line>" --narrative "<prose>" [--tags a,b] [--project <id>]
  process-ops write <id> --name "<name>" --description "<one line>" --stdin      # narrative from stdin (quote-safe)
  process-ops retire <id>`;

const WRITE_VALUED = new Set(['--name', '--description', '--narrative', '--tags', '--project']);

function parseWrite(args) {
  const opts = { name: '', description: '', narrative: '', tags: '', project: '', stdin: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--stdin') { opts.stdin = true; continue; }
    if (!WRITE_VALUED.has(a)) throw new CliError(`unknown option: ${a}`);
    if (i + 1 >= args.length) throw new CliError(`${a} needs a value`);
    opts[a.slice(2)] = args[i += 1];
  }
  return opts;
}

/** A playbook id from the command line. `get --name x` once looked up a playbook named "--name". */
function playbookId(raw, verb) {
  if (!raw) throw new CliError(`usage: process-ops ${verb} <id>`, 1);
  if (raw.startsWith('-')) {
    throw new CliError(`process-ops ${verb} takes the playbook id itself: process-ops ${verb} <id>  (got '${raw}'; process-ops list shows the ids)`, 2);
  }
  if (!ID_PATTERN.test(raw)) throw new CliError(`'${raw}' is not a playbook id: lowercase letters, digits and dashes`, 2);
  return raw;
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
  const [cmd, ...args] = argv;

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { stdout.write(`${USAGE}\n`); return 0; }
  if (!['list', 'get', 'write', 'retire'].includes(cmd)) { stderr.write(`${USAGE}\n`); return 1; }

  try {
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { db, collections, instance, paths } = runtime;
    const docPath = (id) => `${collections.processes}/${id}`;
    const roleDirs = { genericDir: paths.genericRole, role: instance.role, roleDir: paths.role };

    if (cmd === 'list') {
      // The stored playbooks are read strictly here and handed to the registry, so an outage fails
      // the command instead of quietly listing only the installed playbooks.
      const stored = await db.query('', collections.processes, [], { noOrderBy: true, strict: true, limit: READ_LIMIT });
      const defaults = readInstalledProcesses(roleDirs, {
        onError: (file, e) => stderr.write(`process-ops: skipping unreadable ${file}: ${e.message}\n`),
      });
      const registry = createProcessRegistry({ db: { query: async () => stored }, defaults, logger: () => {} });
      await registry.loadProcesses();
      const rows = Object.values(registry.getAllProcesses())
        .map((p) => [p.id, p.name || '', Boolean(p.narrative), p.description || ''])
        .sort((a, b) => a[0].localeCompare(b[0]));
      if (!rows.length) { stdout.write('(no processes)\n'); return 0; }
      const lines = [`${rows.length} process playbook(s):`];
      for (const [id, name, hasNarrative, desc] of rows) {
        lines.push(`  ${id.padEnd(24)}  ${name.slice(0, 34).padEnd(34)}  ${hasNarrative ? '[narrative]' : '[NO narrative]'}  ${desc.slice(0, 56)}`);
      }
      if (stored.length >= READ_LIMIT) lines.push(`(Read the first ${READ_LIMIT} stored playbooks, the most one read covers.)`);
      stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }

    if (cmd === 'get') {
      const id = playbookId(args[0], 'get');
      let p = await db.read(docPath(id), { strict: true });
      if (p) p = { ...p, id };
      else {
        p = readInstalledProcesses(roleDirs).find((d) => d.id === id) || null;
        if (!p) {
          stderr.write(`process-ops: no playbook '${id}' in the library — process-ops list shows the ids\n`);
          return 1;
        }
      }
      stdout.write([
        `id         : ${p.id}`,
        `name       : ${p.name || ''}`,
        `description: ${p.description || ''}`,
        `status     : ${p.status || 'active'}`,
        `updated_by : ${p.updated_by || (p._source ? `installed (${p._source})` : '')}  updated_at: ${p.updated_at || ''}`,
        '',
        'narrative:',
        p.narrative || '(none)',
      ].join('\n') + '\n');
      return 0;
    }

    const installedById = (id) => readInstalledProcesses(roleDirs).find((d) => d.id === id) || null;

    if (cmd === 'write') {
      const id = playbookId(args[0], 'write');
      const opts = parseWrite(args.slice(1));
      const narrative = opts.stdin ? stdin() : opts.narrative;
      const at = now().toISOString().replace(/\.\d{3}Z$/, 'Z');
      // created_at is set once and kept: a playbook without it is hidden from every reader that
      // orders by created_at.
      const existing = await db.read(docPath(id), { strict: true });
      const fields = { id, updated_by: ACTOR, updated_at: at, status: 'active', created_at: existing?.created_at || at };
      // A stored playbook replaces an installed one whole, so the first write over an installed
      // playbook starts from its fields: changing only the narrative must not blank its name, and its
      // recall phrases come along, or the rewrite would stop matching the planner's keyword hint.
      const base = existing ? {} : (installedById(id) || {});
      for (const key of ['name', 'description']) if (opts[key] || base[key]) fields[key] = opts[key] || base[key];
      if (narrative || base.narrative) fields.narrative = narrative || base.narrative;
      if (Array.isArray(base.intent_keywords) && base.intent_keywords.length) fields.intent_keywords = base.intent_keywords;
      const tags = opts.tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.length || opts.project) fields.scope = { project_id: opts.project || null, tags };
      const mask = Object.keys(fields);
      try {
        await db.patch(docPath(id), mask, firestoreEncode(fields), { strict: true });
      } catch (e) {
        stderr.write(`❌ write failed for '${id}': ${e.message}\n`);
        return 1;
      }
      stdout.write(`✅ process '${id}' written to the process library (${mask.join(' ')})\n`);
      return 0;
    }

    const id = playbookId(args[0], 'retire');
    if (!(await db.read(docPath(id), { strict: true }))) {
      // Retiring a missing playbook would create a stray record holding only a status.
      if (installedById(id)) {
        stderr.write(`process-ops: '${id}' is an installed playbook with no stored version; installed playbooks change only with a release\n`);
      } else {
        stderr.write(`process-ops: no playbook '${id}' in the library — process-ops list shows the ids\n`);
      }
      return 1;
    }
    try {
      await db.patch(docPath(id), ['status'], firestoreEncode({ status: 'deprecated' }), { strict: true });
    } catch (e) {
      stderr.write(`❌ retire failed for '${id}': ${e.message}\n`);
      return 1;
    }
    stdout.write(`✅ process '${id}' retired (status=deprecated)\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreUnavailable) {
      stderr.write(`process-ops: could not reach the playbook library: ${e.message}\n`);
      return 1;
    }
    stderr.write(`process-ops: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
