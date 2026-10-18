// Tests for agent/services/ears/intake.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIntake, intakeIdFor, writeIntake } from '../../../../agent/services/ears/intake.mjs';
import { makeAddress, parseAddress, serializeAddress } from '../../../../agent/providers/channel.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { fakeDb } from './fake-db.mjs';

const CREATED = '2026-10-17T12:00:00.000Z';

const dashboardMsg = (over = {}) => ({
  channel: 'dashboard', id: 'Xk2b9QdashMsg01', text: 'Summarize the attached sheet', rawText: 'Summarize the attached sheet',
  timestamp: '2026-10-17T11:59:59Z', sender: 'ana@example.com', senderName: 'Ana',
  address: makeAddress('dashboard', { thread: 'th-ana' }),
  attachments: [{ name: 'sales.xlsx', size: 2048, gcsPath: 'files/in/u-7/sales.xlsx' }], ...over,
});

test('an intake id comes from the channel and its message id, safe as a document id', () => {
  assert.equal(intakeIdFor('dashboard', 'Xk2b9Q'), 'i-dashboard-Xk2b9Q');
  assert.equal(intakeIdFor('gchat', 'spaces/AAA/messages/BBB.CCC'), 'i-gchat-spaces~AAA~messages~BBB.CCC');
  assert.throws(() => intakeIdFor('gchat', ''), /messageId is required/);
});

test('a dashboard intake carries its thread on the Address, the sender and the files', () => {
  const intake = buildIntake(dashboardMsg(), { createdAt: CREATED });
  assert.deepEqual(intake, {
    id: 'i-dashboard-Xk2b9QdashMsg01',
    text: 'Summarize the attached sheet',
    source: 'dashboard',
    status: 'pending',
    created_at: CREATED,
    attachments: [{ name: 'sales.xlsx', size: 2048, gcsPath: 'files/in/u-7/sales.xlsx' }],
    source_meta: {
      address: { channel: 'dashboard', thread: 'th-ana' },
      channel_msg_id: 'Xk2b9QdashMsg01',
      raw_text: 'Summarize the attached sheet',
      sender: 'ana@example.com',
      sender_name: 'Ana',
    },
  });
});

test('the stored Address decodes to the Address the message arrived with', () => {
  const addr = makeAddress('gchat', { space: 'spaces/AAA', thread: 'spaces/AAA/threads/t1' });
  const intake = buildIntake(dashboardMsg({ channel: 'gchat', id: 'spaces/AAA/messages/m1', address: addr, attachments: [] }), { createdAt: CREATED });
  assert.deepEqual(intake.source_meta.address, { channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/t1' });
  assert.deepEqual(parseAddress({ address: serializeAddress(intake.source_meta.address) }, 'dashboard'), addr);
});

test('a Chat intake keeps the repaired text to classify, the raw message, and its conversation as JSON', () => {
  const conversation = { block: '## Conversation', turns: [], last_user_text: null, last_agent_text: null, cue_text: '' };
  const intake = buildIntake(dashboardMsg({
    channel: 'gchat', id: 'spaces/AAA/messages/m1', text: '[Current message - respond to this]\nUser: open file_a',
    rawText: '@Paraclete open file_a', attachments: [], conversation,
    address: makeAddress('gchat', { space: 'spaces/AAA' }),
  }), { text: '[Current message - respond to this]\nUser: open file_a (repaired)', createdAt: CREATED });
  assert.equal(intake.text, '[Current message - respond to this]\nUser: open file_a (repaired)');
  assert.equal(intake.source_meta.raw_text, '@Paraclete open file_a');
  assert.deepEqual(JSON.parse(intake.conversation_ctx), conversation);
});

test('files shared without a word still give the brain a sentence to classify', () => {
  const intake = buildIntake(dashboardMsg({ text: '  ', rawText: '' }), { createdAt: CREATED });
  assert.equal(intake.text, 'Shared 1 file: sales.xlsx');
  assert.equal(intake.source_meta.raw_text, '');
});

test('raw_text is capped', () => {
  const intake = buildIntake(dashboardMsg({ rawText: 'x'.repeat(9000) }), { createdAt: CREATED });
  assert.equal(intake.source_meta.raw_text.length, 8000);
});

test('the write only creates: a replayed message finds its intake and changes nothing', async () => {
  const db = fakeDb();
  const intake = buildIntake(dashboardMsg(), { createdAt: CREATED });
  assert.equal(await writeIntake(db, COLLECTIONS, intake), 'created');
  await db.patch(`intake/${intake.id}`, ['status'], { status: { stringValue: 'claimed' } });
  assert.equal(await writeIntake(db, COLLECTIONS, { ...intake, status: 'pending' }), 'exists');
  assert.equal(db.get(`intake/${intake.id}`).status, 'claimed', 'the brain\'s claim survives the replay');
});

test('an outage is thrown, not mistaken for an existing intake', async () => {
  const db = fakeDb();
  db.fail('commit');
  await assert.rejects(writeIntake(db, COLLECTIONS, buildIntake(dashboardMsg(), { createdAt: CREATED })), StoreUnavailable);
});

test('a Chat sender matched to a dashboard user carries the email; an unmatched one does not', () => {
  const chat = (over) => dashboardMsg({
    channel: 'gchat', id: 'spaces/D/messages/m1', sender: 'users/1', senderName: '', attachments: [],
    address: makeAddress('gchat', { space: 'spaces/D' }), ...over,
  });
  const known = buildIntake(chat({ senderEmail: 'ana@example.com', senderName: 'ana@example.com' }), { createdAt: CREATED });
  assert.equal(known.source_meta.sender, 'users/1');
  assert.equal(known.source_meta.sender_email, 'ana@example.com');
  assert.deepEqual(known.source_meta.address, { channel: 'gchat', space: 'spaces/D' }, 'a direct message has no thread');
  assert.equal('sender_email' in buildIntake(chat({ senderEmail: null }), { createdAt: CREATED }).source_meta, false);
});
