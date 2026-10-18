// Tests for agent/files/mission-paths.mjs: a mission's tree and inbox, and the mission a path is in.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  checkMissionId, freeName, missionInbox, missionOfPath, missionTree, missionTreeExists,
} from '../../../agent/files/mission-paths.mjs';
import { scratch } from './helpers.mjs';

const dir = scratch('mission-paths-test-');
after(() => dir.cleanup());

test('the inbox sits under missions/<id>/ inside the mission tree', () => {
  const root = join(dir.root, 'missions');
  assert.equal(missionTree(root, 'w-1'), join(root, 'w-1'));
  assert.equal(missionInbox(root, 'w-1'), join(root, 'w-1', 'missions', 'w-1', 'inbox'));
  for (const bad of ['', '../w-1', 'w/1', '.hidden', 'w 1', undefined]) assert.throws(() => checkMissionId(bad), /not a mission id/, String(bad));
  assert.equal(checkMissionId('w-1760000000000-ab12cd34'), 'w-1760000000000-ab12cd34');
});

test('a tree exists only while its directory does, and a path names the mission whose tree holds it', () => {
  const root = join(dir.root, 'missions');
  dir.dir('missions/w-2/report');
  assert.equal(missionTreeExists(root, 'w-2'), true);
  assert.equal(missionTreeExists(root, 'w-3'), false);
  assert.equal(missionOfPath(root, join(root, 'w-2', 'report', 'q3.docx')), 'w-2');
  assert.equal(missionOfPath(root, join(root, 'w-2')), 'w-2');
  assert.equal(missionOfPath(root, root), null);
  assert.equal(missionOfPath(root, join(dir.root, 'workspace', 'x.md')), null);
});

test('a free name adds -2, -3 before the extension', () => {
  const inbox = dir.dir('inbox');
  assert.equal(freeName(inbox, 'a.pdf'), 'a.pdf');
  dir.file('inbox/a.pdf', '1');
  dir.file('inbox/a-2.pdf', '2');
  assert.equal(freeName(inbox, 'a.pdf'), 'a-3.pdf');
  dir.file('inbox/repo', '');
  assert.equal(freeName(inbox, 'repo'), 'repo-2');
});
