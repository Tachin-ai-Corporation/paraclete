#!/usr/bin/env node
// agent/cli/work-log-read.mjs: the work-log-read command. Lists the agent's recent work envelopes
// (requests, missions, checkpoints, tasks) from the root work collection, or drills into one mission:
// its mission, checkpoint and task tree plus its step ledger, the per-task attempts with their
// errors, which is the richest record of why a mission failed. It reads only.

import { pathToFileURL } from 'node:url';
import { StoreUnavailable } from '../storage/firestore.mjs';
import { CliError, checkDocId, createCliRuntime } from './cli-runtime.mjs';

const USAGE = `Usage: work-log-read [OPTIONS]

Options:
  --hours N        Look back N hours (default: 24)
  --recent N       Shorthand for "my last N missions" (implies --type M,
                   --limit N, and a 30-day window).
  --status STATUS  Filter by status (complete, failed, blocked, active, pending, ...)
  --type TYPE      Filter by envelope type (R=request, M=mission, C=checkpoint, T=task)
  --min-steps N    Only show envelopes with N+ children (default: 0)
  --mission ID     Drill ONE mission: print its M->C->T tree + step ledger
                   (per-task attempts with their errors — the richest failure
                   detail for diagnosing why a mission failed)
  --limit N        Max results (default: 50)
  --json           Output as JSON array
  --verbose        Include result/instruction text in output`;

const ICON = {
  complete: '✅', archived: '✅', failed: '❌', blocked: '🚫', needs_input: '❓', cancelled: '⊘',
  active: '🔄', waiting: '⏳', queued: '⏳', pending: '⏳',
};

const VALUED = new Set(['--hours', '--recent', '--status', '--type', '--min-steps', '--mission', '--limit']);
const NUMERIC = new Set(['--hours', '--recent', '--min-steps', '--limit']);

function parseArgs(argv) {
  const opts = { hours: 24, recent: 0, status: '', type: '', minSteps: 0, mission: '', limit: 50, json: false, verbose: false, help: false };
  const key = { '--hours': 'hours', '--recent': 'recent', '--status': 'status', '--type': 'type', '--min-steps': 'minSteps', '--mission': 'mission', '--limit': 'limit' };
  let hoursGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (VALUED.has(a)) {
      if (i + 1 >= argv.length) throw new CliError(`${a} needs a value`);
      const value = argv[i += 1];
      if (NUMERIC.has(a)) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || (a !== '--hours' && !Number.isInteger(n))) throw new CliError(`${a} must be a number, got '${value}'`);
        opts[key[a]] = n;
        if (a === '--hours') hoursGiven = true;
      } else {
        opts[key[a]] = value;
      }
    } else throw new CliError(`Unknown option: ${a}`);
  }
  // --recent N: "my last N missions": missions only, over a 30-day window.
  if (opts.recent > 0) {
    opts.type ||= 'M';
    opts.limit = opts.recent;
    if (!hoursGiven) opts.hours = 720;
  }
  if (opts.limit < 1) throw new CliError('--limit must be at least 1');
  return opts;
}

const childIds = (env) => (Array.isArray(env.children) ? env.children.filter((c) => typeof c === 'string') : []);

function durationSec(env) {
  if (!env.created_at || !env.completed_at) return null;
  const ms = Date.parse(String(env.completed_at).slice(0, 19) + 'Z') - Date.parse(String(env.created_at).slice(0, 19) + 'Z');
  return Number.isFinite(ms) ? Math.trunc(ms / 1000) : null;
}

/** Prints one mission's tree, walking `children`, and its step ledger. */
async function drill(db, workCollection, missionId, opts, print) {
  checkDocId(missionId, '--mission');
  const mission = await db.read(`${workCollection}/${missionId}`, { strict: true });
  if (!mission) throw new CliError('Mission not found or inaccessible.');
  mission.id = missionId;

  // One read per envelope in this mission, not a time window over all work: inspecting one mission
  // must not cost the agent a scan of everything it did that day.
  const nodes = [];
  const seen = new Set();
  async function walk(env, depth) {
    nodes.push({ depth, env });
    for (const cid of childIds(env)) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      const child = await db.read(`${workCollection}/${cid}`, { strict: true });
      if (child) await walk({ ...child, id: cid }, depth + 1);
      else nodes.push({ depth: depth + 1, env: { id: cid, type: '?', status: 'missing' } });
    }
  }
  await walk(mission, 0);

  if (opts.json) {
    print(JSON.stringify(nodes.map(({ depth, env }) => ({ depth, ...env })), null, 1));
    return;
  }
  const lines = ['', `MISSION ${mission.id}  [${mission.status}]`, `  ${String(mission.title || '').slice(0, 90)}`];
  const instruction = String(mission.instruction || '').slice(0, 400);
  if (instruction) lines.push(`  instruction: ${instruction}`);
  if (mission.error) lines.push(`  error: ${String(mission.error).slice(0, 300)}`);
  lines.push(`  ${'─'.repeat(60)}`);
  for (const { depth, env } of nodes.slice(1)) {
    const pad = '    '.repeat(depth);
    lines.push(`  ${pad}[${ICON[env.status] || '  '}] ${env.type || '?'} ${env.intent || ''} :: ${String(env.title || '').slice(0, 70)}`);
    if (env.error) lines.push(`  ${pad}      error: ${String(env.error).slice(0, 200)}`);
    if (opts.verbose && env.output) lines.push(`  ${pad}      output: ${String(env.output).slice(0, 200).trim()}`);
  }

  // The step ledger lives on the mission envelope, not in the tree, so a tree walk alone never
  // shows it. The last 25 attempts.
  const ledger = mission.step_ledger;
  if (ledger && typeof ledger === 'object' && Object.keys(ledger).length) {
    lines.push('', '  STEP LEDGER — per-task attempts (richest failure detail):');
    const entries = Object.values(ledger).map((r) => r || {})
      .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    for (const rec of entries.slice(-25)) {
      const st = rec.status || '?';
      lines.push(`    [${ICON[st] || '  '}] ${st}  ${rec.timestamp || ''}${rec.durationMs ? `  (${rec.durationMs}ms)` : ''}`);
      if (rec.error) lines.push(`        error: ${String(rec.error).slice(0, 260)}`);
    }
  }
  lines.push('', `${nodes.length} node(s) in mission tree.`);
  print(lines);
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
  const print = (lines) => stdout.write(`${[].concat(lines).join('\n')}\n`);
  try {
    const opts = parseArgs(argv);
    if (opts.help) { print(USAGE); return 0; }
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { db, collections } = runtime;

    if (opts.mission) {
      await drill(db, collections.work, opts.mission, opts, print);
      return 0;
    }

    const cutoff = new Date(now().getTime() - opts.hours * 3_600_000).toISOString();
    // At most one equality filter goes to Firestore with the time window (type when given, else
    // status): each pairing is one composite index, and asking for both at once needs a third that
    // a missing index would turn into a failed read. The other filter is applied here.
    const filters = [{ field: 'created_at', op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: cutoff } }];
    const local = {};
    if (opts.type) {
      filters.push({ field: 'type', op: 'EQUAL', value: { stringValue: opts.type } });
      if (opts.status) local.status = opts.status;
    } else if (opts.status) {
      filters.push({ field: 'status', op: 'EQUAL', value: { stringValue: opts.status } });
    }
    const docs = await db.query('', collections.work, filters,
      { orderBy: 'created_at', orderDirection: 'DESCENDING', limit: opts.limit, strict: true });

    const envelopes = docs
      .filter((d) => Object.entries(local).every(([k, v]) => d[k] === v))
      .map((d) => ({
        id: d.id,
        type: d.type || '',
        status: d.status || '',
        title: d.title || '',
        instruction: typeof d.instruction === 'string' ? d.instruction : '',
        output: typeof d.output === 'string' ? d.output : '',
        created_at: d.created_at || '',
        completed_at: d.completed_at || '',
        intent: d.intent || '',
        source_channel: d.source_channel || '',
        project_id: d.project_id || '',
        childCount: childIds(d).length,
        child_ids: childIds(d),
        process_id: d.process_id || '',
        durationSec: durationSec(d),
      }))
      .filter((e) => opts.minSteps === 0 || e.childCount >= opts.minSteps);

    if (!envelopes.length) { print('No work envelopes found matching criteria.'); return 0; }

    if (opts.json) {
      if (!opts.verbose) {
        for (const e of envelopes) {
          if (e.instruction.length > 200) e.instruction = `${e.instruction.slice(0, 200)}...`;
          if (e.output.length > 300) e.output = `${e.output.slice(0, 300)}...`;
        }
      }
      print(JSON.stringify(envelopes, null, 2));
      return 0;
    }

    const lines = ['', `${'ID'.padEnd(35)} ${'TYPE'.padEnd(4)} ${'STATUS'.padEnd(12)} ${'CHILDREN'.padEnd(9)} ${'DURATION'.padEnd(10)} TITLE`, '─'.repeat(110)];
    for (const e of envelopes) {
      const dur = e.durationSec !== null ? `${e.durationSec}s` : '—';
      const title = (e.title || e.instruction || '—').slice(0, 45);
      lines.push(`${e.id.padEnd(35)} ${e.type.padEnd(4)} ${ICON[e.status] || '?'} ${e.status.padEnd(10)} ${(e.childCount ? String(e.childCount) : '—').padEnd(9)} ${dur.padEnd(10)} ${title}`);
      if (opts.verbose && e.output) lines.push(`   └─ Output: ${e.output.slice(0, 200).replace(/\n/g, ' ')}`);
      if (opts.verbose && e.process_id) lines.push(`   └─ Process: ${e.process_id}`);
    }
    lines.push('', `${envelopes.length} envelope(s) shown.`);
    print(lines);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreUnavailable) { stderr.write(`ERROR: the work records could not be read: ${e.message}\n`); return 1; }
    stderr.write(`ERROR: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
