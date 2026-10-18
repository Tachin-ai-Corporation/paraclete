// dashboard/lib/server/files.mjs: the files in the instance's bucket, as the dashboard serves them.
// Two kinds live there (agent/storage/file-names.mjs names them):
//   - a mission's outgoing files, <files.prefix>out/<mission>/<name>, which the agent hands back and
//     records in the `files` collection ('out' records, with the mission's id);
//   - files people uploaded, <files.prefix>in/<upload>/<name> (uploads.mjs), recorded as 'in' records.
// Every dashboard user may download either. A download is a redirect to a Cloud Storage V4 signed URL
// (signed-urls.mjs) that makes the bucket answer with the file as an attachment, under its own name
// and type, so the bytes never pass through Cloud Run. Nothing else in the bucket can be fetched.
//
// It also lists a mission's files from their 'out' records, and reads and deletes objects through the
// Cloud Storage JSON API with the dashboard's own token, for uploads.mjs. It does not take uploads.

import { STORAGE_HOST } from '../../../agent/storage/hosts.mjs';
import { contentTypeFor } from '../../../agent/storage/file-names.mjs';
import { StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { HttpError } from './errors.mjs';
import { checkDocId } from './approvals.mjs';
import { signedDownloadUrl } from './signed-urls.mjs';

/** Cloud Storage refuses object names over 1024 bytes. */
const MAX_NAME_BYTES = 1024;
/** How long one metadata call to the bucket may take. */
const STORAGE_TIMEOUT_MS = 30_000;
/** A mission's 'out' records read at most; a re-shared name overwrites its record, so this is files, not versions. */
const MISSION_FILES_LIMIT = 300;

/** The contracts' files.prefix with a trailing `/`, e.g. `files/`. */
function filesPrefix(runtime) {
  const prefix = String(runtime.contracts.files?.prefix ?? '');
  return prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
}

/**
 * Where outgoing files live: the contracts' files.prefix plus `out/`, e.g. `files/out/`.
 *
 * @param {object} runtime
 * @returns {string}
 */
export function outgoingPrefix(runtime) {
  return `${filesPrefix(runtime)}out/`;
}

/**
 * Where uploaded files live: the contracts' files.prefix plus `in/`, e.g. `files/in/`.
 *
 * @param {object} runtime
 * @returns {string}
 */
export function incomingPrefix(runtime) {
  return `${filesPrefix(runtime)}in/`;
}

/**
 * The object name a download may fetch: an outgoing file, `<prefix>out/<mission>/<name>`, or an
 * uploaded one, `<prefix>in/<upload>/<name>`. Refuses anything else with a 400 (not a path at all:
 * empty, control characters, a backslash, an empty, `.` or `..` segment) or a 403 (a path outside
 * those two).
 *
 * @param {object}  runtime
 * @param {unknown} path   as the browser sent it
 * @returns {string} the object name
 */
export function checkDownloadPath(runtime, path) {
  const name = typeof path === 'string' ? path : '';
  if (!name) throw new HttpError(400, 'say which file to download: ?path=<the file\'s path in the bucket>');
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES || /[\u0000-\u001f\u007f\\]/.test(name)) {
    throw new HttpError(400, 'that is not a file path');
  }
  if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new HttpError(400, 'a file path may not have empty, "." or ".." parts');
  }
  const allowed = [outgoingPrefix(runtime), incomingPrefix(runtime)]
    .some((prefix) => name.startsWith(prefix) && name.slice(prefix.length).split('/').length >= 2);
  if (!allowed) {
    throw new HttpError(403, `only the files the agent hands back (${outgoingPrefix(runtime)}<mission>/<name>) and the files people upload (${incomingPrefix(runtime)}<upload>/<name>) can be downloaded`);
  }
  return name;
}

/**
 * Whether a path is one checkDownloadPath accepts. Never throws.
 *
 * @param {object}  runtime
 * @param {unknown} path
 * @returns {boolean}
 */
export function isDownloadablePath(runtime, path) {
  try {
    checkDownloadPath(runtime, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A Content-Disposition header that makes the browser save the file under its own name: a plain
 * ASCII `filename` for old clients and the exact name as UTF-8 in `filename*`.
 *
 * @param {string} fileName
 * @returns {string}
 */
export function attachmentDisposition(fileName) {
  const ascii = String(fileName).replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  const exact = encodeURIComponent(String(fileName)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

/**
 * The type a file is served with: the agent's own table for its extension (the type it was uploaded
 * with), else what the bucket says. Text is UTF-8, which is what the agent writes.
 *
 * @param {string} fileName
 * @param {string|null} stored  the object's content type in the bucket
 * @returns {string}
 */
export function servedType(fileName, stored) {
  let type = contentTypeFor(fileName);
  if (type === 'application/octet-stream' && stored) type = stored;
  return type.startsWith('text/') && !/charset=/i.test(type) ? `${type}; charset=utf-8` : type;
}

/** The JSON API URL of one object in the runtime's bucket. */
function objectUrl(runtime, name) {
  const host = (runtime.settings.storageHost || STORAGE_HOST).replace(/\/+$/, '');
  return `${host}/storage/v1/b/${encodeURIComponent(runtime.settings.bucket)}/o/${encodeURIComponent(name)}`;
}

function requireBucket(runtime) {
  if (!runtime.settings.bucket) throw new HttpError(503, 'the dashboard does not know its bucket (PARACLETE_BUCKET)');
}

/**
 * One object's metadata, or null when it is not in the bucket. Any other failure is a 502 whose
 * details only the log gets.
 *
 * @param {object} runtime
 * @param {string} name  the object name
 * @returns {Promise<{name: string, size: number, content_type: string|null, md5: string|null}|null>}
 */
export async function objectMetadata(runtime, name) {
  requireBucket(runtime);
  const response = await runtime.fetch(objectUrl(runtime, name), {
    headers: { Authorization: `Bearer ${await runtime.getAccessToken()}` },
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    runtime.log('ERROR', `reading gs://${runtime.settings.bucket}/${name} failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
    throw new HttpError(502, `the bucket could not be read (HTTP ${response.status}); the details are in the dashboard's log`);
  }
  const object = await response.json();
  return {
    name: object.name,
    size: Number(object.size) || 0,
    content_type: typeof object.contentType === 'string' ? object.contentType : null,
    md5: typeof object.md5Hash === 'string' ? object.md5Hash : null,
  };
}

/**
 * Deletes one object; false (logged) when the bucket refused. A missing object counts as deleted.
 *
 * @param {object} runtime
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function deleteObject(runtime, name) {
  requireBucket(runtime);
  try {
    const response = await runtime.fetch(objectUrl(runtime, name), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await runtime.getAccessToken()}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (response.ok || response.status === 404) return true;
    runtime.log('WARN', `deleting gs://${runtime.settings.bucket}/${name} failed: HTTP ${response.status}`);
  } catch (err) {
    runtime.log('WARN', `deleting gs://${runtime.settings.bucket}/${name} failed: ${err.message}`);
  }
  return false;
}

/**
 * Answers a download with a redirect to a signed URL for the file, valid files.signed_url_minutes.
 * The file must be in the bucket: a missing one is a 404 here rather than the bucket's own error page.
 *
 * @param {object}  runtime
 * @param {object}  o
 * @param {unknown} o.path   the object name, e.g. files/out/w-123/report.docx
 * @param {Date}    [o.now]
 * @param {Function} [o.sign] tests pass their own signBlob
 * @returns {Promise<Response>} a 302
 */
export async function downloadRedirect(runtime, { path, now = new Date(), sign }) {
  const name = checkDownloadPath(runtime, path);
  const object = await objectMetadata(runtime, name);
  if (!object) throw new HttpError(404, 'that file is not in the bucket any more');
  const fileName = name.split('/').pop();
  const { url } = await signedDownloadUrl(runtime, {
    object: name,
    disposition: attachmentDisposition(fileName),
    contentType: servedType(fileName, object.content_type),
    now,
    ...(sign ? { sign } : {}),
  });
  return new Response(null, {
    status: 302,
    headers: { Location: url, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

const instant = (value) => Date.parse(value || '') || 0;

/** A Drive link the agent recorded, if it is one. */
function driveLinkOf(drive) {
  const link = drive && typeof drive === 'object' ? drive.link : null;
  return typeof link === 'string' && /^https:\/\//.test(link) ? link : null;
}

/**
 * The files a mission handed back: its 'out' records in `files`, newest first. One equality filter,
 * ordered here, so no composite index is needed.
 *
 * @param {object} runtime
 * @param {string} id  the mission's id
 * @returns {Promise<{mission_id: string, files: Array<{id: string, name: string, size: number,
 *   content_type: string|null, created_at: string|null, source: string|null, gcs_path: string,
 *   downloadable: boolean, drive_link: string|null}>}>}
 */
export async function listMissionFiles(runtime, id) {
  const missionId = checkDocId(id, 'work id');
  let rows;
  try {
    rows = await runtime.db.query('', runtime.collections.files, [
      { field: 'mission_id', op: 'EQUAL', value: { stringValue: missionId } },
    ], { noOrderBy: true, limit: MISSION_FILES_LIMIT, strict: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailable)) throw err;
    runtime.log('WARN', `files of ${missionId}: ${err.message}`);
    throw new HttpError(503, 'the dashboard could not read its database just now; try again in a moment');
  }
  const files = rows
    .filter((row) => row.direction === 'out' && typeof row.gcs_path === 'string')
    .sort((a, b) => instant(b.created_at) - instant(a.created_at) || String(a.name).localeCompare(String(b.name)))
    .map((row) => ({
      id: row.id,
      name: String(row.name || row.gcs_path.split('/').pop()),
      size: Number(row.size) || 0,
      content_type: typeof row.content_type === 'string' ? row.content_type : null,
      created_at: typeof row.created_at === 'string' ? row.created_at : null,
      source: typeof row.source === 'string' ? row.source : null,
      gcs_path: row.gcs_path,
      downloadable: isDownloadablePath(runtime, row.gcs_path),
      drive_link: driveLinkOf(row.drive),
    }));
  return { mission_id: missionId, files };
}
