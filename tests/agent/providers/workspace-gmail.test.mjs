// Tests for agent/providers/workspace-gmail.mjs: search pages up to the limit and reads each match's
// headers; a message is read as text (the plain part, else the HTML part turned into text, in its
// charset), attachments are numbered and fetched; a thread comes oldest first. Read only: every call
// is a GET with the gmail.readonly token. Google is a fake fetch.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmailClient, parseMessage, htmlToText, decodeEntities } from '../../../agent/providers/workspace-gmail.mjs';
import { INSTANCE, json, googleError, fakeTokens, fakeGoogle } from './workspace-fakes.mjs';

const b64 = (text, encoding = 'utf8') => Buffer.from(text, encoding).toString('base64url');
const client = (google) => createGmailClient({ instance: INSTANCE, fetch: google.fetch, getDwdToken: fakeTokens() });

const MESSAGE = {
  id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Here&#39;s the plan',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Pat Example <pat@example.com>' }, { name: 'To', value: 'agent@example.com' },
      { name: 'Subject', value: 'Q3 plan' }, { name: 'Date', value: 'Mon, 19 Oct 2026 09:12:00 -0500' },
    ],
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64('Hi,\r\nHere’s the plan.\r\n') } },
          { partId: '0.1', mimeType: 'text/html', body: { data: b64('<p>Hi,</p><p>Here’s the plan.</p>') } },
        ],
      },
      { partId: '1', mimeType: 'application/pdf', filename: 'plan.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="plan.pdf"' }], body: { attachmentId: 'att-1', size: 2048 } },
      { partId: '2', mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline' }], body: { data: b64('png-bytes'), size: 9 } },
    ],
  },
};

describe('reading a message', () => {
  test('headers, the plain text part, and attachments numbered in order', () => {
    const m = parseMessage(MESSAGE);
    assert.equal(m.from, 'Pat Example <pat@example.com>');
    assert.equal(m.subject, 'Q3 plan');
    assert.equal(m.snippet, "Here's the plan");
    assert.equal(m.text, 'Hi,\nHere’s the plan.');
    assert.equal(m.html, false);
    assert.deepEqual(m.attachments.map((a) => [a.index, a.filename, a.mimeType, a.size, a.attachmentId, a.inline]), [
      [1, 'plan.pdf', 'application/pdf', 2048, 'att-1', false],
      [2, 'logo.png', 'image/png', 9, null, true],
    ]);
  });

  test('an HTML-only message is turned into text; a declared charset is honored', () => {
    const html = parseMessage({ id: 'm2', payload: { mimeType: 'text/html', body: { data: b64('<html><head><style>p{}</style></head><body><h1>Agenda</h1><ul><li>One &amp; two</li><li><a href="https://example.com/doc">the doc</a></li></ul><p>Bye<br>Pat</p></body></html>') } } });
    assert.equal(html.html, true);
    assert.equal(html.text, 'Agenda\n\n- One & two\n- the doc (https://example.com/doc)\n\nBye\nPat');
    const latin = parseMessage({ id: 'm3', payload: { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }], body: { data: b64('café', 'latin1') } } });
    assert.equal(latin.text, 'café');
  });

  test('htmlToText and entities on their own', () => {
    assert.equal(htmlToText('<script>x()</script><div>A</div><div>B &nbsp; C</div><!-- note -->'), 'A\nB C');
    assert.equal(htmlToText('<a href="mailto:pat@example.com">Pat</a>'), 'Pat');
    assert.equal(decodeEntities('&lt;b&gt; &#x41;&#66; &mdash; &unknown;'), '<b> AB — &unknown;');
  });
});

describe('the mailbox', () => {
  test('search lists matching ids, then reads each one\'s headers, read only', async () => {
    const google = fakeGoogle([
      ['GET', '/gmail/v1/users/me/messages', (call) => (call.params.get('pageToken')
        ? json({ messages: [{ id: 'm3' }], resultSizeEstimate: 3 })
        : json({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'n2', resultSizeEstimate: 3 }))],
      ['GET', /^\/gmail\/v1\/users\/me\/messages\/(m\d)$/, (call, m) => json({ ...MESSAGE, id: m[1], payload: { headers: MESSAGE.payload.headers } })],
    ]);
    const found = await client(google).search({ query: 'from:pat@example.com newer_than:7d', limit: 3 });
    assert.deepEqual(found.messages.map((m) => [m.id, m.subject, m.from]), [['m1', 'Q3 plan', 'Pat Example <pat@example.com>'], ['m2', 'Q3 plan', 'Pat Example <pat@example.com>'], ['m3', 'Q3 plan', 'Pat Example <pat@example.com>']]);
    assert.equal(found.capped, false);
    assert.equal(found.estimate, 3);
    assert.equal(google.calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Apat%40example.com+newer_than%3A7d&maxResults=3');
    const meta = google.calls.find((c) => c.path.endsWith('/m1'));
    assert.equal(meta.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date');
    assert.ok(google.calls.every((c) => c.method === 'GET' && c.headers.Authorization === 'Bearer tok-gmail.readonly'));
  });

  test('search says when more match than the limit', async () => {
    const google = fakeGoogle([
      ['GET', '/gmail/v1/users/me/messages', () => json({ messages: [{ id: 'm1' }], nextPageToken: 'more', resultSizeEstimate: 40 })],
      ['GET', /messages\/m1$/, () => json({ id: 'm1', payload: { headers: [] } })],
    ]);
    const found = await client(google).search({ query: 'in:inbox', limit: 1 });
    assert.equal(found.capped, true);
    assert.equal(found.estimate, 40);
  });

  test('a message, a thread and an attachment', async () => {
    const google = fakeGoogle([
      ['GET', '/gmail/v1/users/me/messages/m1', () => json(MESSAGE)],
      ['GET', '/gmail/v1/users/me/threads/t1', () => json({ id: 't1', messages: [MESSAGE, { ...MESSAGE, id: 'm9' }] })],
      ['GET', '/gmail/v1/users/me/messages/m1/attachments/att-1', () => json({ size: 3, data: b64('pdf') })],
    ]);
    const gmail = client(google);
    const m = await gmail.getMessage('m1');
    assert.equal(google.calls[0].params.get('format'), 'full');
    assert.equal((await gmail.getAttachment('m1', m.attachments[0])).toString(), 'pdf');
    assert.equal((await gmail.getAttachment('m1', m.attachments[1])).toString(), 'png-bytes', 'a small attachment comes inside the message');
    const thread = await gmail.getThread('t1');
    assert.deepEqual(thread.messages.map((x) => x.id), ['m1', 'm9']);
  });

  test('a wrong id says the message is not in the mailbox, not that it is unshared', async () => {
    const google = fakeGoogle([['GET', /messages\/nope$/, () => googleError(404, 'notFound', 'Requested entity was not found.')]]);
    await assert.rejects(client(google).getMessage('nope'), (err) => err.kind === 'not_found'
      && /^There is no message nope in the mailbox of agent@example\.com: .*gmail-search/.test(err.message));
  });
});
