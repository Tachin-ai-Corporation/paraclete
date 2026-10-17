// dashboard/lib/server/files.mjs: downloading the files the agent hands back. A mission's outgoing
// files sit in the instance's bucket under <files.prefix>out/<mission>/<name> (agent/storage/
// file-store.mjs writes them, and the agent's chat messages carry their object names as `gcsPath`).
// The dashboard streams one to the browser with its own service account's token, through the Cloud
// Storage JSON API, as an attachment with the type the agent uploaded it as. Every dashboard user may
// download; only outgoing files can be fetched this way, never anything else in the bucket.
//
// It does not list a mission's files (the work views do) or take uploads: build plan phase 7 adds
// uploads and moves downloads to signed URLs.

import { STORAGE_HOST } from '../../../agent/storage/hosts.mjs';
import { contentTypeFor } from '../../../agent/storage/file-store.mjs';
import { HttpError } from './errors.mjs';

/** Cloud Storage refuses object names over 1024 bytes. */
const MAX_NAME_BYTES = 1024;
/** How long the bucket may take to start answering; the bytes themselves may take longer. */
const HEADERS_TIMEOUT_MS = 30_000;

/**
 * Where outgoing files live: the contracts' files.prefix plus `out/`, e.g. `files/out/`.
 *
 * @param {object} runtime
 * @returns {string}
 */
export function outgoingPrefix(runtime) {
  const prefix = String(runtime.contracts.files?.prefix ?? '');
  return `${prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix}out/`;
}

/**
 * The object name a download may fetch: an outgoing file, `<prefix>out/<mission>/<name>`. Refuses
 * anything else with a 400 (not a path at all: empty, control characters, a backslash, an empty, `.`
 * or `..` segment) or a 403 (a path outside the outgoing files).
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
  const prefix = outgoingPrefix(runtime);
  if (!name.startsWith(prefix) || name.slice(prefix.length).split('/').length < 2) {
    throw new HttpError(403, `only the files the agent hands back (${prefix}<mission>/<name>) can be downloaded`);
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
 */
function servedType(fileName, stored) {
  let type = contentTypeFor(fileName);
  if (type === 'application/octet-stream' && stored) type = stored;
  return type.startsWith('text/') && !/charset=/i.test(type) ? `${type}; charset=utf-8` : type;
}

/**
 * Streams one outgoing file from the instance's bucket.
 *
 * @param {object}  runtime
 * @param {object}  o
 * @param {unknown} o.path            the object name, e.g. files/out/w-123/report.docx
 * @param {string}  [o.storageHost]   the Cloud Storage origin; tests point it at tests/fakes/gcs-server.mjs
 * @returns {Promise<Response>}
 */
export async function downloadFile(runtime, { path, storageHost = runtime.settings.storageHost || STORAGE_HOST }) {
  const name = checkDownloadPath(runtime, path);
  const bucket = runtime.settings.bucket;
  if (!bucket) throw new HttpError(503, 'the dashboard does not know its bucket (PARACLETE_BUCKET)');

  const token = await runtime.getAccessToken();
  const url = `${storageHost.replace(/\/+$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await runtime.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 404) throw new HttpError(404, 'that file is not in the bucket any more');
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    runtime.log('ERROR', `download of gs://${bucket}/${name} failed: HTTP ${upstream.status} ${detail.slice(0, 200)}`);
    throw new HttpError(502, `the bucket could not be read (HTTP ${upstream.status}); the details are in the dashboard's log`);
  }

  const fileName = name.split('/').pop();
  const headers = {
    'Content-Type': servedType(fileName, upstream.headers.get('content-type')),
    'Content-Disposition': attachmentDisposition(fileName),
    'Cache-Control': 'private, no-store',
    // Never rendered as a page of the dashboard, whatever it holds (HTML, SVG).
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.get('content-encoding')) headers['Content-Length'] = length;
  return new Response(upstream.body, { status: 200, headers });
}
