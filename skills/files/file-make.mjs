#!/usr/bin/env node
// skills/files/file-make.mjs: the file-make command. Builds a new file from source the agent wrote:
// Markdown into Word, PDF, HTML or PowerPoint; HTML into PDF, PNG or Word; CSV or JSON into an Excel
// workbook; JSON into CSV. The source comes from a file (--in) or stdin (--stdin), so free text never
// has to survive shell quoting. Prints what it wrote as JSON. The building is agent/files/makers.mjs.
// Documented in skills/files/SKILL.md.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { loadContracts } from '../../config/contracts.mjs';
import { makeFile, MakeRefused, makeTable } from '../../agent/files/makers.mjs';
import { formatForName } from '../../agent/files/formats.mjs';
import { createRunner } from '../../agent/files/runner.mjs';

export const USAGE = [
  'Usage: file-make <format> --from md|html|csv|json (--in <path> | --stdin) --out <name> [--title <title>] [--reference-doc <file>]',
  '       file-make --list',
].join('\n');

/**
 * @param {string[]} argv
 * @returns {object} { help } | { list } | { error } | { format, from, in, stdin, out, title, referenceDoc }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        from: { type: 'string' }, in: { type: 'string' }, stdin: { type: 'boolean' }, out: { type: 'string' },
        title: { type: 'string' }, 'reference-doc': { type: 'string' }, list: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.list) return { list: true };
  if (positionals.length !== 1) return { error: 'give one format to make, like: file-make docx --from md --in report.md --out report.docx' };
  if (!values.from) return { error: '--from md|html|csv|json is required: what the source is' };
  if (values.in === undefined && !values.stdin) return { error: 'give the source with --in <path> or --stdin' };
  if (values.in !== undefined && values.stdin) return { error: 'use --in or --stdin, not both' };
  if (!values.out) return { error: '--out <name> is required: the file to write' };
  return {
    format: positionals[0], from: values.from, in: values.in, stdin: values.stdin === true, out: values.out,
    title: values.title, referenceDoc: values['reference-doc'],
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.readStdin] () => string
 * @param {object} [deps.runner]    agent/files/runner.mjs's; default: one with the contracts' tool timeout
 * @param {object} [deps.contracts] default: config/contracts.json
 * @param {string} [deps.cwd]
 * @returns {Promise<number>} 0; 1 when building failed; 2 for a usage error or a refused combination
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  const readStdin = deps.readStdin || (() => readFileSync(0, 'utf8'));
  const fail = (message, code = 1) => { stderr.write(`file-make: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.list) { stdout.write(`What each source makes (from -> to):\n${makeTable()}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const source = args.stdin ? readStdin() : undefined;
    if (args.stdin && !String(source).trim()) return fail('stdin is empty: pass the source in the runCommand tool\'s stdin field', 2);
    const runner = deps.runner || createRunner({ timeoutSeconds: (deps.contracts || loadContracts()).files.tool_timeout_seconds });
    const made = await makeFile({
      format: args.format, from: args.from, sourcePath: args.in, source, out: args.out,
      title: args.title, referenceDoc: args.referenceDoc, runner, cwd,
    });
    stdout.write(`${JSON.stringify({
      path: made.path, name: basename(made.path), type: formatForName(made.path), size: statSync(made.path).size, notes: made.notes,
    }, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof MakeRefused) return fail(err.message, 2);
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
