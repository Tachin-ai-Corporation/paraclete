#!/usr/bin/env node
// agent/cli/brain-telemetry-write.mjs: the brain-telemetry-write command. Records one dispatch (an
// organ or a program the agent ran, with its timing, size and outcome) as one JSON line in the
// system journal under the paraclete-telemetry tag, the same one-object-per-line shape the services
// log in, where brain-telemetry-read finds it. The gateway's own organ turns need no such call:
// brain-telemetry-read reads them from the gateway's journal directly.
//
// It never fails the caller: any problem is a warning on stderr and exit 0.

import { pathToFileURL } from 'node:url';
import { runProgram } from './cli-runtime.mjs';

export const TELEMETRY_TAG = 'paraclete-telemetry';
const TASK_MAX_CHARS = 200;

const USAGE = `Usage: brain-telemetry-write <organ> <task> <start_ns> <end_ns> <output_bytes> <exit_code> [error_type]
  start_ns, end_ns  nanoseconds since the epoch (date +%s%N); 0 when unknown
Records one dispatch in the journal. Never fails: problems are warnings on stderr.`;

const toBigInt = (v) => {
  try { return BigInt(String(v)); } catch { return 0n; }
};

/**
 * The journal line for one dispatch.
 *
 * @param {string[]} argv
 * @param {Date} now
 * @returns {object}
 */
export function dispatchEvent(argv, now) {
  const [organ = 'unknown', task = '', startNs = '0', endNs = '0', outputBytes = '0', exitCode = '1', errorType = ''] = argv;
  const start = toBigInt(startNs);
  const end = toBigInt(endNs);
  const durationMs = start > 0n && end > 0n ? Number((end - start) / 1_000_000n) : 0;
  const bytes = Number.parseInt(outputBytes, 10) || 0;
  const code = Number.parseInt(exitCode, 10);
  const exit = Number.isFinite(code) ? code : 1;
  // A dispatch that exited non-zero, said nothing, or named an error did not succeed.
  const success = exit === 0 && bytes > 0 && !errorType;
  return {
    time: now.toISOString(),
    level: success ? 'INFO' : 'WARN',
    service: 'telemetry',
    message: 'dispatch',
    event: 'dispatch',
    organ,
    task: String(task).slice(0, TASK_MAX_CHARS),
    started_at: start > 0n ? new Date(Number(start / 1_000_000n)).toISOString() : now.toISOString(),
    duration_ms: durationMs,
    output_bytes: bytes,
    exit_code: exit,
    success,
    error: errorType || null,
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - stdout, stderr, now, run (runProgram)
 * @returns {Promise<number>} always 0
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  const run = deps.run || runProgram;
  if (argv[0] === '--help' || argv[0] === '-h') { stdout.write(`${USAGE}\n`); return 0; }
  try {
    const event = dispatchEvent(argv, now());
    const priority = event.success ? 'info' : 'warning';
    const result = await run('systemd-cat', ['-t', TELEMETRY_TAG, '-p', priority], { input: `${JSON.stringify(event)}\n` });
    if (result.code !== 0) {
      stderr.write(`[brain-telemetry-write] WARN: could not write to the journal (${result.stderr.trim() || `exit ${result.code}`}); skipping\n`);
    }
  } catch (e) {
    stderr.write(`[brain-telemetry-write] WARN: ${e.message}; skipping\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
