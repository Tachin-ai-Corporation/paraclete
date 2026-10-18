// dashboard/lib/server/signed-urls.mjs: Cloud Storage V4 signed URLs, made without a key. A signed URL
// lets the browser talk to the instance's bucket directly for a few minutes: PUT one upload's bytes
// (Cloud Run's 32 MB request limit never applies), or GET one file as a download. The dashboard holds
// no private key; it builds the canonical request and the string to sign itself, following Google's
// published V4 algorithm (GOOG4-RSA-SHA256, path-style `/<bucket>/<object>` on storage.googleapis.com),
// and has IAM Credentials `signBlob` sign it as its own service account, which holds Service Account
// Token Creator on itself (install/install.sh grants it). The URLs last files.signed_url_minutes.
//
// It only signs. Which object a person may upload to or download is decided by uploads.mjs and
// files.mjs; nothing here checks that an object exists.

import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';

/** The host every signed URL names, and the one its signature covers. */
export const SIGNING_HOST = 'storage.googleapis.com';
/** V4's one algorithm for a service account's RSA key. */
export const ALGORITHM = 'GOOG4-RSA-SHA256';
/** The longest a V4 signed URL may live: seven days. */
export const MAX_EXPIRES_SECONDS = 604_800;

const IAM_CREDENTIALS_HOST = 'https://iamcredentials.googleapis.com';
const SIGN_TIMEOUT_MS = 15_000;

/**
 * Percent-encodes everything but RFC 3986's unreserved characters (A-Z a-z 0-9 - . _ ~), with
 * uppercase hex: the encoding V4 signing uses for query names and values and for path segments.
 *
 * @param {string} value
 * @returns {string}
 */
export function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The path-style resource path: `/<bucket>/<object>`, each part encoded, the object's own `/` kept.
 *
 * @param {string} bucket
 * @param {string} object
 * @returns {string}
 */
export function resourcePath(bucket, object) {
  return `/${rfc3986(bucket)}/${String(object).split('/').map(rfc3986).join('/')}`;
}

/**
 * The request time as V4 writes it: `20270115T080000Z`, and its date, `20270115`.
 *
 * @param {Date} now
 * @returns {{datetime: string, date: string}}
 */
export function goog4Time(now) {
  const datetime = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { datetime, date: datetime.slice(0, 8) };
}

/**
 * The canonical query string: every parameter encoded, sorted by name, joined with `&`.
 *
 * @param {Record<string, string>} params
 * @returns {string}
 */
export function canonicalQuery(params) {
  return Object.entries(params)
    .map(([name, value]) => [rfc3986(name), rfc3986(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * The headers a signature covers, canonical: names lowercase and sorted, values trimmed with inner
 * runs of spaces folded.
 *
 * @param {Record<string, string>} headers
 * @returns {{canonical: string, signed: string}} the `name:value\n` lines, and the names joined with `;`
 */
export function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [String(name).toLowerCase().trim(), String(value).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

/**
 * Signs bytes as a service account through IAM Credentials `signBlob` (RSA with SHA-256). The caller's
 * token must carry `iam.serviceAccounts.signBlob` on that account.
 *
 * @param {object}   o
 * @param {string}   o.signerEmail
 * @param {Function} o.getAccessToken  async () => string
 * @param {Function} [o.fetch]
 * @param {string}   [o.host]
 * @returns {(bytes: Buffer) => Promise<Buffer>} the signature
 */
export function createBlobSigner({ signerEmail, getAccessToken, fetch = globalThis.fetch, host = IAM_CREDENTIALS_HOST }) {
  if (!signerEmail) throw new Error('createBlobSigner: signerEmail is required');
  return async function signBlob(bytes) {
    const url = `${host}/v1/projects/-/serviceAccounts/${encodeURIComponent(signerEmail)}:signBlob`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: Buffer.from(bytes).toString('base64') }),
      signal: AbortSignal.timeout(SIGN_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`signBlob as ${signerEmail} failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
    }
    const { signedBlob } = await response.json();
    if (typeof signedBlob !== 'string' || !signedBlob) throw new Error(`signBlob as ${signerEmail} returned no signature`);
    return Buffer.from(signedBlob, 'base64');
  };
}

/**
 * A V4 signed URL for one object, with the canonical request and string to sign it was made from.
 *
 * @param {object}   o
 * @param {'GET'|'PUT'} o.method
 * @param {string}   o.bucket
 * @param {string}   o.object          the object name, e.g. files/in/u-1-0a1b2c3d/report.pdf
 * @param {string}   o.signerEmail     the service account the URL acts as
 * @param {(bytes: Buffer) => Promise<Buffer>} o.sign  createBlobSigner()'s, or a test's
 * @param {number}   o.expiresSeconds  1 to MAX_EXPIRES_SECONDS
 * @param {Date}     [o.now]
 * @param {Record<string, string>} [o.headers]  headers the browser must send exactly; `host` is always signed
 * @param {Record<string, string>} [o.query]    extra query parameters, e.g. response-content-disposition
 * @param {string}   [o.host]
 * @returns {Promise<{url: string, expires_at: string, canonicalRequest: string, stringToSign: string}>}
 */
export async function signUrl({
  method, bucket, object, signerEmail, sign, expiresSeconds, now = new Date(), headers = {}, query = {}, host = SIGNING_HOST,
}) {
  if (method !== 'GET' && method !== 'PUT') throw new Error(`signUrl: ${method} is not a method this signs`);
  if (!bucket || !object || !signerEmail) throw new Error('signUrl: bucket, object and signerEmail are required');
  const expires = Math.floor(Number(expiresSeconds));
  if (!(expires >= 1 && expires <= MAX_EXPIRES_SECONDS)) {
    throw new Error(`signUrl: a V4 signed URL lasts 1 to ${MAX_EXPIRES_SECONDS} seconds, not ${expiresSeconds}`);
  }

  const { datetime, date } = goog4Time(now);
  const scope = `${date}/auto/storage/goog4_request`;
  const { canonical, signed } = canonicalHeaders({ ...headers, host });
  const params = {
    ...query,
    'X-Goog-Algorithm': ALGORITHM,
    'X-Goog-Credential': `${signerEmail}/${scope}`,
    'X-Goog-Date': datetime,
    'X-Goog-Expires': String(expires),
    'X-Goog-SignedHeaders': signed,
  };
  const path = resourcePath(bucket, object);
  const queryString = canonicalQuery(params);
  const canonicalRequest = [method, path, queryString, canonical, signed, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, datetime, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signature = (await sign(Buffer.from(stringToSign, 'utf8'))).toString('hex');
  return {
    url: `https://${host}${path}?${queryString}&X-Goog-Signature=${signature}`,
    expires_at: new Date(now.getTime() + expires * 1000).toISOString(),
    canonicalRequest,
    stringToSign,
  };
}

const signers = new WeakMap();

/** The runtime's signBlob as the dashboard's own account, made once. */
function signerFor(runtime) {
  let sign = signers.get(runtime);
  if (!sign) {
    sign = createBlobSigner({ signerEmail: runtime.settings.dashboardAccount, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    signers.set(runtime, sign);
  }
  return sign;
}

/**
 * Signs one of the runtime's URLs. A bucket the dashboard does not know is a 503, and a signature
 * IAM refused a 502 that names the fix; the details go to the log.
 */
async function signForRuntime(runtime, what, options) {
  const { bucket, dashboardAccount } = runtime.settings;
  if (!bucket) throw new HttpError(503, 'the dashboard does not know its bucket (PARACLETE_BUCKET)');
  try {
    return await signUrl({ ...options, bucket, signerEmail: dashboardAccount, expiresSeconds: signedUrlSeconds(runtime) });
  } catch (err) {
    runtime.log('ERROR', `signing ${what} gs://${bucket}/${options.object} failed: ${err.message}`);
    throw new HttpError(502, `the dashboard could not sign a link to its bucket as ${dashboardAccount}. Its account needs the Service Account Token Creator role on itself (install/install.sh grants it)`);
  }
}

/** How long the runtime's URLs last: the contracts' files.signed_url_minutes. */
export function signedUrlSeconds(runtime) {
  const minutes = Number(runtime.contracts.files?.signed_url_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('contracts files.signed_url_minutes must be a positive number');
  return Math.min(Math.round(minutes * 60), MAX_EXPIRES_SECONDS);
}

/**
 * A URL the browser PUTs one upload's bytes to, in the instance's bucket. `content-type` is signed, so
 * the browser must send exactly `contentType` and the object is stored with it.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {string} o.object
 * @param {string} o.contentType
 * @param {Date}   [o.now]
 * @param {Function} [o.sign]  tests pass their own signBlob
 * @returns {Promise<{url: string, expires_at: string, headers: {'Content-Type': string}}>}
 */
export async function signedUploadUrl(runtime, { object, contentType, now = new Date(), sign = signerFor(runtime) }) {
  const signedUrl = await signForRuntime(runtime, 'an upload to', {
    method: 'PUT', object, sign, now, headers: { 'content-type': contentType },
  });
  return { url: signedUrl.url, expires_at: signedUrl.expires_at, headers: { 'Content-Type': contentType } };
}

/**
 * A URL the browser GETs one file from as a download: the bucket answers with
 * `Content-Disposition: <disposition>` and `Content-Type: <contentType>`, whatever the object holds.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {string} o.object
 * @param {string} o.disposition  e.g. attachment; filename="a.pdf"; filename*=UTF-8''a.pdf
 * @param {string} o.contentType
 * @param {Date}   [o.now]
 * @param {Function} [o.sign]
 * @returns {Promise<{url: string, expires_at: string}>}
 */
export async function signedDownloadUrl(runtime, { object, disposition, contentType, now = new Date(), sign = signerFor(runtime) }) {
  const signedUrl = await signForRuntime(runtime, 'a download of', {
    method: 'GET', object, sign, now, query: { 'response-content-disposition': disposition, 'response-content-type': contentType },
  });
  return { url: signedUrl.url, expires_at: signedUrl.expires_at };
}
