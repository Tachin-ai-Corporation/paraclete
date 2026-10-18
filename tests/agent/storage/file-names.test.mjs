// Tests for agent/storage/file-names.mjs: object names and content types, with no file system access
// (the dashboard imports this module, and its bundler would trace the disk otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as names from '../../../agent/storage/file-names.mjs';
import * as store from '../../../agent/storage/file-store.mjs';

test('the module reads nothing from the disk', () => {
  const source = readFileSync(new URL('../../../agent/storage/file-names.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"](node:)?fs(\/promises)?['"]/);
  assert.doesNotMatch(source, /import\(/);
});

test('object names, safe names and content types', () => {
  assert.equal(names.outgoingObjectName('files/', 'w-1', '../x/Q3 report.docx'), 'files/out/w-1/Q3 report.docx');
  assert.equal(names.incomingObjectName('files', 'u-1-ab', 'scan.pdf'), 'files/in/u-1-ab/scan.pdf');
  assert.throws(() => names.idSegment('', 'missionId'), /missionId is required/);
  assert.equal(names.idSegment('a/b c', 'x'), 'a_b_c');
  assert.equal(names.contentTypeFor('old.XLS'), 'application/vnd.ms-excel');
  assert.equal(names.contentTypeFor('notes.odt'), 'application/vnd.oasis.opendocument.text');
  assert.equal(names.sanitizeFileName('a\u0007b.md'), 'ab.md');
});

test('file-store re-exports the same helpers, so existing callers keep working', () => {
  for (const name of ['contentTypeFor', 'sanitizeFileName', 'outgoingObjectName', 'incomingObjectName', 'CONTENT_TYPES']) {
    assert.equal(store[name], names[name], name);
  }
});
