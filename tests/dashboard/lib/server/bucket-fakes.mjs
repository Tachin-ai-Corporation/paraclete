// tests/dashboard/lib/server/bucket-fakes.mjs: a dashboard runtime with the instance's bucket and IAM
// faked, for the tests of the dashboard's file handling (files, uploads, chat attachments). The bucket
// is tests/fakes/gcs-server.mjs, named as the runtime expects and reached through
// PARACLETE_STORAGE_HOST; IAM Credentials' signBlob signs with one RSA key generated here, so a test can
// verify a signed URL's signature. Not a test file itself.
import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { startDashboard, PROJECT } from '../../harness.mjs';
import { start as startStorage } from '../../../fakes/gcs-server.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** The bucket the runtime derives for the harness's project. */
export const BUCKET = `${PROJECT}-paraclete`;

/**
 * Starts the Firestore and Cloud Storage fakes and a runtime on both, with IAM's signBlob faked.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {Record<string, {body: string|Buffer, type: string}>} [options.objects]  put in the bucket first
 * @param {Record<string, string>} [options.env]
 * @param {Function} [options.iam]  replaces the signBlob fake: (url, init) => Response
 * @returns {Promise<{dash: object, runtime: object, storage: object, signs: object[], put: Function}>}
 */
export async function startWithBucket(t, { objects = {}, env = {}, iam } = {}) {
  const storage = await startStorage({ bucket: BUCKET });
  const signs = [];
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith(storage.origin)) return globalThis.fetch(url, init);
    if (String(url).includes(':signBlob')) {
      signs.push({ url: String(url), init });
      if (iam) return iam(url, init);
      const payload = Buffer.from(JSON.parse(init.body).payload, 'base64');
      const signedBlob = createSign('RSA-SHA256').update(payload).sign(privateKey).toString('base64');
      return new Response(JSON.stringify({ keyId: 'k1', signedBlob }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected call in a test: ${url}`);
  };
  const dash = await startDashboard({ env: { PARACLETE_STORAGE_HOST: storage.origin, ...env }, fetch });
  t.after(async () => {
    await storage.stop();
    await dash.stop();
  });

  /** Puts an object into the bucket, as a browser's PUT to a signed URL would leave it. */
  async function put(name, body, type = 'application/octet-stream') {
    const response = await globalThis.fetch(`${storage.origin}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': type }, body,
    });
    if (response.status !== 200) throw new Error(`the bucket fake refused ${name}: ${response.status}`);
  }
  for (const [name, { body, type }] of Object.entries(objects)) await put(name, body, type);
  storage.requests.length = 0;
  return { dash, runtime: dash.runtime, storage, signs, put };
}

/**
 * Whether a signed URL carries the fake IAM key's valid V4 signature, checked the way the bucket checks
 * one: the canonical request rebuilt from the URL itself (its path as sent, its other parameters
 * sorted, the host and the given headers), then the string to sign from its date and scope.
 *
 * @param {string} url
 * @param {object} [o]
 * @param {'GET'|'PUT'} [o.method]
 * @param {Record<string, string>} [o.headers]  the headers the request sends besides host
 * @returns {boolean}
 */
export function verifySignedUrl(url, { method = 'GET', headers = {} } = {}) {
  const parsed = new URL(url);
  const params = new URLSearchParams(parsed.search);
  const name = (pair) => pair.split('=')[0];
  const query = parsed.search.slice(1).split('&').filter((pair) => name(pair) !== 'X-Goog-Signature')
    .sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0)).join('&');
  const all = { host: parsed.host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  const names = Object.keys(all).sort();
  if (params.get('X-Goog-SignedHeaders') !== names.join(';')) return false;
  const canonical = [method, parsed.pathname, query, names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = String(params.get('X-Goog-Credential')).split('/').slice(1).join('/');
  const stringToSign = ['GOOG4-RSA-SHA256', params.get('X-Goog-Date'), scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  return createVerify('RSA-SHA256').update(stringToSign).verify(publicKey, Buffer.from(params.get('X-Goog-Signature') || '', 'hex'));
}
