// Tests for agent/gateway/tools.mjs: bounded and honest results, the shell's stdin channel, a failed
// command's output, the memory boundary, and writable roots.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capResult, sniffBinary, splitCommandLine, checkMemoryCommand, memoryFileTarget, isWithinRoots,
  createToolRegistry, DEFAULT_TOOL_LIMITS, OPEN_TOOLSET, CEREBELLUM_TOOLSET, MEMORY_TOOLSET,
} from '../../../agent/gateway/tools.mjs';
import { quiet } from './fakes.mjs';

const BUDGET = DEFAULT_TOOL_LIMITS.outputChars;
const BIN = '/opt/paraclete/bin';
const MEMORY_POLICY = {
  binDir: BIN,
  clis: ['core-memory-read', 'core-memory-write', 'core-memory-retire', 'update-deep-truths', 'session-summary'],
  readViews: { 'process-ops': ['list', 'get'], 'project-manage': ['list', 'get', 'canon-list'] },
};
const MEMORY_FILES = ['MEMORY.md', 'consolidation_report.md'];

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'gateway-tools-')); });
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

function registry(extra = {}) {
  return createToolRegistry({ workspaceDir: dir, env: process.env, logger: quiet, ...extra });
}

describe('capResult: bounded, and honest about it', () => {
  it('passes short output through byte-identical, and output exactly at the budget untouched', () => {
    const s = 'folder ID: 1EXAMPLE0000000000000000000000009';
    assert.equal(capResult(s), s);
    assert.equal(capResult('x'.repeat(BUDGET)).length, BUDGET);
  });

  it('truncates over-budget output and keeps both head and tail', () => {
    const body = `HEAD-MARKER${'a'.repeat(BUDGET * 12)}TAIL-MARKER`;
    const out = capResult(body, 'command output');
    assert.ok(out.length < body.length);
    assert.ok(out.startsWith('HEAD-MARKER'), 'head window kept');
    assert.ok(out.endsWith('TAIL-MARKER'), 'tail window kept: the final status line survives');
  });

  it('announces the cut, with the narrowing hint the caller gives', () => {
    const n = BUDGET * 12;
    const out = capResult('z'.repeat(n), 'command output');
    assert.match(out, new RegExp(`truncated: [0-9]+ of ${n} chars omitted`));
    assert.match(out, /You have NOT seen the whole result/);
    assert.match(capResult('z'.repeat(BUDGET * 2), 'file', 'Read a smaller range.'), /Read a smaller range\./);
  });

  it('takes its budget from the limits passed in', () => {
    const out = capResult('y'.repeat(100), 'output', 'narrow it', { outputChars: 50, outputHeadChars: 20, outputTailChars: 10 });
    assert.match(out, /truncated: 70 of 100 chars omitted \(budget 50\)/);
  });

  it('coerces non-strings instead of throwing', () => {
    assert.equal(capResult(null), '');
    assert.equal(capResult(42), '42');
  });
});

describe('sniffBinary: refuse bytes, name the route', () => {
  const cases = [
    ['PDF', Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3', 'latin1'), /PDF/],
    ['OOXML/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), /OOXML|ZIP/],
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), /PNG/],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), /JPEG/],
  ];
  for (const [name, buf, kind] of cases) {
    it(`flags ${name} and points at the files skill`, () => {
      const hit = sniffBinary(buf);
      assert.match(hit.kind, kind);
      assert.match(hit.route, /files skill/);
    });
  }

  it('flags gzip and says to decompress it', () => {
    assert.match(sniffBinary(Buffer.from([0x1f, 0x8b, 0x08, 0x00])).route, /gunzip/);
  });

  it('flags stray NUL bytes without a known magic number', () => {
    assert.match(sniffBinary(Buffer.from('plausible text\x00then a NUL', 'latin1')).kind, /binary/);
  });

  it('passes real text through: markdown, JSON, tabs, CRLF, accents', () => {
    for (const text of [
      '# Heading\n\nA paragraph with *emphasis*.\n',
      '{"status":"downloaded","mimeType":"application/pdf"}',
      'col_a\tcol_b\r\n1\t2\r\n',
      'accented text: café, naïve, Köln, an em-dash — and “smart quotes”',
    ]) {
      assert.equal(sniffBinary(Buffer.from(text, 'utf8')), null, text.slice(0, 30));
    }
    assert.equal(sniffBinary(Buffer.alloc(0)), null, 'an empty file is text');
  });
});

describe('runCommand', () => {
  let echo;
  let print;
  let refuse;
  before(() => {
    echo = join(dir, 'echo-stdin.cjs');
    print = join(dir, 'print.cjs');
    refuse = join(dir, 'refuse.cjs');
    writeFileSync(echo, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d));");
    writeFileSync(print, "process.stdout.write('NOSTDIN_OK');");
    writeFileSync(refuse, "process.stdout.write('checked 3 projects\\n');process.stderr.write('refused: --stdin is required for free text\\n');process.exit(3);");
  });

  // Free text with apostrophes, quotes or $ reaches a command through stdin, never parsed by a shell.
  it('passes apostrophes, double quotes and $-references through stdin untouched', async () => {
    const original = `Implements the website's "technical" features & $HOME`;
    const r = await registry().tools.runCommand.execute({ command: `node "${echo}"`, stdin: JSON.stringify({ responsibilities: original }) });
    assert.equal(r.error, undefined, `unexpected error: ${r.error}`);
    const parsed = JSON.parse(r.result.slice(r.result.indexOf('{')));
    assert.equal(parsed.responsibilities, original, 'free text round-tripped byte for byte');
  });

  it('runs a command that takes no stdin', async () => {
    const r = await registry().tools.runCommand.execute({ command: `node "${print}"` });
    assert.equal(r.error, undefined, `unexpected error: ${r.error}`);
    assert.match(r.result, /NOSTDIN_OK/);
  });

  it('closes stdin when none is given, so a command that reads it does not hang', async () => {
    const r = await registry({ limits: { timeoutMs: 10_000 } }).tools.runCommand.execute({ command: `node "${echo}"` });
    assert.equal(r.result, '(no output)');
  });

  it('keeps a failed command\'s exit code, stdout and stderr', async () => {
    const r = await registry().tools.runCommand.execute({ command: `node "${refuse}"` });
    assert.equal(r.result, undefined);
    assert.match(r.error, /^ERROR: command exited with code 3: node /);
    assert.match(r.error, /STDOUT:\nchecked 3 projects/);
    assert.match(r.error, /STDERR:\nrefused: --stdin is required for free text/);
  });

  it('bounds a failed command\'s output, keeping the end of stderr', async () => {
    const noisy = join(dir, 'noisy.cjs');
    writeFileSync(noisy, "process.stdout.write('o'.repeat(200));process.stderr.write('e'.repeat(200)+'FINAL REASON');process.exit(1);");
    const r = await registry({ limits: { outputChars: 120, outputHeadChars: 60, outputTailChars: 40 } })
      .tools.runCommand.execute({ command: `node "${noisy}"` });
    assert.match(r.error, /^ERROR: command exited with code 1/);
    assert.match(r.error, /error output truncated/);
    assert.match(r.error, /FINAL REASON$/);
  });

  it('reports a timeout as unknown, not as failed', async (t) => {
    const slow = join(dir, 'slow.cjs');
    const pidFile = join(dir, 'slow.pid');
    writeFileSync(slow, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setTimeout(()=>{},10000);`);
    // Killing the shell on timeout can leave its child running (cmd.exe on Windows); stop it here so
    // the temporary directory can be removed.
    t.after(() => { try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ } });
    const r = await registry({ limits: { timeoutMs: 1500 } }).tools.runCommand.execute({ command: `node "${slow}"` });
    assert.match(r.error, /^ERROR: command timed out after \d+s \(limit 2s\)/);
    assert.match(r.error, /treat this as "unknown", not "failed"/);
  });

  it('hands the access token to the child in the variable it is told, and only then', async () => {
    const show = join(dir, 'show-token.cjs');
    writeFileSync(show, "process.stdout.write(String(process.env.TEST_TOKEN_VAR));");
    const asked = [];
    const getAccessToken = async () => { asked.push(1); return 'tok-123'; };
    const withToken = await registry({ tokenEnvVar: 'TEST_TOKEN_VAR', getAccessToken }).tools.runCommand.execute({ command: `node "${show}"` });
    assert.equal(withToken.result, 'tok-123');
    const without = await registry({ getAccessToken }).tools.runCommand.execute({ command: `node "${show}"` });
    assert.equal(without.result, 'undefined');
    assert.equal(asked.length, 1, 'no token is fetched when no variable is named');
  });
});

describe('readFile, writeFile and listDir', () => {
  it('reads text, a line range, and refuses binary with a route', async () => {
    const { tools } = registry();
    writeFileSync(join(dir, 'notes.txt'), 'one\ntwo\nthree\n');
    assert.equal((await tools.readFile.execute({ path: 'notes.txt' })).result, 'one\ntwo\nthree\n');
    assert.equal((await tools.readFile.execute({ path: 'notes.txt', startLine: 2, endLine: 3 })).result, 'two\nthree');
    writeFileSync(join(dir, 'doc.pdf'), Buffer.from('%PDF-1.7 binary'));
    const pdf = await tools.readFile.execute({ path: 'doc.pdf' });
    assert.match(pdf.error, /is PDF, not text/);
    assert.match(pdf.error, /files skill/);
  });

  it('lists the skills that exist when a skill path is wrong', async () => {
    const skills = join(dir, 'skills');
    mkdirSync(join(skills, 'files'), { recursive: true });
    writeFileSync(join(skills, 'files', 'SKILL.md'), '# files');
    const r = await registry({ skillDirs: [skills] }).tools.readFile.execute({ path: join(skills, 'nope', 'SKILL.md') });
    assert.match(r.error, /Skill not found/);
    assert.ok(r.error.includes(join(skills, 'files', 'SKILL.md')));
  });

  it('writes inside the writable roots and refuses anywhere else', async () => {
    const work = join(dir, 'work');
    mkdirSync(work, { recursive: true });
    const { tools } = registry({ writableRoots: [work] });
    assert.match((await tools.writeFile.execute({ path: join(work, 'out.md'), content: 'hi' })).result, /Written 2 bytes/);
    assert.equal(readFileSync(join(work, 'out.md'), 'utf8'), 'hi');
    for (const bad of [join(dir, 'outside.md'), join(work, '..', 'escape.md'), 'relative-to-workspace.md']) {
      const r = await tools.writeFile.execute({ path: bad, content: 'x' });
      assert.match(r.error, /^REFUSED: .* is outside the writable directories/, bad);
    }
    assert.equal(existsSync(join(dir, 'outside.md')), false);
  });

  it('writes relative paths into the workspace by default', async () => {
    const r = await registry().tools.writeFile.execute({ path: 'draft.md', content: 'x' });
    assert.equal(r.error, undefined);
    assert.ok(existsSync(join(dir, 'draft.md')));
  });

  it('lists a directory', async () => {
    const r = await registry().tools.listDir.execute({ path: '.' });
    assert.match(r.result, /- notes\.txt \(14b\)/);
  });

  it('isWithinRoots resolves .. before it decides', () => {
    assert.equal(isWithinRoots(join(dir, 'a', 'b'), [dir]), true);
    assert.equal(isWithinRoots(dir, [dir]), true);
    assert.equal(isWithinRoots(join(dir, 'a', '..', '..', 'x'), [dir]), false);
    assert.equal(isWithinRoots(`${dir}-sibling`, [dir]), false, 'a sibling with the same prefix is outside');
  });
});

describe('toolsets', () => {
  it('select() returns the named tools, nothing for an empty list, and fails on an unknown name', () => {
    const reg = registry({ binDir: BIN, memory: { home: dir, files: MEMORY_FILES, ...MEMORY_POLICY } });
    assert.deepEqual(Object.keys(reg.select(OPEN_TOOLSET)), [...OPEN_TOOLSET]);
    assert.deepEqual(Object.keys(reg.select(CEREBELLUM_TOOLSET)), [...CEREBELLUM_TOOLSET]);
    assert.deepEqual(Object.keys(reg.select(MEMORY_TOOLSET)), [...MEMORY_TOOLSET]);
    assert.equal(reg.select([]), undefined);
    assert.throws(() => reg.select(['readFile', 'teleport']), /tools not registered: teleport/);
  });

  it('the open toolset holds no verdict tools and no memory tools', () => {
    for (const name of ['report_pass', 'report_fail', 'request_probe', 'memoryCommand', 'writeMemoryFile']) {
      assert.equal(OPEN_TOOLSET.includes(name), false, name);
    }
  });

  it('the memory toolset holds no shell and no general writer', () => {
    assert.deepEqual([...MEMORY_TOOLSET], ['readFile', 'listDir', 'memoryCommand', 'writeMemoryFile']);
  });

  it('without a memory configuration the memory tools are not registered', () => {
    assert.throws(() => registry().select(MEMORY_TOOLSET), /memoryCommand, writeMemoryFile/);
  });

  it('the verdict tools return the verdict as their payload', async () => {
    const { tools } = registry();
    assert.deepEqual(await tools.report_pass.execute({ reasoning: 'met', checks: [], caveat: 'one gap' }),
      { verdict: 'PASS', reasoning: 'met', checks: [], caveat: 'one gap' });
    assert.deepEqual(await tools.report_fail.execute({ reasoning: 'r', checks: [], recommendation: 'fix' }),
      { verdict: 'FAIL', reasoning: 'r', checks: [], recommendation: 'fix' });
    assert.equal(tools.request_probe, undefined, 'no probe tool: nothing would service it');
  });
});

describe('splitCommandLine: argv without a shell', () => {
  it('groups quotes and expands nothing', () => {
    assert.deepEqual(
      splitCommandLine(`core-memory-write --fact 'drive_folder: "weekly_notes_root" = 1AbC' --category resources`),
      ['core-memory-write', '--fact', 'drive_folder: "weekly_notes_root" = 1AbC', '--category', 'resources']);
    assert.deepEqual(splitCommandLine('core-memory-retire --id mem-1 --reason "dup of \\"a\\""'),
      ['core-memory-retire', '--id', 'mem-1', '--reason', 'dup of "a"']);
    assert.deepEqual(splitCommandLine('core-memory-write --fact "a; b | c $(x)"'),
      ['core-memory-write', '--fact', 'a; b | c $(x)'], 'operators inside quotes are literal text');
  });

  it('refuses an unquoted shell operator: that is an attempt to run something else', () => {
    for (const bad of [
      'core-memory-read; rm -rf /', 'core-memory-read && project-manage update p', 'core-memory-read | tee x',
      'core-memory-read > /tmp/x', 'core-memory-read $(whoami)', 'core-memory-read `id`', 'core-memory-read & sleep 9',
    ]) {
      assert.throws(() => splitCommandLine(bad), /shell operator/, bad);
    }
    assert.throws(() => splitCommandLine('core-memory-read --query "open'), /unterminated/);
  });
});

describe('checkMemoryCommand: what the memory organ may run', () => {
  it('allows every memory command, by name or by its installed path', () => {
    for (const c of MEMORY_POLICY.clis) {
      assert.deepEqual(checkMemoryCommand([c, '--limit', '5'], MEMORY_POLICY), { ok: true, name: c, path: `${BIN}/${c}` });
    }
    assert.equal(checkMemoryCommand([`${BIN}/core-memory-read`], MEMORY_POLICY).ok, true);
  });

  it('allows the read-only definition views, and refuses every write of a definition', () => {
    for (const [cli, reads] of Object.entries(MEMORY_POLICY.readViews)) {
      for (const sub of reads) assert.equal(checkMemoryCommand([cli, sub, 'x'], MEMORY_POLICY).ok, true, `${cli} ${sub}`);
    }
    for (const [cli, sub] of [
      ['process-ops', 'write'], ['process-ops', 'retire'], ['process-ops', undefined],
      ['project-manage', 'add-context'], ['project-manage', 'update'], ['project-manage', 'create'],
      ['project-manage', 'canon-set'], ['project-manage', 'add-process'],
    ]) {
      const r = checkMemoryCommand([cli, sub].filter(Boolean), MEMORY_POLICY);
      assert.equal(r.ok, false, `${cli} ${sub}`);
      assert.match(r.reason, /read-only view|never written/, `${cli} ${sub}`);
    }
  });

  it('refuses everything else: memory reaches nothing but memory', () => {
    for (const cmd of ['rm', 'bash', 'curl', 'python3', 'docs-create', 'drive-delete', 'responsibility-manage', 'git', 'constructor', '__proto__']) {
      const r = checkMemoryCommand([cmd, 'x'], MEMORY_POLICY);
      assert.equal(r.ok, false, cmd);
      assert.match(r.reason, /not a memory command/, cmd);
    }
    assert.equal(checkMemoryCommand(['/tmp/core-memory-read'], MEMORY_POLICY).ok, false, 'a look-alike path is not the installed command');
    assert.equal(checkMemoryCommand(['../bin/core-memory-read'], MEMORY_POLICY).ok, false);
    assert.equal(checkMemoryCommand([], MEMORY_POLICY).ok, false);
  });
});

describe('memoryCommand', () => {
  it('refuses a shell operator and a non-memory command before running anything', async () => {
    const { tools } = registry({ binDir: BIN, memory: { home: dir, files: MEMORY_FILES, ...MEMORY_POLICY } });
    assert.match((await tools.memoryCommand.execute({ command: 'core-memory-read; rm -rf /' })).error, /^REFUSED \(memory boundary\): shell operator/);
    assert.match((await tools.memoryCommand.execute({ command: 'project-manage update p' })).error, /^REFUSED \(memory boundary\): .*not a read-only view/);
    assert.match(tools.memoryCommand.description, /core-memory-read, core-memory-write/);
  });

  it('runs an installed memory command without a shell, stdin included', { skip: process.platform === 'win32' && 'runs a POSIX script' }, async () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const cli = join(bin, 'core-memory-read');
    writeFileSync(cli, '#!/bin/sh\necho "args: $*"\ncat\n');
    chmodSync(cli, 0o755);
    const { tools } = registry({ binDir: bin, memory: { home: dir, files: MEMORY_FILES, clis: ['core-memory-read'] } });
    const r = await tools.memoryCommand.execute({ command: 'core-memory-read --query "a b"', stdin: 'from stdin' });
    assert.equal(r.result, 'args: --query a b\nfrom stdin');
  });
});

describe('writeMemoryFile writes only the memory files', () => {
  it('resolves exactly the memory files in the memory home', () => {
    const home = join(tmpdir(), 'mem-home-probe');
    const where = { home, files: MEMORY_FILES };
    for (const f of MEMORY_FILES) assert.ok(memoryFileTarget(f, where), f);
    assert.ok(memoryFileTarget(join(home, 'MEMORY.md'), where), 'absolute form');
    for (const bad of ['IDENTITY.md', 'sub/MEMORY.md', '../workspace-motor/MEMORY.md', '/etc/passwd',
      join(home, '..', 'MEMORY.md'), 'processes.json', '']) {
      assert.equal(memoryFileTarget(bad, where), null, bad || '(empty)');
    }
  });

  it('writes working memory, refuses any other file, and bounds a runaway rewrite', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mem-home-'));
    try {
      const { tools } = registry({ binDir: BIN, memory: { home, files: MEMORY_FILES, ...MEMORY_POLICY } });
      const ok = await tools.writeMemoryFile.execute({ path: 'MEMORY.md', content: '# MEMORY\n- one active item\n' });
      assert.match(ok.result, /Written \d+ chars to MEMORY\.md/);
      assert.equal(readFileSync(join(home, 'MEMORY.md'), 'utf8'), '# MEMORY\n- one active item\n');
      const refused = await tools.writeMemoryFile.execute({ path: 'IDENTITY.md', content: 'x' });
      assert.match(refused.error, /REFUSED \(memory boundary\)/);
      assert.equal(existsSync(join(home, 'IDENTITY.md')), false);
      assert.match((await tools.writeMemoryFile.execute({ path: 'MEMORY.md', content: 'y'.repeat(9_000) })).error, /hard cap/);
      assert.match((await tools.writeMemoryFile.execute({ path: 'MEMORY.md', content: 'z'.repeat(2_500) })).result, /over the 2000-char target/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
