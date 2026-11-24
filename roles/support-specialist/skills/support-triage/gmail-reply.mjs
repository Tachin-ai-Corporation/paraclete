#!/usr/bin/env node
// roles/support-specialist/skills/support-triage/gmail-reply.mjs: sends a threaded plain-text
// Gmail reply to an inbound message for the support-specialist role, enforcing self-loop,
// automated-sender, and idempotent-ledger guards unless explicitly overridden.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../../../agent/cli/cli-runtime.mjs';
import { createGmailClient, extractEmailAddress } from '../../../../agent/providers/workspace-gmail.mjs';
import { getEntry, ledgerPath, upsertEntry } from './support-ledger.mjs';

export const USAGE = 'Usage: gmail-reply <message-id> [--from "<address>"] [--to "<address>"] [--cc "<addresses>"] (--body "<text>" | --stdin | --use-draft) [--auto] [--soc2] [--allow-followup] [--force] [--json]';

const VALID_ID = /^[A-Za-z0-9_-]+$/;
const NOREPLY_LOCAL = /^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounces?)@/;

/**
 * Checks whether replying to `original` is unsafe (self-loop, bulk/auto-responder, or noreply).
 * Returns a human-readable refusal reason or null when safe.
 *
 * @param {object} o
 * @returns {string|null}
 */
export function safetyProblem({ original, recipientEmail, agentEmail, fromEmail }) {
  if (!recipientEmail) return 'recipient email address could not be determined';
  if (agentEmail && recipientEmail === agentEmail) {
    return `refusing to reply to the agent's own mailbox (${recipientEmail})`;
  }
  if (fromEmail && recipientEmail === fromEmail) {
    return `refusing to reply back to the outbound alias (${recipientEmail})`;
  }
  const autoSubmitted = String(original?.autoSubmitted || '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') {
    return `message carries Auto-Submitted: ${original.autoSubmitted} (automated message; mark skipped instead)`;
  }
  const precedence = String(original?.precedence || '').trim().toLowerCase();
  if (/^(bulk|list|junk|auto_reply)$/.test(precedence)) {
    return `message carries Precedence: ${original.precedence} (bulk/automated message; mark skipped instead)`;
  }
  if (NOREPLY_LOCAL.test(recipientEmail)) {
    return `recipient '${recipientEmail}' looks like an automated no-reply address`;
  }
  return null;
}

/**
 * Parses CLI arguments for `gmail-reply`.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        cc: { type: 'string' },
        body: { type: 'string' },
        stdin: { type: 'boolean' },
        'use-draft': { type: 'boolean' },
        auto: { type: 'boolean' },
        soc2: { type: 'boolean' },
        'allow-followup': { type: 'boolean' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: 'exactly one Gmail message id is required' };
  const id = positionals[0];
  if (!VALID_ID.test(id)) return { error: `'${id}' is not a valid Gmail message id` };
  const bodySources = [values.body !== undefined, values.stdin === true, values['use-draft'] === true].filter(Boolean).length;
  if (bodySources !== 1) {
    return { error: 'provide exactly one of --body "<text>", --stdin, or --use-draft' };
  }
  return {
    id,
    from: values.from ? values.from.trim() : '',
    to: values.to ? values.to.trim() : '',
    cc: values.cc ? values.cc.trim() : '',
    body: values.body,
    stdin: values.stdin === true,
    useDraft: values['use-draft'] === true,
    auto: values.auto === true,
    soc2: values.soc2 === true,
    allowFollowup: values['allow-followup'] === true,
    force: values.force === true,
    json: values.json === true,
  };
}

/**
 * Entry point for `gmail-reply`.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || Date.now;
  const fail = (msg, code = 1) => { stderr.write(`gmail-reply: ${msg}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const needsRuntime = !deps.gmail || !deps.ledgerFile;
    const runtime = deps.runtime || (needsRuntime ? createCliRuntime({ stderr }) : null);
    const gmail = deps.gmail || createGmailClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const file = deps.ledgerFile || ledgerPath(runtime);

    const existing = getEntry(file, args.id);
    if ((existing?.status === 'sent' || existing?.status === 'auto_replied') && !args.allowFollowup) {
      return fail(
        `message ${args.id} was already replied to (${existing.status}, sentMessageId=${existing.sentMessageId || 'unknown'} at ${existing.sentAt || 'unknown'}). Pass --allow-followup only when a second reply is intentional.`,
        1,
      );
    }

    let bodyText;
    if (args.useDraft) {
      if (!existing?.proposedBody) {
        return fail(`no stored proposed reply found for message ${args.id}; run support-propose first or pass --body/--stdin`, 1);
      }
      bodyText = existing.proposedBody;
    } else if (args.stdin) {
      bodyText = String(deps.stdinText ?? readFileSync(0, 'utf8')).trim();
    } else {
      bodyText = String(args.body || '').trim();
    }
    if (!bodyText) return fail('reply body cannot be empty', 2);

    const original = await gmail.getMessage(args.id);
    const recipient = args.to || original.replyTo || original.from;
    const problem = safetyProblem({
      original,
      recipientEmail: extractEmailAddress(recipient),
      agentEmail: extractEmailAddress(gmail.account),
      fromEmail: extractEmailAddress(args.from),
    });
    if (problem && !args.force) return fail(problem, 1);

    const sent = await gmail.sendReply({
      messageId: args.id,
      original,
      body: bodyText,
      from: args.from,
      to: args.to,
      cc: args.cc,
    });
    const at = new Date(now()).toISOString();
    const status = args.auto ? 'auto_replied' : 'sent';
    upsertEntry(file, args.id, {
      threadId: original.threadId,
      from: original.from,
      replyTo: original.replyTo,
      subject: original.subject,
      date: original.date,
      status,
      soc2: Boolean(args.soc2 || existing?.soc2),
      sentMessageId: sent.id,
      sentThreadId: sent.threadId,
      sentFrom: sent.from,
      sentTo: sent.to,
      sentBody: bodyText,
      sentAt: at,
      updatedAt: at,
    });

    const out = {
      messageId: args.id,
      sentMessageId: sent.id,
      threadId: sent.threadId,
      from: sent.from,
      to: sent.to,
      subject: sent.subject,
      inReplyTo: sent.inReplyTo,
      status,
    };
    if (args.json) {
      stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    stdout.write(`Sent ${status} Gmail reply ${sent.id} (thread ${sent.threadId}) from ${sent.from} to ${sent.to}: "${sent.subject}".\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
