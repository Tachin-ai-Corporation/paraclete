#!/usr/bin/env node
// roles/support-specialist/skills/support-triage/support-propose.mjs: records a proposed email reply
// in the support triage ledger and queues a notification envelope to a Google Chat space via the
// mouth service, starting one review thread per inbound Gmail message so humans can reply naturally.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../../../agent/cli/cli-runtime.mjs';
import { makeAddress } from '../../../../agent/providers/channel.mjs';
import { createGmailClient } from '../../../../agent/providers/workspace-gmail.mjs';
import { WORK_SCHEMA } from '../../../../agent/work/work-schema.mjs';
import { validate } from '../../../../agent/work/validate-schema.mjs';
import { getEntry, ledgerPath, upsertEntry } from './support-ledger.mjs';

export const USAGE = 'Usage: support-propose <message-id> --space <spaces/id> [--thread <spaces/id/threads/id>] [--soc2] [--summary "<text>"] (--body "<draft>" | --stdin) [--mission <mission-id>] [--json]';

const VALID_ID = /^[A-Za-z0-9_-]+$/;

/** Formats the Chat notification body with the Gmail message id, metadata, and full draft reply. */
export function formatProposalMessage(message, { summary = '', soc2 = false, draft, revision = 1 }) {
  const lines = [
    `Support intake${revision > 1 ? ` (updated draft v${revision})` : ''} — Gmail message \`${message.id}\`${soc2 ? ' [SOC 2]' : ''}`,
    `From: ${message.replyTo || message.from || '(unknown sender)'}`,
    `Subject: ${message.subject || '(no subject)'}`,
  ];
  if (summary.trim()) lines.push(`Summary: ${summary.trim()}`);
  lines.push('', 'Proposed reply:', '```', draft.trim(), '```', '', 'Reply in this thread to approve as-is, tell me how to reword it, or tell me to skip it.');
  return lines.join('\n');
}

/**
 * Parses CLI arguments for `support-propose`.
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
        space: { type: 'string' },
        thread: { type: 'string' },
        soc2: { type: 'boolean' },
        summary: { type: 'string' },
        body: { type: 'string' },
        stdin: { type: 'boolean' },
        mission: { type: 'string' },
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
  if (!values.space || !values.space.trim()) return { error: '--space <spaces/id> is required' };
  if (values.body !== undefined && values.stdin) return { error: 'use either --body or --stdin, not both' };
  if (values.body === undefined && !values.stdin) return { error: 'the proposed reply is required: pass --body or --stdin' };
  return {
    id,
    space: values.space.trim(),
    thread: values.thread ? values.thread.trim() : null,
    soc2: values.soc2 === true,
    summary: values.summary || '',
    body: values.body,
    stdin: values.stdin === true,
    mission: values.mission ? values.mission.trim() : null,
    json: values.json === true,
  };
}

/**
 * Entry point for `support-propose`.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || Date.now;
  const fail = (msg, code = 1) => { stderr.write(`support-propose: ${msg}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const draft = String(args.stdin ? (deps.stdinText ?? readFileSync(0, 'utf8')) : args.body).trim();
    if (!draft) return fail('the proposed reply text cannot be empty', 2);

    const needsRuntime = !deps.gmail || !deps.db || !deps.ledgerFile;
    const runtime = deps.runtime || (needsRuntime ? createCliRuntime({ stderr }) : null);
    const gmail = deps.gmail || createGmailClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const db = deps.db || runtime.db;
    const workCollection = deps.workCollection || runtime.collections.work;
    const file = deps.ledgerFile || ledgerPath(runtime);

    const address = makeAddress('gchat', { space: args.space, thread: args.thread });
    if (!address.space) return fail(`'${args.space}' is not a valid Google Chat space name`, 2);

    const existing = getEntry(file, args.id);
    if (existing?.status === 'sent' || existing?.status === 'auto_replied') {
      return fail(`message ${args.id} was already replied to (${existing.status}); use gmail-reply --allow-followup if another reply is needed`, 1);
    }
    if (
      existing?.status === 'pending_review'
      && existing.proposedBody === draft
      && existing.space === address.space
      && (existing.chatThread || null) === address.thread
    ) {
      const result = {
        messageId: args.id,
        space: address.space,
        thread: address.thread,
        workId: existing.proposalWorkId || `w-proposal-${args.id}`,
        duplicate: true,
        status: existing.status,
      };
      if (args.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else stdout.write(`Proposal for ${args.id} is already queued (${result.workId}).\n`);
      return 0;
    }

    const message = await gmail.getMessage(args.id);
    const revision = (existing?.revision || 0) + 1;
    const workId = revision === 1 ? `w-proposal-${args.id}` : `w-proposal-${args.id}-r${revision}`;
    const at = new Date(now()).toISOString();
    const text = formatProposalMessage(message, {
      summary: args.summary || existing?.summary || '',
      soc2: Boolean(args.soc2 || existing?.soc2),
      draft,
      revision,
    });

    const envelope = {
      id: workId,
      type: 'R',
      parent_id: null,
      status: 'complete',
      intent: 'notification',
      title: `Support reply proposal for Gmail ${args.id}`,
      instruction: `Post support reply proposal for Gmail ${args.id} to ${address.space}`,
      accept_criteria: null,
      context_summary: args.mission ? `Proposed during mission ${args.mission}` : null,
      output: text,
      error: null,
      children: [],
      depends_on: [],
      source_channel: 'gchat',
      source_meta: { notification_type: 'proposal', address },
      source_text: null,
      created_at: at,
      started_at: at,
      completed_at: at,
      updated_at: at,
      iteration: 0,
      project_id: null,
      memory_written: true,
      delivery_status: 'pending',
      delivery_address: address,
      platform_version: null,
    };
    const checked = validate(WORK_SCHEMA, envelope);
    if (!checked.valid) {
      throw new Error(`internal envelope validation failed: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    }

    await db.write(`${workCollection}/${workId}`, envelope);
    upsertEntry(file, args.id, {
      threadId: message.threadId,
      from: message.from,
      replyTo: message.replyTo,
      subject: message.subject,
      date: message.date,
      soc2: Boolean(args.soc2 || existing?.soc2),
      summary: (args.summary || existing?.summary || '').trim(),
      proposedBody: draft,
      space: address.space,
      chatThread: address.thread,
      proposalWorkId: workId,
      revision,
      status: 'pending_review',
      updatedAt: at,
    });

    const out = { messageId: args.id, space: address.space, thread: address.thread, workId, revision, status: 'pending_review' };
    if (args.json) {
      stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    stdout.write(`Queued review proposal ${workId} for Gmail ${args.id} -> ${address.space}${address.thread ? ` (${address.thread})` : ''} [rev ${revision}].\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
