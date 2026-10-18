#!/usr/bin/env node
// skills/workspace-sheets/sheets-append.mjs: the sheets-append command. Adds rows after the table on a
// tab of a Google Sheet the agent's own account owns (one it created): rows given as JSON, or read from
// a CSV file in the mission tree. Values are read as if typed into the sheet (numbers, dates, formulas)
// unless --raw. A spreadsheet someone else owns is refused before anything is written. It also exports
// what sheets-update shares: the rows from --values or --csv. The Sheets calls are
// agent/providers/workspace-sheets.mjs. Documented in skills/workspace-sheets/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createSheetsClient, quoteTab, tabRange } from '../../agent/providers/workspace-sheets.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { parseCsv } from '../../agent/files/csv.mjs';
import { localFile } from '../drive/drive-put.mjs';
import { findTab } from './sheets-get.mjs';

export const USAGE = 'Usage: sheets-append <sheet link or id> --tab <tab name> [--range <columns, e.g. A:D>] (--values <JSON rows> | --csv <csv file> --mission <mission id>) [--raw] [--json]';

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CELLS = 50_000;

/**
 * Rows from JSON: a list of rows (each a list of cells), or one flat list as one row. A cell is text,
 * a number, true/false, or null (empty).
 *
 * @param {string} text
 * @returns {Array<Array<string|number|boolean>>}
 * @throws {Error} in plain words
 */
export function parseValues(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('--values is not JSON: write rows as [["Ana", 3, "done"], ["Bo", 5, "open"]]');
  }
  if (!Array.isArray(data) || !data.length) throw new Error('--values holds rows: [["a", 1], ["b", 2]]');
  const rows = data.every(Array.isArray) ? data : (data.some(Array.isArray) ? null : [data]);
  if (!rows) throw new Error('--values mixes rows and single cells: make every row a list');
  return rows.map((row, r) => row.map((cell, c) => {
    if (cell === null) return '';
    if (['string', 'number', 'boolean'].includes(typeof cell)) return cell;
    throw new Error(`row ${r + 1}, cell ${c + 1} is not text, a number or true/false`);
  }));
}

/**
 * The rows a write command was given: --values, or a CSV file checked as drive-put checks one.
 *
 * @param {{values?: string, csv?: string, mission?: string}} args
 * @param {object} runtime from createCliRuntime(): contracts, paths
 * @returns {Array<Array<*>>}
 */
export function rowsFrom({ values, csv, mission }, runtime) {
  const rows = values !== undefined
    ? parseValues(values)
    : parseCsv(localFile(csv, { mission, paths: runtime.paths, maxBytes: runtime.contracts.files.max_mb * 1024 * 1024 }).bytes.toString('utf8'));
  if (!rows.length) throw new Error('there are no rows to write');
  const cells = rows.reduce((n, r) => n + r.length, 0);
  if (cells > MAX_CELLS) throw new Error(`${cells} cells is more than ${MAX_CELLS} in one write: split it`);
  return rows;
}

/**
 * Checks the shared input options: exactly one of --values and --csv, and --mission with --csv.
 *
 * @returns {string|null} the problem
 */
export function inputProblem({ values, csv, mission }) {
  if ((values === undefined) === (csv === undefined)) return 'give the rows: --values <JSON rows>, or --csv <file> --mission <mission id>';
  if (csv !== undefined && mission === undefined) return '--csv needs --mission <mission id>: a relative path starts from the mission tree';
  if (mission !== undefined && !MISSION_ID.test(mission)) return `'${mission}' is not a mission id`;
  if (values !== undefined) {
    try { parseValues(values); } catch (err) { return err.message; }
  }
  return null;
}

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
  if (!values.tab?.trim()) return { error: '--tab is required: the tab to add rows to (sheets-get lists them)' };
  if (values.range !== undefined && !/^[A-Za-z]{1,3}\d*(:[A-Za-z]{1,3}\d*)?$/.test(values.range)) return { error: '--range is the table\'s columns on that tab, like A:D, without the tab name' };
  const problem = inputProblem(values);
  if (problem) return { error: problem };
  return { id, tab: values.tab, span: values.range, values: values.values, csv: values.csv, mission: values.mission, raw: values.raw === true, json: values.json === true };
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
  const fail = (message, code = 1) => { stderr.write(`sheets-append: ${message}\n`); return code; };

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
    const range = args.span ? tabRange(tab.title, args.span) : quoteTab(tab.title);
    const result = await sheets.append(args.id, range, rows, { raw: args.raw });
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: args.id, range: result.updatedRange, rows: result.updatedRows, cells: result.updatedCells }, null, 2)}\n`);
      return 0;
    }
    stdout.write([
      `Added ${result.updatedRows} row${result.updatedRows === 1 ? '' : 's'} to "${result.file.name}", tab "${tab.title}": ${result.updatedRange} (${result.updatedCells} cells).`,
      `Check them with: sheets-get ${args.id} --range "${result.updatedRange}"`,
      '',
    ].join('\n'));
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
