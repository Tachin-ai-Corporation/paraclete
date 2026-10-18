// Tests for agent/services/mouth/delivery.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAddress, deliveryDecision, mentionsFor, attachmentsOf, contextHintFor, failureUpdate, contentDigest, createDelivery,
} from '../../../../agent/services/mouth/delivery.mjs';
import { UndeliverableError } from '../../../../agent/services/mouth/outbound.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { fakeDb } from '../ears/fake-db.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const DASH = { channel: 'dashboard', thread: 'th-1' };
const CHAT = { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t' };

const envelope = (over = {}) => ({
  id: 'w-1', type: 'M', parent_id: null, status: 'complete', intent: 'decide', output: 'The report is ready.',
  instruction: 'Write the report', created_at: '2026-10-17T11:00:00.000Z', delivery_status: 'pending',
  delivery_address: DASH, source_channel: 'dashboard', source_meta: { address: DASH, sender: 'ana@example.com' }, ...over,
});

describe('pure helpers', () => {
  test('the address comes from delivery_address, then source_meta, then the channel', () => {
    assert.deepEqual(resolveAddress(envelope()), DASH);
    assert.deepEqual(resolveAddress(envelope({ delivery_address: null, source_meta: { address: CHAT } })), CHAT);
    assert.deepEqual(resolveAddress(envelope({ delivery_address: null, source_meta: {}, source_channel: 'system' })), { channel: 'dashboard', thread: null });
    assert.deepEqual(resolveAddress(envelope({ delivery_address: null, source_meta: null, source_channel: 'gchat' })), { channel: 'gchat', space: null, thread: null });
    assert.deepEqual(resolveAddress(envelope({ delivery_address: { channel: 'gchat', space: 'AAA' } })), { channel: 'gchat', space: 'spaces/AAA', thread: null });
  });

  test('what to do with a pending envelope', () => {
    const at = (over) => deliveryDecision(envelope(over), NOW);
    assert.equal(at({}), 'deliver');
    assert.equal(at({ delivery_status: 'delivered' }), 'skip');
    assert.equal(at({ status: 'archived' }), 'skip');
    assert.equal(at({ id: '' }), 'skip');
    for (const status of ['pending', 'planned', 'queued', 'active']) assert.equal(at({ status, output: 'partial' }), 'not_ready', status);
    for (const status of ['needs_input', 'blocked', 'failed', 'waiting', 'awaiting_approval']) assert.equal(at({ status }), 'deliver', status);
    assert.equal(at({ delivery_attempts: 2, next_delivery_attempt_at: '2026-10-17T12:00:30.000Z' }), 'backoff');
    assert.equal(at({ delivery_attempts: 2, next_delivery_attempt_at: '2026-10-17T11:59:30.000Z' }), 'deliver');
    assert.equal(at({ type: 'T', parent_id: 'w-c', intent: 'ack' }), 'deliver');
    assert.equal(at({ type: 'T', parent_id: 'w-c', intent: 'notification' }), 'deliver');
    assert.equal(at({ type: 'T', parent_id: 'w-c', intent: 'execute' }), 'internal');
    assert.equal(at({ type: 'M', parent_id: 'w-r', intent: 'decide' }), 'deliver', 'a responsibility mission reaches people');
    assert.equal(at({ output: '  ' }), 'empty');
  });

  test('mentions: the asker on Chat, everyone when stuck, nobody on the dashboard', () => {
    assert.deepEqual(mentionsFor(envelope(), CHAT), ['ana@example.com']);
    assert.deepEqual(mentionsFor(envelope({ source_meta: { sender: 'users/123' } }), CHAT), ['123']);
    assert.deepEqual(mentionsFor(envelope({ source_meta: {}, status: 'blocked' }), CHAT), ['all']);
    assert.deepEqual(mentionsFor(envelope({ source_meta: {} }), CHAT), []);
    assert.deepEqual(mentionsFor(envelope(), DASH), []);
    assert.deepEqual(mentionsFor(envelope(), { channel: 'gchat', space: 'spaces/D', thread: null }), [],
      'a direct message mentions no one: the one person there hears it anyway');
  });

  test('attachments come from the exported files', () => {
    const files = [{ name: 'a.pdf', size: 10, gcsPath: 'files/out/w-1/a.pdf', contentType: 'application/pdf' }, { name: 'bad' }];
    assert.deepEqual(attachmentsOf(envelope({ context: { attachments_export: files } })), [{ name: 'a.pdf', size: 10, gcsPath: 'files/out/w-1/a.pdf' }]);
    assert.deepEqual(attachmentsOf(envelope({ context: { attachments: [files[0]] } })).length, 1);
    assert.deepEqual(attachmentsOf(envelope()), []);
  });

  test('guidance by status, then by intent', () => {
    assert.match(contextHintFor(envelope({ status: 'needs_input' })), /needs their input/);
    assert.match(contextHintFor(envelope({ status: 'blocked' })), /blocked/);
    assert.match(contextHintFor(envelope({ intent: 'notification' })), /status notification/);
    assert.match(contextHintFor(envelope({ intent: 'ack' })), /acknowledgment/);
    assert.match(contextHintFor(envelope({ intent: 'respond' })), /do not mention tasks/);
    assert.equal(contextHintFor(envelope()), '');
  });

  test('failures back off exponentially, cap the wait, and end at the attempt limit', () => {
    const retry = { max_attempts: 8, retry_backoff_base_seconds: 5, retry_backoff_max_seconds: 600 };
    const first = failureUpdate(0, 'refused', NOW, retry);
    assert.deepEqual(first, {
      attempts: 1, terminal: false, mask: ['delivery_attempts', 'delivery_error', 'next_delivery_attempt_at'],
      fields: {
        delivery_attempts: { integerValue: '1' }, delivery_error: { stringValue: 'refused' },
        next_delivery_attempt_at: { stringValue: '2026-10-17T12:00:10.000Z' },
      },
    });
    assert.equal(failureUpdate(6, 'x', NOW, retry).fields.next_delivery_attempt_at.stringValue, '2026-10-17T12:10:00.000Z', 'capped at 600s');
    const last = failureUpdate(7, 'x', NOW, retry);
    assert.equal(last.terminal, true);
    assert.deepEqual(last.fields.delivery_status, { stringValue: 'failed' });
    assert.equal(failureUpdate(0, 'no space', NOW, retry, true).terminal, true, 'undeliverable fails at once');
    assert.equal(failureUpdate(0, 'e'.repeat(900), NOW, retry).fields.delivery_error.stringValue.length, 500);
  });

  test('the digest changes with status or output only', () => {
    assert.equal(contentDigest(envelope()), contentDigest(envelope({ updated_at: 'later', delivery_status: 'delivered' })));
    assert.notEqual(contentDigest(envelope()), contentDigest(envelope({ output: 'Another answer.' })));
    assert.notEqual(contentDigest(envelope()), contentDigest(envelope({ status: 'needs_input' })));
  });
});

/** A delivery pass over a fake db, with a recording voice, sender and ledger. */
function setup(docs = {}, { sendOk = true, voiced = (input) => ({ action: 'deliver', text: `voiced: ${input.rawText}`, voiced: 'yes' }), clock = { now: NOW } } = {}) {
  const db = fakeDb(docs);
  const sent = [];
  const voiceCalls = [];
  const turns = [];
  const logs = [];
  let ok = sendOk;
  const outbound = {
    send: async (addr, text, opts) => {
      if (addr.channel === 'gchat' && addr.space === 'spaces/NOCHAT') throw new UndeliverableError('Google Chat is not set up on this instance');
      sent.push({ addr, text, opts });
      return typeof ok === 'function' ? ok() : ok;
    },
  };
  const delivery = createDelivery({
    db,
    collections: COLLECTIONS,
    outbound,
    voice: async (input) => { voiceCalls.push(input); return voiced(input); },
    voicingTail: async ({ address, envelope: env }) => `tail for ${address.thread} / ${env.id}`,
    appendTurn: async (turn) => { turns.push(turn); return true; },
    retry: { max_attempts: 3, retry_backoff_base_seconds: 5, retry_backoff_max_seconds: 600 },
    log: (...a) => logs.push(a),
    now: () => clock.now,
  });
  return { db, sent, voiceCalls, turns, logs, delivery, setOk: (v) => { ok = v; } };
}

describe('the delivery pass', () => {
  test('pending envelopes go out oldest first, voiced, to their Address, and are marked delivered', async () => {
    const t = setup({
      'work/w-2': envelope({ id: 'w-2', created_at: '2026-10-17T11:05:00.000Z', output: 'Final answer.' }),
      'work/w-ack': envelope({
        id: 'w-ack', type: 'T', parent_id: 'w-c', intent: 'ack', output: 'Got it.', created_at: '2026-10-17T11:00:01.000Z',
        context: { attachments_export: [{ name: 'a.pdf', size: 3, gcsPath: 'files/out/w-2/a.pdf' }] },
      }),
    });
    assert.deepEqual(await t.delivery.pass(), { delivered: 2, failed: 0, waiting: 0 });
    assert.deepEqual(t.sent.map((s) => s.text), ['voiced: Got it.', 'voiced: Final answer.']);
    assert.deepEqual(t.sent[0].addr, DASH);
    assert.deepEqual(t.sent[0].opts, {
      mentions: [], attachments: [{ name: 'a.pdf', size: 3, gcsPath: 'files/out/w-2/a.pdf' }],
      key: `delivery:w-ack:${contentDigest({ status: 'complete', output: 'Got it.' })}`,
    }, 'keyed by the envelope and what it says, so a delivery retried after a crash posts once');
    assert.deepEqual(t.voiceCalls[0], {
      rawText: 'Got it.', question: 'Write the report', contextHint: 'This is a quick acknowledgment: keep it very short.',
      convoTail: 'tail for th-1 / w-ack',
    });

    const done = t.db.get('work/w-2');
    assert.equal(done.delivery_status, 'delivered');
    assert.equal(done.delivered_channel, 'dashboard');
    assert.equal(done.delivered_at, '2026-10-17T12:00:00.000Z');
    assert.equal(done.output, 'Final answer.', 'only the delivery fields are written');

    assert.deepEqual(t.turns.map((x) => [x.threadKey, x.turnId, x.role, x.text]), [
      ['th-1', 'd-w-ack', 'agent', 'voiced: Got it.'],
      ['th-1', 'd-w-2', 'agent', 'voiced: Final answer.'],
    ]);
  });

  test('work under way, backing off or already handled is left alone', async () => {
    const docs = {
      'work/active': envelope({ id: 'active', status: 'active', output: null }),
      'work/queued': envelope({ id: 'queued', status: 'queued', output: 'stale' }),
      'work/backoff': envelope({ id: 'backoff', delivery_attempts: 1, next_delivery_attempt_at: '2026-10-17T12:05:00.000Z' }),
      'work/archived': envelope({ id: 'archived', status: 'archived' }),
    };
    const t = setup(docs);
    assert.deepEqual(await t.delivery.pass(), { delivered: 0, failed: 0, waiting: 4 });
    assert.equal(t.sent.length, 0);
    for (const id of Object.keys(docs)) assert.equal(t.db.get(id).delivery_status, 'pending', `${id} untouched`);
  });

  test('an internal task is marked internal; a finished envelope with no output is marked delivered unsaid', async () => {
    const t = setup({
      'work/task': envelope({ id: 'task', type: 'T', parent_id: 'w-c', intent: 'execute' }),
      'work/empty': envelope({ id: 'empty', output: '' }),
    });
    await t.delivery.pass();
    assert.equal(t.db.get('work/task').delivery_status, 'internal');
    assert.equal(t.db.get('work/empty').delivery_status, 'delivered');
    assert.equal(t.sent.length, 0);
  });

  test('a message the channel refuses is a failed attempt, retried with backoff, then failed for good', async () => {
    const clock = { now: NOW };
    const t = setup({ 'work/w-1': envelope() }, { sendOk: false, clock });
    assert.deepEqual(await t.delivery.pass(), { delivered: 0, failed: 1, waiting: 0 });
    let env = t.db.get('work/w-1');
    assert.equal(env.delivery_status, 'pending', 'a refused message is not marked delivered');
    assert.equal(env.delivery_attempts, 1);
    assert.equal(env.next_delivery_attempt_at, '2026-10-17T12:00:10.000Z');
    assert.match(env.delivery_error, /the dashboard channel refused the message/);

    await t.delivery.pass();
    assert.equal(t.sent.length, 1, 'nothing is sent during the backoff');
    clock.now += 11_000;
    await t.delivery.pass();
    clock.now += 60_000;
    await t.delivery.pass();
    env = t.db.get('work/w-1');
    assert.equal(env.delivery_attempts, 3);
    assert.equal(env.delivery_status, 'failed');
    assert.ok(t.logs.some(([level, message]) => level === 'ERROR' && message === 'delivery failed for good'));
  });

  test('a Chat address without a space, or Chat without a Workspace account, fails at once', async () => {
    const t = setup({
      'work/nospace': envelope({ id: 'nospace', delivery_address: { channel: 'gchat' }, source_channel: 'gchat' }),
      'work/nochat': envelope({ id: 'nochat', delivery_address: { channel: 'gchat', space: 'spaces/NOCHAT' } }),
    });
    await t.delivery.pass();
    assert.equal(t.db.get('work/nospace').delivery_status, 'failed');
    assert.match(t.db.get('work/nospace').delivery_error, /no Chat space/);
    assert.equal(t.db.get('work/nochat').delivery_status, 'failed');
  });

  test('a stale copy that sets the same content back to pending is marked again, not said twice', async () => {
    const t = setup({ 'work/w-1': envelope() });
    await t.delivery.pass();
    await t.db.write('work/w-1', envelope());
    await t.delivery.pass();
    assert.equal(t.sent.length, 1);
    assert.equal(t.db.get('work/w-1').delivery_status, 'delivered');

    await t.db.write('work/w-1', envelope({ status: 'needs_input', output: 'Which quarter do you mean?' }));
    await t.delivery.pass();
    assert.equal(t.sent.length, 2, 'new content set to pending is said');
  });

  test('an envelope that changed while it was voiced stays pending for its new content', async () => {
    const t = setup({ 'work/w-1': envelope() }, {
      voiced: (input) => {
        t.db.docs.set('work/w-1', { ...t.db.get('work/w-1'), output: 'A newer answer.' });
        return { action: 'deliver', text: input.rawText, voiced: 'yes' };
      },
    });
    await t.delivery.pass();
    assert.equal(t.db.get('work/w-1').delivery_status, 'pending');
    await t.delivery.pass();
    assert.deepEqual(t.sent.map((s) => s.text), ['The report is ready.', 'A newer answer.']);
    assert.equal(t.db.get('work/w-1').delivery_status, 'delivered');
  });

  test('a sent message that could not be marked is marked on the next pass, not sent again', async () => {
    const t = setup({ 'work/w-1': envelope() });
    t.db.fail('readDoc');
    assert.deepEqual(await t.delivery.pass(), { delivered: 1, failed: 0, waiting: 0 });
    assert.equal(t.db.get('work/w-1').delivery_status, 'pending');
    assert.equal(t.db.get('work/w-1').delivery_attempts, undefined, 'not counted as a failed delivery');
    t.db.heal('readDoc');
    await t.delivery.pass();
    assert.equal(t.sent.length, 1);
    assert.equal(t.db.get('work/w-1').delivery_status, 'delivered');
  });

  test('a suppressed envelope is marked delivered with nothing sent or recorded', async () => {
    const t = setup({ 'work/w-1': envelope() }, { voiced: () => ({ action: 'suppress', text: '', voiced: 'suppressed' }) });
    await t.delivery.pass();
    assert.equal(t.sent.length, 0);
    assert.equal(t.turns.length, 0);
    assert.equal(t.db.get('work/w-1').delivery_status, 'delivered');
  });

  test('the guidance for the voice never ends up in the text when it goes out unvoiced', async () => {
    const t = setup({ 'work/w-1': envelope({ intent: 'ack', type: 'T', parent_id: 'w-c', output: 'Got it.' }) }, {
      voiced: (input) => ({ action: 'deliver', text: input.rawText, voiced: 'raw' }),
    });
    await t.delivery.pass();
    assert.equal(t.sent[0].text, 'Got it.');
  });

  test('an artifact-only body gets a plain summary line', async () => {
    const t = setup({ 'work/w-1': envelope({ output: '\n📎 Artifacts: report.md', context: { attachments_export: [{ name: 'r.md', size: 1, gcsPath: 'files/out/w-1/r.md' }] } }) }, {
      voiced: (input) => ({ action: 'deliver', text: input.rawText, voiced: 'raw' }),
    });
    await t.delivery.pass();
    assert.match(t.sent[0].text, /^I finished this, but no written summary was generated: 1 file was produced\./);
  });

  test('Chat deliveries mention the person who asked', async () => {
    const t = setup({ 'work/w-1': envelope({ delivery_address: CHAT, source_channel: 'gchat' }) });
    await t.delivery.pass();
    assert.deepEqual(t.sent[0].opts.mentions, ['ana@example.com']);
    assert.equal(t.turns[0].threadKey, 'gchat-spaces~A~threads~t');
  });

  test('the queue query is strict and needs no composite index', async () => {
    const t = setup();
    const seen = [];
    const spy = createDelivery({
      db: { ...t.db, query: async (...args) => { seen.push(args); return []; } },
      collections: COLLECTIONS, outbound: {}, voice: async () => ({}), voicingTail: async () => '', appendTurn: async () => true,
    });
    await spy.pass();
    assert.deepEqual(seen[0].slice(0, 3), ['', 'work', [{ field: 'delivery_status', op: 'EQUAL', value: { stringValue: 'pending' } }]]);
    assert.equal(seen[0][3].noOrderBy, true);
    assert.equal(seen[0][3].strict, true);

    t.db.fail('query');
    await assert.rejects(t.delivery.pass(), /fake outage/);
  });
});
