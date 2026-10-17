// Tests for agent/context/thread-ledger.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  threadKeyFor, encodeResourceName, appendTurn, readThread, compactThread, sweepThreadTurns,
} from '../../../agent/context/thread-ledger.mjs';
import { SUBCOLLECTIONS } from '../../../agent/storage/collections.mjs';
import { firestoreDecode, firestoreEncode, StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

// ── A Firestore in memory, behind the client interface ────────────────

const plain = (v) => firestoreDecode({ v }).v;

function fakeDb(initial = {}) {
  // Stored as the client would read it back: through an encode and decode round trip, so a Date
  // becomes its ISO string exactly as a timestamp does.
  const roundTrip = (data) => firestoreDecode(firestoreEncode(data));
  const docs = new Map(Object.entries(initial).map(([p, d]) => [p, roundTrip(d)]));
  const state = { fail: false };
  const guard = (op, opts) => {
    if (!state.fail) return false;
    if (opts?.strict) throw new StoreUnavailable(op, '', 503, 'unavailable');
    return true;
  };
  const test = (doc, f) => {
    const v = doc[f.field];
    const want = plain(f.value);
    if (v === undefined) return false;
    switch (f.op) {
      case 'GREATER_THAN': return v > want;
      case 'LESS_THAN_OR_EQUAL': return v <= want;
      case 'EQUAL': return v === want;
      default: throw new Error(`fake query: unsupported op ${f.op}`);
    }
  };
  return {
    docs,
    state,
    deleted: [],
    async read(path, opts) { if (guard('read', opts)) return null; return docs.has(path) ? structuredClone(docs.get(path)) : null; },
    async write(path, data, opts) { if (guard('write', opts)) return null; docs.set(path, roundTrip(data)); return {}; },
    async patch(path, mask, fields, opts) {
      if (guard('patch', opts)) return null;
      const doc = docs.get(path) || {};
      const decoded = firestoreDecode(fields);
      for (const f of mask) doc[f] = decoded[f];
      docs.set(path, doc);
      return {};
    },
    async del(path, opts) { if (guard('del', opts)) return false; this.deleted.push(path); return docs.delete(path); },
    async query(parent, collection, filters, opts = {}) {
      if (guard('query', opts)) return [];
      const prefix = parent ? `${parent}/${collection}/` : `${collection}/`;
      let rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, d]) => ({ id: p.slice(prefix.length), ...structuredClone(d) }))
        .filter((d) => (filters || []).every((f) => test(d, f)));
      if (!opts.noOrderBy) {
        const field = opts.orderBy || 'created_at';
        const dir = opts.orderDirection === 'DESCENDING' ? -1 : 1;
        rows = rows.filter((d) => d[field] !== undefined).sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0));
      }
      return rows.slice(0, opts.limit || 300);
    },
  };
}

const threadDoc = (key) => `${COLLECTIONS.threads}/${key}`;
const turnDoc = (key, id) => `${threadDoc(key)}/${SUBCOLLECTIONS.threadTurns}/${id}`;

/** A thread with `n` alternating turns, one a minute from T0. */
function seedTurns(key, n, extra = {}) {
  const docs = { [threadDoc(key)]: { channel: 'dashboard', ...extra } };
  for (let i = 0; i < n; i++) {
    docs[turnDoc(key, `m${String(i).padStart(3, '0')}`)] = {
      role: i % 2 ? 'agent' : 'user', name: i % 2 ? '' : 'user@example.com', text: `turn ${i}`, ts: new Date(T0 + i * 60_000), source: 'intake',
    };
  }
  return docs;
}

// ── Keys ──────────────────────────────────────────────────────────────

describe('encodeResourceName', () => {
  it('preserves case (lowercasing could merge distinct Chat threads)', () => {
    assert.notEqual(encodeResourceName('spaces/AAaa/threads/BBbb'), encodeResourceName('spaces/aaAA/threads/bbBB'));
  });

  it('maps / to ~ and is collision-free over the Chat id alphabet', () => {
    assert.equal(encodeResourceName('spaces/AB_c-1/threads/Zz9'), 'spaces~AB_c-1~threads~Zz9');
  });

  it('sanitizes characters outside the safe set', () => {
    assert.ok(!/[^A-Za-z0-9_~.-]/.test(encodeResourceName('weird id!with spaces')));
  });
});

describe('threadKeyFor', () => {
  it('keys a Chat thread on its thread resource name', () => {
    assert.equal(threadKeyFor({ channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/BBB' }), 'gchat-spaces~AAA~threads~BBB');
  });

  it('falls back to the space for a threadless direct-message space', () => {
    assert.equal(threadKeyFor({ channel: 'gchat', space: 'spaces/AAA', thread: null }), 'gchat-spaces~AAA');
  });

  it('keys a dashboard conversation on its own thread document', () => {
    assert.equal(threadKeyFor({ channel: 'dashboard', thread: 'Th7xQ2' }), 'Th7xQ2');
  });

  it('returns null when the address names no thread', () => {
    assert.equal(threadKeyFor(null), null);
    assert.equal(threadKeyFor({ channel: 'gchat' }), null);
    assert.equal(threadKeyFor({ channel: 'dashboard' }), null);
  });

  it('two case-variant threads never share a key', () => {
    assert.notEqual(threadKeyFor({ channel: 'gchat', thread: 'spaces/A/threads/xY' }), threadKeyFor({ channel: 'gchat', thread: 'spaces/A/threads/Xy' }));
  });
});

// ── Writing ───────────────────────────────────────────────────────────

describe('appendTurn', () => {
  it('stores a turn under the thread, scrubbed of secrets, and stamps the thread', async () => {
    const db = fakeDb();
    const ok = await appendTurn({
      db, threadKey: 'Th1', turnId: 'msg/1', role: 'user', name: 'user@example.com',
      text: 'deploy with Bearer abcdefghijklmnopqrstuvwxyz0123', clock: () => T0,
    });
    assert.equal(ok, true);
    const turn = db.docs.get(turnDoc('Th1', 'msg~1'));
    assert.deepEqual(turn, { role: 'user', name: 'user@example.com', text: 'deploy with Bearer [REDACTED]', ts: at(0), source: 'intake' });
    assert.deepEqual(db.docs.get(threadDoc('Th1')), { channel: 'dashboard', last_turn_at: at(0) });
  });

  it('touches only its own fields on the dashboard\'s thread document', async () => {
    const db = fakeDb({ [threadDoc('Th1')]: { owner: 'user@example.com', title: 'Quarterly report' } });
    await appendTurn({ db, threadKey: 'Th1', turnId: 'm1', role: 'agent', text: 'Done.', source: 'delivery', clock: () => T0 });
    assert.deepEqual(db.docs.get(threadDoc('Th1')), {
      owner: 'user@example.com', title: 'Quarterly report', channel: 'dashboard', last_turn_at: at(0),
    });
  });

  it('records the Chat space and thread on a Chat thread', async () => {
    const db = fakeDb();
    const key = threadKeyFor({ channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/BBB' });
    await appendTurn({ db, threadKey: key, turnId: 'spaces/AAA/messages/1', role: 'user', text: 'hi', channelMeta: { channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/BBB' }, clock: () => T0 });
    assert.deepEqual(db.docs.get(threadDoc(key)), { channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/BBB', last_turn_at: at(0) });
  });

  it('a retried write upserts the same turn instead of adding one', async () => {
    const db = fakeDb();
    await appendTurn({ db, threadKey: 'Th1', turnId: 'm1', role: 'user', text: 'first', clock: () => T0 });
    await appendTurn({ db, threadKey: 'Th1', turnId: 'm1', role: 'user', text: 'first', clock: () => T0 + 5 });
    const turns = [...db.docs.keys()].filter((p) => p.startsWith(`${threadDoc('Th1')}/${SUBCOLLECTIONS.threadTurns}/`));
    assert.equal(turns.length, 1);
  });

  it('caps the stored text and treats any role but agent as the user', async () => {
    const db = fakeDb();
    await appendTurn({ db, threadKey: 'Th1', turnId: 'm1', role: 'someone', text: 'x'.repeat(20_000), config: { turn_store_chars: 1000 }, clock: () => T0 });
    const turn = db.docs.get(turnDoc('Th1', 'm1'));
    assert.equal(turn.role, 'user');
    assert.ok(turn.text.length < 1100);
  });

  it('refuses incomplete input and reports a failed write', async () => {
    const db = fakeDb();
    assert.equal(await appendTurn({ db, threadKey: 'Th1', turnId: 'm1', role: 'user', text: '' }), false);
    assert.equal(await appendTurn({ db, threadKey: '', turnId: 'm1', role: 'user', text: 'x' }), false);
    db.state.fail = true;
    const logs = [];
    assert.equal(await appendTurn({ db, threadKey: 'Th1', turnId: 'm1', role: 'user', text: 'x', log: (l, m) => logs.push(m) }), false);
    assert.match(logs[0], /turn upsert failed/);
  });
});

// ── Reading ───────────────────────────────────────────────────────────

describe('readThread', () => {
  it('renders the latest turns oldest first, in the conversation-context shape', async () => {
    const db = fakeDb(seedTurns('Th1', 4));
    const t = await readThread({ db, threadKey: 'Th1' });
    assert.deepEqual(t.turns.map((x) => x.text), ['turn 0', 'turn 1', 'turn 2', 'turn 3']);
    assert.deepEqual(t.turns[0], { role: 'user', name: 'user@example.com', text: 'turn 0', ts: at(0) });
    assert.equal(t.turns[1].name, 'agent');
    assert.equal(t.block, `## Conversation (most recent 4 turns, oldest first)\n[user@example.com ${at(0).substring(0, 16)}] turn 0\n[agent ${at(1).substring(0, 16)}] turn 1\n[user@example.com ${at(2).substring(0, 16)}] turn 2\n[agent ${at(3).substring(0, 16)}] turn 3`);
    assert.equal(t.last_user_text, 'turn 2');
    assert.equal(t.last_agent_text, 'turn 3');
    assert.equal(t.cue_text, 'turn 0 turn 1 turn 2 turn 3');
  });

  it('keeps only the newest max_turns, and drops the oldest to fit the budget', async () => {
    const db = fakeDb(seedTurns('Th1', 20));
    const t = await readThread({ db, threadKey: 'Th1', config: { max_turns: 5 } });
    assert.deepEqual(t.turns.map((x) => x.text), ['turn 15', 'turn 16', 'turn 17', 'turn 18', 'turn 19']);
    const tight = await readThread({ db, threadKey: 'Th1', config: { budget_chars: 80 } });
    assert.ok(tight.turns.length >= 1);
    assert.equal(tight.turns.at(-1).text, 'turn 19', 'the newest turn always stays');
  });

  it('puts the compacted summary first, marked as derived', async () => {
    const db = fakeDb(seedTurns('Th1', 2, { summary: 'They agreed on the outline.' }));
    const t = await readThread({ db, threadKey: 'Th1' });
    assert.match(t.block, /^## Thread summary \(compacted, derived — not verbatim[^\n]*\nThey agreed on the outline\.\n\n## Conversation/);
  });

  it('is null for an empty or unreadable thread, so the caller falls back', async () => {
    assert.equal(await readThread({ db: fakeDb(), threadKey: 'Th1' }), null);
    const db = fakeDb(seedTurns('Th1', 2));
    db.state.fail = true;
    assert.equal(await readThread({ db, threadKey: 'Th1' }), null);
    assert.equal(await readThread({ db, threadKey: '' }), null);
  });
});

// ── Compaction and retention ──────────────────────────────────────────

describe('compactThread', () => {
  const cfg = { max_turns: 4, compact_after_turns: 6 };

  it('folds everything but the newest window into the summary and advances the watermark', async () => {
    const db = fakeDb(seedTurns('Th1', 10));
    const calls = [];
    const summarize = async (input, instruction) => { calls.push({ input, instruction }); return 'Summary of the first six turns.'; };
    assert.equal(await compactThread({ db, threadKey: 'Th1', summarize, config: cfg }), true);
    assert.match(calls[0].input, /^\[user@example\.com\] turn 0\n\[agent\] turn 1/);
    assert.doesNotMatch(calls[0].input, /turn 6/, 'the newest window stays verbatim');
    const thread = db.docs.get(threadDoc('Th1'));
    assert.equal(thread.summary, 'Summary of the first six turns.');
    assert.equal(thread.summary_through_ts, at(5));
    assert.equal(thread.channel, 'dashboard', 'other fields are untouched');
  });

  it('does nothing while the window is not exceeded', async () => {
    const db = fakeDb(seedTurns('Th1', 9));
    assert.equal(await compactThread({ db, threadKey: 'Th1', summarize: async () => 'x', config: cfg }), false);
  });

  it('a second fold starts from the watermark and carries the summary forward', async () => {
    const db = fakeDb(seedTurns('Th1', 20, { summary: 'Earlier summary.', summary_through_ts: new Date(at(5)) }));
    let input = '';
    await compactThread({ db, threadKey: 'Th1', summarize: async (text) => { input = text; return 'New summary.'; }, config: cfg });
    assert.match(input, /^EXISTING SUMMARY:\nEarlier summary\.\n\nNEW TURNS:\n\[user@example\.com\] turn 6\n\[agent\] turn 7/);
  });

  it('loses the race when another writer advanced the watermark first', async () => {
    const db = fakeDb(seedTurns('Th1', 10));
    const summarize = async () => {
      db.docs.get(threadDoc('Th1')).summary_through_ts = at(3);
      return 'late';
    };
    assert.equal(await compactThread({ db, threadKey: 'Th1', summarize, config: cfg }), false);
    assert.equal(db.docs.get(threadDoc('Th1')).summary, undefined);
  });

  it('a failed summary or an unreadable thread writes nothing', async () => {
    const db = fakeDb(seedTurns('Th1', 10));
    assert.equal(await compactThread({ db, threadKey: 'Th1', summarize: async () => '', config: cfg }), false);
    db.state.fail = true;
    assert.equal(await compactThread({ db, threadKey: 'Th1', summarize: async () => 'x', config: cfg }), false);
    db.state.fail = false;
    assert.equal(db.docs.get(threadDoc('Th1')).summary, undefined);
  });
});

describe('sweepThreadTurns', () => {
  it('deletes only turns that are folded and past retention', async () => {
    const now = T0 + 30 * 86_400_000;
    const docs = {
      ...seedTurns('Th1', 6, { summary: 's', summary_through_ts: new Date(at(3)) }),
      ...seedTurns('Th2', 3),
    };
    const db = fakeDb(docs);
    const deleted = await sweepThreadTurns({ db, clock: () => now });
    assert.equal(deleted, 4, 'turns 0-3 are folded and old');
    assert.ok(db.docs.has(turnDoc('Th1', 'm004')), 'an unfolded turn stays, whatever its age');
    assert.ok(db.docs.has(turnDoc('Th2', 'm000')), 'a thread with no summary is never swept');
  });

  it('keeps folded turns still inside retention', async () => {
    const db = fakeDb(seedTurns('Th1', 6, { summary: 's', summary_through_ts: new Date(at(3)) }));
    assert.equal(await sweepThreadTurns({ db, clock: () => T0 + 86_400_000 }), 0);
  });

  it('is bounded per run and survives a store failure', async () => {
    const now = T0 + 30 * 86_400_000;
    const db = fakeDb(seedTurns('Th1', 6, { summary: 's', summary_through_ts: new Date(at(5)) }));
    assert.equal(await sweepThreadTurns({ db, clock: () => now, maxDeletes: 2 }), 2);
    db.state.fail = true;
    assert.equal(await sweepThreadTurns({ db, clock: () => now }), 0);
  });
});
