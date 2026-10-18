#!/usr/bin/env node
// skills/workspace-sheets/sheets-get.mjs: the sheets-get command. Reads a Google Sheet: who owns it and
// what the agent may do with it, its tabs with their sizes, and a range of cells (the first tab's first
// rows when none is named) as a Markdown table labelled with row numbers and column letters, so a later
// write can name the exact cell; or as CSV, alone on stdout, for a file. The Sheets calls are
// agent/providers/workspace-sheets.mjs. Documented in skills/workspace-sheets/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createSheetsClient, quoteTab, tabRange, rangeStart, addressedRows } from '../../agent/providers/workspace-sheets.mjs';
import { parseDriveLink, describeType, GOOGLE_TYPES } from '../../agent/providers/drive.mjs';
import { rowsAsMarkdown } from '../../agent/files/sheets.mjs';
import { formatCsv } from '../../agent/files/csv.mjs';

export const USAGE = 'Usage: sheets-get <sheet link or id> [--tab <tab name> | --range <A1 range>] [--format md|csv] [--max-rows <n>] [--formulas] [--json]';

const DEFAULT_MAX_ROWS = 100;
const MAX_ROWS = 10_000;

/**
 * The tab a name points at (exactly, else ignoring case), or an error listing the tabs.
 *
 * @param {object} info the spreadsheet from the client's info()
 * @param {string} name
 * @returns {object} the tab's properties
 * @throws {Error}
 */
export function findTab(info, name) {
  const tabs = (info.sheets || []).map((s) => s.properties);
  const tab = tabs.find((t) => t.title === name) || tabs.find((t) => t.title.toLowerCase() === String(name).toLowerCase());
  if (!tab) throw new Error(`the spreadsheet has no tab "${name}". Its tabs: ${tabs.map((t) => `"${t.title}"`).join(', ') || 'none'}`);
  return tab;
}

/** One line per tab: name, size, frozen rows. */
export function tabsLine(info) {
  return (info.sheets || []).map((s, i) => {
    const p = s.properties;
    const g = p.gridProperties || {};
    return `${i + 1}. "${p.title}"${p.sheetType && p.sheetType !== 'GRID' ? ` (${p.sheetType.toLowerCase()})` : ` ${g.rowCount ?? '?'} rows x ${g.columnCount ?? '?'} columns${g.frozenRowCount ? `, ${g.frozenRowCount} frozen row${g.frozenRowCount === 1 ? '' : 's'}` : ''}`}`;
  }).join(' | ');
}

/** What the agent may do with a spreadsheet, in one line. */
export function accessLine(info, owned) {
  if (owned) return 'You own it: you may write to it (sheets-append, sheets-update).';
  const owner = info.owners?.[0];
  const by = info.driveId ? 'in a shared drive' : `owned by ${owner ? (owner.displayName ? `${owner.displayName} <${owner.emailAddress}>` : owner.emailAddress) : 'someone else'}`;
  return `It is ${by}: you may read it, never change it. Changes go in a new spreadsheet (sheets-create).`;
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { id, tab, range, format, maxRows, formulas, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        tab: { type: 'string' }, range: { type: 'string' }, format: { type: 'string' }, 'max-rows': { type: 'string' },
        formulas: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one spreadsheet at a time, got ${positionals.length}` : 'a Google Sheet link or id is required' };
  const id = parseDriveLink(positionals[0]);
  if (!id) return { error: `'${positionals[0]}' is not a Google Sheet link or id: copy the link from the browser, or the id between /d/ and /edit` };
  if (values.tab !== undefined && values.range !== undefined && values.range.includes('!')) return { error: 'name the tab once: --tab with a range like A1:D20, or --range "\'Tab\'!A1:D20"' };
  const format = values.format ?? 'md';
  if (!['md', 'csv'].includes(format)) return { error: '--format is md or csv' };
  if (format === 'csv' && values.json) return { error: '--format csv and --json do not go together' };
  let maxRows = DEFAULT_MAX_ROWS;
  if (values['max-rows'] !== undefined) {
    maxRows = Number(values['max-rows']);
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) return { error: `--max-rows must be a whole number from 1 to ${MAX_ROWS}` };
  }
  return { id, tab: values.tab, range: values.range, format, maxRows, formulas: values.formulas === true, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime()
 * @param {object} [deps.sheets]  from createSheetsClient()
 * @returns {Promise<number>} 0, 1 when Google refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`sheets-get: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const sheets = deps.sheets || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createSheetsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const file = await sheets.file(args.id);
    if (file.mimeType !== GOOGLE_TYPES.spreadsheet) {
      return fail(`"${file.name}" is ${describeType(file.mimeType)}, not a Google Sheet. Read it with drive-get ${file.id} --mission <mission id>, then file-read.`);
    }
    const info = await sheets.info(args.id);
    let tab = null;
    try {
      if (args.tab !== undefined) tab = findTab(info, args.tab);
    } catch (err) {
      return fail(err.message, 2);
    }
    const first = info.sheets?.[0]?.properties;
    // Without a range, read one row more than shown, to know whether there are more.
    const range = args.range !== undefined
      ? (tab ? tabRange(tab.title, args.range) : args.range)
      : `${quoteTab((tab || first)?.title ?? 'Sheet1')}!1:${args.maxRows + 1}`;
    const read = await sheets.values(args.id, range, { render: args.formulas ? 'FORMULA' : 'FORMATTED_VALUE' });
    const rows = read.values.slice(0, args.maxRows);
    const more = read.values.length - rows.length;
    const start = rangeStart(read.range);
    const link = info.spreadsheetUrl || file.webViewLink;
    const owned = sheets.owns(file);
    const cutNote = more > 0
      ? `[cut: ${args.range !== undefined ? `${more} more rows in this range` : 'the tab has more rows'}. Read on with --range "${quoteTab(start.tab ?? first?.title ?? '')}!${start.row + rows.length}:${start.row + rows.length + args.maxRows - 1}", or raise --max-rows (up to ${MAX_ROWS})]`
      : null;

    if (args.format === 'csv') {
      stdout.write(formatCsv(rows));
      if (cutNote) stderr.write(`sheets-get: ${cutNote}\n`);
      return 0;
    }
    if (args.json) {
      stdout.write(`${JSON.stringify({
        id: args.id, title: info.properties?.title ?? file.name, link, owned, tabs: (info.sheets || []).map((s) => s.properties),
        range: read.range, start_row: start.row, start_column: start.column, values: rows, more_rows: more > 0,
      }, null, 2)}\n`);
      return 0;
    }
    const lines = [
      `"${info.properties?.title ?? file.name}" | Google Sheet | ${link}`,
      accessLine(file, owned),
      `Tabs: ${tabsLine(info)}`,
      '',
      `${read.range}${args.formulas ? ' (formulas)' : ''}:`,
      rows.length ? rowsAsMarkdown(addressedRows(rows, start)) : '(no values in this range)',
    ];
    if (cutNote) lines.push(cutNote);
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
