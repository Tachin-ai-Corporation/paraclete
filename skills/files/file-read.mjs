#!/usr/bin/env node
// skills/files/file-read.mjs: the file-read command. Prints a file's content as Markdown or plain text
// for the agent to read: PDF, Word, OpenDocument, Rich Text, Excel, CSV, PowerPoint, HTML, Markdown,
// JSON and text, with page, sheet and slide selection. A first line says what the file is and what was
// selected; closing lines say what was cut and what the reading leaves out. An image gets its type and
// size, and the route to look at it. It changes nothing. The reading itself is agent/files/readers.mjs.
// Documented in skills/files/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { loadContracts } from '../../config/contracts.mjs';
import { DEFAULT_MAX_CHARS, readDocument, ReadRequestError } from '../../agent/files/readers.mjs';
import { createRunner } from '../../agent/files/runner.mjs';

export const USAGE = 'Usage: file-read <path> [--pages <1-3,5>] [--sheet <name or number>] [--slides <2,4>] [--format md|text] [--max <chars>]';

/**
 * @param {string[]} argv
 * @returns {{help?: true, error?: string, path?: string, pages?: string, sheet?: string, slides?: string, format?: string, max?: number}}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        pages: { type: 'string' }, sheet: { type: 'string' }, slides: { type: 'string' },
        format: { type: 'string' }, max: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one file at a time, got ${positionals.length}` : 'the path of the file to read is required' };
  const format = values.format ?? 'md';
  if (!['md', 'text'].includes(format)) return { error: `--format must be md or text, not '${format}'` };
  let max = DEFAULT_MAX_CHARS;
  if (values.max !== undefined) {
    max = Number(values.max);
    if (!Number.isInteger(max) || max <= 0) return { error: '--max must be a positive whole number of characters' };
  }
  return { path: positionals[0], pages: values.pages, sheet: values.sheet, slides: values.slides, format, max };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runner]    agent/files/runner.mjs's; default: one with the contracts' tool timeout
 * @param {object} [deps.contracts] default: config/contracts.json
 * @returns {Promise<number>} 0; 1 when the file cannot be read; 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`file-read: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runner = deps.runner || createRunner({ timeoutSeconds: (deps.contracts || loadContracts()).files.tool_timeout_seconds });
    const result = await readDocument(args.path, { runner, format: args.format, pages: args.pages, sheet: args.sheet, slides: args.slides, max: args.max });
    const notes = result.notes.map((n) => `[${n}]`).join('\n');
    stdout.write(`[${result.name}: ${result.header}]\n\n${result.text.replace(/\s+$/, '')}\n${notes ? `\n${notes}\n` : ''}`);
    return 0;
  } catch (err) {
    if (err instanceof ReadRequestError) return fail(err.message, 2);
    if (err.code === 'ENOENT') return fail(`${args.path} does not exist`);
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
