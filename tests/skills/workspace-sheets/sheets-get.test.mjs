// Tests for skills/workspace-sheets/sheets-get.mjs: the overview (owner line, tabs, the first rows of
// the first tab, labelled with row numbers and column letters), a tab or a range, the cut note, CSV
// alone on stdout, formulas, and a file that is not a Google Sheet. Google is a fake.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as sheetsGet from '../../../skills/workspace-sheets/sheets-get.mjs';
import { createSheetsClient } from '../../../agent/providers/workspace-sheets.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, driveFile, driveFilesRoute, run } from '../../agent/providers/workspace-fakes.mjs';

const SHEET = driveFile('1SheetTheirsAbcdefghijkl', { name: 'Budget', mimeType: GOOGLE_TYPES.spreadsheet, owner: 'pat@example.com' });
const INFO = {
  spreadsheetId: SHEET.id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET.id}/edit`, properties: { title: 'Budget' },
  sheets: [
    { properties: { sheetId: 0, title: 'Q3 plan', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 } } },
    { properties: { sheetId: 1, title: 'Notes', index: 1, sheetType: 'GRID', gridProperties: { rowCount: 50, columnCount: 5 } } },
  ],
};

function google(valuesFor) {
  return fakeGoogle([
    driveFilesRoute({ [SHEET.id]: SHEET }),
    ['GET', `/v4/spreadsheets/${SHEET.id}`, () => json(INFO)],
    ['GET', /\/values\//, (call) => json(valuesFor(decodeURIComponent(call.path.split('/values/')[1]), call))],
  ]);
}
const sheetsFor = (g) => createSheetsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

describe('sheets-get', () => {
  test('the overview: owner, tabs, and the first rows addressed by row and column', async () => {
    const g = google((range) => ({ range: "'Q3 plan'!A1:C4", values: [['Item', 'Cost', 'Status'], ['Laptops', '$4,000', 'ordered'], ['Desks', '$900']], asked: range }));
    const r = await run(sheetsGet, [SHEET.id, '--max-rows', '3'], { sheets: sheetsFor(g) });
    assert.equal(r.code, 0, r.err);
    assert.equal(decodeURIComponent(g.calls[2].path.split('/values/')[1]), "'Q3 plan'!1:4", 'one row more than shown, to know whether there are more');
    assert.equal(r.out, [
      `"Budget" | Google Sheet | https://docs.google.com/spreadsheets/d/${SHEET.id}/edit`,
      'It is owned by Pat Example <pat@example.com>: you may read it, never change it. Changes go in a new spreadsheet (sheets-create).',
      'Tabs: 1. "Q3 plan" 1000 rows x 26 columns, 1 frozen row | 2. "Notes" 50 rows x 5 columns',
      '',
      "'Q3 plan'!A1:C4:",
      '| Row | A | B | C |',
      '| --- | --- | --- | --- |',
      '| 1 | Item | Cost | Status |',
      '| 2 | Laptops | $4,000 | ordered |',
      '| 3 | Desks | $900 |  |',
      '',
    ].join('\n'));
  });

  test('a range on a tab, its cut note, and formulas', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`r${i + 4}`, String(i)]);
    const g = google(() => ({ range: "'Notes'!B4:C8", values: rows }));
    const r = await run(sheetsGet, [SHEET.id, '--tab', 'notes', '--range', 'B4:C8', '--max-rows', '2', '--formulas'], { sheets: sheetsFor(g) });
    assert.equal(r.code, 0, r.err);
    const call = g.calls[2];
    assert.equal(decodeURIComponent(call.path.split('/values/')[1]), "'Notes'!B4:C8");
    assert.equal(call.params.get('valueRenderOption'), 'FORMULA');
    assert.match(r.out, /'Notes'!B4:C8 \(formulas\):\n\| Row \| B \| C \|\n\| --- \| --- \| --- \|\n\| 4 \| r4 \| 0 \|\n\| 5 \| r5 \| 1 \|\n\[cut: 3 more rows in this range\. Read on with --range "'Notes'!6:7", or raise --max-rows/);
  });

  test('CSV alone on stdout; notes on stderr', async () => {
    const g = google(() => ({ range: "'Q3 plan'!A1:B3", values: [['a', 'b'], ['1', '2,5'], ['x', 'y']] }));
    const r = await run(sheetsGet, [SHEET.id, '--format', 'csv', '--max-rows', '2'], { sheets: sheetsFor(g) });
    assert.equal(r.out, 'a,b\n1,"2,5"\n');
    assert.match(r.err, /^sheets-get: \[cut: the tab has more rows/);
  });

  test('an unknown tab lists the tabs; a file that is not a Sheet goes to drive-get', async () => {
    const g = google(() => ({ values: [] }));
    const bad = await run(sheetsGet, [SHEET.id, '--tab', 'Budget 2025'], { sheets: sheetsFor(g) });
    assert.equal(bad.code, 2);
    assert.match(bad.err, /has no tab "Budget 2025"\. Its tabs: "Q3 plan", "Notes"/);
    const xlsx = driveFile('1XlsxAbcdefghijklmnopqrs', { name: 'old.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const r = await run(sheetsGet, [xlsx.id], { sheets: sheetsFor(fakeGoogle([driveFilesRoute({ [xlsx.id]: xlsx })])) });
    assert.equal(r.code, 1);
    assert.match(r.err, /not a Google Sheet\. Read it with drive-get/);
  });

  test('mistakes are refused before any call', async () => {
    const g = google(() => ({}));
    for (const argv of [[], ['nope'], [SHEET.id, '--format', 'xml'], [SHEET.id, '--tab', 'A', '--range', "'B'!A1"], [SHEET.id, '--format', 'csv', '--json'], [SHEET.id, '--max-rows', '0']]) {
      assert.equal((await run(sheetsGet, argv, { sheets: sheetsFor(g) })).code, 2, argv.join(' '));
    }
    assert.equal(g.calls.length, 0);
    assert.equal((await run(sheetsGet, ['--help'])).code, 0);
  });
});
