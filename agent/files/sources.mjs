// agent/files/sources.mjs: bringing a file into a mission's inbox from wherever it was shared. A
// source is an upload from dashboard chat (gs://<bucket>/files/in/..., the bare object path
// files/in/..., or the upload id), any object in Cloud Storage the agent can read, an http(s) link
// (redirects followed, size capped, named from Content-Disposition or the URL), a git repository
// (shallow clone), or a Google Drive link or id (through agent/providers/drive.mjs: Google Docs,
// Sheets and Slides are exported, other files downloaded). Every file is written beside its final
// name, hashed as it is written, and moved into place only when complete; fetching the same bytes
// under the same name again reuses the file, different bytes get a new name. Credentials embedded in a
// URL never reach the record. Used by the files skill's file-get; the mission inbox's path is
// mission-paths.mjs's.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { STORAGE_HOST } from '../storage/hosts.mjs';
import { sanitizeFileName } from '../storage/file-names.mjs';
import { describeType, EXPORT_FORMATS, exportMimeType, FOLDER_MIME, isGoogleNative, parseDriveLink, SHORTCUT_MIME } from '../providers/drive.mjs';
import { detectFormat, formatForMime } from './formats.mjs';
import { freeName } from './mission-paths.mjs';

/** The kinds of source, for --kind. */
export const SOURCE_KINDS = Object.freeze(['upload', 'gcs', 'http', 'git', 'drive']);

/** An upload id, as the dashboard makes them: u-<ms since epoch>-<8 lowercase hex>. */
const UPLOAD_ID = /^u-\d+-[0-9a-f]{8}$/;
const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);
/** Addresses a fetch never goes to: the metadata server holds the VM's credentials. */
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', '169.254.169.254', '[fd00:ec2::254]']);
const USER_AGENT = 'Mozilla/5.0 (compatible; paraclete-file-get/1.0)';

/** A source file-get cannot fetch, in words the agent can act on. */
export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
  }
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/** A URL as it may be shown and recorded: any user name or password in it removed. */
export function redactUrl(text) {
  return String(text ?? '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

/** Whether an http(s) URL names a git repository rather than a page. */
export function isGitUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (/\.git\/?$/.test(u.pathname)) return true;
  const segments = u.pathname.split('/').filter(Boolean);
  return GIT_HOSTS.has(u.hostname.toLowerCase()) && segments.length === 2 && !u.search;
}

/**
 * What a source is.
 *
 * @param {string} source
 * @param {object} o
 * @param {string} o.bucket   the instance's bucket
 * @param {string} o.prefix   files.prefix, e.g. 'files/'
 * @param {string} [o.kind]   one of SOURCE_KINDS, to say what the source is instead of guessing
 * @returns {{kind: string, bucket?: string, object?: string, uploadId?: string, url?: string, fileId?: string}}
 * @throws {SourceError}
 */
export function classifySource(source, { bucket, prefix, kind = null }) {
  const s = String(source ?? '').trim();
  if (!s) throw new SourceError('the source is empty');
  if (kind && !SOURCE_KINDS.includes(kind)) throw new SourceError(`--kind must be one of ${SOURCE_KINDS.join(', ')}`);
  const incoming = `${normalizePrefix(prefix)}in/`;
  const gs = /^gs:\/\/([^/]+)\/(.+)$/.exec(s);
  const http = /^https?:\/\//i.test(s);
  const gitScheme = /^(git@[^:]+:|ssh:\/\/|git:\/\/)/.test(s);

  const asUpload = () => {
    if (gs && gs[1] === bucket && gs[2].startsWith(incoming)) return { kind: 'upload', bucket, object: gs[2] };
    if (s.startsWith(incoming)) return { kind: 'upload', bucket, object: s };
    if (UPLOAD_ID.test(s)) return { kind: 'upload', bucket, uploadId: s };
    return null;
  };
  const asDrive = () => {
    const fileId = parseDriveLink(s);
    return fileId ? { kind: 'drive', fileId } : null;
  };

  if (kind) {
    const forced = {
      upload: asUpload,
      gcs: () => (gs ? { kind: 'gcs', bucket: gs[1], object: gs[2] } : null),
      http: () => (http ? { kind: 'http', url: s } : null),
      git: () => (http || gitScheme ? { kind: 'git', url: s } : null),
      drive: asDrive,
    }[kind]();
    if (!forced) throw new SourceError(`'${redactUrl(s)}' is not a ${kind} source`);
    return forced;
  }
  const upload = asUpload();
  if (upload) return upload;
  if (gs) return { kind: 'gcs', bucket: gs[1], object: gs[2] };
  if (http) {
    const host = (() => { try { return new URL(s).hostname.toLowerCase(); } catch { return ''; } })();
    if (/(^|\.)(docs|drive)\.google\.com$/.test(host)) {
      const drive = asDrive();
      if (drive) return drive;
    }
    return isGitUrl(s) ? { kind: 'git', url: s } : { kind: 'http', url: s };
  }
  if (gitScheme) return { kind: 'git', url: s };
  const drive = asDrive();
  if (drive) return drive;
  throw new SourceError(`'${redactUrl(s)}' is not a source file-get knows: give an uploaded file's path (files/in/...), a gs:// path, an http(s) link, a git URL, or a Drive link or id`);
}

/** The file name a Content-Disposition header gives, or null. */
export function nameFromDisposition(header) {
  const h = String(header ?? '');
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(h);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(h);
  return plain ? (plain[2] ?? plain[1]).trim() || null : null;
}

/** The last segment of a URL's path, decoded, or null. */
export function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

/** Streams a response body to a file, hashing it, and stops at the cap. */
async function writeBody(response, path, maxBytes, what) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'w');
  let size = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new SourceError(`${what} is larger than ${mb(maxBytes)}, the most file-get downloads (files.fetch_max_mb)`);
        }
        hash.update(value);
        writeSync(fd, value);
      }
    }
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest('hex') };
}

/**
 * Creates the fetcher.
 *
 * @param {object}   deps
 * @param {string}   deps.bucket          the instance's bucket
 * @param {string}   deps.prefix          files.prefix
 * @param {number}   deps.maxBytes        the largest download (files.fetch_max_mb)
 * @param {number}   [deps.uploadMaxBytes] the largest upload (files.max_upload_mb); default maxBytes
 * @param {number}   [deps.timeoutSeconds] how long one download may take
 * @param {Function} deps.getAccessToken  the VM's token source
 * @param {Function} [deps.fetch]
 * @param {string}   [deps.storageHost]   Cloud Storage API origin
 * @param {object}   deps.runner          runner.mjs's: git, and `file` for the type
 * @param {object}   [deps.drive]         a client from createDriveClient(); without it, Drive sources fail
 * @returns {{fetchInto: Function}}
 */
export function createFetcher({
  bucket, prefix, maxBytes, uploadMaxBytes = maxBytes, timeoutSeconds = 180, getAccessToken, fetch = globalThis.fetch,
  storageHost = STORAGE_HOST, runner, drive = null,
}) {
  const gcsHost = storageHost.replace(/\/+$/, '');
  const signal = () => AbortSignal.timeout(timeoutSeconds * 1000);

  /** Writes a file into the inbox through `write(partialPath)`, then names it. */
  async function land(inbox, name, write) {
    mkdirSync(inbox, { recursive: true });
    const partial = join(inbox, `.partial-${randomBytes(6).toString('hex')}`);
    try {
      const { size, sha256 } = await write(partial);
      const clean = sanitizeFileName(name);
      const same = join(inbox, clean);
      if (existsSync(same) && statSync(same).isFile() && sha256Of(same) === sha256) {
        rmSync(partial, { force: true });
        return { path: same, name: clean, size, sha256 };
      }
      const final = freeName(inbox, clean);
      renameSync(partial, join(inbox, final));
      return { path: join(inbox, final), name: final, size, sha256 };
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
  }

  async function gcsFetch(url, what) {
    const token = await getAccessToken();
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: signal() });
    } catch (err) {
      throw new SourceError(`reading ${what} failed: ${err.message}`);
    }
    if (response.status === 404) throw new SourceError(`${what} does not exist`);
    if (response.status === 401 || response.status === 403) {
      throw new SourceError(`the agent may not read ${what}: its service account needs the Storage Object Viewer role on that bucket`);
    }
    if (!response.ok) throw new SourceError(`Cloud Storage answered HTTP ${response.status} for ${what}`);
    return response;
  }

  async function fromStorage(target, inbox, opts, cap) {
    let object = target.object;
    if (target.uploadId) {
      const listPrefix = `${normalizePrefix(prefix)}in/${target.uploadId}/`;
      const list = await (await gcsFetch(`${gcsHost}/storage/v1/b/${encodeURIComponent(target.bucket)}/o?prefix=${encodeURIComponent(listPrefix)}`, `upload ${target.uploadId}`)).json();
      object = list.items?.[0]?.name;
      if (!object) throw new SourceError(`there is no upload ${target.uploadId}: copy the file's path from the "Files shared with this request" block`);
    }
    const what = `gs://${target.bucket}/${object}`;
    const base = `${gcsHost}/storage/v1/b/${encodeURIComponent(target.bucket)}/o/${encodeURIComponent(object)}`;
    const meta = await (await gcsFetch(base, what)).json();
    if (Number(meta.size) > cap) throw new SourceError(`${what} is ${mb(Number(meta.size))}, more than the ${mb(cap)} file-get downloads`);
    const media = await gcsFetch(`${base}?alt=media`, what);
    const landed = await land(inbox, opts.name || basename(object), (p) => writeBody(media, p, cap, what));
    return { ...landed, source: what };
  }

  async function fromHttp(url, inbox, opts) {
    const shown = redactUrl(url);
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { throw new SourceError(`'${shown}' is not a valid URL`); }
    if (BLOCKED_HOSTS.has(host)) throw new SourceError(`${shown} is the VM's metadata server, which file-get never fetches`);
    let response;
    try {
      response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, signal: signal() });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? `no answer within ${timeoutSeconds} seconds` : err.message;
      throw new SourceError(`the request failed (${reason}): ${shown}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(`HTTP ${response.status} for ${shown}`);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(`${shown} is ${mb(length)}, more than the ${mb(maxBytes)} file-get downloads (files.fetch_max_mb)`);
    }
    let name = opts.name || nameFromDisposition(response.headers.get('content-disposition')) || nameFromUrl(response.url || url) || 'download';
    if (!extname(name)) {
      const format = formatForMime(response.headers.get('content-type'));
      if (format) name = `${name}.${format}`;
    }
    const landed = await land(inbox, name, (p) => writeBody(response, p, maxBytes, shown));
    const finalUrl = response.url && response.url !== url ? redactUrl(response.url) : null;
    return { ...landed, source: shown, ...(finalUrl ? { final_url: finalUrl } : {}) };
  }

  async function fromGit(url, inbox, opts) {
    const shown = redactUrl(url);
    const repo = sanitizeFileName(opts.name || /([^/:]+?)(?:\.git)?\/?$/.exec(url)?.[1] || 'repo');
    mkdirSync(inbox, { recursive: true });
    const dir = join(inbox, freeName(inbox, repo));
    const env = { GIT_TERMINAL_PROMPT: '0' };
    if (opts.gitToken) {
      // The token reaches git through its environment only: never the command line, the URL or the
      // clone's .git/config.
      Object.assign(env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$PARACLETE_GIT_TOKEN"; }; f',
        PARACLETE_GIT_TOKEN: opts.gitToken,
      });
    }
    try {
      await runner.check('git', ['clone', '--depth', '1', ...(opts.branch ? ['--branch', opts.branch] : []), '--', url, dir], { env });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      const why = String(err.message).split(url).join(shown);
      throw new SourceError(`cloning ${shown} failed: ${why}${opts.gitToken ? '' : '. A private repository needs --token-secret <secret id>'}`);
    }
    const { stdout } = await runner.check('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return { path: dir, name: basename(dir), type: 'git-repo', size: null, sha256: null, source: shown, commit: stdout.toString('utf8').trim() };
  }

  async function fromDrive(fileId, inbox, opts) {
    if (!drive) throw new SourceError('Drive is not reachable from this command');
    try {
      let meta = await drive.getMeta(fileId);
      if (meta.mimeType === SHORTCUT_MIME && meta.shortcutDetails?.targetId) meta = await drive.getMeta(meta.shortcutDetails.targetId);
      const what = `'${meta.name}' (${meta.id})`;
      if (meta.mimeType === FOLDER_MIME) {
        throw new SourceError(`${what} is a Drive folder: list it with \`drive-find --folder ${meta.id}\`, then fetch the files you need one by one`);
      }
      let bytes;
      let name;
      if (isGoogleNative(meta.mimeType)) {
        const formats = Object.keys(EXPORT_FORMATS[meta.mimeType] || {});
        if (!formats.length) throw new SourceError(`${what} is a ${describeType(meta.mimeType)}, which cannot be exported`);
        const format = String(opts.exportFormat || formats[0]).toLowerCase();
        const mime = exportMimeType(meta.mimeType, format);
        if (!mime) throw new SourceError(`a ${describeType(meta.mimeType)} exports as ${formats.join(', ')}, not ${format}`);
        bytes = Buffer.from(await drive.export(meta.id, mime));
        const base = opts.name || meta.name || meta.id;
        name = extname(base).slice(1).toLowerCase() === format ? base : `${base}.${format}`;
      } else {
        if (opts.exportFormat) throw new SourceError(`--export applies to Google Docs, Sheets and Slides; ${what} is a stored file, fetched as it is`);
        const got = await drive.download(meta.id, { maxBytes });
        bytes = Buffer.from(got.bytes);
        name = opts.name || got.name || meta.id;
      }
      if (bytes.length > maxBytes) throw new SourceError(`${what} is ${mb(bytes.length)}, more than the ${mb(maxBytes)} file-get downloads`);
      const landed = await land(inbox, name, (p) => {
        const fd = openSync(p, 'w');
        try { writeSync(fd, bytes); } finally { closeSync(fd); }
        return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      return { ...landed, source: meta.webViewLink || `drive:${meta.id}` };
    } catch (err) {
      if (err instanceof SourceError) throw err;
      throw new SourceError(err.message);
    }
  }

  /**
   * Fetches a source into an inbox directory.
   *
   * @param {string} source
   * @param {string} inbox
   * @param {object} [opts]
   * @param {string} [opts.kind]          what the source is, instead of guessing
   * @param {string} [opts.name]          the name to save it under
   * @param {string} [opts.branch]        git: the branch or tag
   * @param {string} [opts.gitToken]      git: an access token for a private repository
   * @param {string} [opts.exportFormat]  Drive: what a Google Doc, Sheet or Slides file exports as
   * @returns {Promise<{path: string, name: string, type: string, size: number|null, sha256: string|null, source: string}>}
   * @throws {SourceError}
   */
  async function fetchInto(source, inbox, opts = {}) {
    const target = classifySource(source, { bucket, prefix, kind: opts.kind });
    if (opts.branch && target.kind !== 'git') throw new SourceError('--branch applies to a git repository');
    if (opts.gitToken && target.kind !== 'git') throw new SourceError('--token-secret applies to a git repository');
    if (opts.exportFormat && target.kind !== 'drive') throw new SourceError('--export applies to a Drive file');
    let landed;
    if (target.kind === 'upload') landed = await fromStorage(target, inbox, opts, Math.max(uploadMaxBytes, maxBytes));
    else if (target.kind === 'gcs') landed = await fromStorage(target, inbox, opts, maxBytes);
    else if (target.kind === 'http') landed = await fromHttp(target.url, inbox, opts);
    else if (target.kind === 'git') return fromGit(target.url, inbox, opts);
    else landed = await fromDrive(target.fileId, inbox, opts);
    const { format, mime } = await detectFormat(landed.path, { runner });
    const { path, name, size, sha256, source: shown, ...extra } = landed;
    return { path, name, type: format || mime, size, sha256, source: shown, ...extra };
  }

  return { fetchInto };
}
