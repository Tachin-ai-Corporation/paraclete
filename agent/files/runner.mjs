// agent/files/runner.mjs: runs the VM's file toolchain (pandoc, LibreOffice, headless Chromium,
// poppler, qpdf, ImageMagick, python3, file, git) for this package. Every program gets an argument
// array, never a shell, a time limit (files.tool_timeout_seconds) and an output cap. LibreOffice and
// Chromium get a private profile directory per run, so two conversions never share or lock one, and
// the directory is removed afterwards. A failure becomes a ToolError that says, in words the agent can
// act on, what went wrong: not installed, out of time, or the program's own error. Which program a
// job needs is decided by the readers, converters, makers and fetchers; tests inject `exec`.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_SECONDS = 180; // default; callers pass files.tool_timeout_seconds
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const ERROR_CHARS = 600;

/** The Debian package each program comes from, for the "not installed" message. */
const PROVIDED_BY = {
  pandoc: 'pandoc',
  pdftotext: 'poppler-utils',
  pdfinfo: 'poppler-utils',
  pdftoppm: 'poppler-utils',
  qpdf: 'qpdf',
  soffice: 'LibreOffice',
  chromium: 'chromium',
  convert: 'ImageMagick',
  python3: 'python3',
  file: 'file',
  git: 'git',
};

/** A toolchain program that could not do its job. The message is agent-facing. */
export class ToolError extends Error {
  /**
   * @param {string} message
   * @param {{program?: string, code?: number|null, timedOut?: boolean, missing?: boolean}} [details]
   */
  constructor(message, { program = null, code = null, timedOut = false, missing = false } = {}) {
    super(message);
    this.name = 'ToolError';
    this.program = program;
    this.code = code;
    this.timedOut = timedOut;
    this.missing = missing;
  }
}

/**
 * Runs one program and resolves with what happened; never rejects. The default `exec` of a runner.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, input?: string|Buffer, timeoutMs: number, maxBuffer: number, env?: object}} opts
 * @returns {Promise<{code: number, stdout: Buffer, stderr: Buffer, timedOut: boolean, missing: boolean, overflow: boolean}>}
 */
export function execProgram(file, args, { cwd, input, timeoutMs, maxBuffer, env }) {
  return new Promise((resolve) => {
    const empty = Buffer.alloc(0);
    let child;
    try {
      child = execFile(file, args, {
        cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, encoding: 'buffer', windowsHide: true,
      }, (err, stdout, stderr) => {
        const out = { code: 0, stdout: stdout || empty, stderr: stderr || empty, timedOut: false, missing: false, overflow: false };
        if (!err) return resolve(out);
        if (err.code === 'ENOENT') return resolve({ ...out, code: 127, missing: true });
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ...out, code: 1, overflow: true });
        if (err.killed) return resolve({ ...out, code: 137, timedOut: true });
        const stderrText = out.stderr.length ? out.stderr : Buffer.from(String(err.message || ''));
        return resolve({ ...out, code: typeof err.code === 'number' ? err.code : 1, stderr: stderrText });
      });
    } catch (err) {
      resolve({ code: 127, stdout: empty, stderr: Buffer.from(String(err.message)), timedOut: false, missing: true, overflow: false });
      return;
    }
    // A program that exits without reading its input must not fail the run with EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** The first part of a program's complaint, for an error message. */
function complaint(result) {
  const text = (result.stderr.length ? result.stderr : result.stdout).toString('utf8').trim();
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}...` : text;
}

/**
 * Creates a runner.
 *
 * @param {object}   [options]
 * @param {number}   [options.timeoutSeconds] the longest one program may run (files.tool_timeout_seconds)
 * @param {Function} [options.exec]           (file, args, opts) => Promise<result>, like execProgram
 * @param {string}   [options.tmpRoot]        where scratch and profile directories go
 * @param {object}   [options.env]            the programs' environment
 * @returns {{timeoutSeconds: number, run: Function, check: Function, withTempDir: Function,
 *   soffice: Function, sofficeConvert: Function, chromium: Function}}
 */
export function createRunner({
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  exec = execProgram,
  tmpRoot = tmpdir(),
  env = process.env,
} = {}) {
  const seconds = Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS;

  /**
   * Runs a program; resolves with its result whatever happened.
   *
   * @param {string} program
   * @param {Array<string|number>} args
   * @param {{cwd?: string, input?: string|Buffer, env?: object, timeoutSeconds?: number}} [opts]
   */
  function run(program, args, opts = {}) {
    return exec(program, args.map(String), {
      cwd: opts.cwd,
      input: opts.input,
      timeoutMs: (opts.timeoutSeconds || seconds) * 1000,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...env, ...(opts.env || {}) },
    });
  }

  /**
   * Runs a program and throws a ToolError unless it succeeded.
   *
   * @param {string} program
   * @param {Array<string|number>} args
   * @param {object} [opts] as run()
   */
  async function check(program, args, opts = {}) {
    const result = await run(program, args, opts);
    if (result.missing) {
      throw new ToolError(`${program} is not installed on this host (it comes with ${PROVIDED_BY[program] || program}); the VM bootstrap installs the file toolchain`, { program, code: 127, missing: true });
    }
    if (result.timedOut) {
      throw new ToolError(`${program} did not finish within ${opts.timeoutSeconds || seconds} seconds (files.tool_timeout_seconds): try a smaller file, fewer pages or sheets, or split the work`, { program, timedOut: true });
    }
    if (result.overflow) throw new ToolError(`${program} produced more output than this host keeps (${MAX_OUTPUT_BYTES} bytes)`, { program, code: result.code });
    if (result.code !== 0) {
      const why = complaint(result);
      throw new ToolError(`${program} failed (exit ${result.code})${why ? `: ${why}` : ''}`, { program, code: result.code });
    }
    return result;
  }

  /** Runs fn(dir) with a new scratch directory, and removes the directory afterwards. */
  async function withTempDir(fn) {
    const dir = await mkdtemp(join(tmpRoot, 'paraclete-files-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  /** LibreOffice, headless, with its own profile for this run. */
  function soffice(args, opts = {}) {
    return withTempDir((profile) => check('soffice', [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless', '--norestore', '--nolockcheck', '--nologo', '--nodefault',
      ...args,
    ], opts));
  }

  /**
   * Converts a file with LibreOffice into outDir and returns the new file's path. LibreOffice can
   * exit 0 without converting, so the output's existence is the test.
   *
   * @param {string} input
   * @param {string} target an extension LibreOffice converts to: pdf, docx, xlsx, pptx, csv, html...
   * @param {string} outDir
   * @returns {Promise<string>}
   */
  async function sofficeConvert(input, target, outDir) {
    const result = await soffice(['--convert-to', target, '--outdir', outDir, input]);
    const ext = target.split(':')[0];
    const produced = join(outDir, `${basename(input, extname(input))}.${ext}`);
    if (!existsSync(produced)) {
      const why = complaint(result);
      throw new ToolError(`LibreOffice could not convert ${basename(input)} to ${ext}${why ? `: ${why}` : ''}`, { program: 'soffice', code: result.code });
    }
    return produced;
  }

  /** Headless Chromium with its own profile for this run. */
  function chromium(args, opts = {}) {
    return withTempDir((profile) => check('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', `--user-data-dir=${profile}`,
      ...args,
    ], opts));
  }

  return { timeoutSeconds: seconds, run, check, withTempDir, soffice, sofficeConvert, chromium };
}
