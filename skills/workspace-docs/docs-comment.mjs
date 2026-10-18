#!/usr/bin/env node
// skills/workspace-docs/docs-comment.mjs: the docs-comment command. Lists a Google Doc's comments, adds
// one (quoting the passage it is about, which must be in the document), or replies to one. Commenting
// is how the agent gives feedback on a document someone shared: it never changes their text. A comment
// never mentions people with @ or + before an address, because Google would email them and every
// message the agent sends leaves through its conversation instead. The Drive comment calls are
// agent/providers/workspace-docs.mjs. Documented in skills/workspace-docs/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createDocsClient } from '../../agent/providers/workspace-docs.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { commentLines } from './docs-get.mjs';

export const USAGE = [
  'Usage: docs-comment <doc link or id> [--all] [--json]',
  '       docs-comment <doc link or id> --text <comment> [--quote <exact passage>] [--json]',
  '       docs-comment <doc link or id> --reply <comment id> --text <reply> [--json]',
].join('\n');

const MAX_COMMENT_CHARS = 4000;
/** An address with @ or + in front: Google turns it into a mention and emails the person. */
const MENTION = /(^|[\s(])[@+][^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { id, list, all, text, quote, reply, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: 'boolean' }, text: { type: 'string' }, quote: { type: 'string' }, reply: { type: 'string' },
        json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one document at a time, got ${positionals.length}` : 'a Google Doc link or id is required' };
  const id = parseDriveLink(positionals[0]);
  if (!id) return { error: `'${positionals[0]}' is not a Google Doc link or id` };
  const json = values.json === true;
  if (values.text === undefined) {
    if (values.quote !== undefined || values.reply !== undefined) return { error: '--quote and --reply go with --text' };
    return { id, list: true, all: values.all === true, json };
  }
  if (values.all) return { error: '--all goes with listing, not with --text' };
  const text = values.text.trim();
  if (!text) return { error: '--text is empty' };
  if (text.length > MAX_COMMENT_CHARS) return { error: `a comment is at most ${MAX_COMMENT_CHARS} characters` };
  if (MENTION.test(text)) return { error: 'a comment never mentions people with @ or + before their address: Google would email them. Name them in plain words.' };
  if (values.reply !== undefined) {
    if (values.quote !== undefined) return { error: 'a reply quotes nothing: leave out --quote' };
    if (!/^[A-Za-z0-9_-]+$/.test(values.reply)) return { error: `'${values.reply}' is not a comment id: copy it from the list (docs-comment <doc>)` };
    return { id, text, reply: values.reply, json };
  }
  if (values.quote !== undefined && !values.quote.trim()) return { error: '--quote is empty' };
  return { id, text, quote: values.quote?.trim(), json };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime()
 * @param {object} [deps.docs]    from createDocsClient()
 * @returns {Promise<number>} 0, 1 when Google refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`docs-comment: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const docs = deps.docs || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createDocsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();

    if (args.list) {
      const comments = await docs.comments(args.id, { includeResolved: args.all });
      if (args.json) {
        stdout.write(`${JSON.stringify({ document: args.id, comments }, null, 2)}\n`);
        return 0;
      }
      const head = comments.length ? `${comments.length} ${args.all ? '' : 'open '}comment${comments.length === 1 ? '' : 's'} on document ${args.id}:` : `No ${args.all ? '' : 'open '}comments on document ${args.id}.`;
      stdout.write(`${[head, ...commentLines(comments)].join('\n')}\n`);
      return 0;
    }

    if (args.reply) {
      const reply = await docs.reply(args.id, args.reply, args.text);
      stdout.write(args.json
        ? `${JSON.stringify({ document: args.id, comment: args.reply, reply }, null, 2)}\n`
        : `Replied to comment ${args.reply} on document ${args.id} (reply id ${reply.id}). The document's text is unchanged.\n`);
      return 0;
    }

    const comment = await docs.addComment(args.id, { content: args.text, quote: args.quote });
    stdout.write(args.json
      ? `${JSON.stringify({ document: args.id, comment }, null, 2)}\n`
      : `${[
        `Commented on document ${args.id} (comment id ${comment.id})${args.quote ? `, quoting "${args.quote.slice(0, 120)}"` : ''}.`,
        'The document\'s text is unchanged. Google Docs shows the comment with its quote; it may not highlight the passage itself.',
      ].join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
