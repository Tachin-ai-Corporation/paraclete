#!/usr/bin/env node
// skills/workspace-sheets/sheets-create.mjs: the sheets-create command. Makes a NEW Google Sheet, empty
// or from CSV (a file in the mission tree, or text given inline), converted by Drive so numbers and
// dates arrive as values. It lands in a folder the agent names, or in the agent's own My Drive, and the
// agent's account owns it, so sheets-append and sheets-update may write to it later. It only ever
// creates. The Drive upload is agent/providers/workspace-sheets.mjs over agent/providers/drive.mjs; the
// content options are the ones docs-create takes (skills/workspace-docs/docs-create.mjs). Documented
// in skills/workspace-sheets/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createSheetsClient } from '../../agent/providers/workspace-sheets.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { placeLines, readSource, sourceProblem } from '../workspace-docs/docs-create.mjs';

export const USAGE = 'Usage: sheets-create --title <title> [--from <csv file> --mission <mission id> | --csv <csv text>] [--folder <drive folder link or id>] [--json]';

const CSV_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

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
        title: { type: 'string' }, from: { type: 'string' }, csv: { type: 'string' }, mission: { type: 'string' },
        folder: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values } = parsed;
  if (values.help) return { help: true };
  if (!values.title?.trim()) return { error: '--title is required: the new spreadsheet\'s name' };
  const problem = sourceProblem({ from: values.from, text: values.csv, mission: values.mission }, { required: false });
  if (problem) return { error: problem.replace('--text', '--csv') };
  let folder = null;
  if (values.folder !== undefined) {
    folder = parseDriveLink(values.folder);
    if (!folder) return { error: `'${values.folder}' is not a Drive folder link or id` };
  }
  return { title: values.title.trim(), from: values.from, text: values.csv, mission: values.mission, folder, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, contracts, paths
 * @param {object} [deps.sheets]  from createSheetsClient()
 * @returns {Promise<number>} 0, 1 when Google or the disk refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`sheets-create: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || (args.from !== undefined || !deps.sheets ? createCliRuntime({ stderr }) : null);
    const sheets = deps.sheets || createSheetsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const csv = args.from === undefined && args.text === undefined ? '' : readSource(args, { runtime, extensions: CSV_EXTENSIONS, kind: 'CSV' }).text;
    const file = await sheets.create({ title: args.title, csv, folderId: args.folder });
    const link = file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}/edit`;
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: file.id, name: file.name ?? args.title, link, folder_id: args.folder, owner: sheets.account }, null, 2)}\n`);
      return 0;
    }
    stdout.write([
      `Created the Google Sheet "${file.name ?? args.title}"${csv ? '' : ' (empty)'}`,
      `id: ${file.id}`,
      `link: ${link}`,
      ...placeLines(args.folder, sheets.account),
      `Check it with sheets-get ${file.id} before you hand it over.`,
      '',
    ].join('\n'));
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
