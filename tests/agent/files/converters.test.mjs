// Tests for agent/files/converters.mjs: the conversion table, the program each conversion runs and
// with what arguments, where results land, what is said about what was lost, and what is refused.
// The toolchain is fake: each program writes the file the real one would.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CONVERSIONS, conversionTable, ConversionRefused, convertFile, mergePdfs, reflow } from '../../../agent/files/converters.mjs';
import { ToolError } from '../../../agent/files/runner.mjs';
import { argAfter, argValue, fakeRunner, officeBytes, PDF_BYTES, pngBytes, scratch } from './helpers.mjs';

const dir = scratch('converters-test-');
after(() => dir.cleanup());

const stem = (p) => basename(p).replace(/\.[^.]+$/, '');

/** A fake toolchain whose programs write their outputs; `pages` is every PDF's page count. */
function toolchain({ pages = 2, sheets = null, fail = {} } = {}) {
  const handlers = {
    soffice: (args) => {
      const target = argAfter(args, '--convert-to');
      writeFileSync(join(argAfter(args, '--outdir'), `${stem(args.at(-1))}.${target}`), target === 'pdf' ? PDF_BYTES : 'x');
    },
    pandoc: (args) => {
      const out = argAfter(args, '--output');
      if (out) { writeFileSync(out, `${argAfter(args, '--to')} output`); return {}; }
      return { stdout: '<h1>Report</h1>\n<p>Body</p>' };
    },
    chromium: (args) => {
      const out = argValue(args, '--print-to-pdf=') || argValue(args, '--screenshot=');
      writeFileSync(out, out.endsWith('.pdf') ? PDF_BYTES : pngBytes());
    },
    pdfinfo: () => ({ stdout: `Pages: ${pages}\n` }),
    pdftotext: (args) => {
      const first = Number(argAfter(args, '-f'));
      const last = Number(argAfter(args, '-l'));
      return { stdout: Array.from({ length: last - first + 1 }, (_, i) => `Page ${first + i} line one\ncontinues here.\n\n• A bullet\f`).join('') };
    },
    pdftoppm: (args) => {
      const prefix = args.at(-1);
      const width = String(pages).length;
      for (let n = Number(argAfter(args, '-f')); n <= Number(argAfter(args, '-l')); n++) {
        writeFileSync(`${prefix}-${String(n).padStart(width, '0')}.png`, pngBytes());
      }
    },
    qpdf: (args) => { writeFileSync(args.at(-1), PDF_BYTES); },
    convert: (args) => { writeFileSync(args.at(-1), pngBytes()); },
    python3: (args, opts) => {
      if (opts.input) { writeFileSync(args[3], 'xlsx'); return {}; }
      return { stdout: JSON.stringify(sheets || { sheets: [{ name: 'Q3', rows: [['a', 'b'], ['1', '2']] }, { name: 'Raw data', rows: [['x']] }] }) };
    },
  };
  for (const [program, answer] of Object.entries(fail)) handlers[program] = () => answer;
  return fakeRunner(handlers, { tmpRoot: dir.dir('tmp') });
}

const calls = (runner, program) => runner.calls.filter((c) => c.program === program);

test('the table covers what the brief names, and prints as lines', () => {
  assert.deepEqual(CONVERSIONS.pdf, ['pdf', 'md', 'txt', 'docx', 'png']);
  assert.ok(CONVERSIONS.md.includes('pptx'));
  assert.ok(CONVERSIONS.pptx.includes('png') && CONVERSIONS.docx.includes('png') && CONVERSIONS.gif.includes('png'));
  assert.match(conversionTable(), /^docx -> pdf, html, md, txt, png$/m);
});

test('an office file renders to PDF through LibreOffice, next to the source', async () => {
  const runner = toolchain();
  const src = dir.file('a/memo.docx', officeBytes('docx'));
  const result = await convertFile(src, 'pdf', { runner });
  assert.deepEqual([result.from, result.to, result.outputs], ['docx', 'pdf', [join(dir.root, 'a', 'memo.pdf')]]);
  assert.match(result.notes[0], /LibreOffice: fonts missing on this host are substituted/);
  assert.equal(argAfter(calls(runner, 'soffice')[0].args, '--convert-to'), 'pdf');
});

test('Markdown prints to PDF through a styled page in Chromium; to Word through pandoc', async () => {
  const runner = toolchain();
  const src = dir.file('b/report.md', '# Report\n\nBody');
  const pdf = await convertFile(src, 'pdf', { runner, out: dir.dir('b/out') });
  assert.deepEqual(pdf.outputs, [join(dir.root, 'b', 'out', 'report.pdf')]);
  const [md] = calls(runner, 'pandoc');
  assert.deepEqual(md.args, ['--from', 'gfm', '--to', 'html5', '--wrap=none', src]);
  const chromium = calls(runner, 'chromium')[0].args;
  assert.ok(chromium.includes('--no-pdf-header-footer'));
  assert.match(chromium.at(-1), /^file:\/\/.*page\.html$/);

  const docx = await convertFile(src, 'docx', { runner, out: 'b/report-final', cwd: dir.root });
  assert.deepEqual(docx.outputs, [join(dir.root, 'b', 'report-final.docx')], 'an --out without an extension gets one');
  const writer = calls(runner, 'pandoc').at(-1).args;
  assert.deepEqual([argAfter(writer, '--from'), argAfter(writer, '--to')], ['gfm', 'docx']);
  assert.equal(argValue(writer, '--resource-path='), join(dir.root, 'b'));
});

test('slides and documents become one PNG per page, named by page, and --pages picks them', async () => {
  const runner = toolchain({ pages: 12 });
  const deck = dir.file('c/deck.pptx', officeBytes('pptx'));
  const all = await convertFile(deck, 'png', { runner });
  assert.equal(all.outputs.length, 12);
  assert.equal(basename(all.outputs[0]), 'deck-1.png', 'zero padding dropped');
  assert.equal(basename(all.outputs[11]), 'deck-12.png');
  assert.equal(argAfter(calls(runner, 'pdftoppm')[0].args, '-r'), '150');

  const some = await convertFile(deck, 'png', { runner: toolchain({ pages: 12 }), pages: '2,5-6', out: 'c/slides/', cwd: dir.root });
  assert.deepEqual(some.outputs.map((p) => basename(p)), ['deck-2.png', 'deck-5.png', 'deck-6.png']);
  assert.ok(some.outputs.every((p) => p.startsWith(join(dir.root, 'c', 'slides'))));

  const small = toolchain({ pages: 1 });
  await convertFile(dir.file('c/scan.pdf', PDF_BYTES), 'png', { runner: small, maxSide: 900 });
  assert.equal(argAfter(calls(small, 'pdftoppm')[0].args, '-scale-to'), '900');
  await assert.rejects(convertFile(deck, 'png', { runner: toolchain({ pages: 3 }), pages: '4' }), /slide 4 does not exist: there are 3 slides/);
});

test('PDF pages are extracted with qpdf; PDFs merge in order', async () => {
  const runner = toolchain({ pages: 9 });
  const src = dir.file('d/book.pdf', PDF_BYTES);
  const result = await convertFile(src, 'pdf', { runner, pages: '2-4,7' });
  assert.deepEqual(result.outputs, [join(dir.root, 'd', 'book-pages-2-4_7.pdf')]);
  const qpdf = calls(runner, 'qpdf')[0].args;
  assert.deepEqual(qpdf.slice(0, 5), ['--empty', '--pages', src, '2-4,7', '--']);
  assert.match(result.notes[0], /Pages 2-4, 7 of 9/);

  const b = dir.file('d/b.pdf', PDF_BYTES);
  const merged = await mergePdfs([src, b], { runner });
  assert.deepEqual(merged.outputs, [join(dir.root, 'd', 'merged.pdf')]);
  assert.deepEqual(calls(runner, 'qpdf').at(-1).args.slice(0, 4), ['--empty', '--pages', src, b]);
  await assert.rejects(mergePdfs([src], { runner }), /at least two PDFs/);
  await assert.rejects(mergePdfs([src, dir.file('d/x.md', '# x')], { runner }), /x\.md is Markdown, not a PDF/);
  await assert.rejects(mergePdfs([src, b], { runner, out: b }), /overwrite one of its sources/);
});

test('a PDF to Markdown or Word is a text-level rebuild, and says so', async () => {
  const runner = toolchain({ pages: 2 });
  const src = dir.file('e/paper.pdf', PDF_BYTES);
  const md = await convertFile(src, 'md', { runner });
  const text = readFileSync(md.outputs[0], 'utf8');
  assert.match(text, /^<!-- page 1 -->\n\nPage 1 line one continues here\.\n\n• A bullet/);
  assert.match(md.notes[0], /text-level rebuild/);
  assert.ok(!calls(runner, 'pdftotext')[0].args.includes('-layout'), 'reading order, not layout, for a rebuild');

  const docx = await convertFile(src, 'docx', { runner });
  assert.equal(basename(docx.outputs[0]), 'paper.docx');
  const writer = calls(runner, 'pandoc').at(-1).args;
  assert.deepEqual([argAfter(writer, '--from'), argAfter(writer, '--to')], ['html', 'docx']);

  const txt = await convertFile(src, 'txt', { runner, pages: '2' });
  assert.equal(readFileSync(txt.outputs[0], 'utf8').startsWith('Page 2 line one'), true);
  assert.ok(calls(runner, 'pdftotext').at(-1).args.includes('-layout'));
});

test('a workbook to CSV makes one file per sheet unless --sheet picks one; CSV to Excel types its cells', async () => {
  const runner = toolchain();
  const book = dir.file('f/sales.xlsx', officeBytes('xlsx'));
  const all = await convertFile(book, 'csv', { runner });
  assert.deepEqual(all.outputs.map((p) => basename(p)), ['sales-Q3.csv', 'sales-Raw_data.csv']);
  assert.equal(readFileSync(all.outputs[0], 'utf8'), 'a,b\n1,2\n');
  assert.equal(calls(runner, 'python3')[0].args[4], '0', 'every row, not a reading cap');
  const one = await convertFile(book, 'csv', { runner, sheet: 'raw data', out: dir.file('f/out.csv', '') });
  assert.deepEqual(one.outputs, [join(dir.root, 'f', 'out.csv')]);

  const csv = dir.file('f/list.csv', 'id,qty\n007,5\n');
  const x = await convertFile(csv, 'xlsx', { runner });
  assert.equal(basename(x.outputs[0]), 'list.xlsx');
  const input = JSON.parse(calls(runner, 'python3').at(-1).opts.input);
  assert.deepEqual(input.sheets[0].rows, [['id', 'qty'], ['007', 5]]);
});

test('images convert with ImageMagick, shrink with --max-side, and go to PDF through Chromium', async () => {
  const runner = toolchain();
  const png = dir.file('g/chart.png', pngBytes(4000, 3000));
  const jpg = await convertFile(png, 'jpg', { runner, maxSide: 2000 });
  const args = calls(runner, 'convert')[0].args;
  assert.deepEqual(args.slice(0, 3), [png, '-resize', '2000x2000>']);
  assert.ok(args.includes('-alpha') && args.includes('white'));
  assert.ok(jpg.notes.some((n) => /transparent areas became white/.test(n)));

  const smaller = await convertFile(png, 'png', { runner, maxSide: 800 });
  assert.equal(basename(smaller.outputs[0]), 'chart-800px.png');
  await assert.rejects(convertFile(png, 'png', { runner }), /already png: give --max-side/);

  const gif = dir.file('g/anim.gif', Buffer.from('GIF89a\x02\x00\x02\x00', 'latin1'));
  await convertFile(gif, 'png', { runner });
  assert.equal(calls(runner, 'convert').at(-1).args[0], `${gif}[0]`);

  const pdf = await convertFile(png, 'pdf', { runner });
  assert.equal(basename(pdf.outputs[0]), 'chart.pdf');
  const page = calls(runner, 'chromium').at(-1).args.at(-1);
  assert.match(page, /page\.html$/);
});

test('HTML to PNG is a screenshot at a window size', async () => {
  const runner = toolchain();
  const html = dir.file('h/dash.html', '<!DOCTYPE html><html><body>hi</body></html>');
  const result = await convertFile(html, 'png', { runner, size: { width: 1600, height: 900 } });
  assert.equal(basename(result.outputs[0]), 'dash.png');
  assert.ok(calls(runner, 'chromium')[0].args.includes('--window-size=1600,900'));
  assert.match(result.notes[0], /first 1600 x 900 pixels/);
});

test('what cannot be done is refused before any work, with what can', async () => {
  const runner = toolchain();
  const docx = dir.file('i/memo.docx', officeBytes('docx'));
  const refused = (re) => (err) => err instanceof ConversionRefused && re.test(err.message);
  await assert.rejects(convertFile(docx, 'xlsx', { runner }), refused(/cannot convert Word document \(memo\.docx\) to xlsx\. Word document converts to: pdf, html, md, txt, png/));
  await assert.rejects(convertFile(dir.file('i/blob.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0])), 'pdf', { runner }), refused(/unknown binary data\. The conversions there are:\ndocx -> /));
  await assert.rejects(convertFile(dir.file('i/x.pdf', PDF_BYTES), 'pdf', { runner }), refused(/already a PDF: give --pages/));
  await assert.rejects(convertFile(docx, 'pdf', { runner, sheet: '1' }), refused(/--sheet applies when converting a workbook to CSV/));
  await assert.rejects(convertFile(docx, 'pdf', { runner, pages: '1' }), refused(/--pages applies to a PDF/));
  await assert.rejects(convertFile(docx, 'pdf', { runner, maxSide: 100 }), refused(/--max-side applies to PNG/));
  await assert.rejects(convertFile(docx, 'pdf', { runner, out: 'memo.html', cwd: dir.root }), refused(/ends in \.html, but the conversion makes pdf/));
  await assert.rejects(convertFile(join(dir.root, 'i', 'none.docx'), 'pdf', { runner }), refused(/is not a file/));
  assert.equal(runner.calls.filter((c) => c.program !== 'file').length, 0, 'no program ran');
});

test('a failed program leaves nothing half-written', async () => {
  const runner = toolchain({ fail: { soffice: { code: 1, stderr: 'Error: source file could not be loaded' } } });
  const docx = dir.file('j/broken.docx', officeBytes('docx'));
  await assert.rejects(convertFile(docx, 'pdf', { runner }), (err) => err instanceof ToolError && /could not be loaded/.test(err.message));
  assert.deepEqual(readdirSync(join(dir.root, 'j')), ['broken.docx']);
  assert.equal(existsSync(join(dir.root, 'tmp')) && readdirSync(join(dir.root, 'tmp')).length, 0, 'scratch removed');
});

test('reflow joins wrapped lines, mends hyphenation, and keeps list items apart', () => {
  assert.deepEqual(reflow('A sentence that\nwraps and is hyph-\nenated here.\n\n• one\n• two\n  continued\n1. first'), [
    'A sentence that wraps and is hyphenated here.', '• one', '• two continued', '1. first',
  ]);
});
