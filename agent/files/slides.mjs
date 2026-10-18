// agent/files/slides.mjs: a presentation's text, slide by slide. A .pptx is a ZIP of XML parts: the
// slide order comes from ppt/presentation.xml and its relationships, each slide's title, text, tables
// and picture descriptions from its own XML, and its speaker notes from the notes slide it links to.
// There is no Python library for this on the VM, so the XML is read here, by pattern, for text only:
// layout, styling and images themselves are not read. A .ppt or .odp goes through LibreOffice to
// .pptx first. Used by readers.mjs (file-read).

import { basename, posix } from 'node:path';
import { openZip } from './zip.mjs';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its entities decoded. */
export function decodeXml(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return match; }
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** The attributes of one XML tag, by name. */
function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

/** One paragraph's text: its runs joined, line breaks kept, slide-number fields left out. */
function paragraphText(xml) {
  const cleaned = xml.replace(/<a:fld\b[^>]*type="slidenum"[^>]*>[\s\S]*?<\/a:fld>/g, '');
  let text = '';
  for (const m of cleaned.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) {
    text += m[1] !== undefined ? decodeXml(m[1]) : '\n';
  }
  return text.trim();
}

/** The non-empty paragraphs of a piece of DrawingML. */
function paragraphs(xml) {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => paragraphText(m[1])).filter(Boolean);
}

function tableLines(xml) {
  return [...xml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((row) => [...row[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)]
    .map((cell) => paragraphs(cell[1]).join(' ')).join(' | '));
}

/**
 * A slide's text from its XML. Pure.
 *
 * @param {string} xml
 * @returns {{title: string, lines: string[], hidden: boolean}}
 */
export function parseSlideXml(xml) {
  const root = /<p:sld\b[^>]*>/.exec(xml)?.[0] || '';
  const hidden = attributes(root).show === '0';
  let title = '';
  const lines = [];
  const shapes = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>|<p:graphicFrame\b[^>]*>[\s\S]*?<\/p:graphicFrame>|<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/g;
  for (const [shape] of xml.matchAll(shapes)) {
    if (shape.startsWith('<p:pic')) {
      const descr = attributes(/<p:cNvPr\b[^>]*>/.exec(shape)?.[0] || '').descr;
      lines.push(descr ? `[image: ${descr}]` : '[image]');
      continue;
    }
    if (shape.startsWith('<p:graphicFrame')) {
      if (/<a:tbl\b/.test(shape)) lines.push(...tableLines(shape));
      else if (/<c:chart\b/.test(shape)) lines.push('[chart]');
      continue;
    }
    const text = paragraphs(shape);
    if (!title && /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(shape)) {
      title = text.join(' ');
      continue;
    }
    lines.push(...text);
  }
  return { title, lines, hidden };
}

/**
 * The speaker notes in a notes slide's XML: the text of its body placeholder. Pure.
 *
 * @param {string} xml
 * @returns {string[]}
 */
export function parseNotesXml(xml) {
  const out = [];
  for (const [shape] of xml.matchAll(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)) {
    if (/<p:ph\b[^>]*type="body"/.test(shape)) out.push(...paragraphs(shape));
  }
  return out;
}

/** A part's relationships: Id to { type, target } with the target resolved to a ZIP path. */
function relationships(zip, partPath) {
  const dir = posix.dirname(partPath);
  const relsPath = posix.join(dir, '_rels', `${posix.basename(partPath)}.rels`);
  const xml = zip.text(relsPath) || '';
  const out = new Map();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attributes(m[0]);
    if (!a.Id || !a.Target || a.TargetMode === 'External') continue;
    const target = a.Target.startsWith('/') ? a.Target.slice(1) : posix.normalize(posix.join(dir, a.Target));
    out.set(a.Id, { type: a.Type || '', target });
  }
  return out;
}

/**
 * Every slide of a .pptx, in presentation order.
 *
 * @param {string} path
 * @returns {Array<{number: number, title: string, lines: string[], notes: string[], hidden: boolean}>}
 */
export function readPptx(path) {
  const zip = openZip(path);
  const presentation = zip.text('ppt/presentation.xml');
  if (!presentation) throw new Error(`${basename(path)} has no ppt/presentation.xml: it is not a PowerPoint presentation`);
  const rels = relationships(zip, 'ppt/presentation.xml');
  let order = [...presentation.matchAll(/<p:sldId\b[^>]*>/g)]
    .map((m) => rels.get(attributes(m[0])['r:id'])?.target)
    .filter((target) => target && zip.has(target));
  if (order.length === 0) {
    // No usable slide list: fall back to the slide parts by number.
    order = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  }
  return order.map((part, i) => {
    const slide = parseSlideXml(zip.text(part) || '');
    const notesPart = [...relationships(zip, part).values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notes = notesPart && zip.has(notesPart) ? parseNotesXml(zip.text(notesPart)) : [];
    return { number: i + 1, ...slide, notes };
  });
}

/**
 * Every slide of a presentation: .pptx directly, .ppt and .odp through LibreOffice.
 *
 * @param {string} path
 * @param {string} format pptx, ppt or odp (formats.mjs)
 * @param {{runner: object}} o
 */
export async function readSlides(path, format, { runner }) {
  if (format === 'pptx') return readPptx(path);
  if (format === 'ppt' || format === 'odp') {
    return runner.withTempDir(async (dir) => readPptx(await runner.sofficeConvert(path, 'pptx', dir)));
  }
  throw new Error(`${basename(path)} is not a presentation`);
}

/**
 * One slide as Markdown (`md`) or plain text (`text`).
 *
 * @param {{number: number, title: string, lines: string[], notes: string[], hidden: boolean}} slide
 * @param {'md'|'text'} format
 * @returns {string}
 */
export function renderSlide(slide, format) {
  const head = `Slide ${slide.number}${slide.title ? `: ${slide.title}` : ''}${slide.hidden ? ' (hidden)' : ''}`;
  if (format === 'text') {
    return [head, ...slide.lines, ...(slide.notes.length ? ['Notes:', ...slide.notes] : [])].join('\n');
  }
  const body = slide.lines.map((l) => `- ${l.replace(/\n/g, ' ')}`);
  const notes = slide.notes.length ? ['', `> Notes: ${slide.notes.join(' ').replace(/\n/g, ' ')}`] : [];
  return [`## ${head}`, '', ...(body.length ? body : ['(no text)']), ...notes].join('\n');
}
