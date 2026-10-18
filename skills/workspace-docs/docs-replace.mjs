#!/usr/bin/env node
// skills/workspace-docs/docs-replace.mjs: the docs-replace command. Changes a Google Doc in place, and
// only a Doc the agent's own account owns (one it created): finds and replaces text (one pair, or many
// from a JSON file, in one change), or rewrites the section under a heading from Markdown. Everything it
// does not touch keeps its formatting. A Doc someone else owns, or one in a shared drive, is refused
// before anything is sent, with what to do instead. Each change is guarded by the revision it was
// planned on. The Docs calls are agent/providers/workspace-docs.mjs. Documented in
// skills/workspace-docs/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createDocsClient } from '../../agent/providers/workspace-docs.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { localFile } from '../drive/drive-put.mjs';
import { readSource, sourceProblem } from './docs-create.mjs';

export const USAGE = [
  'Usage: docs-replace <doc link or id> --find <text> --replace <text> [--match-case] [--json]',
  '       docs-replace <doc link or id> --pairs <json file> --mission <mission id> [--json]',
  '       docs-replace <doc link or id> --section <heading> (--with <markdown file> --mission <mission id> | --text <markdown>) [--tab <tab id or title>] [--json]',
].join('\n');

const MAX_PAIRS = 100;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

/**
 * The find-and-replace pairs in a JSON file: `[{ "find", "replace", "match_case"? }]`.
 *
 * @param {string} text
 * @returns {Array<{find: string, replace: string, matchCase: boolean}>}
 * @throws {Error} naming the first bad entry
 */
export function parsePairs(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`the pairs file is not JSON: ${err.message}`);
  }
  if (!Array.isArray(data) || !data.length) throw new Error('the pairs file holds a list: [{ "find": "...", "replace": "..." }]');
  if (data.length > MAX_PAIRS) throw new Error(`at most ${MAX_PAIRS} pairs in one change`);
  return data.map((p, i) => {
    if (!p || typeof p.find !== 'string' || !p.find || typeof p.replace !== 'string') {
      throw new Error(`pair ${i + 1} needs "find" (not empty) and "replace" (text, may be empty)`);
    }
    return { find: p.find, replace: p.replace, matchCase: p.match_case === true || p.matchCase === true };
  });
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { id, mode: 'pairs'|'section', ... }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        find: { type: 'string' }, replace: { type: 'string' }, 'match-case': { type: 'boolean' }, pairs: { type: 'string' },
        section: { type: 'string' }, with: { type: 'string' }, text: { type: 'string' }, tab: { type: 'string' },
        mission: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
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
  const modes = [values.find !== undefined || values.replace !== undefined, values.pairs !== undefined, values.section !== undefined].filter(Boolean).length;
  if (modes !== 1) return { error: 'do one thing: --find with --replace, or --pairs, or --section' };

  if (values.section !== undefined) {
    if (!values.section.trim()) return { error: '--section needs the heading text' };
    const problem = sourceProblem({ from: values.with, text: values.text, mission: values.mission });
    if (problem) return { error: problem.replace('--from', '--with') };
    return { id, mode: 'section', heading: values.section, from: values.with, text: values.text, mission: values.mission, tab: values.tab, json };
  }
  if (values.tab !== undefined || values.with !== undefined || values.text !== undefined) return { error: '--tab, --with and --text go with --section' };
  if (values.pairs !== undefined) {
    if (values.mission === undefined) return { error: '--pairs needs --mission <mission id>: a relative path starts from the mission tree' };
    return { id, mode: 'pairs', pairsFile: values.pairs, mission: values.mission, json };
  }
  if (!values.find) return { error: '--find needs the text to find, exactly as it is in the document (docs-get --format text shows it)' };
  if (values.replace === undefined) return { error: '--replace is required (an empty --replace "" removes the text)' };
  return { id, mode: 'pairs', pairs: [{ find: values.find, replace: values.replace, matchCase: values['match-case'] === true }], json };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, contracts, paths
 * @param {object} [deps.docs]    from createDocsClient()
 * @returns {Promise<number>} 0, 1 when Google or a rule refused (or nothing matched), 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`docs-replace: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const needsFiles = args.pairsFile !== undefined || args.from !== undefined;
    const runtime = deps.runtime || (needsFiles || !deps.docs ? createCliRuntime({ stderr }) : null);
    const docs = deps.docs || createDocsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });

    if (args.mode === 'section') {
      const source = readSource(args, { runtime, extensions: TEXT_EXTENSIONS, kind: 'Markdown or text' });
      const result = await docs.replaceSection(args.id, { heading: args.heading, markdown: source.text, tab: args.tab });
      const link = result.file.webViewLink || `https://docs.google.com/document/d/${args.id}/edit`;
      if (args.json) {
        stdout.write(`${JSON.stringify({ id: args.id, link, heading: result.section.headingText, removed_chars: result.removedChars, paragraphs: result.paragraphs }, null, 2)}\n`);
        return 0;
      }
      stdout.write([
        `Rewrote the section "${result.section.headingText}" of "${result.file.name}": removed ${result.removedChars} characters, wrote ${result.paragraphs} paragraph${result.paragraphs === 1 ? '' : 's'}.`,
        'The heading and the rest of the document are unchanged. Read it back with docs-get to check.',
        `link: ${link}`,
        '',
      ].join('\n'));
      return 0;
    }

    let pairs = args.pairs;
    if (args.pairsFile !== undefined) {
      const file = localFile(args.pairsFile, { mission: args.mission, paths: runtime.paths, maxBytes: 1024 * 1024 });
      try {
        pairs = parsePairs(file.bytes.toString('utf8'));
      } catch (err) {
        return fail(`${file.path}: ${err.message}`, 2);
      }
    }
    const { file, results } = await docs.replaceText(args.id, pairs);
    const changed = results.reduce((n, r) => n + r.occurrences, 0);
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: args.id, title: file.name, changed, results }, null, 2)}\n`);
      return changed ? 0 : 1;
    }
    const lines = [
      changed ? `Changed "${file.name}": ${changed} replacement${changed === 1 ? '' : 's'}.` : `Nothing in "${file.name}" matched, so nothing changed.`,
      ...results.map((r) => `- ${JSON.stringify(r.find)} -> ${JSON.stringify(r.replace)}: ${r.occurrences ? `${r.occurrences} replaced` : 'not found'}`),
    ];
    if (results.some((r) => !r.occurrences)) lines.push(`Text not found is not in the document as written: copy it exactly from docs-get ${args.id} --format text, then try those again.`);
    stdout.write(`${lines.join('\n')}\n`);
    return changed ? 0 : 1;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
