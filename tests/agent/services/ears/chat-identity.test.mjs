// Tests for agent/services/ears/chat-identity.mjs: which dashboard user sent a Chat message, learned
// only through each user's direct message with the agent; how often the users list is read again;
// and that a user who left the dashboard is forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatIdentity, dashboardUserEmails } from '../../../../agent/services/ears/chat-identity.mjs';
import { ChatApiError } from '../../../../agent/providers/channel.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');

function identity({ users = ['ana@example.com'], dms = { 'ana@example.com': 'spaces/D' }, people = {}, clock = { now: NOW }, find } = {}) {
  const lookups = [];
  const state = { users: [...users] };
  const id = createChatIdentity({
    readUsers: async () => state.users,
    findDirectMessage: find || (async (token, email) => { lookups.push(email); return dms[email] ?? null; }),
    agentAccount: 'agent@example.com',
    people,
    now: () => clock.now,
    log: () => {},
  });
  return { id, lookups, state, clock };
}

const from = (sender) => ({ sender: { name: sender, type: 'HUMAN' } });

test("the users list is read from the dashboard's records: only a valid role makes a user", () => {
  assert.deepEqual(dashboardUserEmails([
    { id: 'Ana@Example.com', role: 'admin' }, { id: 'ben@example.com', role: 'member' },
    { id: 'old@example.com', role: 'guest' }, { id: 'not-an-email', role: 'admin' }, null,
  ]), ['ana@example.com', 'ben@example.com']);
});

test("a direct message's other member is its dashboard user; their id then counts in any space", async () => {
  const t = identity();
  await t.id.refresh('token');
  assert.equal(t.id.emailOf('users/1', 'spaces/D', true), 'ana@example.com');
  assert.equal(t.id.emailOf('users/1', 'spaces/A', false), null, 'not known in a space before she writes in her direct message');
  t.id.learn(from('users/1'), 'spaces/D');
  assert.equal(t.id.emailOf('users/1', 'spaces/A', false), 'ana@example.com');
  assert.deepEqual(t.id.saveable(), { 'users/1': 'ana@example.com' });
  assert.equal(t.id.known(), 1);
  t.id.learn(from('users/2'), 'spaces/X');
  assert.equal(t.id.emailOf('users/2', 'spaces/X', true), null, 'a direct message with nobody the dashboard knows teaches nothing');
});

test('the list is read again every ten minutes; a new direct message asks sooner, at most once a minute', async () => {
  const t = identity({ users: ['ana@example.com', 'ben@example.com', 'agent@example.com'], dms: {} });
  await t.id.refresh('token');
  assert.deepEqual(t.lookups, ['ana@example.com', 'ben@example.com'], "never the agent's own account");
  t.clock.now += 30_000;
  await t.id.refresh('token', { force: true });
  assert.equal(t.lookups.length, 2, 'a forced refresh within the minute waits');
  t.clock.now += 40_000;
  await t.id.refresh('token');
  assert.equal(t.lookups.length, 2, 'an ordinary refresh waits ten minutes');
  await t.id.refresh('token', { force: true });
  assert.equal(t.lookups.length, 4, 'people with no direct message yet are looked up again');
});

test('a user removed from the dashboard is forgotten, and no longer matched', async () => {
  const t = identity({ people: { 'users/1': 'ana@example.com', 'bad/1': 'x@example.com' } });
  assert.equal(t.id.emailOf('users/1', 'spaces/A', false), 'ana@example.com', 'remembered from the last run');
  assert.deepEqual(t.id.saveable(), { 'users/1': 'ana@example.com' }, 'only user ids are kept');
  await t.id.refresh('token');
  t.state.users = [];
  t.clock.now += 600_000;
  await t.id.refresh('token');
  assert.equal(t.id.emailOf('users/1', 'spaces/A', false), null);
  assert.equal(t.id.emailOf('users/1', 'spaces/D', true), null);
  assert.deepEqual(t.id.saveable(), {});
});

test('a rate limit propagates; any other lookup failure waits for the next refresh', async () => {
  const limited = identity({ find: async () => { throw new ChatApiError('finding a direct message', 429); } });
  await assert.rejects(limited.id.refresh('token'), /HTTP 429/);
  const broken = identity({ find: async () => { throw new ChatApiError('finding a direct message', 403, 'denied'); } });
  await broken.id.refresh('token');
  assert.equal(broken.id.emailOf('users/1', 'spaces/D', true), null);
});
