// agent/files/makers.mjs: building a new file from source the agent wrote. Markdown becomes a Word
// document or a PowerPoint deck through pandoc (styled by an optional reference document), or an
// HTML page or a PDF with the default stylesheet (html-print.mjs, printed by Chromium); HTML becomes a
// PDF, a PNG or a Word document; CSV and JSON tables become an Excel workbook (python3 and openpyxl,
// header bold, columns sized); JSON becomes CSV. MAKES is the whole table. The result is built in a
// scratch directory and moved into place only when finished. Converting a file that already exists is
// converters.mjs's. Used by the files skill's file-make.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatCsv, parseCsv } from './csv.mjs';
import { escapeHtml, markdownPage, printPdf, screenshot, writePage } from './html-print.mjs';
import { normalizeFormat } from './formats.mjs';
import { jsonCell, typedCell, writeWorkbook } from './sheets.mjs';

/** What each kind of source makes. */
export const MAKES = Object.freeze({
  md: ['docx', 'pdf', 'html', 'pptx'],
  html: ['pdf', 'png', 'docx'],
  csv: ['xlsx'],
  json: ['xlsx', 'csv'],
});

/** A file that cannot be made as asked. The message says what can be. */
export class MakeRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'MakeRefused';
  }
}

/** The make table as lines: `md -> docx, pdf, html, pptx`. */
export function makeTable() {
  return Object.entries(MAKES).map(([from, to]) => `${from} -> ${to.join(', ')}`).join('\n');
}

/**
 * The tables in JSON data: an array of objects (their keys are the header), an array of arrays (the
 * first is the header), or an object whose values are such arrays (one table per key, named by it).
 * Pure.
 *
 * @param {*} data
 * @returns {Array<{name: string, rows: Array<Array<*>>}>}
 * @throws {MakeRefused} for any other shape
 */
export function jsonTables(data) {
  const table = (items, name) => {
    if (items.every((r) => Array.isArray(r))) return { name, rows: items.map((r) => r.map(jsonCell)) };
    if (items.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      const keys = [];
      for (const item of items) for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k);
      return { name, rows: [keys, ...items.map((item) => keys.map((k) => jsonCell(item[k])))] };
    }
    if (items.every((r) => r === null || typeof r !== 'object')) return { name, rows: [['value'], ...items.map((v) => [jsonCell(v)])] };
    throw new MakeRefused(`the rows of '${name}' mix arrays, objects and plain values: use one kind`);
  };
  if (Array.isArray(data)) return [table(data, 'Sheet1')];
  if (data && typeof data === 'object' && Object.values(data).length > 0 && Object.values(data).every(Array.isArray)) {
    return Object.entries(data).map(([name, items]) => table(items, name));
  }
  throw new MakeRefused('the JSON must be an array of objects, an array of arrays, or an object of such arrays (one sheet each)');
}

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

/** The output path: --out resolved, with the format's extension added when it has none. */
function outputPath(out, format, cwd) {
  if (!out || /[\\/]$/.test(out)) throw new MakeRefused('--out <name> is required: the file to write');
  const target = resolve(cwd, out);
  if (existsSync(target) && statSync(target).isDirectory()) throw new MakeRefused(`--out ${out} is a directory: name the file`);
  const ext = extname(target);
  if (!ext) return `${target}.${format}`;
  if (normalizeFormat(ext) !== format) throw new MakeRefused(`--out ${out} ends in ${ext}, but the file made is ${format}`);
  return target;
}

/** HTML from stdin resolves relative links from the working directory, as a file there would. */
function withBase(html, dir) {
  if (/<base\b/i.test(html)) return html;
  const base = `<base href="${escapeHtml(pathToFileURL(resolve(dir)).href)}/">`;
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (m) => `${m}${base}`) : `${base}\n${html}`;
}

/**
 * Makes a file.
 *
 * @param {object} o
 * @param {string} o.format          what to make: docx, pdf, html, pptx, png, xlsx, csv
 * @param {string} o.from            the source's kind: md, html, csv, json
 * @param {string} [o.sourcePath]    the source as a file (--in)
 * @param {string} [o.source]        the source as text (--stdin), when there is no sourcePath
 * @param {string} o.out             the file to write
 * @param {string} [o.title]         document title (Word, PowerPoint, HTML, PDF) or sheet name (xlsx)
 * @param {string} [o.referenceDoc]  a .docx or .pptx whose styles the output takes
 * @param {object} o.runner          runner.mjs's
 * @param {string} [o.cwd]
 * @returns {Promise<{path: string, notes: string[]}>}
 * @throws {MakeRefused} for a combination that is not in MAKES or options that do not apply
 */
export async function makeFile({ format, from, sourcePath, source, out, title, referenceDoc, runner, cwd = process.cwd() }) {
  const kind = normalizeFormat(from);
  const target = normalizeFormat(format);
  if (!MAKES[kind]) throw new MakeRefused(`--from must be one of ${Object.keys(MAKES).join(', ')}, not '${from}'. What each makes:\n${makeTable()}`);
  if (!target || !MAKES[kind].includes(target)) throw new MakeRefused(`${kind} does not make ${format}. ${kind} makes: ${MAKES[kind].join(', ')}.`);
  const path = outputPath(out, target, cwd);
  let reference = null;
  if (referenceDoc) {
    if (!['docx', 'pptx'].includes(target)) throw new MakeRefused('--reference-doc applies to Word (docx) and PowerPoint (pptx) output');
    reference = resolve(cwd, referenceDoc);
    if (!existsSync(reference)) throw new MakeRefused(`--reference-doc ${referenceDoc} does not exist`);
    if (normalizeFormat(extname(reference)) !== target) throw new MakeRefused(`--reference-doc must be a .${target} for ${target} output`);
  }
  const input = sourcePath ? resolve(cwd, sourcePath) : null;
  if (input && (!existsSync(input) || !statSync(input).isFile())) throw new MakeRefused(`--in ${sourcePath} is not a file`);
  if (!input && typeof source !== 'string') throw new MakeRefused('give the source with --in <path> or --stdin');
  const baseDir = input ? dirname(input) : cwd;
  const text = () => (input ? readFileSync(input, 'utf8') : source);

  return runner.withTempDir(async (work) => {
    const notes = [];
    const built = join(work, `out.${target}`);
    const sourceFile = () => {
      if (input) return input;
      const file = join(work, `source.${kind}`);
      writeFileSync(file, kind === 'html' ? withBase(source, cwd) : source);
      return file;
    };

    if (kind === 'md' && (target === 'docx' || target === 'pptx')) {
      await runner.check('pandoc', [
        '--from', 'gfm', '--to', target, `--resource-path=${baseDir}`,
        ...(title ? ['--metadata', `title=${title}`] : []),
        ...(reference ? [`--reference-doc=${reference}`] : []),
        '--output', built, sourceFile(),
      ]);
      if (target === 'pptx') notes.push('Each top heading starts a slide; a horizontal rule (---) also breaks one.');
    } else if (kind === 'md') {
      const page = await markdownPage(runner, sourceFile(), { title, baseDir });
      if (target === 'html') writeFileSync(built, page);
      else await printPdf(runner, writePage(work, page), built);
    } else if (kind === 'html' && target === 'docx') {
      await runner.check('pandoc', [
        '--from', 'html', '--to', 'docx', `--resource-path=${baseDir}`,
        ...(title ? ['--metadata', `title=${title}`] : []),
        ...(reference ? [`--reference-doc=${reference}`] : []),
        '--output', built, sourceFile(),
      ]);
    } else if (kind === 'html') {
      if (target === 'pdf') await printPdf(runner, sourceFile(), built);
      else {
        await screenshot(runner, sourceFile(), built);
        notes.push('A screenshot of the page\'s first 1280 x 1600 pixels; for another size, convert the HTML file with file-convert --size.');
      }
    } else if (kind === 'csv') {
      const rows = parseCsv(text()).map((r) => r.map(typedCell));
      await writeWorkbook(runner, [{ name: title || basename(path, extname(path)), rows }], built);
      notes.push('Plain numbers became numbers; everything else is text. The first row is the header, in bold.');
    } else {
      let data;
      try {
        data = JSON.parse(text());
      } catch (err) {
        throw new MakeRefused(`the source is not valid JSON: ${err.message}`);
      }
      const tables = jsonTables(data);
      if (target === 'csv') {
        if (tables.length !== 1) throw new MakeRefused(`a CSV file holds one table, and the JSON has ${tables.length}: make an xlsx, or give one table`);
        writeFileSync(built, formatCsv(tables[0].rows));
      } else {
        if (title && tables.length === 1) tables[0].name = title;
        await writeWorkbook(runner, tables, built);
      }
    }
    if (!existsSync(built)) throw new Error(`nothing was written for ${basename(path)}`);
    return { path: moveInto(built, path), notes };
  });
}
