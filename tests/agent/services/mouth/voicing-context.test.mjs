// Tests for agent/services/mouth/voicing-context.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voicingTail } from '../../../../agent/services/mouth/voicing-context.mjs';
import { fakeDb } from '../ears/fake-db.mjs';

const DASH = { channel: 'dashboard', thread: 'th-1' };

test('the thread ledger, read at delivery time, wins over the envelope snapshot', async () => {
  const db = fakeDb({
    'threads/th-1': { channel: 'dashboard' },
    'threads/th-1/turns/a': { role: 'user', name: 'Ana', text: 'check the invoices', ts: new Date('2026-10-17T11:00:00Z') },
    'threads/th-1/turns/d-w-1': { role: 'agent', text: 'On it.', ts: new Date('2026-10-17T11:00:05Z') },
  });
  const tail = await voicingTail({ db, address: DASH, envelope: { conversation_context: 'stale snapshot' } });
  assert.equal(tail, '## Conversation (most recent 2 turns, oldest first)\n[Ana 2026-10-17T11:00] check the invoices\n[agent 2026-10-17T11:00] On it.');
});

test('the snapshot stands in when the ledger has nothing or cannot be read', async () => {
  assert.equal(await voicingTail({ db: fakeDb(), address: DASH, envelope: { conversation_context: '  snapshot  ' } }), 'snapshot');
  const broken = fakeDb();
  broken.fail('read');
  assert.equal(await voicingTail({ db: broken, address: DASH, envelope: { conversation_context: 'snapshot' } }), 'snapshot');
  assert.equal(await voicingTail({ db: fakeDb(), address: { channel: 'dashboard', thread: null }, envelope: {} }), '');
});

test('only the tail is kept', async () => {
  const tail = await voicingTail({
    db: fakeDb(), address: DASH, envelope: { conversation_context: `${'a'.repeat(50)}END` }, config: { voicing_tail_chars: 10 },
  });
  assert.equal(tail, 'aaaaaaaEND');
});

test('the ledger is keyed by the Address the reply goes to', async () => {
  const keys = [];
  await voicingTail({
    db: fakeDb(), address: { channel: 'gchat', space: 'spaces/A', thread: 'spaces/A/threads/t' }, envelope: {},
    readThread: async ({ threadKey }) => { keys.push(threadKey); return null; },
  });
  assert.deepEqual(keys, ['gchat-spaces~A~threads~t']);
});
