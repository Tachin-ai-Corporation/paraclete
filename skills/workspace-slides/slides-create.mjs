#!/usr/bin/env node
// skills/workspace-slides/slides-create.mjs: the slides-create command. Builds a NEW Google Slides
// presentation from an outline the agent wrote, as JSON or Markdown: a title slide, then one slide per
// entry with its title, bullets (nested), an optional image Google fetches from a public URL, and
// speaker notes. It lands in a folder the agent names, or in the agent's own My Drive. An image Google
// cannot fetch is reported and the rest of the deck is kept. It only ever creates. The Slides and Drive
// calls are agent/providers/workspace-slides.mjs; the content options are the ones docs-create takes
// (skills/workspace-docs/docs-create.mjs). Documented in skills/workspace-slides/SKILL.md.

import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createSlidesClient, MAX_SLIDES } from '../../agent/providers/workspace-slides.mjs';
import { parseDriveLink } from '../../agent/providers/drive.mjs';
import { placeLines, readSource, sourceProblem } from '../workspace-docs/docs-create.mjs';

export const USAGE = 'Usage: slides-create (--from <outline .json or .md> --mission <mission id> | --outline <JSON>) [--title <title>] [--folder <drive folder link or id>] [--json]';

const OUTLINE_EXTENSIONS = new Set(['.json', '.md', '.markdown', '.txt']);
const IMAGE_URL = /^https?:\/\/\S+$/i;
const MAX_NESTING = 4;

/** One bullet from JSON: text, or { text, level }. */
function bullet(b, where) {
  if (typeof b === 'string') return { text: b.trim(), level: 0 };
  if (b && typeof b.text === 'string') {
    const level = b.level ?? 0;
    if (!Number.isInteger(level) || level < 0 || level > MAX_NESTING) throw new Error(`${where}: level is a whole number from 0 to ${MAX_NESTING}`);
    return { text: b.text.trim(), level };
  }
  throw new Error(`${where}: a bullet is text, or { "text": "...", "level": 1 }`);
}

/** Checks a slide entry and returns it in the shape the client takes. */
function slideEntry(s, i) {
  const where = `slide ${i + 1}`;
  if (!s || typeof s !== 'object') throw new Error(`${where} is not an object with a title`);
  if (!Array.isArray(s.bullets ?? [])) throw new Error(`${where}: bullets is a list`);
  const out = { title: String(s.title ?? '').trim(), bullets: (s.bullets || []).map((b, j) => bullet(b, `${where}, bullet ${j + 1}`)).filter((b) => b.text) };
  if (s.image !== undefined && s.image !== null && s.image !== '') {
    if (!IMAGE_URL.test(String(s.image))) throw new Error(`${where}: image must be a public http(s) URL Google can fetch`);
    out.image = String(s.image);
  }
  if (s.notes) out.notes = String(s.notes).trim();
  if (!out.title && !out.bullets.length && !out.image) throw new Error(`${where} is empty: give it a title, bullets or an image`);
  return out;
}

/**
 * An outline from JSON: `{ "title", "subtitle"?, "slides": [{ "title", "bullets"?, "image"?, "notes"? }] }`,
 * a bullet being text or `{ "text", "level" }`. Pure.
 *
 * @param {string} text
 * @returns {{title: string, subtitle?: string, slides: object[]}}
 * @throws {Error} naming the first problem
 */
export function parseJsonOutline(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`the outline is not JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.slides)) throw new Error('the outline is { "title": "...", "slides": [{ "title": "...", "bullets": ["..."] }] }');
  return { title: String(data.title ?? '').trim(), subtitle: data.subtitle ? String(data.subtitle).trim() : undefined, slides: data.slides.map(slideEntry) };
}

/**
 * An outline from Markdown: `# Deck title`, an optional subtitle line under it, then `## Slide title`
 * per slide with `-` bullets (indent two spaces to nest), `![description](https://...)` for its image,
 * and `Notes: ...` lines for its speaker notes. Other lines under a slide become bullets. Pure.
 *
 * @param {string} text
 * @returns {{title: string, subtitle?: string, slides: object[]}}
 */
export function parseMarkdownOutline(text) {
  let title = '';
  let subtitle;
  const slides = [];
  let current = null;
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const h1 = /^#\s+(.*)$/.exec(line);
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h1 && !current) { title = h1[1].trim(); continue; }
    if (h2 || (h1 && current)) { current = { title: (h2 || h1)[1].trim(), bullets: [] }; slides.push(current); continue; }
    if (!current) { if (title && subtitle === undefined) subtitle = line.trim(); continue; }
    const image = /^\s*!\[[^\]]*\]\((\S+?)\)\s*$/.exec(line);
    const notes = /^\s*notes:\s*(.*)$/i.exec(line);
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (image) current.image = image[1];
    else if (notes) current.notes = current.notes ? `${current.notes}\n${notes[1].trim()}` : notes[1].trim();
    else if (item) current.bullets.push({ text: item[2].trim(), level: Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), MAX_NESTING) });
    else current.bullets.push({ text: line.trim(), level: 0 });
  }
  return { title, subtitle, slides: slides.map(slideEntry) };
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { from, text, mission, title, folder, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      options: {
        from: { type: 'string' }, outline: { type: 'string' }, mission: { type: 'string' }, title: { type: 'string' },
        folder: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values } = parsed;
  if (values.help) return { help: true };
  const problem = sourceProblem({ from: values.from, text: values.outline, mission: values.mission });
  if (problem) return { error: problem.replace('--text <content>', '--outline <JSON>').replace('--text', '--outline') };
  if (values.title !== undefined && !values.title.trim()) return { error: '--title is empty' };
  let folder = null;
  if (values.folder !== undefined) {
    folder = parseDriveLink(values.folder);
    if (!folder) return { error: `'${values.folder}' is not a Drive folder link or id` };
  }
  return { from: values.from, text: values.outline, mission: values.mission, title: values.title?.trim(), folder, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, contracts, paths
 * @param {object} [deps.slides]  from createSlidesClient()
 * @returns {Promise<number>} 0; 1 when Google or the disk refused, or an image could not be placed; 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`slides-create: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || (args.from !== undefined || !deps.slides ? createCliRuntime({ stderr }) : null);
    const client = deps.slides || createSlidesClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const source = readSource(args, { runtime, extensions: OUTLINE_EXTENSIONS, kind: 'a JSON or Markdown outline' });
    let outline;
    try {
      outline = args.from === undefined || extname(source.from).toLowerCase() === '.json' ? parseJsonOutline(source.text) : parseMarkdownOutline(source.text);
    } catch (err) {
      return fail(err.message, 2);
    }
    const title = args.title || outline.title;
    if (!title) return fail('the deck needs a title: --title, or the outline\'s title', 2);
    if (!outline.slides.length) return fail('the outline has no slides', 2);
    if (outline.slides.length > MAX_SLIDES) return fail(`an outline may make at most ${MAX_SLIDES} slides; this one has ${outline.slides.length}`, 2);

    const result = await client.create({ title, subtitle: outline.subtitle, slides: outline.slides, folderId: args.folder });
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: result.file.id, name: title, link: result.file.webViewLink, slides: result.slideCount, folder_id: args.folder, image_failures: result.imageFailures }, null, 2)}\n`);
      return result.imageFailures.length ? 1 : 0;
    }
    stdout.write([
      `Created the presentation "${title}": ${result.slideCount} slides (a title slide and ${outline.slides.length} more)`,
      `id: ${result.file.id}`,
      `link: ${result.file.webViewLink}`,
      ...placeLines(args.folder, client.account),
      `Check it with slides-get ${result.file.id} before you hand it over.`,
      '',
    ].join('\n'));
    if (result.imageFailures.length) {
      stderr.write(`slides-create: the deck was made, but ${result.imageFailures.length} image${result.imageFailures.length === 1 ? '' : 's'} could not be placed:\n${result.imageFailures.map((f) => `- slide ${f.slide}: ${f.url}: ${f.reason}`).join('\n')}\nUse an image URL anyone can open (a public https link to a PNG, JPEG or GIF), or say the slide has no image.\n`);
      return 1;
    }
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
