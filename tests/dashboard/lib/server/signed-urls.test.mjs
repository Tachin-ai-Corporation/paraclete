// Tests for dashboard/lib/server/signed-urls.mjs: V4 signed URLs built to Google's published algorithm
// (canonical request, string to sign, GOOG4-RSA-SHA256), checked byte for byte with a fixed clock, and
// signed through a fake IAM signBlob holding a real RSA key, so the signature verifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { startDashboard } from '../../harness.mjs';
import {
  MAX_EXPIRES_SECONDS, canonicalHeaders, canonicalQuery, createBlobSigner, goog4Time, resourcePath, rfc3986,
  signUrl, signedDownloadUrl, signedUploadUrl, signedUrlSeconds,
} from '../../../../dashboard/lib/server/signed-urls.mjs';

const NOW = new Date('2027-01-15T08:09:10.123Z');
const SIGNER = 'paraclete-dashboard@your-gcp-project.iam.gserviceaccount.com';
const ENCODED_SIGNER = 'paraclete-dashboard%40your-gcp-project.iam.gserviceaccount.com';
const BUCKET = 'your-gcp-project-paraclete';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** IAM Credentials' signBlob, faked with one RSA key: RSA PKCS#1 v1.5 over SHA-256, as Google signs. */
function fakeIam() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const payload = Buffer.from(JSON.parse(init.body).payload, 'base64');
    const signedBlob = createSign('RSA-SHA256').update(payload).sign(privateKey).toString('base64');
    return new Response(JSON.stringify({ keyId: 'k1', signedBlob }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls, sign: createBlobSigner({ signerEmail: SIGNER, getAccessToken: async () => 'dashboard-token', fetch }) };
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const verifies = (stringToSign, hex) => createVerify('RSA-SHA256').update(stringToSign).verify(publicKey, Buffer.from(hex, 'hex'));

test('encoding is RFC 3986: only A-Z a-z 0-9 - . _ ~ stay as they are, in uppercase hex', () => {
  assert.equal(rfc3986("AZaz09-._~ !'()*/@+=&é"), "AZaz09-._~%20%21%27%28%29%2A%2F%40%2B%3D%26%C3%A9");
  assert.equal(resourcePath('b', 'files/in/u-1-0a1b2c3d/Q3 report (final)+ü.docx'),
    '/b/files/in/u-1-0a1b2c3d/Q3%20report%20%28final%29%2B%C3%BC.docx');
  assert.deepEqual(goog4Time(NOW), { datetime: '20270115T080910Z', date: '20270115' });
  assert.equal(canonicalQuery({ b: '2', 'X-Y': 'a b', a: '1/2' }), 'X-Y=a%20b&a=1%2F2&b=2');
  assert.deepEqual(canonicalHeaders({ Host: 'storage.googleapis.com', 'Content-Type': '  application/pdf ' }),
    { canonical: 'content-type:application/pdf\nhost:storage.googleapis.com\n', signed: 'content-type;host' });
});

test('a GET URL: the canonical request and the string to sign follow the V4 algorithm byte for byte, and the signature verifies', async () => {
  const iam = fakeIam();
  const signed = await signUrl({
    method: 'GET', bucket: BUCKET, object: 'files/out/w-1/report.pdf', signerEmail: SIGNER, sign: iam.sign,
    expiresSeconds: 900, now: NOW,
  });
  const query = `X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=${ENCODED_SIGNER}%2F20270115%2Fauto%2Fstorage%2Fgoog4_request`
    + '&X-Goog-Date=20270115T080910Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host';
  const canonicalRequest = [
    'GET',
    `/${BUCKET}/files/out/w-1/report.pdf`,
    query,
    'host:storage.googleapis.com',
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  assert.equal(signed.canonicalRequest, canonicalRequest);
  assert.equal(signed.stringToSign, `GOOG4-RSA-SHA256\n20270115T080910Z\n20270115/auto/storage/goog4_request\n${sha256(canonicalRequest)}`);

  const url = new URL(signed.url);
  assert.equal(url.origin, 'https://storage.googleapis.com');
  assert.equal(url.pathname, `/${BUCKET}/files/out/w-1/report.pdf`);
  const [unsigned, signature] = signed.url.split('?')[1].split('&X-Goog-Signature=');
  assert.equal(unsigned, query);
  assert.match(signature, /^[0-9a-f]{512}$/);
  assert.ok(verifies(signed.stringToSign, signature), 'the signature is over the string to sign');
  assert.equal(signed.expires_at, '2027-01-15T08:24:10.123Z');

  // signBlob was asked as the dashboard's account, with its token, for exactly the string to sign.
  assert.equal(iam.calls.length, 1);
  assert.equal(iam.calls[0].url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER)}:signBlob`);
  assert.equal(iam.calls[0].init.headers.Authorization, 'Bearer dashboard-token');
  assert.equal(Buffer.from(JSON.parse(iam.calls[0].init.body).payload, 'base64').toString('utf8'), signed.stringToSign);
});

test('a PUT URL signs the content type, so the browser must send exactly it; names outside ASCII are encoded once', async () => {
  const iam = fakeIam();
  const object = 'files/in/u-1800000000000-0a1b2c3d/Résumé (v2).docx';
  const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const signed = await signUrl({
    method: 'PUT', bucket: BUCKET, object, signerEmail: SIGNER, sign: iam.sign, expiresSeconds: 900, now: NOW,
    headers: { 'content-type': type },
  });
  const path = `/${BUCKET}/files/in/u-1800000000000-0a1b2c3d/R%C3%A9sum%C3%A9%20%28v2%29.docx`;
  const query = `X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=${ENCODED_SIGNER}%2F20270115%2Fauto%2Fstorage%2Fgoog4_request`
    + '&X-Goog-Date=20270115T080910Z&X-Goog-Expires=900&X-Goog-SignedHeaders=content-type%3Bhost';
  assert.equal(signed.canonicalRequest, [
    'PUT', path, query, `content-type:${type}`, 'host:storage.googleapis.com', '', 'content-type;host', 'UNSIGNED-PAYLOAD',
  ].join('\n'));
  assert.ok(signed.url.startsWith(`https://storage.googleapis.com${path}?${query}&X-Goog-Signature=`));
  assert.ok(verifies(signed.stringToSign, signed.url.split('X-Goog-Signature=')[1]));
});

test('the runtime signs as the dashboard account, for files.signed_url_minutes; a download names its file and type', async (t) => {
  const iam = fakeIam();
  const dash = await startDashboard({ fetch: iam.fetch });
  t.after(dash.stop);
  const { runtime } = dash;
  assert.equal(runtime.settings.dashboardAccount, SIGNER);
  assert.equal(signedUrlSeconds(runtime), runtime.contracts.files.signed_url_minutes * 60);

  const upload = await signedUploadUrl(runtime, { object: 'files/in/u-1-0a1b2c3d/a.csv', contentType: 'text/csv', now: NOW });
  assert.deepEqual(upload.headers, { 'Content-Type': 'text/csv' });
  const uploadQuery = new URL(upload.url).searchParams;
  assert.equal(uploadQuery.get('X-Goog-Expires'), String(runtime.contracts.files.signed_url_minutes * 60));
  assert.equal(uploadQuery.get('X-Goog-Credential'), `${SIGNER}/20270115/auto/storage/goog4_request`);
  assert.equal(uploadQuery.get('X-Goog-SignedHeaders'), 'content-type;host');
  assert.equal(new URL(upload.url).pathname, `/${runtime.settings.bucket}/files/in/u-1-0a1b2c3d/a.csv`);

  const disposition = 'attachment; filename="Q3 report.docx"; filename*=UTF-8\'\'Q3%20report.docx';
  const download = await signedDownloadUrl(runtime, { object: 'files/out/w-1/Q3 report.docx', disposition, contentType: 'text/plain; charset=utf-8', now: NOW });
  const raw = download.url.split('?')[1];
  // Extra parameters sort after the X-Goog ones (uppercase first) and are signed with them.
  assert.match(raw, /X-Goog-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%3D%22Q3%20report\.docx%22%3B%20filename%2A%3DUTF-8%27%27Q3%2520report\.docx&response-content-type=text%2Fplain%3B%20charset%3Dutf-8&X-Goog-Signature=[0-9a-f]+$/);
  const query = new URL(download.url).searchParams;
  assert.equal(query.get('response-content-disposition'), disposition);
  assert.equal(query.get('response-content-type'), 'text/plain; charset=utf-8');
  assert.equal(iam.calls.length, 2);
});

test('a signature IAM refuses is a 502 naming the fix, with the details in the log; no bucket is a 503', async (t) => {
  const dash = await startDashboard({
    fetch: async () => new Response('{"error":{"code":403,"message":"Permission iam.serviceAccounts.signBlob denied"}}', { status: 403 }),
  });
  t.after(dash.stop);
  await assert.rejects(signedUploadUrl(dash.runtime, { object: 'files/in/u-1-0a1b2c3d/a.csv', contentType: 'text/csv' }),
    (err) => err.status === 502 && /Token Creator/.test(err.message) && !/signBlob denied/.test(err.message));
  assert.match(dash.lines.find((line) => line.level === 'ERROR').message, /signBlob denied/);

  const runtime = { ...dash.runtime, settings: { ...dash.runtime.settings, bucket: '' } };
  await assert.rejects(signedDownloadUrl(runtime, { object: 'files/out/w-1/a', disposition: 'attachment', contentType: 'text/plain' }), (err) => err.status === 503);
});

test('only GET and PUT, and only lifetimes V4 allows', async () => {
  const { sign } = fakeIam();
  const base = { bucket: BUCKET, object: 'a', signerEmail: SIGNER, sign, now: NOW };
  await assert.rejects(signUrl({ ...base, method: 'DELETE', expiresSeconds: 60 }), /not a method/);
  for (const expiresSeconds of [0, -1, MAX_EXPIRES_SECONDS + 1, Number.NaN]) {
    await assert.rejects(signUrl({ ...base, method: 'GET', expiresSeconds }), /1 to 604800 seconds/);
  }
  const longest = await signUrl({ ...base, method: 'GET', expiresSeconds: MAX_EXPIRES_SECONDS });
  assert.equal(new URL(longest.url).searchParams.get('X-Goog-Expires'), '604800');
});
