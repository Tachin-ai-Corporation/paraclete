// Tests for skills/files/file-read.mjs: arguments, the printed shape (what the file is, its text, what
// was cut), and exit codes. The toolchain is fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fileRead from '../../../skills/files/file-read.mjs';
import { fakeRunner, PDF_BYTES, runCommand, scratch } from '../../agent/files/helpers.mjs';

const dir = scratch('file-read-test-');
after(() => dir.cleanup());

const pdfRunner = () => fakeRunner({
  pdfinfo: () => ({ stdout: 'Pages: 4\n' }),
  pdftotext: (args) => ({ stdout: `page ${args[args.indexOf('-f') + 1]} text\f` }),
});

test('--help prints the usage; bad arguments exit 2 with it', async () => {
  assert.match((await runCommand(fileRead, ['--help'])).out, /^Usage: file-read <path>/);
  for (const argv of [[], ['a', 'b'], ['a', '--format', 'html'], ['a', '--max', '0'], ['a', '--colour']]) {
    const { code, err } = await runCommand(fileRead, argv, { runner: fakeRunner() });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, /^file-read: .*\nUsage: file-read/s);
  }
  assert.deepEqual(fileRead.parseArgs(['x.pdf', '--pages', '1-2', '--max', '500', '--format', 'text']), {
    path: 'x.pdf', pages: '1-2', sheet: undefined, slides: undefined, format: 'text', max: 500,
  });
});

test('prints what the file is, then its text, then what was cut or left out', async () => {
  const pdf = dir.file('board.pdf', PDF_BYTES);
  const { code, out } = await runCommand(fileRead, [pdf, '--pages', '2-3', '--max', '30'], { runner: pdfRunner() });
  assert.equal(code, 0);
  const lines = out.split('\n');
  assert.equal(lines[0], '[board.pdf: PDF, 4 pages; pages 2-3]');
  assert.match(out, /<!-- page 2 -->\npage 2 text/);
  assert.match(out, /\n\[Cut at 30 of \d+ characters: read the rest with --pages or with a larger --max\.\]\n/);
  assert.match(out, /\[Text from the PDF's text layer/);

  const md = await runCommand(fileRead, [dir.file('notes.md', '# Notes\n\nSome text.\n')], { runner: fakeRunner() });
  assert.equal(md.out, '[notes.md: Markdown]\n\n# Notes\n\nSome text.\n');
});

test('a selection the file cannot have exits 2; an unreadable or missing file exits 1', async () => {
  const pdf = dir.file('short.pdf', PDF_BYTES);
  const outOfRange = await runCommand(fileRead, [pdf, '--pages', '9'], { runner: pdfRunner() });
  assert.deepEqual([outOfRange.code, outOfRange.err], [2, 'file-read: page 9 does not exist: there are 4 pages\n']);
  const wrongFlag = await runCommand(fileRead, [dir.file('a.md', 'x'), '--sheet', '1'], { runner: fakeRunner() });
  assert.equal(wrongFlag.code, 2);
  const missing = await runCommand(fileRead, [`${dir.root}/absent.pdf`], { runner: fakeRunner() });
  assert.deepEqual([missing.code, missing.err.trim()], [1, `file-read: ${dir.root}/absent.pdf does not exist`]);
  const noTool = await runCommand(fileRead, [pdf], { runner: fakeRunner({ pdfinfo: () => 'missing' }) });
  assert.equal(noTool.code, 1);
  assert.match(noTool.err, /pdfinfo is not installed on this host/);
});
