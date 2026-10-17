#!/usr/bin/env node
// agent/cli/responsibility-manage.mjs: the responsibility-manage command, how the agent authors its
// own responsibilities. It writes the agent's store (the root responsibilities collection, each
// change also kept as a numbered revision), which the scheduler re-reads every refresh: a change is
// live within a minute, survives upgrades, and never touches an installed file. Writers that edited
// the installed responsibilities.json in place lost every change at the next upgrade.
//
// The rules (layering over the role packages' installed defaults, validation, what may be
// overridden) live in agent/work/responsibility-store.mjs, shared with the scheduler and the control
// service, so what this command accepts is exactly what the scheduler runs.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StoreConflict, StoreUnavailable } from '../storage/firestore.mjs';
import { cronNextFire } from '../work/scheduler.mjs';
import {
  STORE_COLLECTION, collectDefaults, describeProvenance, mergeResponsibilities, planWrite, readStore, resolvePolicy,
} from '../work/responsibility-store.mjs';
import { readInstalledResponsibilities } from '../work/role-packages.mjs';
import { CliError, checkDocId, createCliRuntime, readStdin } from './cli-runtime.mjs';

/** Who the store records as the author of a change made with this command. */
const ACTOR = 'agent';
const LIVE_NOTE = 'Live within a minute — no release or upgrade needed.';
const HISTORY_LIMIT = 200;

const USAGE = `Usage: responsibility-manage [--note "<why>"] [--json] <verb> ...
  list | show <id> | create <json> | update <id> <json> | toggle <id> [on|off]
  remove <id> | reset <id> | adopt <id> [<json>] | history <id> | revert <id> --to <revision>
A body may be inline JSON, --stdin, or --file <path>. create needs id, name, schedule
(five-field cron) or event, instruction, success_criteria, context.purpose and
context.process; timezone is an IANA zone (default UTC). create and update also take
--process-ref <id> and --process-params '<json>' ("" clears them on update).
Changes go to the agent's own store and are live within a minute.`;

const VALUED = new Set(['--note', '--file', '--to', '--process-ref', '--process-params']);
const SWITCHES = new Set(['--stdin', '--json', '--help', '-h']);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUED.has(a)) {
      if (i + 1 >= argv.length) throw new CliError(`${a} needs a value`);
      flags[a.slice(2)] = argv[i += 1];
    } else if (SWITCHES.has(a)) {
      flags[a.replace(/^-+/, '')] = true;
    } else if (a.startsWith('--')) {
      throw new CliError(`unknown option ${a}`);
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function scheduleOf(r) {
  if (r.schedule) return `${r.schedule} ${r.timezone || 'UTC'}`;
  if (r.event) return `on ${r.event}`;
  return '(no trigger)';
}

const need = (value, message) => {
  if (!value) throw new CliError(message);
  return checkDocId(value);
};

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr, now, readStdin
 * @returns {Promise<number>} 0, or 1 for a refused or invalid request, 2 when the store is
 *   unreachable, 3 when the record changed at the same moment
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  const stdin = deps.readStdin || readStdin;

  try {
    const { flags, pos } = parseArgs(argv);
    const verb = pos[0];
    if (!verb || flags.help || flags.h || verb === 'help') { stdout.write(`${USAGE}\n`); return 0; }

    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { db, contracts, instance, paths } = runtime;
    const policy = resolvePolicy(contracts);
    const roleDirs = { genericDir: paths.genericRole, role: instance.role, roleDir: paths.role };
    const defaults = collectDefaults(readInstalledResponsibilities(roleDirs, {
      onError: (file, e) => stderr.write(`responsibility-manage: skipping unreadable ${file}: ${e.message}\n`),
    }));
    const defaultsById = new Map(defaults.map((r) => [r.id, r]));
    const revisions = runtime.subcollections.responsibilityRevisions;
    const docPath = (id) => `${STORE_COLLECTION}/${id}`;
    const merge = (docs) => mergeResponsibilities(defaults, docs, { policy, nextFire: cronNextFire });

    const out = (human, data) => stdout.write(`${flags.json ? JSON.stringify(data, null, 2) : human}\n`);

    function readBody(positional, { required = true } = {}) {
      let raw = null;
      if (flags.stdin) raw = stdin();
      else if (flags.file) raw = readFileSync(flags.file, 'utf8');
      else if (positional !== undefined) raw = existsSync(positional) ? readFileSync(positional, 'utf8') : positional;
      let body = {};
      if (raw !== null && String(raw).trim()) {
        try {
          body = JSON.parse(raw);
        } catch (e) {
          throw new CliError(`the body is not valid JSON (${e.message}). Free text with quotes or apostrophes is safest on --stdin.`);
        }
      } else if (required && flags['process-ref'] === undefined && flags['process-params'] === undefined) {
        throw new CliError('a JSON body is required (inline, --stdin, or --file <path>)');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new CliError('the body must be one JSON object');
      if (flags['process-ref'] !== undefined) body.processRef = flags['process-ref'] || null;
      if (flags['process-params'] !== undefined) {
        if (!flags['process-params']) body.processParameters = null;
        else {
          try {
            body.processParameters = JSON.parse(flags['process-params']);
          } catch (e) {
            throw new CliError(`--process-params must be JSON: ${e.message}`);
          }
        }
      }
      return body;
    }

    async function write(id, planArgs) {
      checkDocId(id);
      const current = await db.readDoc(docPath(id));
      const docs = await readStore(db);
      const ownCount = docs.filter((d) => d.mode === 'own' && d.status !== 'removed' && d.id !== id).length;
      const plan = planWrite({
        id,
        actor: ACTOR,
        note: flags.note || '',
        now: now().toISOString(),
        policy,
        nextFire: cronNextFire,
        ownCount,
        current: current?.data || null,
        installed: defaultsById.get(id) || null,
        ...planArgs,
      });
      if (!plan.ok) throw new CliError(plan.error);
      const doc = plan.doc;
      // The record and its revision land together or not at all; the record only if nobody changed
      // it since it was read.
      await db.commit([
        { path: docPath(id), data: doc, precondition: current ? { updateTime: current.updateTime } : { exists: false } },
        { path: `${docPath(id)}/${revisions}/${doc.revision}`, data: doc, precondition: { exists: false } },
      ]);
      out(`${plan.summary[0].toUpperCase()}${plan.summary.slice(1)} — revision ${doc.revision}. ${LIVE_NOTE}`,
        { ok: true, id, revision: doc.revision, doc });
      return 0;
    }

    switch (verb) {
      case 'list': {
        const { effective, issues } = merge(await readStore(db));
        const rows = effective.map((r) => `  ${r.id.padEnd(34)} ${scheduleOf(r).padEnd(30)} ${r.enabled ? 'enabled ' : 'DISABLED'} ${describeProvenance(r)}`);
        const warn = issues.map((i) => `  ! ${i.id}: ${i.reason}`);
        out(`Responsibilities:\n${rows.join('\n') || '  (none)'}${warn.length ? `\nIgnored store records:\n${warn.join('\n')}` : ''}\nTotal: ${effective.length}`,
          { responsibilities: effective, issues });
        return 0;
      }

      case 'show': {
        const id = need(pos[1], 'show needs an id');
        const docs = await readStore(db);
        const record = merge(docs).effective.find((r) => r.id === id) || null;
        const doc = docs.find((d) => d.id === id) || null;
        if (!record && !doc) throw new CliError(`'${id}' not found`);
        out(JSON.stringify({ effective: record, store: doc }, null, 2), { effective: record, store: doc });
        return 0;
      }

      case 'create': {
        const body = readBody(pos[1]);
        if (!body.id) throw new CliError('the body needs an id (lowercase letters, digits, dashes)');
        return await write(body.id, { verb: 'create', input: body });
      }

      case 'update': {
        const id = need(pos[1], 'update needs an id');
        return await write(id, { verb: 'update', input: readBody(pos[2]) });
      }

      case 'toggle': {
        const id = need(pos[1], 'toggle needs an id');
        let want = pos[2];
        if (want && want !== 'on' && want !== 'off') throw new CliError('toggle takes on or off');
        if (!want) {
          const current = merge(await readStore(db)).effective.find((r) => r.id === id);
          if (!current) throw new CliError(`'${id}' not found; say toggle ${id} on|off`);
          // The scheduler arms only a responsibility whose enabled is true, so anything else is off.
          want = current.enabled ? 'off' : 'on';
        }
        return await write(id, { verb: 'update', input: { enabled: want === 'on' } });
      }

      case 'remove': return await write(need(pos[1], 'remove needs an id'), { verb: 'remove' });
      case 'reset': return await write(need(pos[1], 'reset needs an id'), { verb: 'reset' });

      case 'adopt': {
        const id = need(pos[1], 'adopt needs an id');
        const changes = (pos[2] !== undefined || flags.stdin || flags.file) ? readBody(pos[2]) : {};
        return await write(id, { verb: 'adopt', input: changes });
      }

      case 'history': {
        const id = need(pos[1], 'history needs an id');
        const revs = (await db.query(docPath(id), revisions, [], { noOrderBy: true, strict: true, limit: HISTORY_LIMIT }))
          .sort((a, b) => b.revision - a.revision);
        if (!revs.length) throw new CliError(`'${id}' has no history in the agent's store`);
        const rows = revs.map((d) => `  rev ${String(d.revision).padEnd(4)} ${d.updated_at}  ${String(d.updated_by).padEnd(18)} ${d.mode}/${d.status}`
          + (d.mode === 'override' ? `  sets ${Object.keys(d.patch || {}).join(', ')}` : `  ${scheduleOf(d.body || {})}`)
          + (d.note ? `  — ${d.note}` : '') + (d.reverted_from ? `  (restores rev ${d.reverted_from})` : ''));
        out(`History of ${id}:\n${rows.join('\n')}`, { id, revisions: revs });
        return 0;
      }

      case 'revert': {
        const id = need(pos[1], 'revert needs an id');
        const to = Number(flags.to);
        if (!Number.isInteger(to) || to < 1) throw new CliError('revert needs --to <revision number>');
        const rev = await db.read(`${docPath(id)}/${revisions}/${to}`, { strict: true });
        return await write(id, { verb: 'revert', revisionDoc: rev });
      }

      default:
        throw new CliError(`unknown verb '${verb}'\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`responsibility-manage: ${e.message}\n`); return e.code; }
    if (e instanceof StoreConflict) {
      stderr.write(`responsibility-manage: ${e.message}\nSomeone changed it at the same moment — run the command again.\n`);
      return 3;
    }
    if (e instanceof StoreUnavailable) {
      stderr.write(`responsibility-manage: the responsibility store is unreachable: ${e.message}\n`);
      return 2;
    }
    stderr.write(`responsibility-manage: ${e?.stack || String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
