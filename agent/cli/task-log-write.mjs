#!/usr/bin/env node
// agent/cli/task-log-write.mjs: the task-log-write command. Records how the delivery of one work
// envelope ended (delivered, timed out, or an error) as a record in that envelope's history
// (work/{id}/history), where task-log-read --task and the dashboard's timeline show it. It is a
// log, never state: it changes no field of the envelope, so it cannot move a status or mark
// something delivered. The mouth service keeps the delivery state itself.
//
// It never fails the caller: any problem is a warning on stderr and exit 0, because a lost log
// record must not turn a delivered reply into a failed one.

import { pathToFileURL } from 'node:url';
import { CliError, checkDocId, createCliRuntime } from './cli-runtime.mjs';

const TEXT_MAX_CHARS = 500;
const DETAIL_MAX_CHARS = 1000;

const USAGE = `Usage: task-log-write <envelopeId> <channel> <status> <startedAt> <durationMs> <outputChars> <classified> [text] [error]
  status      delivered | timed_out | error
  classified  external | internal | unknown
Adds a delivery record to the envelope's history. Never fails: problems are warnings on stderr.`;

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
};

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr, now
 * @returns {Promise<number>} always 0
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  if (argv[0] === '--help' || argv[0] === '-h') { stdout.write(`${USAGE}\n`); return 0; }

  const [envelopeId, channel = 'unknown', status = 'unknown', startedAt = '', durationMs = '0', outputChars = '0',
    classified = 'unknown', text = '', error = ''] = argv;
  try {
    if (!envelopeId) throw new CliError(USAGE);
    checkDocId(envelopeId, 'envelopeId');
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { db, collections, subcollections } = runtime;
    const path = `${collections.work}/${envelopeId}`;

    const env = await db.read(path, { strict: true });
    if (!env) {
      // A history record under a missing envelope would be an orphan nobody can see.
      stderr.write(`[task-log-write] WARN: envelope ${envelopeId} not found; nothing written\n`);
      return 0;
    }
    const at = now();
    const delivery = {
      status,
      channel,
      classified,
      started_at: startedAt || null,
      duration_ms: count(durationMs),
      output_chars: count(outputChars),
      error: error || null,
    };
    const detail = `${status} via ${channel}: ${delivery.output_chars} chars in ${delivery.duration_ms} ms`
      + `${error ? `; error: ${error}` : ''}${text ? `; ${text.slice(0, TEXT_MAX_CHARS)}` : ''}`;
    // prev_status and new_status are both the envelope's own status: this record is not a
    // transition, and the timeline must not show one.
    const record = {
      seq: at.getTime(),
      prev_status: env.status ?? null,
      new_status: env.status ?? null,
      agent: 'task-log-write',
      timestamp: at.toISOString(),
      detail: detail.slice(0, DETAIL_MAX_CHARS),
      delivery,
    };
    const written = await db.write(`${path}/${subcollections.workHistory}/${at.getTime()}-delivery`, record);
    if (!written) stderr.write('[task-log-write] WARN: Firestore write failed (non-fatal)\n');
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`[task-log-write] WARN: ${e.message}\n`); return 0; }
    stderr.write(`[task-log-write] WARN: ${e.message} (non-fatal)\n`);
    return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
