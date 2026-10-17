// agent/storage/file-store.mjs: where files going out to people, and coming in from them, live in
// the instance's bucket. A mission's outgoing files sit at <prefix>out/<missionId>/<name>, where the
// dashboard lists them as downloads; uploaded files sit at <prefix>in/<uploadId>/<name>. This module
// names objects and moves bytes. Which files a mission hands back is decided by its callers
// (artifacts.mjs and the files skill), and the dashboard signs its own upload URLs.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';

const DEFAULT_PREFIX = 'files/'; // default; callers pass the contracts value
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // default; callers pass the contracts value
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_NAME_LENGTH = 200;

const CONTENT_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html',
  '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * The content type a download is served with, from the file's extension.
 *
 * @param {string} name
 * @returns {string}
 */
export function contentTypeFor(name) {
  return CONTENT_TYPES[extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

/**
 * A file name that is safe as the last segment of an object name: no directory part, no control
 * characters, at most 200 characters with the extension kept, never empty, '.' or '..'.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFileName(name) {
  const last = String(name ?? '').split(/[\\/]/).pop();
  let clean = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean || clean === '.' || clean === '..') clean = 'file';
  if (clean.length > MAX_NAME_LENGTH) {
    const ext = extname(clean).slice(0, 20);
    clean = clean.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return clean;
}

/** An id as one path segment: anything but letters, digits, '_' and '-' becomes '_'. */
function idSegment(id, what) {
  const segment = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!segment) throw new Error(`file-store: ${what} is required`);
  return segment;
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/**
 * Object name of a mission's outgoing file: <prefix>out/<missionId>/<name>.
 *
 * @param {string} prefix - e.g. 'files/'
 * @param {string} missionId
 * @param {string} name
 */
export function outgoingObjectName(prefix, missionId, name) {
  return `${normalizePrefix(prefix)}out/${idSegment(missionId, 'missionId')}/${sanitizeFileName(name)}`;
}

/**
 * Object name of an uploaded file: <prefix>in/<uploadId>/<name>.
 *
 * @param {string} prefix - e.g. 'files/'
 * @param {string} uploadId
 * @param {string} name
 */
export function incomingObjectName(prefix, uploadId, name) {
  return `${normalizePrefix(prefix)}in/${idSegment(uploadId, 'uploadId')}/${sanitizeFileName(name)}`;
}

/** Credentials are never shared, whatever the caller asks. Checked on the resolved path. */
function isCredentialPath(absPath) {
  const path = absPath.replace(/\\/g, '/').toLowerCase();
  const name = path.split('/').pop();
  return path.endsWith('/.gateway-token')
    || path.includes('/keys/')
    || name.endsWith('-key.json')
    || name.endsWith('.pem')
    || name === '.env' || name.startsWith('.env.')
    || (name.includes('credentials') && name.endsWith('.json'));
}

/** `report.md` taken: `report-2.md`, then `report-3.md`. */
function uniqueName(name, used) {
  if (!used.has(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 2;
  while (used.has(`${stem}-${n}${ext}`)) n += 1;
  return `${stem}-${n}${ext}`;
}

/**
 * Creates a file store over one bucket.
 *
 * @param {object}   options
 * @param {string}   options.bucket           the instance's bucket
 * @param {string}   [options.prefix]         object prefix for files, e.g. 'files/'
 * @param {number}   [options.maxBytes]       largest file that is uploaded
 * @param {Function} [options.getAccessToken] token source; defaults to the VM's metadata server
 * @param {Function} [options.fetch]          fetch implementation (injectable for tests)
 * @param {Function} [options.logger]         (level, message)
 * @returns {{uploadOutgoing: Function}}
 */
export function createFileStore({
  bucket,
  prefix = DEFAULT_PREFIX,
  maxBytes = DEFAULT_MAX_BYTES,
  getAccessToken = getVmAccessToken,
  fetch = globalThis.fetch,
  logger = () => {},
} = {}) {
  if (!bucket) throw new Error('createFileStore: bucket is required');
  const log = logger;

  /**
   * Uploads local files as a mission's downloads. Best effort, file by file: a missing file, a
   * directory, a credential, an oversized file or a failed upload is logged and skipped, and the
   * rest still go. Two files with the same name in one call get distinct names.
   *
   * @param {string} missionId
   * @param {string[]} absPaths - absolute paths of local files
   * @returns {Promise<Array<{name: string, size: number, gcsPath: string, contentType: string}>>}
   */
  async function uploadOutgoing(missionId, absPaths) {
    idSegment(missionId, 'missionId');
    const results = [];
    const token = await getAccessToken().catch((err) => {
      log('ERROR', `uploadOutgoing auth failure: ${err.message}`);
      return null;
    });
    if (!token) return results;

    const used = new Set();
    for (const raw of absPaths || []) {
      try {
        if (!existsSync(raw)) { log('WARN', `uploadOutgoing: missing ${raw}`); continue; }
        const abs = realpathSync(raw);
        if (isCredentialPath(abs)) { log('WARN', `uploadOutgoing: denied credential path ${raw}`); continue; }
        const st = statSync(abs);
        if (st.isDirectory()) { log('WARN', `uploadOutgoing: skipping directory ${raw}`); continue; }
        if (st.size > maxBytes) { log('WARN', `uploadOutgoing: ${raw} exceeds ${maxBytes} bytes, skipping`); continue; }

        const name = uniqueName(sanitizeFileName(abs), used);
        const objectName = outgoingObjectName(prefix, missionId, name);
        const contentType = contentTypeFor(name);
        const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
          body: readFileSync(abs),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 160)}`);
        }
        await resp.json();

        used.add(name);
        log('INFO', `uploadOutgoing: uploaded ${name} (${st.size} B) to gs://${bucket}/${objectName}`);
        results.push({ name, size: st.size, gcsPath: objectName, contentType });
      } catch (err) {
        log('ERROR', `uploadOutgoing: failed ${raw}: ${err.message}`);
      }
    }
    return results;
  }

  return { uploadOutgoing };
}
