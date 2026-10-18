// agent/providers/workspace-docs.mjs: a Google Docs API v1 client acting as the agent's own Workspace
// account (agent/providers/workspace.mjs), with the pure pieces around it: a document (every tab) as
// Markdown or as its exact text, and a section rewrite turned into Docs requests.
//
// What it may do: read any Doc the account can open, read and add comments (Drive's comments API), and
// create new Docs from Markdown (Drive converts the upload). It changes a Doc in place (find and
// replace, rewrite a section) only when the agent's own account owns it; anything else is refused
// before a request is made (session.ownedFile). Every change is guarded by the revision it was planned
// on, so a Doc someone edited meanwhile is never changed blind.
//
// Called by the workspace-docs skill's commands (skills/workspace-docs/).

import { createWorkspaceSession, WorkspaceError } from './workspace.mjs';
import { GOOGLE_TYPES } from './drive.mjs';

const DOC_TYPE = GOOGLE_TYPES.document;
const MAX_COMMENTS = 500;
const COMMENT_FIELDS = 'id,content,quotedFileContent(value),author(displayName,emailAddress,me),createdTime,resolved,deleted,'
  + 'replies(id,content,author(displayName,emailAddress,me),createdTime,deleted,action)';
const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN']);

/**
 * A document's tabs, flattened in reading order (child tabs after their parent), each with what its
 * content needs: `{ id, title, body, lists }`. A document read without tabs is one untitled tab. Pure.
 *
 * @param {object} doc a Docs API document (read with includeTabsContent=true, or without)
 * @returns {Array<{id: string|null, title: string, body: object, lists: object}>}
 */
export function documentTabs(doc) {
  const out = [];
  const visit = (tab) => {
    const dt = tab?.documentTab;
    if (dt) out.push({ id: tab.tabProperties?.tabId ?? null, title: tab.tabProperties?.title ?? '', body: dt.body || { content: [] }, lists: dt.lists || {} });
    for (const child of tab?.childTabs || []) visit(child);
  };
  for (const tab of doc?.tabs || []) visit(tab);
  if (!out.length) out.push({ id: null, title: '', body: doc?.body || { content: [] }, lists: doc?.lists || {} });
  return out;
}

/** A styled stretch of text as Markdown, the marks kept off its surrounding spaces. */
function markRun(text, style = {}) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  let core = m[2];
  if (!core) return text;
  if (style.bold && style.italic) core = `***${core}***`;
  else if (style.bold) core = `**${core}**`;
  else if (style.italic) core = `*${core}*`;
  if (style.link?.url) core = `[${core}](${style.link.url})`;
  return `${m[1]}${core}${m[3]}`;
}

/** One paragraph's text: Markdown marks in md, the exact characters in text. */
function paragraphText(paragraph, markdown) {
  let s = '';
  for (const el of paragraph?.elements || []) {
    if (el.textRun) {
      const content = String(el.textRun.content ?? '').replace(/\n$/, '');
      s += markdown ? markRun(content, el.textRun.textStyle) : content;
    } else if (el.person) {
      s += el.person.personProperties?.name || el.person.personProperties?.email || '';
    } else if (el.richLink) {
      const p = el.richLink.richLinkProperties || {};
      s += markdown && p.uri ? `[${p.title || p.uri}](${p.uri})` : (p.title || p.uri || '');
    } else if (el.inlineObjectElement) {
      s += markdown ? '[image]' : '';
    } else if (el.footnoteReference) {
      s += markdown ? `[^${el.footnoteReference.footnoteNumber || ''}]` : '';
    } else if (el.horizontalRule && markdown) {
      s += '---';
    }
  }
  return s.replace(/\n$/, '');
}

/** The heading level a paragraph style names: TITLE 0, HEADING_n n, anything else null. */
export function headingLevel(paragraph) {
  const type = paragraph?.paragraphStyle?.namedStyleType || '';
  if (type === 'TITLE') return 0;
  const m = /^HEADING_([1-6])$/.exec(type);
  return m ? Number(m[1]) : null;
}

/** Renders structural elements into blocks: `{ text, list }` (list items join without blank lines). */
function renderContent(content, lists, markdown) {
  const blocks = [];
  for (const el of content || []) {
    if (el.paragraph) {
      const p = el.paragraph;
      const text = paragraphText(p, markdown);
      if (!markdown) { blocks.push({ text, list: true }); continue; }
      if (!text.trim()) continue;
      const level = headingLevel(p);
      if (p.bullet) {
        const nesting = p.bullet.nestingLevel || 0;
        const glyph = lists?.[p.bullet.listId]?.listProperties?.nestingLevels?.[nesting]?.glyphType;
        blocks.push({ text: `${'  '.repeat(nesting)}${ORDERED_GLYPHS.has(glyph) ? '1.' : '-'} ${text.trim()}`, list: true });
      } else if (level !== null) {
        blocks.push({ text: `${'#'.repeat(Math.max(level, 1))} ${text.trim()}`, list: false });
      } else if (p.paragraphStyle?.namedStyleType === 'SUBTITLE') {
        blocks.push({ text: `*${text.trim()}*`, list: false });
      } else {
        blocks.push({ text, list: false });
      }
    } else if (el.table) {
      const rows = (el.table.tableRows || []).map((row) => (row.tableCells || []).map((cell) => renderContent(cell.content, lists, markdown)
        .map((b) => b.text).filter((t) => t.trim()).join(markdown ? '<br>' : ' ').trim()));
      if (!rows.length) continue;
      if (markdown) {
        const width = Math.max(1, ...rows.map((r) => r.length));
        const line = (r) => `| ${Array.from({ length: width }, (_, i) => String(r[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
        blocks.push({ text: [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n'), list: false });
      } else {
        blocks.push({ text: rows.map((r) => r.join('\t')).join('\n'), list: true });
      }
    } else if (el.tableOfContents && !markdown) {
      blocks.push(...renderContent(el.tableOfContents.content, lists, false));
    }
  }
  return blocks;
}

/** Blocks joined: list items and plain-text lines on consecutive lines, other blocks a blank line apart. */
function joinBlocks(blocks) {
  let out = '';
  blocks.forEach((b, i) => {
    if (i > 0) out += b.list && blocks[i - 1].list ? '\n' : '\n\n';
    out += b.text;
  });
  return out;
}

/**
 * A document as Markdown (`md`: headings, lists, bold, italic, links and tables) or as its exact text
 * (`text`: every paragraph as written, table cells tab-separated: the strings find and replace and
 * quoted comments match). Several tabs each get a line naming them. Pure.
 *
 * @param {object} doc
 * @param {object} [o]
 * @param {'md'|'text'} [o.format]
 * @param {string} [o.tab] one tab, by id or title
 * @returns {string}
 */
export function renderDocument(doc, { format = 'md', tab } = {}) {
  const markdown = format !== 'text';
  const tabs = tab ? [findTab(doc, tab)] : documentTabs(doc);
  const parts = tabs.map((t) => {
    const text = joinBlocks(renderContent(t.body?.content, t.lists, markdown)).replace(/\n{3,}/g, '\n\n').trim();
    return tabs.length > 1 ? `--- Tab "${t.title}" (tab id ${t.id}) ---\n\n${text}` : text;
  });
  return `${parts.join('\n\n')}\n`;
}

/**
 * One tab by id or title (case does not matter for a title). Pure.
 *
 * @throws {WorkspaceError} listing the tabs when none matches
 */
export function findTab(doc, wanted) {
  const tabs = documentTabs(doc);
  const w = String(wanted ?? '').trim();
  const tab = tabs.find((t) => t.id === w) || tabs.find((t) => t.title.toLowerCase() === w.toLowerCase());
  if (!tab) {
    throw new WorkspaceError(`The document has no tab '${w}'. Its tabs: ${tabs.map((t) => `"${t.title}" (id ${t.id})`).join(', ')}.`, { kind: 'bad_request', api: 'docs' });
  }
  return tab;
}

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The section under a heading in a tab's body: the heading paragraph, and the range from just after
 * it to the next heading of the same or a higher level (or the end of the body). Only top-level
 * paragraphs styled as headings (Title, Heading 1 to 6) count. Pure.
 *
 * @param {object} body a tab's body
 * @param {string} heading the heading's text (spaces and case do not matter)
 * @returns {{level: number, headingText: string, start: number, end: number, atEnd: boolean, bodyEnd: number}}
 * @throws {WorkspaceError} kind heading_not_found, listing the headings, or when the heading repeats
 */
export function findSection(body, heading) {
  const content = body?.content || [];
  const headings = content
    .filter((el) => el.paragraph && headingLevel(el.paragraph) !== null)
    .map((el) => ({ el, level: headingLevel(el.paragraph), text: collapse(paragraphText(el.paragraph, false)) }));
  const want = collapse(heading).toLowerCase();
  const matches = headings.filter((h) => h.text.toLowerCase() === want);
  if (matches.length !== 1) {
    const list = headings.map((h) => `"${h.text}"`).join(', ') || 'none';
    const problem = matches.length ? `appears ${matches.length} times` : 'is not a heading in it';
    throw new WorkspaceError(`"${collapse(heading)}" ${problem}. The document's headings: ${list}. Use one exactly as it is written there.`, { kind: 'heading_not_found', api: 'docs' });
  }
  const { el, level, text } = matches[0];
  const bodyEnd = content.length ? content[content.length - 1].endIndex : 1;
  const next = headings.find((h) => h.el.startIndex > el.startIndex && h.level <= level);
  const end = next ? next.el.startIndex : bodyEnd - 1;
  return { level, headingText: text, start: el.endIndex, end: Math.max(end, el.endIndex), atEnd: !next, bodyEnd };
}

/**
 * Markdown, a small part of it, as paragraphs with styles: `#` headings, `-`/`*`/`+` bullets and `1.`
 * numbered items (indent two spaces per level), paragraphs (lines joined until a blank line), and
 * **bold**, *italic* or _italic_, and [links](https://...) inside them. Pure.
 *
 * @param {string} markdown
 * @returns {Array<{text: string, style: string, list: null|'bullet'|'number', nesting: number,
 *   spans: Array<{start: number, end: number, bold?: true, italic?: true, link?: string}>}>}
 */
export function parseMarkdownBlocks(markdown) {
  const paragraphs = [];
  let pending = null;
  const flush = () => { if (pending) { paragraphs.push(inline(pending)); pending = null; } };
  for (const raw of String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const number = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (heading) { flush(); paragraphs.push(inline({ text: heading[2].replace(/\s+#+$/, ''), style: `HEADING_${heading[1].length}`, list: null, nesting: 0 })); continue; }
    if (bullet || number) {
      flush();
      const m = bullet || number;
      paragraphs.push(inline({ text: m[2], style: 'NORMAL_TEXT', list: bullet ? 'bullet' : 'number', nesting: Math.min(Math.floor(m[1].replace(/\t/g, '  ').length / 2), 8) }));
      continue;
    }
    if (pending) pending.text += ` ${line.trim()}`;
    else pending = { text: line.trim(), style: 'NORMAL_TEXT', list: null, nesting: 0 };
  }
  flush();
  return paragraphs;
}

/** A paragraph's inline marks taken out of its text and kept as spans. */
function inline(p) {
  const spans = [];
  let out = '';
  const src = p.text;
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    out += src.slice(last, m.index);
    const start = out.length;
    if (m[1] !== undefined) { out += m[1]; spans.push({ start, end: out.length, link: m[2] }); }
    else if (m[3] !== undefined) { out += m[3]; spans.push({ start, end: out.length, bold: true, italic: true }); }
    else if (m[4] !== undefined || m[5] !== undefined) { out += m[4] ?? m[5]; spans.push({ start, end: out.length, bold: true }); }
    else { out += m[6] ?? m[7]; spans.push({ start, end: out.length, italic: true }); }
    last = m.index + m[0].length;
  }
  out += src.slice(last);
  return { text: out, style: p.style, list: p.list, nesting: p.nesting, spans };
}

/** Text style fields a rewrite resets, so new text takes its paragraph's named style. */
const RESET_TEXT_FIELDS = 'bold,italic,underline,strikethrough,smallCaps,link,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset';
const RESET_PARAGRAPH_FIELDS = 'namedStyleType,alignment,indentStart,indentFirstLine,indentEnd,spaceAbove,spaceBelow,lineSpacing';

/**
 * The Docs requests that rewrite a section: delete what is under the heading, insert the new
 * paragraphs, give each its style (named style, list, inline marks), in an order where no request
 * moves the text a later one points at. Pure.
 *
 * @param {object} section from findSection()
 * @param {Array} paragraphs from parseMarkdownBlocks()
 * @param {object} [o]
 * @param {string|null} [o.tabId]
 * @returns {object[]} requests for documents.batchUpdate
 */
export function sectionRequests(section, paragraphs, { tabId = null } = {}) {
  const at = (index) => (tabId ? { index, tabId } : { index });
  const range = (startIndex, endIndex) => (tabId ? { startIndex, endIndex, tabId } : { startIndex, endIndex });
  const requests = [];
  // The body's last newline cannot be deleted, so a last section keeps it and the new text goes before it.
  if (section.end > section.start) requests.push({ deleteContentRange: { range: range(section.start, section.end) } });
  if (!paragraphs.length) return requests;

  // A heading that ends the body has nothing after it to insert into: insert before its newline instead.
  const pastEnd = section.start >= section.bodyEnd;
  const base = pastEnd ? section.start - 1 : section.start;
  const lines = paragraphs.map((p) => `${p.list ? '\t'.repeat(p.nesting) : ''}${p.text}`);
  const text = pastEnd ? `\n${lines.join('\n')}` : `${lines.join('\n')}${section.atEnd ? '' : '\n'}`;
  requests.push({ insertText: { location: at(base), text } });

  const first = pastEnd ? base + 1 : base;
  const offsets = [];
  let o = first;
  for (const line of lines) { offsets.push(o); o += line.length + 1; }
  const insertedEnd = offsets[offsets.length - 1] + lines[lines.length - 1].length;

  requests.push({ deleteParagraphBullets: { range: range(first, insertedEnd) } });
  paragraphs.forEach((p, i) => {
    requests.push({ updateParagraphStyle: { range: range(offsets[i], offsets[i] + Math.max(lines[i].length, 1)), paragraphStyle: { namedStyleType: p.style }, fields: RESET_PARAGRAPH_FIELDS } });
  });
  requests.push({ updateTextStyle: { range: range(first, insertedEnd), textStyle: {}, fields: RESET_TEXT_FIELDS } });
  paragraphs.forEach((p, i) => {
    const lead = p.list ? p.nesting : 0;
    for (const s of p.spans) {
      const textStyle = {};
      const fields = [];
      if (s.bold) { textStyle.bold = true; fields.push('bold'); }
      if (s.italic) { textStyle.italic = true; fields.push('italic'); }
      if (s.link) { textStyle.link = { url: s.link }; fields.push('link'); }
      requests.push({ updateTextStyle: { range: range(offsets[i] + lead + s.start, offsets[i] + lead + s.end), textStyle, fields: fields.join(',') } });
    }
  });
  // Lists last, the last group first: creating bullets removes the leading tabs and shifts what follows.
  const groups = [];
  paragraphs.forEach((p, i) => {
    const prev = groups[groups.length - 1];
    if (!p.list) return;
    if (prev && prev.kind === p.list && prev.last === i - 1) { prev.last = i; return; }
    groups.push({ kind: p.list, first: i, last: i });
  });
  for (const g of groups.reverse()) {
    requests.push({
      createParagraphBullets: {
        range: range(offsets[g.first], offsets[g.last] + lines[g.last].length),
        bulletPreset: g.kind === 'number' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  return requests;
}

/** Whether a passage is in a text, exactly or with its spacing collapsed. Pure. */
export function containsPassage(text, passage) {
  return String(text).includes(passage) || collapse(text).includes(collapse(passage));
}

/**
 * Creates a Docs client acting as the agent's Workspace account.
 *
 * @param {object} [options] a `session` from createWorkspaceSession, or the options to make one
 */
export function createDocsClient(options = {}) {
  const session = options.session || createWorkspaceSession(options);
  const { account } = session;
  const docPath = (id) => `/v1/documents/${encodeURIComponent(id)}`;
  const commentsPath = (id) => `/drive/v3/files/${encodeURIComponent(id)}/comments`;

  async function get(id) {
    return session.request('docs', 'GET', docPath(id), { query: { includeTabsContent: 'true' }, about: { what: `document ${id}` } });
  }

  async function batchUpdate(id, requests, revisionId) {
    return session.request('docs', 'POST', `${docPath(id)}:batchUpdate`, {
      json: { requests, ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}) },
      about: { what: `document ${id}`, action: 'change' },
    });
  }

  return {
    account,

    /** The whole document, every tab's content included. */
    get,

    /** The Drive record of the document: name, owners, whether the agent owns it, link. */
    info: (id) => session.fileInfo(id),

    /** Whether the agent's account owns a Drive record from info(). */
    owns: (info) => session.owns(info),

    /**
     * The document's comments, oldest first, with their replies. Resolved ones only when asked.
     *
     * @param {string} id
     * @param {{includeResolved?: boolean}} [o]
     * @returns {Promise<object[]>}
     */
    async comments(id, { includeResolved = false } = {}) {
      const all = [];
      let pageToken;
      do {
        const page = await session.request('drive', 'GET', commentsPath(id), {
          query: { pageSize: 100, includeDeleted: 'false', fields: `nextPageToken,comments(${COMMENT_FIELDS})`, pageToken },
          about: { what: `the comments on document ${id}` },
        });
        all.push(...(page.comments || []));
        pageToken = page.nextPageToken;
      } while (pageToken && all.length < MAX_COMMENTS);
      return all.filter((c) => !c.deleted && (includeResolved || !c.resolved));
    },

    /**
     * Adds a comment. With `quote`, the passage must be in the document (checked first): the comment
     * carries it as the text it is about. Google Docs shows such a comment with its quote, though it may
     * not highlight the passage in the text.
     *
     * @param {string} id
     * @param {{content: string, quote?: string}} o
     * @returns {Promise<object>} the comment
     * @throws {WorkspaceError} kind quote_not_found when the passage is not in the document
     */
    async addComment(id, { content, quote }) {
      if (quote) {
        const text = renderDocument(await get(id), { format: 'text' });
        if (!containsPassage(text, quote)) {
          throw new WorkspaceError(`The quoted passage is not in the document. Copy it exactly from docs-get --format text (a short, distinctive phrase works best), or comment without --quote.`, { kind: 'quote_not_found', api: 'docs' });
        }
      }
      return session.request('drive', 'POST', commentsPath(id), {
        query: { fields: 'id,content,quotedFileContent(value),createdTime' },
        json: { content, ...(quote ? { quotedFileContent: { mimeType: 'text/plain', value: quote } } : {}) },
        about: { what: `document ${id}`, action: 'comment on' },
      });
    },

    /** Replies to a comment. */
    async reply(id, commentId, content) {
      return session.request('drive', 'POST', `${commentsPath(id)}/${encodeURIComponent(commentId)}/replies`, {
        query: { fields: 'id,content,createdTime' },
        json: { content },
        about: { what: `comment ${commentId} on document ${id}`, action: 'reply to' },
      });
    },

    /**
     * A new Google Doc from Markdown, converted by Drive, in a folder or the agent's My Drive.
     *
     * @param {{title: string, markdown: string, folderId?: string}} o
     * @returns {Promise<object>} the new file: id, name, webViewLink
     */
    async create({ title, markdown, folderId }) {
      return session.drive.create({ name: title, parentId: folderId || undefined, mimeType: 'text/markdown', bytes: Buffer.from(String(markdown), 'utf8'), convertTo: 'doc' });
    },

    /**
     * Finds and replaces text everywhere in a document the agent owns, in one change. Matching ignores
     * case unless a pair says otherwise; the replacement takes the formatting of the text it replaces.
     *
     * @param {string} id
     * @param {Array<{find: string, replace: string, matchCase?: boolean}>} pairs
     * @returns {Promise<{file: object, results: Array<{find: string, replace: string, occurrences: number}>}>}
     * @throws {WorkspaceError} kind not_owner (nothing is requested of Docs then)
     */
    async replaceText(id, pairs) {
      const file = await session.ownedFile(id, { type: DOC_TYPE, action: 'change' });
      const doc = await get(id);
      const reply = await batchUpdate(id, pairs.map((p) => ({
        replaceAllText: { containsText: { text: p.find, matchCase: p.matchCase === true }, replaceText: p.replace },
      })), doc.revisionId);
      const results = pairs.map((p, i) => ({ find: p.find, replace: p.replace, occurrences: reply?.replies?.[i]?.replaceAllText?.occurrencesChanged || 0 }));
      return { file, results };
    },

    /**
     * Rewrites the section under a heading in a document the agent owns: everything from the heading
     * to the next heading of the same or a higher level is replaced by the Markdown given. The heading
     * itself and the rest of the document are untouched.
     *
     * @param {string} id
     * @param {{heading: string, markdown: string, tab?: string}} o
     * @returns {Promise<{file: object, section: object, paragraphs: number, removedChars: number}>}
     */
    async replaceSection(id, { heading, markdown, tab }) {
      const file = await session.ownedFile(id, { type: DOC_TYPE, action: 'change' });
      const doc = await get(id);
      const target = tab ? findTab(doc, tab) : documentTabs(doc)[0];
      const section = findSection(target.body, heading);
      const paragraphs = parseMarkdownBlocks(markdown);
      const requests = sectionRequests(section, paragraphs, { tabId: tab ? target.id : null });
      if (requests.length) await batchUpdate(id, requests, doc.revisionId);
      return { file, section, paragraphs: paragraphs.length, removedChars: Math.max(section.end - section.start, 0) };
    },
  };
}
