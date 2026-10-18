// Tests for agent/files/shared-files.mjs: the block naming each shared file's fetch command, upload
// ids read from object paths, and shared-file lists merged without repeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSharedFiles, sharedFilesBlock, shellArg, uploadIdOf } from '../../../agent/files/shared-files.mjs';

test('each shared file gets the exact command, its path quoted for the shell when it must be', () => {
  const block = sharedFilesBlock([{ name: 'a b.pdf', size: 3, gcsPath: 'files/in/u-1-aaaaaaaa/a b.pdf' }, { name: 'gone.doc' }], 'w-1');
  assert.match(block, /^## Files shared with this request\n/);
  assert.ok(block.includes("- a b.pdf (3 bytes): `file-get --mission w-1 'files/in/u-1-aaaaaaaa/a b.pdf'`"));
  assert.ok(block.endsWith('- gone.doc: no stored copy'));
  assert.equal(sharedFilesBlock([], 'w-1'), '');
  assert.equal(shellArg("it's"), "'it'\\''s'");
  assert.equal(shellArg('files/in/u-1-aaaaaaaa/x.pdf'), 'files/in/u-1-aaaaaaaa/x.pdf');
});

test('an upload id is read from the object path', () => {
  assert.equal(uploadIdOf('files/in/u-1760000000000-1a2b3c4d/q3.xlsx'), 'u-1760000000000-1a2b3c4d');
  assert.equal(uploadIdOf('gs://b/files/in/u-1-abcdef12/x'), 'u-1-abcdef12');
  assert.equal(uploadIdOf('files/out/w-1/x.pdf'), null);
  assert.equal(uploadIdOf(undefined), null);
});

test('merged lists keep each object once, in order', () => {
  const a = { name: 'a', size: 1, gcsPath: 'files/in/u-1-aaaaaaaa/a' };
  assert.deepEqual(mergeSharedFiles([a], [a, { name: 'b' }, { name: 'b' }, null]), [a, { name: 'b', size: 0, gcsPath: '' }]);
});
