// tests/agent/files/toolchain-smoke.test.mjs: the files package against the real toolchain (pandoc,
// LibreOffice, Chromium, poppler, qpdf, ImageMagick, python3 with openpyxl). Skipped unless
// PARACLETE_TOOLCHAIN_TESTS=1, because CI has none of it; run it on a host the bootstrap set up:
//   PARACLETE_TOOLCHAIN_TESTS=1 node --test tests/agent/files/toolchain-smoke.test.mjs
// It walks the path a person's request takes: Markdown made into Word, PDF and PowerPoint; the PDF
// read, rendered, split and rebuilt as Word; a table made into a workbook and read back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertFile, mergePdfs } from '../../../agent/files/converters.mjs';
import { detectFormat } from '../../../agent/files/formats.mjs';
import { makeFile } from '../../../agent/files/makers.mjs';
import { readDocument } from '../../../agent/files/readers.mjs';
import { createRunner } from '../../../agent/files/runner.mjs';
import { scratch } from './helpers.mjs';

const enabled = process.env.PARACLETE_TOOLCHAIN_TESTS === '1';
const dir = scratch('toolchain-smoke-');
after(() => dir.cleanup());
const runner = createRunner({ timeoutSeconds: 180 });
const opts = { skip: enabled ? false : 'set PARACLETE_TOOLCHAIN_TESTS=1 on a host with the file toolchain' };

const MARKDOWN = '# Quarterly Review\n\nRevenue grew in every region.\n\n| Region | Sales |\n|---|---|\n| North | 120 |\n| South | 95 |\n\n# Next Steps\n\n- Hire two people\n- Open the new office\n';

test('Markdown becomes Word, PDF and PowerPoint, and each reads back', opts, async () => {
  const src = dir.file('review.md', MARKDOWN);
  for (const format of ['docx', 'pdf', 'pptx', 'html']) {
    const made = await makeFile({ format, from: 'md', sourcePath: src, out: join(dir.root, `review.${format}`), runner });
    assert.ok(existsSync(made.path), format);
    assert.equal((await detectFormat(made.path, { runner })).format, format);
  }
  assert.match((await readDocument(join(dir.root, 'review.docx'), { runner })).text, /Quarterly Review[\s\S]*\| North \| 120 \|/);
  assert.match((await readDocument(join(dir.root, 'review.pdf'), { runner })).text, /Revenue grew in every region/);
  const deck = await readDocument(join(dir.root, 'review.pptx'), { runner });
  assert.match(deck.text, /Slide 1: Quarterly Review/);
});

test('a PDF renders to PNG, splits, merges and is rebuilt as Word; Word renders to PDF', opts, async () => {
  const pdf = join(dir.root, 'review.pdf');
  const pngs = await convertFile(pdf, 'png', { runner, out: join(dir.root, 'pages') });
  assert.ok(pngs.outputs.length >= 1 && pngs.outputs.every((p) => readFileSync(p).subarray(1, 4).toString() === 'PNG'));
  const first = await convertFile(pdf, 'pdf', { runner, pages: '1', out: join(dir.root, 'first.pdf') });
  const merged = await mergePdfs([pdf, first.outputs[0]], { runner, out: join(dir.root, 'merged.pdf') });
  assert.ok(existsSync(merged.outputs[0]));
  const rebuilt = await convertFile(pdf, 'docx', { runner, out: join(dir.root, 'rebuilt.docx') });
  assert.match((await readDocument(rebuilt.outputs[0], { runner })).text, /Revenue grew/);
  const rendered = await convertFile(join(dir.root, 'review.docx'), 'pdf', { runner, out: join(dir.root, 'from-word.pdf') });
  assert.match((await readDocument(rendered.outputs[0], { runner })).text, /Quarterly Review/);
});

test('a table becomes a workbook, reads back, and converts to CSV; an image shrinks', opts, async () => {
  const xlsx = await makeFile({ format: 'xlsx', from: 'csv', source: 'Region,Sales\nNorth,120\nSouth,95\n', out: join(dir.root, 'sales.xlsx'), runner });
  const read = await readDocument(xlsx.path, { runner });
  assert.match(read.text, /\| Region \| Sales \|\n\| --- \| --- \|\n\| North \| 120 \|/);
  const csv = await convertFile(xlsx.path, 'csv', { runner });
  assert.equal(readFileSync(csv.outputs[0], 'utf8'), 'Region,Sales\nNorth,120\nSouth,95\n');
  const png = join(dir.root, 'pages', 'review-1.png');
  const jpg = await convertFile(png, 'jpg', { runner, maxSide: 300 });
  assert.equal((await detectFormat(jpg.outputs[0])).format, 'jpg');
});
