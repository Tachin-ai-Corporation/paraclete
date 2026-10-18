#!/usr/bin/env node
// skills/files/file-convert.mjs: the file-convert command. Converts a file to another format (Word,
// PDF, HTML, Markdown, text, Excel, CSV, PowerPoint, PNG, JPEG, WebP), renders pages and slides to PNG,
// shrinks images, extracts PDF pages, and merges PDFs. Prints what it wrote as JSON, with what the
// conversion leaves out. A conversion that does not exist is refused with the ones that do. The
// conversions are agent/files/converters.mjs. Documented in skills/files/SKILL.md.

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { loadContracts } from '../../config/contracts.mjs';
import { conversionTable, ConversionRefused, convertFile, mergePdfs } from '../../agent/files/converters.mjs';
import { formatForName } from '../../agent/files/formats.mjs';
import { createRunner } from '../../agent/files/runner.mjs';

export const USAGE = [
  'Usage: file-convert <path> <format> [--out <path>] [--pages <1-3,5>] [--sheet <name or number>] [--max-side <px>] [--size <width>x<height>]',
  '       file-convert --merge <a.pdf> <b.pdf> [<more.pdf> ...] [--out <path>]',
  '       file-convert --list',
].join('\n');

/** The largest side an image may be asked for: what the image tool accepts. */
const MAX_SIDE_LIMIT = 8000;

/**
 * @param {string[]} argv
 * @returns {object} { help } | { list } | { error } | { merge: string[], out } | { path, format, out, pages, sheet, maxSide, size }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string' }, pages: { type: 'string' }, sheet: { type: 'string' }, 'max-side': { type: 'string' },
        size: { type: 'string' }, merge: { type: 'boolean' }, list: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.list) return { list: true };
  if (values.merge) {
    if (values.pages || values.sheet || values['max-side'] || values.size) return { error: '--merge takes only PDFs and --out' };
    if (positionals.length < 2) return { error: '--merge needs at least two PDFs' };
    return { merge: positionals, out: values.out };
  }
  if (positionals.length !== 2) return { error: 'give the file and the format to convert it to, like: file-convert report.docx pdf' };
  let maxSide;
  if (values['max-side'] !== undefined) {
    maxSide = Number(values['max-side']);
    if (!Number.isInteger(maxSide) || maxSide < 16 || maxSide > MAX_SIDE_LIMIT) return { error: `--max-side must be a whole number of pixels from 16 to ${MAX_SIDE_LIMIT}` };
  }
  let size;
  if (values.size !== undefined) {
    const m = /^(\d{2,5})x(\d{2,5})$/i.exec(values.size);
    if (!m || Number(m[1]) > MAX_SIDE_LIMIT || Number(m[2]) > MAX_SIDE_LIMIT) return { error: `--size must be <width>x<height> in pixels, each at most ${MAX_SIDE_LIMIT}, like 1280x800` };
    size = { width: Number(m[1]), height: Number(m[2]) };
  }
  return { path: positionals[0], format: positionals[1], out: values.out, pages: values.pages, sheet: values.sheet, maxSide, size };
}

/** What a written file is, for the printed record. */
function described(path) {
  return { path, name: basename(path), type: formatForName(path), size: statSync(path).size };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runner]    agent/files/runner.mjs's; default: one with the contracts' tool timeout
 * @param {object} [deps.contracts] default: config/contracts.json
 * @param {string} [deps.cwd]
 * @returns {Promise<number>} 0; 1 when the conversion failed; 2 for a usage error or a refused conversion
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  const fail = (message, code = 1) => { stderr.write(`file-convert: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.list) { stdout.write(`Every conversion (from -> to):\n${conversionTable()}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runner = deps.runner || createRunner({ timeoutSeconds: (deps.contracts || loadContracts()).files.tool_timeout_seconds });
    const result = args.merge
      ? await mergePdfs(args.merge, { runner, out: args.out, cwd })
      : await convertFile(args.path, args.format, {
        runner, out: args.out, pages: args.pages, sheet: args.sheet, maxSide: args.maxSide, size: args.size, cwd,
      });
    stdout.write(`${JSON.stringify({ from: result.from, to: result.to, outputs: result.outputs.map(described), notes: result.notes }, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ConversionRefused) return fail(err.message, 2);
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
