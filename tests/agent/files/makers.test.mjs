// Tests for agent/files/makers.mjs: new files from Markdown, HTML, CSV and JSON the agent wrote, with
// the program and arguments each takes, and what is refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonTables, MAKES, makeFile, MakeRefused, makeTable } from '../../../agent/files/makers.mjs';
import { argAfter, argValue, fakeRunner, scratch } from './helpers.mjs';

const dir = scratch('makers-test-');
after(() => dir.cleanup());

function toolchain() {
  return fakeRunner({
    pandoc: (args) => {
      const out = argAfter(args, '--output');
      if (out) { writeFileSync(out, 'made'); return {}; }
      return { stdout: '<h1>T</h1>' };
    },
    chromium: (args) => { writeFileSync(argValue(args, '--print-to-pdf=') || argValue(args, '--screenshot='), 'made'); },
    python3: (args) => { writeFileSync(args[3], 'xlsx'); },
  }, { tmpRoot: dir.dir('tmp') });
}

const pandocCall = (runner) => runner.calls.filter((c) => c.program === 'pandoc').at(-1).args;

test('the make table', () => {
  assert.deepEqual(MAKES.md, ['docx', 'pdf', 'html', 'pptx']);
  assert.match(makeTable(), /^json -> xlsx, csv$/m);
});

test('Markdown from stdin becomes Word with a title and a reference document, images resolving from the working directory', async () => {
  const runner = toolchain();
  const ref = dir.file('brand.docx', 'x');
  const made = await makeFile({ format: 'docx', from: 'md', source: '# Q3\n\n|a|b|\n|-|-|\n|1|2|', out: 'out/q3', title: 'Q3 Report', referenceDoc: 'brand.docx', runner, cwd: dir.root });
  assert.equal(made.path, join(dir.root, 'out', 'q3.docx'));
  assert.equal(readFileSync(made.path, 'utf8'), 'made');
  const args = pandocCall(runner);
  assert.deepEqual([argAfter(args, '--from'), argAfter(args, '--to'), argAfter(args, '--metadata')], ['gfm', 'docx', 'title=Q3 Report']);
  assert.equal(argValue(args, '--reference-doc='), ref);
  assert.equal(argValue(args, '--resource-path='), dir.root);
  assert.match(args.at(-1), /source\.md$/, 'stdin is written to a scratch file first');
});

test('Markdown from a file becomes a deck, an HTML page, or a PDF printed by Chromium', async () => {
  const runner = toolchain();
  const src = dir.file('src/deck.md', '# One\n\n---\n\n# Two');
  const deck = await makeFile({ format: 'pptx', from: 'md', sourcePath: src, out: 'deck.pptx', runner, cwd: dir.root });
  assert.match(deck.notes[0], /top heading starts a slide/);
  assert.equal(pandocCall(runner).at(-1), src);
  assert.equal(argValue(pandocCall(runner), '--resource-path='), join(dir.root, 'src'));

  const html = await makeFile({ format: 'html', from: 'markdown', sourcePath: src, out: 'page.html', runner, cwd: dir.root });
  assert.match(readFileSync(html.path, 'utf8'), /<style>/);

  const pdf = await makeFile({ format: 'pdf', from: 'md', sourcePath: src, out: 'doc.pdf', runner, cwd: dir.root });
  assert.ok(existsSync(pdf.path));
  assert.ok(runner.calls.some((c) => c.program === 'chromium' && c.args.includes('--no-pdf-header-footer')));
});

test('HTML from stdin gets a base for relative links, and prints, screenshots or becomes Word', async () => {
  const runner = toolchain();
  await makeFile({ format: 'pdf', from: 'html', source: '<html><head><title>x</title></head><body><img src="chart.png"></body></html>', out: 'h.pdf', runner, cwd: dir.root });
  const printed = runner.calls.find((c) => c.program === 'chromium').args.at(-1);
  assert.match(printed, /source\.html$/);
  const png = await makeFile({ format: 'png', from: 'html', source: '<p>x</p>', out: 'h.png', runner, cwd: dir.root });
  assert.match(png.notes[0], /first 1280 x 1600 pixels/);
  await makeFile({ format: 'docx', from: 'html', source: '<p>x</p>', out: 'h.docx', runner, cwd: dir.root });
  assert.deepEqual([argAfter(pandocCall(runner), '--from'), argAfter(pandocCall(runner), '--to')], ['html', 'docx']);
});

test('CSV and JSON become a workbook; JSON becomes CSV', async () => {
  const runner = toolchain();
  await makeFile({ format: 'xlsx', from: 'csv', source: 'id,amount\n007,12.5\n', out: 'a.xlsx', runner, cwd: dir.root });
  let input = JSON.parse(runner.calls.at(-1).opts.input);
  assert.deepEqual(input.sheets, [{ name: 'a', rows: [['id', 'amount'], ['007', 12.5]], header: true }]);

  await makeFile({ format: 'xlsx', from: 'json', source: JSON.stringify({ Sales: [{ region: 'N', total: '=SUM(B2:B3)' }], Notes: [['a'], ['b']] }), out: 'b.xlsx', runner, cwd: dir.root });
  input = JSON.parse(runner.calls.at(-1).opts.input);
  assert.deepEqual(input.sheets.map((s) => [s.name, s.rows]), [['Sales', [['region', 'total'], ['N', '=SUM(B2:B3)']]], ['Notes', [['a'], ['b']]]]);

  await makeFile({ format: 'xlsx', from: 'json', source: '[[1,2]]', out: 'c.xlsx', title: 'Totals', runner, cwd: dir.root });
  assert.equal(JSON.parse(runner.calls.at(-1).opts.input).sheets[0].name, 'Totals');

  const csv = await makeFile({ format: 'csv', from: 'json', source: '[{"a":1,"b":"x, y"},{"a":2,"c":null}]', out: 'd.csv', runner, cwd: dir.root });
  assert.equal(readFileSync(csv.path, 'utf8'), 'a,b,c\n1,"x, y",\n2,,\n');
  await assert.rejects(makeFile({ format: 'csv', from: 'json', source: '{"x":[[1]],"y":[[2]]}', out: 'e.csv', runner, cwd: dir.root }), /holds one table, and the JSON has 2/);
  await assert.rejects(makeFile({ format: 'xlsx', from: 'json', source: '{not json', out: 'f.xlsx', runner, cwd: dir.root }), /not valid JSON/);
});

test('JSON shapes: objects, arrays, sheets of either, and nothing else', () => {
  assert.deepEqual(jsonTables([{ a: 1 }, { b: { c: 2 } }]), [{ name: 'Sheet1', rows: [['a', 'b'], [1, null], [null, '{"c":2}']] }]);
  assert.deepEqual(jsonTables(['x', 2]), [{ name: 'Sheet1', rows: [['value'], ['x'], [2]] }]);
  assert.throws(() => jsonTables({ a: 1 }), MakeRefused);
  assert.throws(() => jsonTables([[1], { a: 1 }]), /mix arrays, objects and plain values/);
});

test('what cannot be made is refused before any work, with what can', async () => {
  const runner = toolchain();
  const refused = (re) => (err) => err instanceof MakeRefused && re.test(err.message);
  await assert.rejects(makeFile({ format: 'xlsx', from: 'md', source: 'x', out: 'a.xlsx', runner, cwd: dir.root }), refused(/md does not make xlsx\. md makes: docx, pdf, html, pptx/));
  await assert.rejects(makeFile({ format: 'pdf', from: 'yaml', source: 'x', out: 'a.pdf', runner, cwd: dir.root }), refused(/--from must be one of md, html, csv, json/));
  await assert.rejects(makeFile({ format: 'docx', from: 'md', source: 'x', out: 'a.pdf', runner, cwd: dir.root }), refused(/ends in \.pdf, but the file made is docx/));
  await assert.rejects(makeFile({ format: 'docx', from: 'md', source: 'x', out: 'a.docx', referenceDoc: 'none.docx', runner, cwd: dir.root }), refused(/does not exist/));
  await assert.rejects(makeFile({ format: 'pdf', from: 'md', source: 'x', out: 'a.pdf', referenceDoc: 'brand.docx', runner, cwd: dir.root }), refused(/--reference-doc applies to Word/));
  await assert.rejects(makeFile({ format: 'docx', from: 'md', out: 'a.docx', runner, cwd: dir.root }), refused(/--in <path> or --stdin/));
  await assert.rejects(makeFile({ format: 'docx', from: 'md', source: 'x', out: dir.dir('somedir'), runner, cwd: dir.root }), refused(/is a directory/));
  assert.equal(runner.calls.length, 0);
});
