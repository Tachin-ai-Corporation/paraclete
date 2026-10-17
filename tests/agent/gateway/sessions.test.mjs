// Tests for agent/gateway/sessions.mjs: the brain-commanded session store.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore, hashSystem, estimateMessageTokens } from '../../../agent/gateway/sessions.mjs';

describe('hashSystem and estimateMessageTokens', () => {
  it('the hash is stable and content-keyed', () => {
    assert.equal(hashSystem('abc'), hashSystem('abc'));
    assert.notEqual(hashSystem('abc'), hashSystem('abd'));
  });

  it('estimates characters / 4 over message contents', () => {
    assert.equal(estimateMessageTokens([{ role: 'user', content: 'x'.repeat(40) }]), 10);
  });
});

describe('open, continue, append', () => {
  it('open stores the messages at seq 0; continue hits on matching identity', () => {
    const store = createSessionStore();
    store.openSession({ id: 's1', organ: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'open payload' }] });
    const hit = store.continueSession({ id: 's1', organ: 'cortex', systemHash: 'h1', expectedSeq: 0 });
    assert.equal(hit.session.seq, 0);
  });

  it('appendTurn stores the brain\'s delta and advances seq', () => {
    const store = createSessionStore();
    store.openSession({ id: 's1', organ: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'open' }] });
    const s = store.appendTurn('s1', [{ role: 'assistant', content: '{"action":"synthesize"}' }, { role: 'user', content: 'delta-2' }], 1234);
    assert.equal(s.seq, 1);
    assert.equal(s.messages.length, 3);
    assert.equal(s.lastRealPromptTokens, 1234);
    assert.equal(store.appendTurn('gone', []), null);
  });

  it('a continue misses by reason and never throws', () => {
    const store = createSessionStore();
    store.openSession({ id: 's1', organ: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(store.continueSession({ id: 's1', organ: 'cortex', systemHash: 'h1', expectedSeq: 9 }).miss, 'seq');
    assert.equal(store.continueSession({ id: 's1', organ: 'motor', systemHash: 'h1', expectedSeq: 0 }).miss, 'organ');
    assert.equal(store.continueSession({ id: 's1', organ: 'cortex', systemHash: 'DIFFERENT', expectedSeq: 0 }).miss, 'system_hash');
    assert.equal(store.continueSession({ id: 'nope', organ: 'cortex', systemHash: 'h1', expectedSeq: 0 }).miss, 'absent');
    assert.ok(store.continueSession({ id: 's1', organ: 'cortex', systemHash: null }).session, 'no hash to check, no seq to check');
  });

  it('caps oversized user and tool content but leaves content-part arrays intact', () => {
    const store = createSessionStore({ turnContentCap: 100 });
    store.openSession({ id: 's1', organ: 'cortex', systemHash: 'h1', messages: [] });
    const s = store.appendTurn('s1', [
      { role: 'user', content: 'y'.repeat(50_000) },
      { role: 'assistant', content: [{ type: 'text', text: 'parts block' }] },
      { role: 'assistant', content: 'z'.repeat(500) },
    ]);
    assert.match(s.messages[0].content, /^y{100} \[\.\.\.capped at 100 chars/);
    assert.ok(Array.isArray(s.messages[1].content));
    assert.equal(s.messages[2].content.length, 500, 'assistant strings are the brain\'s decisions, never capped');
  });

  it('reset replaces the messages and keeps seq; close is idempotent', () => {
    const store = createSessionStore();
    store.openSession({ id: 's1', organ: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'a' }] });
    store.appendTurn('s1', [{ role: 'assistant', content: 'b' }]);
    const r = store.resetSession({ id: 's1', organ: 'cortex', systemHash: 'h2', messages: [{ role: 'user', content: 'fresh' }] });
    assert.equal(r.seq, 1);
    assert.equal(r.messages.length, 1);
    assert.equal(store.closeSession('s1'), true);
    assert.equal(store.closeSession('s1'), false);
  });

  it('listSessions gives counters and metadata, never content', () => {
    const store = createSessionStore();
    store.openSession({ id: 's1', organ: 'cortex', systemHash: 'h1', messages: [{ role: 'user', content: 'hello world' }] });
    const [entry] = store.listSessions();
    assert.equal(entry.id, 's1');
    assert.equal(entry.organ, 'cortex');
    assert.equal(typeof entry.est_tokens, 'number');
    assert.ok(!('messages' in entry) && !('content' in entry));
  });
});

describe('eviction', () => {
  it('drops idle sessions when a session opens', () => {
    let t = 0;
    const store = createSessionStore({ idleTtlMs: 1000, now: () => t });
    store.openSession({ id: 'old', organ: 'cortex', systemHash: 'h', messages: [] });
    t = 2000;
    store.openSession({ id: 'new', organ: 'cortex', systemHash: 'h', messages: [] });
    assert.deepEqual(store.listSessions().map((s) => s.id), ['new']);
  });

  it('keeps at most maxSessions, dropping the least recently used', () => {
    let t = 0;
    const store = createSessionStore({ maxSessions: 2, now: () => t });
    store.openSession({ id: 'a', organ: 'cortex', systemHash: 'h', messages: [] });
    t = 1;
    store.openSession({ id: 'b', organ: 'cortex', systemHash: 'h', messages: [] });
    t = 2;
    store.continueSession({ id: 'a', organ: 'cortex' });
    t = 3;
    store.openSession({ id: 'c', organ: 'cortex', systemHash: 'h', messages: [] });
    assert.deepEqual(store.listSessions().map((s) => s.id).sort(), ['a', 'c']);
  });
});
