// tests/skills/workspace-sheets/fakes.mjs: what the sheets-create, sheets-append and sheets-update tests
// share: a spreadsheet the agent owns and one it does not (both with a tab whose name needs quoting), a
// fake Google answering Drive's files.get and upload and the Sheets calls, the writes it received, and
// a command runtime over a temp data root with a file in a mission tree.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSheetsClient } from '../../../agent/providers/workspace-sheets.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, driveFile, driveFilesRoute } from '../../agent/providers/workspace-fakes.mjs';
import { driveRuntime, WORKSPACE } from '../drive/fakes.mjs';

export const MINE = driveFile('1SheetMineAbcdefghijklmn', { name: 'Tracker', mimeType: GOOGLE_TYPES.spreadsheet });
export const THEIRS = driveFile('1SheetTheirsAbcdefghijkl', { name: 'Budget', mimeType: GOOGLE_TYPES.spreadsheet, owner: 'pat@example.com' });
const info = (title) => ({ properties: { title }, sheets: [{ properties: { sheetId: 0, title: "Tasks '26", index: 0 } }] });

/** The fake Google the writing commands talk to. */
export function google() {
  return fakeGoogle([
    driveFilesRoute({ [MINE.id]: MINE, [THEIRS.id]: THEIRS }),
    ['GET', /^\/v4\/spreadsheets\/([^/]+)$/, (call, m) => json(info(m[1] === MINE.id ? 'Tracker' : 'Budget'))],
    ['POST', /:append$/, () => json({ updates: { updatedRange: "'Tasks ''26'!A5:C6", updatedRows: 2, updatedCells: 6 } })],
    ['PUT', /\/values\//, () => json({ updatedRange: "'Tasks ''26'!C3", updatedRows: 1, updatedCells: 1 })],
    ['POST', '/upload/drive/v3/files', () => json({ id: '1NewSheetAbcdefghijklmno', name: 'Contacts', webViewLink: 'https://docs.google.com/spreadsheets/d/1NewSheetAbcdefghijklmno/edit' })],
  ]);
}

/** A Sheets client over the fake. */
export const sheetsFor = (g) => createSheetsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

/** The value writes the fake received. */
export const writes = (g) => g.calls.filter((c) => c.method === 'PUT' || c.path.endsWith(':append'));

/** A command runtime whose mission m-8 holds one file. */
export function runtimeWith(name, content) {
  const runtime = driveRuntime({ workspace: WORKSPACE });
  mkdirSync(join(runtime.paths.data.missions, 'm-8'), { recursive: true });
  if (name) writeFileSync(join(runtime.paths.data.missions, 'm-8', name), content);
  return runtime;
}
