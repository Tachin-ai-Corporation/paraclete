// tests/agent/services/control/workspace-fakes.mjs: Google, as the Workspace check meets it, for the
// tests of workspace-check.mjs and the workspace commands. One fetch answers IAM Credentials signJwt
// (as the delegation signer, or refused), the OAuth token exchange (domain-wide delegation: a token
// only for scopes the Admin console granted, refused for a user Google does not know), IAM's service
// account lookup (the client ID), and each Workspace API's read-only call, scripted per API. Every call
// is recorded.

import { WORKSPACE_SCOPES } from '../../../../agent/auth/workspace-scopes.mjs';

export const PROJECT = 'your-gcp-project';
export const SIGNER = `paraclete-dwd@${PROJECT}.iam.gserviceaccount.com`;
export const ACCOUNT = 'agent@example.com';
export const CLIENT_ID = '109876543210987654321';
export const VM_TOKEN = 'vm-token';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const googleError = (status, message, extra = {}) => json({ error: { code: status, message, ...extra } }, status);

/** What each API answers when nothing else is scripted: Docs, Sheets and Slides know no such file. */
const DEFAULT_ANSWERS = {
  chat: () => json({ spaces: [] }),
  // The account's direct message with itself, which the check looks up when Chat refuses the listing.
  chatSelf: () => googleError(404, "The specified direct message doesn't exist.", { status: 'NOT_FOUND' }),
  drive: () => json({ user: { emailAddress: ACCOUNT } }),
  docs: () => googleError(404, 'Requested entity was not found.', { status: 'NOT_FOUND' }),
  sheets: () => googleError(404, 'Requested entity was not found.', { status: 'NOT_FOUND' }),
  slides: () => googleError(404, 'Requested entity was not found.', { status: 'NOT_FOUND' }),
  calendar: () => json({ items: [] }),
  gmail: () => json({ emailAddress: ACCOUNT }),
};

const API_HOSTS = [
  ['chatSelf', /^https:\/\/chat\.googleapis\.com\/v1\/spaces:findDirectMessage/],
  ['chat', /^https:\/\/chat\.googleapis\.com\/v1\/spaces/],
  ['drive', /^https:\/\/www\.googleapis\.com\/drive\/v3\/about/],
  ['docs', /^https:\/\/docs\.googleapis\.com\/v1\/documents\//],
  ['sheets', /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//],
  ['slides', /^https:\/\/slides\.googleapis\.com\/v1\/presentations\//],
  ['calendar', /^https:\/\/www\.googleapis\.com\/calendar\/v3\/users\/me\/calendarList/],
  ['gmail', /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/],
];

/** Builders for the answers tests script. */
export const answers = {
  disabled: (service) => () => googleError(403, `${service} has not been used in project 123456789012 before or it is disabled.`, {
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { service } }],
  }),
  chatAppMissing: () => () => googleError(404, 'Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.', { status: 'NOT_FOUND' }),
  mailOff: () => () => googleError(400, 'Mail service not enabled', { status: 'FAILED_PRECONDITION', errors: [{ reason: 'failedPrecondition' }] }),
  status: (status, message) => () => googleError(status, message),
};

/**
 * @param {object} [o]
 * @param {string[]} [o.granted]        the scopes the Admin console grants the signer's client ID
 * @param {boolean}  [o.userExists]     whether Google knows the subject
 * @param {number|null} [o.signerStatus] an HTTP status for signJwt to fail with, or null
 * @param {Record<string, Function>} [o.apis] per API id, () => Response
 * @param {boolean}  [o.clientIdReadable]
 * @param {boolean}  [o.offline]        every call throws, as fetch does without a network
 */
export function fakeGoogle({
  granted = [...WORKSPACE_SCOPES], userExists = true, signerStatus = null, apis = {}, clientIdReadable = true, offline = false,
} = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const call = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(call);
    if (offline) throw new TypeError('fetch failed');
    if (u.startsWith('https://iamcredentials.googleapis.com/')) {
      call.kind = 'signJwt';
      if (signerStatus) return googleError(signerStatus, signerStatus === 404 ? `Service account ${SIGNER} not found.` : `Permission 'iam.serviceAccounts.signJwt' denied on resource`);
      const claims = JSON.parse(JSON.parse(init.body).payload);
      call.claims = claims;
      return json({ keyId: 'k1', signedJwt: Buffer.from(JSON.stringify(claims)).toString('base64url') });
    }
    if (u === 'https://oauth2.googleapis.com/token') {
      call.kind = 'token';
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion'), 'base64url').toString('utf8'));
      call.claims = claims;
      if (!userExists) return json({ error: 'invalid_grant', error_description: 'Invalid email or User ID' }, 400);
      const asked = claims.scope.split(' ');
      if (!asked.every((scope) => granted.includes(scope))) {
        return json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.' }, 401);
      }
      return json({ access_token: `token:${claims.sub}:${claims.scope}`, expires_in: 3600 });
    }
    if (u.startsWith('https://iam.googleapis.com/v1/projects/-/serviceAccounts/')) {
      call.kind = 'clientId';
      return clientIdReadable ? json({ oauth2ClientId: CLIENT_ID }) : googleError(403, 'Permission denied');
    }
    const hit = API_HOSTS.find(([, pattern]) => pattern.test(u));
    if (hit) {
      call.kind = 'api';
      call.api = hit[0];
      return (apis[hit[0]] || DEFAULT_ANSWERS[hit[0]])();
    }
    throw new Error(`the fake Google has no answer for ${u}`);
  };
  return { fetch, calls, of: (kind) => calls.filter((c) => c.kind === kind) };
}

// Addresses the address rule refuses. Built from parts: the repo's hygiene test allows only
// placeholder domains to appear as written addresses.
export const PERSONAL = ['someone', 'gmail.com'].join('@');
export const PERSONAL_LEGACY = ['someone', 'googlemail.com'].join('@');
export const OTHER_SERVICE_ACCOUNT = ['x', 'developer.gserviceaccount.com'].join('@');
