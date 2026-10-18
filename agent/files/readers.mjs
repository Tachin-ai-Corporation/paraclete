// agent/files/readers.mjs: a file's content as text or Markdown, for the agent to read. PDF through
// poppler (pdftotext -layout, pdfinfo for the page count), Word and OpenDocument text through pandoc
// (.doc and .rtf through LibreOffice first), HTML through pandoc, spreadsheets as tables
// (sheets.mjs), presentations slide by slide (slides.mjs), and text formats as they are. An image has
// no text: its type and size are reported, with the route to look at it. A page, sheet or slide
// selection narrows what is read, the result is cut at a character cap, and every cut and every
// approximation is said in `notes`. Used by the files skill's file-read.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { detectFormat, IMAGE_FORMATS, labelOf } from './formats.mjs';
import { imageSize } from './images.mjs';
import { readSheets, rowsAsCsv, rowsAsMarkdown, selectSheet } from './sheets.mjs';
import { readSlides, renderSlide } from './slides.mjs';
import { listZipEntries } from './zip.mjs';

/** The default cap on what file-read prints, under the shell tool's own output cap. */
export const DEFAULT_MAX_CHARS = 40_000;

const SHEET_FORMATS = new Set(['xlsx', 'xls', 'ods', 'csv', 'tsv']);
const SLIDE_FORMATS = new Set(['pptx', 'ppt', 'odp']);
const ZIP_LIST_LIMIT = 200;

/** A request file-read cannot serve as asked: the agent's arguments, not the file, are at fault. */
export class ReadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadRequestError';
  }
}

/**
 * The numbers a selection names: `3`, `1-3`, `2,4,7-9`, `5-` (to the end). Sorted, without repeats.
 *
 * @param {string} spec
 * @param {number} count how many there are
 * @param {string} what  'page', 'slide'
 * @returns {number[]}
 * @throws {ReadRequestError}
 */
export function parseSelection(spec, count, what) {
  const out = new Set();
  for (const part of String(spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(part);
    if (!m) throw new ReadRequestError(`'${part}' is not a ${what} selection: use numbers and ranges, like 1-3,5`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : (m[2] === '' ? count : Number(m[2]));
    if (from < 1 || to < from) throw new ReadRequestError(`'${part}' is not a ${what} range: it counts from 1, low to high`);
    if (from > count) throw new ReadRequestError(`${what} ${from} does not exist: there ${count === 1 ? 'is' : 'are'} ${count} ${what}${count === 1 ? '' : 's'}`);
    for (let n = from; n <= Math.min(to, count); n++) out.add(n);
  }
  if (out.size === 0) throw new ReadRequestError(`no ${what}s selected`);
  return [...out].sort((a, b) => a - b);
}

/** Runs of consecutive numbers: [1,2,3,5] -> [[1,3],[5,5]]. */
export function toRanges(numbers) {
  const ranges = [];
  for (const n of numbers) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

/** Describes a selection briefly: [1,2,3,5] -> '1-3, 5'. */
export function describeSelection(numbers) {
  return toRanges(numbers).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/** The page count pdfinfo reports. */
export async function pdfPageCount(runner, path) {
  const { stdout } = await runner.check('pdfinfo', [path]);
  const m = /^Pages:\s+(\d+)/m.exec(stdout.toString('utf8'));
  if (!m) throw new Error(`pdfinfo did not report a page count for ${basename(path)}`);
  return Number(m[1]);
}

/**
 * A PDF's text, page by page, from its text layer.
 *
 * @param {object} runner
 * @param {string} path
 * @param {number[]} pages 1-based
 * @param {{layout?: boolean}} [opts] layout: keep the columns with spaces (pdftotext -layout)
 * @returns {Promise<Array<{page: number, text: string}>>}
 */
export async function pdfPages(runner, path, pages, { layout = true } = {}) {
  const out = [];
  for (const [first, last] of toRanges(pages)) {
    const args = [...(layout ? ['-layout'] : []), '-enc', 'UTF-8', '-f', first, '-l', last, path, '-'];
    const { stdout } = await runner.check('pdftotext', args);
    // pdftotext ends every page with a form feed.
    const texts = stdout.toString('utf8').split('\f');
    for (let n = first; n <= last; n++) out.push({ page: n, text: (texts[n - first] || '').replace(/\s+$/, '') });
  }
  return out;
}

async function readPdf(path, opts, runner) {
  const count = await pdfPageCount(runner, path);
  const pages = opts.pages ? parseSelection(opts.pages, count, 'page') : Array.from({ length: count }, (_, i) => i + 1);
  const texts = await pdfPages(runner, path, pages);
  const notes = ['Text from the PDF\'s text layer: columns are kept with spaces; images and charts are not read, and tables come out as aligned text.'];
  if (texts.every((p) => !p.text.trim())) {
    notes.push('These pages have no text layer: they are probably scanned images. Render them with `file-convert <pdf> png --pages <n>` and look at the PNGs with the viewImage tool.');
  }
  const text = texts.map((p) => (opts.format === 'md' ? `<!-- page ${p.page} -->\n${p.text}` : `--- page ${p.page} ---\n${p.text}`)).join('\n\n');
  const shown = opts.pages ? `; pages ${describeSelection(pages)}` : '';
  return { header: `PDF, ${count} page${count === 1 ? '' : 's'}${shown}`, text, notes };
}

async function pandocText(runner, path, from, format) {
  const to = format === 'md' ? 'gfm' : 'plain';
  const { stdout } = await runner.check('pandoc', ['--from', from, '--to', to, '--wrap=none', path]);
  return stdout.toString('utf8').trim();
}

async function readWord(path, format, opts, runner) {
  const notes = ['Images in the document are not included; tracked changes are shown accepted.'];
  if (format === 'docx' || format === 'odt') {
    return { header: labelOf(format), text: await pandocText(runner, path, format, opts.format), notes };
  }
  const text = await runner.withTempDir(async (dir) => pandocText(runner, await runner.sofficeConvert(path, 'docx', dir), 'docx', opts.format));
  return { header: `${labelOf(format)} (read through LibreOffice)`, text, notes };
}

async function readSpreadsheet(path, format, opts, runner) {
  const sheets = await readSheets(path, format, { runner });
  const chosen = opts.sheet ? [selectSheet(sheets, opts.sheet)] : sheets;
  const notes = [];
  if (format !== 'csv' && format !== 'tsv') {
    notes.push('Cells show values as last calculated and saved; a formula a program never calculated shows empty.');
  }
  const parts = chosen.map((s) => {
    const label = `Sheet: ${s.name}${s.hidden ? ' (hidden)' : ''}`;
    if (s.more) notes.push(`Sheet '${s.name}' has more rows than the ${s.rows.length} read; convert it to CSV (\`file-convert <file> csv\`) to work on all of them.`);
    return opts.format === 'md' ? `## ${label}\n\n${rowsAsMarkdown(s.rows)}` : `# ${label}\n${rowsAsCsv(s.rows).trimEnd()}`;
  });
  const names = sheets.map((s, i) => `${i + 1} '${s.name}'`).join(', ');
  const header = `${labelOf(format)}, ${sheets.length} sheet${sheets.length === 1 ? '' : 's'} (${names})${opts.sheet ? `; sheet '${chosen[0].name}'` : ''}`;
  return { header, text: parts.join('\n\n'), notes };
}

async function readPresentation(path, format, opts, runner) {
  const slides = await readSlides(path, format, { runner });
  const numbers = opts.slides ? parseSelection(opts.slides, slides.length, 'slide') : slides.map((s) => s.number);
  const chosen = slides.filter((s) => numbers.includes(s.number));
  const shown = opts.slides ? `; slides ${describeSelection(numbers)}` : '';
  return {
    header: `${labelOf(format)}, ${slides.length} slide${slides.length === 1 ? '' : 's'}${shown}`,
    text: chosen.map((s) => renderSlide(s, opts.format)).join('\n\n'),
    notes: ['Slide text only: layout, styling and the pictures themselves are not read. To see a slide, render it with `file-convert <file> png` and look at the PNG with the viewImage tool.'],
  };
}

function readImage(path, format) {
  const size = imageSize(path, format);
  const dims = size ? `${size.width} x ${size.height} pixels` : 'size unknown';
  const viewable = ['png', 'jpg', 'webp'].includes(format);
  const route = viewable
    ? 'Look at it with the viewImage tool, which shows you the image as pixels.'
    : 'Convert it to PNG (`file-convert <file> png`), then look at the PNG with the viewImage tool.';
  return { header: `${labelOf(format)}, ${dims}`, text: `An image has no text to read. ${route}`, notes: [] };
}

function readZip(path) {
  const entries = listZipEntries(path).filter((e) => !e.name.endsWith('/'));
  const lines = entries.slice(0, ZIP_LIST_LIMIT).map((e) => `${e.name} (${e.size} bytes)`);
  const notes = ['Extract it with `python3 -m zipfile -e <zip> <directory>`, then read the files inside.'];
  if (entries.length > ZIP_LIST_LIMIT) notes.push(`Only the first ${ZIP_LIST_LIMIT} of ${entries.length} entries are listed.`);
  return { header: `ZIP archive, ${entries.length} file${entries.length === 1 ? '' : 's'}`, text: lines.join('\n'), notes };
}

/**
 * Reads a file as text or Markdown.
 *
 * @param {string} path
 * @param {object} o
 * @param {object} o.runner          runner.mjs's
 * @param {'md'|'text'} [o.format]   default md
 * @param {string} [o.pages]         a PDF's pages, like 1-3,5
 * @param {string} [o.sheet]         a spreadsheet's sheet, by name or number
 * @param {string} [o.slides]        a presentation's slides, like 2,4
 * @param {number} [o.max]           the most characters returned
 * @returns {Promise<{name: string, format: string|null, header: string, text: string, notes: string[]}>}
 *   header: one line saying what the file is and what was selected
 * @throws {ReadRequestError} for a selection the file cannot have; Error or ToolError otherwise
 */
export async function readDocument(path, { runner, format = 'md', pages, sheet, slides, max = DEFAULT_MAX_CHARS }) {
  if (!statSync(path).isFile()) throw new ReadRequestError(`${path} is not a file`);
  const detected = await detectFormat(path, { runner });
  const kind = detected.format;
  const opts = { format, pages, sheet, slides };
  const misplaced = (flag, applies) => new ReadRequestError(`${flag} applies to ${applies}; ${basename(path)} is ${detected.label}`);
  if (pages && kind !== 'pdf') throw misplaced('--pages', 'a PDF');
  if (sheet && !SHEET_FORMATS.has(kind)) throw misplaced('--sheet', 'a spreadsheet');
  if (slides && !SLIDE_FORMATS.has(kind)) throw misplaced('--slides', 'a presentation');

  let result;
  if (kind === 'pdf') result = await readPdf(path, opts, runner);
  else if (['docx', 'odt', 'doc', 'rtf'].includes(kind)) result = await readWord(path, kind, opts, runner);
  else if (kind === 'html') {
    result = { header: labelOf(kind), text: await pandocText(runner, path, 'html', format), notes: ['Scripts, styles and images are left out.'] };
  } else if (SHEET_FORMATS.has(kind)) result = await readSpreadsheet(path, kind, opts, runner);
  else if (SLIDE_FORMATS.has(kind)) result = await readPresentation(path, kind, opts, runner);
  else if (IMAGE_FORMATS.includes(kind)) result = readImage(path, kind);
  else if (kind === 'zip') result = readZip(path);
  else if (['md', 'txt', 'json'].includes(kind)) result = { header: labelOf(kind), text: readFileSync(path, 'utf8'), notes: [] };
  else throw new Error(`cannot read ${basename(path)}: it is ${detected.label}, not a format the files skill reads`);

  const notes = [...result.notes];
  let text = result.text;
  if (text.length > max) {
    const narrower = { pdf: '--pages', xlsx: '--sheet', xls: '--sheet', ods: '--sheet', pptx: '--slides', ppt: '--slides', odp: '--slides' }[kind];
    notes.unshift(`Cut at ${max} of ${text.length} characters: read the rest ${narrower ? `with ${narrower} or ` : ''}with a larger --max${['md', 'txt', 'json', 'csv', 'tsv'].includes(kind) ? ', or a line range with the readFile tool' : ''}.`);
    text = text.slice(0, max);
  }
  return { name: basename(path), format: kind, header: result.header, text, notes };
}
