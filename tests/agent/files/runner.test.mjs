// Tests for agent/files/runner.mjs: programs run with argument arrays and a time limit; failures say
// what went wrong; LibreOffice and Chromium get a private profile that is removed afterwards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner, execProgram, ToolError } from '../../../agent/files/runner.mjs';
import { argValue, fakeExec, scratch } from './helpers.mjs';

const dir = scratch('runner-test-');
after(() => dir.cleanup());

test('execProgram runs a real program with arguments and input, and never rejects', async () => {
  const ok = await execProgram(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("note")'], {
    input: 'piped $HOME `x`', timeoutMs: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.deepEqual([ok.code, ok.stdout.toString(), ok.stderr.toString()], [0, 'piped $HOME `x`', 'note']);

  const failed = await execProgram(process.execPath, ['-e', 'process.stderr.write("bad input"); process.exit(3)'], { timeoutMs: 10_000, maxBuffer: 1024 });
  assert.deepEqual([failed.code, failed.stderr.toString()], [3, 'bad input']);

  const missing = await execProgram('no-such-program-anywhere', [], { timeoutMs: 1000, maxBuffer: 1024 });
  assert.deepEqual([missing.code, missing.missing], [127, true]);

  const slow = await execProgram(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200, maxBuffer: 1024 });
  assert.equal(slow.timedOut, true);
});

test('check() turns a failure into a ToolError the agent can act on', async () => {
  const runner = createRunner({
    timeoutSeconds: 42,
    exec: fakeExec({ pandoc: () => 'missing', pdftotext: () => 'timeout', qpdf: () => ({ code: 2, stderr: 'qpdf: input.pdf: not a PDF file' }) }),
  });
  await assert.rejects(runner.check('pandoc', ['x']), (err) => err instanceof ToolError && err.missing && /pandoc is not installed on this host \(it comes with pandoc\)/.test(err.message));
  await assert.rejects(runner.check('pdftotext', ['x']), (err) => err.timedOut && /did not finish within 42 seconds \(files.tool_timeout_seconds\)/.test(err.message));
  await assert.rejects(runner.check('qpdf', ['x']), /qpdf failed \(exit 2\): qpdf: input\.pdf: not a PDF file/);
  const ok = await runner.check('file', ['--brief', 3]);
  assert.equal(ok.code, 0);
});

test('run() passes arguments as strings, the time limit and extra environment through', async () => {
  const exec = fakeExec();
  const runner = createRunner({ timeoutSeconds: 5, exec, env: { HOME: '/home/agent' } });
  await runner.run('git', ['clone', 1], { env: { GIT_TERMINAL_PROMPT: '0' } });
  const [call] = exec.calls;
  assert.deepEqual(call.args, ['clone', '1']);
  assert.equal(call.opts.timeoutMs, 5000);
  assert.deepEqual(call.opts.env, { HOME: '/home/agent', GIT_TERMINAL_PROMPT: '0' });
  assert.equal(createRunner({ timeoutSeconds: 0 }).timeoutSeconds, 180, 'a nonsense limit falls back to the default');
});

test('LibreOffice gets a private profile per run, removed afterwards, and a conversion is checked by its output', async () => {
  let profile;
  const exec = fakeExec({
    soffice: (args) => {
      profile = fileURLToPath(argValue(args, '-env:UserInstallation='));
      assert.ok(existsSync(profile), 'the profile exists while LibreOffice runs');
      const outDir = args[args.indexOf('--outdir') + 1];
      if (!args.at(-1).includes('broken')) writeFileSync(join(outDir, 'memo.pdf'), '%PDF-');
      return { stdout: 'convert memo.doc -> memo.pdf' };
    },
  });
  const runner = createRunner({ exec, tmpRoot: dir.root });
  const out = dir.dir('out');
  const produced = await runner.sofficeConvert(dir.file('memo.doc', 'x'), 'pdf', out);
  assert.equal(produced, join(out, 'memo.pdf'));
  assert.equal(existsSync(profile), false, 'the profile is removed');
  const args = exec.calls[0].args;
  for (const flag of ['--headless', '--norestore', '--nolockcheck']) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(-5), ['--convert-to', 'pdf', '--outdir', out, join(dir.root, 'memo.doc')]);

  await assert.rejects(runner.sofficeConvert(dir.file('broken.doc', 'x'), 'pdf', out), /LibreOffice could not convert broken\.doc to pdf/);
});

test('Chromium runs headless without a sandbox, with its own profile', async () => {
  const exec = fakeExec();
  const runner = createRunner({ exec, tmpRoot: dir.root });
  await runner.chromium(['--print-to-pdf=/tmp/x.pdf', 'file:///tmp/page.html']);
  const args = exec.calls[0].args;
  for (const flag of ['--headless=new', '--no-sandbox', '--disable-gpu']) assert.ok(args.includes(flag), flag);
  const profile = argValue(args, '--user-data-dir=');
  assert.ok(profile && !existsSync(profile), 'a profile was given, and removed afterwards');
});
