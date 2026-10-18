// Tests for agent/auth/workspace-scopes.mjs: the full list an admin grants is exactly the nine scopes
// the build plan names, every per-API subset is part of it, the ears never hold a scope that can send,
// and the services and the Drive client take their scopes from here rather than their own copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_SCOPES, WORKSPACE_APIS, CHAT, CHAT_READ, CHAT_SEND, DRIVE, DOCS, SHEETS, SLIDES, CALENDAR, GMAIL_READ,
  adminConsoleScopes, scopeName,
} from '../../../agent/auth/workspace-scopes.mjs';
import { CHAT_READ_SCOPES } from '../../../agent/services/ears/main.mjs';
import { CHAT_SEND_SCOPES } from '../../../agent/services/mouth/main.mjs';
import { DRIVE_SCOPE } from '../../../agent/providers/drive.mjs';

const ROOT = 'https://www.googleapis.com/auth/';

test('the full list is the nine scopes an admin grants, each a full scope URL, no duplicates', () => {
  assert.deepEqual(WORKSPACE_SCOPES.map(scopeName), [
    'chat.messages', 'chat.messages.readonly', 'chat.spaces.readonly', 'drive', 'documents', 'spreadsheets',
    'presentations', 'calendar', 'gmail.readonly',
  ]);
  assert.ok(WORKSPACE_SCOPES.every((s) => s.startsWith(ROOT)));
  assert.equal(new Set(WORKSPACE_SCOPES).size, WORKSPACE_SCOPES.length);
  assert.ok(Object.isFrozen(WORKSPACE_SCOPES));
});

test('every per-API subset is inside the full list', () => {
  for (const subset of [CHAT, CHAT_READ, CHAT_SEND, DRIVE, DOCS, SHEETS, SLIDES, CALENDAR, GMAIL_READ]) {
    assert.ok(Object.isFrozen(subset));
    assert.deepEqual(subset.filter((s) => !WORKSPACE_SCOPES.includes(s)), []);
  }
  assert.deepEqual(GMAIL_READ, [`${ROOT}gmail.readonly`], 'Gmail is read only: no scope that sends or changes mail');
  assert.deepEqual(DOCS, [`${ROOT}documents`]);
  assert.deepEqual(SHEETS, [`${ROOT}spreadsheets`]);
  assert.deepEqual(SLIDES, [`${ROOT}presentations`]);
  assert.deepEqual(CALENDAR, [`${ROOT}calendar`]);
  assert.deepEqual(DRIVE, [`${ROOT}drive`]);
});

test('Chat splits into the ears\' read scopes and the mouth\'s send scope', () => {
  assert.deepEqual(CHAT_READ.filter((s) => !s.endsWith('.readonly')), [], 'the ears never hold a scope that can send');
  assert.ok(CHAT_SEND.includes(`${ROOT}chat.messages`));
  assert.deepEqual([...new Set([...CHAT_READ, ...CHAT_SEND])].sort(), [...CHAT].sort());
});

test('the APIs table covers the full list, with a name per API', () => {
  const covered = Object.values(WORKSPACE_APIS).flatMap((api) => api.scopes);
  assert.deepEqual([...new Set(covered)].sort(), [...WORKSPACE_SCOPES].sort());
  for (const api of Object.values(WORKSPACE_APIS)) assert.match(api.name, /^(Google |Gmail)/);
  assert.equal(WORKSPACE_APIS.gmail.scopes, GMAIL_READ);
});

test('the Admin console form takes one comma-separated line', () => {
  assert.equal(adminConsoleScopes([`${ROOT}drive`, `${ROOT}calendar`]), `${ROOT}drive,${ROOT}calendar`);
  assert.equal(adminConsoleScopes().split(',').length, 9);
  assert.equal(scopeName('https://example.com/other'), 'https://example.com/other');
});

test('the ears, the mouth and the Drive client take their scopes from here', () => {
  assert.deepEqual(CHAT_READ_SCOPES, CHAT_READ);
  assert.deepEqual(CHAT_SEND_SCOPES, CHAT_SEND);
  assert.equal(DRIVE_SCOPE, DRIVE[0]);
});
