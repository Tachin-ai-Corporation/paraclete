#!/usr/bin/env node
// skills/workspace-gmail/gmail-get.mjs: the gmail-get command. Reads one message from the agent's own
// mailbox as text (or, with --thread, the whole conversation it belongs to, oldest first): its headers,
// its body (the plain-text part, or the HTML part turned into text) and a numbered list of its
// attachments. With --attachment it fetches an attachment into the mission's inbox (or to a path) so
// the files skill can read it. Read only. The Gmail calls are agent/providers/workspace-gmail.mjs; the
// file is saved the way drive-get saves one (skills/drive/drive-get.mjs). Documented in
// skills/workspace-gmail/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createGmailClient } from '../../agent/providers/workspace-gmail.mjs';
import { destinationProblem, saveFile } from '../drive/drive-get.mjs';

export const USAGE = [
  'Usage: gmail-get <message id> [--thread] [--max-chars <n>] [--json]',
  '       gmail-get <message id> --attachment <number|all> (--mission <mission id> | --out <path>) [--json]',
].join('\n');

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS = 200_000;

/** A size in bytes, briefly. */
export function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { id, thread, maxChars, attachment, mission, out, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        thread: { type: 'boolean' }, 'max-chars': { type: 'string' }, attachment: { type: 'string' },
        mission: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one message at a time, got ${positionals.length}` : 'the message id is required (gmail-search prints it)' };
  const id = positionals[0];
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { error: `'${id}' is not a Gmail message id: copy the id gmail-search printed` };
  let maxChars = DEFAULT_MAX_CHARS;
  if (values['max-chars'] !== undefined) {
    maxChars = Number(values['max-chars']);
    if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > MAX_CHARS) return { error: `--max-chars must be a whole number from 100 to ${MAX_CHARS}` };
  }
  if (values.attachment !== undefined) {
    if (values.thread) return { error: '--attachment fetches from one message: leave out --thread' };
    const which = values.attachment.trim().toLowerCase();
    if (which !== 'all' && !/^\d+$/.test(which)) return { error: "--attachment takes the attachment's number from the list, or all" };
    const problem = destinationProblem(values);
    if (problem) return { error: problem };
    return { id, attachment: which === 'all' ? 'all' : Number(which), mission: values.mission, out: values.out, json: values.json === true };
  }
  if (values.mission !== undefined || values.out !== undefined) return { error: '--mission and --out go with --attachment' };
  return { id, thread: values.thread === true, maxChars, json: values.json === true };
}

/** A message as JSON prints it: an attachment's bytes stay out. */
const messageJson = (m) => ({ ...m, attachments: m.attachments.map(({ data, ...a }) => a) });

/** One message as the lines the command prints, its body cut at `maxChars`. */
function messageLines(m, maxChars) {
  const body = m.text || m.snippet || '(no text)';
  const cut = body.length > maxChars;
  const lines = [
    `From: ${m.from || '(none)'}`,
    `To: ${m.to || '(none)'}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Date: ${m.date || '(none)'}`,
    `Subject: ${m.subject || '(none)'}`,
    `Message id: ${m.id} | thread ${m.threadId}${m.labelIds.length ? ` | labels ${m.labelIds.join(', ')}` : ''}`,
    '',
    cut ? body.slice(0, maxChars) : body,
  ];
  if (cut) lines.push(`[cut: ${body.length - maxChars} more characters. Read more with --max-chars, up to ${MAX_CHARS}]`);
  if (m.html) lines.push('[this message has no plain-text part; its HTML was turned into text]');
  if (m.attachments.length) {
    lines.push('', 'Attachments:');
    for (const a of m.attachments) {
      lines.push(`${a.index}. ${a.filename} (${a.mimeType}, ${size(a.size)}${a.inline ? ', inline' : ''}): gmail-get ${m.id} --attachment ${a.index} --mission <mission id>`);
    }
  }
  return lines;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, contracts, paths
 * @param {object} [deps.gmail]   from createGmailClient()
 * @param {string} [deps.cwd]
 * @returns {Promise<number>} 0, 1 when Gmail or the disk refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`gmail-get: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || (args.attachment !== undefined || !deps.gmail ? createCliRuntime({ stderr }) : null);
    const gmail = deps.gmail || createGmailClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });

    if (args.attachment !== undefined) {
      const message = await gmail.getMessage(args.id);
      if (!message.attachments.length) return fail(`message ${args.id} has no attachments`);
      const picked = args.attachment === 'all' ? message.attachments : message.attachments.filter((a) => a.index === args.attachment);
      if (!picked.length) return fail(`message ${args.id} has no attachment ${args.attachment}: it has ${message.attachments.length} (${message.attachments.map((a) => `${a.index} ${a.filename}`).join(', ')})`, 2);
      const maxBytes = runtime.contracts.files.fetch_max_mb * 1024 * 1024;
      const saved = [];
      for (const a of picked) {
        if (a.size > maxBytes) return fail(`${a.filename} is ${size(a.size)}, more than the ${runtime.contracts.files.fetch_max_mb} MB a fetched file may be`);
        const bytes = await gmail.getAttachment(message.id, a);
        const out = args.out !== undefined && picked.length > 1 && !/[\\/]$/.test(args.out) ? `${args.out}/` : args.out;
        const file = saveFile({ bytes, name: a.filename, mission: args.mission, out, missionsRoot: runtime.paths.data.missions, cwd: deps.cwd });
        saved.push({ ...file, name: a.filename, mime_type: a.mimeType, index: a.index });
      }
      if (args.json) {
        stdout.write(`${JSON.stringify({ message: message.id, files: saved }, null, 2)}\n`);
        return 0;
      }
      const lines = [];
      for (const f of saved) {
        lines.push(`Saved ${f.path}${f.replaced ? ' (replacing an earlier copy)' : ''}`, `${f.name} | ${f.mime_type} | ${f.size} bytes | sha256 ${f.sha256}`, `Read it with: file-read ${f.path}`);
      }
      lines.push(`From message ${message.id}: "${message.subject || '(no subject)'}" from ${message.from || '(unknown sender)'}`);
      stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }

    if (args.thread) {
      const first = await gmail.getMessage(args.id);
      const thread = await gmail.getThread(first.threadId);
      if (args.json) {
        stdout.write(`${JSON.stringify({ thread: thread.id, messages: thread.messages.map(messageJson) }, null, 2)}\n`);
        return 0;
      }
      const lines = [`Thread ${thread.id}: ${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}, oldest first.`];
      thread.messages.forEach((m, i) => {
        lines.push('', `=== Message ${i + 1} of ${thread.messages.length} ===`, ...messageLines(m, Math.ceil(args.maxChars / thread.messages.length)));
      });
      stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }

    const message = await gmail.getMessage(args.id);
    if (args.json) {
      stdout.write(`${JSON.stringify(messageJson(message), null, 2)}\n`);
      return 0;
    }
    stdout.write(`${messageLines(message, args.maxChars).join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
