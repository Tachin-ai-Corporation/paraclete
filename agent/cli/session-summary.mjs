#!/usr/bin/env node
// agent/cli/session-summary.mjs: the session-summary command. Summarizes the missions the agent
// completed in the last hours, from the root work collection: each one's request, result and, for a
// long mission, its compaction digest (claims already condensed while it ran, with their learnings).
// The nightly memory consolidation reads it to decide what to remember. It reads only.

import { pathToFileURL } from 'node:url';
import { StoreUnavailable } from '../storage/firestore.mjs';
import { CliError, createCliRuntime } from './cli-runtime.mjs';

/** How many of the newest missions one run looks through for completed ones. */
const SCAN_LIMIT = 300;

const USAGE = `Usage: session-summary [--hours 24] [--limit 20] [--exclude-intent <intent>]
Summarizes the missions completed in the last --hours, newest first, for memory consolidation.`;

function parseArgs(argv) {
  const opts = { hours: 24, limit: 20, excludeIntent: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a !== '--hours' && a !== '--limit' && a !== '--exclude-intent') throw new CliError(`Unknown option: ${a}`);
    if (i + 1 >= argv.length) throw new CliError(`${a} needs a value`);
    const value = argv[i += 1];
    if (a === '--exclude-intent') { opts.excludeIntent = value; continue; }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || (a === '--limit' && !Number.isInteger(n))) {
      throw new CliError(`${a} must be a positive number, got '${value}'`);
    }
    opts[a.slice(2)] = n;
  }
  return opts;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr, now
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout.write(`${USAGE}\n`); return 0; }
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const cutoff = new Date(now().getTime() - opts.hours * 3_600_000).toISOString();

    // The newest missions by creation, filtered here to the completed ones in the window. Asking
    // Firestore for "complete missions" with a limit and no order returned an arbitrary few, often
    // the oldest, so a busy week hid the last day's work.
    const missions = await runtime.db.query('', runtime.collections.work,
      [{ field: 'type', op: 'EQUAL', value: { stringValue: 'M' } }],
      { orderBy: 'created_at', orderDirection: 'DESCENDING', limit: SCAN_LIMIT, strict: true });
    const shown = missions
      .filter((m) => m.status === 'complete' && typeof m.completed_at === 'string' && m.completed_at >= cutoff)
      .filter((m) => !(opts.excludeIntent && m.intent === opts.excludeIntent))
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
      .slice(0, opts.limit);

    const lines = [];
    shown.forEach((m, i) => {
      const instruction = typeof m.instruction === 'string' ? m.instruction : '';
      const output = typeof m.output === 'string' ? m.output : '';
      let display = m.title || instruction.slice(0, 200) || '?';
      if (m.intent === 'respond') display = `[chat] ${display}`;
      lines.push(`--- Mission ${i + 1}: ${display} ---`);
      lines.push(`  Completed: ${m.completed_at}`);
      if (instruction) lines.push(`  Request: ${instruction.slice(0, 300)}`);
      if (output) lines.push(`  Result: ${output.slice(0, m.intent === 'respond' ? 100 : 300)}`);

      // A long mission carries its compaction digest: claims already condensed and binned while it
      // ran, which make better consolidation input than the raw output.
      const comp = m._compaction && typeof m._compaction === 'object' ? m._compaction : null;
      const learnings = Array.isArray(comp?.durable_learnings) ? comp.durable_learnings : [];
      if (comp && (comp.covered || learnings.length)) {
        lines.push(`  Digest: compaction seq ${comp.seq ?? ''}, iterations ${comp.covered || '?'}`);
        for (const l of learnings) if (typeof l === 'string' && l) lines.push(`    - learning: ${l.slice(0, 300)}`);
      }
      lines.push('');
    });

    if (shown.length === 0) lines.push('No recent completed missions found.');
    else lines.push(`--- ${shown.length} completed missions in the last ${opts.hours} hours ---`);
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreUnavailable) {
      stderr.write(`session-summary: the work records could not be read (${e.message}). This is an outage, not a quiet day.\n`);
      return 1;
    }
    stderr.write(`session-summary: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
