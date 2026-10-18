#!/usr/bin/env node
// skills/workspace-docs/docs-get.mjs: the docs-get command. Reads a Google Doc, every tab of it or one,
// as Markdown (headings, lists, bold, italic, links, tables) or as its exact text (the strings
// docs-replace and quoted comments match), with who owns it and what the agent may do with it, and
// optionally its comments. A long document is cut on screen and says so; --mission or --out saves the
// whole of it as a file instead. It also exports the comment lines docs-comment prints. The Docs and
// Drive calls are agent/providers/workspace-docs.mjs. Documented in skills/workspace-docs/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createDocsClient, renderDocument } from '../../agent/providers/workspace-docs.mjs';
import { parseDriveLink, describeType, GOOGLE_TYPES } from '../../agent/providers/drive.mjs';
import { destinationProblem, saveFile } from '../drive/drive-get.mjs';

export const USAGE = [
  'Usage: docs-get <doc link or id> [--format md|text] [--tab <tab id or title>] [--comments | --all-comments] [--max-chars <n>] [--json]',
  '       docs-get <doc link or id> (--mission <mission id> | --out <path>) [--format md|text] [--tab <tab id or title>]',
].join('\n');

const DEFAULT_MAX_CHARS = 40_000;
const MAX_CHARS = 400_000;

/** Someone as the comment lines name them. */
const who = (author) => (author?.me ? 'you' : (author?.displayName || author?.emailAddress || 'someone'));

/**
 * Comments as numbered lines: id, author, date, the passage, the comment, then each reply.
 *
 * @param {object[]} comments from the Docs client's comments()
 * @returns {string[]}
 */
export function commentLines(comments) {
  const lines = [];
  comments.forEach((c, i) => {
    const quote = c.quotedFileContent?.value ? ` on "${c.quotedFileContent.value.replace(/\s+/g, ' ').trim().slice(0, 120)}"` : '';
    lines.push(`${i + 1}. [${c.id}] ${who(c.author)}, ${String(c.createdTime || '').slice(0, 10)}${quote}${c.resolved ? ' (resolved)' : ''}: ${c.content}`);
    for (const r of c.replies || []) {
      if (r.deleted) continue;
      lines.push(`   - ${who(r.author)}, ${String(r.createdTime || '').slice(0, 10)}${r.action ? ` (${r.action})` : ''}: ${r.content || ''}`);
    }
  });
  return lines;
}

/**
 * What the agent may do with a Doc, in one line: owns it, or shared with it and how.
 *
 * @param {object} info the Drive record (session.fileInfo)
 * @param {boolean} owned
 * @returns {string}
 */
export function accessLine(info, owned) {
  if (owned) return 'You own it: you may change it in place (docs-replace).';
  const owner = info.owners?.[0];
  const by = info.driveId ? 'in a shared drive' : `owned by ${owner ? (owner.displayName ? `${owner.displayName} <${owner.emailAddress}>` : owner.emailAddress) : 'someone else'}`;
  const can = info.capabilities?.canComment ? 'you may read and comment' : 'you may read it';
  return `It is ${by}: ${can}, never change it. Changes go in a new document (docs-create), or in comments (docs-comment).`;
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { id, format, tab, comments, allComments, maxChars, mission, out, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string' }, tab: { type: 'string' }, comments: { type: 'boolean' }, 'all-comments': { type: 'boolean' },
        'max-chars': { type: 'string' }, mission: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one document at a time, got ${positionals.length}` : 'a Google Doc link or id is required' };
  const id = parseDriveLink(positionals[0]);
  if (!id) return { error: `'${positionals[0]}' is not a Google Doc link or id: copy the link from the browser, or the id between /d/ and /edit` };
  const format = values.format ?? 'md';
  if (!['md', 'text'].includes(format)) return { error: '--format is md or text' };
  let maxChars = DEFAULT_MAX_CHARS;
  if (values['max-chars'] !== undefined) {
    maxChars = Number(values['max-chars']);
    if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > MAX_CHARS) return { error: `--max-chars must be a whole number from 100 to ${MAX_CHARS}` };
  }
  const saving = values.mission !== undefined || values.out !== undefined;
  if (saving) {
    const problem = destinationProblem(values);
    if (problem) return { error: problem };
    if (values.comments || values['all-comments'] || values.json) return { error: 'saving to a file takes only --format and --tab' };
  }
  return {
    id, format, tab: values.tab, comments: values.comments === true || values['all-comments'] === true, allComments: values['all-comments'] === true,
    maxChars, mission: values.mission, out: values.out, saving, json: values.json === true,
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, paths
 * @param {object} [deps.docs]    from createDocsClient()
 * @param {string} [deps.cwd]
 * @returns {Promise<number>} 0, 1 when Google or the disk refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`docs-get: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || (args.saving || !deps.docs ? createCliRuntime({ stderr }) : null);
    const docs = deps.docs || createDocsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const info = await docs.info(args.id);
    if (info.mimeType !== GOOGLE_TYPES.document) {
      return fail(`"${info.name}" is ${describeType(info.mimeType)}, not a Google Doc. Read it with drive-get ${info.id} --mission <mission id>, then file-read, or for Sheets and Slides use sheets-get or slides-get.`);
    }
    const owned = docs.owns(info);
    const doc = await docs.get(args.id);
    const text = renderDocument(doc, { format: args.format, tab: args.tab });
    const link = info.webViewLink || `https://docs.google.com/document/d/${info.id}/edit`;

    if (args.saving) {
      const name = `${info.name || doc.title || info.id}.${args.format === 'md' ? 'md' : 'txt'}`;
      const saved = saveFile({ bytes: Buffer.from(text, 'utf8'), name, mission: args.mission, out: args.out, missionsRoot: runtime.paths.data.missions, cwd: deps.cwd });
      stdout.write([
        `Saved ${saved.path}${saved.replaced ? ' (replacing an earlier copy)' : ''}`,
        `"${info.name}" as ${args.format === 'md' ? 'Markdown' : 'text'} | ${saved.size} bytes | from ${link}`,
        accessLine(info, owned),
        '',
      ].join('\n'));
      return 0;
    }

    const comments = args.comments ? await docs.comments(args.id, { includeResolved: args.allComments }) : null;
    if (args.json) {
      stdout.write(`${JSON.stringify({
        id: info.id, title: info.name, link, owned, owners: info.owners || [], shared_drive: info.driveId || null, revision: doc.revisionId || null,
        format: args.format, text, comments,
      }, null, 2)}\n`);
      return 0;
    }
    const cut = text.length > args.maxChars;
    const lines = [
      `"${info.name}" | Google Doc | ${link}`,
      accessLine(info, owned),
      '',
      cut ? text.slice(0, args.maxChars) : text.replace(/\n$/, ''),
    ];
    if (cut) lines.push(`[cut: ${text.length - args.maxChars} more characters. Save the whole document with --mission <mission id> and read the file]`);
    if (comments) {
      lines.push('', comments.length ? `Comments (${comments.length}${args.allComments ? '' : ' open'}):` : `No ${args.allComments ? '' : 'open '}comments.`, ...commentLines(comments));
    }
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
