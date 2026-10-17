// Tests for agent/services/ears/chat-inbox.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatInbox } from '../../../../agent/services/ears/chat-inbox.mjs';

const AGENT = 'users/900';
const NOW = Date.parse('2026-10-17T12:00:00Z');
const T = (minutes) => new Date(NOW + minutes * 60_000).toISOString();

/** A Chat API fake: spaces of messages, listed newest first, 25 per page, page tokens as offsets. */
function fakeChat(spaces, { failing = [] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const u = new URL(url);
    const space = decodeURIComponent(u.pathname).replace(/^\/v1\//, '').replace(/\/messages$/, '');
    if (failing.includes(space)) return { ok: false, status: 403, json: async () => ({}) };
    const all = [...(spaces[space] || [])].sort((a, b) => b.createTime.localeCompare(a.createTime));
    const start = Number(u.searchParams.get('pageToken') || 0);
    const size = Number(u.searchParams.get('pageSize'));
    const next = start + size < all.length ? String(start + size) : null;
    return { ok: true, status: 200, json: async () => ({ messages: all.slice(start, start + size), ...(next ? { nextPageToken: next } : {}) }) };
  };
  return { fetch, calls };
}

function memoryStore(initial = { cursors: {}, seen: [], agentUserId: AGENT }) {
  const saves = [];
  let state = structuredClone(initial);
  return { saves, load: () => structuredClone(state), save: (s) => { state = structuredClone(s); saves.push(state); }, get state() { return state; } };
}

const msg = (n, minutes, over = {}) => ({
  name: `spaces/A/messages/${n}`, text: `@Paraclete request ${n}`, createTime: T(minutes),
  sender: { name: 'users/1', displayName: 'Ana', email: 'ana@example.com' }, thread: { name: 'spaces/A/threads/t1' }, ...over,
});

function inbox({ spaces = {}, store = memoryStore(), clock = { now: NOW }, config = {}, failing = [], getToken, resolveAgentUserId, discover } = {}) {
  const chat = fakeChat(spaces, { failing });
  const turns = [];
  const logs = [];
  const discovered = [];
  const box = createChatInbox({
    getToken: getToken || (async () => 'chat-token'),
    discoverSpaces: discover || (async (token) => { discovered.push(token); return Object.keys(spaces); }),
    resolveAgentUserId: resolveAgentUserId || (async () => AGENT),
    store,
    appendTurn: async (turn) => { turns.push(turn); return true; },
    agentName: 'Paraclete',
    mention: '@Paraclete',
    config: { maxPagesPerPoll: 5, newSpaceSeed: 'now', mentionMatch: 'annotation', contextMessages: 0, ...config },
    fetch: chat.fetch,
    log: (...a) => logs.push(a),
    now: () => clock.now,
  });
  return { box, chat, turns, logs, store, clock, discovered };
}

test('connect waits for the Workspace account instead of failing, then comes online', async () => {
  let fail = true;
  const t = inbox({ store: memoryStore({ cursors: {}, seen: [], agentUserId: null }), getToken: async () => {
    if (fail) throw new Error('Delegated token exchange failed: Invalid email or User ID');
    return 'chat-token';
  } });
  assert.equal(await t.box.connect(), false);
  assert.match(t.logs[0][1], /waiting for the agent's Workspace account/);
  assert.equal(t.box.ready, false);
  fail = false;
  assert.equal(await t.box.connect(), true);
  assert.match(t.logs.at(-2)[1], /now resolves/);
  assert.equal(t.box.status().agentUserId, AGENT);
  assert.equal(t.store.state.agentUserId, AGENT, 'the resolved id is persisted');
});

test('a remembered agent id is not resolved again', async () => {
  let resolved = 0;
  const t = inbox({ resolveAgentUserId: async () => { resolved += 1; return 'users/other'; } });
  await t.box.connect();
  assert.equal(resolved, 0);
  assert.equal(t.box.status().agentUserId, AGENT);
});

test('a new space starts now: only later messages that mention the agent come in', async () => {
  const t = inbox({ spaces: { 'spaces/A': [
    msg(1, -5),
    msg(2, 1, { text: 'chatter without a mention' }),
    msg(3, 2, { sender: { name: AGENT, displayName: 'Paraclete' }, text: '@Paraclete my own echo' }),
    msg(4, 3, { sender: { name: 'users/2', displayName: 'Ben' } }),
  ] } });
  await t.box.connect();
  const got = await t.box.poll();
  assert.deepEqual(got.map((m) => m.id), ['spaces/A/messages/4']);
  assert.deepEqual(got[0], {
    channel: 'gchat',
    id: 'spaces/A/messages/4',
    text: '[Current message - respond to this]\nUser: request 4',
    rawText: '@Paraclete request 4',
    timestamp: T(3),
    sender: 'users/2',
    senderName: 'Ben',
    address: { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t1' },
    attachments: [],
    conversation: got[0].conversation,
  });
  assert.equal(got[0].conversation.turns.length, 3, 'the thread before it, the agent included');
  assert.equal(t.chat.calls[0].auth, 'Bearer chat-token');
});

test('a sender with an email is known by it', async () => {
  const t = inbox({ spaces: { 'spaces/A': [msg(1, 1)] } });
  await t.box.connect();
  assert.equal((await t.box.poll())[0].sender, 'ana@example.com');
});

test('consume moves the cursor and remembers the message, across a restart', async () => {
  const store = memoryStore();
  const spaces = { 'spaces/A': [msg(1, 1), msg(2, 2)] };
  const t = inbox({ spaces, store });
  await t.box.connect();
  const [first] = await t.box.poll();
  await t.box.consume(first);
  assert.equal(store.state.cursors['spaces/A'], T(1));
  assert.deepEqual(store.state.seen, ['spaces/A/messages/1']);

  const restarted = inbox({ spaces, store });
  await restarted.box.connect();
  assert.deepEqual((await restarted.box.poll()).map((m) => m.id), ['spaces/A/messages/2']);
});

test('the cursor compares instants, not strings', async () => {
  const store = memoryStore({ cursors: { 'spaces/A': '2026-10-17T12:00:00.500Z' }, seen: [], agentUserId: AGENT });
  const t = inbox({ store, spaces: { 'spaces/A': [
    msg(1, 0, { createTime: '2026-10-17T12:00:00Z' }),
    msg(2, 0, { createTime: '2026-10-17T12:00:00.500123Z' }),
  ] } });
  await t.box.connect();
  assert.deepEqual((await t.box.poll()).map((m) => m.id), ['spaces/A/messages/2'],
    'the older whole-second message stays old; the one in the same millisecond as the cursor is new');
});

test('reading stops at the page that reaches the cursor', async () => {
  const many = Array.from({ length: 60 }, (_, i) => msg(i, -60 + i, { text: 'old chatter' }));
  const t = inbox({ spaces: { 'spaces/A': [...many, msg(100, 1)] } });
  await t.box.connect();
  assert.equal((await t.box.poll()).length, 1);
  assert.equal(t.chat.calls.length, 1, 'the first page already reaches back past the cursor');
});

test('a space taken from the beginning pages up to the limit', async () => {
  const many = Array.from({ length: 200 }, (_, i) => msg(i, -300 + i));
  const t = inbox({ spaces: { 'spaces/A': many }, config: { newSpaceSeed: 'beginning', maxPagesPerPoll: 3 } });
  await t.box.connect();
  const got = await t.box.poll();
  assert.equal(t.chat.calls.length, 3);
  assert.equal(got.length, 75);
  assert.deepEqual(got.map((m) => m.timestamp), [...got.map((m) => m.timestamp)].sort(), 'oldest first');
  assert.match(t.chat.calls[1].url, /&pageToken=25$/);
});

test('messages from several spaces come back oldest first, and a failing space is counted', async () => {
  const t = inbox({
    spaces: {
      'spaces/A': [msg(1, 3)],
      'spaces/B': [msg(2, 1, { name: 'spaces/B/messages/2' })],
      'spaces/C': [msg(3, 2, { name: 'spaces/C/messages/3' })],
    },
    failing: ['spaces/C'],
  });
  await t.box.connect();
  const got = await t.box.poll();
  assert.deepEqual(got.map((m) => m.id), ['spaces/B/messages/2', 'spaces/A/messages/1']);
  assert.equal(t.box.status().errors, 1);
  assert.equal(t.box.status().spaces, 3);
});

test('spaces are discovered again only every five minutes', async () => {
  const t = inbox({ spaces: { 'spaces/A': [] } });
  await t.box.connect();
  await t.box.poll();
  t.clock.now += 60_000;
  await t.box.poll();
  assert.equal(t.discovered.length, 1);
  t.clock.now += 300_000;
  await t.box.poll();
  assert.equal(t.discovered.length, 2);
});

test('a mention annotation teaches the inbox its own user id', async () => {
  const store = memoryStore({ cursors: {}, seen: [], agentUserId: null });
  const t = inbox({
    store,
    resolveAgentUserId: async () => null,
    spaces: { 'spaces/A': [msg(1, 1, { text: '@Paraclete hi', annotations: [{ type: 'USER_MENTION', startIndex: 0, length: 10, userMention: { user: { name: 'users/555' } } }] })] },
  });
  await t.box.connect();
  assert.equal((await t.box.poll()).length, 1);
  assert.equal(store.state.agentUserId, 'users/555');
});

test('earlier page messages are framed as context only when configured', async () => {
  const spaces = { 'spaces/A': [msg(1, 1, { text: 'numbers are in', sender: { name: 'users/2', displayName: 'Ben' } }), msg(2, 2)] };
  const none = inbox({ spaces });
  await none.box.connect();
  assert.equal((await none.box.poll())[0].text, '[Current message - respond to this]\nUser: request 2');

  const some = inbox({ spaces, config: { contextMessages: 5 } });
  await some.box.connect();
  assert.match((await some.box.poll())[0].text, /^\[Chat messages since your last reply - for context\]\nBen: numbers are in\n\n/);
});

test("the thread's turns on the page are copied into the thread ledger", async () => {
  const t = inbox({ spaces: { 'spaces/A': [
    msg(1, 1, { text: 'context first', sender: { name: 'users/2', displayName: 'Ben' } }),
    msg(2, 2, { sender: { name: AGENT, displayName: 'Paraclete' }, text: 'on it' }),
    msg(3, 3),
    msg(4, 4, { thread: { name: 'spaces/A/threads/other' }, text: 'other thread' }),
  ] } });
  await t.box.connect();
  await t.box.poll();
  await t.box.settle();
  assert.deepEqual(t.turns.map((x) => [x.turnId, x.role, x.name]), [
    ['spaces/A/messages/1', 'user', 'Ben'],
    ['spaces/A/messages/2', 'agent', 'Paraclete'],
    ['spaces/A/messages/3', 'user', 'Ana'],
  ]);
  assert.equal(t.turns[0].threadKey, 'gchat-spaces~A~threads~t1');
  assert.deepEqual(t.turns[0].channelMeta, { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t1' });
});
