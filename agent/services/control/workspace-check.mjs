// agent/services/control/workspace-check.mjs: the workspace_check command, the Test button of the
// dashboard's Workspace setup. It asks Google, the way the agent will, whether an account works for
// it: the VM's service account has IAM sign a token request as the delegation signer
// (paraclete-dwd@<project>), naming the account as its subject, and trades it for a token per API
// (agent/auth/dwd-token.mjs, with the scopes in agent/auth/workspace-scopes.mjs); then it makes one
// read-only call per API. Each failure becomes the one thing a person must change, in `fix`: a scope
// missing from the Admin console's delegation entry, an entry for another client ID or none at all, a
// user that does not exist or is suspended, an API turned off in the project, a service turned off for
// the user, the signer missing or not signable. It writes nothing in Google. commands.mjs calls it and
// records its outcome for the dashboard (workspace-account.mjs writeLastCheck).
//
// Docs, Sheets and Slides have no call that reads without naming a file, so the check asks each for a
// file id that cannot exist: Google answering "not found" proves the API is on and took the token.
// Google Chat refuses to list the spaces of a user nobody has written to yet, so when the listing is
// refused the check looks up the account's direct message with itself: "not found" there means Chat
// took the token, and Chat counts as working but `pending`, with a `note` saying to add the agent to a
// space and @mention it.
// Delegation answers only "not authorized" for a request with any scope the grant lacks, so when the
// whole list is refused each scope is asked for alone, to name exactly the ones missing.

import { createDwdTokenSource } from '../../auth/dwd-token.mjs';
import { WORKSPACE_SCOPES, WORKSPACE_APIS, chatAppPage } from '../../auth/workspace-scopes.mjs';
import { checkWorkspaceAccount, signerFor } from './workspace-account.mjs';

/** A file id shaped like Google's (44 letters, digits, - and _) that no file has. */
export const PROBE_FILE_ID = '1paracleteWorkspaceCheckNoSuchFile0000000000';

/** The Admin console page where an admin grants domain-wide delegation to a client ID. */
export const DELEGATION_PAGE = 'https://admin.google.com/ac/owl/domainwidedelegation';

const IAM_API = 'https://iam.googleapis.com/v1';
/** Chat's lookup of a direct message by the other person; the check asks for the account's own. */
const CHAT_SELF_URL = 'https://chat.googleapis.com/v1/spaces:findDirectMessage?name=';
const CALL_TIMEOUT_MS = 15_000;
const MAX_ERROR_CHARS = 300;

const list = (scopes) => (Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/\s+/)).filter(Boolean);

/**
 * The call the check makes to each API: `service` is the API's name in the project (what install.sh
 * turns on), `url` one read-only call, and `notFoundIsOk` marks the probes for a file that cannot
 * exist. The API's name and scopes are workspace-scopes.mjs's.
 */
const CALLS = Object.freeze({
  chat: { service: 'chat.googleapis.com', url: 'https://chat.googleapis.com/v1/spaces?pageSize=1' },
  drive: { service: 'drive.googleapis.com', url: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)' },
  docs: { service: 'docs.googleapis.com', url: `https://docs.googleapis.com/v1/documents/${PROBE_FILE_ID}?fields=documentId`, notFoundIsOk: true },
  sheets: { service: 'sheets.googleapis.com', url: `https://sheets.googleapis.com/v4/spreadsheets/${PROBE_FILE_ID}?fields=spreadsheetId`, notFoundIsOk: true },
  slides: { service: 'slides.googleapis.com', url: `https://slides.googleapis.com/v1/presentations/${PROBE_FILE_ID}?fields=presentationId`, notFoundIsOk: true },
  calendar: { service: 'calendar-json.googleapis.com', url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1' },
  gmail: { service: 'gmail.googleapis.com', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' },
});

/** What the check asks of each Workspace API, in workspace-scopes.mjs's order: `{ api, name, scopes, service, url, notFoundIsOk? }`. */
export const API_PROBES = Object.freeze(Object.entries(WORKSPACE_APIS).map(([api, { name, scopes }]) => {
  if (!CALLS[api]) throw new Error(`workspace-check.mjs has no call for the ${api} API`);
  return Object.freeze({ api, name, scopes: list(scopes), ...CALLS[api] });
}));

const clip = (text) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s;
};

/**
 * Sorts a failure to get a delegated token by its cause, from the message dwd-token.mjs throws.
 *
 * @param {Error} err
 * @returns {{kind: 'signer'|'grant'|'user'|'network'|'other', status: number|null, message: string}}
 */
export function tokenFailure(err) {
  const message = clip(err?.message || err);
  const signing = /^signJwt failed \(HTTP (\d+)\)/.exec(message);
  if (signing) return { kind: 'signer', status: Number(signing[1]), message };
  const exchange = /^Delegated token exchange failed: (.*)$/.exec(message);
  if (exchange) {
    const reason = exchange[1];
    if (/unauthorized_client|access_denied|not authorized|unauthorized to retrieve/i.test(reason)) return { kind: 'grant', status: null, message };
    if (/email|user id|user|account/i.test(reason)) return { kind: 'user', status: null, message };
    return { kind: 'other', status: null, message };
  }
  if (err?.name === 'TypeError' || /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timed? ?out|aborted/i.test(message)) {
    return { kind: 'network', status: null, message };
  }
  return { kind: 'other', status: null, message };
}

/**
 * The one thing to change for a token failure that stops every API.
 *
 * @param {object} failure  from tokenFailure()
 * @param {object} c        { account, signer, project, clientId }
 * @returns {string}
 */
export function tokenFix(failure, { account, signer, project, clientId }) {
  const agent = `paraclete-agent@${project}.iam.gserviceaccount.com`;
  switch (failure.kind) {
    case 'signer':
      if (/SERVICE_DISABLED|iamcredentials|has not been used|is disabled/i.test(failure.message)) {
        return `Turn on the IAM Service Account Credentials API (iamcredentials.googleapis.com) in ${project}; running install/install.sh again does it.`;
      }
      if (failure.status === 404) {
        return `${signer} does not exist. Run install/install.sh again: for a role with a Workspace account it creates ${signer} and lets the agent sign as it.`;
      }
      if (failure.status === 403) {
        return `The agent's service account may not sign as ${signer}. Run install/install.sh again: it gives ${agent} the Service Account Token Creator role on ${signer}.`;
      }
      return `Signing as ${signer} failed. Run Test again in a minute; if it keeps failing, run install/install.sh again.`;
    case 'user':
      return `Google does not know ${account} as an active user. In the Admin console (Directory, Users), check that a user has exactly this address, that it is not suspended, and that it has a Google Workspace license. A new user can take a few minutes to become usable.`;
    case 'grant':
      return `The Admin console grants no domain-wide delegation to client ID ${clientId || `of ${signer}`}. Open ${DELEGATION_PAGE}, choose Add new, and enter that client ID with the full scope list. If an entry is there already, check that it names this client ID: an entry for another one (such as an account from an earlier install) does not count. A new entry can take a few minutes to apply.`;
    case 'network':
      return 'Google could not be reached from the VM. Run Test again in a minute.';
    default:
      return 'Google refused the token request. Run Test again in a minute; if it keeps failing, the error above says why.';
  }
}

/**
 * Google's error from an API answer: its message, its status and the first detail's reason.
 *
 * @param {number} status
 * @param {string} text  the answer's body
 */
function googleError(status, text) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON: the text is the message */ }
  const error = body?.error && typeof body.error === 'object' ? body.error : {};
  const reasons = (Array.isArray(error.details) ? error.details : []).map((d) => d?.reason).filter(Boolean);
  for (const e of Array.isArray(error.errors) ? error.errors : []) if (e?.reason) reasons.push(e.reason);
  return { status, message: clip(error.message || (typeof body?.error === 'string' ? body.error : '') || text || `HTTP ${status}`), state: error.status || '', reasons };
}

/**
 * The fix for an API call Google refused.
 *
 * @param {object} api     an API_PROBES entry
 * @param {object} e       googleError()
 * @param {object} c       { account, project }
 * @returns {string}
 */
export function apiFix(api, e, { account, project }) {
  const text = `${e.message} ${e.state} ${e.reasons.join(' ')}`;
  if (e.status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(text)) {
    return `Turn on the ${api.name} API (${api.service}) in ${project}: https://console.cloud.google.com/apis/library/${api.service}?project=${project}. Running install/install.sh again turns on every API a Workspace role uses. A just-enabled API can take a few minutes to answer.`;
  }
  if (api.api === 'chat' && e.status === 404 && /chat app/i.test(text)) {
    return `The Google Chat API needs a Chat app record in ${project}: open ${chatAppPage(project)}, enter an app name and a description, turn Interactive features off, and Save.`;
  }
  if (api.api === 'gmail' && /mail service not enabled|failedPrecondition|FAILED_PRECONDITION/i.test(text)) {
    return `Gmail is off for ${account}: give the user a license that includes Gmail, or turn Gmail on for its organizational unit (Admin console, Apps, Google Workspace, Gmail).`;
  }
  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(text)) {
    return `Google says the token lacks a scope ${api.name} needs. Paste the full scope list into the domain-wide delegation entry again (${DELEGATION_PAGE}).`;
  }
  if (e.status === 401) {
    return `Google did not accept the token for ${account}. If the delegation entry just changed, wait a few minutes, then run Test again.`;
  }
  if (e.status === 429 || e.status >= 500) return `${api.name} is busy or failing on Google's side. Run Test again in a minute.`;
  if (api.api === 'chat' && e.status === 403) {
    // Chat says only "permission denied" both for a project without a Chat app record and for a user
    // Chat is off for, so the fix names both, the project's first.
    return `Google Chat refused ${account}. First check that ${project} has a Chat app record: open ${chatAppPage(project)}, enter an app name and a description, turn Interactive features off, and Save (a new record can take a few minutes to apply). Then check that Google Chat is on for the user's organizational unit (Admin console, Apps, Google Workspace, Google Chat) and that its license includes it.`;
  }
  if (e.status === 403) {
    return `Google refused ${api.name} for ${account}. Check that ${api.name} is on for the user's organizational unit (Admin console, Apps, Google Workspace) and that its license includes it.`;
  }
  return `${api.name} answered ${e.status}. Run Test again; if it keeps failing, the error above says why.`;
}

/**
 * Whether Chat took the token of an account it refused to list spaces for. Google Chat knows a
 * Workspace user only once someone has written to it or added it to a space; until then spaces.list
 * answers that user 403, while a lookup of the account's direct message with itself answers 404:
 * the token was taken, there is just nothing to list yet.
 */
async function chatTookToken({ token, account, fetch }) {
  try {
    const response = await fetch(`${CHAT_SELF_URL}${encodeURIComponent(`users/${account}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/** What the check says of Chat for an account nobody has written to yet. */
export function chatPendingNote({ account, project }) {
  return `Chat took the agent's token but has no conversations for ${account} yet: Google Chat lists a user's spaces only once someone has written to it. Add the agent to a space in Google Chat and @mention it; it reads messages from up to an hour before it first comes online. If Chat still shows this after that, check the project's Chat app record: ${chatAppPage(project)}.`;
}

/**
 * The signer's OAuth client ID, the number an admin enters in the Admin console, as IAM reports it.
 * Best effort: null when IAM does not answer.
 */
async function lookupClientId({ signer, fetch, getVmAccessToken }) {
  try {
    const response = await fetch(`${IAM_API}/projects/-/serviceAccounts/${encodeURIComponent(signer)}?fields=oauth2ClientId`, {
      headers: { Authorization: `Bearer ${await getVmAccessToken()}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.oauth2ClientId === 'string' && body.oauth2ClientId ? body.oauth2ClientId : null;
  } catch {
    return null;
  }
}

/**
 * Runs the check. Google's answers become the result, never a thrown error; an address that is not a
 * Workspace user's is thrown, which fails the command.
 *
 * @param {object}   o
 * @param {unknown}  o.account            the address to check
 * @param {string}   o.project            the instance's project (names the signer)
 * @param {Function} o.fetch
 * @param {Function} o.getVmAccessToken   the VM service account's token
 * @param {Function} [o.now]              () => Date
 * @returns {Promise<{account: string, signer: string, client_id: string|null, checked_at: string,
 *   ready: boolean, missing_scopes: string[]|null, apis: object[]}>}
 */
export async function checkWorkspace({ account: value, project, fetch, getVmAccessToken, now = () => new Date() }) {
  const account = checkWorkspaceAccount(value);
  const signer = signerFor(project);
  const all = list(WORKSPACE_SCOPES);
  // A source of its own per check: a cached token would hide a grant changed since the last one.
  const getToken = createDwdTokenSource({ fetch, getVmAccessToken, now: () => now().getTime() });
  const mint = async (scopes) => {
    try {
      return { token: await getToken({ signerServiceAccount: signer, subjectEmail: account, scopes }) };
    } catch (err) {
      return { failure: tokenFailure(err) };
    }
  };

  // The whole list first: one answer when the grant is complete, the cause when nothing works.
  let blocker = null;
  let missing = [];
  const whole = await mint(all);
  if (whole.failure?.kind === 'grant') {
    for (const scope of all) {
      const one = await mint([scope]);
      if (!one.failure) continue;
      if (one.failure.kind !== 'grant') { blocker = one.failure; break; }
      missing.push(scope);
    }
    if (!blocker && missing.length === all.length) blocker = whole.failure;
    // Every scope alone was granted, but not all together: the grant cannot be judged scope by scope.
    if (!blocker && missing.length === 0) {
      blocker = whole.failure;
      missing = null;
    }
  } else if (whole.failure) {
    blocker = whole.failure;
  }
  if (blocker && blocker.kind !== 'grant') missing = null;
  const clientId = blocker?.kind === 'grant' || missing?.length ? await lookupClientId({ signer, fetch, getVmAccessToken }) : null;
  const context = { account, signer, project, clientId };

  const apis = [];
  for (const api of API_PROBES) {
    const entry = { api: api.api, name: api.name, scopes: [...api.scopes], ok: false, error: null, fix: null };
    apis.push(entry);
    if (blocker) {
      entry.error = blocker.message;
      entry.fix = tokenFix(blocker, context);
      continue;
    }
    const lacking = api.scopes.filter((scope) => missing.includes(scope));
    if (lacking.length) {
      entry.error = `the domain-wide delegation entry lacks ${lacking.join(', ')}`;
      entry.fix = `Edit the entry for client ID ${clientId || `of ${signer}`} at ${DELEGATION_PAGE} and add ${lacking.join(', ')}: paste the full scope list again. A change can take a few minutes to apply.`;
      continue;
    }
    const minted = await mint(api.scopes);
    if (minted.failure) {
      entry.error = minted.failure.message;
      entry.fix = tokenFix(minted.failure, context);
      continue;
    }
    let response;
    try {
      response = await fetch(api.url, { headers: { Authorization: `Bearer ${minted.token}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (err) {
      entry.error = clip(err.message);
      entry.fix = tokenFix({ kind: 'network', message: entry.error }, context);
      continue;
    }
    if (response.ok || (api.notFoundIsOk && response.status === 404)) {
      entry.ok = true;
      continue;
    }
    if (api.api === 'chat' && response.status === 403 && await chatTookToken({ token: minted.token, account, fetch })) {
      entry.ok = true;
      entry.pending = true;
      entry.note = chatPendingNote(context);
      continue;
    }
    const e = googleError(response.status, await response.text().catch(() => ''));
    entry.error = `HTTP ${e.status}: ${e.message}`;
    entry.fix = apiFix(api, e, context);
  }

  return {
    account,
    signer,
    client_id: clientId,
    checked_at: now().toISOString(),
    ready: apis.every((entry) => entry.ok),
    missing_scopes: missing,
    apis,
  };
}
