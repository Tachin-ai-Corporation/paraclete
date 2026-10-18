// Tests for skills/workspace-gmail/gmail-search.mjs: matches newest first with the ids gmail-get takes,
// unread marked, the "more match" note, an empty result that says how to widen the query, and usage
// errors refused before any call. Google is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gmailSearch from '../../../skills/workspace-gmail/gmail-search.mjs';
import { createGmailClient } from '../../../agent/providers/workspace-gmail.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';

const headers = (from, subject) => [{ name: 'From', value: from }, { name: 'Subject', value: subject }];
function google(list) {
  return fakeGoogle([
    ['GET', '/gmail/v1/users/me/messages', () => json(list)],
    ['GET', /^\/gmail\/v1\/users\/me\/messages\/(m\d)$/, (call, m) => json({
      id: m[1], threadId: `t${m[1].slice(1)}`, labelIds: m[1] === 'm1' ? ['INBOX', 'UNREAD'] : ['INBOX'], snippet: `Snippet of ${m[1]} &amp; more`,
      internalDate: m[1] === 'm1' ? String(Date.parse('2026-10-19T14:12:30Z')) : String(Date.parse('2026-10-18T08:00:00Z')),
      payload: { headers: headers('Pat Example <pat@example.com>', m[1] === 'm1' ? 'Q3 plan' : 'Lunch') },
    })],
  ]);
}
const gmailFor = (g) => createGmailClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

test('matches, newest first, with their ids', async () => {
  const g = google({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'more', resultSizeEstimate: 31 });
  const r = await run(gmailSearch, ['from:pat@example.com', 'newer_than:7d', '--limit', '2'], { gmail: gmailFor(g) });
  assert.equal(r.code, 0, r.err);
  assert.equal(g.calls[0].params.get('q'), 'from:pat@example.com newer_than:7d');
  assert.equal(r.out, [
    '2 messages in the mailbox of agent@example.com match "from:pat@example.com newer_than:7d", newest first:',
    '1. 2026-10-19 14:12 UTC | Pat Example <pat@example.com> | Q3 plan | id m1 | thread t1 | unread',
    '   Snippet of m1 & more',
    '2. 2026-10-18 08:00 UTC | Pat Example <pat@example.com> | Lunch | id m2 | thread t2',
    '   Snippet of m2 & more',
    'More match (about 31): narrow the query, or raise --limit (at most 100).',
    '',
  ].join('\n'));
});

test('no match says how to widen; --json; mistakes', async () => {
  const empty = await run(gmailSearch, ['subject:nothing'], { gmail: gmailFor(google({ resultSizeEstimate: 0 })) });
  assert.equal(empty.code, 0);
  assert.match(empty.out, /^No message in the mailbox of agent@example\.com matches "subject:nothing"\. Widen the query/);
  const js = await run(gmailSearch, ['in:inbox', '--json'], { gmail: gmailFor(google({ messages: [{ id: 'm1' }] })) });
  assert.equal(JSON.parse(js.out).messages[0].subject, 'Q3 plan');
  const g = google({});
  for (const argv of [[], ['x', '--limit', '0'], ['x', '--limit', '101']]) {
    assert.equal((await run(gmailSearch, argv, { gmail: gmailFor(g) })).code, 2, argv.join(' '));
  }
  assert.equal(g.calls.length, 0);
  assert.equal((await run(gmailSearch, ['--help'])).code, 0);
});
