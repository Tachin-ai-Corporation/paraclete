#!/usr/bin/env node
// skills/workspace-gmail/gmail-search.mjs: the gmail-search command. Searches the agent's own mailbox
// with Gmail's query syntax and prints each match, newest first: when it arrived, sender, subject, the
// ids gmail-get takes, whether it is unread, and its snippet. Read only. The Gmail calls are
// agent/providers/workspace-gmail.mjs. Documented in skills/workspace-gmail/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createGmailClient } from '../../agent/providers/workspace-gmail.mjs';

export const USAGE = 'Usage: gmail-search <Gmail query> [--limit <n>] [--json]';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** When a message arrived, in UTC: "2026-10-19 14:12 UTC". */
export function arrived(ms) {
  if (!Number.isFinite(ms)) return 'date unknown';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { query, limit, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: { limit: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const query = positionals.join(' ').trim();
  if (!query) return { error: "a Gmail query is required, like 'from:pat@example.com newer_than:7d' or 'in:inbox is:unread'" };
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: `--limit must be a whole number from 1 to ${MAX_LIMIT}` };
  }
  return { query, limit, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime()
 * @param {object} [deps.gmail]   from createGmailClient()
 * @returns {Promise<number>} 0, 1 when Gmail refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`gmail-search: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const gmail = deps.gmail || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createGmailClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const found = await gmail.search({ query: args.query, limit: args.limit });
    if (args.json) {
      stdout.write(`${JSON.stringify({ mailbox: gmail.account, query: args.query, messages: found.messages, capped: found.capped, estimate: found.estimate }, null, 2)}\n`);
      return 0;
    }
    const n = found.messages.length;
    const lines = n
      ? [`${n} message${n === 1 ? '' : 's'} in the mailbox of ${gmail.account} match ${JSON.stringify(args.query)}, newest first:`]
      : [`No message in the mailbox of ${gmail.account} matches ${JSON.stringify(args.query)}. Widen the query: fewer words, a longer newer_than, or no is:/in: filters.`];
    found.messages.forEach((m, i) => {
      const flags = [m.labelIds.includes('UNREAD') ? 'unread' : null, m.labelIds.includes('SENT') ? 'sent by you' : null].filter(Boolean);
      lines.push(`${i + 1}. ${arrived(m.internalDate)} | ${m.from || '(no sender)'} | ${m.subject || '(no subject)'} | id ${m.id} | thread ${m.threadId}${flags.length ? ` | ${flags.join(', ')}` : ''}`);
      if (m.snippet) lines.push(`   ${m.snippet}`);
    });
    if (found.capped) lines.push(`More match (about ${found.estimate}): narrow the query, or raise --limit (at most ${MAX_LIMIT}).`);
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
