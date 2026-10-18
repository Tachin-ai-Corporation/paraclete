// agent/storage/file-names.mjs: how files going out and coming in are named in the instance's bucket,
// and the content type each is served with. A mission's outgoing files are <prefix>out/<missionId>/<name>;
// uploaded files are <prefix>in/<uploadId>/<name>. Pure string functions with no file system access,
// so the dashboard can import them without its bundler tracing the disk. Moving the bytes is
// file-store.mjs's, which re-exports everything here for the agent's callers.

import { extname } from 'node:path';

const MAX_NAME_LENGTH = 200;

/** The content type a download is served with, by extension. */
export const CONTENT_TYPES = Object.freeze({
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
  '.xml': 'application/xml',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.rtf': 'application/rtf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.doc': 'application/msword',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
});

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

/**
 * An id as one path segment: anything but letters, digits, '_' and '-' becomes '_'.
 *
 * @param {string} id
 * @param {string} what how an error names it
 * @returns {string}
 * @throws {Error} when the id is empty
 */
export function idSegment(id, what) {
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
