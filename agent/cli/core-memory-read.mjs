#!/usr/bin/env node
// agent/cli/core-memory-read.mjs: the core-memory-read command. Reads the agent's Core Memory (the
// root core_memory collection), filters it, ranks it by value and prints it. It never writes:
// core-memory-write and core-memory-retire do. Run by the agent's organs, the memory organ included.
//
// Firestore has no substring search, so --query matches terms against each entry's fact and tags
// here, over the entries the filters return, with the ranking recall uses
// (agent/context/core-memory-rank.mjs).

import { pathToFileURL } from 'node:url';
import { StoreUnavailable } from '../storage/firestore.mjs';
import { rankCoreMemory } from '../context/core-memory-rank.mjs';
import { CliError, createCliRuntime } from './cli-runtime.mjs';

/** The most entries one read searches. Core Memory is pruned nightly and stays far below this. */
const FETCH_LIMIT = 300;

const USAGE = `Usage: core-memory-read [--category <category>] [--query "<search terms>"] [--status active] [--limit 10] [--since <Nd>]

Categories: architecture, operations, iam, decisions, patterns, errors, resources
  resources is the name-to-id table: one entry per identifier (folder, doc, space).
--category all (or *) reads every category.
--query     matches terms against each entry's fact and tags; matching entries rank higher.
--status    active (default), superseded or retired.
--since     only entries created in the last N days, e.g. 7d or 30d.
Entries print by value: importance x confidence x (1 + matched terms), newest first on a tie.`;

const VALUED = new Set(['--category', '--query', '--status', '--limit', '--since']);

function parseArgs(argv) {
  const opts = { category: '', query: '', status: 'active', limit: 10, since: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (!VALUED.has(a)) throw new CliError(`Unknown option: ${a}`);
    if (i + 1 >= argv.length) throw new CliError(`${a} needs a value`);
    const value = argv[i += 1];
    if (a === '--limit') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new CliError(`--limit must be a positive whole number, got '${value}'`);
      opts.limit = n;
    } else {
      opts[a.slice(2)] = value;
    }
  }
  // `--category all` (or `*`) means every category. It once became a literal filter
  // category == "all", matched nothing, and printed "no entries", which a consolidation read as
  // "Core Memory is empty" and then filled it with copies of project facts.
  if (opts.category === 'all' || opts.category === '*') opts.category = '';
  return opts;
}

/** A number as Python printed it: whole numbers keep one decimal place (1.0, not 1). */
const showNumber = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(1) : String(v)) : '?');

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

    let sinceTimestamp = '';
    if (opts.since) {
      const days = /^(\d+)d$/.exec(opts.since);
      if (days) sinceTimestamp = new Date(now().getTime() - Number(days[1]) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      else stderr.write(`Warning: could not parse --since '${opts.since}', ignoring time filter\n`);
    }

    // With --since, the range filter is the only one sent to Firestore and status and category are
    // applied here: an equality filter plus a range on another field needs a composite index, and a
    // missing index fails the whole read.
    const filters = [];
    const local = {};
    if (sinceTimestamp) {
      filters.push({ field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: sinceTimestamp } });
      if (opts.status) local.status = opts.status;
      if (opts.category) local.category = opts.category;
    } else {
      if (opts.status) filters.push({ field: 'status', op: 'EQUAL', value: { stringValue: opts.status } });
      if (opts.category) filters.push({ field: 'category', op: 'EQUAL', value: { stringValue: opts.category } });
    }

    // Every matching entry is read, then ranked, then cut to --limit. Cutting first would search
    // only the first few entries Firestore happened to return.
    const docs = await runtime.db.query('', runtime.collections.coreMemory, filters, { noOrderBy: true, strict: true, limit: FETCH_LIMIT });
    const filtered = docs.filter((d) => Object.entries(local).every(([k, v]) => d[k] === v));
    const terms = opts.query.trim() ? opts.query.trim().toLowerCase().split(/\s+/) : [];
    const shown = rankCoreMemory(filtered, terms).slice(0, opts.limit);

    const lines = [];
    for (const e of shown) {
      lines.push(`[${e.category ?? '?'}] (${e.id}) ${e.fact ?? '?'}`);
      lines.push(`  confidence: ${showNumber(e.confidence)} | source: ${e.source ?? '?'} | status: ${e.status ?? '?'}`);
      lines.push(`  created: ${e.createdAt ?? '?'}`);
      lines.push('');
    }
    if (shown.length === 0) {
      // Say what was filtered. A filtered read that matches nothing is not an empty memory: reading
      // it as one is how a consolidation once decided Core Memory was empty and refilled it with
      // copies of project facts.
      const scope = [['category', opts.category], ['query', opts.query.trim()], ['status', opts.status], ['since', opts.since]]
        .filter(([, v]) => v)
        .map(([label, v]) => `${label} '${v}'`);
      lines.push(`No core memory entries matched${scope.length ? ` (${scope.join(', ')})` : ''}.`);
      if (opts.category || opts.query.trim() || opts.since) {
        lines.push('This read was FILTERED — it does not mean memory is empty. Omit --category/--query/--since to read every entry before concluding that.');
      }
    } else {
      lines.push(`--- ${shown.length} entries ---`);
    }
    if (docs.length >= FETCH_LIMIT) {
      lines.push(`(Searched the first ${FETCH_LIMIT} entries, the most one read covers. Narrow with --category or --since to search the rest.)`);
    }
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreUnavailable) {
      stderr.write(`core-memory-read: Core Memory could not be read (${e.message}). This is an outage, not an empty memory.\n`);
      return 1;
    }
    stderr.write(`core-memory-read: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
