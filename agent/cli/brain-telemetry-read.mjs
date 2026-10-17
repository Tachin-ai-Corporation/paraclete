#!/usr/bin/env node
// agent/cli/brain-telemetry-read.mjs: the brain-telemetry-read command. Shows the agent's recent
// organ turns, newest first: which organ ran, how long it took, how much it answered, and whether it
// failed. It reads the services' journal, where every log line is one JSON object: the gateway's
// line when a turn starts and the line when it completes or fails, plus any events
// brain-telemetry-write recorded. It reads only, and needs read access to the system journal.

import { pathToFileURL } from 'node:url';
import { CliError, runProgram } from './cli-runtime.mjs';
import { TELEMETRY_TAG } from './brain-telemetry-write.mjs';

/** The unit whose journal holds the organ turns. */
export const GATEWAY_UNIT = 'paraclete-gateway.service';

const USAGE = `Usage: brain-telemetry-read [--last N] [--organ <id>] [--failures] [--json]
  --last N        Show the last N turns (default: 20)
  --organ <id>    Only one organ: cortex, prefrontal, motor, cerebellum, temporal-memory, temporal-research
  --failures      Only turns that failed
  --json          Output as a JSON array`;

function parseArgs(argv) {
  const opts = { last: 20, organ: '', failures: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--failures') opts.failures = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--last' || a === '--organ') {
      if (i + 1 >= argv.length) throw new CliError(`${a} needs a value`);
      const value = argv[i += 1];
      if (a === '--organ') opts.organ = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new CliError(`--last must be a positive whole number, got '${value}'`);
        opts.last = n;
      }
    } else throw new CliError(`Unknown option: ${a}`);
  }
  return opts;
}

/**
 * Journal entries from `journalctl -o json` output: one object per line, its message unwrapped from
 * the service's own JSON log line when it is one.
 *
 * @param {string} text
 * @returns {Array<{at: string|null, level: string, message: string, fields: object}>}
 */
export function parseJournal(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    let message = rec.MESSAGE;
    if (Array.isArray(message)) message = Buffer.from(message).toString('utf8');
    if (typeof message !== 'string') continue;
    const micros = Number(rec.__REALTIME_TIMESTAMP);
    let at = Number.isFinite(micros) ? new Date(Math.floor(micros / 1000)).toISOString() : null;
    let level = Number(rec.PRIORITY) <= 3 ? 'ERROR' : Number(rec.PRIORITY) === 4 ? 'WARN' : 'INFO';
    let fields = {};
    if (message.startsWith('{')) {
      try {
        const inner = JSON.parse(message);
        fields = inner;
        message = String(inner.message ?? '');
        if (inner.level) level = String(inner.level);
        if (inner.time) at = String(inner.time);
      } catch { /* a plain line that starts with a brace */ }
    } else {
      // A service that logs plain text: "[gateway] LEVEL: message".
      const plain = /^\[[\w-]+\] (\w+): (.*)$/s.exec(message);
      if (plain) { level = plain[1]; message = plain[2]; }
    }
    entries.push({ at, level, message, fields });
  }
  return entries;
}

const START_RE = /^#(\d+) organ=(\S+) model=(\S+) msgs=(\d+)/;
const COMPLETE_RE = /^#(\d+) completed \((\d+) chars, .*?steps=(\S+) provider=([^\s)]+)(?: fallback_from=([^\s)]+))?\)/;
const MISS_RE = /^#(\d+) TELEMETRY session_miss id=\S+ reason=(\S+)/;
const RID_RE = /^#(\d+) (.*)$/s;

const elapsed = (from, to) => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The gateway's organ turns, paired from its start and end lines by request number. A request
 * number restarts with the gateway, so a start that is never closed before the same number starts
 * again is reported as unfinished. A turn still open at the end of the journal is running.
 *
 * @param {Array} entries - from parseJournal()
 * @returns {object[]}
 */
export function gatewayTurns(entries) {
  const open = new Map();
  const turns = [];
  const close = (rid, patch) => {
    const turn = open.get(rid);
    if (!turn) return;
    open.delete(rid);
    turns.push({ ...turn, ...patch });
  };
  for (const e of entries) {
    let m = START_RE.exec(e.message);
    if (m) {
      close(m[1], { success: false, error: 'no end was logged (the gateway restarted?)' });
      open.set(m[1], {
        source: 'gateway', startedAt: e.at, organ: m[2], model: m[3], messages: Number(m[4]),
        durationMs: null, outputChars: 0, success: null, error: null,
      });
      continue;
    }
    m = COMPLETE_RE.exec(e.message);
    if (m) {
      const turn = open.get(m[1]);
      close(m[1], {
        success: true, outputChars: Number(m[2]), steps: Number(m[3]) || null, provider: m[4],
        ...(m[5] ? { fallbackFrom: m[5] } : {}),
        durationMs: turn ? elapsed(turn.startedAt, e.at) : null,
      });
      continue;
    }
    m = MISS_RE.exec(e.message);
    if (m) {
      const turn = open.get(m[1]);
      close(m[1], { success: true, note: `session miss (${m[2]}); the brain reopens`, durationMs: turn ? elapsed(turn.startedAt, e.at) : null });
      continue;
    }
    m = RID_RE.exec(e.message);
    if (m && e.level === 'ERROR' && open.has(m[1])) {
      const turn = open.get(m[1]);
      close(m[1], { success: false, error: m[2], durationMs: elapsed(turn.startedAt, e.at) });
    }
  }
  for (const turn of open.values()) turns.push({ ...turn, note: 'still running' });
  return turns;
}

/**
 * The events brain-telemetry-write recorded.
 *
 * @param {Array} entries - from parseJournal()
 * @returns {object[]}
 */
export function writtenEvents(entries) {
  return entries
    .filter((e) => e.fields?.event === 'dispatch')
    .map(({ at, fields: f }) => ({
      source: 'telemetry',
      startedAt: f.started_at || at,
      organ: f.organ || '?',
      task: f.task || '',
      durationMs: Number.isFinite(f.duration_ms) ? f.duration_ms : null,
      outputBytes: Number.isFinite(f.output_bytes) ? f.output_bytes : 0,
      exitCode: Number.isFinite(f.exit_code) ? f.exit_code : null,
      success: f.success === true,
      error: f.error || null,
    }));
}

function statusOf(e) {
  if (e.success === true) return '✅ ok';
  if (e.success === false) return '❌ fail';
  return '… running';
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - stdout, stderr, run (runProgram)
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const run = deps.run || runProgram;
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout.write(`${USAGE}\n`); return 0; }

    // Enough journal lines for the turns asked for: each turn logs a start, an end, and a line per
    // tool it ran.
    const lines = String(Math.min(50_000, Math.max(2_000, opts.last * 200)));
    const reads = [
      ['-u', GATEWAY_UNIT, '-o', 'json', '--no-pager', '-n', lines],
      ['-t', TELEMETRY_TAG, '-o', 'json', '--no-pager', '-n', lines],
    ];
    const results = await Promise.all(reads.map((args) => run('journalctl', args)));
    if (results.some((r) => r.code === 127)) {
      throw new CliError('brain-telemetry-read: journalctl is not available; the telemetry lives in the journal on the agent\'s VM');
    }
    // Some journalctl versions exit non-zero when nothing matches; only a failure with a reason is one.
    const failed = results.find((r) => r.code !== 0 && r.stderr.trim() && !/no entries/i.test(r.stderr));
    if (failed) throw new CliError(`brain-telemetry-read: journalctl failed: ${failed.stderr.trim() || `exit ${failed.code}`}`);

    let events = [...gatewayTurns(parseJournal(results[0].stdout)), ...writtenEvents(parseJournal(results[1].stdout))];
    if (opts.organ) events = events.filter((e) => e.organ === opts.organ);
    if (opts.failures) events = events.filter((e) => e.success === false);
    events.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    events = events.slice(0, opts.last);

    if (!events.length) {
      stdout.write('No dispatch events found.\n');
      // journalctl says so when it is hiding the services' entries from this user.
      const hint = results.map((r) => r.stderr).join('\n').split('\n').find((l) => /not seeing messages|systemd-journal/.test(l));
      if (hint) stderr.write(`${hint.trim()}\n`);
      return 0;
    }
    if (opts.json) { stdout.write(`${JSON.stringify(events, null, 2)}\n`); return 0; }

    const out = [`${'TIMESTAMP'.padEnd(24)} ${'ORGAN'.padEnd(20)} ${'DURATION'.padStart(10)} ${'STATUS'.padStart(10)} ${'OUTPUT'.padStart(14)}  ERROR`, '-'.repeat(96)];
    for (const e of events) {
      const ts = e.startedAt ? String(e.startedAt).slice(0, 19).replace('T', ' ') : '?';
      const dur = e.durationMs === null ? '—' : `${(e.durationMs / 1000).toFixed(1)}s`;
      const output = e.source === 'gateway' ? `${e.outputChars} chars` : `${e.outputBytes} bytes`;
      const detail = e.error || (e.fallbackFrom ? `fell back from ${e.fallbackFrom}` : '') || e.note || '';
      out.push(`${ts.padEnd(24)} ${String(e.organ).padEnd(20)} ${dur.padStart(10)} ${statusOf(e).padStart(10)} ${output.padStart(14)}  ${detail}`);
    }
    out.push('', `${events.length} event(s) shown.`);
    stdout.write(`${out.join('\n')}\n`);
    return 0;
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return e instanceof CliError ? e.code : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
