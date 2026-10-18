// Tests for skills/files/file-convert.mjs: arguments, the printed record of what was written, the
// conversion list, merges, and refusals. The toolchain is fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as fileConvert from '../../../skills/files/file-convert.mjs';
import { fakeRunner, officeBytes, PDF_BYTES, pngBytes, runCommand, scratch } from '../../agent/files/helpers.mjs';

const dir = scratch('file-convert-test-');
after(() => dir.cleanup());

const runner = () => fakeRunner({
  soffice: (args) => {
    const outDir = args[args.indexOf('--outdir') + 1];
    writeFileSync(join(outDir, `${basename(args.at(-1)).replace(/\.[^.]+$/, '')}.${args[args.indexOf('--convert-to') + 1]}`), PDF_BYTES);
  },
  pdfinfo: () => ({ stdout: 'Pages: 2\n' }),
  pdftoppm: (args) => { writeFileSync(`${args.at(-1)}-1.png`, pngBytes()); writeFileSync(`${args.at(-1)}-2.png`, pngBytes()); },
  qpdf: (args) => { writeFileSync(args.at(-1), PDF_BYTES); },
}, { tmpRoot: dir.dir('tmp') });

test('--help and --list; bad arguments exit 2', async () => {
  assert.match((await runCommand(fileConvert, ['--help'])).out, /^Usage: file-convert <path> <format>/);
  assert.match((await runCommand(fileConvert, ['--list'])).out, /^Every conversion \(from -> to\):\ndocx -> pdf, html, md, txt, png/);
  for (const argv of [['only.docx'], ['a', 'pdf', '--max-side', '9000'], ['a', 'png', '--size', 'big'], ['--merge', 'a.pdf'], ['--merge', 'a.pdf', 'b.pdf', '--pages', '1']]) {
    const { code, err } = await runCommand(fileConvert, argv, { runner: runner() });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, /^file-convert: /);
  }
  assert.deepEqual(fileConvert.parseArgs(['a.html', 'png', '--size', '1600x900', '--max-side', '800']).size, { width: 1600, height: 900 });
  assert.deepEqual(fileConvert.parseArgs(['--merge', 'a.pdf', 'b.pdf', 'c.pdf', '--out', 'all.pdf']), { merge: ['a.pdf', 'b.pdf', 'c.pdf'], out: 'all.pdf' });
});

test('prints the outputs with their types and sizes, and the notes', async () => {
  const src = dir.file('memo.docx', officeBytes('docx'));
  const { code, out } = await runCommand(fileConvert, ['memo.docx', 'pdf'], { runner: runner(), cwd: dir.root });
  assert.equal(code, 0);
  const record = JSON.parse(out);
  assert.deepEqual([record.from, record.to], ['docx', 'pdf']);
  assert.deepEqual(record.outputs, [{ path: join(dir.root, 'memo.pdf'), name: 'memo.pdf', type: 'pdf', size: PDF_BYTES.length }]);
  assert.match(record.notes[0], /LibreOffice/);

  const pages = JSON.parse((await runCommand(fileConvert, [src, 'png', '--out', join(dir.root, 'pages')], { runner: runner() })).out);
  assert.deepEqual(pages.outputs.map((o) => [o.name, o.type]), [['memo-1.png', 'png'], ['memo-2.png', 'png']]);
});

test('merges PDFs; a refused conversion exits 2 with what is possible; a failed program exits 1', async () => {
  const a = dir.file('a.pdf', PDF_BYTES);
  const b = dir.file('b.pdf', PDF_BYTES);
  const merged = await runCommand(fileConvert, ['--merge', a, b, '--out', join(dir.root, 'both.pdf')], { runner: runner() });
  assert.equal(merged.code, 0);
  assert.equal(JSON.parse(merged.out).outputs[0].name, 'both.pdf');

  const refused = await runCommand(fileConvert, [a, 'pptx'], { runner: runner() });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /cannot convert PDF \(a\.pdf\) to pptx\. PDF converts to: pdf, md, txt, docx, png\./);

  const failed = await runCommand(fileConvert, [dir.file('x.docx', officeBytes('docx')), 'pdf'], { runner: fakeRunner({ soffice: () => 'timeout' }, { tmpRoot: dir.dir('tmp') }) });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /soffice did not finish within 30 seconds/);
});
