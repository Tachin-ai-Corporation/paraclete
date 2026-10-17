#!/usr/bin/env node
// agent/cli/core-memory-write.mjs: the core-memory-write command. Writes one new entry into the
// agent's Core Memory (the root core_memory collection) and, with --supersedes, marks the entry it
// replaces as superseded. It never edits an entry's fact in place: a changed fact is a new entry that
// supersedes the old one. core-memory-retire retires an entry with no replacement.
//
// The `resources` category is the name-to-id table, not narrative memory: one entry per identifier,
// written as  <kind>: "<name>" = <id>  (for example  folder: "templates" = 1AbC...). Writing a new
// entry with --supersedes when an id changes keeps one row per name, and keeps the agent from
// searching for the same folder on every mission.

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { firestoreEncode, StoreConflict, StoreUnavailable } from '../storage/firestore.mjs';
import { CliError, checkDocId, createCliRuntime } from './cli-runtime.mjs';

const CATEGORIES = 'architecture, operations, iam, decisions, patterns, errors, resources';

const USAGE = `Usage: core-memory-write --fact "<text>" --category <category> [options]
Categories: ${CATEGORIES}

Options:
  --tags "a,b"               comma-separated tags
  --confidence 0.9           how sure the fact is, 0 to 1 (default 0.9)
  --importance 0.5           how much the fact matters, 0 to 1 (default 0.5)
  --source observation       where the fact came from (default observation)
  --source-detail "<text>"   more about the source
  --supersedes <entry-id>    the entry this one replaces; it is marked superseded

resources entries are one identifier each:  <kind>: "<name>" = <id>`;

const VALUED = {
  '--fact': 'fact',
  '--category': 'category',
  '--tags': 'tags',
  '--confidence': 'confidence',
  '--importance': 'importance',
  '--source': 'source',
  '--source-detail': 'sourceDetail',
  '--supersedes': 'supersedes',
};

function parseArgs(argv) {
  const opts = { fact: '', category: '', tags: '', confidence: '0.9', importance: '0.5', source: 'observation', sourceDetail: '', supersedes: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (!Object.hasOwn(VALUED, a)) throw new CliError(`Unknown option: ${a}`);
    if (i + 1 >= argv.length) throw new CliError(`${a} needs a value`);
    opts[VALUED[a]] = argv[i += 1];
  }
  return opts;
}

function unitInterval(raw, flag) {
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || n < 0 || n > 1) throw new CliError(`${flag} must be a number from 0 to 1, got '${raw}'`);
  return n;
}

/** A timestamp to the second, the format every Core Memory date is stored in. */
const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime, stdout, stderr, now, randomHex
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  const randomHex = deps.randomHex || (() => randomBytes(4).toString('hex'));
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout.write(`${USAGE}\n`); return 0; }
    if (!opts.fact || !opts.category) {
      stderr.write(`Usage: core-memory-write --fact "<text>" --category <category> [options]\nCategories: ${CATEGORIES}\n`);
      return 1;
    }
    const confidence = unitInterval(opts.confidence, '--confidence');
    const importance = unitInterval(opts.importance, '--importance');
    if (opts.supersedes) checkDocId(opts.supersedes, '--supersedes');
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const { db, collections } = runtime;

    const at = now();
    const timestamp = isoSeconds(at);
    const entryId = `mem-${timestamp.slice(0, 10).replace(/-/g, '')}-${randomHex()}`;
    const tags = opts.tags.split(',').map((t) => t.trim()).filter(Boolean);
    const entry = {
      id: entryId,
      fact: opts.fact,
      category: opts.category,
      tags,
      confidence,
      importance,
      source: opts.source,
      ...(opts.sourceDetail ? { sourceDetail: opts.sourceDetail } : {}),
      ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
      supersededBy: null,
      createdAt: timestamp,
      lastRecalledAt: timestamp,
      recallCount: 0,
      status: 'active',
    };
    // Create only: a new entry never overwrites an existing one.
    await db.commit([{ path: `${collections.coreMemory}/${entryId}`, data: entry, precondition: { exists: false } }]);

    const lines = [
      `✅ Core memory written: ${entryId}`,
      `  Category: ${opts.category}`,
      `  Fact: ${opts.fact}`,
      `  Confidence: ${opts.confidence}`,
      `  Source: ${opts.source}`,
    ];

    if (opts.supersedes) {
      // The old entry is checked first: a field-masked update of a missing document would create a
      // stray entry holding nothing but these two fields.
      const oldPath = `${collections.coreMemory}/${opts.supersedes}`;
      let updated = false;
      try {
        if (await db.read(oldPath, { strict: true })) {
          await db.patch(oldPath, ['supersededBy', 'status'], firestoreEncode({ supersededBy: entryId, status: 'superseded' }), { strict: true });
          updated = true;
        }
      } catch { /* reported below */ }
      if (updated) lines.push(`  Superseded: ${opts.supersedes}`);
      else stderr.write(`  Warning: could not update superseded entry ${opts.supersedes}\n`);
    }
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreConflict || e instanceof StoreUnavailable) {
      stderr.write(`❌ Failed to write core memory\n${e.message}\n`);
      return 1;
    }
    stderr.write(`core-memory-write: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
