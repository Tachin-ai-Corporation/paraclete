#!/usr/bin/env node
// skills/workspace-slides/slides-get.mjs: the slides-get command. Reads a Google Slides presentation as
// text, slide by slide: each slide's number, id and title, its text (bullets indented, tables as rows,
// images and charts named), and its speaker notes. --slides picks some. Read only. The Slides calls are
// agent/providers/workspace-slides.mjs. Documented in skills/workspace-slides/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createSlidesClient, presentationSlides } from '../../agent/providers/workspace-slides.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { parseSelection, describeSelection } from '../../agent/files/readers.mjs';

export const USAGE = 'Usage: slides-get <deck link or id> [--slides <list, e.g. 1-3,5>] [--no-notes] [--json]';

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { id, slides, notes, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: { slides: { type: 'string' }, 'no-notes': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one presentation at a time, got ${positionals.length}` : 'a Google Slides link or id is required' };
  const id = parseDriveLink(positionals[0]);
  if (!id) return { error: `'${positionals[0]}' is not a Google Slides link or id: copy the link from the browser, or the id between /d/ and /edit` };
  if (values.slides !== undefined && !/^[\d\s,-]+$/.test(values.slides)) return { error: '--slides takes numbers and ranges, like 1-3,5' };
  return { id, slides: values.slides, notes: values['no-notes'] !== true, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime()
 * @param {object} [deps.slides]  from createSlidesClient()
 * @returns {Promise<number>} 0, 1 when Google refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`slides-get: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const client = deps.slides || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createSlidesClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const deck = await client.get(args.id);
    const all = presentationSlides(deck);
    let picked = all;
    if (args.slides !== undefined) {
      try {
        const numbers = parseSelection(args.slides, all.length, 'slide');
        picked = all.filter((s) => numbers.includes(s.number));
      } catch (err) {
        return fail(err.message, 2);
      }
    }
    const link = `https://docs.google.com/presentation/d/${deck.presentationId || args.id}/edit`;
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: deck.presentationId || args.id, title: deck.title ?? null, link, slide_count: all.length, slides: picked.map((s) => (args.notes ? s : { ...s, notes: undefined })) }, null, 2)}\n`);
      return 0;
    }
    const lines = [`"${deck.title || '(untitled)'}" | Google Slides | ${all.length} slide${all.length === 1 ? '' : 's'}${args.slides !== undefined ? ` (showing ${describeSelection(picked.map((s) => s.number))})` : ''} | ${link}`];
    for (const s of picked) {
      lines.push('', `Slide ${s.number} (id ${s.id}): ${s.title || '(no title)'}`);
      for (const line of s.lines) lines.push(`  ${line}`);
      if (args.notes && s.notes) lines.push(`  Notes: ${s.notes.replace(/\n/g, '\n         ')}`);
    }
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
