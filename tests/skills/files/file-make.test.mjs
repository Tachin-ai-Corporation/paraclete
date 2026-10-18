// Tests for skills/files/file-make.mjs: arguments, source from a file or stdin, the printed record, and
// refusals. The toolchain is fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fileMake from '../../../skills/files/file-make.mjs';
import { fakeRunner, runCommand, scratch } from '../../agent/files/helpers.mjs';

const dir = scratch('file-make-test-');
after(() => dir.cleanup());

const runner = () => fakeRunner({
  pandoc: (args) => {
    const out = args[args.indexOf('--output') + 1];
    writeFileSync(out, readFileSync(args.at(-1)));
  },
}, { tmpRoot: dir.dir('tmp') });

test('--help and --list; missing pieces exit 2', async () => {
  assert.match((await runCommand(fileMake, ['--help'])).out, /^Usage: file-make <format> --from/);
  assert.match((await runCommand(fileMake, ['--list'])).out, /md -> docx, pdf, html, pptx/);
  const cases = [
    [['docx', '--in', 'a.md', '--out', 'a.docx'], /--from md\|html\|csv\|json is required/],
    [['docx', '--from', 'md', '--out', 'a.docx'], /--in <path> or --stdin/],
    [['docx', '--from', 'md', '--in', 'a.md', '--stdin', '--out', 'a.docx'], /not both/],
    [['docx', '--from', 'md', '--in', 'a.md'], /--out <name> is required/],
    [['--from', 'md', '--in', 'a.md', '--out', 'x'], /give one format to make/],
  ];
  for (const [argv, message] of cases) {
    const { code, err } = await runCommand(fileMake, argv, { runner: runner() });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, message);
  }
});

test('Markdown on stdin becomes a Word document; the record says where', async () => {
  const { code, out } = await runCommand(fileMake, ['docx', '--from', 'md', '--stdin', '--out', 'report', '--title', 'Q3'], {
    runner: runner(), cwd: dir.root, readStdin: () => "# Q3\n\nIt's \"quoted\" and $dollar.\n",
  });
  assert.equal(code, 0);
  const record = JSON.parse(out);
  assert.deepEqual([record.path, record.name, record.type], [join(dir.root, 'report.docx'), 'report.docx', 'docx']);
  assert.equal(readFileSync(record.path, 'utf8'), "# Q3\n\nIt's \"quoted\" and $dollar.\n", 'the source reached pandoc unchanged');

  const empty = await runCommand(fileMake, ['docx', '--from', 'md', '--stdin', '--out', 'x.docx'], { runner: runner(), cwd: dir.root, readStdin: () => '  \n' });
  assert.deepEqual([empty.code, empty.err], [2, "file-make: stdin is empty: pass the source in the runCommand tool's stdin field\n"]);
});

test('a combination that does not exist exits 2; a failed program exits 1', async () => {
  dir.file('t.csv', 'a,b\n1,2\n');
  const refused = await runCommand(fileMake, ['pdf', '--from', 'csv', '--in', 't.csv', '--out', 't.pdf'], { runner: runner(), cwd: dir.root });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /csv does not make pdf\. csv makes: xlsx\./);
  const failed = await runCommand(fileMake, ['xlsx', '--from', 'csv', '--in', 't.csv', '--out', 't.xlsx'], {
    runner: fakeRunner({ python3: () => ({ code: 1, stderr: "ModuleNotFoundError: No module named 'openpyxl'" }) }, { tmpRoot: dir.dir('tmp') }), cwd: dir.root,
  });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /python3 failed \(exit 1\): ModuleNotFoundError/);
});
