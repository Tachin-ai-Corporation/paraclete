// Tests for skills/workspace-sheets/sheets-create.mjs: a new Sheet, empty, from CSV text, or from a CSV
// file in the mission tree, in the agent's My Drive with who can open it said plainly; an Excel file
// is refused. Google is a fake; files go to a temp data root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sheetsCreate from '../../../skills/workspace-sheets/sheets-create.mjs';
import { run } from '../../agent/providers/workspace-fakes.mjs';
import { google, sheetsFor, runtimeWith } from './fakes.mjs';

test('from CSV text, into My Drive, said plainly', async () => {
  const g = google();
  const r = await run(sheetsCreate, ['--title', 'Contacts', '--csv', 'Name,Email\nAna,ana@example.com\n'], { sheets: sheetsFor(g) });
  assert.equal(r.code, 0, r.err);
  assert.ok(g.calls[0].body.toString().includes('Content-Type: text/csv\r\n\r\nName,Email\nAna,ana@example.com\n'));
  assert.match(r.out, /^Created the Google Sheet "Contacts"\nid: 1NewSheetAbcdefghijklmno\nlink: .*\nIn the My Drive of agent@example\.com: only you can open it/);
});

test('empty, or from a CSV file in the mission tree; an Excel file is refused', async () => {
  const g = google();
  const empty = await run(sheetsCreate, ['--title', 'Log'], { sheets: sheetsFor(g) });
  assert.match(empty.out, /^Created the Google Sheet "Contacts" \(empty\)/);
  const runtime = runtimeWith('rows.csv', 'a,b\n1,2\n');
  const fromFile = await run(sheetsCreate, ['--title', 'Rows', '--from', 'rows.csv', '--mission', 'm-8'], { sheets: sheetsFor(g), runtime });
  assert.equal(fromFile.code, 0, fromFile.err);
  assert.ok(g.calls.at(-1).body.toString().includes('a,b\n1,2\n'));
  writeFileSync(join(runtime.paths.data.missions, 'm-8', 'old.xlsx'), 'PK');
  const xlsx = await run(sheetsCreate, ['--title', 'x', '--from', 'old.xlsx', '--mission', 'm-8'], { sheets: sheetsFor(g), runtime });
  assert.equal(xlsx.code, 1);
  assert.match(xlsx.err, /old\.xlsx is not CSV/);
});

test('mistakes are refused before any call', async () => {
  const g = google();
  for (const argv of [[], ['--title', 'x', '--from', 'a.csv'], ['--title', 'x', '--csv', 'a', '--from', 'a.csv', '--mission', 'm-1'], ['--title', 'x', '--folder', 'nope']]) {
    assert.equal((await run(sheetsCreate, argv, { sheets: sheetsFor(g) })).code, 2, argv.join(' '));
  }
  assert.equal(g.calls.length, 0);
  assert.equal((await run(sheetsCreate, ['--help'])).code, 0);
});
