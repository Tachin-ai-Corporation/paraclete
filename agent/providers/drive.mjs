// agent/providers/drive.mjs: a Google Drive API v3 client for the agent, over plain REST (fetch, no npm
// packages). It acts as one of two identities, chosen from the instance record: the agent's own
// Workspace account when the role has one (instance.workspace.account, a token from
// agent/auth/dwd-token.mjs through domain-wide delegation with the Drive scope), otherwise the VM's
// service account (agent/auth/metadata-token.mjs asks the metadata server for the default account's
// token without naming scopes, so the token carries the scopes the VM was created with; the installer
// creates it with cloud-platform and drive). It finds, downloads and exports files, creates new ones,
// lists shared drives, reads Drive links, and turns Google's errors into plain sentences that say what
// to do.
//
// The agent reads Drive and adds to it; it never edits, moves, renames, trashes or deletes a file it
// did not just create. So this client has no update or move: the one removal it offers, remove(), is
// for drive_check's own test file.
//
// Every files call sends supportsAllDrives=true, and every file list includeItemsFromAllDrives=true,
// so shared drives work like My Drive. about.get, drives.list and files.export document neither
// parameter, so they are not sent there.
//
// It does not decide where a file lands on the VM or in Drive: the drive skill's commands
// (skills/drive/), the files skill and control's drive_check (agent/services/control/drive-check.mjs)
// call it with their own choices.

import { randomBytes } from 'node:crypto';
import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';
import { createDwdTokenSource } from '../auth/dwd-token.mjs';

/** The scope every Drive call needs. The VM is created with it; a Workspace grant must include it. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** The Drive API origin. The instance record's `endpoints.drive` overrides it (tests, development). */
export const DRIVE_HOST = 'https://www.googleapis.com';

/**
 * The agent's service account name. config/instance.mjs (agentIdentity) owns it; providers may not
 * read config/, so this copy is pinned to it by tests/agent/providers/drive.test.mjs.
 */
const AGENT_SERVICE_ACCOUNT = 'paraclete-agent';

const REQUEST_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 300_000;
/** Google's limit for a one-request (multipart or media) upload; anything larger goes resumable. */
const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Google's own limit on what files.export returns. */
const EXPORT_LIMIT_MB = 10;
const MAX_PAGE_SIZE = 1000;
const MAX_DRIVE_PAGES = 10;

const GOOGLE_PREFIX = 'application/vnd.google-apps.';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** The Google-native types the agent exports and converts to. */
export const GOOGLE_TYPES = Object.freeze({
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
});

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PDF = 'application/pdf';

/** What each Google-native type exports to: format name (also the file extension) to MIME type. */
export const EXPORT_FORMATS = Object.freeze({
  [GOOGLE_TYPES.document]: Object.freeze({ docx: DOCX, pdf: PDF, md: 'text/markdown', txt: 'text/plain' }),
  [GOOGLE_TYPES.spreadsheet]: Object.freeze({ xlsx: XLSX, csv: 'text/csv', pdf: PDF }),
  [GOOGLE_TYPES.presentation]: Object.freeze({ pptx: PPTX, pdf: PDF, txt: 'text/plain' }),
});

/** What `create({ convertTo })` turns an upload into. */
export const CONVERT_TARGETS = Object.freeze({
  doc: GOOGLE_TYPES.document,
  sheet: GOOGLE_TYPES.spreadsheet,
  slides: GOOGLE_TYPES.presentation,
});

/** The upload types Drive imports into each Google-native type. */
const IMPORTS = Object.freeze({
  doc: [DOCX, 'application/msword', 'application/vnd.oasis.opendocument.text', 'application/rtf', 'text/plain', 'text/markdown', 'text/html'],
  sheet: [XLSX, 'application/vnd.ms-excel', 'application/vnd.oasis.opendocument.spreadsheet', 'text/csv', 'text/tab-separated-values'],
  slides: [PPTX, 'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.presentation'],
});

const TYPE_NAMES = Object.freeze({
  [GOOGLE_TYPES.document]: 'Google Doc',
  [GOOGLE_TYPES.spreadsheet]: 'Google Sheet',
  [GOOGLE_TYPES.presentation]: 'Google Slides',
  [FOLDER_MIME]: 'folder',
  [SHORTCUT_MIME]: 'shortcut',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.drawing': 'Google Drawing',
});

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,owners(displayName,emailAddress),parents,driveId,webViewLink,shortcutDetails(targetId,targetMimeType)';
const META_FIELDS = `${FILE_FIELDS},capabilities(canDownload,canEdit,canAddChildren,canDelete,canTrash,canCopy)`;

/** Whether a MIME type is a Google-native file (Doc, Sheet, Slides, folder, ...), which has no bytes of its own. */
export function isGoogleNative(mimeType) {
  return String(mimeType || '').startsWith(GOOGLE_PREFIX);
}

/** A short human name for a MIME type: "Google Doc", "folder", or the type itself. */
export function describeType(mimeType) {
  return TYPE_NAMES[mimeType] || mimeType || 'unknown type';
}

/**
 * The MIME type to export a Google-native file as, or null when that type has no such format.
 *
 * @param {string} googleMimeType e.g. application/vnd.google-apps.document
 * @param {string} format e.g. docx, pdf, md
 * @returns {string|null}
 */
export function exportMimeType(googleMimeType, format) {
  return EXPORT_FORMATS[googleMimeType]?.[String(format || '').toLowerCase()] ?? null;
}

/**
 * Which Google-native type an upload of this MIME type can become, or null.
 *
 * @param {string} mimeType
 * @returns {'doc'|'sheet'|'slides'|null}
 */
export function conversionFor(mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  for (const [target, sources] of Object.entries(IMPORTS)) if (sources.includes(type)) return target;
  return null;
}

/**
 * A string as a literal inside a Drive query: backslashes and single quotes escaped. Pure.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeQueryValue(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const ID_IN_URL = /^[A-Za-z0-9_-]{10,}$/;
/** A bare id must be at least as long as the shortest Drive ids (a shared drive's, 19 characters). */
const BARE_ID = /^[A-Za-z0-9_-]{19,}$/;

/**
 * The file or folder id in a Drive link, or a bare id. Reads Docs, Sheets and Slides links
 * (`.../d/<id>/...`), Drive file and folder links (`/file/d/<id>`, `/drive/folders/<id>`) and
 * `open?id=<id>` links, with or without a `/u/<n>/` account segment, inside other text too. A
 * published-to-web link (`/d/e/...`) names no file and reads as null. Pure.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseDriveLink(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const link = /https?:\/\/[^\s<>"'()[\]]+/i.exec(s)?.[0];
  if (link) {
    let url;
    try {
      url = new URL(link);
    } catch {
      return null;
    }
    if (!/(^|\.)google\.com$/i.test(url.hostname)) return null;
    if (/\/d\/e\//.test(url.pathname)) return null;
    const inPath = /\/(?:d|folders)\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
    if (inPath) return inPath[1];
    const id = url.searchParams.get('id');
    return id && ID_IN_URL.test(id) ? id : null;
  }
  return BARE_ID.test(s) ? s : null;
}

/**
 * A Drive failure, in plain words. `kind` is one of: not_found, permission, download_blocked,
 * domain_policy, storage_quota, export_too_large, api_disabled, scope, auth, rate_limit, bad_request,
 * unavailable, token, google_native, not_a_file, too_large. `status` is the HTTP status, `reason`
 * Google's own reason code, `google` Google's message.
 */
export class DriveError extends Error {
  constructor(message, { kind, status = null, reason = null, google = null } = {}) {
    super(message);
    this.name = 'DriveError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
    this.google = google;
  }
}

/** Google's error kinds by reason code; the first reason that maps wins. */
const REASON_KINDS = Object.freeze({
  notFound: 'not_found',
  teamDriveNotFound: 'not_found',
  storageQuotaExceeded: 'storage_quota',
  teamDriveFileLimitExceeded: 'storage_quota',
  cannotDownloadFile: 'download_blocked',
  cannotDownloadAbusiveFile: 'download_blocked',
  cannotCopyFile: 'download_blocked',
  cannotExportFile: 'download_blocked',
  domainPolicy: 'domain_policy',
  shareInNotPermitted: 'domain_policy',
  shareOutNotPermitted: 'domain_policy',
  exportSizeLimitExceeded: 'export_too_large',
  accessNotConfigured: 'api_disabled',
  SERVICE_DISABLED: 'api_disabled',
  insufficientPermissions: 'scope',
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'scope',
  rateLimitExceeded: 'rate_limit',
  userRateLimitExceeded: 'rate_limit',
  sharingRateLimitExceeded: 'rate_limit',
  insufficientFilePermissions: 'permission',
  teamDriveMembershipRequired: 'permission',
  forbidden: 'permission',
  authError: 'auth',
});

function classify(status, reasons) {
  for (const reason of reasons) if (REASON_KINDS[reason]) return REASON_KINDS[reason];
  if (status === 401) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 403) return 'permission';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}

/**
 * Creates a Drive client acting as the agent's Drive identity.
 *
 * @param {object}   options
 * @param {object}   options.instance          the instance record (config/instance.mjs loadInstance)
 * @param {Function} [options.getAccessToken]  the VM's token source (default: the metadata server)
 * @param {Function} [options.getDwdToken]     the Workspace token source (default: one built over
 *                                             getAccessToken, fetch and now)
 * @param {Function} [options.fetch]
 * @param {Function} [options.now]             clock in milliseconds, for the Workspace token cache
 * @param {string}   [options.driveHost]       API origin; default instance.endpoints.drive, else Google's
 */
export function createDriveClient({
  instance,
  getAccessToken = getVmAccessToken,
  getDwdToken,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  driveHost,
} = {}) {
  const account = instance?.workspace?.account || null;
  if (!account && !instance?.project) throw new Error('createDriveClient: instance.project is required');
  const who = Object.freeze(account
    ? { kind: 'workspace', email: account }
    : { kind: 'service_account', email: `${AGENT_SERVICE_ACCOUNT}@${instance.project}.iam.gserviceaccount.com` });
  const host = String(driveHost || instance?.endpoints?.drive || DRIVE_HOST).replace(/\/+$/, '');
  const dwdToken = getDwdToken || createDwdTokenSource({ fetch: fetchImpl, now, getVmAccessToken: getAccessToken });

  async function token() {
    try {
      if (who.kind === 'service_account') return await getAccessToken();
      return await dwdToken({ signerServiceAccount: instance.workspace.signer, subjectEmail: account, scopes: [DRIVE_SCOPE] });
    } catch (err) {
      const fix = who.kind === 'workspace'
        ? ` Check the domain-wide delegation grant for the agent's account in the Admin console: it must include ${DRIVE_SCOPE}.`
        : '';
      throw new DriveError(`Cannot get a Drive token for ${who.email}: ${String(err?.message || err).replace(/\.$/, '')}.${fix}`, { kind: 'token' });
    }
  }

  /** The plain-words error for a failed response. `what` names the file or folder the call was about. */
  async function errorFrom(response, { what, action = 'read', format } = {}) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const err = body?.error || {};
    const google = typeof err.message === 'string' && err.message ? err.message : null;
    const reasons = [
      ...(Array.isArray(err.errors) ? err.errors.map((e) => e?.reason) : []),
      ...(Array.isArray(err.details) ? err.details.map((d) => d?.reason) : []),
    ].filter(Boolean);
    const kind = classify(response.status, reasons);
    const subject = what || 'the file';
    const email = who.email;
    const writing = action !== 'read';
    let message;
    switch (kind) {
      case 'not_found':
        message = `Drive has no ${subject} that ${email} can see: it does not exist, or it is not shared with ${email}. Ask its owner to share it with ${email}.`;
        break;
      case 'permission':
        message = writing
          ? `${email} is not allowed to ${action} ${subject}: it needs Editor access (Content manager in a shared drive).`
          : `${email} is not allowed to read ${subject}. Ask its owner to share it with ${email}.`;
        break;
      case 'download_blocked':
        message = `The owner of ${subject} has turned off downloading, printing and copying for viewers and commenters, so ${email} cannot download or export it. Ask the owner for Editor access, or to allow downloads.`;
        break;
      case 'domain_policy':
        message = `The organization's Drive policy does not allow ${email} to do this.`;
        break;
      case 'storage_quota':
        message = who.kind === 'service_account'
          ? `${email} is a service account and has no Drive storage of its own, so it cannot create files in My Drive or in a folder that lives in someone's My Drive. Create the file inside a shared drive that ${email} is a member of (as Content manager).`
          : `The Drive storage of ${email} is full. Free some space, or create the file in a shared drive.`;
        break;
      case 'export_too_large':
        message = `Google exports at most ${EXPORT_LIMIT_MB} MB per file, and ${subject} is larger${format ? ` as ${format}` : ''}. Try another format (pdf is often smaller), or ask the owner to split the file.`;
        break;
      case 'api_disabled':
        message = 'The Google Drive API is turned off in this project. Turn it on (APIs & Services, Google Drive API); the installer normally does this.';
        break;
      case 'scope':
        message = who.kind === 'service_account'
          ? `The token for ${email} lacks the Drive scope. The VM must run with the ${DRIVE_SCOPE} scope, which the installer sets; re-run the installer to repair the VM.`
          : `The domain-wide delegation grant for ${email} lacks the Drive scope. Add ${DRIVE_SCOPE} to the grant in the Admin console.`;
        break;
      case 'auth':
        message = `Google refused the credentials of ${email}.`;
        break;
      case 'rate_limit':
        message = `Drive is limiting requests from ${email}. Wait a minute, then try again.`;
        break;
      case 'unavailable':
        message = `Drive failed to answer (HTTP ${response.status}). Try again in a minute.`;
        break;
      default:
        message = `Drive refused the request (HTTP ${response.status}).`;
    }
    return new DriveError(google ? `${message} (Google: ${google})` : message, {
      kind, status: response.status, reason: reasons[0] || null, google,
    });
  }

  /**
   * One Drive call. `allDrives` adds supportsAllDrives=true; `expect` is json, bytes or response.
   */
  async function call(method, path, {
    query = {}, body, headers = {}, upload = false, allDrives = true, expect = 'json', timeoutMs = REQUEST_TIMEOUT_MS, about = {}, url: fullUrl,
  } = {}) {
    let url = fullUrl;
    if (!url) {
      const u = new URL(`${host}${upload ? '/upload' : ''}/drive/v3${path}`);
      if (allDrives) u.searchParams.set('supportsAllDrives', 'true');
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') u.searchParams.set(key, String(value));
      }
      url = u.toString();
    }
    const bearer = await token();
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, ...headers },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DriveError(`Drive could not be reached: ${err.message}. Try again in a minute.`, { kind: 'unavailable' });
    }
    if (!response.ok) throw await errorFrom(response, about);
    if (expect === 'response') return response;
    if (expect === 'bytes') return Buffer.from(await response.arrayBuffer());
    if (response.status === 204) return null;
    return response.json();
  }

  const fileId = (id, what = 'file id') => {
    const s = String(id ?? '').trim();
    if (!ID_IN_URL.test(s)) throw new DriveError(`'${s}' is not a Drive ${what}: pass a Drive link or id`, { kind: 'bad_request' });
    return s;
  };
  const fileWord = (id, name) => (name ? `"${name}" (${id})` : `file ${id}`);

  /** A file resource with size as a number (Drive sends it as a string), or null when it has none. */
  const normalize = (f) => (f ? { ...f, size: f.size !== undefined && f.size !== null ? Number(f.size) : null } : f);

  /** Uploads a new file in one request (≤ 5 MB) or a resumable session (larger). Returns the file resource. */
  async function upload({ metadata, bytes, mimeType, about }) {
    const data = Buffer.from(bytes);
    const type = mimeType || 'application/octet-stream';
    const method = 'POST';
    const path = '/files';
    if (data.length <= SIMPLE_UPLOAD_MAX_BYTES) {
      const boundary = `paraclete-${randomBytes(12).toString('hex')}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return call(method, path, {
        upload: true, query: { uploadType: 'multipart', fields: META_FIELDS }, body,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, timeoutMs: TRANSFER_TIMEOUT_MS, about,
      });
    }
    const session = await call(method, path, {
      upload: true, query: { uploadType: 'resumable', fields: META_FIELDS }, body: JSON.stringify(metadata),
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(data.length) },
      expect: 'response', about,
    });
    const location = session.headers.get('location');
    if (!location || !location.startsWith(`${host}/`)) {
      throw new DriveError('Drive started an upload but returned no upload address on its own host. Try again.', { kind: 'unavailable' });
    }
    return call('PUT', null, {
      url: location, body: data, headers: { 'Content-Type': type }, timeoutMs: TRANSFER_TIMEOUT_MS, about,
    });
  }

  async function getMeta(id) {
    const fid = fileId(id);
    return normalize(await call('GET', `/files/${encodeURIComponent(fid)}`, { query: { fields: META_FIELDS }, about: { what: `file ${fid}` } }));
  }

  return {
    /** Who the agent is on Drive: `{ kind: 'service_account' | 'workspace', email }`. */
    identity: () => who,

    /** The account Drive sees, and its storage: `{ user: { displayName, emailAddress }, storageQuota }`. */
    async about() {
      return call('GET', '/about', { allDrives: false, query: { fields: 'user(displayName,emailAddress),storageQuota(limit,usage)' } });
    },

    /**
     * Searches the files this identity can see, newest first (by relevance with `query`).
     *
     * @param {object}  [o]
     * @param {string}  [o.query]        words to find in the name or content (fullText contains)
     * @param {string}  [o.name]         words to find in the name
     * @param {string}  [o.mimeType]     an exact MIME type
     * @param {string}  [o.folderId]     only files directly in this folder
     * @param {boolean} [o.sharedWithMe] only files shared with this identity directly
     * @param {string}  [o.driveId]      only files in this shared drive
     * @param {number}  [o.limit]        at most this many (default 50, at most 1000)
     * @returns {Promise<{files: object[], capped: boolean, incomplete: boolean}>} capped: there are
     *   more than `limit`; incomplete: Drive did not search every shared drive
     */
    async find({ query, name, mimeType, folderId, sharedWithMe = false, driveId, limit = 50 } = {}) {
      const clauses = ['trashed = false'];
      if (query) clauses.push(`fullText contains '${escapeQueryValue(query)}'`);
      if (name) clauses.push(`name contains '${escapeQueryValue(name)}'`);
      if (mimeType) clauses.push(`mimeType = '${escapeQueryValue(mimeType)}'`);
      if (folderId) clauses.push(`'${escapeQueryValue(fileId(folderId, 'folder id'))}' in parents`);
      if (sharedWithMe) clauses.push('sharedWithMe = true');
      const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), MAX_PAGE_SIZE);
      const files = [];
      let pageToken;
      let incomplete = false;
      do {
        const page = await call('GET', '/files', {
          query: {
            q: clauses.join(' and '),
            corpora: driveId ? 'drive' : (sharedWithMe ? 'user' : 'allDrives'),
            driveId: driveId ? fileId(driveId, 'shared drive id') : undefined,
            includeItemsFromAllDrives: 'true',
            pageSize: cap - files.length,
            orderBy: query ? undefined : 'modifiedTime desc',
            fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
            pageToken,
          },
          about: { what: folderId ? `folder ${folderId}` : (driveId ? `shared drive ${driveId}` : 'file list') },
        });
        files.push(...(page.files || []).map(normalize));
        incomplete = incomplete || page.incompleteSearch === true;
        pageToken = page.nextPageToken;
      } while (pageToken && files.length < cap);
      return { files: files.slice(0, cap), capped: Boolean(pageToken), incomplete };
    },

    /**
     * One file's metadata: id, name, mimeType, size (a number, or null), modifiedTime, owners,
     * parents, driveId, webViewLink, shortcutDetails and capabilities.
     */
    getMeta,

    /**
     * A binary file's bytes. A shortcut is followed to its target. Google-native files (Docs, Sheets,
     * Slides) have no bytes: they are refused with the formats to export them to instead.
     *
     * @param {string} id
     * @param {{maxBytes?: number}} [o]
     * @returns {Promise<{bytes: Buffer, name: string, mimeType: string, file: object}>}
     */
    async download(id, { maxBytes } = {}) {
      let meta = await getMeta(id);
      if (meta.mimeType === SHORTCUT_MIME && meta.shortcutDetails?.targetId) meta = await getMeta(meta.shortcutDetails.targetId);
      const what = fileWord(meta.id, meta.name);
      if (meta.mimeType === FOLDER_MIME) {
        throw new DriveError(`${what} is a folder, not a file. List what is in it instead.`, { kind: 'not_a_file' });
      }
      if (isGoogleNative(meta.mimeType)) {
        const formats = Object.keys(EXPORT_FORMATS[meta.mimeType] || {});
        throw new DriveError(formats.length
          ? `${what} is a ${describeType(meta.mimeType)}: Google files have no bytes to download. Export it instead: drive-export ${meta.id} --format ${formats.join('|')}`
          : `${what} is a ${describeType(meta.mimeType)}, which cannot be downloaded or exported.`, { kind: 'google_native' });
      }
      if (meta.capabilities?.canDownload === false) {
        throw new DriveError(`The owner of ${what} has turned off downloading for viewers and commenters, so ${who.email} cannot download it. Ask the owner for Editor access, or to allow downloads.`, { kind: 'download_blocked' });
      }
      const tooBig = (size) => new DriveError(`${what} is ${(size / 1048576).toFixed(1)} MB, more than the ${(maxBytes / 1048576).toFixed(0)} MB a download may be.`, { kind: 'too_large' });
      if (maxBytes && meta.size > maxBytes) throw tooBig(meta.size);
      const bytes = await call('GET', `/files/${encodeURIComponent(meta.id)}`, {
        query: { alt: 'media' }, expect: 'bytes', timeoutMs: TRANSFER_TIMEOUT_MS, about: { what },
      });
      if (maxBytes && bytes.length > maxBytes) throw tooBig(bytes.length);
      return { bytes, name: meta.name, mimeType: meta.mimeType, file: meta };
    },

    /**
     * A Google-native file exported as another type (see EXPORT_FORMATS). Google exports at most
     * 10 MB; a larger result fails with kind export_too_large.
     *
     * @param {string} id
     * @param {string} mimeType the type to export as
     * @returns {Promise<Buffer>}
     */
    async export(id, mimeType) {
      const fid = fileId(id);
      if (!mimeType) throw new DriveError('export needs the MIME type to export as', { kind: 'bad_request' });
      return call('GET', `/files/${encodeURIComponent(fid)}/export`, {
        allDrives: false, query: { mimeType }, expect: 'bytes', timeoutMs: TRANSFER_TIMEOUT_MS,
        about: { what: `file ${fid}`, format: mimeType },
      });
    },

    /**
     * Creates a new file from bytes; it never replaces an existing one, even of the same name. Without
     * parentId it lands in the identity's My Drive, which a service account does not have: give it a
     * folder in a shared drive it is a member of.
     *
     * @param {object} o
     * @param {string} o.name
     * @param {string} [o.parentId]  the folder to create it in
     * @param {string} o.mimeType    the bytes' type
     * @param {Buffer|Uint8Array|string} o.bytes
     * @param {'doc'|'sheet'|'slides'} [o.convertTo] make it a Google Doc, Sheet or Slides
     * @returns {Promise<object>} the new file's metadata, with id and webViewLink
     */
    async create({ name, parentId, mimeType, bytes, convertTo } = {}) {
      if (!name) throw new DriveError('create needs a name', { kind: 'bad_request' });
      const metadata = { name };
      if (parentId) metadata.parents = [fileId(parentId, 'folder id')];
      if (convertTo) {
        const target = CONVERT_TARGETS[convertTo];
        if (!target) throw new DriveError(`convertTo must be one of ${Object.keys(CONVERT_TARGETS).join(', ')}`, { kind: 'bad_request' });
        metadata.mimeType = target;
      }
      return normalize(await upload({
        metadata, bytes: bytes ?? Buffer.alloc(0), mimeType,
        about: { what: parentId ? `folder ${parentId}` : 'My Drive', action: 'create a file in' },
      }));
    },

    /**
     * The shared drives this identity is a member of: `[{ id, name, canAddChildren, canTrashChildren,
     * canDeleteChildren }]`, the last three what its membership allows (a Content manager can add and
     * trash files but not delete them for good; a Viewer or Commenter can do none of it).
     */
    async listSharedDrives() {
      const drives = [];
      let pageToken;
      let pages = 0;
      do {
        const page = await call('GET', '/drives', {
          allDrives: false,
          query: { pageSize: 100, fields: 'nextPageToken,drives(id,name,capabilities(canAddChildren,canTrashChildren,canDeleteChildren))', pageToken },
          about: { what: 'shared drive list' },
        });
        drives.push(...(page.drives || []).map((d) => ({
          id: d.id,
          name: d.name,
          canAddChildren: d.capabilities?.canAddChildren === true,
          canTrashChildren: d.capabilities?.canTrashChildren === true,
          canDeleteChildren: d.capabilities?.canDeleteChildren === true,
        })));
        pageToken = page.nextPageToken;
        pages += 1;
      } while (pageToken && pages < MAX_DRIVE_PAGES);
      return drives;
    },

    /**
     * Moves a file to Drive's trash (files.update { trashed: true }), where its owner or a shared drive's
     * managers can restore it. Trashing, not deleting: a Content manager in a shared drive may trash
     * the files there but not delete them for good. Only drive_check uses it, on the test file it has
     * just created; nothing may call it on a file the agent did not create in the same breath.
     */
    async remove(id) {
      const fid = fileId(id);
      await call('PATCH', `/files/${encodeURIComponent(fid)}`, {
        query: { fields: 'id,trashed' }, body: JSON.stringify({ trashed: true }),
        headers: { 'Content-Type': 'application/json; charset=UTF-8' }, about: { what: `file ${fid}`, action: 'move to the trash' },
      });
    },
  };
}
