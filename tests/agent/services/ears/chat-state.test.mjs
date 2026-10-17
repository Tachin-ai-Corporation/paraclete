// Tests for agent/services/ears/chat-state.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileStateStore } from '../../../../agent/services/ears/chat-state.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'ears-state-'));

test('state round-trips through the file, creating its directory', () => {
  const path = join(dir(), 'services', 'ears', 'chat-state.json');
  const store = createFileStateStore(path);
  const state = { cursors: { 'spaces/A': '2026-10-17T12:00:00Z' }, seen: ['spaces/A/messages/1'], agentUserId: 'users/9' };
  store.save(state);
  assert.deepEqual(createFileStateStore(path).load(), state);
  assert.equal(existsSync(`${path}.tmp`), false, 'the temporary file is renamed away');
});

test('a missing file is empty state', () => {
  assert.deepEqual(createFileStateStore(join(dir(), 'none.json')).load(), { cursors: {}, seen: [], agentUserId: null });
});

test('a corrupt or malformed file is empty state, and says so', () => {
  const path = join(dir(), 'chat-state.json');
  writeFileSync(path, '{"cursors": ');
  const logs = [];
  assert.deepEqual(createFileStateStore(path, { log: (...a) => logs.push(a) }).load(), { cursors: {}, seen: [], agentUserId: null });
  assert.equal(logs[0][0], 'WARN');

  writeFileSync(path, JSON.stringify({ cursors: 'nope', seen: ['ok', 7], agentUserId: 12 }));
  assert.deepEqual(createFileStateStore(path).load(), { cursors: {}, seen: ['ok'], agentUserId: null });
});

test('a save that cannot write is logged, not thrown', () => {
  const blocker = join(dir(), 'file');
  writeFileSync(blocker, 'x');
  const logs = [];
  createFileStateStore(join(blocker, 'chat-state.json'), { log: (...a) => logs.push(a) }).save({ cursors: {}, seen: [], agentUserId: null });
  assert.equal(logs[0][0], 'WARN');
  assert.equal(readFileSync(blocker, 'utf8'), 'x');
});
