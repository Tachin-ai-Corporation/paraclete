// Tests for dev/query.mjs: filters, order, limit, subcollections and single documents read through the
// real Firestore client against the fake; typed values; and that it never writes: options that would
// are refused, its client can only read, and nothing but reads and queries ever reaches Firestore.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { main, parseWhere, readOnly, splitCollectionPath, typedValue } from '../../dev/query.mjs';
import { DEV_TOKEN, devDeps, fakeExec } from './fakes.mjs';

let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(async () => {
  firestore.reset();
  await db.write('work/w-1', { type: 'M', status: 'complete', iteration: 3, created_at: '2026-10-17T10:01:00.000Z', source_meta: { sender: 'a@example.com' } });
  await db.write('work/w-2', { type: 'M', status: 'active', iteration: 1, created_at: '2026-10-17T10:02:00.000Z', source_meta: { sender: 'b@example.com' } });
  await db.write('work/w-3', { type: 'T', status: 'complete', iteration: 0, created_at: '2026-10-17T10:03:00.000Z' });
  await db.write('work/w-1/history/h-1', { new_status: 'complete', created_at: '2026-10-17T10:05:00.000Z' });
});

async function query(argv) {
  const deps = devDeps({ firestore, exec: fakeExec() });
  const exit = await main(argv, deps);
  let json = null;
  try { json = JSON.parse(deps.stdout.text); } catch { /* not JSON */ }
  return { exit, json, out: deps.stdout.text, err: deps.stderr.text };
}

test('values are typed: booleans and numbers by their look, anything else a string, prefixes to choose', () => {
  assert.deepEqual(typedValue('true'), { booleanValue: true });
  assert.deepEqual(typedValue('42'), { integerValue: '42' });
  assert.deepEqual(typedValue('-1.5'), { doubleValue: -1.5 });
  assert.deepEqual(typedValue('complete'), { stringValue: 'complete' });
  assert.deepEqual(typedValue('str:42'), { stringValue: '42' });
  assert.deepEqual(typedValue('int:7'), { integerValue: '7' });
  assert.deepEqual(typedValue('num:2'), { doubleValue: 2 });
  assert.deepEqual(typedValue('bool:false'), { booleanValue: false });
  assert.deepEqual(typedValue('ts:2026-10-17T12:00:00Z'), { timestampValue: '2026-10-17T12:00:00.000Z' });
  assert.deepEqual(typedValue('str:'), { stringValue: '' });
  assert.throws(() => typedValue('int:x'), /'x' is not a valid int: value/);
  assert.throws(() => typedValue('null'), /IS_NULL/);
});

test('a --where reads field, operator and value', () => {
  assert.deepEqual(parseWhere('status=complete'), { field: 'status', op: 'EQUAL', value: { stringValue: 'complete' } });
  assert.deepEqual(parseWhere('status==complete').op, 'EQUAL');
  assert.deepEqual(parseWhere('source_meta.sender!=a@example.com'), { field: 'source_meta.sender', op: 'NOT_EQUAL', value: { stringValue: 'a@example.com' } });
  assert.deepEqual(parseWhere('iteration>=3'), { field: 'iteration', op: 'GREATER_THAN_OR_EQUAL', value: { integerValue: '3' } });
  assert.deepEqual(parseWhere('iteration<3').op, 'LESS_THAN');
  assert.deepEqual(parseWhere('text=a=b').value, { stringValue: 'a=b' }, 'only the first operator splits');
  assert.throws(() => parseWhere('=x'), /needs <field><op><value>/);
  assert.throws(() => parseWhere('status'), /needs <field><op><value>/);
  assert.throws(() => parseWhere('a b=c'), /'a b' is not a field name/);
});

test('a collection path names a root collection or a subcollection', () => {
  assert.deepEqual(splitCollectionPath('work'), { parent: '', collection: 'work' });
  assert.deepEqual(splitCollectionPath('work/w-1/history'), { parent: 'work/w-1', collection: 'history' });
  assert.throws(() => splitCollectionPath('work/w-1'), /is not a collection/);
  assert.throws(() => splitCollectionPath('work//history'), /is not a collection/);
  assert.throws(() => splitCollectionPath('../work'), /is not a collection/);
});

test('a filtered, ordered, limited query prints the matching documents with their ids', async () => {
  const r = await query(['work', '--where', 'type=M', '--order', 'created_at', 'desc', '--limit', '5']);
  assert.equal(r.exit, 0, r.err);
  assert.deepEqual(r.json.map((d) => [d.id, d.status]), [['w-2', 'active'], ['w-1', 'complete']]);
  assert.equal(r.json[0].source_meta.sender, 'b@example.com');

  const ranged = await query(['work', '--where', 'iteration>=1', '--where', 'status=complete']);
  assert.deepEqual(ranged.json.map((d) => d.id), ['w-1']);

  const limited = await query(['work', '--limit', '2']);
  assert.equal(limited.json.length, 2);
  assert.match(limited.err, /showing the first 2; raise --limit for more/);
});

test('--doc reads one document; a subcollection is queried under its parent', async () => {
  const doc = await query(['work', '--doc', 'w-3']);
  assert.equal(doc.exit, 0);
  assert.deepEqual(doc.json, { id: 'w-3', type: 'T', status: 'complete', iteration: 0, created_at: '2026-10-17T10:03:00.000Z' });
  const missing = await query(['work', '--doc', 'w-404']);
  assert.equal(missing.exit, 1);
  assert.match(missing.err, /work\/w-404 does not exist/);
  const history = await query(['work/w-1/history']);
  assert.deepEqual(history.json.map((d) => d.id), ['h-1']);
  assert.match((await query(['workk'])).err, /'workk' is not a collection paraclete uses/);
});

test('nothing that would write is accepted, and only reads and queries ever reach Firestore', async () => {
  const before = firestore.requests.length;
  for (const argv of [['work', '--set', 'status=done'], ['work', '--doc', 'w-1', '--delete'], ['work', '--update=status=x'], ['work', '--patch', 'x'], ['work', '--create', 'x']]) {
    const r = await query(argv);
    assert.equal(r.exit, 2, argv.join(' '));
    assert.match(r.err, /dev\/query only reads\. Changing an instance by hand is not allowed/, argv.join(' '));
  }
  assert.equal(firestore.requests.length, before, 'a refused command sends nothing');

  await query(['work', '--where', 'type=M', '--order', 'created_at']);
  await query(['work', '--doc', 'w-1']);
  await query(['work/w-1/history', '--limit', '3']);
  const sent = firestore.requests.slice(before);
  assert.ok(sent.length >= 3);
  for (const r of sent) {
    assert.ok(r.method === 'GET' || (r.method === 'POST' && r.path.endsWith(':runQuery')), `${r.method} ${r.path}`);
    assert.equal(r.token, DEV_TOKEN);
  }

  const facade = readOnly(db);
  assert.deepEqual(Object.keys(facade).sort(), ['query', 'read']);
  assert.ok(Object.isFrozen(facade));
});

test('usage mistakes exit 2', async () => {
  for (const argv of [[], ['work', 'messages'], ['work', '--limit', '0'], ['work', '--limit', '5000'], ['work', '--doc', 'w-1', '--where', 'a=b'], ['work', '--order'], ['work', '--frobnicate']]) {
    assert.equal((await query(argv)).exit, 2, argv.join(' '));
  }
});
