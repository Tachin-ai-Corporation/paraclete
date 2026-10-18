// tests/agent/files/helpers.mjs: what the agent/files and skills/files tests share. A ZIP writer, for
// building .docx, .xlsx, .pptx and OpenDocument fixtures in memory; a fake toolchain, whose programs
// answer from handlers and record their arguments, so no test needs pandoc, LibreOffice or Chromium;
// a scratch directory; and a stand-in for stdout. Not a test itself.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { createRunner } from '../../../agent/files/runner.mjs';

/**
 * A ZIP archive's bytes from { name: content } entries, deflated (or stored with { store: true }).
 *
 * @param {Record<string, string|Buffer>} entries
 * @param {{store?: boolean}} [opts]
 * @returns {Buffer}
 */
export function zipBytes(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A minimal .docx, .xlsx or .pptx container: what format detection looks for. */
export function officeBytes(kind) {
  const dir = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[kind];
  return zipBytes({ '[Content_Types].xml': '<Types/>', [dir]: '<x/>' });
}

/** A minimal OpenDocument container. */
export function openDocumentBytes(kind) {
  const type = { odt: 'text', ods: 'spreadsheet', odp: 'presentation' }[kind];
  return zipBytes({ mimetype: `application/vnd.oasis.opendocument.${type}`, 'content.xml': '<x/>' }, { store: true });
}

/** A 1x1 PNG of a given size in its header. */
export function pngBytes(width = 2, height = 3) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

/** A scratch directory, removed by cleanup(). */
export function scratch(prefix = 'files-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    file(rel, content = '') {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
    dir(rel) {
      const path = join(root, rel);
      mkdirSync(path, { recursive: true });
      return path;
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

/**
 * A fake toolchain: `handlers[program](args, opts)` answers each call with { code, stdout, stderr }
 * (strings or Buffers; anything left out is success with no output), may write files, and may throw
 * to be "not installed". A program without a handler succeeds silently. Every call is recorded.
 *
 * @param {Record<string, Function>} [handlers]
 * @returns {Function & {calls: Array<{program: string, args: string[], opts: object}>}}
 */
export function fakeExec(handlers = {}) {
  const calls = [];
  const exec = async (program, args, opts) => {
    calls.push({ program, args, opts });
    const handler = handlers[program];
    const answer = handler ? await handler(args, opts) : {};
    if (answer === 'missing') {
      return { code: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(`${program}: not found`), timedOut: false, missing: true, overflow: false };
    }
    if (answer === 'timeout') return { code: 137, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: true, missing: false, overflow: false };
    const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? '')));
    return { code: answer?.code ?? 0, stdout: toBuf(answer?.stdout), stderr: toBuf(answer?.stderr), timedOut: false, missing: false, overflow: false };
  };
  exec.calls = calls;
  return exec;
}

/** A runner over a fake toolchain. `runner.calls` lists the programs it ran. */
export function fakeRunner(handlers = {}, opts = {}) {
  const exec = fakeExec(handlers);
  const runner = createRunner({ exec, timeoutSeconds: 30, ...opts });
  runner.calls = exec.calls;
  return runner;
}

/** The value after a flag in an argument list. */
export function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The value of a --flag=value argument. */
export function argValue(args, prefix) {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** A stand-in for stdout or stderr that keeps what was written. */
export function sink() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

/** Runs a command module's main with captured output. */
export async function runCommand(mod, argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await mod.main(argv, { stdout, stderr, ...deps });
  return { code, out: stdout.text(), err: stderr.text() };
}
