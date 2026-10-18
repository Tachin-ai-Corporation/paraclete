// Tests for skills/workspace-sheets/sheets-append.mjs: JSON rows or a CSV file added after the table on
// a named tab (its name quoted), typed unless --raw, only into a Sheet the agent's account owns:
// someone else's is refused before anything is written. Google is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sheetsAppend from '../../../skills/workspace-sheets/sheets-append.mjs';
import { run } from '../../agent/providers/workspace-fakes.mjs';
import { MINE, THEIRS, google, sheetsFor, writes, runtimeWith } from './fakes.mjs';

test('JSON rows after the table on the tab, typed as a person would', async () => {
  const g = google();
  const r = await run(sheetsAppend, [MINE.id, '--tab', "tasks '26", '--values', '[["Draft plan", "Ana", 3], ["Review", null, true]]'], { sheets: sheetsFor(g) });
  assert.equal(r.code, 0, r.err);
  const [call] = writes(g);
  assert.equal(decodeURIComponent(call.path), `/v4/spreadsheets/${MINE.id}/values/'Tasks ''26':append`);
  assert.equal(call.params.get('valueInputOption'), 'USER_ENTERED');
  assert.deepEqual(call.json().values, [['Draft plan', 'Ana', 3], ['Review', '', true]]);
  assert.equal(r.out, `Added 2 rows to "Tracker", tab "Tasks '26": 'Tasks ''26'!A5:C6 (6 cells).\nCheck them with: sheets-get ${MINE.id} --range "'Tasks ''26'!A5:C6"\n`);
});

test('rows from a CSV file, raw, into the named columns', async () => {
  const g = google();
  const runtime = runtimeWith('new.csv', 'x,"1,5"\n');
  const r = await run(sheetsAppend, [MINE.id, '--tab', "Tasks '26", '--range', 'A:D', '--csv', 'new.csv', '--mission', 'm-8', '--raw'], { sheets: sheetsFor(g), runtime });
  assert.equal(r.code, 0, r.err);
  const [call] = writes(g);
  assert.equal(decodeURIComponent(call.path).split('/values/')[1], "'Tasks ''26'!A:D:append");
  assert.equal(call.params.get('valueInputOption'), 'RAW');
  assert.deepEqual(call.json().values, [['x', '1,5']]);
});

test("someone else's Sheet is refused, and nothing is written", async () => {
  const g = google();
  const r = await run(sheetsAppend, [THEIRS.id, '--tab', "Tasks '26", '--values', '[["x"]]'], { sheets: sheetsFor(g) });
  assert.equal(r.code, 1);
  assert.match(r.err, /^sheets-append: You may not add rows to "Budget": it belongs to Pat Example/);
  assert.equal(writes(g).length, 0);
});

test('mistakes are refused before any call', async () => {
  const g = google();
  for (const argv of [
    [MINE.id, '--values', '[["x"]]'], [MINE.id, '--tab', 'T'], [MINE.id, '--tab', 'T', '--values', 'not json'], [MINE.id, '--tab', 'T', '--values', '[["a"], "b"]'],
    [MINE.id, '--tab', 'T', '--values', '[[{"a": 1}]]'], [MINE.id, '--tab', 'T', '--csv', 'a.csv'], [MINE.id, '--tab', 'T', '--range', "'T'!A:D", '--values', '[["x"]]'],
  ]) {
    assert.equal((await run(sheetsAppend, argv, { sheets: sheetsFor(g) })).code, 2, argv.join(' '));
  }
  assert.equal(g.calls.length, 0);
  assert.deepEqual(sheetsAppend.parseValues('["a", 1]'), [['a', 1]], 'one flat list is one row');
  assert.equal((await run(sheetsAppend, ['--help'])).code, 0);
});
