// Tests for agent/services/ears/inbound-gate.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboundGate, dedupKey } from '../../../../agent/services/ears/inbound-gate.mjs';

const at = (t) => () => t.now;
const msg = (over = {}) => ({
  channel: 'dashboard', id: 'm-1', text: 'Draft the report', sender: 'ana@example.com',
  address: { channel: 'dashboard', thread: 'th-1' }, attachments: [], ...over,
});

test('the same message from the same person in the same thread inside the window is a duplicate', () => {
  const clock = { now: 0 };
  const gate = createInboundGate({ dedupWindowMs: 300_000, cooldownMs: 2_000, now: at(clock) });
  assert.equal(gate.check(msg()), 'accept');
  gate.record(msg());
  clock.now = 60_000;
  assert.equal(gate.check(msg({ id: 'm-2', text: '  DRAFT the report ' })), 'duplicate');
  clock.now = 300_001;
  assert.equal(gate.check(msg({ id: 'm-3' })), 'accept', 'the window expired');
});

test('two people saying the same thing are not duplicates of each other', () => {
  const clock = { now: 0 };
  const gate = createInboundGate({ now: at(clock) });
  gate.record(msg({ text: 'yes' }));
  clock.now = 10_000;
  assert.equal(gate.check(msg({ id: 'm-2', text: 'yes', sender: 'ben@example.com', address: { channel: 'dashboard', thread: 'th-2' } })), 'accept');
  assert.equal(gate.check(msg({ id: 'm-3', text: 'yes', address: { channel: 'dashboard', thread: 'th-9' } })), 'accept',
    'the same person in another conversation is not a duplicate either');
});

test('the cooldown applies per person, not to the whole channel', () => {
  const clock = { now: 0 };
  const gate = createInboundGate({ cooldownMs: 2_000, now: at(clock) });
  gate.record(msg());
  clock.now = 1_000;
  assert.equal(gate.check(msg({ id: 'm-2', text: 'and the summary' })), 'cooldown');
  assert.equal(gate.check(msg({ id: 'm-3', text: 'something else', sender: 'ben@example.com' })), 'accept');
  clock.now = 2_000;
  assert.equal(gate.check(msg({ id: 'm-4', text: 'and the summary' })), 'accept');
});

test('check does not remember: a message whose intake failed is not a duplicate when retried', () => {
  const gate = createInboundGate({ now: () => 0 });
  assert.equal(gate.check(msg()), 'accept');
  assert.equal(gate.check(msg()), 'accept');
});

test('files count in the key by object path, so a second upload of the same name is new', () => {
  const a = msg({ text: '', attachments: [{ name: 'q3.pdf', gcsPath: 'files/in/u-1/q3.pdf' }] });
  const b = msg({ text: '', attachments: [{ name: 'q3.pdf', gcsPath: 'files/in/u-2/q3.pdf' }] });
  assert.notEqual(dedupKey(a), dedupKey(b));
  assert.equal(dedupKey(a), dedupKey({ ...a, id: 'other' }));
});
