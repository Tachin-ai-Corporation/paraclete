// Tests for skills/workspace-gmail/gmail-get.mjs: a message as headers, text and numbered attachments; a
// long body cut and said so; the whole thread; attachments saved into the mission's inbox (one, or
// all) with their size and checksum; and the mistakes refused. Google is a fake; files go to a temp
// data root.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gmailGet from '../../../skills/workspace-gmail/gmail-get.mjs';
import { createGmailClient } from '../../../agent/providers/workspace-gmail.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';
import { driveRuntime, WORKSPACE } from '../drive/fakes.mjs';

const b64 = (s) => Buffer.from(s).toString('base64url');
const message = (id, text) => ({
  id, threadId: 't1', labelIds: ['INBOX'],
  payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'Pat Example <pat@example.com>' }, { name: 'To', value: 'agent@example.com' }, { name: 'Subject', value: 'Q3 plan' }, { name: 'Date', value: 'Mon, 19 Oct 2026 09:12:00 -0500' }],
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { data: b64(text) } },
      { partId: '1', mimeType: 'application/pdf', filename: 'plan.pdf', body: { attachmentId: 'a1', size: 3 } },
      { partId: '2', mimeType: 'text/csv', filename: 'figures.csv', body: { data: b64('a,b\n1,2\n'), size: 8 } },
    ],
  },
});

function google() {
  return fakeGoogle([
    ['GET', '/gmail/v1/users/me/messages/m1', () => json(message('m1', 'Hi,\nHere is the plan.'))],
    ['GET', '/gmail/v1/users/me/messages/m1/attachments/a1', () => json({ size: 3, data: b64('pdf') })],
    ['GET', '/gmail/v1/users/me/threads/t1', () => json({ id: 't1', messages: [message('m0', 'First.'), message('m1', 'Second.')] })],
  ]);
}
const gmailFor = (g) => createGmailClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

describe('gmail-get', () => {
  test('a message: headers, text, and numbered attachments with the command that fetches each', async () => {
    const r = await run(gmailGet, ['m1'], { gmail: gmailFor(google()) });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, [
      'From: Pat Example <pat@example.com>',
      'To: agent@example.com',
      'Date: Mon, 19 Oct 2026 09:12:00 -0500',
      'Subject: Q3 plan',
      'Message id: m1 | thread t1 | labels INBOX',
      '',
      'Hi,\nHere is the plan.',
      '',
      'Attachments:',
      '1. plan.pdf (application/pdf, 3 B): gmail-get m1 --attachment 1 --mission <mission id>',
      '2. figures.csv (text/csv, 8 B): gmail-get m1 --attachment 2 --mission <mission id>',
      '',
    ].join('\n'));
  });

  test('a long body is cut and says so; --json leaves attachment bytes out', async () => {
    const g = fakeGoogle([['GET', '/gmail/v1/users/me/messages/m1', () => json(message('m1', 'x'.repeat(500)))]]);
    const r = await run(gmailGet, ['m1', '--max-chars', '100'], { gmail: gmailFor(g) });
    assert.match(r.out, /\nx{100}\n\[cut: 400 more characters\. Read more with --max-chars, up to 200000\]\n/);
    const js = JSON.parse((await run(gmailGet, ['m1', '--json'], { gmail: gmailFor(g) })).out);
    assert.equal(js.attachments[1].data, undefined);
    assert.equal(js.attachments[1].filename, 'figures.csv');
  });

  test('the whole thread, oldest first', async () => {
    const r = await run(gmailGet, ['m1', '--thread'], { gmail: gmailFor(google()) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Thread t1: 2 messages, oldest first\.\n\n=== Message 1 of 2 ===\nFrom: Pat Example[\s\S]*First\.[\s\S]*=== Message 2 of 2 ===[\s\S]*Second\./);
  });

  test('an attachment lands in the mission inbox; all of them, too', async () => {
    const runtime = driveRuntime({ workspace: WORKSPACE });
    const one = await run(gmailGet, ['m1', '--attachment', '1', '--mission', 'm-42'], { gmail: gmailFor(google()), runtime });
    assert.equal(one.code, 0, one.err);
    const path = join(runtime.paths.data.missions, 'm-42', 'missions', 'm-42', 'inbox', 'plan.pdf');
    assert.equal(readFileSync(path, 'utf8'), 'pdf');
    assert.match(one.out, new RegExp(`^Saved ${path.replace(/\\/g, '\\\\')}\nplan\\.pdf \\| application/pdf \\| 3 bytes \\| sha256 [0-9a-f]{64}\nRead it with: file-read `));
    const all = await run(gmailGet, ['m1', '--attachment', 'all', '--mission', 'm-42', '--json'], { gmail: gmailFor(google()), runtime });
    assert.deepEqual(JSON.parse(all.out).files.map((f) => [f.name, f.size, f.replaced]), [['plan.pdf', 3, true], ['figures.csv', 8, false]]);
    assert.equal(readFileSync(join(runtime.paths.data.missions, 'm-42', 'missions', 'm-42', 'inbox', 'figures.csv'), 'utf8'), 'a,b\n1,2\n');
  });

  test('an attachment over the size cap, or one that is not there, is refused', async () => {
    const runtime = driveRuntime({ workspace: WORKSPACE, files: { fetch_max_mb: 0.000001 } });
    const big = await run(gmailGet, ['m1', '--attachment', '1', '--mission', 'm-42'], { gmail: gmailFor(google()), runtime });
    assert.equal(big.code, 1);
    assert.match(big.err, /plan\.pdf is 3 B, more than the .* MB a fetched file may be/);
    const missing = await run(gmailGet, ['m1', '--attachment', '7', '--mission', 'm-42'], { gmail: gmailFor(google()), runtime: driveRuntime({ workspace: WORKSPACE }) });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /has no attachment 7: it has 2 \(1 plan\.pdf, 2 figures\.csv\)/);
  });

  test('mistakes are refused before any call', async () => {
    const g = google();
    for (const argv of [[], ['m1', 'm2'], ['bad/id'], ['m1', '--attachment', '1'], ['m1', '--attachment', 'x', '--mission', 'm-1'], ['m1', '--mission', 'm-1'], ['m1', '--thread', '--attachment', '1', '--mission', 'm-1'], ['m1', '--max-chars', '5']]) {
      assert.equal((await run(gmailGet, argv, { gmail: gmailFor(g) })).code, 2, argv.join(' '));
    }
    assert.equal(g.calls.length, 0);
    assert.equal((await run(gmailGet, ['--help'])).code, 0);
  });
});
