// agent/files/sheets.mjs: spreadsheets as tables of text, and tables as workbooks. An Excel workbook
// is read sheet by sheet with python3 and openpyxl (each cell's value as last computed and saved; .xls
// and .ods go through LibreOffice to .xlsx first); a CSV or TSV file is read directly. A sheet renders
// as a Markdown table or as CSV. Rows are written to a new .xlsx, header bold, with python3 and
// openpyxl. Used by readers.mjs (file-read), converters.mjs and makers.mjs.

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { formatCsv, parseCsv } from './csv.mjs';

/** The most rows a sheet is read to when no cap is given: more is never readable in one go. */
export const DEFAULT_MAX_ROWS = 10_000;

/**
 * Reads every worksheet of a workbook and prints JSON: { sheets: [{ name, hidden, rows, more }] }.
 * argv: <path> <max rows, 0 for all>. Values only (data_only): a formula shows its cached result.
 */
export const READ_SHEETS_SCRIPT = `
import datetime, json, sys
from openpyxl import load_workbook

path, max_rows = sys.argv[1], int(sys.argv[2])

def text(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    return str(value)

wb = load_workbook(path, read_only=True, data_only=True)
sheets = []
for ws in wb.worksheets:
    rows, more = [], False
    for row in ws.iter_rows(values_only=True):
        if max_rows and len(rows) >= max_rows:
            more = True
            break
        cells = [text(v) for v in row]
        while cells and cells[-1] == '':
            cells.pop()
        rows.append(cells)
    while rows and not rows[-1]:
        rows.pop()
    sheets.append({'name': ws.title, 'hidden': getattr(ws, 'sheet_state', 'visible') != 'visible', 'rows': rows, 'more': more})
wb.close()
json.dump({'sheets': sheets}, sys.stdout)
`;

/**
 * The sheets of a spreadsheet.
 *
 * @param {string} path
 * @param {string} format xlsx, xls, ods, csv or tsv (formats.mjs)
 * @param {object} o
 * @param {object} o.runner    runner.mjs's
 * @param {number} [o.maxRows] rows read per sheet; 0 for all
 * @returns {Promise<Array<{name: string, hidden: boolean, rows: string[][], more: boolean}>>} more:
 *   the sheet has rows past maxRows
 */
export async function readSheets(path, format, { runner, maxRows = DEFAULT_MAX_ROWS }) {
  if (format === 'csv' || format === 'tsv') {
    const all = parseCsv(readFileSync(path, 'utf8'), format === 'tsv' ? { delimiter: '\t' } : {});
    const rows = maxRows ? all.slice(0, maxRows) : all;
    return [{ name: basename(path, extname(path)), hidden: false, rows, more: rows.length < all.length }];
  }
  if (format === 'xls' || format === 'ods') {
    return runner.withTempDir(async (dir) => readSheets(await runner.sofficeConvert(path, 'xlsx', dir), 'xlsx', { runner, maxRows }));
  }
  if (format !== 'xlsx') throw new Error(`${basename(path)} is not a spreadsheet`);
  const { stdout } = await runner.check('python3', ['-I', '-c', READ_SHEETS_SCRIPT, path, String(maxRows || 0)]);
  let parsed;
  try {
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch (err) {
    throw new Error(`reading ${basename(path)} gave output that is not JSON: ${err.message}`);
  }
  return (parsed.sheets || []).map((s) => ({
    name: String(s.name), hidden: Boolean(s.hidden), rows: Array.isArray(s.rows) ? s.rows : [], more: Boolean(s.more),
  }));
}

/**
 * The sheet a selector names: a 1-based number or a name (case does not matter).
 *
 * @param {Array<{name: string}>} sheets
 * @param {string} selector
 * @returns {object} the sheet
 * @throws {Error} listing the sheets when none matches
 */
export function selectSheet(sheets, selector) {
  const wanted = String(selector ?? '').trim();
  const byNumber = /^\d+$/.test(wanted) ? sheets[Number(wanted) - 1] : null;
  const byName = sheets.find((s) => s.name === wanted) || sheets.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  const sheet = byName || byNumber;
  if (!sheet) {
    throw new Error(`no sheet '${wanted}': the sheets are ${sheets.map((s, i) => `${i + 1} '${s.name}'`).join(', ') || 'none'}`);
  }
  return sheet;
}

/** A cell made safe inside a Markdown table: pipes escaped, line breaks as <br>. */
function mdCell(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

/**
 * A sheet's rows as a Markdown table, the first row as its header. Rows are padded to one width.
 *
 * @param {string[][]} rows
 * @returns {string}
 */
export function rowsAsMarkdown(rows) {
  if (!rows.length) return '(empty sheet)';
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => mdCell(r[i])).join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** A sheet's rows as CSV text. */
export function rowsAsCsv(rows) {
  return formatCsv(rows);
}

/**
 * Writes an .xlsx from JSON on stdin: { sheets: [{ name, rows, header }] }. argv: <out path>. The
 * header row is bold and frozen, and each column is as wide as its longest value, within limits. A
 * string starting with '=' is a formula, as in Excel.
 */
export const WRITE_XLSX_SCRIPT = `
import json, sys
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

out = sys.argv[1]
data = json.load(sys.stdin)
wb = Workbook()
wb.remove(wb.active)
for sheet in data['sheets']:
    ws = wb.create_sheet(title=sheet['name'])
    rows = sheet['rows']
    widths = {}
    for row in rows:
        row = [ILLEGAL_CHARACTERS_RE.sub('', v) if isinstance(v, str) else v for v in row]
        ws.append(row)
        for i, value in enumerate(row):
            if value is not None:
                widths[i] = max(widths.get(i, 0), max(len(line) for line in str(value).split('\\n')))
    if rows and sheet.get('header', True):
        for cell in ws[1]:
            cell.font = Font(bold=True)
        ws.freeze_panes = 'A2'
    for i, width in widths.items():
        ws.column_dimensions[get_column_letter(i + 1)].width = min(max(width + 2, 8), 60)
if not wb.worksheets:
    wb.create_sheet(title='Sheet1')
wb.save(out)
`;

/** A number as CSV writes it: no leading zeros (an id like 007 stays text) and at most 15 digits. */
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;

/**
 * A CSV cell as a workbook value: plain numbers become numbers, empty cells empty, the rest text.
 *
 * @param {string} text
 * @returns {string|number|null}
 */
export function typedCell(text) {
  const s = String(text ?? '');
  if (s === '') return null;
  return PLAIN_NUMBER.test(s) ? Number(s) : s;
}

/**
 * A JSON value as a workbook value: numbers, booleans and text as they are, nested values as JSON.
 *
 * @param {*} value
 * @returns {string|number|boolean|null}
 */
export function jsonCell(value) {
  if (value === null || value === undefined) return null;
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return JSON.stringify(value);
}

/**
 * Sheet names Excel accepts: no []:*?/\, at most 31 characters, not empty, no two alike.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function sheetNames(names) {
  const used = new Set();
  return names.map((raw, i) => {
    let name = String(raw ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${i + 1}`;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${n++})`;
      name = `${name.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Writes an .xlsx workbook with python3 and openpyxl.
 *
 * @param {object} runner
 * @param {Array<{name: string, rows: Array<Array<*>>, header?: boolean}>} sheets values already typed
 * @param {string} outPath
 */
export async function writeWorkbook(runner, sheets, outPath) {
  const names = sheetNames(sheets.map((s) => s.name));
  const input = JSON.stringify({ sheets: sheets.map((s, i) => ({ name: names[i], rows: s.rows, header: s.header !== false })) });
  await runner.check('python3', ['-I', '-c', WRITE_XLSX_SCRIPT, outPath], { input });
  return outPath;
}
