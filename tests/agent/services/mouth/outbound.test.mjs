// Tests for agent/services/mouth/outbound.mjs: the token each channel needs, what reaches deliverToAddress, when
// the agent last spoke to an Address, and how Google Chat answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbound, addressKey, UndeliverableError } from '../../../../agent/services/mouth/outbound.mjs';

function fakeDeliver(ok = true) {
  const calls = [];
  const deliver = async (addr, text, opts) => { calls.push({ addr, text, opts }); opts.log('ERROR: Chat POST failed', { status: 500 }); return ok; };
  return { deliver, calls };
}

const DASH = { channel: 'dashboard', thread: 'th-1' };
const CHAT = { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t' };

test('a dashboard send uses the VM token and passes the attachments through', async () => {
  const fake = fakeDeliver();
  const out = createOutbound({ getVmToken: async () => 'vm', getChatToken: async () => 'chat', deliver: fake.deliver, now: () => 42 });
  const files = [{ name: 'a.pdf', size: 1, gcsPath: 'files/out/w-1/a.pdf' }];
  assert.equal(await out.send(DASH, 'hello', { attachments: files }), true);
  const { addr, text, opts } = fake.calls[0];
  assert.deepEqual(addr, DASH);
  assert.equal(text, 'hello');
  assert.equal(opts.token, 'vm');
  assert.equal(opts.replyInThread, true);
  assert.deepEqual(opts.attachments, files);
  assert.equal(out.lastSpokenAt(DASH), 42);
});

test('a Chat send uses the Workspace token, the mentions and the thread setting', async () => {
  const fake = fakeDeliver();
  const out = createOutbound({ getVmToken: async () => 'vm', getChatToken: async () => 'chat', replyInThread: false, deliver: fake.deliver });
  await out.send(CHAT, 'hi', { mentions: ['ana@example.com'] });
  assert.equal(fake.calls[0].opts.token, 'chat');
  assert.equal(fake.calls[0].opts.replyInThread, false);
  assert.deepEqual(fake.calls[0].opts.mentions, ['ana@example.com']);
});

test('a refused send returns false and does not count as speaking', async () => {
  const fake = fakeDeliver(false);
  const out = createOutbound({ getVmToken: async () => 'vm', deliver: fake.deliver, now: () => 42 });
  assert.equal(await out.send(DASH, 'hello'), false);
  assert.equal(out.lastSpokenAt(DASH), 0);
});

test('Chat on an instance without a Workspace account can never be delivered', async () => {
  const out = createOutbound({ getVmToken: async () => 'vm', deliver: fakeDeliver().deliver });
  await assert.rejects(out.send(CHAT, 'hi'), UndeliverableError);
});

test("the channel's prefixed log lines become levels", async () => {
  const logs = [];
  const out = createOutbound({ getVmToken: async () => 'vm', deliver: fakeDeliver().deliver, log: (...a) => logs.push(a) });
  await out.send(DASH, 'x');
  assert.deepEqual(logs[0], ['ERROR', 'Chat POST failed', { status: 500 }]);
});

test('each destination has its own key', () => {
  assert.equal(addressKey(DASH), 'dashboard||th-1');
  assert.notEqual(addressKey(CHAT), addressKey({ ...CHAT, thread: null }));
  assert.equal(addressKey(null), '||');
});

test("a Chat send passes its key through, and counts how Chat answered for the health file", async () => {
  let answer = { ok: true, status: 200, error: null };
  const deliver = async (addr, text, opts) => { opts.report(answer); return answer.ok; };
  const out = createOutbound({ getVmToken: async () => 'vm', getChatToken: async () => 'chat', deliver, now: () => Date.parse('2026-10-17T12:00:00Z') });
  await out.send(CHAT, 'hi', { key: 'delivery:w-1:abc' });
  assert.deepEqual(out.chatStatus(), { sent: 1, refused: 0, last_sent_at: '2026-10-17T12:00:00.000Z', last_error: null, last_error_at: null });
  answer = { ok: false, status: 403, error: 'The caller does not have permission' };
  await out.send(CHAT, 'hi');
  await out.send(DASH, 'dashboard sends are not Chat');
  assert.deepEqual(out.chatStatus(), {
    sent: 1, refused: 1, last_sent_at: '2026-10-17T12:00:00.000Z', last_error: 'The caller does not have permission',
    last_error_at: '2026-10-17T12:00:00.000Z',
  });
  const keyed = [];
  const out2 = createOutbound({ getVmToken: async () => 'vm', getChatToken: async () => 'chat', deliver: async (a, t, o) => { keyed.push(o.messageKey); return true; } });
  await out2.send(CHAT, 'x', { key: 'status:w-1:0' });
  assert.deepEqual(keyed, ['status:w-1:0']);
});

test('a Workspace token that cannot be had is counted as a refused Chat send, and thrown', async () => {
  const out = createOutbound({ getVmToken: async () => 'vm', getChatToken: async () => { throw new Error('unauthorized_client'); }, deliver: fakeDeliver().deliver });
  await assert.rejects(out.send(CHAT, 'hi'), /unauthorized_client/);
  assert.equal(out.chatStatus().refused, 1);
  assert.match(out.chatStatus().last_error, /no Workspace token: unauthorized_client/);
});
