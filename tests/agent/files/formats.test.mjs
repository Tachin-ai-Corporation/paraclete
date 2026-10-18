// Tests for agent/files/formats.mjs: what a file is, from its bytes first, its extension only between
// text formats, and `file --mime-type` only when the bytes leave it open.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, formatForMime, formatForName, labelOf, looksLikeText, mimeOf, normalizeFormat,
} from '../../../agent/files/formats.mjs';
import { fakeRunner, officeBytes, openDocumentBytes, PDF_BYTES, pngBytes, scratch, zipBytes } from './helpers.mjs';

const dir = scratch('formats-test-');
after(() => dir.cleanup());

test('names, aliases and MIME types map to format ids', () => {
  assert.equal(normalizeFormat('JPEG'), 'jpg');
  assert.equal(normalizeFormat('.markdown'), 'md');
  assert.equal(normalizeFormat('tif'), 'tiff');
  assert.equal(normalizeFormat('exe'), null);
  assert.equal(formatForName('/x/Report.DOCX'), 'docx');
  assert.equal(formatForName('noext'), null);
  assert.equal(formatForMime('text/csv; charset=utf-8'), 'csv');
  assert.equal(formatForMime('application/x-pdf'), 'pdf');
  assert.equal(mimeOf('xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(labelOf('pptx'), 'PowerPoint presentation');
});

test('text is told from binary by its bytes', () => {
  assert.equal(looksLikeText(Buffer.from('hello\nworld\t1')), true);
  assert.equal(looksLikeText(Buffer.from([0x61, 0x00, 0x62])), false);
  assert.equal(looksLikeText(Buffer.alloc(0)), true);
});

test('binary formats are detected from their bytes, whatever the name says', async () => {
  const cases = {
    'scan.bin': ['pdf', PDF_BYTES],
    'a.pdf.docx': ['docx', officeBytes('docx')],
    'book.dat': ['xlsx', officeBytes('xlsx')],
    'deck': ['pptx', officeBytes('pptx')],
    'notes.zip': ['odt', openDocumentBytes('odt')],
    'sheet.bin': ['ods', openDocumentBytes('ods')],
    'slides.bin': ['odp', openDocumentBytes('odp')],
    'plain.bin': ['zip', zipBytes({ 'a.txt': 'a' })],
    'pic.jpg': ['png', pngBytes()],
    'photo': ['jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])],
    'anim': ['gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')],
    'img': ['webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])],
    'doc.txt': ['rtf', Buffer.from('{\\rtf1\\ansi hello}')],
    'scan.tif': ['tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])],
  };
  for (const [name, [format, bytes]] of Object.entries(cases)) {
    const detected = await detectFormat(dir.file(`bin/${name}`, bytes));
    assert.equal(detected.format, format, name);
  }
});

test('text formats: markup by its first tag, otherwise the extension, otherwise plain text', async () => {
  assert.equal((await detectFormat(dir.file('t/a.md', '# Title'))).format, 'md');
  assert.equal((await detectFormat(dir.file('t/a.csv', 'a,b\n1,2'))).format, 'csv');
  assert.equal((await detectFormat(dir.file('t/a.json', '{"a":1}'))).format, 'json');
  assert.equal((await detectFormat(dir.file('t/page', '<!DOCTYPE html><html></html>'))).format, 'html');
  assert.equal((await detectFormat(dir.file('t/logo.txt', '<?xml version="1.0"?>\n<svg width="10"></svg>'))).format, 'svg');
  assert.equal((await detectFormat(dir.file('t/script.py', 'print(1)'))).format, 'txt');
  assert.equal((await detectFormat(dir.file('t/BMW notes.txt', 'BMW report for Q3'))).format, 'txt', 'text starting with BM is not a bitmap');
  assert.equal((await detectFormat(dir.file('t/empty.md', ''))).format, 'md');
});

test('an old Office container goes by its extension, else by `file`; an unknown binary says what `file` saw', async () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
  assert.equal((await detectFormat(dir.file('o/old.xls', ole))).format, 'xls');

  const runner = fakeRunner({ file: (args) => ({ stdout: args.at(-1).endsWith('mystery') ? 'application/vnd.ms-powerpoint\n' : 'application/x-executable\n' }) });
  assert.equal((await detectFormat(dir.file('o/mystery', ole), { runner })).format, 'ppt');
  assert.deepEqual(runner.calls[0].args.slice(0, 2), ['--brief', '--mime-type']);
  const unknown = await detectFormat(dir.file('o/prog', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0])), { runner });
  assert.deepEqual([unknown.format, unknown.mime], [null, 'application/x-executable']);
  const noRunner = await detectFormat(dir.file('o/prog2', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0])));
  assert.equal(noRunner.format, null);
});
