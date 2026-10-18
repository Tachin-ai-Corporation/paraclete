// Tests for agent/files/zip.mjs: listing and inflating a ZIP container's entries.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { listZipEntries, openZip, readZipEntry } from '../../../agent/files/zip.mjs';
import { scratch, zipBytes } from './helpers.mjs';

const dir = scratch('zip-test-');
after(() => dir.cleanup());

test('lists every entry with its sizes, and reads deflated and stored entries back', () => {
  const big = 'x'.repeat(10_000);
  const deflated = dir.file('a.zip', zipBytes({ 'word/document.xml': '<w>hello</w>', 'big.txt': big }));
  const entries = listZipEntries(deflated);
  assert.deepEqual(entries.map((e) => [e.name, e.size]), [['word/document.xml', 12], ['big.txt', 10_000]]);
  assert.ok(entries[1].compressedSize < 10_000, 'deflated');
  assert.equal(readZipEntry(deflated, entries[1]).toString(), big);

  const stored = dir.file('b.zip', zipBytes({ mimetype: 'application/vnd.oasis.opendocument.text' }, { store: true }));
  const zip = openZip(stored);
  assert.deepEqual(zip.names, ['mimetype']);
  assert.equal(zip.text('mimetype'), 'application/vnd.oasis.opendocument.text');
  assert.equal(zip.has('content.xml'), false);
  assert.equal(zip.read('content.xml'), null);
});

test('refuses what is not a ZIP, and an entry larger than the cap', () => {
  assert.throws(() => listZipEntries(dir.file('short', 'PK')), /too short/);
  assert.throws(() => listZipEntries(dir.file('text.txt', 'just some text that is long enough to look')), /no end of central directory/);
  const path = dir.file('c.zip', zipBytes({ 'a.txt': 'y'.repeat(5000) }));
  const [entry] = listZipEntries(path);
  assert.throws(() => readZipEntry(path, entry, { maxBytes: 100 }), /larger than 100 bytes/);
});
