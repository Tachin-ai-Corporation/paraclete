// Tests for agent/services/ears/chat-message.mjs: the agent's own messages, mentions as Chat shows
// them to a user-authenticated caller (a sender and a mentioned user named only by 'users/<id>'), the
// request's text, and the conversation from one poll page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  instant, isFromAgent, agentUserIdFrom, mentionsAgent, requestText, nameWords, buildContextualMessage,
  buildThreadConversation,
} from '../../../../agent/services/ears/chat-message.mjs';
import { agentMessageId } from '../../../../agent/providers/channel.mjs';

const AGENT = 'users/900';
const who = (over = {}) => ({ agentUserId: AGENT, agentName: 'Paraclete', ...over });
const chat = (over = {}) => ({
  name: 'spaces/A/messages/1', text: 'hello', createTime: '2026-10-17T12:00:00.000000Z',
  sender: { name: 'users/1', type: 'HUMAN' }, thread: { name: 'spaces/A/threads/t1' }, ...over,
});
const mention = (start, length, user) => ({ type: 'USER_MENTION', startIndex: start, length, userMention: { user: { name: user, type: 'HUMAN' }, type: 'MENTION' } });

test("the agent's own messages: the ones its mouth posted, then its user id, then its name until the id is known", () => {
  const posted = chat({ clientAssignedMessageId: agentMessageId('delivery:w-1:abc'), sender: { name: 'users/555' } });
  assert.equal(isFromAgent(posted, who({ agentUserId: null })), true, 'the client id alone marks it');
  assert.equal(agentUserIdFrom(posted), 'users/555', 'and its sender is then the agent');
  assert.equal(agentUserIdFrom(chat()), null, "a person's message never teaches the agent's id");
  assert.equal(agentUserIdFrom(chat({ clientAssignedMessageId: 'client-someone-else' })), null);

  assert.equal(isFromAgent(chat({ sender: { name: AGENT } }), who()), true);
  assert.equal(isFromAgent(chat({ sender: { name: 'users/2', displayName: 'Paraclete' } }), who()), false,
    'once the id is known, a person who shares the name is not the agent');
  assert.equal(isFromAgent(chat({ sender: { name: 'users/2', displayName: 'Paraclete' } }), who({ agentUserId: null })), true);
  assert.equal(isFromAgent(chat(), who({ agentUserId: null })), false);
});

test("a mention annotation naming the agent's id is a mention; one naming someone else is not", () => {
  assert.equal(mentionsAgent(chat({ text: '@Paraclete Agent hi', annotations: [mention(0, 16, AGENT)] }), who()), true);
  assert.equal(mentionsAgent(chat({ text: '@Ben can you', annotations: [mention(0, 4, 'users/3')] }), who()), false);
});

test("until the id is known, a mention whose text starts with the agent's whole name counts", () => {
  const unknown = who({ agentUserId: null });
  assert.equal(mentionsAgent(chat({ text: 'hey @Paraclete Agent can you', annotations: [mention(4, 16, 'users/777')] }), unknown), true);
  assert.equal(mentionsAgent(chat({ text: 'hey @Para-clete', annotations: [mention(4, 11, 'users/777')] }), unknown), false,
    'whole words, not squashed letters');
  const short = who({ agentUserId: null, agentName: 'Al' });
  assert.equal(mentionsAgent(chat({ text: '@Alice look', annotations: [mention(0, 6, 'users/4')] }), short), false, '"Al" is not "Alice"');
  assert.equal(mentionsAgent(chat({ text: '@Al Agent look', annotations: [mention(0, 9, 'users/5')] }), short), true);
});

test("the agent's name typed as plain text counts, unless it is part of somebody else's mention", () => {
  assert.equal(mentionsAgent(chat({ text: 'ping @Paraclete please' }), who()), true);
  assert.equal(mentionsAgent(chat({ text: 'ping @paraclete, please' }), who()), true, 'any case, any punctuation after it');
  assert.equal(mentionsAgent(chat({ text: 'mail paraclete@example.com' }), who()), false, 'an email is not a mention');
  assert.equal(mentionsAgent(chat({ text: 'see @Paracletes' }), who()), false, 'a longer word is not the name');
  const ada = who({ agentName: 'Ada' });
  assert.equal(mentionsAgent(chat({ text: '@Ada Lovelace can you', annotations: [mention(0, 13, 'users/8')] }), ada), false,
    'the mention of a person named like the agent is theirs');
  assert.equal(mentionsAgent(chat({ text: 'hi', annotations: [mention(0, 2, AGENT)] }), who(), 'text'), false,
    'with mention_match "text" annotations are not read');
  assert.equal(mentionsAgent(chat({ text: 'hi @Paraclete' }), who(), 'text'), true);
});

test("the request is the text without the agent's mentions, its own lines and indentation kept", () => {
  assert.equal(requestText(chat({ text: '@Paraclete Agent   draft the plan', annotations: [mention(0, 16, AGENT)] }), who()), 'draft the plan');
  assert.equal(requestText(chat({ text: 'please @Paraclete draft:\n- intro\n    code()' }), who()), 'please draft:\n- intro\n    code()');
  assert.equal(requestText(chat({ text: '@Paraclete' }), who()), '@Paraclete', 'nothing left: the text as it was');
  assert.equal(requestText(chat({ text: 'Paraclete, draft it' }), who()), 'Paraclete, draft it', 'only a mention is removed');
  assert.equal(requestText(chat({ text: 'ask @Ben and @Paraclete', annotations: [mention(4, 4, 'users/3')] }), who()), 'ask @Ben and');
  assert.deepEqual(nameWords('@Ada-Agent 2'), ['ada', 'agent', '2']);
});

test('the classified text frames earlier messages as context and leaves out the agent', () => {
  const prior = [
    chat({ text: 'the numbers are in', sender: { name: 'users/2' } }),
    chat({ text: 'I will look', sender: { name: AGENT } }),
    chat({ text: '   ' }),
  ];
  const nameOf = (m) => (m.sender.name === 'users/2' ? 'ben@example.com' : 'someone');
  assert.equal(
    buildContextualMessage(chat({ text: '@Paraclete summarize them' }), prior, who(), nameOf),
    '[Chat messages since your last reply - for context]\nben@example.com: the numbers are in\n\n[Current message - respond to this]\nUser: summarize them',
  );
  assert.equal(buildContextualMessage(chat({ text: '@Paraclete hi there' }), [], who()), '[Current message - respond to this]\nUser: hi there');
});

test('the thread conversation holds only the same thread, before the message, in budget', () => {
  const page = [
    chat({ name: 'm0', text: 'other thread', createTime: '2026-10-17T11:00:00Z', thread: { name: 'spaces/A/threads/t2' } }),
    chat({ name: 'm1', text: 'first ask', createTime: '2026-10-17T11:01:00Z' }),
    chat({ name: 'm2', text: 'on it', createTime: '2026-10-17T11:02:00Z', sender: { name: AGENT } }),
    chat({ name: 'm3', text: 'the target', createTime: '2026-10-17T11:03:00Z' }),
    chat({ name: 'm4', text: 'after', createTime: '2026-10-17T11:04:00Z' }),
  ];
  const convo = buildThreadConversation(page[3], page, who(), {}, { nameOf: () => 'ana@example.com' });
  assert.deepEqual(convo.turns, [
    { role: 'user', name: 'ana@example.com', text: 'first ask', ts: '2026-10-17T11:01:00Z' },
    { role: 'agent', name: 'agent', text: 'on it', ts: '2026-10-17T11:02:00Z' },
  ]);
  assert.equal(convo.block, '## Conversation (most recent 2 turns, oldest first)\n[ana@example.com 2026-10-17T11:01] first ask\n[agent 2026-10-17T11:02] on it');
  assert.equal(convo.last_user_text, 'first ask');
  assert.equal(convo.last_agent_text, 'on it');
  assert.equal(convo.cue_text, 'first ask on it');
  assert.equal(buildThreadConversation(page[3], page, who()).turns[0].name, 'user', 'a person with no name or email is "user"');

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

test('a direct message is one conversation: the whole page, whatever the threads', () => {
  const page = [
    chat({ name: 'm1', text: 'one', createTime: '2026-10-17T11:01:00Z', thread: { name: 'spaces/D/threads/a' } }),
    chat({ name: 'm2', text: 'two', createTime: '2026-10-17T11:02:00Z', thread: { name: 'spaces/D/threads/b' } }),
  ];
  const target = chat({ thread: { name: 'spaces/D/threads/c' }, createTime: '2026-10-17T11:03:00Z' });
  assert.deepEqual(buildThreadConversation(target, page, who(), {}, { whole: true }).turns.map((t) => t.text), ['one', 'two']);
  assert.equal(buildThreadConversation(target, page, who()), null, 'by thread, the new top-level message has no history');
  const threadless = buildThreadConversation(chat({ thread: undefined, createTime: '2026-10-17T11:03:00Z' }),
    page.map((m) => ({ ...m, thread: undefined })), who());
  assert.deepEqual(threadless.turns.map((t) => t.text), ['one', 'two'], 'a message without a thread uses the whole page');
});
