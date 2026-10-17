# tests/fakes/

Hermetic in-memory fakes of the Google APIs the agent's storage talks to over REST, for integration
tests. Each starts an HTTP server on `127.0.0.1` on a free port; a test points a client's host option
at it, runs real code, and inspects what was stored. No emulator, no network, no npm packages.

**Installed:** no.

| File | What it is |
|---|---|
| `firestore-server.mjs` | Firestore REST API (v1) fake: documents, queries, commits |
| `firestore-model.mjs` | Firestore's value model for that fake: validation, field paths, ordering, sizes |
| `gcs-server.mjs` | Cloud Storage JSON API fake: one bucket of objects |
| `*.test.mjs` | Tests of the fakes, driven through the agent's real clients. They double as the conformance check that the clients and the fakes agree on the API |

## Using them

```js
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { start as startStorage } from '../fakes/gcs-server.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';

const firestore = await startFirestore();                  // projectId defaults to your-gcp-project
const storage = await startStorage({ bucket: 'your-gcp-project-test' });
const db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin,
  getAccessToken: async () => 'test-token' });
// ... run the code under test ...
firestore.dump();   // { 'work/w-1': { fields, createTime, updateTime } }, typed values as sent
storage.dump();     // { 'files/out/m-1/report.md': { contentType, generation, size, md5Hash, crc32c, data } }
firestore.requests; // [{ method, path, query, token }]: token is the Bearer value, or null if none was sent
firestore.reset();  // forget all data and requests
await firestore.stop();
```

`origin` is what a client takes as its host. Firestore's `url` is the documents base URL
(`<origin>/v1/projects/<project>/databases/(default)/documents`), which `initChannel` takes as
`firestoreUrl`.

| Client | How to point it at a fake |
|---|---|
| `createClient` (storage/firestore.mjs) | `firestoreHost: firestore.origin` |
| `createRemoteStore` (storage/git-store.mjs) | `firestoreHost` and `storageHost` |
| `createFileStore` (storage/file-store.mjs) | `storageHost: storage.origin` |
| `initChannel` (providers/channel.mjs) | `firestoreUrl: firestore.url` |
| `assembleConversation` (context/conversation-context.mjs) | No host option: it builds the production URL. Pass a `fetch` that rewrites `https://firestore.googleapis.com` to `firestore.origin` |

Any token is accepted and none is required; the fakes only record what was sent, so a test can assert
that a client authenticated.

## Firestore fake

**Supported**, with the real API's status codes and `{ error: { code, message, status } }` bodies:

- `GET` a document (404 `NOT_FOUND` when missing); `GET` a collection lists it, by document name,
  with `pageSize` and `pageToken`; a missing collection is `{}`.
- `PATCH` a document: whole replace (an upsert), or `updateMask.fieldPaths` with dotted and
  backtick-quoted paths (masked fields the body omits are deleted). `currentDocument.exists` fails
  with 404 `NOT_FOUND` or 409 `ALREADY_EXISTS`; `currentDocument.updateTime` with 400
  `FAILED_PRECONDITION`.
- `POST` to a collection creates a document: `documentId` (409 `ALREADY_EXISTS` if taken), or a
  20-character id the server picks.
- `DELETE` (200 `{}` even when the document is missing), with the same preconditions.
- `:runQuery` at the root or under a parent document: one `from` collection (`allDescendants` too);
  `fieldFilter` `EQUAL`, `NOT_EQUAL`, `LESS_THAN(_OR_EQUAL)`, `GREATER_THAN(_OR_EQUAL)`, `IN`,
  `NOT_IN`, `ARRAY_CONTAINS`, `ARRAY_CONTAINS_ANY`; `compositeFilter` `AND` and `OR`; `unaryFilter`
  `IS_NULL` and `IS_NOT_NULL`; `orderBy` and `limit`. The answer is `[{ document, readTime }, ...]`,
  or `[{ readTime }]` when nothing matches; an error is a one-element array.
- `:commit` with `update` (optionally `updateMask`) and `delete` writes and `currentDocument`
  preconditions, applied all or nothing, at most 500 writes. `writeResults` carry the commit time
  (an empty `{}` for a delete).

**Faithful in the details that bite:** values are compared in Firestore's cross-type order (null,
boolean, number, timestamp, string, bytes, reference, geopoint, array, map), integers and doubles
numerically, strings by UTF-8 bytes. Range filters match only values of the filter's type.
`NOT_EQUAL` and `NOT_IN` skip missing and null fields. A document missing an ordered field is left
out, so the client's default `orderBy: created_at` drops documents without one. Results follow the
explicit order, then inequality fields, then the document name. `createTime` and `updateTime` are
RFC 3339 with microseconds and strictly increase; a write that changes nothing keeps its
`updateTime`. Malformed requests get 400 `INVALID_ARGUMENT`: unknown JSON fields, a value with no
type or two, an array directly inside an array, an unquoted field path segment that is not an
identifier, a reserved `__name__`-style id or field, an empty composite filter, an unknown operator,
and a document over 1 MiB (sized by Firestore's storage-size rules).

**Not implemented** (answers 501 `UNIMPLEMENTED`, so a client that starts using one finds out):
transactions, `:batchGet` and every other `:verb` but `:runQuery` and `:commit`, field transforms,
`select`, `offset`, `startAt` and `endAt` cursors, filters on `__name__`, `IS_NAN`, response masks,
and listing with `orderBy` or `showMissing`.

**Deliberately not modelled:** composite indexes (a query that needs one works here and fails in
production with `FAILED_PRECONDITION`), security rules, quotas and the 10 MiB request limit.

**Where it differs from the real API:**

- Values come back exactly as they were sent. The real API returns canonical proto JSON: an
  `integerValue` is always a string, and a `timestampValue` is UTC `Z` with 0, 3, 6 or 9 fractional
  digits, so `2026-01-01T00:00:00.000Z` comes back as `2026-01-01T00:00:00Z` (confirmed on a live
  project). Compare timestamps as instants, never as strings.
- Server times always have six fractional digits; the real API drops trailing zero groups.
- A field present in the document but not named by the update mask is refused with 400 (unverified).

**Confirmed the same as the real API:** an `updateTime` precondition on a deleted document fails with
400 `FAILED_PRECONDITION`, which `commit()` reports as `StoreConflict`.

## Cloud Storage fake

**Supported**, with the JSON API's `{ error: { code, message, errors: [{ message, domain, reason }] } }`
bodies:

- `POST /upload/storage/v1/b/<bucket>/o?uploadType=media&name=<name>`: the object's content type is
  the request's `Content-Type`. Returns the object resource.
- `GET /storage/v1/b/<bucket>/o/<name>`: the object resource, with `generation`, `metageneration`
  and `size` as strings, `md5Hash` and `crc32c` in base64, and a `mediaLink`.
- `?alt=media` (and the `mediaLink` download path): the bytes, with `x-goog-hash`,
  `x-goog-generation` and the stored content type. A `generation` that is not current is a 404.
- `DELETE`: 204, then 404 `notFound` (`No such object: <bucket>/<name>`).
- `GET /storage/v1/b/<bucket>/o`: list with `prefix`, `delimiter` (folded names in `prefixes`),
  `maxResults` (at most 1000) and `pageToken`; an empty result is `{ kind: 'storage#objects' }`.
- A missing `name` is 400 `required`; another bucket is 404; an object name must arrive
  percent-encoded as one path segment, as the real API requires.

**Not implemented** (501): multipart and resumable uploads, `if*Match` preconditions, ranged reads,
object versions and list offsets, bucket calls, metadata updates, compose, copy and rewrite.

**Deliberately not modelled:** IAM and ACLs, signed URLs, retention, versioning, storage classes and
gzip transcoding. Unknown query parameters are ignored.
