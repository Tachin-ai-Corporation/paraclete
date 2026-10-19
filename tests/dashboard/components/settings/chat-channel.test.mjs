// Tests for dashboard/components/settings/chat-channel.js: the Google Chat block of Settings, System,
// from the ears' and the mouth's heartbeats: off, connecting with Google's reason, ready with what it
// reads, and the errors that need a person's attention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatChannelView, count } from '../../../../dashboard/components/settings/chat-channel.js';

const ready = (over = {}) => ({
  state: 'ready', account: 'agent@example.com', last_poll_at: '2026-10-17T12:00:05Z', last_ok_at: '2026-10-17T12:00:05Z',
  last_error: null, spaces: 3, direct_messages: 1, external_spaces: 0, known_users: 2, agent_user_id: 'users/900',
  rate_limited: false, taken_in: 4, ...over,
});

test('without a Workspace account, Chat is off and says why; without a report, it is unknown', () => {
  const off = chatChannelView({ state: 'off', account: null });
  assert.deepEqual([off.state, off.badge, off.error, off.facts], ['off', { level: 'neutral', label: 'off' }, null, []]);
  assert.match(off.summary, /no Workspace account/);
  assert.equal(chatChannelView(undefined).state, 'unknown');
  assert.equal(chatChannelView(null).badge.level, 'warn');
});

test("while the account's token fails, it is connecting, with Google's reason", () => {
  const view = chatChannelView({ state: 'connecting', account: 'agent@example.com', last_error: 'waiting for the Workspace token: unauthorized_client' });
  assert.equal(view.badge.label, 'connecting');
  assert.equal(view.error, 'waiting for the Workspace token: unauthorized_client');
  assert.deepEqual(view.facts, [{ label: 'Account', value: 'agent@example.com' }]);
});

test('ready: the account, what it reads, how many of those admit outsiders, and what the mouth sent', () => {
  const view = chatChannelView(ready({ external_spaces: 2 }), { sent: 5, refused: 0, last_sent_at: '2026-10-17T12:00:00Z', last_error: null });
  assert.deepEqual(view.badge, { level: 'ok', label: 'ready' });
  assert.equal(view.error, null);
  assert.deepEqual(view.facts, [
    { label: 'Account', value: 'agent@example.com' },
    { label: 'Reads', value: '3 spaces and 1 direct message' },
    { label: 'Open to outsiders', value: "2 spaces of them: people outside the organization see the agent's answers there" },
    { label: 'Dashboard users known in Chat', value: '2' },
    { label: 'Last read', value: '2026-10-17T12:00:05Z', at: '2026-10-17T12:00:05Z' },
    { label: 'Messages taken in', value: '4' },
    { label: 'Replies sent', value: '5' },
  ]);
});

test('a read error, a rate limit or a refused post since the last good one shows, and the badge says so', () => {
  assert.deepEqual(chatChannelView(ready({ last_error: '1 space(s) could not be read' })).badge, { level: 'warn', label: 'ready, with errors' });
  assert.deepEqual(chatChannelView(ready({ rate_limited: true, last_error: 'the Chat API quota is spent' })).badge, { level: 'warn', label: 'rate limited' });
  const refused = chatChannelView(ready(), {
    sent: 2, refused: 1, last_sent_at: '2026-10-17T11:00:00.000Z', last_error: 'The caller does not have permission', last_error_at: '2026-10-17T11:30:00.000Z',
  });
  assert.equal(refused.error, 'Sending: The caller does not have permission');
  assert.equal(refused.facts.at(-1).value, '2, 1 refused');
  const recovered = chatChannelView(ready(), {
    sent: 3, refused: 1, last_sent_at: '2026-10-17T11:45:00.000Z', last_error: 'old', last_error_at: '2026-10-17T11:30:00.000Z',
  });
  assert.equal(recovered.error, null, 'a post accepted since the error clears it');
  assert.equal(count(1, 'space'), '1 space');
  assert.equal(count(undefined, 'space'), '0 spaces');
});
