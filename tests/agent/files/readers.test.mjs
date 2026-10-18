// Tests for agent/files/readers.mjs: each kind of file read as text or Markdown, with page, sheet and
// slide selection, and every cut and approximation said.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeSelection, parseSelection, readDocument, ReadRequestError, toRanges } from '../../../agent/files/readers.mjs';
import { argAfter, fakeRunner, officeBytes, PDF_BYTES, pngBytes, scratch, zipBytes } from './helpers.mjs';

const dir = scratch('readers-test-');
after(() => dir.cleanup());

/** A fake poppler for a PDF of `pages` pages whose page n reads "text of page n". */
function pdfTools(pages, text = (n) => `text of page ${n}`) {
  return {
    pdfinfo: () => ({ stdout: `Title: x\nPages:          ${pages}\nEncrypted: no\n` }),
    pdftotext: (args) => {
      const first = Number(argAfter(args, '-f'));
      const last = Number(argAfter(args, '-l'));
      return { stdout: Array.from({ length: last - first + 1 }, (_, i) => `${text(first + i)}\f`).join('') };
    },
  };
}

test('selections: numbers, ranges, open ends, deduplicated and checked against the count', () => {
  assert.deepEqual(parseSelection('3', 5, 'page'), [3]);
  assert.deepEqual(parseSelection('4-, 1-2, 2', 5, 'page'), [1, 2, 4, 5]);
  assert.deepEqual(parseSelection('2-9', 4, 'slide'), [2, 3, 4], 'a range past the end stops at the end');
  assert.throws(() => parseSelection('7', 4, 'page'), (err) => err instanceof ReadRequestError && /page 7 does not exist: there are 4 pages/.test(err.message));
  assert.throws(() => parseSelection('3-1', 4, 'page'), /low to high/);
  assert.throws(() => parseSelection('first', 4, 'page'), /not a page selection/);
  assert.throws(() => parseSelection('', 4, 'page'), /no pages selected/);
  assert.deepEqual(toRanges([1, 2, 3, 5, 7, 8]), [[1, 3], [5, 5], [7, 8]]);
  assert.equal(describeSelection([1, 2, 3, 5]), '1-3, 5');
});

test('a PDF reads page by page from its text layer, with the pages asked for', async () => {
  const path = dir.file('report.pdf', PDF_BYTES);
  const runner = fakeRunner(pdfTools(5));
  const all = await readDocument(path, { runner });
  assert.equal(all.header, 'PDF, 5 pages');
  assert.match(all.text, /^<!-- page 1 -->\ntext of page 1\n\n<!-- page 2 -->/);
  assert.match(all.notes[0], /text layer/);
  const pdftotext = runner.calls.find((c) => c.program === 'pdftotext').args;
  assert.deepEqual(pdftotext, ['-layout', '-enc', 'UTF-8', '-f', '1', '-l', '5', path, '-']);

  const some = await readDocument(path, { runner: fakeRunner(pdfTools(5)), pages: '1,4-5', format: 'text' });
  assert.equal(some.header, 'PDF, 5 pages; pages 1, 4-5');
  assert.equal(some.text, '--- page 1 ---\ntext of page 1\n\n--- page 4 ---\ntext of page 4\n\n--- page 5 ---\ntext of page 5');
  await assert.rejects(readDocument(path, { runner: fakeRunner(pdfTools(2)), pages: '3' }), ReadRequestError);
});

test('a scanned PDF says so and gives the route to look at its pages', async () => {
  const result = await readDocument(dir.file('scan.pdf', PDF_BYTES), { runner: fakeRunner(pdfTools(2, () => '  ')) });
  assert.ok(result.notes.some((n) => /no text layer.*file-convert <pdf> png --pages/.test(n)));
});

test('a long result is cut at --max, and the cut says how to read the rest', async () => {
  const result = await readDocument(dir.file('long.pdf', PDF_BYTES), { runner: fakeRunner(pdfTools(3, () => 'x'.repeat(100))), max: 50 });
  assert.equal(result.text.length, 50);
  assert.match(result.notes[0], /^Cut at 50 of \d+ characters: read the rest with --pages or with a larger --max\.$/);
  const text = await readDocument(dir.file('big.md', 'y'.repeat(80)), { runner: fakeRunner(), max: 10 });
  assert.match(text.notes[0], /a line range with the readFile tool/);
});

test('Word and HTML read through pandoc; .doc and .rtf through LibreOffice first', async () => {
  const runner = fakeRunner({ pandoc: (args) => ({ stdout: argAfter(args, '--to') === 'gfm' ? '# Memo\n\n| a | b |\n' : 'MEMO\n' }) });
  const docx = dir.file('memo.docx', officeBytes('docx'));
  const md = await readDocument(docx, { runner });
  assert.deepEqual([md.header, md.text], ['Word document', '# Memo\n\n| a | b |']);
  assert.deepEqual(runner.calls.at(-1).args, ['--from', 'docx', '--to', 'gfm', '--wrap=none', docx]);
  assert.equal((await readDocument(docx, { runner, format: 'text' })).text, 'MEMO');

  const page = await readDocument(dir.file('page.html', '<html><body><h1>Hi</h1></body></html>'), { runner });
  assert.equal(page.header, 'HTML page');
  assert.equal(runner.calls.at(-1).args[1], 'html');

  const old = fakeRunner({
    soffice: (args) => { writeFileSync(join(args[args.indexOf('--outdir') + 1], 'legacy.docx'), 'x'); },
    pandoc: () => ({ stdout: 'converted' }),
  });
  const rtf = await readDocument(dir.file('legacy.rtf', '{\\rtf1 hi}'), { runner: old });
  assert.deepEqual([rtf.header, rtf.text], ['Rich Text document (read through LibreOffice)', 'converted']);
  assert.deepEqual(old.calls.map((c) => c.program), ['soffice', 'pandoc']);
});

test('a workbook reads each sheet as a table; --sheet picks one', async () => {
  const sheets = { sheets: [{ name: 'Q3', hidden: false, rows: [['Region', 'Sales'], ['North', '120']], more: true }, { name: 'Raw', hidden: true, rows: [['x']], more: false }] };
  const runner = fakeRunner({ python3: () => ({ stdout: JSON.stringify(sheets) }) });
  const book = dir.file('book.xlsx', officeBytes('xlsx'));
  const all = await readDocument(book, { runner });
  assert.equal(all.header, "Excel workbook, 2 sheets (1 'Q3', 2 'Raw')");
  assert.match(all.text, /^## Sheet: Q3\n\n\| Region \| Sales \|\n\| --- \| --- \|\n\| North \| 120 \|\n\n## Sheet: Raw \(hidden\)/);
  assert.ok(all.notes.some((n) => /last calculated and saved/.test(n)));
  assert.ok(all.notes.some((n) => /Sheet 'Q3' has more rows than the 2 read/.test(n)));
  const one = await readDocument(book, { runner, sheet: 'raw', format: 'text' });
  assert.equal(one.text, '# Sheet: Raw (hidden)\nx');
  assert.match(one.header, /; sheet 'Raw'$/);

  const csv = await readDocument(dir.file('t.csv', 'a,b\n1,2\n'), { runner: fakeRunner() });
  assert.equal(csv.header, 'CSV table, 1 sheet (1 \'t\')');
  assert.deepEqual(csv.notes, []);
});

test('a presentation reads slide by slide; --slides picks some', async () => {
  const ns = 'xmlns:a="a" xmlns:p="p" xmlns:r="r"';
  const slide = (title) => `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const deck = dir.file('deck.pptx', zipBytes({
    '[Content_Types].xml': '<Types/>',
    'ppt/presentation.xml': `<p:presentation ${ns}/>`,
    'ppt/slides/slide1.xml': slide('One'),
    'ppt/slides/slide2.xml': slide('Two'),
    'ppt/slides/slide3.xml': slide('Three'),
  }));
  const result = await readDocument(deck, { runner: fakeRunner(), slides: '2-3' });
  assert.equal(result.header, 'PowerPoint presentation, 3 slides; slides 2-3');
  assert.equal(result.text, '## Slide 2: Two\n\n(no text)\n\n## Slide 3: Three\n\n(no text)');
  assert.match(result.notes[0], /file-convert <file> png/);
});

test('an image reports its size and the route to look at it; a ZIP lists its files; text is as is', async () => {
  const png = await readDocument(dir.file('chart.png', pngBytes(800, 600)), { runner: fakeRunner() });
  assert.equal(png.header, 'PNG image, 800 x 600 pixels');
  assert.match(png.text, /viewImage tool/);
  const gif = await readDocument(dir.file('anim.gif', Buffer.from('GIF89a\x02\x00\x02\x00', 'latin1')), { runner: fakeRunner() });
  assert.match(gif.text, /file-convert <file> png/);
  const zip = await readDocument(dir.file('bundle.zip', zipBytes({ 'a.txt': 'aaa', 'docs/b.md': 'b' })), { runner: fakeRunner() });
  assert.deepEqual([zip.header, zip.text], ['ZIP archive, 2 files', 'a.txt (3 bytes)\ndocs/b.md (1 bytes)']);
  const json = await readDocument(dir.file('data.json', '{"a": 1}'), { runner: fakeRunner() });
  assert.deepEqual([json.header, json.text], ['JSON', '{"a": 1}']);
});

test('a selection that does not fit the file, or a format it cannot read, is refused', async () => {
  const md = dir.file('notes.md', '# Notes');
  await assert.rejects(readDocument(md, { runner: fakeRunner(), pages: '1' }), (err) => err instanceof ReadRequestError && /--pages applies to a PDF; notes\.md is Markdown/.test(err.message));
  await assert.rejects(readDocument(md, { runner: fakeRunner(), sheet: '1' }), /--sheet applies to a spreadsheet/);
  await assert.rejects(readDocument(md, { runner: fakeRunner(), slides: '1' }), /--slides applies to a presentation/);
  const binary = dir.file('prog.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
  await assert.rejects(readDocument(binary, { runner: fakeRunner({ file: () => ({ stdout: 'application/x-executable' }) }) }), /cannot read prog\.bin: it is application\/x-executable/);
  await assert.rejects(readDocument(dir.dir('a-dir'), { runner: fakeRunner() }), /is not a file/);
});
