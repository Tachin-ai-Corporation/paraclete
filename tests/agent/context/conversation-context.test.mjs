// Tests for agent/context/conversation-context.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleConversation } from '../../../agent/context/conversation-context.mjs';
import { AGENT_SENDER } from '../../../agent/providers/channel.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

/** A runQuery row as Firestore returns it. */
const row = (sender, text, ts, name) => ({
  document: {
    fields: {
      sender: { stringValue: sender },
      text: { stringValue: text },
      timestamp: { timestampValue: ts },
      ...(name ? { sender_name: { stringValue: name } } : {}),
    },
  },
});

/** Fakes Firestore runQuery; rows come back newest first, as the query orders them. */
function fakeFirestore(rows, { status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status === 200, status, json: async () => rows };
  };
  return { fetch, calls };
}

const base = { projectId: 'your-gcp-project', threadId: 'th-1', getAccessToken: async () => 'vm-token' };

test("queries only the request's thread, newest first, in the root messages collection", async () => {
  const firestore = fakeFirestore([]);
  await assembleConversation({ ...base, fetch: firestore.fetch, config: { max_turns: 5 } });
  const [call] = firestore.calls;
  assert.equal(call.url, 'https://firestore.googleapis.com/v1/projects/your-gcp-project/databases/(default)/documents:runQuery');
  assert.equal(call.init.headers.Authorization, 'Bearer vm-token');
  const q = call.body.structuredQuery;
  assert.deepEqual(q.from, [{ collectionId: COLLECTIONS.messages }]);
  assert.deepEqual(q.where.fieldFilter, { field: { fieldPath: 'thread_id' }, op: 'EQUAL', value: { stringValue: 'th-1' } });
  assert.deepEqual(q.orderBy, [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }]);
  assert.equal(q.limit, 5);
});

test('labels the named user and the agent, oldest turn first', async () => {
  const firestore = fakeFirestore([
    row(AGENT_SENDER, 'It is 42.', '2026-10-17T10:01:30Z', 'Ada'),
    row('dana@example.com', 'How many orders today?', '2026-10-17T10:01:00Z', 'Dana'),
    row('dana@example.com', 'Hello', '2026-10-17T10:00:00Z'),
  ]);
  const convo = await assembleConversation({ ...base, fetch: firestore.fetch });
  assert.deepEqual(convo.turns.map((t) => [t.role, t.name]), [['user', 'dana@example.com'], ['user', 'Dana'], ['agent', 'agent']]);
  assert.equal(convo.block, [
    '## Conversation (most recent 3 turns, oldest first)',
    '[dana@example.com 2026-10-17T10:00] Hello',
    '[Dana 2026-10-17T10:01] How many orders today?',
    '[agent 2026-10-17T10:01] It is 42.',
  ].join('\n'));
  assert.equal(convo.last_user_text, 'How many orders today?');
  assert.equal(convo.last_agent_text, 'It is 42.');
  assert.equal(convo.cue_text, 'Hello How many orders today? It is 42.');
});

test('trims long turns and drops the oldest whole turns to fit the budget', async () => {
  const firestore = fakeFirestore([
    row('dana@example.com', 'newest', '2026-10-17T10:02:00Z'),
    row(AGENT_SENDER, 'y'.repeat(100), '2026-10-17T10:01:00Z'),
    row('dana@example.com', 'oldest', '2026-10-17T10:00:00Z'),
  ]);
  const convo = await assembleConversation({ ...base, fetch: firestore.fetch, config: { per_turn_chars: 20, budget_chars: 100 } });
  assert.deepEqual(convo.turns.map((t) => t.text), [`${'y'.repeat(20)} […trimmed]`, 'newest']);
});

test('always keeps the newest turn, even over budget', async () => {
  const firestore = fakeFirestore([row('dana@example.com', 'z'.repeat(500), '2026-10-17T10:00:00Z')]);
  const convo = await assembleConversation({ ...base, fetch: firestore.fetch, config: { budget_chars: 10 } });
  assert.equal(convo.turns.length, 1);
});

test('returns null without a project, a thread, a token, messages, or a successful read', async () => {
  const empty = fakeFirestore([{ readTime: '2026-10-17T10:00:00Z' }]);
  assert.equal(await assembleConversation({ ...base, projectId: '', fetch: empty.fetch }), null);
  assert.equal(await assembleConversation({ ...base, threadId: undefined, fetch: empty.fetch }), null);
  assert.equal(empty.calls.length, 0);
  assert.equal(await assembleConversation({ ...base, getAccessToken: async () => '', fetch: empty.fetch }), null);
  assert.equal(await assembleConversation({ ...base, fetch: empty.fetch }), null);
  assert.equal(await assembleConversation({ ...base, fetch: fakeFirestore([], { status: 403 }).fetch }), null);
  assert.equal(await assembleConversation({ ...base, fetch: async () => { throw new Error('offline'); } }), null);
  assert.equal(await assembleConversation({ ...base, getAccessToken: async () => { throw new Error('no metadata'); }, fetch: empty.fetch }), null);
});
