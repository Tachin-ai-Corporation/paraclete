// tests/fakes/gcs-server.mjs: an in-memory stand-in for the Cloud Storage JSON API, served by
// node:http on 127.0.0.1 so integration tests can point the agent's storage clients at it with
// `storageHost`. One bucket. It is faithful for the calls the clients in agent/ make: media upload,
// object metadata, alt=media download, delete, and list with prefix, delimiter and page tokens. A
// feature outside that subset (multipart or resumable uploads, preconditions, ranges, versions)
// answers 501 rather than guessing. It does not model IAM, retention, versioning or signed URLs.
// tests/fakes/README.md lists what it supports and what it deliberately doesn't. Used by
// integration tests, and checked against the real clients by tests/fakes/gcs-server.test.mjs.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const MAX_LIST_RESULTS = 1000;
const MAX_NAME_BYTES = 1024;

/** An error the fake answers with, in the JSON API's { error: { code, message, errors } } shape. */
class ApiError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}
const unimplemented = (what) =>
  new ApiError(501, 'notImplemented', `The Cloud Storage fake does not implement ${what}. See tests/fakes/README.md.`);

const byteCompare = (a, b) => Math.sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

// CRC32C (Castagnoli), the checksum Cloud Storage reports alongside MD5.
const CRC32C_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** Base64 of the big-endian CRC32C of `data`, as Cloud Storage reports it. */
export function crc32c(data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC32C_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return out.toString('base64');
}

function checkParams(params, unsupported) {
  for (const key of params.keys()) {
    if (unsupported.includes(key)) throw unimplemented(`the ${key} parameter`);
  }
}

function checkName(name) {
  if (!name) throw new ApiError(400, 'required', 'Required');
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES || /[\r\n]/.test(name) || name === '.' || name === '..') {
    throw new ApiError(400, 'invalid', 'The specified object name is not valid.');
  }
}

/**
 * Starts the fake on a free port on 127.0.0.1.
 *
 * @param {object} [options]
 * @param {string} [options.bucket='your-gcp-project-bucket'] the only bucket it serves
 * @returns {Promise<{origin: string, url: string, bucket: string, requests: Array<object>,
 *   dump: Function, reset: Function, stop: Function}>} `origin` (also `url`) is what clients take
 *   as `storageHost`; `requests` records { method, path, query, token }
 */
export async function start({ bucket = 'your-gcp-project-bucket' } = {}) {
  const objects = new Map(); // name -> { data, contentType, generation, timeCreated, md5Hash, crc32c }
  const requests = [];
  let lastGeneration = 0;
  let origin = '';

  function resource(rec, name) {
    const encoded = encodeURIComponent(name);
    return {
      kind: 'storage#object',
      id: `${bucket}/${name}/${rec.generation}`,
      selfLink: `${origin}/storage/v1/b/${bucket}/o/${encoded}`,
      mediaLink: `${origin}/download/storage/v1/b/${bucket}/o/${encoded}?generation=${rec.generation}&alt=media`,
      name,
      bucket,
      generation: rec.generation,
      metageneration: '1',
      contentType: rec.contentType,
      storageClass: 'STANDARD',
      size: String(rec.data.length),
      md5Hash: rec.md5Hash,
      crc32c: rec.crc32c,
      etag: Buffer.from(`${rec.generation}/1`).toString('base64'),
      timeCreated: rec.timeCreated,
      updated: rec.timeCreated,
      timeStorageClassUpdated: rec.timeCreated,
    };
  }

  function find(name, params) {
    const rec = objects.get(name);
    if (!rec || (params.has('generation') && params.get('generation') !== rec.generation)) {
      throw new ApiError(404, 'notFound', `No such object: ${bucket}/${name}`);
    }
    return rec;
  }

  function upload(params, body, headers) {
    const type = params.get('uploadType');
    if (type === 'multipart' || type === 'resumable') throw unimplemented(`uploadType=${type}`);
    if (type !== 'media') {
      throw new ApiError(400, 'invalid', 'Upload requests must include an uploadType URL parameter and a URL path beginning with /upload/');
    }
    checkParams(params, ['ifGenerationMatch', 'ifGenerationNotMatch', 'ifMetagenerationMatch', 'ifMetagenerationNotMatch',
      'predefinedAcl', 'kmsKeyName', 'contentEncoding', 'fields']);
    const name = params.get('name');
    checkName(name);
    lastGeneration = Math.max(Date.now() * 1000, lastGeneration + 1);
    const data = Buffer.from(body);
    const rec = {
      data,
      contentType: headers['content-type'] || 'application/octet-stream',
      generation: String(lastGeneration),
      timeCreated: new Date(Math.floor(lastGeneration / 1000)).toISOString(),
      md5Hash: createHash('md5').update(data).digest('base64'),
      crc32c: crc32c(data),
    };
    objects.set(name, rec); // a new generation replaces the old one, as in a bucket without versioning
    return { status: 200, json: resource(rec, name) };
  }

  function list(params) {
    checkParams(params, ['versions', 'startOffset', 'endOffset', 'matchGlob', 'includeTrailingDelimiter',
      'includeFoldersAsPrefixes', 'softDeleted', 'fields']);
    const prefix = params.get('prefix') || '';
    const delimiter = params.get('delimiter') || '';
    const rawMax = params.get('maxResults');
    if (rawMax !== null && !/^\d+$/.test(rawMax)) throw new ApiError(400, 'invalid', `Invalid value for maxResults: ${rawMax}`);
    const maxResults = Math.min(Number(rawMax) || MAX_LIST_RESULTS, MAX_LIST_RESULTS);
    const token = params.get('pageToken');
    const after = token ? Buffer.from(token, 'base64url').toString('utf8') : '';
    if (token && Buffer.from(after, 'utf8').toString('base64url') !== token) throw new ApiError(400, 'invalid', 'Invalid pageToken.');

    // Each entry is an object, or a prefix that stands for every object under it up to the delimiter.
    const entries = new Map();
    for (const name of objects.keys()) {
      if (!name.startsWith(prefix)) continue;
      const cut = delimiter ? name.indexOf(delimiter, prefix.length) : -1;
      const entry = cut === -1 ? name : name.slice(0, cut + delimiter.length);
      if (!entries.has(entry)) entries.set(entry, cut === -1 ? 'item' : 'prefix');
    }
    const keys = [...entries.keys()].sort(byteCompare).filter((k) => !after || byteCompare(k, after) > 0);
    const page = keys.slice(0, maxResults);
    const prefixes = page.filter((k) => entries.get(k) === 'prefix');
    const items = page.filter((k) => entries.get(k) === 'item').map((k) => resource(objects.get(k), k));
    return {
      status: 200,
      json: {
        kind: 'storage#objects',
        ...(keys.length > page.length ? { nextPageToken: Buffer.from(page.at(-1), 'utf8').toString('base64url') } : {}),
        ...(prefixes.length ? { prefixes } : {}),
        ...(items.length ? { items } : {}),
      },
    };
  }

  function objectCall(method, api, name, params, headers) {
    if (method === 'GET') {
      const media = params.get('alt') === 'media';
      checkParams(params, ['ifGenerationMatch', 'ifGenerationNotMatch', 'ifMetagenerationMatch', 'ifMetagenerationNotMatch',
        'fields', 'softDeleted']);
      if (api === 'download' && !media) throw new ApiError(400, 'invalid', 'The download path serves alt=media only.');
      const rec = find(name, params);
      if (!media) return { status: 200, json: resource(rec, name) };
      if (headers.range) throw unimplemented('ranged downloads');
      return {
        status: 200,
        bytes: rec.data,
        headers: {
          'Content-Type': rec.contentType,
          'x-goog-generation': rec.generation,
          'x-goog-metageneration': '1',
          'x-goog-hash': `crc32c=${rec.crc32c},md5=${rec.md5Hash}`,
          'x-goog-stored-content-length': String(rec.data.length),
          'x-goog-stored-content-encoding': 'identity',
          ETag: Buffer.from(`${rec.generation}/1`).toString('base64'),
        },
      };
    }
    if (method === 'DELETE' && api === 'storage') {
      checkParams(params, ['ifGenerationMatch', 'ifGenerationNotMatch', 'ifMetagenerationMatch', 'ifMetagenerationNotMatch']);
      find(name, params);
      objects.delete(name);
      return { status: 204 };
    }
    throw unimplemented(`${method} on an object`);
  }

  function route(method, rawPath, params, body, headers) {
    // Object names arrive percent-encoded as one path segment; a raw '/' in one is not an object path.
    const m = /^\/(upload\/storage|storage|download\/storage)\/v1\/b\/([^/]+)(\/o(?:\/([^/]+))?)?$/.exec(rawPath);
    if (!m) throw new ApiError(404, 'notFound', 'Not Found');
    const [, api, rawBucket, objectPart, rawName] = m;
    if (rawBucket !== encodeURIComponent(bucket)) throw new ApiError(404, 'notFound', 'The specified bucket does not exist.');
    if (!objectPart) throw unimplemented('bucket calls');
    if (api === 'upload/storage') {
      if (rawName !== undefined || method !== 'POST') throw new ApiError(404, 'notFound', 'Not Found');
      return upload(params, body, headers);
    }
    if (rawName === undefined) {
      if (api === 'storage' && method === 'GET') return list(params);
      if (api === 'storage' && method === 'POST') throw unimplemented('metadata-only inserts');
      throw new ApiError(404, 'notFound', 'Not Found');
    }
    let name;
    try { name = decodeURIComponent(rawName); } catch { throw new ApiError(400, 'invalid', 'The specified object name is not valid.'); }
    checkName(name);
    return objectCall(method, api === 'storage' ? 'storage' : 'download', name, params, headers);
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const cut = req.url.indexOf('?');
      const rawPath = cut === -1 ? req.url : req.url.slice(0, cut);
      const query = cut === -1 ? '' : req.url.slice(cut + 1);
      const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      requests.push({ method: req.method, path: rawPath, query, token: auth ? auth[1] : null });
      let out;
      try {
        out = route(req.method, rawPath, new URLSearchParams(query), Buffer.concat(chunks), req.headers);
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(500, 'backendError', `Cloud Storage fake bug: ${err.stack}`);
        out = { status: e.code, json: { error: { code: e.code, message: e.message, errors: [{ message: e.message, domain: 'global', reason: e.reason }] } } };
      }
      if (out.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      const bytes = out.bytes ?? Buffer.from(JSON.stringify(out.json), 'utf8');
      res.writeHead(out.status, {
        'Content-Type': 'application/json; charset=UTF-8',
        ...out.headers,
        'Content-Length': bytes.length,
      });
      res.end(bytes);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    url: origin,
    bucket,
    requests,
    /** Every stored object by name: { contentType, generation, size, md5Hash, crc32c, data: Buffer }. */
    dump: () => Object.fromEntries([...objects.keys()].sort(byteCompare).map((name) => {
      const { data, contentType, generation, md5Hash, crc32c: crc } = objects.get(name);
      return [name, { contentType, generation, size: data.length, md5Hash, crc32c: crc, data: Buffer.from(data) }];
    })),
    /** Forgets every object and recorded request. */
    reset() {
      objects.clear();
      requests.length = 0;
    },
    stop: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
