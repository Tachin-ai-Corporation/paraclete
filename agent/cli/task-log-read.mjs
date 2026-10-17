#!/usr/bin/env node
// agent/cli/task-log-read.mjs: the task-log-read command. Prints the agent's most recent tasks (task
// envelopes in the root work collection) as a JSON array, newest first, or one envelope with its
// history: the status changes the brain recorded and the delivery records task-log-write added. It
// reads only. work-log-read is the wider view, of every envelope type.

import { pathToFileURL } from 'node:url';
import { StoreUnavailable } from '../storage/firestore.mjs';
import { CliError, checkDocId, createCliRuntime } from './cli-runtime.mjs';

const HISTORY_LIMIT = 200;

const USAGE = `Usage: task-log-read [--last N] [--task taskId]
  --last N       Show the last N tasks (default: 5)
  --task id      Get one envelope by ID, with its history
Output: JSON array of task records.`;

const str = (v) => (typeof v === 'string' && v ? v : null);

/** One envelope as a task record. */
export function taskRecord(id, env) {
  const start = Date.parse(env.started_at || env.created_at || '');
  const end = Date.parse(env.completed_at || '');
  const text = str(env.title) || str(env.instruction) || '';
  return {
    taskId: id,
    type: env.type || null,
    parentId: str(env.parent_id),
    status: env.status || null,
    intent: str(env.intent),
    text: text.slice(0, 500),
    startedAt: str(env.started_at),
    completedAt: str(env.completed_at),
    durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
    outputChars: typeof env.output === 'string' ? env.output.length : 0,
    error: str(env.error),
  };
}

function parseArgs(argv) {
  const opts = { last: 5, task: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a !== '--last' && a !== '--task') throw new CliError(`[task-log-read] ERROR: Unknown arg: ${a}`);
    if (i + 1 >= argv.length) throw new CliError(`[task-log-read] ERROR: ${a} needs a value`);
    const value = argv[i += 1];
    if (a === '--task') opts.task = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new CliError(`[task-log-read] ERROR: --last must be a positive whole number, got '${value}'`);
      opts.last = n;
    }
  }
  return opts;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout.write(`${USAGE}\n`); return 0; }
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { db, collections, subcollections } = runtime;

    if (opts.task) {
      checkDocId(opts.task, '--task');
      const path = `${collections.work}/${opts.task}`;
      const env = await db.read(path, { strict: true });
      if (!env) { stdout.write('[]\n'); return 0; }
      const history = (await db.query(path, subcollections.workHistory, [], { noOrderBy: true, strict: true, limit: HISTORY_LIMIT }))
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.id).localeCompare(String(b.id)));
      stdout.write(`${JSON.stringify([{ ...taskRecord(opts.task, env), history }], null, 2)}\n`);
      return 0;
    }

    const tasks = await db.query('', collections.work, [{ field: 'type', op: 'EQUAL', value: { stringValue: 'T' } }],
      { orderBy: 'created_at', orderDirection: 'DESCENDING', limit: opts.last, strict: true });
    stdout.write(`${JSON.stringify(tasks.map((t) => taskRecord(t.id, t)), null, 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreUnavailable) { stderr.write(`[task-log-read] ERROR: the work records could not be read: ${e.message}\n`); return 1; }
    stderr.write(`[task-log-read] ERROR: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
