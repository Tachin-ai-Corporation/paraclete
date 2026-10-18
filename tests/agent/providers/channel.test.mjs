// Tests for agent/providers/channel.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SENDER, initChannel, makeAddress, serializeAddress, parseAddress, toGChatMarkdown, chatMessageText,
  chatMessagesUrl, dashboardMessagesUrl, dashboardMessageFields, listSpaces, findDirectMessage, deliverToAddress,
  agentMessageId, AGENT_MESSAGE_ID_PREFIX, ChatApiError,
} from '../../../agent/providers/channel.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/your-gcp-project/databases/(default)/documents';
const CHAT = 'https://chat.googleapis.com/v1';

function fakeFetch(status = 200, body = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status === 200, status, json: async () => body, text: async () => 'refused' };
  };
  return { fetch, calls };
}

describe('Address model', () => {
  it('a Chat address always carries exactly one spaces/ prefix', () => {
    assert.deepEqual(makeAddress('gchat', { space: 'AAA', thread: 'spaces/AAA/threads/t1' }),
      { channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/t1' });
    assert.equal(makeAddress('gchat', { space: 'spaces/AAA' }).space, 'spaces/AAA');
    assert.deepEqual(makeAddress('gchat'), { channel: 'gchat', space: null, thread: null });
  });

  it('a dashboard address names its conversation thread, and anything else is the dashboard', () => {
    assert.deepEqual(makeAddress('dashboard', { thread: 'th-1' }), { channel: 'dashboard', thread: 'th-1' });
    assert.deepEqual(makeAddress('firestore'), { channel: 'dashboard', thread: null });
  });

  it('round-trips through Firestore for both channels', () => {
    for (const addr of [
      makeAddress('gchat', { space: 'spaces/AAA', thread: 'spaces/AAA/threads/t1' }),
      makeAddress('gchat', { space: 'spaces/AAA' }),
      makeAddress('dashboard', { thread: 'th-1' }),
      makeAddress('dashboard'),
    ]) {
      assert.deepEqual(parseAddress({ address: serializeAddress(addr) }, 'ignored'), addr);
    }
  });

  it('serializes only the fields that are set', () => {
    assert.deepEqual(serializeAddress(makeAddress('dashboard')), { mapValue: { fields: { channel: { stringValue: 'dashboard' } } } });
    assert.deepEqual(serializeAddress(null), {});
  });

  it('falls back to flat Chat fields, then to the source channel', () => {
    assert.deepEqual(parseAddress({ spaceName: { stringValue: 'spaces/B' }, threadName: { stringValue: 'spaces/B/threads/x' } }, 'dashboard'),
      { channel: 'gchat', space: 'spaces/B', thread: 'spaces/B/threads/x' });
    assert.deepEqual(parseAddress({}, 'gchat'), makeAddress('gchat'));
    assert.deepEqual(parseAddress(null, 'dashboard'), makeAddress('dashboard'));
    assert.deepEqual(parseAddress(null, 'gchat'), makeAddress('gchat'));
  });
});

describe('Chat formatting', () => {
  it('turns headings and bold-italic into bold and links into their text', () => {
    assert.equal(toGChatMarkdown('# Title\n***Note*** see [the doc](https://example.com/d)'), '*Title*\n*Note* see the doc');
    assert.equal(toGChatMarkdown(''), '');
  });

  it('cuts the body, never the mentions, to fit the 4096 limit', () => {
    const text = chatMessageText('x'.repeat(5000), ['a@example.com', 'a@example.com']);
    assert.equal(text.length, 4096);
    assert.ok(text.endsWith('...\n\n<users/a@example.com>'), 'mentions survive, deduplicated');
    assert.equal(chatMessageText('hi'), 'hi');
  });
});

describe('paths', () => {
  it('a Chat message goes to its space, threaded only when replying in a thread', () => {
    const threaded = makeAddress('gchat', { space: 'spaces/AAA', thread: 'spaces/AAA/threads/t1' });
    assert.equal(chatMessagesUrl(threaded), `${CHAT}/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`);
    assert.equal(chatMessagesUrl(threaded, { replyInThread: false }), `${CHAT}/spaces/AAA/messages`);
    assert.equal(chatMessagesUrl(makeAddress('gchat', { space: 'AAA' })), `${CHAT}/spaces/AAA/messages`);
    assert.equal(chatMessagesUrl(threaded, { messageId: 'client-paraclete-1', requestId: 'client-paraclete-1' }),
      `${CHAT}/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD&messageId=client-paraclete-1&requestId=client-paraclete-1`);
  });

  it('a dashboard message goes to the root messages collection', () => {
    assert.equal(dashboardMessagesUrl(`${FIRESTORE}/`, COLLECTIONS), `${FIRESTORE}/${COLLECTIONS.messages}`);
  });

  it("the agent's dashboard message is processed and carries its thread, name and attachments", () => {
    const fields = dashboardMessageFields('done', {
      thread: 'th-1',
      agentName: 'Ada',
      attachments: [{ name: 'report.docx', size: 2048, gcsPath: 'gs://bucket/report.docx' }],
      timestamp: '2026-10-17T10:00:00.000Z',
    });
    assert.equal(fields.sender.stringValue, AGENT_SENDER);
    assert.equal(fields.sender_name.stringValue, 'Ada');
    assert.equal(fields.thread_id.stringValue, 'th-1');
    assert.equal(fields.processed.booleanValue, true);
    assert.equal(fields.timestamp.timestampValue, '2026-10-17T10:00:00.000Z');
    assert.deepEqual(fields.attachments.arrayValue.values[0].mapValue.fields.size, { integerValue: '2048' });
    const bare = dashboardMessageFields('hi', { timestamp: '2026-10-17T10:00:00.000Z' });
    assert.equal(bare.thread_id, undefined);
    assert.equal(bare.sender_name, undefined);
    assert.equal(bare.attachments, undefined);
  });
});

describe('deliverToAddress', () => {
  it("posts to Chat with the agent's Workspace token, in the thread, with mentions, marked as the agent's own", async () => {
    const google = fakeFetch();
    initChannel({ firestoreUrl: FIRESTORE, collections: COLLECTIONS, fetch: google.fetch });
    const addr = makeAddress('gchat', { space: 'spaces/AAA', thread: 'spaces/AAA/threads/t1' });
    const reports = [];
    assert.equal(await deliverToAddress(addr, '## Done', {
      token: 'dwd-token', mentions: ['u@example.com'], messageKey: 'delivery:w-1:abc', report: (r) => reports.push(r),
    }), true);
    const [call] = google.calls;
    const id = agentMessageId('delivery:w-1:abc');
    assert.equal(call.url, chatMessagesUrl(addr, { messageId: id, requestId: id }), 'one key: one message id, and a repeated request returns it');
    assert.equal(call.init.headers.Authorization, 'Bearer dwd-token');
    assert.deepEqual(call.body, { text: '*Done*\n\n<users/u@example.com>', thread: { name: 'spaces/AAA/threads/t1' } });
    assert.deepEqual(reports, [{ ok: true, status: 200, error: null }]);
  });

  it('a direct message is posted to the conversation; without a key the message still carries an agent id', async () => {
    const google = fakeFetch();
    initChannel({ firestoreUrl: FIRESTORE, collections: COLLECTIONS, fetch: google.fetch });
    assert.equal(await deliverToAddress(makeAddress('gchat', { space: 'spaces/D' }), 'hi', { token: 't' }), true);
    const url = new URL(google.calls[0].url);
    assert.equal(url.pathname, '/v1/spaces/D/messages');
    assert.equal(url.searchParams.get('messageReplyOption'), null);
    assert.ok(url.searchParams.get('messageId').startsWith(AGENT_MESSAGE_ID_PREFIX));
    assert.equal(url.searchParams.get('requestId'), null, 'nothing to repeat without a key');
    assert.equal(google.calls[0].body.thread, undefined);
  });

  it('a keyed message Chat already has counts as delivered, never posted twice', async () => {
    const google = fakeFetch(409, { error: { status: 'ALREADY_EXISTS' } });
    initChannel({ firestoreUrl: FIRESTORE, collections: COLLECTIONS, fetch: google.fetch });
    const addr = makeAddress('gchat', { space: 'spaces/AAA' });
    assert.equal(await deliverToAddress(addr, 'x', { token: 't', messageKey: 'delivery:w-1:abc' }), true);
    assert.equal(await deliverToAddress(addr, 'x', { token: 't' }), false, 'without a key a conflict is a failure');
  });

  it('drops a Chat address with no space, and reports a refused post', async () => {
    const google = fakeFetch(403);
    initChannel({ firestoreUrl: FIRESTORE, collections: COLLECTIONS, fetch: google.fetch });
    assert.equal(await deliverToAddress(makeAddress('gchat'), 'x', { token: 't' }), false);
    assert.equal(google.calls.length, 0);
    const logged = [];
    assert.equal(await deliverToAddress(makeAddress('gchat', { space: 'AAA' }), 'x', { token: 't', log: (m, d) => logged.push(d) }), false);
    assert.equal(logged[0].status, 403);
  });

  it('writes a dashboard reply into the root messages collection, in its thread', async () => {
    const google = fakeFetch();
    initChannel({ firestoreUrl: FIRESTORE, collections: COLLECTIONS, agentName: 'Ada', fetch: google.fetch, now: () => Date.parse('2026-10-17T10:00:00Z') });
    assert.equal(await deliverToAddress(makeAddress('dashboard', { thread: 'th-1' }), 'done', { token: 'vm-token' }), true);
    const [call] = google.calls;
    assert.equal(call.url, `${FIRESTORE}/${COLLECTIONS.messages}`);
    assert.equal(call.init.headers.Authorization, 'Bearer vm-token');
    assert.deepEqual(call.body.fields, dashboardMessageFields('done', { thread: 'th-1', agentName: 'Ada', timestamp: '2026-10-17T10:00:00.000Z' }));
  });

  it('refuses an unknown channel', async () => {
    assert.equal(await deliverToAddress({ channel: 'pager' }, 'x', { token: 't' }), false);
  });

  it('requires the messages collection name at setup', () => {
    assert.throws(() => initChannel({ firestoreUrl: FIRESTORE, collections: {} }), /collections\.messages is required/);
    assert.throws(() => initChannel({ collections: COLLECTIONS }), /firestoreUrl is required/);
  });
});

describe('Chat as the agent\'s own user', () => {
  /** A fetch that answers each call from a list of [status, body], in order, and records the calls. */
  function scripted(answers) {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url, init });
      const [status, body] = answers.shift();
      return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
    };
    return { fetch, calls };
  }

  it('lists every space the account is in, across pages, with what the ears need of each', async () => {
    const google = scripted([
      [200, { spaces: [
        { name: 'spaces/A', spaceType: 'SPACE', displayName: 'Team', lastActiveTime: '2026-10-17T11:00:00Z' },
        { name: 'spaces/D', spaceType: 'DIRECT_MESSAGE', externalUserAllowed: false },
        {},
      ], nextPageToken: 'p2' }],
      [200, { spaces: [{ name: 'spaces/X', type: 'ROOM', externalUserAllowed: true }, { name: 'spaces/O', type: 'DM' }] }],
    ]);
    assert.deepEqual(await listSpaces('dwd-token', { fetch: google.fetch }), [
      { name: 'spaces/A', spaceType: 'SPACE', external: false, lastActiveTime: '2026-10-17T11:00:00Z', displayName: 'Team' },
      { name: 'spaces/D', spaceType: 'DIRECT_MESSAGE', external: false, lastActiveTime: null, displayName: '' },
      { name: 'spaces/X', spaceType: 'SPACE', external: true, lastActiveTime: null, displayName: '' },
      { name: 'spaces/O', spaceType: 'DIRECT_MESSAGE', external: false, lastActiveTime: null, displayName: '' },
    ]);
    assert.equal(google.calls[0].url, `${CHAT}/spaces?pageSize=1000`);
    assert.equal(google.calls[1].url, `${CHAT}/spaces?pageSize=1000&pageToken=p2`);
    assert.equal(google.calls[0].init.headers.Authorization, 'Bearer dwd-token');
  });

  it('a listing that fails throws with the status and Google\'s reason, never an empty list', async () => {
    const google = scripted([[429, { error: { code: 429, message: 'Quota exceeded for quota metric', status: 'RESOURCE_EXHAUSTED' } }]]);
    await assert.rejects(listSpaces('t', { fetch: google.fetch }), (err) => err instanceof ChatApiError && err.status === 429
      && /Quota exceeded/.test(err.message));
  });

  it('finds the direct message with a person by their email, and says when there is none', async () => {
    const google = scripted([[200, { name: 'spaces/D', spaceType: 'DIRECT_MESSAGE' }], [404, { error: { status: 'NOT_FOUND' } }], [403, { error: { message: 'denied' } }]]);
    assert.equal(await findDirectMessage('t', 'ana@example.com', { fetch: google.fetch }), 'spaces/D');
    assert.equal(google.calls[0].url, `${CHAT}/spaces:findDirectMessage?name=users%2Fana%40example.com`);
    assert.equal(await findDirectMessage('t', 'ben@example.com', { fetch: google.fetch }), null);
    await assert.rejects(findDirectMessage('t', 'cy@example.com', { fetch: google.fetch }), /HTTP 403: denied/);
  });

  it("the agent's message ids are Chat custom ids: client-, lowercase, at most 63 characters, the same for the same key", () => {
    const id = agentMessageId('delivery:w-1:abc');
    assert.match(id, /^client-[a-z0-9-]{1,56}$/);
    assert.ok(id.length <= 63);
    assert.ok(id.startsWith(AGENT_MESSAGE_ID_PREFIX));
    assert.equal(agentMessageId('delivery:w-1:abc'), id);
    assert.notEqual(agentMessageId('delivery:w-1:abd'), id);
  });
});
