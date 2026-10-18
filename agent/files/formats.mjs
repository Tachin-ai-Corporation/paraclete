// agent/files/formats.mjs: what kind of file a file is. Each format the files skill knows has an id
// (its usual extension: pdf, docx, xlsx...), a MIME type and a plain name. detectFormat() decides from
// the file's first bytes, looking inside a ZIP to tell Word, Excel, PowerPoint and OpenDocument files
// apart, and asks `file --mime-type` only when the bytes leave it open (an old binary Office file, an
// unknown binary). A file's extension decides only between text formats, whose bytes say little, and
// between the old Office formats, which share one container. Used by the readers, converters, makers
// and fetchers in this package.

import { closeSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';
import { listZipEntries, readZipEntry } from './zip.mjs';

/** Every format by id: [MIME type, plain name]. The id is also the extension a new file gets. */
const TABLE = {
  pdf: ['application/pdf', 'PDF'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document'],
  doc: ['application/msword', 'Word 97-2003 document'],
  odt: ['application/vnd.oasis.opendocument.text', 'OpenDocument text'],
  rtf: ['application/rtf', 'Rich Text document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel workbook'],
  xls: ['application/vnd.ms-excel', 'Excel 97-2003 workbook'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet', 'OpenDocument spreadsheet'],
  csv: ['text/csv', 'CSV table'],
  tsv: ['text/tab-separated-values', 'tab-separated table'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint presentation'],
  ppt: ['application/vnd.ms-powerpoint', 'PowerPoint 97-2003 presentation'],
  odp: ['application/vnd.oasis.opendocument.presentation', 'OpenDocument presentation'],
  html: ['text/html', 'HTML page'],
  md: ['text/markdown', 'Markdown'],
  txt: ['text/plain', 'plain text'],
  json: ['application/json', 'JSON'],
  png: ['image/png', 'PNG image'],
  jpg: ['image/jpeg', 'JPEG image'],
  gif: ['image/gif', 'GIF image'],
  webp: ['image/webp', 'WebP image'],
  svg: ['image/svg+xml', 'SVG image'],
  bmp: ['image/bmp', 'BMP image'],
  tiff: ['image/tiff', 'TIFF image'],
  zip: ['application/zip', 'ZIP archive'],
};

/** Every format id. */
export const FORMAT_IDS = Object.freeze(Object.keys(TABLE));

/** The images the toolchain converts between. */
export const IMAGE_FORMATS = Object.freeze(['png', 'jpg', 'gif', 'webp', 'svg', 'bmp', 'tiff']);

/** Other spellings of an extension or a format name. */
const ALIASES = {
  jpeg: 'jpg', htm: 'html', xhtml: 'html', markdown: 'md', text: 'txt', log: 'txt', xlsm: 'xlsx', tif: 'tiff',
};

/** Extensions of files that are plain text to read, though not a format of their own here. */
const TEXT_EXTENSIONS = new Set([
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb',
  'go', 'java', 'kt', 'rs', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'bash', 'sql', 'css', 'scss', 'rst', 'tex',
  'ics', 'vcf', 'srt', 'vtt',
]);

/** Formats whose bytes are text: the extension decides between them. */
const TEXT_FORMATS = new Set(['md', 'txt', 'json', 'csv', 'tsv', 'html', 'svg']);

const MIME_TO_FORMAT = Object.fromEntries(Object.entries(TABLE).map(([id, [mime]]) => [mime, id]));
Object.assign(MIME_TO_FORMAT, {
  'application/x-pdf': 'pdf',
  'text/rtf': 'rtf',
  'application/vnd.ms-office': null, // `file` says this for an OLE container it cannot place
  'application/x-ole-storage': null,
  'application/cdfv2': null,
  'text/x-markdown': 'md',
  'image/jpg': 'jpg',
  'application/xhtml+xml': 'html',
  'application/x-zip-compressed': 'zip',
  'image/x-ms-bmp': 'bmp',
});

const OPENDOCUMENT = {
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

/**
 * A format id from a name, an extension or an alias ('JPEG', '.docx', 'markdown'); null if unknown.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function normalizeFormat(name) {
  const id = String(name ?? '').trim().toLowerCase().replace(/^\./, '');
  const resolved = ALIASES[id] || id;
  return TABLE[resolved] ? resolved : null;
}

/**
 * The format a file name's extension names, or null.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function formatForName(name) {
  const ext = extname(String(name ?? '')).slice(1);
  return ext ? normalizeFormat(ext) : null;
}

/**
 * The format of a MIME type (parameters ignored), or null.
 *
 * @param {string} mime
 * @returns {string|null}
 */
export function formatForMime(mime) {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return MIME_TO_FORMAT[type] ?? null;
}

/** The MIME type of a format id. */
export function mimeOf(format) {
  return TABLE[format]?.[0] || 'application/octet-stream';
}

/** A format's plain name: "Word document", "PDF". */
export function labelOf(format) {
  return TABLE[format]?.[1] || format || 'unknown';
}

function readHead(path, length) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function startsWith(buf, bytes, at = 0) {
  return buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
}

/** Whether a file's first bytes look like text: no NUL, and almost no other control characters. */
export function looksLikeText(head) {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  let control = 0;
  for (const b of head) if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) control += 1;
  return control / head.length < 0.01;
}

/** Which office format a ZIP holds, by its entries; 'zip' when it is a plain archive. */
function zipFormat(path) {
  let entries;
  try {
    entries = listZipEntries(path);
  } catch {
    return 'zip';
  }
  const names = entries.map((e) => e.name);
  if (names.includes('[Content_Types].xml')) {
    if (names.some((n) => n.startsWith('word/'))) return 'docx';
    if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
    if (names.some((n) => n.startsWith('ppt/'))) return 'pptx';
  }
  const mimetype = entries.find((e) => e.name === 'mimetype');
  if (mimetype) {
    try {
      const type = readZipEntry(path, mimetype, { maxBytes: 1024 }).toString('latin1').trim();
      if (OPENDOCUMENT[type]) return OPENDOCUMENT[type];
    } catch { /* an unreadable mimetype entry: a plain archive */ }
  }
  return 'zip';
}

/** The format of text bytes: markup by its first tag, otherwise the extension, otherwise plain text. */
function textFormat(head, byName) {
  const start = head.toString('utf8').replace(/^﻿/, '').trimStart().slice(0, 2048);
  if (/^<svg\b/i.test(start) || (/^<\?xml\b/i.test(start) && /<svg\b/i.test(start))) return 'svg';
  if (byName && TEXT_FORMATS.has(byName)) return byName;
  if (/^<!doctype html\b/i.test(start) || /^<html\b/i.test(start)) return 'html';
  return 'txt';
}

/**
 * What a file is, from its bytes first.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {object} [opts.runner] runner.mjs's runner, for `file --mime-type` when the bytes leave it open
 * @returns {Promise<{format: string|null, mime: string, label: string}>} format null: not one the files
 *   skill knows; mime is then what `file` said
 */
export async function detectFormat(path, { runner = null } = {}) {
  const head = readHead(path, 4096);
  const byName = formatForName(path);
  const ext = extname(String(path)).slice(1).toLowerCase();
  const known = (format) => ({ format, mime: mimeOf(format), label: labelOf(format) });

  if (head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return known('pdf');
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return known(zipFormat(path));
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return known('png');
  if (startsWith(head, [0xff, 0xd8, 0xff])) return known('jpg');
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return known('gif');
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return known('webp');
  if (head.toString('latin1', 0, 5) === '{\\rtf') return known('rtf');
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return known('tiff');
  if (head.length >= 26 && head.toString('latin1', 0, 2) === 'BM' && head.readUInt32LE(6) === 0
    && [12, 40, 52, 56, 64, 108, 124].includes(head.readUInt32LE(14))) return known('bmp');

  const ole = startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (ole && ['doc', 'xls', 'ppt'].includes(byName)) return known(byName);
  if (!ole && looksLikeText(head)) return known(textFormat(head, byName || (TEXT_EXTENSIONS.has(ext) ? 'txt' : null)));

  // The bytes leave it open: ask `file`, which knows far more containers than this module.
  if (runner) {
    const res = await runner.run('file', ['--brief', '--mime-type', path]).catch(() => null);
    const mime = res && res.code === 0 ? res.stdout.toString('utf8').trim() : '';
    const format = formatForMime(mime);
    if (format) return known(format);
    if (mime) return { format: null, mime, label: mime };
  }
  return { format: null, mime: 'application/octet-stream', label: ole ? 'an old binary Office file of unknown kind' : 'unknown binary data' };
}
