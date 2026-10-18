// agent/gateway/tools.mjs: the tools an organ can call during a turn, and which organ gets which.
// createToolRegistry() builds them from the paths and limits the caller passes: the workspace, the
// directories the agent may write, the skill directories, the installed command directory, and the
// memory files and commands. It does not decide when a tool runs (turn-loop.mjs) or which organ asks
// (organs.mjs). The gateway service builds one registry at startup.
//
// A tool result is context. Every result passes through capResult(), so no single call can flood an
// organ's window, and a cut is always announced: a silent cut reads as "I saw everything" and
// produces confident wrong answers. viewImage is the one tool whose result also carries an image, as
// `{ result, images }`: the text goes to the tool log, the image only to the model (turn-loop.mjs).

import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve, relative, basename, delimiter } from 'node:path';
import { getAccessToken as metadataAccessToken } from '../auth/metadata-token.mjs';
import { sniffImage, imageDimensions } from './images.mjs';

/** Result and process limits. Defaults; callers pass the contracts values. */
export const DEFAULT_TOOL_LIMITS = Object.freeze({
  outputChars: 24_000,
  outputHeadChars: 16_000,
  outputTailChars: 6_000,
  timeoutMs: 120_000,
  maxBufferBytes: 4 * 1024 * 1024,
  binaryGuard: true,
  // Claude on Vertex AI takes an image of at most 5 MB base64-encoded, and 3,750,000 bytes encode to
  // 5,000,000. Gemini's limit on inline data (7 MB) is looser; the transcript must suit both.
  imageMaxBytes: 3_750_000,
  // The longest side Claude accepts; a larger image is rejected, not scaled.
  imageMaxSide: 8000,
});

/** Working-memory sizes. Defaults; callers pass the contracts values. */
export const DEFAULT_MEMORY_LIMITS = Object.freeze({
  // the budget the consolidation skill prunes working memory to
  targetChars: 2_000,
  // a runaway rewrite must not flood every cortex prompt
  hardCapChars: 8_000,
});

/** The tools of an organ that executes: a shell, files, directories, and eyes for images. */
export const OPEN_TOOLSET = Object.freeze(['runCommand', 'readFile', 'writeFile', 'listDir', 'viewImage']);

/**
 * The verifier reads evidence and reports a verdict; it changes nothing. It views images because a
 * visual deliverable (a chart, a rendered slide, a screenshot) is verified by looking at it, not by
 * trusting the executor's description of it.
 */
export const CEREBELLUM_TOOLSET = Object.freeze(['readFile', 'viewImage', 'report_pass', 'report_fail']);

/**
 * The memory boundary. Memory is a closed set: working memory, Core Memory and the Deep Truths. When
 * the memory organ is tooled to consolidate it holds only these: the memory commands and read-only
 * views of definitions (memoryCommand), its own files (writeMemoryFile), and reads. Never runCommand or
 * writeFile: with a full shell, a consolidation pass once wrote project context. Processes, projects,
 * skills and responsibilities are definitions; memory reads them and never writes them.
 */
export const MEMORY_TOOLSET = Object.freeze(['readFile', 'listDir', 'memoryCommand', 'writeMemoryFile']);

const DEFAULT_NARROWING = 'Narrow the command (grep/head/tail/--limit), or read a line range with readFile startLine/endLine.';

/**
 * Bounds a tool result, keeping a head and a tail window so both the command echo and the final
 * status line survive.
 *
 * @param {*}      text          raw tool output (coerced to a string)
 * @param {string} [what]        noun used in the truncation notice
 * @param {string} [howToNarrow] the concrete next step for the organ
 * @param {object} [limits]      { outputChars, outputHeadChars, outputTailChars }
 * @returns {string} the text, or a bounded version that says it was cut
 */
export function capResult(text, what = 'output', howToNarrow = DEFAULT_NARROWING, limits = DEFAULT_TOOL_LIMITS) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const max = limits.outputChars;
  if (s.length <= max) return s;
  const head = s.slice(0, limits.outputHeadChars);
  const tail = limits.outputTailChars > 0 ? s.slice(-limits.outputTailChars) : '';
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n[… ${what} truncated: ${omitted} of ${s.length} chars omitted (budget ${max}). `
    + `You have NOT seen the whole result. ${howToNarrow} …]\n\n${tail}`;
}

// Magic bytes, most specific first; images are recognized in images.mjs. Each entry names a route
// that does work, so a refusal is a signpost rather than a dead end. `<path>` in a route is replaced
// with the path the organ gave.
const CONVERT = 'Use the files skill to convert it to text, then read the converted file.';
const VIEW = 'Look at it with the viewImage tool, which shows you the image itself, as pixels.';
const CONVERT_THEN_VIEW = 'Convert it to PNG with the files skill (`file-convert <path> png`), then look at the PNG with the viewImage tool.';
const BINARY_TYPES = [
  { kind: 'PDF', magic: Buffer.from('%PDF'), route: CONVERT },
  { kind: 'ZIP/OOXML (docx, xlsx, pptx)', magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), route: CONVERT },
  { kind: 'gzip archive', magic: Buffer.from([0x1f, 0x8b]), route: 'Decompress it first (gunzip), then read the extracted text.' },
];

/**
 * Whether a buffer is not text: an image or a known format by its magic bytes, then a
 * control-character heuristic over the first 4 KB for formats the table doesn't name.
 *
 * @param {Buffer} buf
 * @returns {{kind: string, route: string}|null} null when the content is text
 */
export function sniffBinary(buf) {
  if (!buf || buf.length === 0) return null;
  const image = sniffImage(buf);
  if (image) return { kind: `${image.kind} image`, route: image.viewable ? VIEW : CONVERT_THEN_VIEW };
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  for (const t of BINARY_TYPES) {
    if (head.length >= t.magic.length && head.subarray(0, t.magic.length).equals(t.magic)) {
      return { kind: t.kind, route: t.route };
    }
  }
  let nul = 0;
  let ctrl = 0;
  for (const b of head) {
    if (b === 0) nul++;
    else if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  if (nul > 0 || ctrl / head.length > 0.1) {
    return { kind: 'binary (non-text bytes)', route: `If it is a document: ${CONVERT} If it is an image in another format: ${CONVERT_THEN_VIEW}` };
  }
  return null;
}

/**
 * Splits a command line into argv without a shell. Quotes group; nothing expands. An unquoted shell
 * operator is refused rather than passed through: memoryCommand runs one memory command, and a `;`,
 * pipe, redirect or `$(...)` is an attempt to run something else.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCommandLine(line) {
  const argv = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { argv.push(cur); cur = ''; started = false; }
      continue;
    }
    if (/[;&|<>`$(){}]/.test(c)) {
      throw new Error(`shell operator '${c}' is refused: memoryCommand runs ONE memory command with no shell`);
    }
    cur += c;
    started = true;
  }
  if (quote) throw new Error('unterminated quote');
  if (started) argv.push(cur);
  return argv;
}

/**
 * Whether argv is a command the memory organ may run. Pure.
 *
 * @param {string[]} argv
 * @param {object}   policy
 * @param {string}   policy.binDir    where the commands are installed
 * @param {string[]} policy.clis      the memory commands
 * @param {Record<string, string[]>} policy.readViews definition commands memory may only read with,
 *                                     and the subcommands that read: { 'process-ops': ['list', 'get'] }
 * @returns {{ok: true, name: string, path: string} | {ok: false, reason: string}}
 */
export function checkMemoryCommand(argv, { binDir, clis = [], readViews = {} }) {
  if (!Array.isArray(argv) || !argv[0]) return { ok: false, reason: 'empty command' };
  let name = argv[0];
  if (name.includes('/')) {
    // A path is accepted only when it IS the installed command, never an arbitrary binary.
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (name !== `${binDir}/${base}`) return { ok: false, reason: `'${name}' is not an installed memory command` };
    name = base;
  }
  if (clis.includes(name)) return { ok: true, name, path: `${binDir}/${name}` };
  const views = Object.hasOwn(readViews, name) ? readViews[name] : null;
  if (views) {
    if (views.includes(argv[1])) return { ok: true, name, path: `${binDir}/${name}` };
    const attempted = [name, argv[1]].filter(Boolean).join(' ');
    return {
      ok: false,
      reason: `'${attempted}' is not a read-only view: memory may run only ${name} ${views.join('|')}; definitions are read, never written`,
    };
  }
  const viewList = Object.entries(readViews).map(([k, v]) => `${k} ${v.join('|')}`).join(', ');
  return {
    ok: false,
    reason: `'${name}' is not a memory command. Memory writes only working memory, Core Memory and Deep Truths `
      + `(${clis.join(', ')}); definitions are read-only (${viewList || 'none'}).`,
  };
}

/**
 * The absolute path of a memory file, or null for any other path. Pure.
 *
 * @param {string}   path   absolute, or relative to the memory home
 * @param {object}   where
 * @param {string}   where.home  the directory the memory files live in
 * @param {string[]} where.files the memory file names
 * @returns {string|null}
 */
export function memoryFileTarget(path, { home, files }) {
  if (!path || !home) return null;
  const target = resolve(isAbsolute(path) ? path : join(home, path));
  return files.map((f) => resolve(join(home, f))).includes(target) ? target : null;
}

/**
 * Whether a path lies inside one of the roots (after resolving `..`). Pure. A lexical check: it does
 * not follow symlinks. The fence that holds whatever a shell command does is the VM's file
 * permissions; this one keeps the agent's own file tool off installed code.
 *
 * @param {string}   path
 * @param {string[]} roots
 * @returns {boolean}
 */
export function isWithinRoots(path, roots) {
  const target = resolve(path);
  return roots.some((root) => {
    const rel = relative(resolve(root), target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * Builds the tool registry.
 *
 * @param {object}   o
 * @param {string}   o.workspaceDir       working directory for commands, base for relative paths
 * @param {string[]} [o.writableRoots]    where writeFile may write (default: the workspace)
 * @param {string[]} [o.skillDirs]        directories of skill packages, for the skill-not-found hint
 * @param {string}   [o.binDir]           installed commands, put first on PATH
 * @param {object}   [o.env]              the environment child commands start from (the service
 *                                        passes its own); PATH is taken from it
 * @param {object}   [o.limits]           see DEFAULT_TOOL_LIMITS
 * @param {object}   [o.memory]           omit to leave the memory tools out
 * @param {string}   o.memory.home        the directory the memory files live in
 * @param {string[]} o.memory.files       the files memory may write, e.g. ['MEMORY.md', 'consolidation_report.md']
 * @param {string}   [o.memory.workingMemoryFile='MEMORY.md'] the one with the size limits
 * @param {number}   [o.memory.targetChars]
 * @param {number}   [o.memory.hardCapChars]
 * @param {string[]} o.memory.clis        the memory commands
 * @param {Record<string, string[]>} [o.memory.readViews] read-only definition views
 * @param {string}   [o.tokenEnvVar]      when set, child commands get the VM's access token in this
 *                                        variable, so each command need not ask the metadata server
 * @param {Function} [o.getAccessToken]   the token source (default: the VM's metadata server)
 * @param {Function} [o.logger]           (level, msg) logger
 * @param {Function} [o.now]              clock in milliseconds
 * @returns {{tools: Record<string, object>, select: (names: string[]) => Record<string, object>|undefined}}
 */
export function createToolRegistry({
  workspaceDir,
  writableRoots,
  skillDirs = [],
  binDir,
  env = {},
  limits: limitOverrides,
  memory,
  tokenEnvVar,
  getAccessToken = metadataAccessToken,
  logger = defaultLogger,
  now = Date.now,
}) {
  if (!workspaceDir) throw new Error('createToolRegistry: workspaceDir is required');
  const limits = { ...DEFAULT_TOOL_LIMITS, ...(limitOverrides || {}) };
  const roots = (writableRoots && writableRoots.length > 0 ? writableRoots : [workspaceDir]).map((r) => resolve(r));
  const cap = (text, what, howToNarrow) => capResult(text, what, howToNarrow, limits);
  const resolvePath = (p) => (isAbsolute(p) ? p : join(workspaceDir, p));

  async function childEnv() {
    const out = { ...env, NODE_OPTIONS: '--dns-result-order=ipv4first' };
    if (binDir) {
      // Windows spells it Path; keep whichever key the environment uses.
      const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      out[key] = out[key] ? `${binDir}${delimiter}${out[key]}` : binDir;
    }
    if (tokenEnvVar) {
      try {
        const token = await getAccessToken();
        if (token) out[tokenEnvVar] = token;
      } catch { /* a command that needs a token fetches its own */ }
    }
    return out;
  }

  /** The tool result for a command that did not complete. */
  function execFailure(tool, err, elapsed, brief) {
    const streams = commandStreams(err);
    const timedOut = err.killed || err.signal === 'SIGTERM' || /timed?\s?out/i.test(err.message || '');
    if (timedOut) {
      logger('WARN', `${tool} TIMEOUT ${elapsed}ms (limit ${limits.timeoutMs}ms) → ${brief}`);
      return { error: cap(`ERROR: command timed out after ${Math.round(elapsed / 1000)}s (limit ${Math.round(limits.timeoutMs / 1000)}s): ${brief}\n`
        + 'The command did not finish: treat this as "unknown", not "failed". Re-run a narrower version (one file or id at a time, add --limit, or filter with grep) rather than repeating it verbatim.'
        + (streams ? `\nOutput before it was stopped:\n${streams}` : ''), 'error output') };
    }
    if (err.code === 'ENOBUFS' || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(err.message || '')) {
      logger('WARN', `${tool} OVERFLOW ${elapsed}ms → ${brief}`);
      return { error: `ERROR: command produced more than the ${limits.maxBufferBytes}-byte output limit: ${brief}\n`
        + 'Redirect it to a file and read a range, or filter the output (grep/head) before returning it.' };
    }
    // A command that ran and refused: its exit code and both streams. The reason a command refused
    // is usually on stderr, and often on stdout too; dropping either loses it.
    const head = Number.isInteger(err.code)
      ? `ERROR: command exited with code ${err.code}: ${brief}`
      : `ERROR: ${String(err.message || err).split('\n')[0]}`;
    logger('WARN', `${tool} ✗ ${elapsed}ms → ${brief}: ${head.slice(0, 200)}`);
    return { error: cap(streams ? `${head}\n${streams}` : head, 'error output') };
  }

  const runCommand = {
    name: 'runCommand',
    description: "Execute a shell command on the agent's host. You MUST read the relevant SKILL.md with readFile before your first use of any command: the Available Skills list in your instructions gives each path. Never guess at command syntax. When an argument contains free text with apostrophes, double quotes, newlines or $, do NOT inline it in the command: pass it in the 'stdin' field and read it with the command's --stdin flag. Inlining such text in single quotes breaks the shell's quoting. A command that fails returns its exit code, stdout and stderr.",
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        stdin: { type: 'string', description: 'Optional. Text piped to the command on stdin: the shell-safe channel for free text with quotes, apostrophes or newlines. The shell never parses it, so it cannot break quoting. Pair it with a command that reads stdin (a --stdin flag).' },
      },
      required: ['command'],
    },
    execute: async ({ command, stdin }) => {
      // Breadcrumb for the call in flight: when the brain gives up on a turn, the organ's reply is lost
      // and this line is the only record of what it was doing.
      const brief = String(command ?? '').replace(/\s+/g, ' ').slice(0, 200);
      const t0 = now();
      logger('INFO', `runCommand → ${brief}`);
      try {
        const opts = { cwd: workspaceDir, timeout: limits.timeoutMs, maxBuffer: limits.maxBufferBytes, env: await childEnv() };
        const { stdout, stderr } = await runChild((cb) => execCb(String(command ?? ''), opts, cb), stdin);
        const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
        logger('INFO', `runCommand ✓ ${now() - t0}ms ${output.length}b`);
        return { result: cap(output, 'command output') || '(no output)' };
      } catch (err) {
        return execFailure('runCommand', err, now() - t0, brief);
      }
    },
  };

  const readFile = {
    name: 'readFile',
    description: 'Read the contents of a file from the agent workspace or filesystem.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        startLine: { type: 'number', description: 'Start line (1-indexed)' },
        endLine: { type: 'number', description: 'End line (1-indexed, inclusive)' },
      },
      required: ['path'],
    },
    execute: async ({ path, startLine, endLine }) => {
      try {
        // Read bytes, so a binary file is refused rather than decoded into the context window: a
        // 340 KB PDF decoded as UTF-8 is 340k characters of noise that teach the organ nothing.
        const buf = readFileSync(resolvePath(String(path ?? '')));
        if (limits.binaryGuard) {
          const bin = sniffBinary(buf);
          if (bin) {
            return { error: `ERROR: ${path} is ${bin.kind}, not text: its bytes are unreadable as characters and would consume the whole context window.\n`
              + `Do this instead: ${bin.route.replaceAll('<path>', String(path))}\n`
              + 'This is a routing problem, not a dead end: the content IS reachable by the route above.' };
          }
        }
        const content = buf.toString('utf8');
        if (startLine || endLine) {
          const lines = content.split('\n');
          const start = (startLine || 1) - 1;
          const end = endLine || lines.length;
          return { result: cap(lines.slice(start, end).join('\n'), `${path} lines ${start + 1}-${end}`, 'Request a smaller startLine/endLine range.') };
        }
        return { result: cap(content, path, `Re-read a specific range with startLine/endLine (the file is ${content.length} chars).`) };
      } catch (err) {
        if (err.code === 'ENOENT' && /[\\/]skills[\\/]/.test(String(path))) {
          const available = listSkills(skillDirs);
          if (available.length > 0) {
            return { error: `ERROR: Skill not found at ${path}. Available skills:\n${available.join('\n')}` };
          }
        }
        return { error: `ERROR: ${err.message}` };
      }
    },
  };

  const writeFile = {
    name: 'writeFile',
    description: `Write content to a file. Creates the file if it does not exist. Writable directories: ${roots.join(', ')}.`,
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      const target = resolvePath(String(path ?? ''));
      if (!isWithinRoots(target, roots)) {
        return { error: `REFUSED: '${path}' is outside the writable directories (${roots.join(', ')}). Installed code and organ prompts are read-only.` };
      }
      try {
        const text = typeof content === 'string' ? content : String(content ?? '');
        writeFileSync(target, text, 'utf8');
        return { result: `Written ${text.length} bytes to ${path}` };
      } catch (err) {
        return { error: `ERROR: ${err.message}` };
      }
    },
  };

  const listDir = {
    name: 'listDir',
    description: 'List directory contents.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path' } },
      required: ['path'],
    },
    execute: async ({ path }) => {
      try {
        const dir = resolvePath(String(path ?? ''));
        const entries = readdirSync(dir).map((name) => {
          try {
            const stat = statSync(join(dir, name));
            return `${stat.isDirectory() ? 'd' : '-'} ${name}${stat.isDirectory() ? '/' : ''} (${stat.size}b)`;
          } catch {
            return `? ${name}`;
          }
        });
        return { result: cap(entries.join('\n'), `listing of ${path}`, 'List a narrower subdirectory.') || '(empty directory)' };
      } catch (err) {
        return { error: `ERROR: ${err.message}` };
      }
    },
  };

  const tools = {
    runCommand,
    readFile,
    writeFile,
    listDir,
    viewImage: imageTool({ resolvePath, limits, logger }),
    report_pass: reportPass,
    report_fail: reportFail,
  };
  if (memory) Object.assign(tools, memoryTools({ memory, binDir, limits, cap, childEnv, execFailure, logger, now }));

  return {
    tools,
    /**
     * The tools an organ gets, by name. An empty list means no tools (undefined); a name that isn't
     * registered is an error, so a toolset can never silently lose a tool.
     */
    select(names) {
      if (!Array.isArray(names) || names.length === 0) return undefined;
      const missing = names.filter((n) => !Object.hasOwn(tools, n));
      if (missing.length > 0) throw new Error(`tools not registered: ${missing.join(', ')}`);
      return Object.fromEntries(names.map((n) => [n, tools[n]]));
    },
  };
}

/**
 * viewImage: reads an image file and returns it for the model to look at. It refuses, with a route,
 * whatever a provider would reject: a type not every model takes, more bytes than a provider accepts
 * in one image, too many pixels, a header that cannot be read. A provider that rejects an image
 * rejects the whole request, and the fallback model would be sent the same transcript.
 */
function imageTool({ resolvePath, limits, logger }) {
  const maxBytes = limits.imageMaxBytes;
  const maxSide = limits.imageMaxSide;
  const shrink = (p) => `Make a smaller copy with the files skill (\`file-convert ${p} jpg\`: a JPEG of a photo or a screenshot is usually several times smaller than a PNG; add \`--max-side 2000\` to shrink it as well, since a viewable image is at most ${maxSide} px on its longest side), then view the copy.`;
  return {
    name: 'viewImage',
    description: 'Look at an image file. It is sent to you as pixels, so you see what a person would see: a chart, a screenshot, a photo, a rendered page or slide. '
      + `Takes PNG, JPEG or WebP, up to ${megabytes(maxBytes)} and ${maxSide} px on a side. `
      + 'A PDF page, a slide or a document is not an image: render it to PNG with the files skill first (`file-convert <path> png`), then view the PNG. Convert a GIF the same way. '
      + 'For a larger image, view a smaller copy made with the files skill (`file-convert <path> jpg`, adding `--max-side 2000` to shrink it). '
      + 'Only the images you viewed most recently stay attached as the turn goes on, so note what you see.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or workspace-relative path of a PNG, JPEG or WebP file' } },
      required: ['path'],
    },
    execute: async ({ path }) => {
      const shown = String(path ?? '');
      const tooLarge = (bytes) => `ERROR: ${shown} is ${bytes.toLocaleString('en-US')} bytes; viewImage takes images up to `
        + `${maxBytes.toLocaleString('en-US')} bytes (${megabytes(maxBytes)}), the most a model accepts in one image. ${shrink(shown)}`;
      let buf;
      try {
        const target = resolvePath(shown);
        const stat = statSync(target);
        if (stat.isDirectory()) return { error: `ERROR: ${shown} is a directory, not an image file. Give the path of one image file.` };
        // Size first: an oversized file is refused without reading it into memory.
        if (stat.size > maxBytes) return { error: tooLarge(stat.size) };
        buf = readFileSync(target);
      } catch (err) {
        return { error: `ERROR: ${err.message}` };
      }
      if (buf.length > maxBytes) return { error: tooLarge(buf.length) };
      const image = sniffImage(buf);
      if (!image) return { error: notAnImage(shown, buf) };
      if (!image.viewable) {
        return { error: `ERROR: ${shown} is a ${image.kind} image, which not every model can view. Convert it to PNG with the files skill (\`file-convert ${shown} png\`), then view the PNG.` };
      }
      const dims = imageDimensions(buf, image.mimeType);
      if (!dims) {
        return { error: `ERROR: ${shown} starts like a ${image.kind} image, but its header is damaged or cut off, so a model would reject it. Re-create the image, or convert it with the files skill (\`file-convert ${shown} png\`) and view the result.` };
      }
      if (Math.max(dims.width, dims.height) > maxSide) {
        return { error: `ERROR: ${shown} is ${dims.width}x${dims.height} px; viewImage takes images up to ${maxSide} px on a side. ${shrink(shown)}` };
      }
      logger('INFO', `viewImage → ${shown} ${image.kind} ${dims.width}x${dims.height} ${buf.length}b`);
      return {
        result: `Viewing ${shown}: ${image.kind}, ${dims.width}x${dims.height} px, ${buf.length} bytes. The image is attached to this result.`,
        images: [{ mimeType: image.mimeType, data: buf.toString('base64'), name: shown }],
      };
    },
  };
}

/** The refusal for a file that is not a known image, with the route that fits what it is. */
function notAnImage(shown, buf) {
  const bin = sniffBinary(buf);
  if (!bin) return `ERROR: ${shown} is text, not an image: read it with readFile.`;
  if (bin.kind === 'PDF' || bin.kind.startsWith('ZIP/OOXML')) {
    return `ERROR: ${shown} is ${bin.kind}, not an image. Render the page or slide you need to PNG with the files skill (\`file-convert ${shown} png\`), then view the PNG.`;
  }
  return `ERROR: ${shown} is not a PNG, JPEG or WebP image: its first bytes match none of them. If it is an image in another format, convert it to PNG with the files skill (\`file-convert ${shown} png\`) and view the PNG.`;
}

/** Bytes as megabytes, for a person or a model to read: 3750000 is '3.75 MB'. */
function megabytes(bytes) {
  return `${(bytes / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })} MB`;
}

function memoryTools({ memory, binDir, limits, cap, childEnv, execFailure, logger, now }) {
  if (!memory.home) throw new Error('createToolRegistry: memory.home is required');
  if (!Array.isArray(memory.files) || memory.files.length === 0) throw new Error('createToolRegistry: memory.files is required');
  if (!Array.isArray(memory.clis)) throw new Error('createToolRegistry: memory.clis is required');
  if (!binDir) throw new Error('createToolRegistry: binDir is required for the memory commands');
  const policy = { binDir, clis: memory.clis, readViews: memory.readViews || {} };
  const workingMemoryFile = memory.workingMemoryFile || 'MEMORY.md';
  const targetChars = memory.targetChars || DEFAULT_MEMORY_LIMITS.targetChars;
  const hardCapChars = memory.hardCapChars || DEFAULT_MEMORY_LIMITS.hardCapChars;
  const views = Object.entries(policy.readViews).map(([k, v]) => `${k} ${v.join('|')}`).join(', ');
  const [exampleCli] = policy.clis;

  const memoryCommand = {
    name: 'memoryCommand',
    description: `Run ONE memory command: the only commands the memory organ runs. Memory commands: ${policy.clis.join(', ')}. `
      + (views ? `Read-only definition views: ${views} (definitions are read, never written). ` : '')
      + `Pass the command line exactly as the memory skill shows it${exampleCli ? `, e.g. "${exampleCli} --limit 50"` : ''}. `
      + 'It runs WITHOUT a shell: pipes, redirects, ";", "&&" and "$(...)" are refused. Put long free text (quotes, apostrophes, newlines) in \'stdin\' for a command that reads it.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The memory command and its arguments.' },
        stdin: { type: 'string', description: 'Optional text piped to the command on stdin.' },
      },
      required: ['command'],
    },
    execute: async ({ command, stdin }) => {
      const brief = String(command ?? '').replace(/\s+/g, ' ').slice(0, 200);
      let argv;
      try {
        argv = splitCommandLine(String(command ?? '').trim());
      } catch (e) {
        logger('WARN', `memoryCommand ✗ refused → ${brief}: ${e.message}`);
        return { error: `REFUSED (memory boundary): ${e.message}` };
      }
      const check = checkMemoryCommand(argv, policy);
      if (!check.ok) {
        logger('WARN', `memoryCommand ✗ refused → ${brief}: ${check.reason}`);
        return { error: `REFUSED (memory boundary): ${check.reason}` };
      }
      const t0 = now();
      logger('INFO', `memoryCommand → ${brief}`);
      try {
        const opts = { cwd: memory.home, timeout: limits.timeoutMs, maxBuffer: limits.maxBufferBytes, env: await childEnv() };
        const { stdout, stderr } = await runChild((cb) => execFileCb(check.path, argv.slice(1), opts, cb), stdin);
        const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
        logger('INFO', `memoryCommand ✓ ${now() - t0}ms ${output.length}b`);
        return { result: cap(output, 'command output') || '(no output)' };
      } catch (err) {
        return execFailure('memoryCommand', err, now() - t0, brief);
      }
    },
  };

  const writeMemoryFile = {
    name: 'writeMemoryFile',
    description: `Write one of the memory organ's own files: working memory (${workingMemoryFile}; keep it under ${targetChars.toLocaleString('en-US')} characters) `
      + `or the consolidation report. These are the ONLY files memory writes: ${memory.files.join(', ')}. Any other path is refused: `
      + 'process, project, skill and organ files are read-only to memory, and Deep Truths change only through their own memory command.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `One of: ${memory.files.join(', ')}` },
        content: { type: 'string', description: 'The complete file content' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      const target = memoryFileTarget(String(path ?? ''), { home: memory.home, files: memory.files });
      if (!target) {
        logger('WARN', `writeMemoryFile ✗ refused → ${path}`);
        return { error: `REFUSED (memory boundary): '${path}' is not a memory file. Memory writes only ${memory.files.join(', ')}.` };
      }
      const text = typeof content === 'string' ? content : String(content ?? '');
      const isWorkingMemory = basename(target) === workingMemoryFile;
      if (isWorkingMemory && text.length > hardCapChars) {
        return { error: `REFUSED: ${workingMemoryFile} would be ${text.length} chars (hard cap ${hardCapChars}; target < ${targetChars}). Prune further: working memory is loaded into every cortex prompt.` };
      }
      try {
        writeFileSync(target, text, 'utf8');
        const over = isWorkingMemory && text.length > targetChars ? `, over the ${targetChars}-char target; prune further` : '';
        return { result: `Written ${text.length} chars to ${basename(target)}${over}` };
      } catch (err) {
        return { error: `ERROR: ${err.message}` };
      }
    },
  };

  return { memoryCommand, writeMemoryFile };
}

/**
 * Runs a child through `start(callback)` and always closes its stdin: with the given text, or empty.
 * Text on stdin never passes through a shell, so it cannot break quoting; an empty, closed stdin
 * means a command that reads stdin gets end-of-file instead of waiting until the timeout.
 */
function runChild(start, stdin) {
  return new Promise((resolvePromise, reject) => {
    const child = start((err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolvePromise({ stdout, stderr });
    });
    child.stdin?.on('error', () => { /* the child exited before reading */ });
    try { child.stdin?.end(typeof stdin === 'string' ? stdin : ''); } catch { /* the child already exited */ }
  });
}

/** A failed command's stdout and stderr, labelled, or '' when both are empty. */
function commandStreams(err) {
  const out = String(err?.stdout ?? '').trimEnd();
  const errText = String(err?.stderr ?? '').trimEnd();
  return [out && `STDOUT:\n${out}`, errText && `STDERR:\n${errText}`].filter(Boolean).join('\n');
}

/** Paths of every SKILL.md under the skill directories. */
function listSkills(skillDirs) {
  const found = [];
  for (const dir of skillDirs) {
    let names;
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      const file = join(dir, name, 'SKILL.md');
      if (existsSync(file)) found.push(file);
    }
  }
  return found;
}

// ---- Verdict tools: the cerebellum's only way to report. Terminal: calling one ends the turn. ----

const CHECKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      criterion: { type: 'string' },
      pass: { type: 'boolean' },
      evidence: { type: 'string' },
    },
    required: ['criterion', 'pass', 'evidence'],
  },
};

const reportPass = Object.freeze({
  name: 'report_pass',
  description: "Report that the milestone's INTENT is achieved. Call this tool exactly once when the deliverable does what was asked, with concrete supporting evidence. You may PASS even when a listed criterion is only partially met or deferred, SO LONG AS the gap does NOT defeat the deliverable (e.g. a value that resolves at runtime, an optional enrichment left undone): pass, and state that gap in `caveat` so the user sees it. Reserve report_fail for a milestone whose intent is genuinely unmet (wrong output, a missing core deliverable, an unrecoverable error, a claim contradicted by evidence).",
  schema: {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: 'Brief summary of why the work passes' },
      checks: CHECKS_SCHEMA,
      caveat: { type: 'string', description: 'OPTIONAL. Leave empty for a clean, unqualified pass. If the intent is met but a criterion is partially met or deferred in a way that does NOT defeat the deliverable, name that gap here in one plain sentence: it is shown to the user, honestly, not hidden. A caveat is not a way to wave through wrong work: a gap that defeats the deliverable is a report_fail, not a caveat.' },
    },
    required: ['reasoning', 'checks'],
  },
  execute: async ({ reasoning, checks, caveat }) => ({ verdict: 'PASS', reasoning, checks, ...(caveat ? { caveat } : {}) }),
});

const reportFail = Object.freeze({
  name: 'report_fail',
  description: 'Report that one or more acceptance criteria are NOT satisfied. Call this tool exactly once when any criterion lacks evidence or is contradicted.',
  schema: {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: 'Summary of what failed and why' },
      checks: CHECKS_SCHEMA,
      recommendation: { type: 'string', description: 'Specific action to fix the failure' },
    },
    required: ['reasoning', 'checks', 'recommendation'],
  },
  execute: async ({ reasoning, checks, recommendation }) => ({ verdict: 'FAIL', reasoning, checks, recommendation }),
});

function defaultLogger(level, msg) {
  console.log(`[gateway] ${level}: ${msg}`);
}
