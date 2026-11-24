// Tests for roles/support-specialist/skills/support-triage/: support-ledger, support-propose, and
// gmail-reply commands with in-memory/temp storage and fake Gmail + Firestore dependencies.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeDb } from '../../../../agent/services/ears/fake-db.mjs';
import { WORK_SCHEMA } from '../../../../../agent/work/work-schema.mjs';
import { validate } from '../../../../../agent/work/validate-schema.mjs';
import * as supportLedger from '../../../../../roles/support-specialist/skills/support-triage/support-ledger.mjs';
import * as supportPropose from '../../../../../roles/support-specialist/skills/support-triage/support-propose.mjs';
import * as gmailReply from '../../../../../roles/support-specialist/skills/support-triage/gmail-reply.mjs';

const NOW = Date.parse('2026-11-24T15:00:00Z');
const scratch = () => mkdtempSync(join(tmpdir(), 'support-triage-'));

function capture(fn) {
  let out = '';
  let err = '';
  const stdout = { write: (s) => { out += s; } };
  const stderr = { write: (s) => { err += s; } };
  return fn(stdout, stderr).then((code) => ({ code, out, err }));
}

const SAMPLE_MESSAGE = {
  id: 'msg-101',
  threadId: 'th-101',
  from: 'Customer <customer@example.net>',
  replyTo: 'customer@example.net',
  to: 'support@example.com',
  subject: 'SOC 2 report request',
  date: 'Tue, 24 Nov 2026 14:30:00 +0000',
  messageIdHeader: '<cust-101@example.net>',
  references: '',
  autoSubmitted: '',
  precedence: '',
  text: 'Can you share your latest SOC 2 Type II report?',
  html: false,
  attachments: [],
};

describe('support-ledger', () => {
  test('--help prints usage and check/get/list/skip manage message state', async () => {
    const ledgerFile = join(scratch(), 'ledger.json');
    const help = await capture((stdout, stderr) => supportLedger.main(['--help'], { stdout, stderr, ledgerFile }));
    assert.equal(help.code, 0);
    assert.match(help.out, /^Usage: support-ledger/);

    const check1 = await capture((stdout, stderr) => supportLedger.main(['check', 'msg-101', 'msg-102', '--json'], { stdout, stderr, ledgerFile }));
    assert.equal(check1.code, 0);
    assert.deepEqual(JSON.parse(check1.out).entries.map((e) => e.status), ['new', 'new']);

    const skip = await capture((stdout, stderr) => supportLedger.main(['skip', 'msg-102', '--reason', 'Automated bounce', '--soc2', '--json'], { stdout, stderr, ledgerFile, now: () => NOW }));
    assert.equal(skip.code, 0);
    assert.equal(JSON.parse(skip.out).status, 'skipped');

    const get = await capture((stdout, stderr) => supportLedger.main(['get', 'msg-102', '--json'], { stdout, stderr, ledgerFile }));
    assert.equal(get.code, 0);
    assert.equal(JSON.parse(get.out).skipReason, 'Automated bounce');

    const list = await capture((stdout, stderr) => supportLedger.main(['list', '--status', 'skipped', '--json'], { stdout, stderr, ledgerFile }));
    assert.equal(list.code, 0);
    assert.deepEqual(JSON.parse(list.out).entries.map((e) => e.messageId), ['msg-102']);

    const bad = await capture((stdout, stderr) => supportLedger.main(['bad-cmd'], { stdout, stderr, ledgerFile }));
    assert.equal(bad.code, 2);
  });
});

describe('support-propose', () => {
  test('--help prints usage, queues Chat notification envelope, records draft, and deduplicates retries', async () => {
    const ledgerFile = join(scratch(), 'ledger.json');
    const db = fakeDb();
    const gmail = { account: 'agent@example.org', getMessage: async () => SAMPLE_MESSAGE };

    const help = await capture((stdout, stderr) => supportPropose.main(['--help'], { stdout, stderr }));
    assert.equal(help.code, 0);
    assert.match(help.out, /^Usage: support-propose/);

    const body = 'Hello,\n\nWe can share our SOC 2 report under NDA. Let us know the signer email.';
    const first = await capture((stdout, stderr) => supportPropose.main(
      ['msg-101', '--space', 'AAA', '--soc2', '--summary', 'Customer asked for SOC 2 report', '--mission', 'w-m1', '--body', body, '--json'],
      { stdout, stderr, gmail, db, workCollection: 'work', ledgerFile, now: () => NOW },
    ));
    assert.equal(first.code, 0);
    const firstOut = JSON.parse(first.out);
    assert.equal(firstOut.workId, 'w-proposal-msg-101');
    assert.equal(firstOut.space, 'spaces/AAA');
    assert.equal(firstOut.revision, 1);

    const env = db.get('work/w-proposal-msg-101');
    assert.ok(env, 'proposal notification envelope written to Firestore');
    assert.equal(validate(WORK_SCHEMA, env).valid, true, 'proposal envelope conforms to WORK_SCHEMA');
    assert.equal(env.type, 'R');
    assert.equal(env.memory_written, true);
    assert.equal(env.delivery_status, 'pending');
    assert.deepEqual(env.delivery_address, { channel: 'gchat', space: 'spaces/AAA', thread: null });
    assert.equal(env.source_meta.notification_type, 'proposal');
    assert.match(env.output, /msg-101/);
    assert.match(env.output, /\[SOC 2\]/);
    assert.match(env.output, /We can share our SOC 2 report under NDA/);

    // Identical retry does not post a duplicate Chat notification.
    const dup = await capture((stdout, stderr) => supportPropose.main(
      ['msg-101', '--space', 'spaces/AAA', '--soc2', '--body', body, '--json'],
      { stdout, stderr, gmail, db, workCollection: 'work', ledgerFile, now: () => NOW + 1000 },
    ));
    assert.equal(dup.code, 0, dup.err);
    assert.equal(JSON.parse(dup.out).duplicate, true);
    assert.equal(db.docs.size, 1);

    // Revision in an existing thread writes revision 2 into that thread.
    const rev = await capture((stdout, stderr) => supportPropose.main(
      ['msg-101', '--space', 'spaces/AAA', '--thread', 'spaces/AAA/threads/t9', '--stdin', '--json'],
      { stdout, stderr, gmail, db, workCollection: 'work', ledgerFile, stdinText: 'Updated draft text.', now: () => NOW + 2000 },
    ));
    assert.equal(rev.code, 0, rev.err);
    const revOut = JSON.parse(rev.out);
    assert.equal(revOut.workId, 'w-proposal-msg-101-r2');
    assert.equal(revOut.revision, 2);
    assert.equal(db.get('work/w-proposal-msg-101-r2').delivery_address.thread, 'spaces/AAA/threads/t9');
  });
});

describe('gmail-reply', () => {
  test('sends approved draft from ledger, blocks duplicate send unless --allow-followup, and blocks loops/auto-responders', async () => {
    const ledgerFile = join(scratch(), 'ledger.json');
    const db = fakeDb();
    const sends = [];
    const gmail = {
      account: 'agent@example.org',
      getMessage: async () => SAMPLE_MESSAGE,
      sendReply: async (opts) => {
        sends.push(opts);
        return {
          id: `sent-${sends.length}`,
          threadId: opts.original.threadId,
          labelIds: ['SENT'],
          to: opts.to || opts.original.replyTo || opts.original.from,
          from: opts.from || 'agent@example.org',
          cc: opts.cc || '',
          subject: `Re: ${opts.original.subject}`,
          inReplyTo: opts.original.messageIdHeader,
        };
      },
    };

    const help = await capture((stdout, stderr) => gmailReply.main(['--help'], { stdout, stderr }));
    assert.equal(help.code, 0);
    assert.match(help.out, /^Usage: gmail-reply/);

    // First queue a draft via support-propose.
    const prop = await capture((stdout, stderr) => supportPropose.main(
      ['msg-101', '--space', 'spaces/AAA', '--soc2', '--body', 'Approved draft reply.', '--json'],
      { stdout, stderr, gmail, db, workCollection: 'work', ledgerFile, now: () => NOW },
    ));
    assert.equal(prop.code, 0, prop.err);

    // Send using --use-draft and custom --from group alias.
    const sent = await capture((stdout, stderr) => gmailReply.main(
      ['msg-101', '--from', 'support@example.com', '--use-draft', '--json'],
      { stdout, stderr, gmail, ledgerFile, now: () => NOW + 5000 },
    ));
    assert.equal(sent.code, 0, sent.err);
    const sentJson = JSON.parse(sent.out);
    assert.equal(sentJson.sentMessageId, 'sent-1');
    assert.equal(sentJson.from, 'support@example.com');
    assert.equal(sentJson.to, 'customer@example.net');
    assert.equal(sends[0].body, 'Approved draft reply.');

    // Duplicate send without --allow-followup fails safely.
    const dup = await capture((stdout, stderr) => gmailReply.main(
      ['msg-101', '--from', 'support@example.com', '--body', 'Oops duplicate'],
      { stdout, stderr, gmail, ledgerFile },
    ));
    assert.equal(dup.code, 1);
    assert.match(dup.err, /already replied to/);
    assert.equal(sends.length, 1);

    // Followup with --allow-followup succeeds.
    const follow = await capture((stdout, stderr) => gmailReply.main(
      ['msg-101', '--from', 'support@example.com', '--allow-followup', '--stdin', '--json'],
      { stdout, stderr, gmail, ledgerFile, stdinText: 'Second approved follow-up.', now: () => NOW + 9000 },
    ));
    assert.equal(follow.code, 0);
    assert.equal(sends.length, 2);

    // Safety blocks: Auto-Submitted, noreply, and self-loop.
    const autoMail = { ...SAMPLE_MESSAGE, id: 'msg-auto', autoSubmitted: 'auto-replied' };
    const blockAuto = await capture((stdout, stderr) => gmailReply.main(
      ['msg-auto', '--from', 'support@example.com', '--body', 'hi', '--auto'],
      { stdout, stderr, gmail: { ...gmail, getMessage: async () => autoMail }, ledgerFile },
    ));
    assert.equal(blockAuto.code, 1);
    assert.match(blockAuto.err, /Auto-Submitted/);

    const noreplyMail = { ...SAMPLE_MESSAGE, id: 'msg-noreply', from: 'noreply@example.net', replyTo: '' };
    const blockNoreply = await capture((stdout, stderr) => gmailReply.main(
      ['msg-noreply', '--from', 'support@example.com', '--body', 'hi'],
      { stdout, stderr, gmail: { ...gmail, getMessage: async () => noreplyMail }, ledgerFile },
    ));
    assert.equal(blockNoreply.code, 1);
    assert.match(blockNoreply.err, /no-reply/);

    const selfMail = { ...SAMPLE_MESSAGE, id: 'msg-self', from: 'support@example.com', replyTo: '' };
    const blockSelf = await capture((stdout, stderr) => gmailReply.main(
      ['msg-self', '--from', 'support@example.com', '--body', 'hi'],
      { stdout, stderr, gmail: { ...gmail, getMessage: async () => selfMail }, ledgerFile },
    ));
    assert.equal(blockSelf.code, 1);
    assert.match(blockSelf.err, /outbound alias/);
  });
});
