// dashboard/lib/server/uploads.mjs: files people give the agent from the dashboard. An upload goes in
// three steps, so the bytes go from the browser straight to the bucket and never through Cloud Run
// (whose requests stop at 32 MB):
//   1. startUpload: the browser says what it is about to send (name, size, type). The size is checked
//      against files.max_upload_mb, the upload gets an id (`u-<ms>-<8 hex>`) and an object name
//      (`files/in/<id>/<sanitized name>`, agent/storage/file-names.mjs), and the answer carries a
//      signed PUT URL for exactly that object and type (signed-urls.mjs).
//   2. The browser PUTs the bytes to that URL. The bucket's CORS setting (install/install.sh) lets the
//      dashboard's origin do so.
//   3. completeUpload: the server checks the object arrived, at an allowed size, and writes its 'in'
//      record in `files` (created_by the person, expiring with the bucket's inbox lifecycle rule after
//      files.inbox_retention_days). The answer is the attachment a message carries: { name, size, gcsPath }.
//
// A message then carries completed uploads (claimUploads, called by chat.mjs): only the sender's own,
// each once. The agent takes them from there (agent/services/ears/, the files skill's file-get).

import { randomBytes } from 'node:crypto';
import { StoreConflict } from '../../../agent/storage/firestore.mjs';
import { contentTypeFor, incomingObjectName, sanitizeFileName } from '../../../agent/storage/file-names.mjs';
import { HttpError } from './errors.mjs';
import { deleteObject, incomingPrefix, objectMetadata } from './files.mjs';
import { signedUploadUrl } from './signed-urls.mjs';

/** An upload id: `u-`, milliseconds since the epoch, `-`, 8 lowercase hex digits. */
export const UPLOAD_ID = /^u-\d{1,16}-[0-9a-f]{8}$/;

/** The most files one message carries. */
export const MAX_ATTACHMENTS = 10;

const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;
/** A media type as `type/subtype`, lowercase, without parameters. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * A new upload id.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function newUploadId(now = new Date()) {
  return `u-${now.getTime()}-${randomBytes(4).toString('hex')}`;
}

/**
 * The largest upload in bytes: the contracts' files.max_upload_mb, in MiB.
 *
 * @param {object} runtime
 * @returns {number}
 */
export function maxUploadBytes(runtime) {
  const mb = Number(runtime.contracts.files?.max_upload_mb);
  if (!Number.isFinite(mb) || mb <= 0) throw new Error('contracts files.max_upload_mb must be a positive number');
  return Math.floor(mb * MIB);
}

const megabytes = (bytes) => `${(bytes / MIB).toFixed(bytes < 10 * MIB ? 1 : 0)} MB`;

/**
 * The type an upload is stored with: the agent's own table for its extension (the type the agent
 * serves it with), else the type the browser reported, else application/octet-stream. Parameters are
 * dropped and the type is lowercase, so the header the browser must send matches the signed one exactly.
 *
 * @param {string}  name
 * @param {unknown} declared  the browser's File.type
 * @returns {string}
 */
export function uploadContentType(name, declared) {
  const known = contentTypeFor(name);
  if (known !== 'application/octet-stream') return known;
  const type = typeof declared === 'string' ? declared.split(';')[0].trim().toLowerCase() : '';
  return MEDIA_TYPE.test(type) ? type : 'application/octet-stream';
}

/** An upload id from the browser, or a 400. */
export function checkUploadId(id) {
  const value = String(id ?? '');
  if (!UPLOAD_ID.test(value)) throw new HttpError(400, `'${value.slice(0, 80)}' is not an upload id`);
  return value;
}

/** The attachment a message carries for a record: { name, size, gcsPath }. */
function attachmentOf(record) {
  return { name: record.name, size: Number(record.size) || 0, gcsPath: record.gcs_path };
}

/**
 * Starts an upload: checks the size and answers where to PUT the bytes. Writes nothing; the record
 * comes with completeUpload.
 *
 * @param {object}  runtime
 * @param {object}  o
 * @param {{email: string}} o.user
 * @param {unknown} o.name          the file's name as the browser has it
 * @param {unknown} o.size          bytes
 * @param {unknown} [o.content_type] the browser's File.type
 * @param {Date}    [o.now]
 * @param {Function} [o.sign]       tests pass their own signBlob
 * @returns {Promise<{upload_id: string, name: string, size: number, gcs_path: string, url: string,
 *   headers: {'Content-Type': string}, expires_at: string}>}
 */
export async function startUpload(runtime, { user, name, size, content_type: declared, now = new Date(), sign }) {
  if (!user?.email) throw new HttpError(403, 'only a dashboard user can upload');
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, "say the file's name");
  const fileName = sanitizeFileName(name);
  const bytes = typeof size === 'number' ? size : Number.NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new HttpError(400, `the size of ${fileName} must be a whole number of bytes`);
  if (bytes === 0) throw new HttpError(400, `${fileName} is empty`);
  const max = maxUploadBytes(runtime);
  if (bytes > max) {
    throw new HttpError(413, `${fileName} is ${megabytes(bytes)}; the most one file may be is ${runtime.contracts.files.max_upload_mb} MB`);
  }

  const uploadId = newUploadId(now);
  const gcsPath = incomingObjectName(runtime.contracts.files.prefix, uploadId, fileName);
  const contentType = uploadContentType(fileName, declared);
  const signed = await signedUploadUrl(runtime, { object: gcsPath, contentType, now, ...(sign ? { sign } : {}) });
  return { upload_id: uploadId, name: fileName, size: bytes, gcs_path: gcsPath, url: signed.url, headers: signed.headers, expires_at: signed.expires_at };
}

/** A record found where completeUpload would write one: the same person's is answered again, anyone else's refused. */
function alreadyCompleted(record, user, gcsPath) {
  if (record?.direction === 'in' && record.created_by === user.email && record.gcs_path === gcsPath) return attachmentOf(record);
  throw new HttpError(409, 'that upload was already completed by someone else');
}

/**
 * Completes an upload: the object must be in the bucket, within the size limit; then its 'in' record
 * is written. Completing the same upload again answers the same attachment.
 *
 * @param {object}  runtime
 * @param {object}  o
 * @param {{email: string}} o.user
 * @param {unknown} o.id        the upload id, from the route
 * @param {unknown} o.gcs_path  the object name startUpload gave
 * @param {Date}    [o.now]
 * @returns {Promise<{name: string, size: number, gcsPath: string}>}
 */
export async function completeUpload(runtime, { user, id, gcs_path: path, now = new Date() }) {
  if (!user?.email) throw new HttpError(403, 'only a dashboard user can upload');
  const uploadId = checkUploadId(id);
  const prefix = `${incomingPrefix(runtime)}${uploadId}/`;
  const gcsPath = typeof path === 'string' ? path : '';
  const fileName = gcsPath.startsWith(prefix) ? gcsPath.slice(prefix.length) : '';
  if (!fileName || fileName.includes('/') || sanitizeFileName(fileName) !== fileName) {
    throw new HttpError(400, `gcs_path must be the path this upload was given (${prefix}<name>)`);
  }

  const recordPath = `${runtime.collections.files}/${uploadId}`;
  const existing = await runtime.db.read(recordPath, { strict: true });
  if (existing) return alreadyCompleted(existing, user, gcsPath);

  const object = await objectMetadata(runtime, gcsPath);
  if (!object) throw new HttpError(409, `${fileName} is not in the bucket: its upload did not finish`);
  if (object.size > maxUploadBytes(runtime)) {
    await deleteObject(runtime, gcsPath);
    throw new HttpError(413, `${fileName} is ${megabytes(object.size)}; the most one file may be is ${runtime.contracts.files.max_upload_mb} MB`);
  }

  const days = Number(runtime.contracts.files?.inbox_retention_days);
  const record = {
    direction: 'in',
    mission_id: null,
    name: fileName,
    size: object.size,
    content_type: object.content_type || uploadContentType(fileName, null),
    gcs_path: gcsPath,
    sha256: null,
    source: 'upload',
    created_at: now.toISOString(),
    created_by: user.email,
    drive: null,
    expires_at: Number.isFinite(days) && days > 0 ? new Date(now.getTime() + days * DAY_MS).toISOString() : null,
    // The dashboard message that carried it, once one has (claimUploads).
    message_id: null,
  };
  try {
    await runtime.db.commit([{ path: recordPath, data: record, precondition: { exists: false } }]);
  } catch (err) {
    if (!(err instanceof StoreConflict)) throw err;
    // The same upload completed at the same moment, by a retried request.
    return alreadyCompleted(await runtime.db.read(recordPath, { strict: true }), user, gcsPath);
  }
  return attachmentOf(record);
}

/**
 * Checks the uploads a message is to carry and prepares marking them used by it. Each must be an
 * 'in' record this person completed, under files/in/, not expired, not yet sent in a message and not
 * yet taken by a mission. The attachments come from the records, never from the browser's copy.
 *
 * The marks are whole-document writes with the version each record was read at (an updateTime
 * precondition), for the caller to commit together with the message: two messages sending the same
 * file at once cannot both succeed. The records are rewritten exactly as read, plus `message_id`; the
 * dashboard wrote them with plain values only (ISO strings for times), which read back unchanged.
 *
 * @param {object}  runtime
 * @param {object}  o
 * @param {{email: string}} o.user
 * @param {unknown} o.attachments  the browser's list: [{ gcsPath }, ...] as completeUpload answered
 * @param {string}  o.messageId    the message about to carry them
 * @param {Date}    [o.now]
 * @returns {Promise<{attachments: Array<{name: string, size: number, gcsPath: string}>, writes: object[]}>}
 */
export async function claimUploads(runtime, { user, attachments, messageId, now = new Date() }) {
  if (attachments === undefined || attachments === null) return { attachments: [], writes: [] };
  if (!Array.isArray(attachments)) throw new HttpError(400, 'attachments must be a list of uploaded files');
  if (attachments.length > MAX_ATTACHMENTS) throw new HttpError(400, `a message carries at most ${MAX_ATTACHMENTS} files`);
  const paths = attachments.map((item) => (item && typeof item === 'object' && typeof item.gcsPath === 'string' ? item.gcsPath : null));
  if (paths.some((path) => !path)) throw new HttpError(400, 'each attachment must be an uploaded file: { gcsPath }');
  if (new Set(paths).size !== paths.length) throw new HttpError(400, 'the same file is attached twice');

  const prefix = incomingPrefix(runtime);
  const claimed = [];
  const writes = [];
  for (const gcsPath of paths) {
    const shown = gcsPath.split('/').pop().slice(0, 200) || gcsPath.slice(0, 200);
    const uploadId = gcsPath.startsWith(prefix) ? gcsPath.slice(prefix.length).split('/')[0] : '';
    if (!UPLOAD_ID.test(uploadId)) throw new HttpError(400, `${shown} is not a file uploaded to the dashboard`);
    const recordPath = `${runtime.collections.files}/${uploadId}`;
    const doc = await runtime.db.readDoc(recordPath);
    const record = doc?.data;
    if (!record || record.direction !== 'in' || record.gcs_path !== gcsPath) {
      throw new HttpError(400, `${shown} has not finished uploading`);
    }
    if (record.created_by !== user.email) throw new HttpError(403, `${shown} was uploaded by someone else`);
    if (record.message_id || record.mission_id) {
      throw new HttpError(409, `${shown} was already sent; upload it again to send it in another message`);
    }
    if (record.expires_at && Date.parse(record.expires_at) <= now.getTime()) {
      throw new HttpError(410, `${shown} has expired from the dashboard's inbox; upload it again`);
    }
    claimed.push(attachmentOf(record));
    writes.push({ path: recordPath, data: { ...record, message_id: messageId }, precondition: { updateTime: doc.updateTime } });
  }
  return { attachments: claimed, writes };
}
