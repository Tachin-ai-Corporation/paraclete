#!/usr/bin/env node
// roles/support-specialist/skills/support-triage/support-ledger.mjs: tracks which inbound Gmail
// messages the support triage workflow has already inspected, proposed, replied to, or skipped so
// scheduled inbox polls never double-propose or double-reply. Also exports ledger storage helpers
// shared by support-propose.mjs and gmail-reply.mjs.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../../../agent/cli/cli-runtime.mjs';

export const USAGE = [
  'Usage: support-ledger check <message-id> [<message-id> ...] [--json]',
  '       support-ledger get <message-id> [--json]',
  '       support-ledger list [--status <status>] [--limit <n>] [--json]',
  '       support-ledger skip <message-id> --reason "<why>" [--soc2] [--json]',
  '       support-ledger stats [--days <n>] [--json]',
].join('\n');

const VALID_ID = /^[A-Za-z0-9_-]+$/;
const VALID_STATUSES = new Set(['pending_review', 'auto_replied', 'sent', 'skipped']);
const MAX_ENTRIES = 5000;
const DEFAULT_LIMIT = 50;

/** Path to the support triage ledger under the instance data root. */
export const ledgerPath = (runtime) => join(runtime.paths.data.root, 'support-triage', 'ledger.json');

/** Reads the ledger file; returns an empty ledger when no file exists yet. */
export function loadLedger(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, entries: {} };
    throw new Error(`could not read support ledger at ${path}: ${err.message}`);
  }
  const parsed = JSON.parse(raw);
  const entries = parsed && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
    ? parsed.entries
    : {};
  return { version: 1, entries: { ...entries } };
}

/** Atomically writes the ledger file, keeping at most MAX_ENTRIES most-recently updated entries. */
export function saveLedger(path, data) {
  const entries = data?.entries && typeof data.entries === 'object' ? { ...data.entries } : {};
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => String(entries[b]?.updatedAt || '').localeCompare(String(entries[a]?.updatedAt || '')));
    for (const drop of keys.slice(MAX_ENTRIES)) delete entries[drop];
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Reads one Gmail message's ledger record, or null when unseen. */
export function getEntry(path, messageId) {
  const ledger = loadLedger(path);
  return ledger.entries[messageId] || null;
}

/** Merges fields into one Gmail message's ledger record and saves atomically. */
export function upsertEntry(path, messageId, patch) {
  const ledger = loadLedger(path);
  const next = { ...(ledger.entries[messageId] || { messageId }), ...patch, messageId };
  ledger.entries[messageId] = next;
  saveLedger(path, ledger);
  return next;
}

/**
 * Parses CLI arguments for `support-ledger`.
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
        status: { type: 'string' },
        limit: { type: 'string' },
        days: { type: 'string' },
        reason: { type: 'string' },
        soc2: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [sub, ...rest] = positionals;
  if (!sub || !['check', 'get', 'list', 'skip', 'stats'].includes(sub)) {
    return { error: sub ? `unknown subcommand '${sub}'` : 'a subcommand is required (check, get, list, skip, or stats)' };
  }
  const json = values.json === true;

  if (sub === 'stats') {
    if (rest.length) return { error: 'stats takes flags only, no positional arguments' };
    let days = null;
    if (values.days !== undefined) {
      days = Number(values.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return { error: '--days must be a whole number from 1 to 3650' };
      }
    }
    return { sub, days, json };
  }

  if (sub === 'check') {
    if (!rest.length) return { error: 'check needs at least one Gmail message id' };
    const bad = rest.find((id) => !VALID_ID.test(id));
    if (bad) return { error: `'${bad}' is not a valid Gmail message id` };
    return { sub, ids: rest, json };
  }

  if (sub === 'get') {
    if (rest.length !== 1) return { error: 'get needs exactly one Gmail message id' };
    if (!VALID_ID.test(rest[0])) return { error: `'${rest[0]}' is not a valid Gmail message id` };
    return { sub, id: rest[0], json };
  }

  if (sub === 'list') {
    if (rest.length) return { error: 'list takes flags only, no positional arguments' };
    if (values.status && !VALID_STATUSES.has(values.status)) {
      return { error: `--status must be one of ${[...VALID_STATUSES].join(', ')}` };
    }
    let limit = DEFAULT_LIMIT;
    if (values.limit !== undefined) {
      limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return { error: '--limit must be a whole number from 1 to 500' };
      }
    }
    return { sub, status: values.status || null, limit, json };
  }

  if (rest.length !== 1) return { error: 'skip needs exactly one Gmail message id' };
  if (!VALID_ID.test(rest[0])) return { error: `'${rest[0]}' is not a valid Gmail message id` };
  const reason = String(values.reason || '').trim();
  if (!reason) return { error: 'skip requires --reason "<why>"' };
  return { sub, id: rest[0], reason, soc2: values.soc2 === true, json };
}

/** Computes outcome & quality metrics across stored triage ledger entries. */
export function computeStats(entries, { days = null, nowMs = Date.now() } = {}) {
  const cutoff = days ? nowMs - days * 86_400_000 : null;
  const all = Object.values(entries || {});
  const rows = cutoff === null
    ? all
    : all.filter((e) => {
        const ts = Date.parse(e?.updatedAt || e?.sentAt || '');
        return Number.isFinite(ts) && ts >= cutoff;
      });
  const byStatus = { pending_review: 0, auto_replied: 0, sent: 0, skipped: 0 };
  const byResolution = { auto_replied: 0, approved_as_is: 0, edited_before_send: 0, manual_reply: 0, skipped: 0 };
  const latencies = [];
  const edited = [];
  let dryRunPreviews = 0;
  let soc2Total = 0;

  for (const e of rows) {
    if (!e || e.status === 'dry_run') {
      if (e?.lastDryRun) dryRunPreviews += 1;
      continue;
    }
    if (e.status in byStatus) byStatus[e.status] += 1;
    if (e.soc2) soc2Total += 1;
    if (e.status === 'skipped') {
      byResolution.skipped += 1;
    } else if (e.status === 'auto_replied') {
      byResolution.auto_replied += 1;
    } else if (e.status === 'sent') {
      const res = e.resolution || (e.proposedBody ? 'approved_as_is' : 'manual_reply');
      if (res in byResolution) byResolution[res] += 1;
      if (res === 'edited_before_send') {
        edited.push({
          messageId: e.messageId,
          subject: e.subject || '(no subject)',
          updatedAt: e.updatedAt || null,
          revisions: e.revision || 1,
        });
      }
    }
    if (Number.isFinite(e.reviewLatencySeconds)) latencies.push(e.reviewLatencySeconds);
  }

  const reviewedCount = byResolution.approved_as_is + byResolution.edited_before_send;
  const handledResponses = byStatus.auto_replied + byStatus.sent + byStatus.pending_review;
  const autoReplyRate = handledResponses > 0 ? Number((byStatus.auto_replied / handledResponses).toFixed(3)) : null;
  const unmodifiedApprovalRate = reviewedCount > 0 ? Number((byResolution.approved_as_is / reviewedCount).toFixed(3)) : null;
  let medianReviewLatencySeconds = null;
  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    const mid = Math.floor(latencies.length / 2);
    medianReviewLatencySeconds = latencies.length % 2 === 1 ? latencies[mid] : Math.round((latencies[mid - 1] + latencies[mid]) / 2);
  }
  edited.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const total = byStatus.pending_review + byStatus.auto_replied + byStatus.sent + byStatus.skipped;

  return {
    windowDays: days,
    total,
    soc2Total,
    dryRunPreviews,
    byStatus,
    byResolution,
    autoReplyRate,
    unmodifiedApprovalRate,
    medianReviewLatencySeconds,
    recentEdited: edited.slice(0, 10),
  };
}

/**
 * Entry point for `support-ledger`.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || Date.now;
  const fail = (msg, code = 1) => { stderr.write(`support-ledger: ${msg}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const file = deps.ledgerFile || ledgerPath(deps.runtime || createCliRuntime({ stderr }));

    if (args.sub === 'check') {
      const ledger = loadLedger(file);
      const results = args.ids.map((id) => {
        const e = ledger.entries[id];
        if (!e) return { messageId: id, status: 'new', soc2: false, updatedAt: null };
        if (e.status === 'dry_run') {
          return { messageId: id, status: 'new', dryRunAt: e.lastDryRun?.at || e.updatedAt || null, soc2: Boolean(e.soc2), updatedAt: e.updatedAt || null };
        }
        return { messageId: id, status: e.status, soc2: Boolean(e.soc2), updatedAt: e.updatedAt || null };
      });
      if (args.json) {
        stdout.write(`${JSON.stringify({ entries: results }, null, 2)}\n`);
        return 0;
      }
      for (const r of results) {
        stdout.write(`${r.messageId}: ${r.status}${r.dryRunAt ? ' [dry-run previewed]' : ''}${r.soc2 ? ' [soc2]' : ''}${r.updatedAt ? ` (${r.updatedAt})` : ''}\n`);
      }
      return 0;
    }

    if (args.sub === 'stats') {
      const ledger = loadLedger(file);
      const stats = computeStats(ledger.entries, { days: args.days, nowMs: now() });
      if (args.json) {
        stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
        return 0;
      }
      const fmtPct = (v) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
      stdout.write([
        `Support ledger stats${args.days ? ` (last ${args.days}d)` : ''}:`,
        `- Total tracked: ${stats.total} (SOC 2: ${stats.soc2Total}${stats.dryRunPreviews ? `, dry-run previews: ${stats.dryRunPreviews}` : ''})`,
        `- Statuses: auto_replied=${stats.byStatus.auto_replied}, pending_review=${stats.byStatus.pending_review}, sent=${stats.byStatus.sent}, skipped=${stats.byStatus.skipped}`,
        `- Review outcomes: approved_as_is=${stats.byResolution.approved_as_is}, edited_before_send=${stats.byResolution.edited_before_send}, auto_reply_rate=${fmtPct(stats.autoReplyRate)}, unmodified_approval_rate=${fmtPct(stats.unmodifiedApprovalRate)}`,
        `- Median review latency: ${stats.medianReviewLatencySeconds === null ? 'n/a' : `${stats.medianReviewLatencySeconds}s`}`,
      ].join('\n') + '\n');
      return 0;
    }

    if (args.sub === 'get') {
      const entry = getEntry(file, args.id);
      if (!entry) return fail(`message ${args.id} is not in the support ledger`, 1);
      if (args.json) {
        stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
        return 0;
      }
      const lines = [
        `Message: ${entry.messageId} (thread ${entry.threadId || 'unknown'})`,
        `Status: ${entry.status}${entry.soc2 ? ' [SOC 2]' : ''}`,
        ...(entry.from ? [`From: ${entry.from}`] : []),
        ...(entry.replyTo ? [`Reply-To: ${entry.replyTo}`] : []),
        ...(entry.subject ? [`Subject: ${entry.subject}`] : []),
        ...(entry.space ? [`Chat space: ${entry.space}${entry.chatThread ? ` | thread ${entry.chatThread}` : ''}`] : []),
        ...(entry.sentMessageId ? [`Sent Gmail id: ${entry.sentMessageId}${entry.sentAt ? ` at ${entry.sentAt}` : ''}`] : []),
        ...(entry.skipReason ? [`Skip reason: ${entry.skipReason}`] : []),
        `Updated: ${entry.updatedAt || 'unknown'}`,
      ];
      if (entry.proposedBody) lines.push('', 'Proposed reply:', entry.proposedBody);
      if (entry.sentBody) lines.push('', 'Sent reply:', entry.sentBody);
      stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }

    if (args.sub === 'list') {
      const ledger = loadLedger(file);
      let rows = Object.values(ledger.entries).filter((e) => e?.status && e.status !== 'dry_run');
      if (args.status) rows = rows.filter((e) => e.status === args.status);
      rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      rows = rows.slice(0, args.limit);
      if (args.json) {
        stdout.write(`${JSON.stringify({ entries: rows }, null, 2)}\n`);
        return 0;
      }
      if (!rows.length) {
        stdout.write(args.status ? `No entries with status '${args.status}'.\n` : 'No entries in the support ledger yet.\n');
        return 0;
      }
      for (const e of rows) {
        stdout.write(`${e.messageId} | ${e.status}${e.soc2 ? ' [SOC 2]' : ''} | ${e.subject || '(no subject)'} | ${e.from || '(unknown)'}\n`);
      }
      return 0;
    }

    const updatedAt = new Date(now()).toISOString();
    const existing = getEntry(file, args.id);
    const saved = upsertEntry(file, args.id, {
      status: 'skipped',
      resolution: 'skipped',
      skipReason: args.reason,
      soc2: Boolean(args.soc2 || existing?.soc2),
      updatedAt,
    });
    if (args.json) {
      stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
      return 0;
    }
    stdout.write(`Marked ${args.id} skipped: ${args.reason}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
