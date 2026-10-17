// Tests for tests/fakes/firestore-server.mjs. The fake is driven through the agent's real clients
// (createClient, the git store's remote store, the dashboard channel, the conversation reader and the
// thread ledger), and through raw REST where the shape on the wire is the point, so these tests are
// also the conformance check that the clients and the fake agree on the Firestore API.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './firestore-server.mjs';
import { createClient, firestoreEncode, StoreConflict, StoreUnavailable } from '../../agent/storage/firestore.mjs';
import { createRemoteStore } from '../../agent/storage/git-store.mjs';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { initChannel, deliverToAddress } from '../../agent/providers/channel.mjs';
import { assembleConversation } from '../../agent/context/conversation-context.mjs';
import { appendTurn, readThread, compactThread, sweepThreadTurns } from '../../agent/context/thread-ledger.mjs';

const TOKEN = 'test-token';
const getAccessToken = async () => TOKEN;
const MICROS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

let fake;
let db;
let logs;
before(async () => { fake = await start(); });
after(() => fake.stop());
beforeEach(() => {
  fake.reset();
  logs = [];
  db = createClient({
    projectId: fake.projectId,
    firestoreHost: fake.origin,
    getAccessToken,
    logger: (...args) => logs.push(args.join(' ')),
  });
});

/** One raw REST call against the documents base URL. */
async function rest(method, path, body, { auth = true } = {}) {
  const res = await fetch(`${fake.url}${path}`, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const runQuery = (structuredQuery, parent = '') => rest('POST', `${parent ? `/${parent}` : ''}:runQuery`, { structuredQuery });
const ids = (rows) => rows.map((r) => r.id);

describe('documents', () => {
  test('a write is stored with its typed values exactly as sent and reads back decoded', async () => {
    const data = {
      text: 'hi', count: 3, ratio: 0.5, done: false, gone: null,
      at: new Date('2026-01-02T03:04:05.000Z'), tags: ['a', 1], nested: { deeper: { v: 'x' } },
    };
    const written = await db.write('work/w-1', { ...data });
    assert.equal(written.name, 'projects/your-gcp-project/databases/(default)/documents/work/w-1');
    assert.match(written.createTime, MICROS);
    assert.equal(written.updateTime, written.createTime);
    assert.deepEqual(fake.dump()['work/w-1'].fields, firestoreEncode(data));
    assert.deepEqual(await db.read('work/w-1'), { ...data, at: '2026-01-02T03:04:05.000Z' });
  });

  test('a missing document reads as null, and the raw 404 has the NOT_FOUND shape', async () => {
    assert.equal(await db.read('work/none', { strict: true }), null);
    assert.equal(await db.readDoc('work/none'), null);
    assert.deepEqual(await rest('GET', '/work/none'), {
      status: 404,
      body: { error: {
        code: 404,
        message: 'Document "projects/your-gcp-project/databases/(default)/documents/work/none" not found.',
        status: 'NOT_FOUND',
      } },
    });
  });

  test('createTime stays, updateTime strictly increases, and a write that changes nothing keeps it', async () => {
    const first = await db.write('work/w-2', { n: 1 });
    const second = await db.write('work/w-2', { n: 2 });
    const third = await db.write('work/w-2', { n: 2 });
    assert.equal(second.createTime, first.createTime);
    assert.ok(second.updateTime > first.updateTime);
    assert.equal(third.updateTime, second.updateTime, 'an unchanged document keeps its version');
  });

  test('patch sets only the masked fields, deletes masked fields the body omits, and creates a missing document', async () => {
    await db.write('work/p', { keep: 'k', drop: 'd', meta: { a: 1, b: 2 } });
    await db.patch('work/p', ['status', 'drop', 'meta.a'], {
      status: { stringValue: 'done' },
      meta: { mapValue: { fields: { a: { integerValue: '9' } } } },
    }, { strict: true });
    assert.deepEqual(await db.read('work/p'), { keep: 'k', meta: { a: 9, b: 2 }, status: 'done' });
    await db.patch('work/fresh', ['x'], { x: { booleanValue: true } }, { strict: true });
    assert.deepEqual(await db.read('work/fresh'), { x: true });
  });

  test('patch preconditions fail the way Firestore fails them', async () => {
    const doc = await db.write('work/pre', { n: 1 });
    const body = { fields: { n: { integerValue: '2' } } };
    const missing = await rest('PATCH', '/work/none?currentDocument.exists=true', body);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.status, 'NOT_FOUND');
    const exists = await rest('PATCH', '/work/pre?currentDocument.exists=false', body);
    assert.equal(exists.status, 409);
    assert.equal(exists.body.error.status, 'ALREADY_EXISTS');
    const stale = await rest('PATCH', '/work/pre?currentDocument.updateTime=2020-01-01T00:00:00.000001Z', body);
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error.status, 'FAILED_PRECONDITION');
    const fresh = await rest('PATCH', `/work/pre?currentDocument.updateTime=${doc.updateTime}`, body);
    assert.equal(fresh.status, 200);
    assert.deepEqual(await db.read('work/pre'), { n: 2 });
  });

  test('delete removes a document, and deleting a missing one still succeeds', async () => {
    await db.write('work/d', { n: 1 });
    assert.equal(await db.del('work/d', { strict: true }), true);
    assert.equal(await db.read('work/d'), null);
    assert.equal(await db.del('work/d', { strict: true }), true);
  });

  test('create with a documentId refuses an existing id; without one, the server picks a 20-character id', async () => {
    const body = { fields: { text: { stringValue: 'x' } } };
    assert.equal((await rest('POST', '/messages?documentId=m-1', body)).status, 200);
    const again = await rest('POST', '/messages?documentId=m-1', body);
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /^Document already exists: projects\/your-gcp-project\/.*\/messages\/m-1$/);
    const auto = await rest('POST', '/messages', body);
    assert.match(auto.body.name, /\/documents\/messages\/[A-Za-z0-9]{20}$/);
  });

  test('requests record the bearer token, and one without a token is still served', async () => {
    await db.write('work/a', { n: 1 });
    await db.read('work/a');
    assert.ok(fake.requests.every((r) => r.token === TOKEN));
    assert.equal((await rest('GET', '/work/a', undefined, { auth: false })).status, 200);
    assert.equal(fake.requests.at(-1).token, null);
  });
});

describe('commit', () => {
  test('a create-only commit succeeds once, then throws StoreConflict', async () => {
    await db.commit([{ path: 'projects/default', data: { name: 'Default' }, precondition: { exists: false } }]);
    await assert.rejects(
      db.commit([{ path: 'projects/default', data: { name: 'Other' }, precondition: { exists: false } }]),
      StoreConflict,
    );
    assert.deepEqual(await db.read('projects/default'), { name: 'Default' });
  });

  test('an updateTime precondition is compare-and-swap: the stale writer gets StoreConflict', async () => {
    await db.write('config/settings', { v: 1 });
    const seen = await db.readDoc('config/settings');
    assert.match(seen.updateTime, MICROS);
    await db.commit([{ path: 'config/settings', data: { v: 2 }, precondition: { updateTime: seen.updateTime } }]);
    await assert.rejects(
      db.commit([{ path: 'config/settings', data: { v: 3 }, precondition: { updateTime: seen.updateTime } }]),
      StoreConflict,
    );
    assert.deepEqual(await db.read('config/settings'), { v: 2 });
  });

  test('a commit is all or nothing', async () => {
    await db.write('work/b', { n: 1 });
    await assert.rejects(db.commit([
      { path: 'work/a', data: { n: 1 } },
      { path: 'work/b', data: { n: 2 }, precondition: { exists: false } },
    ]), StoreConflict);
    assert.deepEqual(Object.keys(fake.dump()), ['work/b']);
  });

  test('the response has one writeResult per write, at the commit time', async () => {
    await db.write('work/old', { n: 1 });
    const name = (path) => `projects/your-gcp-project/databases/(default)/documents/${path}`;
    const res = await rest('POST', ':commit', { writes: [
      { update: { name: name('work/new'), fields: { n: { integerValue: '1' } } } },
      { delete: name('work/old') },
    ] });
    assert.equal(res.status, 200);
    assert.match(res.body.commitTime, MICROS);
    assert.deepEqual(res.body.writeResults, [{ updateTime: res.body.commitTime }, {}]);
    assert.deepEqual(Object.keys(fake.dump()), ['work/new']);
  });

  test("the git store's ref writes report a refused precondition as PRECONDITION_FAILED", async () => {
    const remote = createRemoteStore({ firestoreHost: fake.origin, getAccessToken });
    const fields = firestoreEncode({ sha: 'a'.repeat(40) });
    assert.equal((await remote.firestoreWrite(fake.projectId, 'git_repos/r/refs/main', fields, { exists: false })).ok, true);
    const again = await remote.firestoreWrite(fake.projectId, 'git_repos/r/refs/main', fields, { exists: false });
    assert.deepEqual([again.ok, again.reason], [false, 'PRECONDITION_FAILED']);
    const ref = await remote.firestoreRead(fake.projectId, 'git_repos/r/refs/main');
    const advance = (sha) => remote.firestoreWrite(fake.projectId, 'git_repos/r/refs/main', firestoreEncode({ sha }), { updateTime: ref.updateTime });
    assert.equal((await advance('b'.repeat(40))).ok, true);
    const stale = await advance('c'.repeat(40));
    assert.deepEqual([stale.ok, stale.reason], [false, 'PRECONDITION_FAILED']);
    assert.match(stale.detail, /FAILED_PRECONDITION/);
  });
});

describe('queries', () => {
  async function seedWork() {
    await db.write('work/m1', { created_at: '2026-01-01', type: 'M', status: 'running', project_id: 'p1', depends_on: [], source_meta: { responsibility_id: 'r1' } });
    await db.write('work/m2', { created_at: '2026-01-03', type: 'M', status: 'pending', project_id: 'p1', depends_on: ['m1'], source_meta: { responsibility_id: 'r2' } });
    await db.write('work/m3', { created_at: '2026-01-02', type: 'M', status: 'done', project_id: 'p2', depends_on: ['m1', 'm2'] });
    await db.write('work/t1', { type: 'T', status: 'running', project_id: 'p1' }); // no created_at
  }
  const str = (s) => ({ stringValue: s });
  const anyOf = (...values) => ({ arrayValue: { values: values.map(str) } });

  test("the work, project and scheduler filters select what they should", async () => {
    await seedWork();
    const open = await db.query('', 'work', [
      { field: 'project_id', op: 'EQUAL', value: str('p1') },
      { field: 'type', op: 'EQUAL', value: str('M') },
      { field: 'status', op: 'IN', value: anyOf('running', 'pending') },
    ], { noOrderBy: true, strict: true });
    assert.deepEqual(ids(open), ['m1', 'm2']);
    const waiting = await db.query('', 'work', [
      { field: 'depends_on', op: 'ARRAY_CONTAINS', value: str('m1') },
      { field: 'status', op: 'EQUAL', value: str('pending') },
    ], { noOrderBy: true, strict: true });
    assert.deepEqual(ids(waiting), ['m2']);
    const cycle = await db.query('', 'work', [{ field: 'source_meta.responsibility_id', op: 'EQUAL', value: str('r2') }], { noOrderBy: true, strict: true });
    assert.deepEqual(ids(cycle), ['m2']);
  });

  test('ordering by created_at (the default) leaves out documents without it, as Firestore does', async () => {
    await seedWork();
    const ordered = await db.query('', 'work', [{ field: 'status', op: 'EQUAL', value: str('running') }], { strict: true });
    assert.deepEqual(ids(ordered), ['m1'], 't1 has no created_at');
    const unordered = await db.query('', 'work', [{ field: 'status', op: 'EQUAL', value: str('running') }], { noOrderBy: true, strict: true });
    assert.deepEqual(ids(unordered), ['m1', 't1']);
  });

  test('DESCENDING with a limit, and document-name order when no order is given', async () => {
    await seedWork();
    assert.deepEqual(ids(await db.query('', 'work', [], { orderDirection: 'DESCENDING', limit: 2, strict: true })), ['m2', 'm3']);
    assert.deepEqual(ids(await db.query('', 'work', [], { noOrderBy: true, strict: true })), ['m1', 'm2', 'm3', 't1']);
  });

  test('values order across types as Firestore orders them, and range filters match one type only', async () => {
    const values = {
      a: null, b: false, c: true, d: 10, e: 9, f: 9.5, g: new Date('2026-01-01T00:00:00Z'),
      h: '5', i: 'a', j: [1], k: { a: 1 },
    };
    for (const [id, v] of Object.entries(values)) await db.write(`mixed/${id}`, { v });
    const all = await db.query('', 'mixed', [], { orderBy: 'v', strict: true });
    assert.deepEqual(ids(all), ['a', 'b', 'c', 'e', 'f', 'd', 'g', 'h', 'i', 'j', 'k'], 'integer 10 sorts after 9.5, not as the string "10"');
    const numbers = await db.query('', 'mixed', [{ field: 'v', op: 'GREATER_THAN', value: { integerValue: '0' } }], { orderBy: 'v', strict: true });
    assert.deepEqual(ids(numbers), ['e', 'f', 'd'], 'the string "5" is not greater than 0');
    const strings = await db.query('', 'mixed', [{ field: 'v', op: 'LESS_THAN_OR_EQUAL', value: { stringValue: 'a' } }], { orderBy: 'v', strict: true });
    assert.deepEqual(ids(strings), ['h', 'i']);
  });

  test('NOT_EQUAL and NOT_IN skip missing and null fields; ARRAY_CONTAINS_ANY matches any element', async () => {
    await db.write('c/1', { s: 'x', tags: ['a'] });
    await db.write('c/2', { s: 'y', tags: ['b', 'c'] });
    await db.write('c/3', { s: null });
    await db.write('c/4', { other: 1 });
    assert.deepEqual(ids(await db.query('', 'c', [{ field: 's', op: 'NOT_EQUAL', value: str('x') }], { noOrderBy: true, strict: true })), ['2']);
    assert.deepEqual(ids(await db.query('', 'c', [{ field: 's', op: 'NOT_IN', value: anyOf('y') }], { noOrderBy: true, strict: true })), ['1']);
    assert.deepEqual(ids(await db.query('', 'c', [{ field: 'tags', op: 'ARRAY_CONTAINS_ANY', value: anyOf('c', 'z') }], { noOrderBy: true, strict: true })), ['2']);
  });

  test('an inequality filter orders by its own field when no order is given', async () => {
    for (const [id, n] of [['a', 3], ['b', 1], ['c', 2], ['d', 0]]) await db.write(`n/${id}`, { n });
    const rows = await db.query('', 'n', [{ field: 'n', op: 'GREATER_THAN', value: { integerValue: '0' } }], { noOrderBy: true, strict: true });
    assert.deepEqual(ids(rows), ['b', 'c', 'a']);
  });

  test("a subcollection query sees only its parent's documents", async () => {
    await db.write('threads/t1/turns/1', { ts: new Date('2026-01-01T00:00:01Z') });
    await db.write('threads/t1/turns/2', { ts: new Date('2026-01-01T00:00:02Z') });
    await db.write('threads/t2/turns/3', { ts: new Date('2026-01-01T00:00:03Z') });
    assert.deepEqual(ids(await db.query('threads/t1', 'turns', [], { orderBy: 'ts', orderDirection: 'DESCENDING', strict: true })), ['2', '1']);
    assert.deepEqual(await db.query('', 'turns', [], { orderBy: 'ts', strict: true }), [], 'a root query does not reach subcollections');
  });

  test('an empty result is one entry holding only readTime', async () => {
    const res = await runQuery({ from: [{ collectionId: 'nothing' }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.deepEqual(Object.keys(res.body[0]), ['readTime']);
    assert.match(res.body[0].readTime, MICROS);
  });
});

describe('malformed requests are refused with 400, as the real API refuses them', () => {
  test('unknown fields, a value with two types, a misspelled operator and an empty composite filter', async () => {
    const unknown = await rest('PATCH', '/work/x', { field: { n: { integerValue: '1' } } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error.message, /Unknown name "field"/);
    assert.equal((await rest('PATCH', '/work/x', { fields: { n: { stringValue: 'a', integerValue: '1' } } })).status, 400);
    await assert.rejects(
      db.query('', 'work', [{ field: 'status', op: 'EQUALS', value: { stringValue: 'x' } }], { strict: true }),
      (e) => e instanceof StoreUnavailable && e.status === 400,
    );
    const empty = await runQuery({ from: [{ collectionId: 'work' }], where: { compositeFilter: { op: 'AND', filters: [] } } });
    assert.equal(empty.status, 400);
    assert.ok(Array.isArray(empty.body), 'a streamed runQuery error arrives as a one-element array');
    assert.equal(empty.body[0].error.status, 'INVALID_ARGUMENT');
  });

  test('a mask segment that is not an identifier must be quoted, and the client quotes it', async () => {
    const fields = { 'odd-name': { stringValue: 'x' } };
    const unquoted = await rest('PATCH', '/work/q?updateMask.fieldPaths=odd-name', { fields });
    assert.equal(unquoted.status, 400, 'the API refuses an unquoted non-identifier segment');
    await db.patch('work/q', ['odd-name'], fields, { strict: true });
    assert.deepEqual(await db.read('work/q'), { 'odd-name': 'x' });
  });

  test('an array directly inside an array is refused by the API, and the client refuses it first', async () => {
    const raw = await rest('PATCH', '/work/grid', { fields: { grid: { arrayValue: { values: [{ arrayValue: { values: [] } }] } } } });
    assert.equal(raw.status, 400);
    assert.match(JSON.stringify(raw.body), /array value in an array value/);
    await assert.rejects(db.write('work/grid', { grid: [[1, 2]] }, { strict: true }), /cannot store an array directly inside an array/);
    assert.notEqual(await db.write('work/grid', { grid: [{ row: [1, 2] }] }, { strict: true }), null, 'an array in a map in an array is fine');
  });

  test("a document over 1 MiB is refused; the client's output trim keeps an envelope under the limit", async () => {
    await assert.rejects(db.write('work/big', { blob: 'x'.repeat(1_100_000) }, { strict: true }),
      (e) => e.status === 400 && /cannot be written because its size \(1,100,063 bytes\)/.test(e.message));
    await db.write('work/out', { output: 'x'.repeat(1_100_000) }, { strict: true });
    assert.ok((await db.read('work/out')).output.length < 1_000_000);
  });

  test('a feature the fake does not implement answers 501, never a guess', async () => {
    const batchGet = await rest('POST', ':batchGet', { documents: [] });
    assert.equal(batchGet.status, 501);
    assert.equal(batchGet.body.error.status, 'UNIMPLEMENTED');
    const offset = await runQuery({ from: [{ collectionId: 'work' }], offset: 1 });
    assert.equal(offset.status, 501);
  });
});

describe('listing documents', () => {
  test("the git store lists every ref across pages; a missing collection is empty", async () => {
    const writes = Array.from({ length: 301 }, (_, i) => ({ path: `git_repos/r/refs/b${String(i).padStart(3, '0')}`, data: { sha: null } }));
    await db.commit(writes);
    const remote = createRemoteStore({ firestoreHost: fake.origin, getAccessToken });
    const listed = await remote.firestoreList(fake.projectId, 'git_repos/r/refs');
    assert.equal(listed.length, 301);
    assert.equal(listed[0].name.split('/').pop(), 'b000');
    assert.equal(listed.at(-1).name.split('/').pop(), 'b300');
    assert.equal(fake.requests.filter((r) => r.method === 'GET').length, 2, 'two pages of 300');
    assert.deepEqual(await remote.firestoreList(fake.projectId, 'git_repos/none/refs'), []);
  });

  test('raw pages carry nextPageToken until the last one, and an empty collection is {}', async () => {
    for (const id of ['a', 'b', 'c']) await db.write(`l/${id}`, { n: 1 });
    const first = await rest('GET', '/l?pageSize=2');
    assert.deepEqual(first.body.documents.map((d) => d.name.split('/').pop()), ['a', 'b']);
    const second = await rest('GET', `/l?pageSize=2&pageToken=${first.body.nextPageToken}`);
    assert.deepEqual(second.body.documents.map((d) => d.name.split('/').pop()), ['c']);
    assert.equal(second.body.nextPageToken, undefined);
    assert.deepEqual((await rest('GET', '/empty')).body, {});
  });
});

describe('agent readers and writers, end to end', () => {
  test('a dashboard delivery gets a server-picked id, and the conversation reader finds it', async () => {
    const t0 = Date.parse('2026-03-01T10:00:00Z');
    await db.write(`${COLLECTIONS.messages}/u-1`, {
      text: 'Can you summarize the plan?', sender: 'user@example.com', sender_name: 'User',
      thread_id: 'thread-1', timestamp: new Date(t0),
    });
    await db.write(`${COLLECTIONS.messages}/u-2`, { text: 'other thread', sender: 'user@example.com', thread_id: 'thread-2', timestamp: new Date(t0) });
    initChannel({ firestoreUrl: fake.url, collections: COLLECTIONS, agentName: 'Agent', now: () => t0 + 60_000 });
    assert.equal(await deliverToAddress({ channel: 'dashboard', thread: 'thread-1' }, 'Here is the plan.', { token: TOKEN }), true);
    const created = Object.keys(fake.dump()).filter((p) => !/u-\d$/.test(p));
    assert.equal(created.length, 1);
    assert.match(created[0], /^messages\/[A-Za-z0-9]{20}$/);

    // conversation-context builds the production URL itself, so the test reroutes its fetch.
    const reroute = (url, init) => fetch(String(url).replace('https://firestore.googleapis.com', fake.origin), init);
    const convo = await assembleConversation({ projectId: fake.projectId, threadId: 'thread-1', getAccessToken, fetch: reroute });
    assert.deepEqual(convo.turns.map((t) => [t.role, t.text]), [['user', 'Can you summarize the plan?'], ['agent', 'Here is the plan.']]);
  });

  test('the thread ledger appends, compacts, sweeps and reads back', async () => {
    const t0 = Date.parse('2026-02-01T08:00:00Z');
    const config = { max_turns: 2, compact_after_turns: 3, turn_retention_days: 1 };
    for (let i = 0; i < 6; i += 1) {
      const stored = await appendTurn({
        db, threadKey: 'thread-9', turnId: `msg-${i}`, role: i % 2 ? 'agent' : 'user', name: 'User',
        text: `turn ${i}`, config, clock: () => t0 + i * 60_000,
      });
      assert.equal(stored, true);
    }
    assert.equal(fake.dump()['threads/thread-9'].fields.last_turn_at.timestampValue, new Date(t0 + 5 * 60_000).toISOString());

    const folded = await compactThread({ db, threadKey: 'thread-9', config, summarize: async () => 'Summary of turns 0-3.' });
    assert.equal(folded, true);
    assert.equal((await db.read('threads/thread-9')).summary_through_ts, new Date(t0 + 3 * 60_000).toISOString());

    const swept = await sweepThreadTurns({ db, config, clock: () => t0 + 30 * 86_400_000 });
    assert.equal(swept, 4, 'the four folded turns are past retention');
    const thread = await readThread({ db, threadKey: 'thread-9', config });
    assert.match(thread.block, /Summary of turns 0-3\./);
    assert.deepEqual(thread.turns.map((t) => t.text), ['turn 4', 'turn 5']);
  });
});
