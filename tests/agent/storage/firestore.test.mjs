// Tests for agent/storage/firestore.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClient,
  firestoreEncode,
  firestoreDecode,
  StoreUnavailable,
  StoreConflict,
} from '../../../agent/storage/firestore.mjs';

const DOCS = 'https://firestore.googleapis.com/v1/projects/your-gcp-project/databases/(default)/documents';

/** Fakes the Firestore REST API: each call takes the next scripted response. */
function fakeFirestore(responses = []) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift() || { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  return { fetch, calls };
}

function client(server, extra = {}) {
  const logs = [];
  const db = createClient({
    projectId: 'your-gcp-project',
    fetch: server.fetch,
    getAccessToken: async () => 'test-token',
    logger: (...args) => logs.push(args.join(' ')),
    ...extra,
  });
  return { db, logs };
}

test('encodes and decodes every value type the client writes', () => {
  const when = new Date('2026-01-02T03:04:05.000Z');
  const input = {
    text: 'hello',
    count: 3,
    ratio: 0.5,
    done: false,
    missing: null,
    at: when,
    tags: ['a', 1, true, null],
    nested: { deeper: { value: 'x' } },
  };
  const fields = firestoreEncode(input);
  assert.deepEqual(fields.count, { integerValue: '3' });
  assert.deepEqual(fields.ratio, { doubleValue: 0.5 });
  assert.deepEqual(fields.at, { timestampValue: '2026-01-02T03:04:05.000Z' });
  assert.deepEqual(firestoreDecode(fields), { ...input, at: '2026-01-02T03:04:05.000Z' });
});

test('undefined is stored as null', () => {
  assert.deepEqual(firestoreEncode({ gone: undefined }), { gone: { nullValue: null } });
});

test('nested arrays decode with their real values, not as strings', () => {
  // The decoder used to flatten an array inside an array to stringValue || integerValue || '', so
  // [[1, 2]] came back as [['1', '2']] and maps or zeros inside it became ''.
  const input = { grid: [[1, 0, 2], [{ cell: 'x' }, false, 'y']] };
  assert.deepEqual(firestoreDecode(firestoreEncode(input)), input);
});

test('createClient requires a project', () => {
  assert.throws(() => createClient({}), /projectId is required/);
});

test('reads a document with the injected token and decodes it', async () => {
  const server = fakeFirestore([{ status: 200, body: { fields: { status: { stringValue: 'running' } } } }]);
  const { db } = client(server);
  assert.deepEqual(await db.read('work/w-1'), { status: 'running' });
  assert.equal(server.calls[0].url, `${DOCS}/work/w-1`);
  assert.equal(server.calls[0].init.headers.Authorization, 'Bearer test-token');
});

test('a 404 is absence, not an outage, even for a strict caller', async () => {
  const server = fakeFirestore([{ status: 404, body: 'not found' }, { status: 404, body: 'not found' }]);
  const { db } = client(server);
  assert.equal(await db.read('work/w-1'), null);
  assert.equal(await db.read('work/w-1', { strict: true }), null);
});

test('a strict read throws StoreUnavailable on any other failure', async () => {
  const server = fakeFirestore([{ status: 500, body: 'boom' }]);
  const { db } = client(server);
  await assert.rejects(db.read('work/w-1', { strict: true }), (e) => e instanceof StoreUnavailable && e.status === 500);
});

test('a permissive read returns null on failure but logs it', async () => {
  const server = fakeFirestore([{ status: 403, body: 'denied' }]);
  const { db, logs } = client(server);
  assert.equal(await db.read('work/w-1'), null);
  assert.match(logs.join('\n'), /Firestore read failed: 403 work\/w-1/);
});

test('a strict query throws instead of returning an empty list', async () => {
  const strict = client(fakeFirestore([{ status: 503, body: 'down' }])).db;
  await assert.rejects(strict.query('', 'work', [], { strict: true }), StoreUnavailable);
  const permissive = client(fakeFirestore([{ status: 503, body: 'down' }])).db;
  assert.deepEqual(await permissive.query('', 'work', []), []);
});

test('strict write, patch and delete throw StoreUnavailable; permissive ones return null or false', async () => {
  const strict = client(fakeFirestore([
    { status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' },
  ])).db;
  await assert.rejects(strict.write('work/w-1', { a: 1 }, { strict: true }), StoreUnavailable);
  await assert.rejects(strict.patch('work/w-1', ['a'], {}, { strict: true }), StoreUnavailable);
  await assert.rejects(strict.del('work/w-1', { strict: true }), StoreUnavailable);

  const permissive = client(fakeFirestore([
    { status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' },
  ])).db;
  assert.equal(await permissive.write('work/w-1', { a: 1 }), null);
  assert.equal(await permissive.patch('work/w-1', ['a'], {}), null);
  assert.equal(await permissive.del('work/w-1'), false);
});

test('an unfiltered query omits `where`; filters are ANDed; ordering is optional', async () => {
  const server = fakeFirestore([
    { status: 200, body: [{ document: { name: `${DOCS}/work/w-1`, fields: { a: { integerValue: '1' } } } }, { readTime: 'x' }] },
    { status: 200, body: [] },
  ]);
  const { db } = client(server);
  assert.deepEqual(await db.query('', 'work', []), [{ id: 'w-1', a: 1 }]);
  const unfiltered = server.calls[0].body.structuredQuery;
  assert.equal(server.calls[0].url, `${DOCS}:runQuery`);
  assert.equal('where' in unfiltered, false);
  assert.deepEqual(unfiltered.orderBy, [{ field: { fieldPath: 'created_at' }, direction: 'ASCENDING' }]);
  assert.equal(unfiltered.limit, 300);

  const filter = { field: 'status', op: 'EQUAL', value: { stringValue: 'running' } };
  await db.query('projects/p-1', 'promotions', [filter], { noOrderBy: true, limit: 5 });
  const filtered = server.calls[1].body.structuredQuery;
  assert.equal(server.calls[1].url, `${DOCS}/projects/p-1:runQuery`);
  assert.equal(filtered.where.compositeFilter.op, 'AND');
  assert.equal(filtered.where.compositeFilter.filters[0].fieldFilter.field.fieldPath, 'status');
  assert.equal('orderBy' in filtered, false);
  assert.equal(filtered.limit, 5);
});

test('a query result takes its id from the document path, never from a stored id field', async () => {
  const server = fakeFirestore([
    { status: 200, body: [{ document: { name: `${DOCS}/projects/real-id`, fields: { id: { stringValue: 'stale-id' }, name: { stringValue: 'Site' } } } }] },
  ]);
  const { db } = client(server);
  assert.deepEqual(await db.query('', 'projects', []), [{ id: 'real-id', name: 'Site' }]);
});

test('patch sends the field mask', async () => {
  const server = fakeFirestore([{ status: 200, body: {} }]);
  const { db } = client(server);
  await db.patch('work/w-1', ['status', 'updated_at'], { status: { stringValue: 'done' } });
  assert.equal(server.calls[0].url, `${DOCS}/work/w-1?updateMask.fieldPaths=status&updateMask.fieldPaths=updated_at`);
  assert.equal(server.calls[0].init.method, 'PATCH');
});

test('readDoc returns the update time, null for a 404, and throws on any other failure', async () => {
  const server = fakeFirestore([
    { status: 200, body: { fields: { a: { stringValue: 'b' } }, updateTime: 't-1' } },
    { status: 404, body: 'missing' },
    { status: 500, body: 'boom' },
  ]);
  const { db } = client(server);
  assert.deepEqual(await db.readDoc('work/w-1'), { data: { a: 'b' }, updateTime: 't-1' });
  assert.equal(await db.readDoc('work/w-2'), null);
  await assert.rejects(db.readDoc('work/w-3'), StoreUnavailable);
});

test('commit sends preconditions and maps a refused precondition to StoreConflict', async () => {
  const server = fakeFirestore([
    { status: 200, body: { writeResults: [] } },
    { status: 409, body: 'conflict' },
    { status: 400, body: 'FAILED_PRECONDITION: the stored version does not match' },
    { status: 500, body: 'boom' },
  ]);
  const { db } = client(server);
  await db.commit([{ path: 'work/w-1', data: { a: 1 }, precondition: { exists: false } }]);
  const [write] = server.calls[0].body.writes;
  assert.equal(server.calls[0].url, `${DOCS}:commit`);
  assert.equal(write.update.name, 'projects/your-gcp-project/databases/(default)/documents/work/w-1');
  assert.deepEqual(write.currentDocument, { exists: false });

  await assert.rejects(db.commit([{ path: 'work/w-1', data: {} }]), StoreConflict);
  await assert.rejects(db.commit([{ path: 'work/w-1', data: {}, precondition: { updateTime: 't' } }]), StoreConflict);
  await assert.rejects(db.commit([{ path: 'work/w-1', data: {} }]), StoreUnavailable);
});

test('every call carries a timeout signal', async () => {
  // A hung connection with no timeout blocks the caller's poll tick forever.
  const server = fakeFirestore([
    { status: 200, body: { fields: {} } }, { status: 200, body: {} }, { status: 200, body: [] },
    { status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: { fields: {} } },
    { status: 200, body: {} },
  ]);
  const { db } = client(server);
  await db.read('work/w-1');
  await db.write('work/w-1', { a: 1 });
  await db.query('', 'work', []);
  await db.patch('work/w-1', ['a'], {});
  await db.del('work/w-1');
  await db.readDoc('work/w-1');
  await db.commit([{ path: 'work/w-1', data: {} }]);
  assert.equal(server.calls.length, 7);
  for (const call of server.calls) assert.ok(call.init.signal instanceof AbortSignal, `${call.url} has no timeout`);
});

test('write trims an oversized output and says what was dropped, without claiming it was saved', async () => {
  const server = fakeFirestore([{ status: 200, body: {} }]);
  const { db } = client(server);
  const data = { output: 'x'.repeat(800_010) };
  await db.write('work/w-1', data);
  const stored = server.calls[0].body.fields.output.stringValue;
  assert.ok(stored.startsWith('x'.repeat(800_000)));
  assert.match(stored, /\[TRUNCATED at the Firestore document size limit: 10 chars dropped\]$/);
  assert.doesNotMatch(stored, /saved to/);
  assert.equal(data.output, stored, "the caller's copy matches what was stored");
});

test('write keeps the head and tail of an oversized accumulated context', async () => {
  const server = fakeFirestore([{ status: 200, body: {} }]);
  const { db } = client(server);
  const acc = `HEAD${'m'.repeat(500_000)}TAIL`;
  await db.write('work/w-1', { _accumulated_context: acc });
  const stored = server.calls[0].body.fields._accumulated_context.stringValue;
  assert.ok(stored.startsWith('HEAD'));
  assert.ok(stored.endsWith('TAIL'));
  assert.match(stored, /chars elided at Firestore size guard/);
  assert.ok(stored.length < 401_000);
});
