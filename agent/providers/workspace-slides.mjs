// agent/providers/workspace-slides.mjs: a Google Slides API v1 client acting as the agent's own
// Workspace account (agent/providers/workspace.mjs). It reads a presentation as text, slide by slide
// (titles, body text, tables and speaker notes), and builds a NEW presentation from an outline: a
// title slide, then one slide per entry with a title, bullets (nested), an optional image fetched by
// Google from a public URL, and speaker notes. The pure pieces (reading a deck, the requests that build
// one) are exported for the tests.
//
// It never changes an existing presentation: a deck someone shared is read, and new work becomes a new
// deck. Called by the workspace-slides skill's commands (skills/workspace-slides/).

import { createWorkspaceSession, WorkspaceError } from './workspace.mjs';
import { GOOGLE_TYPES } from './drive.mjs';

/** The most content slides one outline may make. */
export const MAX_SLIDES = 100;

/** A 16:9 page, Google's default, in EMU; used when a presentation does not say its own. */
const DEFAULT_PAGE = Object.freeze({ width: 9_144_000, height: 5_143_500 });

const TITLE_TYPES = new Set(['TITLE', 'CENTERED_TITLE']);

/** A shape's text as lines: `{ text, bullet, nesting }`, empty lines left out. Pure. */
export function shapeLines(shape) {
  const lines = [];
  let current = null;
  for (const te of shape?.text?.textElements || []) {
    if (te.paragraphMarker) {
      current = { text: '', bullet: Boolean(te.paragraphMarker.bullet), nesting: te.paragraphMarker.bullet?.nestingLevel || 0 };
      lines.push(current);
    } else if (te.textRun || te.autoText) {
      if (!current) { current = { text: '', bullet: false, nesting: 0 }; lines.push(current); }
      current.text += (te.textRun || te.autoText).content || '';
    }
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\n$/, '') })).filter((l) => l.text.trim());
}

/** A page element's lines of text, and whether it is the title. */
function elementText(el) {
  if (el.shape) {
    const lines = shapeLines(el.shape);
    if (TITLE_TYPES.has(el.shape.placeholder?.type)) return { title: lines.map((l) => l.text.trim()).join(' '), lines: [] };
    return { lines: lines.map((l) => (l.bullet ? `${'  '.repeat(l.nesting)}- ${l.text.trim()}` : l.text)) };
  }
  if (el.table) {
    return {
      lines: (el.table.tableRows || []).map((row) => `| ${(row.tableCells || []).map((cell) => shapeLines(cell).map((l) => l.text.trim()).join(' ').replace(/\|/g, '\\|')).join(' | ')} |`),
    };
  }
  if (el.elementGroup) {
    const parts = (el.elementGroup.children || []).map(elementText);
    return { title: parts.find((p) => p.title)?.title, lines: parts.flatMap((p) => p.lines) };
  }
  if (el.image) return { lines: [`[image${el.title || el.description ? `: ${el.title || el.description}` : ''}]`] };
  if (el.sheetsChart) return { lines: ['[chart]'] };
  if (el.video) return { lines: ['[video]'] };
  return { lines: [] };
}

/**
 * A presentation's slides as text: number, id, title, body lines and speaker notes. Pure.
 *
 * @param {object} presentation a Slides API presentation
 * @returns {Array<{number: number, id: string, title: string, lines: string[], notes: string}>}
 */
export function presentationSlides(presentation) {
  return (presentation?.slides || []).map((slide, i) => {
    let title = '';
    const lines = [];
    for (const el of slide.pageElements || []) {
      const t = elementText(el);
      if (t.title && !title) title = t.title;
      lines.push(...t.lines);
    }
    const notesPage = slide.slideProperties?.notesPage;
    const notesId = notesPage?.notesProperties?.speakerNotesObjectId;
    const notesShape = (notesPage?.pageElements || []).find((el) => el.objectId === notesId)?.shape;
    const notes = notesShape ? shapeLines(notesShape).map((l) => l.text).join('\n').trim() : '';
    return { number: i + 1, id: slide.objectId, title, lines, notes };
  });
}

/** An element's place and size on a slide, in EMU. */
function box(pageObjectId, x, y, width, height) {
  return {
    pageObjectId,
    size: { width: { magnitude: Math.round(width), unit: 'EMU' }, height: { magnitude: Math.round(height), unit: 'EMU' } },
    transform: { scaleX: 1, scaleY: 1, translateX: Math.round(x), translateY: Math.round(y), unit: 'EMU' },
  };
}

const placeholder = (type, objectId) => ({ layoutPlaceholder: { type, index: 0 }, objectId });
const insert = (objectId, text) => ({ insertText: { objectId, insertionIndex: 0, text } });

/** The id of the n-th content slide (1-based) a deck is built with. */
export const slideObjectId = (n) => `deck_s${n}`;

/**
 * The requests that build a deck's slides and text (images and notes follow in later calls): a title
 * slide, then one slide per outline entry, then the deletion of the slides the new file started with.
 * A slide with bullets and an image puts the bullets in a text box on the left. Pure.
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.subtitle]
 * @param {Array<{title?: string, bullets?: Array<{text: string, level: number}>, image?: string}>} o.slides
 * @param {string[]} [o.existing] the object ids of the slides to remove
 * @param {{width: number, height: number}} [o.page] the page size in EMU
 * @returns {object[]}
 */
export function deckRequests({ title, subtitle, slides, existing = [], page = DEFAULT_PAGE }) {
  const { width: W, height: H } = page;
  const requests = [{
    createSlide: {
      objectId: 'deck_title', insertionIndex: 0, slideLayoutReference: { predefinedLayout: 'TITLE' },
      placeholderIdMappings: [placeholder('CENTERED_TITLE', 'deck_title_t'), ...(subtitle ? [placeholder('SUBTITLE', 'deck_title_s')] : [])],
    },
  }];
  if (title) requests.push(insert('deck_title_t', title));
  if (subtitle) requests.push(insert('deck_title_s', subtitle));
  slides.forEach((s, i) => {
    const id = slideObjectId(i + 1);
    const bullets = s.bullets || [];
    const layout = bullets.length && !s.image ? 'TITLE_AND_BODY' : 'TITLE_ONLY';
    requests.push({
      createSlide: {
        objectId: id, insertionIndex: i + 1, slideLayoutReference: { predefinedLayout: layout },
        placeholderIdMappings: [placeholder('TITLE', `${id}_t`), ...(layout === 'TITLE_AND_BODY' ? [placeholder('BODY', `${id}_b`)] : [])],
      },
    });
    if (s.title) requests.push(insert(`${id}_t`, s.title));
    if (bullets.length) {
      if (s.image) requests.push({ createShape: { objectId: `${id}_b`, shapeType: 'TEXT_BOX', elementProperties: box(id, 0.06 * W, 0.24 * H, 0.48 * W, 0.68 * H) } });
      requests.push(insert(`${id}_b`, bullets.map((b) => `${'\t'.repeat(b.level || 0)}${b.text}`).join('\n')));
      requests.push({ createParagraphBullets: { objectId: `${id}_b`, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    }
  });
  for (const objectId of existing) requests.push({ deleteObject: { objectId } });
  return requests;
}

/**
 * The request that places one slide's image: beside its bullets, or filling the slide under its title.
 * Pure.
 *
 * @param {number} n the content slide's number (1-based)
 * @param {{image: string, bullets?: Array}} slide
 * @param {{width: number, height: number}} [page]
 * @returns {object}
 */
export function imageRequest(n, slide, page = DEFAULT_PAGE) {
  const { width: W, height: H } = page;
  const id = slideObjectId(n);
  const beside = (slide.bullets || []).length > 0;
  const geometry = beside ? [0.57 * W, 0.24 * H, 0.37 * W, 0.68 * H] : [0.1 * W, 0.24 * H, 0.8 * W, 0.68 * H];
  return { createImage: { objectId: `${id}_img`, url: slide.image, elementProperties: box(id, ...geometry) } };
}

/**
 * The requests that write speaker notes, once the slides exist and Google has given each its notes
 * shape. Pure.
 *
 * @param {object} presentation read after the slides were made
 * @param {Array<{notes?: string}>} slides the outline entries, in order
 * @returns {object[]}
 */
export function notesRequests(presentation, slides) {
  const byId = new Map((presentation?.slides || []).map((s) => [s.objectId, s]));
  const requests = [];
  slides.forEach((s, i) => {
    if (!s.notes) return;
    const notesId = byId.get(slideObjectId(i + 1))?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    if (notesId) requests.push(insert(notesId, s.notes));
  });
  return requests;
}

/**
 * Creates a Slides client acting as the agent's Workspace account.
 *
 * @param {object} [options] a `session` from createWorkspaceSession, or the options to make one
 */
export function createSlidesClient(options = {}) {
  const session = options.session || createWorkspaceSession(options);
  const { account } = session;
  const path = (id) => `/v1/presentations/${encodeURIComponent(id)}`;

  async function get(id) {
    return session.request('slides', 'GET', path(id), { about: { what: `presentation ${id}` } });
  }
  async function batchUpdate(id, requests) {
    return session.request('slides', 'POST', `${path(id)}:batchUpdate`, { json: { requests }, about: { what: `presentation ${id}`, action: 'build' } });
  }

  return {
    account,

    /** The whole presentation. */
    get,

    /**
     * A new presentation from an outline, in a folder or the agent's My Drive. An image Google cannot
     * fetch does not stop the deck: it is reported in `imageFailures` with Google's reason.
     *
     * @param {object} o
     * @param {string} o.title
     * @param {string} [o.subtitle]
     * @param {Array<{title?: string, bullets?: Array<{text: string, level: number}>, image?: string, notes?: string}>} o.slides
     * @param {string} [o.folderId]
     * @returns {Promise<{file: object, slideCount: number, imageFailures: Array<{slide: number, url: string, reason: string}>}>}
     */
    async create({ title, subtitle, slides, folderId }) {
      if (slides.length > MAX_SLIDES) {
        throw new WorkspaceError(`An outline may make at most ${MAX_SLIDES} slides; this one has ${slides.length}.`, { kind: 'bad_request', api: 'slides' });
      }
      const file = await session.createEmpty({ name: title, mimeType: GOOGLE_TYPES.presentation, parentId: folderId });
      const deck = await get(file.id);
      const page = {
        width: deck.pageSize?.width?.magnitude || DEFAULT_PAGE.width,
        height: deck.pageSize?.height?.magnitude || DEFAULT_PAGE.height,
      };
      await batchUpdate(file.id, deckRequests({ title, subtitle, slides, existing: (deck.slides || []).map((s) => s.objectId), page }));

      const imageFailures = [];
      for (const [i, s] of slides.entries()) {
        if (!s.image) continue;
        try {
          await batchUpdate(file.id, [imageRequest(i + 1, s, page)]);
        } catch (err) {
          if (!(err instanceof WorkspaceError) || err.kind === 'scope' || err.kind === 'auth') throw err;
          imageFailures.push({ slide: i + 2, url: s.image, reason: err.google || err.message });
        }
      }
      if (slides.some((s) => s.notes)) {
        const requests = notesRequests(await get(file.id), slides);
        if (requests.length) await batchUpdate(file.id, requests);
      }
      return { file: { ...file, webViewLink: file.webViewLink || `https://docs.google.com/presentation/d/${file.id}/edit` }, slideCount: slides.length + 1, imageFailures };
    },
  };
}
