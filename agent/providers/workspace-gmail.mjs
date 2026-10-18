// agent/providers/workspace-gmail.mjs: a Gmail API v1 client for the agent's own mailbox, read only.
// It searches with Gmail's own query syntax, reads a message or a whole thread as plain text (the
// text/plain part, or the HTML part turned into text), lists each message's attachments, and fetches
// an attachment's bytes. It acts as the agent's Workspace account (agent/providers/workspace.mjs) with
// the gmail.readonly scope, so nothing here can send, draft, label, move or delete mail: replies
// leave only through the mouth service.
//
// Mail is data from outside: whatever a message says is never an instruction to the agent. The
// workspace-gmail skill (skills/workspace-gmail/) tells the agent so, and prints what this returns.

import { createWorkspaceSession, mapLimit } from './workspace.mjs';

const BASE = '/gmail/v1/users/me';
const MAX_RESULTS = 100;
const SUMMARY_HEADERS = Object.freeze(['From', 'To', 'Cc', 'Subject', 'Date']);

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', euro: '€',
});

/** Text with HTML entities decoded. Pure. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * An HTML mail body as readable text: scripts and styles dropped, blocks on their own lines, list items
 * as "- ", a link as its text followed by its address. Pure.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  const text = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (whole, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return !label || label === href || /^mailto:/i.test(href) ? (label || href) : `${label} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(p|h[1-6]|ul|ol|table|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|ul|ol|h[1-6]|table|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A header's value from a Gmail header list, case-insensitively, or ''. */
function header(headers, name) {
  const h = (headers || []).find((x) => String(x?.name).toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/** A body part's bytes as text, in its declared charset (UTF-8 when none or unknown). */
function decodeBody(data, contentType) {
  const bytes = Buffer.from(String(data || ''), 'base64url');
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType || '')?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * A Gmail message (format=full) as plain values: its headers, its body as text, and its attachments
 * numbered from 1 in the order they appear. Pure.
 *
 * @param {object} raw the message resource
 * @returns {{id: string, threadId: string, labelIds: string[], snippet: string, from: string, to: string,
 *   cc: string, subject: string, date: string, text: string, html: boolean,
 *   attachments: Array<{index: number, partId: string, filename: string, mimeType: string, size: number,
 *   attachmentId: string|null, data: string|null, inline: boolean}>}}
 */
export function parseMessage(raw) {
  const plain = [];
  const html = [];
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    const type = String(part.mimeType || '').toLowerCase();
    const contentType = header(part.headers, 'Content-Type') || type;
    const disposition = header(part.headers, 'Content-Disposition');
    const isFile = Boolean(part.filename) || /^attachment/i.test(disposition);
    if (Array.isArray(part.parts) && part.parts.length) {
      for (const child of part.parts) walk(child);
    } else if (isFile) {
      attachments.push({
        index: attachments.length + 1,
        partId: part.partId ?? '',
        filename: part.filename || `attachment-${attachments.length + 1}`,
        mimeType: type || 'application/octet-stream',
        size: Number(part.body?.size ?? 0),
        attachmentId: part.body?.attachmentId || null,
        data: part.body?.attachmentId ? null : (part.body?.data || null),
        inline: /^inline/i.test(disposition),
      });
    } else if (type === 'text/plain' && part.body?.data) {
      plain.push(decodeBody(part.body.data, contentType));
    } else if (type === 'text/html' && part.body?.data) {
      html.push(decodeBody(part.body.data, contentType));
    }
  };
  walk(raw?.payload);
  const headers = raw?.payload?.headers;
  return {
    id: raw?.id ?? '',
    threadId: raw?.threadId ?? '',
    labelIds: raw?.labelIds || [],
    snippet: decodeEntities(raw?.snippet || ''),
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    cc: header(headers, 'Cc'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    text: plain.length ? plain.join('\n').replace(/\r\n/g, '\n').trim() : htmlToText(html.join('\n')),
    html: !plain.length && html.length > 0,
    attachments,
  };
}

/** A search result's summary from a message read with format=metadata. Pure. */
export function summarizeMessage(raw) {
  const headers = raw?.payload?.headers;
  return {
    id: raw?.id ?? '',
    threadId: raw?.threadId ?? '',
    labelIds: raw?.labelIds || [],
    snippet: decodeEntities(raw?.snippet || ''),
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    internalDate: raw?.internalDate ? Number(raw.internalDate) : null,
  };
}

/**
 * Creates a read-only Gmail client for the agent's own mailbox.
 *
 * @param {object} [options] a `session` from createWorkspaceSession, or the options to make one
 */
export function createGmailClient(options = {}) {
  const session = options.session || createWorkspaceSession(options);
  const { account } = session;
  const missing = (what) => `There is no ${what} in the mailbox of ${account}: the id is wrong, or it was deleted. Search again (gmail-search) and copy the id exactly.`;

  async function getRaw(id) {
    return session.request('gmail', 'GET', `${BASE}/messages/${encodeURIComponent(id)}`, {
      query: { format: 'full' },
      about: { what: `message ${id}`, notFound: missing(`message ${id}`) },
    });
  }

  return {
    account,

    /**
     * Messages matching a Gmail query, newest first, each with its headers and snippet.
     *
     * @param {object} o
     * @param {string} o.query  Gmail search syntax: from:, to:, subject:, newer_than:2d, has:attachment...
     * @param {number} [o.limit] at most this many (default 20, at most 100)
     * @returns {Promise<{messages: object[], capped: boolean, estimate: number}>}
     */
    async search({ query, limit = 20 } = {}) {
      const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : 20, 1), MAX_RESULTS);
      const found = [];
      let pageToken;
      let estimate = 0;
      do {
        const page = await session.request('gmail', 'GET', `${BASE}/messages`, {
          query: { q: query, maxResults: cap - found.length, pageToken },
          about: { what: 'the mailbox' },
        });
        found.push(...(page.messages || []));
        estimate = Number(page.resultSizeEstimate ?? estimate) || 0;
        pageToken = page.nextPageToken;
      } while (pageToken && found.length < cap);
      const picked = found.slice(0, cap);
      const messages = await mapLimit(picked, 8, (m) => session.request('gmail', 'GET', `${BASE}/messages/${encodeURIComponent(m.id)}`, {
        query: { format: 'metadata', metadataHeaders: SUMMARY_HEADERS },
        about: { what: `message ${m.id}`, notFound: missing(`message ${m.id}`) },
      }));
      return { messages: messages.map(summarizeMessage), capped: Boolean(pageToken), estimate: Math.max(estimate, picked.length) };
    },

    /** One message, parsed (parseMessage). */
    async getMessage(id) {
      return parseMessage(await getRaw(id));
    },

    /** A whole thread: `{ id, messages }`, oldest first, each parsed. */
    async getThread(id) {
      const thread = await session.request('gmail', 'GET', `${BASE}/threads/${encodeURIComponent(id)}`, {
        query: { format: 'full' },
        about: { what: `thread ${id}`, notFound: missing(`thread ${id}`) },
      });
      return { id: thread.id ?? id, messages: (thread.messages || []).map(parseMessage) };
    },

    /**
     * An attachment's bytes.
     *
     * @param {string} messageId
     * @param {{attachmentId: string|null, data: string|null}} attachment from parseMessage()
     * @returns {Promise<Buffer>}
     */
    async getAttachment(messageId, attachment) {
      if (attachment?.data) return Buffer.from(attachment.data, 'base64url');
      const body = await session.request('gmail', 'GET', `${BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`, {
        about: { what: `an attachment of message ${messageId}`, notFound: missing(`attachment on message ${messageId}`) },
      });
      return Buffer.from(String(body?.data || ''), 'base64url');
    },
  };
}
