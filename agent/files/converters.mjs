// agent/files/converters.mjs: converting a file from one format to another with the VM's toolchain,
// and merging PDFs. CONVERSIONS is the whole table of what converts to what; anything else is refused
// with the conversions that exist. LibreOffice renders office files to PDF and between office formats,
// pandoc moves between Word, HTML, Markdown and text, Chromium prints HTML and Markdown to PDF and
// screenshots HTML, poppler renders PDF pages to PNG and reads PDF text, qpdf merges and extracts PDF
// pages, ImageMagick converts and resizes images, and openpyxl writes and reads workbooks (sheets.mjs).
// Each conversion works in a scratch directory and moves only finished files into place, so a failed
// one leaves nothing half-written. What a conversion loses is said in its notes. Used by the files
// skill's file-convert.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatCsv, parseCsv } from './csv.mjs';
import { detectFormat, IMAGE_FORMATS, labelOf, normalizeFormat } from './formats.mjs';
import { escapeHtml, htmlPage, markdownPage, printPdf, screenshot, writePage } from './html-print.mjs';
import { imageSize } from './images.mjs';
import { describeSelection, parseSelection, pdfPageCount, pdfPages, toRanges } from './readers.mjs';
import { readSheets, rowsAsCsv, selectSheet, typedCell, writeWorkbook } from './sheets.mjs';

/** What each format converts to. */
export const CONVERSIONS = Object.freeze({
  docx: ['pdf', 'html', 'md', 'txt', 'png'],
  doc: ['docx', 'pdf', 'html', 'md', 'txt', 'png'],
  odt: ['docx', 'pdf', 'html', 'md', 'txt', 'png'],
  rtf: ['docx', 'pdf', 'html', 'md', 'txt', 'png'],
  html: ['docx', 'pdf', 'png', 'md', 'txt'],
  md: ['docx', 'pdf', 'html', 'txt', 'pptx', 'png'],
  xlsx: ['csv', 'pdf', 'png'],
  xls: ['xlsx', 'csv', 'pdf', 'png'],
  ods: ['xlsx', 'csv', 'pdf', 'png'],
  csv: ['xlsx', 'pdf'],
  tsv: ['xlsx', 'csv'],
  pptx: ['pdf', 'png'],
  ppt: ['pptx', 'pdf', 'png'],
  odp: ['pptx', 'pdf', 'png'],
  pdf: ['pdf', 'md', 'txt', 'docx', 'png'],
  png: ['png', 'jpg', 'webp', 'pdf'],
  jpg: ['jpg', 'png', 'webp', 'pdf'],
  gif: ['png', 'jpg', 'webp', 'pdf'],
  webp: ['webp', 'png', 'jpg', 'pdf'],
  svg: ['png', 'jpg', 'webp', 'pdf'],
  bmp: ['png', 'jpg', 'webp', 'pdf'],
  tiff: ['png', 'jpg', 'webp', 'pdf'],
});

const OFFICE = new Set(['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp']);
const WORKBOOKS = new Set(['xlsx', 'xls', 'ods']);
const RASTER = new Set(['png', 'jpg', 'webp']);
/** The resolution PDF pages and slides render at: legible, and well inside what viewImage takes. */
const PAGE_DPI = 150;

/** A conversion that cannot be done as asked. The message lists what can be. */
export class ConversionRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversionRefused';
  }
}

/** The conversion table as lines: `docx -> pdf, html, md, txt, png`. */
export function conversionTable() {
  return Object.entries(CONVERSIONS).map(([from, to]) => `${from} -> ${to.join(', ')}`).join('\n');
}

function stemOf(path) {
  return basename(path, extname(path));
}

/** Moves a finished file into place, across file systems if need be. */
function moveInto(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
  return to;
}

/**
 * Text broken into paragraphs: blank lines separate them, wrapped lines are joined, a word hyphenated
 * across lines is mended, and a line that starts a list item starts a new paragraph. Pure.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function reflow(text) {
  const out = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    let current = '';
    for (const raw of block.split('\n')) {
      const line = raw.trim().replace(/\s{2,}/g, ' ');
      if (!line) continue;
      if (current && /^([•◦▪●‣\-*–]|\d{1,3}[.)])\s/.test(line)) {
        out.push(current);
        current = line;
      } else if (current && /[A-Za-z]-$/.test(current) && /^[a-z]/.test(line)) {
        current = current.slice(0, -1) + line;
      } else {
        current = current ? `${current} ${line}` : line;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/** The file a single-output conversion writes, from --out or next to the source. */
function singleTarget(src, to, { out, cwd, defaultName }) {
  if (out) {
    const target = resolve(cwd, out);
    if (/[\\/]$/.test(out) || (existsSync(target) && statSync(target).isDirectory())) return join(target, defaultName);
    const ext = extname(target);
    if (!ext) return `${target}.${to}`;
    if (normalizeFormat(ext) !== to) throw new ConversionRefused(`--out ${out} ends in ${ext}, but the conversion makes ${to}`);
    return target;
  }
  return join(dirname(src), defaultName);
}

/** The directory and name stem a many-output conversion writes into: --out as a directory, or as a file name whose stem is kept. */
function manyTarget(src, to, { out, cwd }) {
  if (!out) return { dir: dirname(src), stem: stemOf(src) };
  const target = resolve(cwd, out);
  if (/[\\/]$/.test(out) || (existsSync(target) && statSync(target).isDirectory()) || !extname(target)) return { dir: target, stem: stemOf(src) };
  if (normalizeFormat(extname(target)) !== to) throw new ConversionRefused(`--out ${out} ends in ${extname(target)}, but the conversion makes ${to}`);
  return { dir: dirname(target), stem: stemOf(target) };
}

async function pdfOf(ctx) {
  const { src, from, work, runner } = ctx;
  if (from === 'pdf') return src;
  if (OFFICE.has(from)) {
    ctx.notes.push('Rendered by LibreOffice: fonts missing on this host are substituted, so line breaks and layout can shift a little.');
    return runner.sofficeConvert(src, 'pdf', work);
  }
  const pdf = join(work, `${stemOf(src)}.pdf`);
  if (from === 'md') return printPdf(runner, writePage(work, await markdownPage(runner, src)), pdf);
  if (from === 'html') return printPdf(runner, src, pdf);
  if (IMAGE_FORMATS.includes(from)) {
    const size = imageSize(src, from);
    const page = size ? `${size.width}px ${size.height}px` : 'auto';
    const css = `@page { size: ${page}; margin: 0; } html, body { margin: 0; } img { display: block; width: 100%; }`;
    const body = `<img src="${escapeHtml(pathToFileURL(resolve(src)).href)}" alt="">`;
    return printPdf(runner, writePage(work, htmlPage({ body, title: basename(src), css })), pdf);
  }
  throw new ConversionRefused(`${labelOf(from)} does not convert to PDF`);
}

/** A PDF's pages as PNG files named <stem>-<page>.png in a scratch directory. */
async function pagesAsPng(ctx, pdf) {
  const { runner, work, pages, maxSide } = ctx;
  const count = await pdfPageCount(runner, pdf);
  const wanted = pages ? parseSelection(pages, count, ctx.from === 'pptx' || ctx.from === 'ppt' || ctx.from === 'odp' ? 'slide' : 'page') : Array.from({ length: count }, (_, i) => i + 1);
  const dir = join(work, 'pages');
  mkdirSync(dir, { recursive: true });
  const scale = maxSide ? ['-scale-to', maxSide] : ['-r', PAGE_DPI];
  for (const [first, last] of toRanges(wanted)) {
    await runner.check('pdftoppm', ['-png', ...scale, '-f', first, '-l', last, pdf, join(dir, 'page')]);
  }
  const produced = readdirSync(dir)
    .map((name) => ({ name, page: Number(/-(\d+)\.png$/.exec(name)?.[1]) }))
    .filter((p) => Number.isInteger(p.page))
    .sort((a, b) => a.page - b.page);
  if (produced.length === 0) throw new Error('pdftoppm rendered no pages');
  return produced.map((p) => ({ path: join(dir, p.name), name: `${stemOf(ctx.src)}-${p.page}.png` }));
}

async function pandocTo(ctx, from, to, input, outPath) {
  await ctx.runner.check('pandoc', ['--from', from, '--to', to, '--wrap=none', `--resource-path=${dirname(resolve(ctx.src))}`, '--output', outPath, input]);
  return outPath;
}

/** A Word, OpenDocument or Rich Text file as something pandoc reads: .docx and .odt as they are, the rest through LibreOffice. */
async function pandocReadable(ctx) {
  const { src, from, work, runner } = ctx;
  if (from === 'docx' || from === 'odt' || from === 'html' || from === 'md') return { input: src, reader: from === 'md' ? 'gfm' : from };
  return { input: await runner.sofficeConvert(src, 'docx', join(work, 'docx')), reader: 'docx' };
}

async function pdfText(ctx, layout) {
  const count = await pdfPageCount(ctx.runner, ctx.src);
  const pages = ctx.pages ? parseSelection(ctx.pages, count, 'page') : Array.from({ length: count }, (_, i) => i + 1);
  ctx.notes.push('A text-level rebuild from the PDF\'s text layer: layout, images, tables and fonts are not kept.');
  const texts = await pdfPages(ctx.runner, ctx.src, pages, { layout });
  if (texts.every((p) => !p.text.trim())) ctx.notes.push('The pages have no text layer (probably scanned images), so the result is empty.');
  return texts;
}

async function toDocument(ctx, to) {
  const { src, from, work, runner, notes } = ctx;
  const outPath = join(work, `${stemOf(src)}.${to}`);
  if (from === 'pdf') {
    const texts = await pdfText(ctx, to === 'txt');
    if (to === 'txt') {
      writeFileSync(outPath, `${texts.map((p) => p.text).join('\n\f')}\n`);
    } else if (to === 'md') {
      writeFileSync(outPath, `${texts.map((p) => `<!-- page ${p.page} -->\n\n${reflow(p.text).join('\n\n')}`).join('\n\n')}\n`);
    } else {
      const body = texts.map((p) => reflow(p.text).map((par) => `<p>${escapeHtml(par)}</p>`).join('\n')).join('\n<hr>\n');
      const page = join(work, 'rebuild.html');
      writeFileSync(page, htmlPage({ body, title: stemOf(src) }));
      await pandocTo(ctx, 'html', 'docx', page, outPath);
    }
    return outPath;
  }
  if (to === 'docx' && ['doc', 'odt', 'rtf'].includes(from)) return runner.sofficeConvert(src, 'docx', work);
  if (to === 'html' && from === 'md') {
    writeFileSync(outPath, await markdownPage(runner, src));
    return outPath;
  }
  const { input, reader } = await pandocReadable(ctx);
  if (to === 'html') {
    const { stdout } = await runner.check('pandoc', ['--from', reader, '--to', 'html5', '--wrap=none', input]);
    writeFileSync(outPath, htmlPage({ body: stdout.toString('utf8'), title: stemOf(src) }));
    notes.push('Images in the document are not carried over.');
    return outPath;
  }
  const writer = { docx: 'docx', md: 'gfm', txt: 'plain', pptx: 'pptx' }[to];
  if (from !== 'md' && from !== 'html' && to !== 'docx') notes.push('Images, headers, footers and comments are not carried over.');
  if (to === 'pptx') notes.push('Each top heading starts a slide; the design is pandoc\'s plain default.');
  return pandocTo(ctx, reader, writer, input, outPath);
}

async function toWorkbook(ctx) {
  const { src, from, work, runner, notes } = ctx;
  if (from === 'xls' || from === 'ods') return runner.sofficeConvert(src, 'xlsx', work);
  const rows = parseCsv(readFileSync(src, 'utf8'), from === 'tsv' ? { delimiter: '\t' } : {});
  notes.push('Plain numbers became numbers; everything else is text. The first row is the header, in bold.');
  return writeWorkbook(runner, [{ name: stemOf(src), rows: rows.map((r) => r.map(typedCell)) }], join(work, `${stemOf(src)}.xlsx`));
}

async function toCsv(ctx) {
  const { src, from, work, runner, sheet, notes } = ctx;
  if (from === 'tsv') {
    const out = join(work, `${stemOf(src)}.csv`);
    writeFileSync(out, formatCsv(parseCsv(readFileSync(src, 'utf8'), { delimiter: '\t' })));
    return [{ path: out, name: `${stemOf(src)}.csv` }];
  }
  const sheets = await readSheets(src, from, { runner, maxRows: 0 });
  const chosen = sheet ? [selectSheet(sheets, sheet)] : sheets;
  notes.push('Values only: formulas, formatting and charts are not carried over.');
  if (!sheet && sheets.length > 1) notes.push(`One CSV file per sheet (${sheets.length} sheets); --sheet picks one.`);
  return chosen.map((s, i) => {
    const name = chosen.length === 1 ? `${stemOf(src)}.csv` : `${stemOf(src)}-${s.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.csv`;
    const path = join(work, `${i}-${name}`);
    writeFileSync(path, rowsAsCsv(s.rows));
    return { path, name };
  });
}

async function toImage(ctx, to) {
  const { src, from, work, runner, maxSide, notes } = ctx;
  const out = join(work, `${stemOf(src)}.${to}`);
  const args = [];
  if (from === 'svg') {
    args.push('-density', '150', '-background', 'none');
    notes.push('The SVG was rendered at 150 dpi.');
  }
  // An animated GIF or a multi-page TIFF converts its first frame only.
  const framed = from === 'gif' || from === 'tiff';
  args.push(framed ? `${src}[0]` : src);
  if (framed) notes.push(`Only the first ${from === 'gif' ? 'frame' : 'page'} of the ${from.toUpperCase()} was converted.`);
  if (maxSide) args.push('-resize', `${maxSide}x${maxSide}>`);
  if (to === 'jpg') {
    args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-quality', '90');
    notes.push('JPEG has no transparency: transparent areas became white.');
  }
  args.push(out);
  await runner.check('convert', args);
  return out;
}

/**
 * Converts a file.
 *
 * @param {string} input
 * @param {string} target a format id or alias (pdf, docx, md, png...)
 * @param {object} o
 * @param {object} o.runner        runner.mjs's
 * @param {string} [o.out]         output file, or directory for conversions that make several files
 * @param {string} [o.pages]       PDF pages (or rendered pages and slides, to PNG), like 1-3,5
 * @param {string} [o.sheet]       one sheet of a workbook, to CSV
 * @param {number} [o.maxSide]     longest side in pixels, for PNG, JPEG and WebP output
 * @param {{width: number, height: number}} [o.size] window size of an HTML screenshot
 * @param {string} [o.cwd]
 * @returns {Promise<{from: string, to: string, outputs: string[], notes: string[]}>}
 * @throws {ConversionRefused} for a conversion that does not exist or options that do not apply
 */
export async function convertFile(input, target, { runner, out, pages, sheet, maxSide, size, cwd = process.cwd() }) {
  const src = resolve(cwd, input);
  if (!existsSync(src) || !statSync(src).isFile()) throw new ConversionRefused(`${input} is not a file`);
  const detected = await detectFormat(src, { runner });
  const from = detected.format;
  const targets = CONVERSIONS[from];
  if (!targets) throw new ConversionRefused(`cannot convert ${basename(src)}: it is ${detected.label}. The conversions there are:\n${conversionTable()}`);
  const to = normalizeFormat(target);
  if (!to || !targets.includes(to)) {
    throw new ConversionRefused(`cannot convert ${labelOf(from)} (${basename(src)}) to ${target}. ${labelOf(from)} converts to: ${targets.join(', ')}.`);
  }
  if (to === from && from === 'pdf' && !pages) throw new ConversionRefused(`${basename(src)} is already a PDF: give --pages to extract pages from it`);
  if (to === from && RASTER.has(from) && !maxSide) throw new ConversionRefused(`${basename(src)} is already ${to}: give --max-side to make a smaller copy`);
  // A document, workbook, presentation or PDF becomes one PNG per page or slide.
  const many = to === 'png' && !IMAGE_FORMATS.includes(from) && from !== 'html';
  const csvMany = to === 'csv' && WORKBOOKS.has(from);
  if (pages && from !== 'pdf' && !many) throw new ConversionRefused('--pages applies to a PDF, or to the pages or slides rendered to PNG');
  if (sheet && !csvMany) throw new ConversionRefused('--sheet applies when converting a workbook to CSV');
  if (maxSide && !RASTER.has(to)) throw new ConversionRefused('--max-side applies to PNG, JPEG and WebP output');
  if (size && !(from === 'html' && to === 'png')) throw new ConversionRefused('--size applies to an HTML screenshot (html to png)');

  let defaultName = `${stemOf(src)}.${to}`;
  if (to === from && from === 'pdf') defaultName = `${stemOf(src)}-pages-${pages.replace(/[^0-9-]+/g, '_')}.pdf`;
  if (to === from && RASTER.has(from)) defaultName = `${stemOf(src)}-${maxSide}px.${to}`;
  // Where the result goes is settled before any work, so a bad --out costs nothing.
  const place = many || csvMany ? manyTarget(src, to, { out, cwd }) : singleTarget(src, to, { out, cwd, defaultName });
  if (!many && !csvMany && resolve(place) === src) throw new ConversionRefused('the output would overwrite the source file: give another --out');

  return runner.withTempDir(async (work) => {
    const ctx = { src, from, work, runner, pages, sheet, maxSide, notes: [] };
    let produced;
    if (many) produced = await pagesAsPng(ctx, await pdfOf(ctx));
    else if (csvMany) produced = await toCsv(ctx);
    else {
      let file;
      if (to === 'pdf' && from === 'pdf') {
        const count = await pdfPageCount(runner, src);
        const wanted = parseSelection(pages, count, 'page');
        file = join(work, 'extract.pdf');
        await runner.check('qpdf', ['--empty', '--pages', src, toRanges(wanted).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(','), '--', file]);
        ctx.notes.push(`Pages ${describeSelection(wanted)} of ${count}.`);
      } else if (to === 'pdf') file = await pdfOf(ctx);
      else if (to === 'png' && from === 'html') {
        file = await screenshot(runner, src, join(work, `${stemOf(src)}.png`), size || {});
        ctx.notes.push(`A screenshot of the page's first ${size?.width || 1280} x ${size?.height || 1600} pixels; --size WxH changes it.`);
      } else if (RASTER.has(to)) file = await toImage(ctx, to);
      else if (to === 'xlsx') file = await toWorkbook(ctx);
      else if (to === 'csv') file = (await toCsv(ctx))[0].path;
      else if (to === 'pptx' && (from === 'ppt' || from === 'odp')) file = await runner.sofficeConvert(src, 'pptx', work);
      else file = await toDocument(ctx, to);
      produced = [{ path: file, name: basename(place) }];
    }
    const outputs = (many || csvMany)
      ? produced.map((p) => moveInto(p.path, join(place.dir, p.name.replace(stemOf(src), place.stem))))
      : [moveInto(produced[0].path, place)];
    return { from, to, outputs, notes: ctx.notes };
  });
}

/**
 * Merges PDFs, in the order given, into one.
 *
 * @param {string[]} inputs
 * @param {object} o
 * @param {object} o.runner
 * @param {string} [o.out] default: merged.pdf next to the first input
 * @param {string} [o.cwd]
 * @returns {Promise<{from: string, to: string, outputs: string[], notes: string[]}>}
 */
export async function mergePdfs(inputs, { runner, out, cwd = process.cwd() }) {
  if (!Array.isArray(inputs) || inputs.length < 2) throw new ConversionRefused('--merge needs at least two PDFs');
  const sources = inputs.map((p) => resolve(cwd, p));
  for (const [i, src] of sources.entries()) {
    if (!existsSync(src) || !statSync(src).isFile()) throw new ConversionRefused(`${inputs[i]} is not a file`);
    const { format, label } = await detectFormat(src, { runner });
    if (format !== 'pdf') throw new ConversionRefused(`${inputs[i]} is ${label}, not a PDF: convert it to PDF first`);
  }
  const target = singleTarget(sources[0], 'pdf', { out, cwd, defaultName: 'merged.pdf' });
  if (sources.includes(resolve(target))) throw new ConversionRefused('the merged PDF would overwrite one of its sources: give another --out');
  return runner.withTempDir(async (work) => {
    const file = join(work, 'merged.pdf');
    await runner.check('qpdf', ['--empty', '--pages', ...sources, '--', file]);
    return { from: 'pdf', to: 'pdf', outputs: [moveInto(file, target)], notes: [`${sources.length} PDFs merged in the order given.`] };
  });
}
