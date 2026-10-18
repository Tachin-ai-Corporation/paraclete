// Tests for skills/workspace-sheets/sheets-update.mjs: values written into exactly the cells named on
// the tab named, only in a Sheet the agent's account owns; someone else's is refused, and an unknown
// tab lists the tabs, before anything is written. Google is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sheetsUpdate from '../../../skills/workspace-sheets/sheets-update.mjs';
import { run } from '../../agent/providers/workspace-fakes.mjs';
import { MINE, THEIRS, google, sheetsFor, writes } from './fakes.mjs';

test('writes exactly the cells named, on the tab named', async () => {
  const g = google();
  const r = await run(sheetsUpdate, [MINE.id, '--tab', "Tasks '26", '--range', 'c3', '--values', '[["done"]]'], { sheets: sheetsFor(g) });
  assert.equal(r.code, 0, r.err);
  const [call] = writes(g);
  assert.equal(call.method, 'PUT');
  assert.equal(decodeURIComponent(call.path).split('/values/')[1], "'Tasks ''26'!C3");
  assert.deepEqual(call.json(), { range: "'Tasks ''26'!C3", majorDimension: 'ROWS', values: [['done']] });
  assert.match(r.out, /^Wrote 1 cell in "Tracker": 'Tasks ''26'!C3\. Nothing else changed\./);
});

test("someone else's Sheet is refused; an unknown tab lists the tabs", async () => {
  const g = google();
  const theirs = await run(sheetsUpdate, [THEIRS.id, '--tab', "Tasks '26", '--range', 'A1', '--values', '[["x"]]'], { sheets: sheetsFor(g) });
  assert.equal(theirs.code, 1);
  assert.match(theirs.err, /You may not change "Budget"/);
  const tab = await run(sheetsUpdate, [MINE.id, '--tab', 'Sheet1', '--range', 'A1', '--values', '[["x"]]'], { sheets: sheetsFor(g) });
  assert.equal(tab.code, 2);
  assert.match(tab.err, /no tab "Sheet1"\. Its tabs: "Tasks '26"/);
  assert.equal(writes(g).length, 0);
});

test('mistakes are refused before any call', async () => {
  const g = google();
  for (const argv of [[MINE.id, '--tab', 'T', '--values', '[["x"]]'], [MINE.id, '--tab', 'T', '--range', 'A:C', '--values', '[["x"]]'], [MINE.id, '--range', 'A1', '--values', '[["x"]]']]) {
    assert.equal((await run(sheetsUpdate, argv, { sheets: sheetsFor(g) })).code, 2, argv.join(' '));
  }
  assert.equal(g.calls.length, 0);
  assert.equal((await run(sheetsUpdate, ['--help'])).code, 0);
});
