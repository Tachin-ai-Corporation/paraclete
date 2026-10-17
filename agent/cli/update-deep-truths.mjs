#!/usr/bin/env node
// agent/cli/update-deep-truths.mjs: the update-deep-truths command. Lists, adds and removes the
// agent's Deep Truths: the few principles it has confirmed across many sessions, kept as single-line
// bullets ("- ...") in memory/DEEP_TRUTHS.md under the data root. At most ten; adding an eleventh
// drops the oldest. Every line that is not a bullet (a heading, a comment) is kept exactly as it is.
// The file is replaced atomically, so a reader never sees half of it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, createCliRuntime } from './cli-runtime.mjs';

/** The most Deep Truths the file holds. They are principles, not a log. */
export const MAX_DEEP_TRUTHS = 10;

const USAGE = 'Usage: update-deep-truths --add "fact" | --remove "fact" | --list';

function parseArgs(argv) {
  let action = '';
  let fact = '';
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--list') action = 'list';
    else if (a === '--add' || a === '--remove') {
      if (i + 1 >= argv.length) throw new CliError(`${a} needs a fact`);
      action = a.slice(2);
      fact = argv[i += 1];
    } else throw new CliError(`Unknown arg: ${a}`);
  }
  return { action, fact, help };
}

const isFact = (line) => line.startsWith('- ');

/**
 * Splits the file into the lines that are kept as they are and the Deep Truths themselves.
 *
 * @param {string} text
 * @returns {{kept: string[], facts: string[]}} facts without their "- " marker
 */
export function parseDeepTruths(text) {
  const kept = [];
  const facts = [];
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (isFact(line)) facts.push(line.slice(2));
    else kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  return { kept, facts };
}

/** The file's text from its kept lines and its facts. */
export function renderDeepTruths({ kept, facts }) {
  const lines = [...kept];
  if (lines.length && facts.length) lines.push('');
  lines.push(...facts.map((f) => `- ${f}`));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - runtime (paths.data.deepTruthsFile), stdout, stderr, now
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  const log = (msg) => stdout.write(`[${now().toISOString()}] [update-deep-truths] ${msg}\n`);
  try {
    const { action, fact, help } = parseArgs(argv);
    if (help) { stdout.write(`${USAGE}\n`); return 0; }
    if (!action) throw new CliError('Missing action. Use --add, --remove, or --list');
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const file = runtime.paths.data.deepTruthsFile;

    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const doc = parseDeepTruths(before);

    if (action === 'list') {
      if (doc.facts.length === 0) stdout.write('No deep truths found.\n');
      else stdout.write(`Deep Truths (${doc.facts.length} items):\n${doc.facts.map((f) => `- ${f}`).join('\n')}\n`);
      return 0;
    }

    const text = fact.trim();
    if (!text) throw new CliError(`Empty fact — nothing to ${action}`);
    if (/[\r\n]/.test(fact)) throw new CliError('Facts must be single-line. Got multi-line input.');

    let facts;
    if (action === 'add') {
      // A whole-line match: a fact that merely contains another is a different fact.
      if (doc.facts.includes(text)) {
        log('Fact already exists in Deep Truths — skipping');
        stdout.write(`Already exists: ${text}\n`);
        return 0;
      }
      facts = [...doc.facts, text];
      if (facts.length > MAX_DEEP_TRUTHS) {
        const removed = facts.shift();
        log(`Exceeded ${MAX_DEEP_TRUTHS} items — archived oldest: - ${removed}`);
      }
      log(`Added deep truth: ${text}`);
    } else {
      if (!doc.facts.includes(text)) {
        log('Fact not found in Deep Truths');
        stdout.write(`Not found: ${text}\n`);
        return 0;
      }
      facts = doc.facts.filter((f) => f !== text);
      log(`Removed deep truth: ${text}`);
    }

    const after = renderDeepTruths({ kept: doc.kept, facts });
    // Only the bullets may change. Checked on the result before it replaces the file.
    if (parseDeepTruths(after).kept.join('\n') !== doc.kept.join('\n')) {
      throw new CliError('The lines around the Deep Truths changed during the rewrite. Aborting.');
    }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, after);
    renameSync(tmp, file);
    stdout.write('OK\n');
    return 0;
  } catch (e) {
    const message = e instanceof CliError ? e.message : e.message || String(e);
    stderr.write(`[${now().toISOString()}] [update-deep-truths] [FATAL] ${message}\n`);
    return e instanceof CliError ? e.code : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
