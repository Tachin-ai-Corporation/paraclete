// Tests for agent/services/ears/inbound.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboundHandler } from '../../../../agent/services/ears/inbound.mjs';
import { createInboundGate } from '../../../../agent/services/ears/inbound-gate.mjs';
import { makeAddress } from '../../../../agent/providers/channel.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { fakeDb } from './fake-db.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');

function setup({ db = fakeDb(), clock = { now: NOW } } = {}) {
  const consumed = [];
  const preprocessed = [];
  const inbox = { consume: async (m) => { consumed.push(m.id); } };
  const handle = createInboundHandler({
    db,
    collections: COLLECTIONS,
    gate: createInboundGate({ dedupWindowMs: 300_000, cooldownMs: 2_000, now: () => clock.now }),
    preprocess: async (text) => { preprocessed.push(text); return `${text} [repaired]`; },
    now: () => clock.now,
  });
  return { db, clock, consumed, preprocessed, inbox, handle };
}

const dashboard = (over = {}) => ({
  channel: 'dashboard', id: 'msg-1', text: 'Draft the plan', rawText: 'Draft the plan', timestamp: '2026-10-17T11:59:00Z',
  sender: 'ana@example.com', senderName: 'Ana', address: makeAddress('dashboard', { thread: 'th-1' }), attachments: [], ...over,
});

test('a message becomes an intake, then is marked consumed', async () => {
  const t = setup();
  assert.equal(await t.handle(dashboard(), t.inbox), 'created');
  const intake = t.db.get('intake/i-dashboard-msg-1');
  assert.equal(intake.text, 'Draft the plan');
  assert.equal(intake.created_at, '2026-10-17T12:00:00.000Z');
  assert.deepEqual(t.consumed, ['msg-1']);
  assert.deepEqual(t.preprocessed, [], 'dashboard text arrives as typed');
});

test('a Chat message is repaired before it is classified', async () => {
  const t = setup();
  await t.handle(dashboard({ channel: 'gchat', id: 'spaces/A/messages/1', address: makeAddress('gchat', { space: 'spaces/A' }) }), t.inbox);
  assert.equal(t.db.get('intake/i-gchat-spaces~A~messages~1').text, 'Draft the plan [repaired]');
});

test('a duplicate or a message inside the cooldown is consumed without an intake', async () => {
  const t = setup();
  await t.handle(dashboard(), t.inbox);
  t.clock.now += 1_000;
  assert.equal(await t.handle(dashboard({ id: 'msg-2', text: 'and the budget' }), t.inbox), 'cooldown');
  t.clock.now += 60_000;
  assert.equal(await t.handle(dashboard({ id: 'msg-3' }), t.inbox), 'duplicate');
  assert.deepEqual(t.consumed, ['msg-1', 'msg-2', 'msg-3']);
  assert.equal(t.db.get('intake/i-dashboard-msg-2'), undefined);
  assert.equal(t.db.get('intake/i-dashboard-msg-3'), undefined);
});

test('a failed intake write leaves the message unconsumed and does not count it as seen', async () => {
  const t = setup();
  t.db.fail('commit');
  await assert.rejects(t.handle(dashboard(), t.inbox));
  assert.deepEqual(t.consumed, [], 'the next poll reads it again');
  t.db.heal('commit');
  assert.equal(await t.handle(dashboard(), t.inbox), 'created', 'the retry is not dropped as a duplicate');
});

test('a message read again after a crash finds its intake and is only consumed', async () => {
  const db = fakeDb();
  const first = setup({ db });
  await first.handle(dashboard(), { consume: async () => { throw new Error('crash before consume'); } }).catch(() => {});
  const restarted = setup({ db });
  assert.equal(await restarted.handle(dashboard(), restarted.inbox), 'exists');
  assert.deepEqual(restarted.consumed, ['msg-1']);
});
