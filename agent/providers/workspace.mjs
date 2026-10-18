// agent/providers/workspace.mjs: the shared core of the agent's Google Workspace API clients
// (workspace-calendar.mjs, workspace-gmail.mjs, workspace-docs.mjs, workspace-sheets.mjs and
// workspace-slides.mjs). Plain REST over fetch, no npm packages.
//
// It acts only as the agent's own Workspace account, through domain-wide delegation
// (agent/auth/dwd-token.mjs): the subject is instance.workspace.account and the signer
// instance.workspace.signer. Each call asks for a token carrying only the scopes of the API it calls
// (agent/auth/workspace-scopes.mjs), so a scope missing from the Admin console grant breaks only the
// APIs that need it, and the error names that scope. Google's errors become plain sentences with
// Google's own message and the fix.
//
// It also holds the one rule every in-place change goes through: the agent changes a file only when
// its own account owns it (ownedFile), which is to say a file it created. Files people shared are read,
// commented on, or copied into new files; never edited, moved, renamed, trashed or deleted.
//
// It does not decide what to call or how to print it: the API modules and the skills' commands
// (skills/workspace-*/) do.

import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';
import { createDwdTokenSource } from '../auth/dwd-token.mjs';
import { WORKSPACE_APIS } from '../auth/workspace-scopes.mjs';
import { createDriveClient, describeType } from './drive.mjs';

/** Each API's origin. The instance record's `endpoints.<api>` overrides one (tests, development). */
export const API_HOSTS = Object.freeze({
  calendar: 'https://www.googleapis.com',
  gmail: 'https://gmail.googleapis.com',
  docs: 'https://docs.googleapis.com',
  sheets: 'https://sheets.googleapis.com',
  slides: 'https://slides.googleapis.com',
  drive: 'https://www.googleapis.com',
});

const REQUEST_TIMEOUT_MS = 60_000;

/** Where an admin edits the grant, in the Admin console's own words. */
const GRANT_PLACE = "the Admin console (Security, Access and data control, API controls, Domain-wide delegation), on the agent's client ID";

/**
 * A Workspace failure, in plain words. `kind` is one of: no_account, token, scope, account, auth,
 * api_disabled, quota, not_found, permission, wrong_type, conflict, unavailable, bad_request, not_owner,
 * and a few the API modules add (not_organizer, quote_not_found, heading_not_found). `api` is the API
 * it came from, `status` the HTTP status, `reason` Google's reason code, `google` Google's message.
 */
export class WorkspaceError extends Error {
  constructor(message, { kind, api = null, status = null, reason = null, google = null } = {}) {
    super(message);
    this.name = 'WorkspaceError';
    this.kind = kind;
    this.api = api;
    this.status = status;
    this.reason = reason;
    this.google = google;
  }
}

/** Whether two email addresses name the same account (case does not matter). */
export function sameEmail(a, b) {
  return Boolean(a) && Boolean(b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * The agent's Workspace account and the delegation signer, from the instance record.
 *
 * @param {object} instance
 * @returns {{account: string, signer: string}}
 * @throws {WorkspaceError} kind no_account when the instance has none
 */
export function workspaceAccount(instance) {
  const account = instance?.workspace?.account;
  const signer = instance?.workspace?.signer;
  if (!account || !signer) {
    throw new WorkspaceError(
      'This instance has no Workspace account, and the Workspace commands act only as one. A dashboard admin sets it up in Settings (Workspace). Until then, tell the person you cannot reach their Google Workspace from here.',
      { kind: 'no_account' },
    );
  }
  return { account, signer };
}

const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
const DISABLED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);
const QUOTA_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED']);

/**
 * Which kind of failure a Google error is. Pure.
 *
 * @param {number} httpStatus
 * @param {string[]} reasons     Google's reason codes (errors[].reason and details[].reason)
 * @param {string|null} grpcStatus e.g. PERMISSION_DENIED, RESOURCE_EXHAUSTED
 * @param {string|null} google   Google's message
 * @returns {string}
 */
export function classifyError(httpStatus, reasons = [], grpcStatus = null, google = null) {
  const has = (set) => reasons.some((r) => set.has(r));
  const said = (pattern) => pattern.test(google || '');
  if (has(SCOPE_REASONS) || said(/insufficient authentication scopes/i)) return 'scope';
  if (has(DISABLED_REASONS) || said(/has not been used in project|API .*is disabled|it is disabled/i)) return 'api_disabled';
  if (httpStatus === 429 || has(QUOTA_REASONS) || grpcStatus === 'RESOURCE_EXHAUSTED') return 'quota';
  if (httpStatus === 401) return 'auth';
  if (said(/operation is not supported for this document/i)) return 'wrong_type';
  if (httpStatus === 404 || reasons.includes('notFound')) return 'not_found';
  if (httpStatus === 403) return 'permission';
  if (httpStatus === 409 || said(/required revision/i)) return 'conflict';
  if (httpStatus >= 500) return 'unavailable';
  return 'bad_request';
}

/**
 * The plain sentence for a failure kind. Pure.
 *
 * @param {string} kind from classifyError()
 * @param {object} o
 * @param {string} o.api      calendar, gmail, docs, sheets, slides or drive
 * @param {string} o.account  the agent's Workspace address
 * @param {number} [o.status] the HTTP status
 * @param {string} [o.what]   what the call was about: "document 1abc...", "your calendar"
 * @param {string} [o.action] what the call did to it; 'read' (the default) or a verb phrase: 'change'
 * @param {string} [o.hint]   a sentence to add when the thing was not found
 * @param {string} [o.notFound] the whole sentence for not_found, where "not shared" would mislead (mail)
 * @returns {string}
 */
export function errorMessage(kind, { api, account, status, what, action = 'read', hint, notFound } = {}) {
  const { name, scopes } = WORKSPACE_APIS[api] || { name: 'Google Workspace', scopes: [] };
  const list = scopes.join(', ');
  const subject = what || `the ${name} item`;
  switch (kind) {
    case 'scope':
      return `${name} refused ${account}: the domain-wide delegation grant does not include ${list}. A Workspace admin adds it in ${GRANT_PLACE}. Until then this does not work; do not retry.`;
    case 'auth':
      return `${name} refused the credentials of ${account}. The domain-wide delegation grant may lack ${list}, or the account may be suspended. A Workspace admin checks the grant in ${GRANT_PLACE}; a dashboard admin can run the Workspace check in Settings.`;
    case 'api_disabled':
      return `The ${name} API is turned off in this Google Cloud project. A project owner turns it on in APIs & Services; the installer does this for Workspace roles.`;
    case 'quota':
      return `${name} is limiting requests from ${account} (a rate limit or quota). Wait a minute, then try once more; do not retry in a loop.`;
    case 'wrong_type':
      return `${subject} is not a native Google file that the ${name} API can open; it is probably an uploaded Office or PDF file. Read it with drive-get and file-read instead.`;
    case 'not_found':
      if (notFound) return notFound;
      return `${name} has no ${subject} that ${account} can see: the id or link is wrong, or it is not shared with ${account}. Copy the link or id again exactly (never edit an id and retry), or ask its owner to share it with ${account}.${hint ? ` ${hint}` : ''}`;
    case 'permission':
      return action === 'read'
        ? `${account} is not allowed to open ${subject}. Ask its owner to share it with ${account}.`
        : `${account} is not allowed to ${action} ${subject}.`;
    case 'conflict':
      return `${subject} changed while this command was working on it. Read it again, then make the change again.`;
    case 'unavailable':
      return `${name} failed to answer (HTTP ${status}). Try again in a minute.`;
    default:
      return `${name} refused the request (HTTP ${status}): Google's message below says what is wrong with it.`;
  }
}

/**
 * The error a failed token exchange becomes. Pure.
 *
 * @param {string} api
 * @param {Error|string} err  what agent/auth/dwd-token.mjs threw
 * @param {{account: string, signer: string}} who
 * @returns {WorkspaceError}
 */
export function tokenError(api, err, { account, signer }) {
  const { name, scopes } = WORKSPACE_APIS[api];
  const text = String(err?.message || err).replace(/\.$/, '');
  if (/unauthorized_client|unauthorized to retrieve access tokens|not authorized for any of the scopes/i.test(text)) {
    return new WorkspaceError(
      `Cannot get a ${name} token for ${account}: Google refused the domain-wide delegation (${text}). The grant must include ${scopes.join(', ')}; a Workspace admin adds it in ${GRANT_PLACE}. A dashboard admin can run the Workspace check in Settings to see which scopes are missing. Do not retry until then.`,
      { kind: 'scope', api },
    );
  }
  if (/invalid_grant|invalid email|user id/i.test(text)) {
    return new WorkspaceError(
      `Cannot get a ${name} token: Google does not accept ${account} as the account to act as (${text}). It may not exist, be suspended, or belong to another organization. A Workspace admin checks the account in the Admin console.`,
      { kind: 'account', api },
    );
  }
  if (/signJwt/i.test(text)) {
    return new WorkspaceError(
      `Cannot get a ${name} token for ${account}: the VM's service account could not sign as ${signer} (${text}). The installer grants it that right; re-running the installer repairs it.`,
      { kind: 'token', api },
    );
  }
  return new WorkspaceError(`Cannot get a ${name} token for ${account}: ${text}.`, { kind: 'token', api });
}

/** Google's message, reason codes and gRPC status from an error response body. */
async function readGoogleError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const err = body?.error && typeof body.error === 'object' ? body.error : {};
  const google = typeof err.message === 'string' && err.message
    ? err.message
    : (typeof body?.error === 'string' ? body.error_description || body.error : null);
  const reasons = [
    ...(Array.isArray(err.errors) ? err.errors.map((e) => e?.reason) : []),
    ...(Array.isArray(err.details) ? err.details.map((d) => d?.reason) : []),
  ].filter(Boolean);
  return { google, reasons, grpcStatus: typeof err.status === 'string' ? err.status : null };
}

/** Drive fields for one file: enough to tell its type, its owner and whether the agent owns it. */
const FILE_FIELDS = 'id,name,mimeType,ownedByMe,owners(displayName,emailAddress),driveId,webViewLink,modifiedTime,capabilities(canEdit,canComment)';

/**
 * Creates a session for the agent's Workspace account: tokens per API, one request function, and the
 * Drive calls every API module shares.
 *
 * @param {object}   options
 * @param {object}   options.instance          the instance record (config/instance.mjs loadInstance)
 * @param {Function} [options.getAccessToken]  the VM's token source, which signs as the signer
 * @param {Function} [options.getDwdToken]     the delegation token source (default: one over
 *                                             getAccessToken, fetch and now)
 * @param {Function} [options.fetch]
 * @param {Function} [options.now]             clock in milliseconds, for the token cache
 * @param {object}   [options.hosts]           API origins by API name, over instance.endpoints and API_HOSTS
 * @param {object}   [options.drive]           a Drive client (agent/providers/drive.mjs) for uploads
 * @throws {WorkspaceError} kind no_account when the instance has no Workspace account
 */
export function createWorkspaceSession({
  instance,
  getAccessToken = getVmAccessToken,
  getDwdToken,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  hosts = {},
  drive,
} = {}) {
  const who = workspaceAccount(instance);
  const { account, signer } = who;
  const dwdToken = getDwdToken || createDwdTokenSource({ fetch: fetchImpl, now, getVmAccessToken: getAccessToken });
  const origin = (api) => String(hosts[api] || instance?.endpoints?.[api] || API_HOSTS[api]).replace(/\/+$/, '');
  let driveClient = drive || null;

  async function token(api) {
    try {
      return await dwdToken({ signerServiceAccount: signer, subjectEmail: account, scopes: [...WORKSPACE_APIS[api].scopes] });
    } catch (err) {
      throw tokenError(api, err, who);
    }
  }

  /**
   * One API call.
   *
   * @param {string} api      calendar, gmail, docs, sheets, slides or drive
   * @param {string} method
   * @param {string} path     from the origin: /calendar/v3/...
   * @param {object} [o]
   * @param {object} [o.query]   query parameters; an array value repeats the parameter; empty ones are left out
   * @param {*}      [o.json]    a body sent as JSON
   * @param {object} [o.about]   { what, action, hint } for the error message
   * @param {'json'|'bytes'|'none'} [o.expect]
   * @returns {Promise<*>}
   */
  async function request(api, method, path, { query = {}, json, about = {}, expect = 'json', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = new URL(`${origin(api)}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    const bearer = await token(api);
    const headers = { Authorization: `Bearer ${bearer}` };
    if (json !== undefined) headers['Content-Type'] = 'application/json; charset=UTF-8';
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WorkspaceError(`${WORKSPACE_APIS[api].name} could not be reached: ${err.message}. Try again in a minute.`, { kind: 'unavailable', api });
    }
    if (!response.ok) {
      const { google, reasons, grpcStatus } = await readGoogleError(response);
      const kind = classifyError(response.status, reasons, grpcStatus, google);
      const message = errorMessage(kind, { api, account, status: response.status, ...about });
      throw new WorkspaceError(google ? `${message} (Google: ${google})` : message, {
        kind, api, status: response.status, reason: reasons[0] || null, google,
      });
    }
    if (expect === 'none' || response.status === 204) return null;
    if (expect === 'bytes') return Buffer.from(await response.arrayBuffer());
    return response.json();
  }

  /** One Drive file's id, name, type, owners, whether the agent owns it, link and capabilities. */
  async function fileInfo(id) {
    return request('drive', 'GET', `/drive/v3/files/${encodeURIComponent(id)}`, {
      query: { supportsAllDrives: 'true', fields: FILE_FIELDS },
      about: { what: `file ${id}` },
    });
  }

  /** Whether the agent's account owns a file, from fileInfo(). */
  function owns(info) {
    return info?.ownedByMe === true || (info?.owners || []).some((o) => sameEmail(o?.emailAddress, account));
  }

  return {
    account,
    signer,
    request,
    fileInfo,
    owns,

    /**
     * A file the agent may change in place: one of the expected Google type that its own account owns.
     * Anything else is refused with what to do instead.
     *
     * @param {string} id
     * @param {object} o
     * @param {string} o.type    the Google MIME type it must be (agent/providers/drive.mjs GOOGLE_TYPES)
     * @param {string} [o.action] what the caller would do, for the refusal: 'change'
     * @returns {Promise<object>} the file's info
     * @throws {WorkspaceError} kind wrong_type or not_owner
     */
    async ownedFile(id, { type, action = 'change' } = {}) {
      const info = await fileInfo(id);
      if (type && info.mimeType !== type) {
        throw new WorkspaceError(`"${info.name}" is ${describeType(info.mimeType)}, not a ${describeType(type)}, so this command cannot ${action} it.`, { kind: 'wrong_type', api: 'drive' });
      }
      if (!owns(info)) {
        const owner = info.owners?.[0];
        const whose = info.driveId
          ? 'it is in a shared drive, where files have no single owner'
          : `it belongs to ${owner ? (owner.displayName ? `${owner.displayName} <${owner.emailAddress}>` : owner.emailAddress) : 'someone else'}`;
        throw new WorkspaceError(
          `You may not ${action} "${info.name}": ${whose}, not to ${account}. You change in place only files your own account owns, the ones you created. Comment on it instead, or make a new file with the changes and say the original is unchanged.`,
          { kind: 'not_owner', api: 'drive' },
        );
      }
      return info;
    },

    /**
     * Creates an empty Google file (a Doc, Sheet or Slides) in a folder, or in the agent's My Drive.
     *
     * @param {{name: string, mimeType: string, parentId?: string}} o
     * @returns {Promise<{id: string, name: string, mimeType: string, webViewLink: string}>}
     */
    async createEmpty({ name, mimeType, parentId }) {
      return request('drive', 'POST', '/drive/v3/files', {
        query: { supportsAllDrives: 'true', fields: 'id,name,mimeType,webViewLink,parents' },
        json: { name, mimeType, ...(parentId ? { parents: [parentId] } : {}) },
        about: { what: parentId ? `folder ${parentId}` : 'My Drive', action: 'create a file in' },
      });
    },

    /** The Drive client (agent/providers/drive.mjs) acting as the same account, for uploads. */
    get drive() {
      if (!driveClient) {
        driveClient = createDriveClient({
          instance, getAccessToken, getDwdToken: dwdToken, fetch: fetchImpl, now, driveHost: hosts.drive,
        });
      }
      return driveClient;
    },
  };
}

/**
 * Runs `fn` over the items, at most `limit` at a time, keeping their order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
