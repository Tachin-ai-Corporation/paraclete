#!/usr/bin/env node
// agent/cli/core-memory-retire.mjs: the core-memory-retire command. Marks an active Core Memory entry
// retired, with a reason and a time, when its fact is no longer true or useful and nothing replaces
// it. A fact that has a replacement is written with core-memory-write --supersedes instead. The
// entry stays in the root core_memory collection: retiring never deletes.

import { pathToFileURL } from 'node:url';
import { firestoreEncode, StoreUnavailable } from '../storage/firestore.mjs';
import { CliError, checkDocId, createCliRuntime } from './cli-runtime.mjs';

const USAGE = 'Usage: core-memory-retire --id <entry-id> --reason "<reason>"';
const DEFAULT_REASON = 'Retired during nightly consolidation';

function parseArgs(argv) {
  const opts = { id: '', reason: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a !== '--id' && a !== '--reason') throw new CliError(`Unknown option: ${a}`);
    if (i + 1 >= argv.length) throw new CliError(`${a} needs a value`);
    opts[a.slice(2)] = argv[i += 1];
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
    if (opts.help) {
      stdout.write(`${USAGE}\nMarks an active Core Memory entry as retired.\n`);
      return 0;
    }
    if (!opts.id) { stderr.write(`${USAGE}\n`); return 1; }
    checkDocId(opts.id, '--id');
    const reason = opts.reason || DEFAULT_REASON;
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const path = `${runtime.collections.coreMemory}/${opts.id}`;

    const existing = await runtime.db.read(path, { strict: true });
    if (!existing) { stderr.write(`❌ Entry not found: ${opts.id}\n`); return 1; }
    const previous = existing.status || 'unknown';
    if (previous === 'retired') { stdout.write(`Already retired: ${opts.id}\n`); return 0; }
    if (previous === 'superseded') { stdout.write(`Already superseded: ${opts.id} — skipping retirement\n`); return 0; }

    const retiredAt = now().toISOString().replace(/\.\d{3}Z$/, 'Z');
    await runtime.db.patch(path, ['status', 'retiredAt', 'retireReason'],
      firestoreEncode({ status: 'retired', retiredAt, retireReason: reason }), { strict: true });

    stdout.write([
      `✅ Core memory retired: ${opts.id}`,
      `  Reason: ${reason}`,
      `  Retired at: ${retiredAt}`,
      `  Previous status: ${previous}`,
    ].join('\n') + '\n');
    return 0;
  } catch (e) {
    if (e instanceof CliError) { stderr.write(`${e.message}\n`); return e.code; }
    if (e instanceof StoreUnavailable) {
      stderr.write(`❌ Failed to retire entry: ${e.message}\n`);
      return 1;
    }
    stderr.write(`core-memory-retire: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
