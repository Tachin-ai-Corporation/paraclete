#!/usr/bin/env node
// skills/workspace-docs/docs-create.mjs: the docs-create command. Makes a NEW Google Doc from Markdown
// the agent wrote (a file in its mission tree, or text given inline), converted by Drive: headings,
// lists, emphasis, links and tables become a formatted Doc. It lands in a folder the agent names, or in
// the agent's own My Drive, and the agent's account owns it, so docs-replace may change it later. It
// only ever creates. The Drive upload is agent/providers/workspace-docs.mjs over
// agent/providers/drive.mjs; the local file is checked the way drive-put checks one
// (skills/drive/drive-put.mjs). Documented in skills/workspace-docs/SKILL.md.

import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createDocsClient } from '../../agent/providers/workspace-docs.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { localFile } from '../drive/drive-put.mjs';

export const USAGE = 'Usage: docs-create --title <title> (--from <markdown file> --mission <mission id> | --text <markdown>) [--folder <drive folder link or id>] [--json]';

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

/**
 * Where a new file landed, in words, and who can see it.
 *
 * @param {string|null} folder
 * @param {string} account
 * @returns {string[]}
 */
export function placeLines(folder, account) {
  return folder
    ? [`In Drive folder ${folder}: whoever can open that folder can open it.`]
    : [`In the My Drive of ${account}: only you can open it until it is shared. To hand it to a person, make it in a folder they can open (--folder), and deliver the content as a download too.`];
}

/**
 * Text content for a new file: --text as given, or a local file read with drive-put's checks (inside the
 * agent's data, not a credential, under the size cap) that must have one of the given extensions.
 *
 * @returns {{text: string, from: string|null}}
 */
export function readSource({ text, from, mission }, { runtime, extensions, kind }) {
  if (text !== undefined) return { text, from: null };
  const file = localFile(from, { mission, paths: runtime.paths, maxBytes: runtime.contracts.files.max_mb * 1024 * 1024 });
  if (!extensions.has(extname(file.name).toLowerCase())) {
    throw new Error(`${file.name} is not ${kind} (${[...extensions].join(', ')}). Write the content as ${kind} first; to put an Office file into Drive, use drive-put --convert.`);
  }
  return { text: file.bytes.toString('utf8'), from: file.path };
}

/**
 * Checks the source options every create command shares: --from with --mission, or --text.
 *
 * @returns {string|null} the problem
 */
export function sourceProblem({ from, text, mission }, { required = true } = {}) {
  if (from !== undefined && text !== undefined) return 'use --from or --text, not both';
  if (from === undefined && text === undefined) return required ? 'give the content: --from <file> --mission <mission id>, or --text <content>' : null;
  if (from !== undefined && mission === undefined) return '--from needs --mission <mission id>: a relative path starts from the mission tree';
  if (mission !== undefined && !MISSION_ID.test(mission)) return `'${mission}' is not a mission id`;
  return null;
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { title, from, text, mission, folder, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      options: {
        title: { type: 'string' }, from: { type: 'string' }, text: { type: 'string' }, mission: { type: 'string' },
        folder: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values } = parsed;
  if (values.help) return { help: true };
  if (!values.title?.trim()) return { error: '--title is required: the new document\'s name' };
  const problem = sourceProblem(values);
  if (problem) return { error: problem };
  let folder = null;
  if (values.folder !== undefined) {
    folder = parseDriveLink(values.folder);
    if (!folder) return { error: `'${values.folder}' is not a Drive folder link or id` };
  }
  return { title: values.title.trim(), from: values.from, text: values.text, mission: values.mission, folder, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, contracts, paths
 * @param {object} [deps.docs]    from createDocsClient()
 * @returns {Promise<number>} 0, 1 when Google or the disk refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`docs-create: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const docs = deps.docs || createDocsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const source = readSource(args, { runtime, extensions: TEXT_EXTENSIONS, kind: 'Markdown or text' });
    if (!source.text.trim()) return fail('the content is empty: write the document first', 2);
    const file = await docs.create({ title: args.title, markdown: source.text, folderId: args.folder });
    const link = file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit`;
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: file.id, name: file.name ?? args.title, link, folder_id: args.folder, owner: docs.account }, null, 2)}\n`);
      return 0;
    }
    stdout.write([
      `Created the Google Doc "${file.name ?? args.title}"`,
      `id: ${file.id}`,
      `link: ${link}`,
      ...placeLines(args.folder, docs.account),
      'Check it with docs-get before you hand it over.',
      '',
    ].join('\n'));
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
