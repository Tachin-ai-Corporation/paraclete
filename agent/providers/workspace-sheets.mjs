// agent/providers/workspace-sheets.mjs: a Google Sheets API v4 client acting as the agent's own
// Workspace account (agent/providers/workspace.mjs), with the A1-notation arithmetic its commands need:
// quoting a tab name, column letters, where a returned range starts, and rows labelled with their
// cell addresses so a later write lands in the right cell.
//
// What it may do: read any spreadsheet the account can open, and create new ones from CSV (Drive
// converts the upload). It writes values (append, update) only into a spreadsheet the agent's own
// account owns; anything else is refused before a request is made (session.ownedFile). A value write
// changes only the cells it names: formatting, formulas elsewhere and other tabs stay as they are.
//
// Called by the workspace-sheets skill's commands (skills/workspace-sheets/).

import { createWorkspaceSession } from './workspace.mjs';
import { GOOGLE_TYPES } from './drive.mjs';

const SHEET_TYPE = GOOGLE_TYPES.spreadsheet;
const INFO_FIELDS = 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),'
  + 'sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount)))';

/** A tab name as A1 notation needs it: always in single quotes, a quote inside doubled. Pure. */
export function quoteTab(name) {
  return `'${String(name ?? '').replace(/'/g, "''")}'`;
}

/** A range on a tab: `'My tab'!A1:D20`, or the whole tab when there is no span. Pure. */
export function tabRange(tab, span) {
  return span ? `${quoteTab(tab)}!${span}` : quoteTab(tab);
}

/** A 1-based column number as letters: 1 is A, 27 is AA. Pure. */
export function columnLetters(n) {
  let s = '';
  for (let x = Math.floor(n); x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Column letters as a 1-based number: A is 1, AA is 27. Pure. */
export function columnNumber(letters) {
  return String(letters ?? '').toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}

/**
 * Where a range starts, from what Sheets returns ("'Q3 plan'!B2:D9", "Sheet1!A1", "A:C"): the tab,
 * and the first row and column (1-based; a whole-column range starts at row 1). Pure.
 *
 * @param {string} range
 * @returns {{tab: string|null, row: number, column: number}}
 */
export function rangeStart(range) {
  const s = String(range ?? '');
  const bang = s.lastIndexOf('!');
  let tab = null;
  let span = s;
  if (bang >= 0) {
    tab = s.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    span = s.slice(bang + 1);
  }
  const m = /^\$?([A-Za-z]{1,3})?\$?(\d+)?$/.exec(span.split(':')[0]);
  return { tab, row: m?.[2] ? Number(m[2]) : 1, column: m?.[1] ? columnNumber(m[1]) : 1 };
}

/**
 * Rows labelled with their addresses, for a Markdown table a reader can point into: a first row of
 * column letters headed "Row", and each row's number in front. Pure.
 *
 * @param {Array<Array<*>>} rows
 * @param {{row: number, column: number}} start where rows[0][0] sits
 * @returns {string[][]}
 */
export function addressedRows(rows, { row = 1, column = 1 } = {}) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const header = ['Row', ...Array.from({ length: width }, (_, i) => columnLetters(column + i))];
  return [header, ...rows.map((r, i) => [String(row + i), ...Array.from({ length: width }, (_, j) => String(r[j] ?? ''))])];
}

/**
 * Creates a Sheets client acting as the agent's Workspace account.
 *
 * @param {object} [options] a `session` from createWorkspaceSession, or the options to make one
 */
export function createSheetsClient(options = {}) {
  const session = options.session || createWorkspaceSession(options);
  const { account } = session;
  const sheetPath = (id) => `/v4/spreadsheets/${encodeURIComponent(id)}`;
  const valuesPath = (id, range) => `${sheetPath(id)}/values/${encodeURIComponent(range)}`;

  return {
    account,

    /** The Drive record of the spreadsheet: name, owners, whether the agent owns it, link. */
    file: (id) => session.fileInfo(id),

    /** Whether the agent's account owns a Drive record from file(). */
    owns: (info) => session.owns(info),

    /** The spreadsheet's title, link and tabs: each tab's title, size and frozen rows. */
    async info(id) {
      return session.request('sheets', 'GET', sheetPath(id), { query: { fields: INFO_FIELDS }, about: { what: `spreadsheet ${id}` } });
    },

    /**
     * The values in a range, as shown in the sheet (formatted) unless asked for raw values or formulas.
     *
     * @param {string} id
     * @param {string} range A1 notation, with its tab
     * @param {{render?: 'FORMATTED_VALUE'|'UNFORMATTED_VALUE'|'FORMULA'}} [o]
     * @returns {Promise<{range: string, values: Array<Array<*>>}>}
     */
    async values(id, range, { render = 'FORMATTED_VALUE' } = {}) {
      const result = await session.request('sheets', 'GET', valuesPath(id, range), {
        query: { valueRenderOption: render, majorDimension: 'ROWS' },
        about: { what: `range ${range} of spreadsheet ${id}` },
      });
      return { range: result.range || range, values: result.values || [] };
    },

    /**
     * Adds rows after the table a range holds, in a spreadsheet the agent owns. Values are read as if
     * typed into the sheet (numbers, dates, formulas) unless `raw`.
     *
     * @returns {Promise<{file: object, updatedRange: string, updatedRows: number, updatedCells: number}>}
     * @throws {WorkspaceError} kind not_owner
     */
    async append(id, range, rows, { raw = false } = {}) {
      const file = await session.ownedFile(id, { type: SHEET_TYPE, action: 'add rows to' });
      const result = await session.request('sheets', 'POST', `${valuesPath(id, range)}:append`, {
        query: { valueInputOption: raw ? 'RAW' : 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
        json: { range, majorDimension: 'ROWS', values: rows },
        about: { what: `range ${range} of spreadsheet ${id}`, action: 'change' },
      });
      const u = result?.updates || {};
      return { file, updatedRange: u.updatedRange || range, updatedRows: u.updatedRows || 0, updatedCells: u.updatedCells || 0 };
    },

    /**
     * Writes values into a range, in a spreadsheet the agent owns: only those cells change.
     *
     * @returns {Promise<{file: object, updatedRange: string, updatedRows: number, updatedCells: number}>}
     * @throws {WorkspaceError} kind not_owner
     */
    async update(id, range, rows, { raw = false } = {}) {
      const file = await session.ownedFile(id, { type: SHEET_TYPE, action: 'change' });
      const result = await session.request('sheets', 'PUT', valuesPath(id, range), {
        query: { valueInputOption: raw ? 'RAW' : 'USER_ENTERED' },
        json: { range, majorDimension: 'ROWS', values: rows },
        about: { what: `range ${range} of spreadsheet ${id}`, action: 'change' },
      });
      return { file, updatedRange: result?.updatedRange || range, updatedRows: result?.updatedRows || 0, updatedCells: result?.updatedCells || 0 };
    },

    /**
     * A new Google Sheet from CSV text, converted by Drive, in a folder or the agent's My Drive.
     *
     * @param {{title: string, csv: string, folderId?: string}} o
     * @returns {Promise<object>} the new file: id, name, webViewLink
     */
    async create({ title, csv = '', folderId }) {
      return session.drive.create({ name: title, parentId: folderId || undefined, mimeType: 'text/csv', bytes: Buffer.from(String(csv), 'utf8'), convertTo: 'sheet' });
    },
  };
}
