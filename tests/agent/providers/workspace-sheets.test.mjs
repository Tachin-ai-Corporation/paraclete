// Tests for agent/providers/workspace-sheets.mjs: A1 notation (quoted tab names, column letters, where
// a range starts, rows labelled with their addresses), and the client: exact URLs and bodies, values
// written as typed unless raw, and writes only into a spreadsheet the agent's account owns (refused
// before anything is sent otherwise). Google is a fake fetch.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSheetsClient, quoteTab, tabRange, columnLetters, columnNumber, rangeStart, addressedRows,
} from '../../../agent/providers/workspace-sheets.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import { INSTANCE, json, grpcError, fakeTokens, fakeGoogle, driveFile, driveFilesRoute } from './workspace-fakes.mjs';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

describe('A1 notation', () => {
  test('tab names are always quoted, a quote inside doubled', () => {
    assert.equal(quoteTab('Sheet1'), "'Sheet1'");
    assert.equal(quoteTab("Q3 plan's"), "'Q3 plan''s'");
    assert.equal(tabRange('Q3 plan', 'A1:D20'), "'Q3 plan'!A1:D20");
    assert.equal(tabRange('Q3 plan'), "'Q3 plan'");
  });

  test('column letters both ways', () => {
    assert.deepEqual([1, 26, 27, 52, 703].map(columnLetters), ['A', 'Z', 'AA', 'AZ', 'AAA']);
    assert.deepEqual(['A', 'z', 'AA', 'AAA'].map(columnNumber), [1, 26, 27, 703]);
  });

  test('where a returned range starts', () => {
    assert.deepEqual(rangeStart("'Q3 plan''s'!B2:D9"), { tab: "Q3 plan's", row: 2, column: 2 });
    assert.deepEqual(rangeStart('Sheet1!AA10'), { tab: 'Sheet1', row: 10, column: 27 });
    assert.deepEqual(rangeStart('Sheet1!C:E'), { tab: 'Sheet1', row: 1, column: 3 });
    assert.deepEqual(rangeStart('Sheet1'), { tab: null, row: 1, column: 1 }, 'a bare tab name, as Sheets never returns it, starts at A1');
  });

  test('rows labelled with their addresses, ragged rows padded', () => {
    assert.deepEqual(addressedRows([['Name', 'Status'], ['Ana']], { row: 4, column: 2 }), [
      ['Row', 'B', 'C'], ['4', 'Name', 'Status'], ['5', 'Ana', ''],
    ]);
  });
});

describe('the client', () => {
  const MINE = driveFile('1SheetMineAbcde', { name: 'Tracker', mimeType: GOOGLE_TYPES.spreadsheet });
  const THEIRS = driveFile('1SheetTheirsAbc', { name: 'Budget', mimeType: GOOGLE_TYPES.spreadsheet, owner: 'pat@example.com' });
  const files = { [MINE.id]: MINE, [THEIRS.id]: THEIRS };
  const google = (extra = []) => fakeGoogle([driveFilesRoute(files), ...extra]);
  const client = (g) => createSheetsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

  test('info asks for the title and every tab\'s size, with the spreadsheets token', async () => {
    const g = google([['GET', /^\/v4\/spreadsheets\/[^/]+$/, () => json({ properties: { title: 'Tracker' }, sheets: [] })]]);
    await client(g).info(MINE.id);
    assert.equal(g.calls[0].path, `/v4/spreadsheets/${MINE.id}`);
    assert.match(g.calls[0].params.get('fields'), /sheets\(properties\(sheetId,title,index,sheetType,gridProperties\(rowCount,columnCount,frozenRowCount\)\)\)/);
    assert.equal(g.calls[0].headers.Authorization, 'Bearer tok-spreadsheets');
  });

  test('values reads a range as shown, any spreadsheet the account can open', async () => {
    const g = google([['GET', /\/values\//, () => json({ range: "'Budget'!A1:B2", values: [['a', 'b'], ['1']] })]]);
    const result = await client(g).values(THEIRS.id, "'Budget'!A1:B2");
    assert.deepEqual(result, { range: "'Budget'!A1:B2", values: [['a', 'b'], ['1']] });
    assert.equal(g.calls[0].url, `${BASE}/${THEIRS.id}/values/'Budget'!A1%3AB2?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
  });

  test('append adds rows after the table, typed as a person would; raw on request', async () => {
    const g = google([['POST', /:append$/, (call) => json({ updates: { updatedRange: "'Tracker'!A5:C5", updatedRows: 1, updatedCells: 3 } })]]);
    const result = await client(g).append(MINE.id, "'Tracker'", [['Ana', 'done', '=1+1']]);
    assert.deepEqual([result.updatedRange, result.updatedRows, result.updatedCells], ["'Tracker'!A5:C5", 1, 3]);
    const call = g.calls[1];
    assert.equal(call.url, `${BASE}/${MINE.id}/values/'Tracker':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`);
    assert.deepEqual(call.json(), { range: "'Tracker'", majorDimension: 'ROWS', values: [['Ana', 'done', '=1+1']] });
    await client(g).append(MINE.id, "'Tracker'", [['x']], { raw: true });
    assert.equal(g.calls[3].params.get('valueInputOption'), 'RAW');
  });

  test('update writes exactly the range named', async () => {
    const g = google([['PUT', /\/values\//, () => json({ updatedRange: "'Tracker'!C3", updatedRows: 1, updatedCells: 1 })]]);
    const result = await client(g).update(MINE.id, "'Tracker'!C3", [['done']]);
    assert.equal(result.updatedCells, 1);
    assert.equal(g.calls[1].url, `${BASE}/${MINE.id}/values/'Tracker'!C3?valueInputOption=USER_ENTERED`);
    assert.deepEqual(g.calls[1].json(), { range: "'Tracker'!C3", majorDimension: 'ROWS', values: [['done']] });
  });

  test("a spreadsheet the agent does not own is refused before any write", async () => {
    const g = google();
    await assert.rejects(client(g).update(THEIRS.id, "'Budget'!A1", [['x']]), (err) => err.kind === 'not_owner' && /You may not change "Budget"/.test(err.message));
    await assert.rejects(client(g).append(THEIRS.id, "'Budget'", [['x']]), (err) => err.kind === 'not_owner' && /You may not add rows to "Budget"/.test(err.message));
    assert.deepEqual(g.calls.map((c) => c.method), ['GET', 'GET']);
  });

  test('an uploaded Excel file is not a Google Sheet', async () => {
    const xlsx = driveFile('1XlsxMineAbcdef', { name: 'old.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const g = fakeGoogle([driveFilesRoute({ [xlsx.id]: xlsx }), ['GET', /\/values\//, () => grpcError(400, 'FAILED_PRECONDITION', 'This operation is not supported for this document')]]);
    await assert.rejects(client(g).update(xlsx.id, 'A1', [['x']]), (err) => err.kind === 'wrong_type');
    await assert.rejects(client(g).values(xlsx.id, 'A1'), (err) => err.kind === 'wrong_type' && /drive-get and file-read/.test(err.message));
  });

  test('create uploads CSV for Drive to convert into a Sheet', async () => {
    const g = google([['POST', '/upload/drive/v3/files', () => json({ id: '1NewSheetAbcdef', name: 'Contacts' })]]);
    await client(g).create({ title: 'Contacts', csv: 'Name,Email\nAna,ana@example.com\n' });
    const sent = g.calls[0].body.toString();
    assert.ok(sent.includes(JSON.stringify({ name: 'Contacts', mimeType: GOOGLE_TYPES.spreadsheet })));
    assert.ok(sent.includes('Content-Type: text/csv\r\n\r\nName,Email\nAna,ana@example.com\n'));
  });
});
