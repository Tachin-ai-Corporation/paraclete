// Tests for agent/files/sheets.mjs: spreadsheets read as rows (CSV directly, workbooks through the
// openpyxl script, old formats through LibreOffice first), rendered as tables, and written as .xlsx.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  READ_SHEETS_SCRIPT, WRITE_XLSX_SCRIPT, jsonCell, readSheets, rowsAsCsv, rowsAsMarkdown, selectSheet, sheetNames, typedCell, writeWorkbook,
} from '../../../agent/files/sheets.mjs';
import { fakeRunner, scratch } from './helpers.mjs';

const dir = scratch('sheets-test-');
after(() => dir.cleanup());

const WORKBOOK = { sheets: [{ name: 'Q3', hidden: false, rows: [['Region', 'Sales'], ['North', '120']], more: false }, { name: 'Notes', hidden: true, rows: [], more: true }] };

test('a CSV or TSV file is one sheet named after the file', async () => {
  const [sheet] = await readSheets(dir.file('sales.csv', 'a,b\n1,2\n3,4\n'), 'csv', { runner: fakeRunner() });
  assert.deepEqual(sheet, { name: 'sales', hidden: false, rows: [['a', 'b'], ['1', '2'], ['3', '4']], more: false });
  const [capped] = await readSheets(dir.file('t.tsv', 'a\tb\n1\t2\n3\t4\n'), 'tsv', { runner: fakeRunner(), maxRows: 2 });
  assert.deepEqual([capped.rows.length, capped.more], [2, true]);
});

test('a workbook is read by the openpyxl script, isolated from the working directory', async () => {
  const runner = fakeRunner({ python3: () => ({ stdout: JSON.stringify(WORKBOOK) }) });
  const book = dir.file('book.xlsx', 'x');
  const sheets = await readSheets(book, 'xlsx', { runner, maxRows: 50 });
  assert.deepEqual(sheets.map((s) => [s.name, s.hidden, s.more]), [['Q3', false, false], ['Notes', true, true]]);
  assert.deepEqual(runner.calls[0].args, ['-I', '-c', READ_SHEETS_SCRIPT, book, '50']);
  await assert.rejects(readSheets(book, 'xlsx', { runner: fakeRunner({ python3: () => ({ stdout: 'Traceback' }) }) }), /not JSON/);
  await assert.rejects(readSheets(book, 'pdf', { runner }), /not a spreadsheet/);
});

test('an .xls or .ods goes through LibreOffice to .xlsx first', async () => {
  const runner = fakeRunner({
    soffice: (args) => { writeFileSync(join(args[args.indexOf('--outdir') + 1], 'old.xlsx'), 'x'); },
    python3: () => ({ stdout: JSON.stringify(WORKBOOK) }),
  });
  const sheets = await readSheets(dir.file('old.xls', 'x'), 'xls', { runner });
  assert.equal(sheets.length, 2);
  assert.deepEqual(runner.calls.map((c) => c.program), ['soffice', 'python3']);
  assert.match(runner.calls[1].args[3], /old\.xlsx$/);
});

test('a sheet is picked by name (any case) or number, and a miss lists the sheets', () => {
  const sheets = WORKBOOK.sheets;
  assert.equal(selectSheet(sheets, 'notes').name, 'Notes');
  assert.equal(selectSheet(sheets, '1').name, 'Q3');
  assert.throws(() => selectSheet(sheets, 'Q4'), /no sheet 'Q4': the sheets are 1 'Q3', 2 'Notes'/);
});

test('rows render as a padded Markdown table with safe cells, or as CSV', () => {
  assert.equal(rowsAsMarkdown([['a', 'b|c'], ['multi\nline'], ['x', 'y', 'z']]), [
    '| a | b\\|c |  |',
    '| --- | --- | --- |',
    '| multi<br>line |  |  |',
    '| x | y | z |',
  ].join('\n'));
  assert.equal(rowsAsMarkdown([]), '(empty sheet)');
  assert.equal(rowsAsCsv([['a', 'b,c']]), 'a,"b,c"\n');
});

test('cells are typed for a workbook: plain numbers become numbers, ids keep their zeros', () => {
  assert.deepEqual(['42', '-3.5', '007', '1e5', '', 'TRUE', '1234567890123456'].map(typedCell), [42, -3.5, '007', '1e5', null, 'TRUE', '1234567890123456']);
  assert.deepEqual([1, 'x', true, null, undefined, { a: 1 }, [1]].map(jsonCell), [1, 'x', true, null, null, '{"a":1}', '[1]']);
});

test('sheet names are made acceptable to Excel and unique', () => {
  assert.deepEqual(sheetNames(['Q3/Q4: sales?', '', 'a'.repeat(40), 'Data', 'data']), [
    'Q3 Q4  sales', 'Sheet2', 'a'.repeat(31), 'Data', 'data (2)',
  ]);
});

test('writing a workbook hands the script typed rows and clean names on stdin', async () => {
  const runner = fakeRunner();
  const out = join(dir.root, 'out.xlsx');
  await writeWorkbook(runner, [{ name: 'Bad[Name]', rows: [['h'], [1]] }, { name: 'Raw', rows: [[2]], header: false }], out);
  const [call] = runner.calls;
  assert.deepEqual(call.args, ['-I', '-c', WRITE_XLSX_SCRIPT, out]);
  assert.deepEqual(JSON.parse(call.opts.input), { sheets: [{ name: 'Bad Name', rows: [['h'], [1]], header: true }, { name: 'Raw', rows: [[2]], header: false }] });
});

test('the embedded Python scripts are valid Python', (t) => {
  const python = ['python3', 'python'].find((p) => /Python 3/.test(spawnSync(p, ['--version'], { encoding: 'utf8' }).stdout || ''));
  if (!python) { t.skip('no python3 on this host'); return; }
  for (const script of [READ_SHEETS_SCRIPT, WRITE_XLSX_SCRIPT]) {
    const res = spawnSync(python, ['-I', '-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: script, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  }
});
