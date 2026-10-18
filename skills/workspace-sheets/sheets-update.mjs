#!/usr/bin/env node
// skills/workspace-sheets/sheets-update.mjs: the sheets-update command. Writes values into exactly the
// cells a range names, on a tab of a Google Sheet the agent's own account owns (one it created): rows
// given as JSON, or read from a CSV file in the mission tree. Only those cells change; formatting,
// other cells and other tabs stay as they are. A spreadsheet someone else owns is refused before
// anything is written. The Sheets calls are agent/providers/workspace-sheets.mjs. Documented in
// skills/workspace-sheets/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createSheetsClient, tabRange } from '../../agent/providers/workspace-sheets.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { findTab } from './sheets-get.mjs';
import { inputProblem, rowsFrom } from './sheets-append.mjs';

export const USAGE = 'Usage: sheets-update <sheet link or id> --tab <tab name> --range <cells, e.g. B2 or B2:D5> (--values <JSON rows> | --csv <csv file> --mission <mission id>) [--raw] [--json]';

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { id, tab, span, values, csv, mission, raw, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        tab: { type: 'string' }, range: { type: 'string' }, values: { type: 'string' }, csv: { type: 'string' },
        mission: { type: 'string' }, raw: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one spreadsheet at a time, got ${positionals.length}` : 'a Google Sheet link or id is required' };
  const id = parseDriveLink(positionals[0]);
  if (!id) return { error: `'${positionals[0]}' is not a Google Sheet link or id` };
  if (!values.tab?.trim()) return { error: '--tab is required: the tab to write on (sheets-get lists them)' };
  if (!values.range) return { error: '--range is required: the first cell to write (B2), or the block (B2:D5)' };
  if (!/^[A-Za-z]{1,3}\d+(:[A-Za-z]{1,3}\d+)?$/.test(values.range)) return { error: '--range is cells on that tab, like B2 or B2:D5, without the tab name' };
  const problem = inputProblem(values);
  if (problem) return { error: problem };
  return { id, tab: values.tab, span: values.range.toUpperCase(), values: values.values, csv: values.csv, mission: values.mission, raw: values.raw === true, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, contracts, paths
 * @param {object} [deps.sheets]  from createSheetsClient()
 * @returns {Promise<number>} 0, 1 when Google or a rule refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`sheets-update: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || (args.csv !== undefined || !deps.sheets ? createCliRuntime({ stderr }) : null);
    const sheets = deps.sheets || createSheetsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const rows = rowsFrom(args, runtime);
    let tab;
    try {
      tab = findTab(await sheets.info(args.id), args.tab);
    } catch (err) {
      if (err.kind) throw err;
      return fail(err.message, 2);
    }
    const result = await sheets.update(args.id, tabRange(tab.title, args.span), rows, { raw: args.raw });
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: args.id, range: result.updatedRange, rows: result.updatedRows, cells: result.updatedCells }, null, 2)}\n`);
      return 0;
    }
    stdout.write([
      `Wrote ${result.updatedCells} cell${result.updatedCells === 1 ? '' : 's'} in "${result.file.name}": ${result.updatedRange}. Nothing else changed.`,
      `Check them with: sheets-get ${args.id} --range "${result.updatedRange}"`,
      '',
    ].join('\n'));
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
