// agent/files/csv.mjs: CSV and TSV text as rows of cells, and back. Parsing follows RFC 4180 (quoted
// cells, doubled quotes, line breaks inside quotes, CRLF or LF) and guesses the delimiter from the
// first line when none is given; writing quotes only the cells that need it. Pure. Used by sheets.mjs
// (reading a table), converters.mjs and makers.mjs (writing one).

const DELIMITERS = [',', '\t', ';', '|'];

/**
 * The delimiter a table's first line uses most, outside quotes: comma, tab, semicolon or bar.
 *
 * @param {string} text
 * @returns {string}
 */
export function detectDelimiter(text) {
  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of String(text)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  }
  let best = ',';
  for (const [d, n] of counts) if (n > counts.get(best)) best = d;
  return best;
}

/**
 * Rows of cells from CSV text.
 *
 * @param {string} text
 * @param {{delimiter?: string}} [opts] default: detected from the first line
 * @returns {string[][]}
 */
export function parseCsv(text, { delimiter } = {}) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const sep = delimiter || detectDelimiter(s);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false;
      } else {
        cell += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** One cell as CSV: quoted when it holds the delimiter, a quote, a line break or edge spaces. */
function csvCell(value, sep) {
  const text = value === null || value === undefined ? '' : String(value);
  return /["\r\n]/.test(text) || text.includes(sep) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV text from rows of cells, one line per row, ending with a line break.
 *
 * @param {Array<Array<*>>} rows
 * @param {{delimiter?: string}} [opts]
 * @returns {string}
 */
export function formatCsv(rows, { delimiter = ',' } = {}) {
  if (!rows.length) return '';
  return `${rows.map((row) => row.map((v) => csvCell(v, delimiter)).join(delimiter)).join('\n')}\n`;
}
