// agent/storage/file-store.mjs: where files going out to people, and coming in from them, live in
// the instance's bucket. A mission's outgoing files sit at <prefix>out/<missionId>/<name>, where the
// dashboard lists them as downloads; uploaded files sit at <prefix>in/<uploadId>/<name> (the names are
// file-names.mjs's). This module moves bytes, and refuses to send a credential or an oversized file
// whatever the caller asks. Which files a mission hands back is decided by its callers (artifacts.mjs
// and the files skill's file-share), which also write the files' records (agent/files/outgoing.mjs);
// the dashboard signs its own upload URLs.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { STORAGE_HOST } from './hosts.mjs';
import { contentTypeFor, idSegment, outgoingObjectName, sanitizeFileName } from './file-names.mjs';
import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';

// The naming helpers live in file-names.mjs, free of file system access, so the dashboard can import
// them; they are re-exported here for the agent's callers.
export { CONTENT_TYPES, contentTypeFor, incomingObjectName, outgoingObjectName, sanitizeFileName } from './file-names.mjs';

const DEFAULT_PREFIX = 'files/'; // default; callers pass the contracts value
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // default; callers pass the contracts value
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Credentials are never shared, whatever the caller asks. Checked on the resolved path: the
 * instance's own configuration and gateway token, keys, SSH and git credentials, .env files.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
export function isCredentialPath(absPath) {
  const path = absPath.replace(/\\/g, '/').toLowerCase();
  const name = path.split('/').pop();
  return path.startsWith('/etc/paraclete/')
    || name === 'gateway-token' || name === '.gateway-token'
    || path.includes('/keys/')
    || path.includes('/.ssh/')
    || name.endsWith('-key.json')
    || name.endsWith('.pem') || name.endsWith('.key')
    || name === '.git-credentials' || name === '.netrc'
    || name === '.env' || name.startsWith('.env.')
    || (name.includes('credentials') && name.endsWith('.json'));
}

/** A size in words: bytes, KB or MB. */
function sizeText(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1).replace(/\.0$/, '')} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${bytes} bytes`;
}

/** A file the store will not send, and why. The message is agent-facing. */
export class ShareRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShareRefused';
  }
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
 * @param {string}   [options.storageHost]    Cloud Storage API origin; defaults to production
 * @returns {{uploadOne: Function, uploadOutgoing: Function}}
 */
export function createFileStore({
  bucket,
  prefix = DEFAULT_PREFIX,
  maxBytes = DEFAULT_MAX_BYTES,
  getAccessToken = getVmAccessToken,
  fetch = globalThis.fetch,
  logger = () => {},
  storageHost = STORAGE_HOST,
} = {}) {
  if (!bucket) throw new Error('createFileStore: bucket is required');
  const gcsHost = storageHost.replace(/\/+$/, '');
  const log = logger;

  /**
   * Checks one local file before it goes: it must exist, be a regular file, not be a credential, and
   * fit the size cap.
   *
   * @returns {{abs: string, size: number} | {refused: 'missing'|'credential'|'directory'|'not_file'|'too_large', abs?: string, size?: number}}
   */
  function inspect(raw) {
    if (!existsSync(raw)) return { refused: 'missing' };
    const abs = realpathSync(raw);
    if (isCredentialPath(abs)) return { refused: 'credential', abs };
    const st = statSync(abs);
    if (st.isDirectory()) return { refused: 'directory', abs };
    if (!st.isFile()) return { refused: 'not_file', abs };
    if (st.size > maxBytes) return { refused: 'too_large', abs, size: st.size };
    return { abs, size: st.size };
  }

  async function put(token, objectName, contentType, bytes) {
    const url = `${gcsHost}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 160)}`);
    }
    await resp.json();
  }

  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

  /**
   * Uploads one local file as a mission's download, under its own name or the one given. A file of
   * the same name for the same mission is replaced: the latest wins.
   *
   * @param {string} missionId
   * @param {string} path
   * @param {{name?: string}} [opts]
   * @returns {Promise<{name: string, size: number, gcsPath: string, contentType: string, sha256: string}>}
   * @throws {ShareRefused} for a file that may not go; Error for a failed upload
   */
  async function uploadOne(missionId, path, { name } = {}) {
    idSegment(missionId, 'missionId');
    const file = inspect(path);
    const reasons = {
      missing: `${path} does not exist`,
      credential: `${path} is a credential or the instance's own configuration, which is never shared`,
      directory: `${path} is a directory: share its files one by one, or zip it first`,
      not_file: `${path} is not a regular file`,
      too_large: `${path} is ${sizeText(file.size || 0)}, more than the ${sizeText(maxBytes)} a shared file may be (files.max_mb)`,
    };
    if (file.refused) throw new ShareRefused(reasons[file.refused]);
    const bytes = readFileSync(file.abs);
    const fileName = sanitizeFileName(name || file.abs);
    const objectName = outgoingObjectName(prefix, missionId, fileName);
    const contentType = contentTypeFor(fileName);
    await put(await getAccessToken(), objectName, contentType, bytes);
    log('INFO', `uploadOne: uploaded ${fileName} (${bytes.length} B) to gs://${bucket}/${objectName}`);
    return { name: fileName, size: bytes.length, gcsPath: objectName, contentType, sha256: sha256(bytes) };
  }

  /**
   * Uploads local files as a mission's downloads. Best effort, file by file: a missing file, a
   * directory, a credential, an oversized file or a failed upload is logged and skipped, and the
   * rest still go. Two files with the same name in one call get distinct names.
   *
   * @param {string} missionId
   * @param {string[]} absPaths - absolute paths of local files
   * @returns {Promise<Array<{name: string, size: number, gcsPath: string, contentType: string, sha256: string}>>}
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
        const file = inspect(raw);
        if (file.refused === 'missing') { log('WARN', `uploadOutgoing: missing ${raw}`); continue; }
        if (file.refused === 'credential') { log('WARN', `uploadOutgoing: denied credential path ${raw}`); continue; }
        if (file.refused === 'directory' || file.refused === 'not_file') { log('WARN', `uploadOutgoing: skipping directory or special file ${raw}`); continue; }
        if (file.refused === 'too_large') { log('WARN', `uploadOutgoing: ${raw} exceeds ${maxBytes} bytes, skipping`); continue; }

        const bytes = readFileSync(file.abs);
        const name = uniqueName(sanitizeFileName(file.abs), used);
        const objectName = outgoingObjectName(prefix, missionId, name);
        const contentType = contentTypeFor(name);
        await put(token, objectName, contentType, bytes);

        used.add(name);
        log('INFO', `uploadOutgoing: uploaded ${name} (${bytes.length} B) to gs://${bucket}/${objectName}`);
        results.push({ name, size: bytes.length, gcsPath: objectName, contentType, sha256: sha256(bytes) });
      } catch (err) {
        log('ERROR', `uploadOutgoing: failed ${raw}: ${err.message}`);
      }
    }
    return results;
  }

  return { uploadOne, uploadOutgoing };
}
