// Tests for agent/services/ears/chat-message.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  instant, isFromAgent, findMention, cleanMentionText, buildContextualMessage, buildThreadConversation,
} from '../../../../agent/services/ears/chat-message.mjs';

const AGENT = 'users/900';
const who = (over = {}) => ({ agentUserId: AGENT, agentName: 'Paraclete', mention: '@Paraclete', ...over });
const chat = (over = {}) => ({
  name: 'spaces/A/messages/1', text: 'hello', createTime: '2026-10-17T12:00:00.000000Z',
  sender: { name: 'users/1', displayName: 'Ana', email: 'ana@example.com' }, thread: { name: 'spaces/A/threads/t1' }, ...over,
});

test("the agent's own messages are recognised by user id, and by display name until the id is known", () => {
  assert.equal(isFromAgent(chat({ sender: { name: AGENT, displayName: 'Paraclete' } }), who()), true);
  assert.equal(isFromAgent(chat({ sender: { name: 'users/2', displayName: 'Paraclete' } }), who()), false,
    'once the id is known, a person who shares the name is not the agent');
  assert.equal(isFromAgent(chat({ sender: { name: 'users/2', displayName: 'Paraclete' } }), who({ agentUserId: null })), true);
  assert.equal(isFromAgent(chat(), who({ agentUserId: null })), false);
});

test('a USER_MENTION annotation of the agent id is a mention', () => {
  const m = chat({ text: '@Paraclete hi', annotations: [{ type: 'USER_MENTION', startIndex: 0, length: 10, userMention: { user: { name: AGENT } } }] });
  assert.deepEqual(findMention(m, who()), { mentioned: true, agentUserId: null });
});

test('an annotation whose text matches the agent name is a mention, and reveals the agent id', () => {
  const m = chat({ text: 'hey @Para-clete can you', annotations: [{ type: 'USER_MENTION', startIndex: 4, length: 11, userMention: { user: { name: 'users/777' } } }] });
  assert.deepEqual(findMention(m, who({ agentUserId: null })), { mentioned: true, agentUserId: 'users/777' });
  assert.deepEqual(findMention(m, who()), { mentioned: true, agentUserId: null }, 'a known id is never replaced');
});

test("someone else's mention is not the agent's", () => {
  const m = chat({ text: '@Ben can you', annotations: [{ type: 'USER_MENTION', startIndex: 0, length: 4, userMention: { user: { name: 'users/3' } } }] });
  assert.deepEqual(findMention(m, who()), { mentioned: false, agentUserId: null });
});

test('the mention text counts without annotations, and annotations are ignored when matching is off', () => {
  assert.equal(findMention(chat({ text: 'ping @Paraclete please' }), who()).mentioned, true);
  const annotated = chat({ text: 'hi', annotations: [{ type: 'USER_MENTION', startIndex: 0, length: 2, userMention: { user: { name: AGENT } } }] });
  assert.equal(findMention(annotated, who(), 'text').mentioned, false);
});

test('the mention is cleaned out of the text, unless nothing would be left', () => {
  assert.equal(cleanMentionText('@Paraclete   draft the plan', '@Paraclete'), 'draft the plan');
  assert.equal(cleanMentionText('please @Paraclete draft:\n- intro\n    code()', '@Paraclete'), 'please draft:\n- intro\n    code()',
    'line breaks and indentation survive');
  assert.equal(cleanMentionText('@Paraclete', '@Paraclete'), '@Paraclete');
  assert.equal(cleanMentionText('Paraclete, draft it', '@Paraclete'), 'Paraclete, draft it', 'only the @mention is removed');
  assert.equal(cleanMentionText('text', ''), 'text');
});

test('the classified text frames earlier messages as context and leaves out the agent', () => {
  const prior = [
    chat({ text: 'the numbers are in', sender: { name: 'users/2', displayName: 'Ben' } }),
    chat({ text: 'I will look', sender: { name: AGENT, displayName: 'Paraclete' } }),
    chat({ text: '   ' }),
  ];
  assert.equal(
    buildContextualMessage(chat({ text: '@Paraclete summarize them' }), prior, who()),
    '[Chat messages since your last reply - for context]\nBen: the numbers are in\n\n[Current message - respond to this]\nUser: summarize them',
  );
  assert.equal(buildContextualMessage(chat({ text: '@Paraclete hi there' }), [], who()), '[Current message - respond to this]\nUser: hi there');
});

test('the thread conversation holds only the same thread, before the message, in budget', () => {
  const page = [
    chat({ name: 'm0', text: 'other thread', createTime: '2026-10-17T11:00:00Z', thread: { name: 'spaces/A/threads/t2' } }),
    chat({ name: 'm1', text: 'first ask', createTime: '2026-10-17T11:01:00Z' }),
    chat({ name: 'm2', text: 'on it', createTime: '2026-10-17T11:02:00Z', sender: { name: AGENT, displayName: 'Paraclete' } }),
    chat({ name: 'm3', text: 'the target', createTime: '2026-10-17T11:03:00Z' }),
    chat({ name: 'm4', text: 'after', createTime: '2026-10-17T11:04:00Z' }),
  ];
  const convo = buildThreadConversation(page[3], page, who());
  assert.deepEqual(convo.turns, [
    { role: 'user', name: 'Ana', text: 'first ask', ts: '2026-10-17T11:01:00Z' },
    { role: 'agent', name: 'agent', text: 'on it', ts: '2026-10-17T11:02:00Z' },
  ]);
  assert.equal(convo.block, '## Conversation (most recent 2 turns, oldest first)\n[Ana 2026-10-17T11:01] first ask\n[agent 2026-10-17T11:02] on it');
  assert.equal(convo.last_user_text, 'first ask');
  assert.equal(convo.last_agent_text, 'on it');
  assert.equal(convo.cue_text, 'first ask on it');

  const tight = buildThreadConversation(page[3], page, who(), { budget_chars: 40, per_turn_chars: 5 });
  assert.deepEqual(tight.turns.map((t) => t.text), ['on it'], 'oldest turns go first, the newest always stays');
  assert.equal(buildThreadConversation(page[1], page, who()), null);
});

test('timestamps compare as instants, whatever their fractional digits', () => {
  assert.ok(instant('2026-10-17T12:00:00Z') < instant('2026-10-17T12:00:00.5Z'), 'a string compare gets this backwards');
  assert.equal(instant('2026-10-17T12:00:00.000123Z'), instant('2026-10-17T12:00:00.000Z'));
  assert.equal(instant(''), -Infinity);
  assert.equal(instant(undefined), -Infinity);

  const page = [chat({ name: 'm1', text: 'whole second', createTime: '2026-10-17T11:00:00Z' })];
  const convo = buildThreadConversation(chat({ createTime: '2026-10-17T11:00:00.25Z' }), page, who());
  assert.equal(convo.turns.length, 1, 'the earlier whole-second message is history');
});

test('a threadless space uses the whole page', () => {
  const page = [
    chat({ name: 'm1', text: 'one', createTime: '2026-10-17T11:01:00Z', thread: undefined }),
    chat({ name: 'm2', text: 'two', createTime: '2026-10-17T11:02:00Z', thread: { name: 'spaces/A/threads/x' } }),
  ];
  const convo = buildThreadConversation(chat({ thread: undefined, createTime: '2026-10-17T11:03:00Z' }), page, who());
  assert.deepEqual(convo.turns.map((t) => t.text), ['one', 'two']);
});
