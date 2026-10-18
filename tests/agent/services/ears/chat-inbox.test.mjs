// Tests for agent/services/ears/chat-inbox.mjs, against a fake Chat API that answers as Chat answers
// a user-authenticated caller: senders named only by 'users/<id>', the agent's own posts carrying the
// mouth's client-assigned id. Covers which spaces are read and when, what is taken in (every direct
// message, mentions in spaces), cursors across restarts, the agent's own id, dashboard users matched
// through their direct messages, the thread ledger copy, and the Chat API's limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatInbox } from '../../../../agent/services/ears/chat-inbox.mjs';
import { createChatIdentity } from '../../../../agent/services/ears/chat-identity.mjs';
import { agentMessageId, ChatApiError } from '../../../../agent/providers/channel.mjs';

const AGENT = 'users/900';
const NOW = Date.parse('2026-10-17T12:00:00Z');
const T = (minutes) => new Date(NOW + minutes * 60_000).toISOString();

/** A Chat API fake: spaces of messages, listed newest first, 25 per page, page tokens as offsets. */
function fakeChat(messages, { failing = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const u = new URL(url);
    const space = decodeURIComponent(u.pathname).replace(/^\/v1\//, '').replace(/\/messages$/, '');
    if (failing[space]) return { ok: false, status: failing[space], json: async () => ({}) };
    const all = [...(messages[space] || [])].sort((a, b) => b.createTime.localeCompare(a.createTime));
    const start = Number(u.searchParams.get('pageToken') || 0);
    const size = Number(u.searchParams.get('pageSize'));
    const next = start + size < all.length ? String(start + size) : null;
    return { ok: true, status: 200, json: async () => ({ messages: all.slice(start, start + size), ...(next ? { nextPageToken: next } : {}) }) };
  };
  return { fetch, calls, messages };
}

function memoryStore(initial = {}) {
  const saves = [];
  let state = structuredClone({ cursors: {}, seen: [], agentUserId: AGENT, listedAt: null, people: {}, ...initial });
  return { saves, load: () => structuredClone(state), save: (s) => { state = structuredClone(s); saves.push(state); }, get state() { return state; } };
}

const space = (name, over = {}) => ({ name, spaceType: 'SPACE', external: false, lastActiveTime: null, displayName: '', ...over });
const dm = (name, over = {}) => space(name, { spaceType: 'DIRECT_MESSAGE', ...over });

const msg = (n, minutes, over = {}) => ({
  name: `spaces/A/messages/${n}`, text: `@Paraclete request ${n}`, createTime: T(minutes),
  sender: { name: 'users/1', type: 'HUMAN' }, thread: { name: 'spaces/A/threads/t1' }, ...over,
});
/** A message the agent's mouth posted, as Chat lists it. */
const posted = (n, minutes, over = {}) => msg(n, minutes, {
  text: 'on it', sender: { name: AGENT, type: 'HUMAN' }, clientAssignedMessageId: agentMessageId(`delivery:w-${n}:x`), ...over,
});

function inbox({
  messages = {}, spaces, store = memoryStore(), clock = { now: NOW }, config = {}, failing = {}, getToken,
  listSpaces, identity = null,
} = {}) {
  const chat = fakeChat(messages, { failing });
  const turns = [];
  const logs = [];
  const listings = [];
  const listed = spaces || Object.keys(messages).map((name) => space(name));
  const box = createChatInbox({
    getToken: getToken || (async () => 'chat-token'),
    listSpaces: listSpaces || (async (token) => { listings.push(token); return typeof listed === 'function' ? listed() : listed; }),
    identity,
    store,
    appendTurn: async (turn) => { turns.push(turn); return true; },
    agentName: 'Paraclete',
    config: { maxPagesPerPoll: 5, newSpaceSeed: 'now', mentionMatch: 'annotation', contextMessages: 0, ...config },
    fetch: chat.fetch,
    log: (...a) => logs.push(a),
    now: () => clock.now,
  });
  return { box, chat, turns, logs, store, clock, listings };
}

test('connect waits for the Workspace account instead of failing, says why, then comes online', async () => {
  let fail = true;
  const t = inbox({ store: memoryStore({ agentUserId: null }), getToken: async () => {
    if (fail) throw new Error('Delegated token exchange failed: Invalid email or User ID');
    return 'chat-token';
  } });
  assert.equal(await t.box.connect(), false);
  assert.match(t.logs[0][1], /waiting for the agent's Workspace account/);
  assert.match(t.box.status().tokenError, /Invalid email or User ID/);
  assert.equal(t.box.ready, false);
  fail = false;
  assert.equal(await t.box.connect(), true);
  assert.equal(t.box.status().tokenError, null);
  assert.ok(t.logs.some(([, m]) => /now resolves/.test(m)));
  assert.ok(t.logs.some(([, m]) => /learned from its first message/.test(m)), 'an unknown agent id is said once');
});

test('the first listing starts every space an hour back: older messages stay out, later mentions come in', async () => {
  const t = inbox({ messages: { 'spaces/A': [
    msg(1, -65),
    msg(2, 1, { text: 'chatter without a mention' }),
    posted(3, 2, { text: '@Paraclete my own echo' }),
    msg(4, 3, { sender: { name: 'users/2', type: 'HUMAN' } }),
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
    senderName: '',
    senderEmail: null,
    address: { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t1' },
    attachments: [],
    conversation: got[0].conversation,
  });
  assert.equal(got[0].conversation.turns.length, 3, 'the thread before it, the agent included');
  assert.equal(t.chat.calls[0].auth, 'Bearer chat-token');
  assert.equal(t.store.state.listedAt, new Date(NOW).toISOString());
});

test("a new account's first direct message, sent before Chat would list it, is read; one from before the hour is not", async () => {
  // Google Chat lists no spaces for a user nobody has written to, so the message that brings the
  // agent's account into Chat is always older than the first listing that succeeds.
  const t = inbox({
    spaces: [dm('spaces/D')],
    messages: { 'spaces/D': [
      msg(1, -90, { name: 'spaces/D/messages/1', text: 'an old note', thread: { name: 'spaces/D/threads/a' } }),
      msg(2, -20, { name: 'spaces/D/messages/2', text: 'hello!', thread: { name: 'spaces/D/threads/b' } }),
    ] },
  });
  await t.box.connect();
  const got = await t.box.poll();
  assert.deepEqual(got.map((m) => m.rawText), ['hello!']);
  assert.deepEqual(got[0].address, { channel: 'gchat', space: 'spaces/D', thread: null }, 'answered in the direct message');
});

test('a direct message takes in every message, with no mention, and is answered in the conversation itself', async () => {
  const t = inbox({
    spaces: [dm('spaces/D')],
    messages: { 'spaces/D': [
      msg(1, 1, { name: 'spaces/D/messages/1', text: "what's on today?", thread: { name: 'spaces/D/threads/a' } }),
      posted(2, 2, { name: 'spaces/D/messages/2', text: 'Two meetings.', thread: { name: 'spaces/D/threads/a' } }),
      msg(3, 3, { name: 'spaces/D/messages/3', text: 'and tomorrow?', thread: { name: 'spaces/D/threads/b' } }),
    ] },
  });
  await t.box.connect();
  const got = await t.box.poll();
  assert.deepEqual(got.map((m) => m.rawText), ["what's on today?", 'and tomorrow?']);
  assert.deepEqual(got[1].address, { channel: 'gchat', space: 'spaces/D', thread: null });
  assert.deepEqual(got[1].conversation.turns.map((x) => [x.role, x.text]), [['user', "what's on today?"], ['agent', 'Two meetings.']],
    'the whole direct message is the conversation');
  await t.box.settle();
  assert.equal(t.turns[0].threadKey, 'gchat-spaces~D', 'one ledger thread for the direct message');
  assert.deepEqual(t.box.status(), {
    ready: true, tokenError: null, spaces: 0, directMessages: 1, external: 0, errors: 0, rateLimited: false,
    agentUserId: AGENT, knownUsers: 0,
  });
});

test('a space open to people outside the organization is never read, and is counted', async () => {
  const t = inbox({
    spaces: [space('spaces/A'), space('spaces/X', { external: true }), dm('spaces/E', { external: true })],
    messages: { 'spaces/A': [msg(1, 1)], 'spaces/X': [msg(2, 1, { name: 'spaces/X/messages/2' })], 'spaces/E': [] },
  });
  await t.box.connect();
  assert.deepEqual((await t.box.poll()).map((m) => m.id), ['spaces/A/messages/1']);
  assert.ok(t.chat.calls.every((c) => c.url.includes('/spaces/A/')), 'no call reads an external space');
  assert.equal(t.box.status().external, 2);
  await t.box.poll();
  assert.equal(t.logs.filter(([, m]) => /outside the organization/.test(m)).length, 2, 'each is said once');
});

test('a space that appears later starts a minute before the previous listing, so its first message is read', async () => {
  let listed = [space('spaces/A')];
  const t = inbox({
    spaces: () => listed,
    messages: { 'spaces/A': [], 'spaces/D': [msg(1, 0.5, { name: 'spaces/D/messages/1', text: 'hello, can you help?' })] },
  });
  await t.box.connect();
  await t.box.poll();
  t.clock.now += 60_000;
  listed = [space('spaces/A'), dm('spaces/D')];
  const got = await t.box.poll();
  assert.deepEqual(got.map((m) => m.rawText), ['hello, can you help?'], 'the message that opened the direct message');
  assert.equal(t.store.state.cursors['spaces/D'], new Date(NOW - 60_000).toISOString());

  listed = [space('spaces/A')];
  await t.box.poll();
  assert.equal('spaces/D' in t.store.state.cursors, false, 'a space the account left is forgotten');
});

test('consume moves the cursor and remembers the message, across a restart', async () => {
  const store = memoryStore();
  const messages = { 'spaces/A': [msg(1, 1), msg(2, 2)] };
  const t = inbox({ messages, store });
  await t.box.connect();
  const [first] = await t.box.poll();
  await t.box.consume(first);
  assert.equal(store.state.cursors['spaces/A'], T(1));
  assert.deepEqual(store.state.seen, ['spaces/A/messages/1']);

  const restarted = inbox({ messages, store });
  await restarted.box.connect();
  assert.deepEqual((await restarted.box.poll()).map((m) => m.id), ['spaces/A/messages/2']);
});

test('the cursor compares instants, not strings', async () => {
  const store = memoryStore({ cursors: { 'spaces/A': '2026-10-17T12:00:00.500Z' }, listedAt: T(0) });
  const t = inbox({ store, messages: { 'spaces/A': [
    msg(1, 0, { createTime: '2026-10-17T12:00:00Z' }),
    msg(2, 0, { createTime: '2026-10-17T12:00:00.500123Z' }),
  ] } });
  await t.box.connect();
  assert.deepEqual((await t.box.poll()).map((m) => m.id), ['spaces/A/messages/2'],
    'the older whole-second message stays old; the one in the same millisecond as the cursor is new');
});

test('reading stops at the page that reaches the cursor', async () => {
  const many = Array.from({ length: 60 }, (_, i) => msg(i, -180 + i, { text: 'old chatter' }));
  const t = inbox({ messages: { 'spaces/A': [...many, msg(100, 1)] } });
  await t.box.connect();
  assert.equal((await t.box.poll()).length, 1);
  assert.equal(t.chat.calls.length, 1, 'the first page already reaches back past the cursor');
});

test('a space taken from the beginning pages up to the limit, and says what it passed over', async () => {
  const many = Array.from({ length: 200 }, (_, i) => msg(i, -300 + i));
  const t = inbox({ messages: { 'spaces/A': many }, config: { newSpaceSeed: 'beginning', maxPagesPerPoll: 3 } });
  await t.box.connect();
  const got = await t.box.poll();
  assert.equal(t.chat.calls.length, 3);
  assert.equal(got.length, 75);
  assert.deepEqual(got.map((m) => m.timestamp), [...got.map((m) => m.timestamp)].sort(), 'oldest first');
  assert.match(t.chat.calls[1].url, /&pageToken=25$/);
  assert.ok(t.logs.some(([level, m]) => level === 'WARN' && /passed over/.test(m)));
});

test('messages from several spaces come back oldest first, and a failing space is counted', async () => {
  const t = inbox({
    messages: {
      'spaces/A': [msg(1, 3)],
      'spaces/B': [msg(2, 1, { name: 'spaces/B/messages/2' })],
      'spaces/C': [msg(3, 2, { name: 'spaces/C/messages/3' })],
    },
    failing: { 'spaces/C': 403 },
  });
  await t.box.connect();
  const got = await t.box.poll();
  assert.deepEqual(got.map((m) => m.id), ['spaces/B/messages/2', 'spaces/A/messages/1']);
  assert.equal(t.box.status().errors, 1);
  assert.equal(t.box.status().spaces, 3);
});

test('only a space whose newest message is past its cursor is read, and every space every five minutes', async () => {
  const lastActive = { 'spaces/A': T(-70), 'spaces/B': T(-70) };
  const t = inbox({
    spaces: () => Object.entries(lastActive).map(([name, at]) => space(name, { lastActiveTime: at })),
    messages: { 'spaces/A': [], 'spaces/B': [] },
  });
  await t.box.connect();
  await t.box.poll();
  assert.equal(t.chat.calls.length, 2, 'the first poll is a sweep');
  t.clock.now += 5_000;
  await t.box.poll();
  assert.equal(t.chat.calls.length, 2, 'nothing new anywhere: no messages.list at all');
  t.chat.messages['spaces/B'].push(msg(1, 0.2, { name: 'spaces/B/messages/1' }));
  lastActive['spaces/B'] = T(0.2);
  t.clock.now += 5_000;
  const got = await t.box.poll();
  assert.deepEqual(got.map((m) => m.id), ['spaces/B/messages/1']);
  assert.equal(t.chat.calls.length, 3, 'only the active space was read');
  assert.equal(t.listings.length, 3, 'the spaces are listed every poll');
  t.clock.now += 300_000;
  await t.box.poll();
  assert.equal(t.chat.calls.length, 5, 'the sweep reads every space again');
});

test('a busy space with nothing for the agent moves its cursor up, so it is not paged through again', async () => {
  const chatter = Array.from({ length: 40 }, (_, i) => msg(i, 1 + i / 100, { text: 'team chatter' }));
  const t = inbox({ messages: { 'spaces/A': chatter } });
  await t.box.connect();
  assert.deepEqual(await t.box.poll(), []);
  assert.equal(t.store.state.cursors['spaces/A'], chatter.at(-1).createTime);
  const before = t.chat.calls.length;
  t.clock.now += 300_000;
  await t.box.poll();
  assert.equal(t.chat.calls.length, before + 1, 'one page, which reaches the cursor at once');
});

test("the agent's id is learned from a message its mouth posted, and recognizes its later messages", async () => {
  const store = memoryStore({ agentUserId: null });
  const t = inbox({ store, messages: { 'spaces/A': [
    posted(1, 1, { sender: { name: 'users/555', type: 'HUMAN' } }),
    msg(2, 2, { sender: { name: 'users/555', type: 'HUMAN' }, text: '@Paraclete an old untagged reply' }),
    msg(3, 3),
  ] } });
  await t.box.connect();
  assert.deepEqual((await t.box.poll()).map((m) => m.id), ['spaces/A/messages/3'], "its own untagged message is skipped by id");
  assert.equal(store.state.agentUserId, 'users/555');
  assert.equal(t.box.status().agentUserId, 'users/555');
});

test('a rate limit ends the round and is reported; a failed listing throws', async () => {
  const t = inbox({
    messages: { 'spaces/A': [msg(1, 1)], 'spaces/B': [msg(2, 1, { name: 'spaces/B/messages/2' })] },
    failing: { 'spaces/A': 429 },
  });
  await t.box.connect();
  assert.deepEqual(await t.box.poll(), []);
  assert.equal(t.box.status().rateLimited, true);
  assert.equal(t.chat.calls.length, 1, 'no further space was read');

  const refused = inbox({ listSpaces: async () => { throw new ChatApiError('listing the Chat spaces', 429, 'Quota exceeded'); } });
  await refused.box.connect();
  await assert.rejects(refused.box.poll(), /HTTP 429/);
  assert.equal(refused.box.status().rateLimited, true);
});

test('earlier page messages are framed as context only when configured', async () => {
  const messages = { 'spaces/A': [msg(1, 1, { text: 'numbers are in', sender: { name: 'users/2', type: 'HUMAN' } }), msg(2, 2)] };
  const none = inbox({ messages });
  await none.box.connect();
  assert.equal((await none.box.poll())[0].text, '[Current message - respond to this]\nUser: request 2');

  const some = inbox({ messages, config: { contextMessages: 5 } });
  await some.box.connect();
  assert.match((await some.box.poll())[0].text, /^\[Chat messages since your last reply - for context\]\nsomeone: numbers are in\n\n/);
});

test("the thread's turns on the page are copied into the thread ledger", async () => {
  const t = inbox({ messages: { 'spaces/A': [
    msg(1, 1, { text: 'context first', sender: { name: 'users/2', type: 'HUMAN' } }),
    posted(2, 2),
    msg(3, 3),
    msg(4, 4, { thread: { name: 'spaces/A/threads/other' }, text: 'other thread' }),
  ] } });
  await t.box.connect();
  await t.box.poll();
  await t.box.settle();
  assert.deepEqual(t.turns.map((x) => [x.turnId, x.role, x.name]), [
    ['spaces/A/messages/1', 'user', 'someone'],
    ['spaces/A/messages/2', 'agent', 'Paraclete'],
    ['spaces/A/messages/3', 'user', 'someone'],
  ]);
  assert.equal(t.turns[0].threadKey, 'gchat-spaces~A~threads~t1');
  assert.deepEqual(t.turns[0].channelMeta, { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t1' });
});

test('a dashboard user is known by their direct message, then by their user id in any space', async () => {
  const store = memoryStore();
  const lookups = [];
  const identity = createChatIdentity({
    readUsers: async () => ['ana@example.com', 'ben@example.com'],
    findDirectMessage: async (token, email) => { lookups.push([token, email]); return email === 'ana@example.com' ? 'spaces/D' : null; },
    agentAccount: 'agent@example.com',
    now: () => NOW,
  });
  const t = inbox({
    store,
    identity,
    spaces: [dm('spaces/D'), space('spaces/A')],
    messages: {
      'spaces/D': [msg(1, 1, { name: 'spaces/D/messages/1', text: 'approve', sender: { name: 'users/1', type: 'HUMAN' } })],
      'spaces/A': [msg(2, 2), msg(3, 3, { sender: { name: 'users/7', type: 'HUMAN' } })],
    },
  });
  await t.box.connect();
  const got = await t.box.poll();
  assert.deepEqual(lookups, [['chat-token', 'ana@example.com'], ['chat-token', 'ben@example.com']]);
  assert.deepEqual(got.map((m) => [m.id, m.senderEmail, m.senderName]), [
    ['spaces/D/messages/1', 'ana@example.com', 'ana@example.com'],
    ['spaces/A/messages/2', 'ana@example.com', 'ana@example.com'],
    ['spaces/A/messages/3', null, ''],
  ], 'Ana wrote in her direct message, so she is known in the space too; users/7 is nobody the dashboard knows');
  assert.deepEqual(store.state.people, { 'users/1': 'ana@example.com' }, 'what was learned is kept');
  assert.equal(t.box.status().knownUsers, 1);
});
