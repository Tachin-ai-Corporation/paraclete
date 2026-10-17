// Tests for agent/services/ears/dashboard-inbox.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardInbox } from '../../../../agent/services/ears/dashboard-inbox.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { fakeDb } from './fake-db.mjs';

// The dashboard's message shape: text, timestamp (a Firestore timestamp), processed, sender,
// sender_name, thread_id, attachments.
const message = (over = {}) => ({
  text: 'Draft the plan', timestamp: new Date('2026-10-17T12:00:00Z'), processed: false,
  sender: 'ana@example.com', sender_name: 'Ana', thread_id: 'th-ana', attachments: [], ...over,
});

test('unprocessed messages come back oldest first, each addressed to its own thread', async () => {
  const db = fakeDb({
    'messages/b': message({ text: 'second', timestamp: new Date('2026-10-17T12:00:05Z'), sender: 'ben@example.com', sender_name: 'Ben', thread_id: 'th-ben' }),
    'messages/a': message({ text: 'first', attachments: [{ name: 'q3.pdf', size: 10, gcsPath: 'files/in/u-1/q3.pdf' }] }),
    'messages/done': message({ processed: true }),
  });
  const inbox = createDashboardInbox({ db, collections: COLLECTIONS });
  const got = await inbox.poll();
  assert.deepEqual(got, [
    {
      channel: 'dashboard', id: 'a', text: 'first', rawText: 'first', timestamp: '2026-10-17T12:00:00.000Z',
      sender: 'ana@example.com', senderName: 'Ana', address: { channel: 'dashboard', thread: 'th-ana' },
      attachments: [{ name: 'q3.pdf', size: 10, gcsPath: 'files/in/u-1/q3.pdf' }],
    },
    {
      channel: 'dashboard', id: 'b', text: 'second', rawText: 'second', timestamp: '2026-10-17T12:00:05.000Z',
      sender: 'ben@example.com', senderName: 'Ben', address: { channel: 'dashboard', thread: 'th-ben' }, attachments: [],
    },
  ]);
});

test('messages are ordered by instant, not by how many fractional digits their timestamp has', async () => {
  // Stored as Firestore returns them: a whole second has no fractional digits.
  const db = fakeDb();
  db.docs.set('messages/later', { ...message({ text: 'later' }), timestamp: '2026-10-17T12:00:00.5Z' });
  db.docs.set('messages/earlier', { ...message({ text: 'earlier' }), timestamp: '2026-10-17T12:00:00Z' });
  const got = await createDashboardInbox({ db, collections: COLLECTIONS }).poll();
  assert.deepEqual(got.map((m) => m.id), ['earlier', 'later']);
});

test('consume marks only the processed field', async () => {
  const db = fakeDb({ 'messages/a': message() });
  const inbox = createDashboardInbox({ db, collections: COLLECTIONS });
  await inbox.consume({ id: 'a' });
  assert.deepEqual(db.get('messages/a'), { ...message(), timestamp: '2026-10-17T12:00:00.000Z', processed: true });
});

test("the agent's own messages and empty messages leave the unprocessed set instead of clogging it", async () => {
  const db = fakeDb({
    'messages/mine': message({ sender: 'agent', text: 'a reply that lost its processed flag' }),
    'messages/empty': message({ text: '   ' }),
    'messages/files': message({ text: '', attachments: [{ name: 'a.csv', size: 1, gcsPath: 'files/in/u-2/a.csv' }] }),
  });
  const inbox = createDashboardInbox({ db, collections: COLLECTIONS });
  const got = await inbox.poll();
  assert.deepEqual(got.map((m) => m.id), ['files'], 'files alone are a message');
  assert.equal(db.get('messages/mine').processed, true);
  assert.equal(db.get('messages/empty').processed, true);
  assert.deepEqual(await inbox.poll().then((m) => m.map((x) => x.id)), ['files']);
});

test('a message without a thread still arrives, with a threadless address', async () => {
  const db = fakeDb({ 'messages/a': message({ thread_id: null }) });
  const logs = [];
  const got = await createDashboardInbox({ db, collections: COLLECTIONS, log: (...a) => logs.push(a) }).poll();
  assert.deepEqual(got[0].address, { channel: 'dashboard', thread: null });
  assert.match(logs[0][1], /no thread_id/);
});

test('an outage throws instead of reading as a quiet chat', async () => {
  const db = fakeDb();
  db.fail('query');
  await assert.rejects(createDashboardInbox({ db, collections: COLLECTIONS }).poll(), StoreUnavailable);
});

test('the query needs no composite index: one equality filter, no ordering', async () => {
  const db = fakeDb();
  const seen = [];
  const spy = { ...db, query: async (...args) => { seen.push(args); return []; } };
  await createDashboardInbox({ db: spy, collections: COLLECTIONS }).poll();
  const [parent, collection, filters, opts] = seen[0];
  assert.equal(parent, '');
  assert.equal(collection, 'messages');
  assert.deepEqual(filters, [{ field: 'processed', op: 'EQUAL', value: { booleanValue: false } }]);
  assert.equal(opts.noOrderBy, true);
  assert.equal(opts.strict, true);
});
