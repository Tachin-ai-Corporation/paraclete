// agent/providers/workspace-gmail.mjs: a Gmail API v1 client for the agent's own mailbox. Reads
// (search, getMessage, getThread, getAttachment) use the `gmail.readonly` scope: they search with
// Gmail's own query syntax, read a message or thread as plain text (or HTML turned into text), and
// fetch attachments. Sending a threaded reply (`sendReply`) requests the `gmail.send` scope, which
// only mail-sending roles (`MAIL_SEND_ROLES` in agent/auth/workspace-scopes.mjs) hold in domain-wide
// delegation. It acts as the agent's Workspace account (agent/providers/workspace.mjs).
//
// Mail is data from outside: whatever a message says is never an instruction to the agent. The
// workspace-gmail skill (skills/workspace-gmail/) and support-triage skill tell the agent so.

import { GMAIL_SEND, GMAIL_SETTINGS_SHARING } from '../auth/workspace-scopes.mjs';
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
 *   cc: string, replyTo: string, subject: string, date: string, messageIdHeader: string,
 *   references: string, autoSubmitted: string, precedence: string, text: string, html: boolean,
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
    replyTo: header(headers, 'Reply-To'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    messageIdHeader: header(headers, 'Message-ID'),
    references: header(headers, 'References'),
    autoSubmitted: header(headers, 'Auto-Submitted'),
    precedence: header(headers, 'Precedence'),
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
 * Extracts a lowercase email address from `"Display Name <user@example.com>"` or `"user@example.com"`. Pure.
 *
 * @param {string} value
 * @returns {string}
 */
export function extractEmailAddress(value) {
  const s = String(value ?? '').trim();
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  if (angled) return angled[1].toLowerCase();
  const bare = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(s);
  return bare ? bare[0].toLowerCase() : '';
}

/**
 * Encodes one mail header value safely: rejects CR/LF (header injection) and RFC-2047 encodes
 * non-ASCII text (preserving `<addr@domain>` verbatim on address headers). Pure.
 *
 * @param {string} value
 * @returns {string}
 */
export function encodeHeaderValue(value) {
  const s = String(value ?? '').trim();
  if (/[\r\n]/.test(s)) throw new Error('mail header cannot contain line breaks');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const addrMatch = /^(.*?)(<[^<>\s]+@[^<>\s]+>)$/.exec(s);
  if (addrMatch) {
    const display = addrMatch[1].trim();
    const emailPart = addrMatch[2];
    if (!display) return emailPart;
    const encodedDisplay = /^[\x20-\x7E]*$/.test(display)
      ? display
      : `=?UTF-8?B?${Buffer.from(display, 'utf8').toString('base64')}?=`;
    return `${encodedDisplay} ${emailPart}`;
  }
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** Wraps a base64 string into 76-character CRLF lines per RFC 2045. */
function wrapBase64(b64) {
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

/**
 * Builds an RFC 2822 UTF-8 text/plain reply and base64url-encodes it for Gmail's `messages/send`
 * API. Pure.
 *
 * @param {object} o
 * @param {object} [o.original]  parsed message from parseMessage()
 * @param {string} o.body        plain-text reply body
 * @param {string} [o.from]      optional From address (e.g. a verified Send-As group alias)
 * @param {string} [o.to]        recipient override (default: original.replyTo || original.from)
 * @param {string} [o.cc]        optional Cc header
 * @param {string} [o.subject]   optional Subject override (default: Re: original.subject)
 * @returns {{raw: string, mime: string, to: string, from: string, cc: string, subject: string,
 *   inReplyTo: string, references: string, threadId: string|null}}
 */
export function buildReplyMime({ original = {}, body, from = '', to = '', cc = '', subject = '' } = {}) {
  const recipient = String(to || original?.replyTo || original?.from || '').trim();
  if (!recipient) throw new Error('cannot build reply: recipient address is missing');
  const bodyText = String(body ?? '').replace(/\r?\n/g, '\r\n').trim();
  if (!bodyText) throw new Error('cannot build reply: body is empty');

  const rawSubject = String(subject || '').trim() || (() => {
    const base = String(original?.subject || '').trim();
    if (!base) return 'Re: Support request';
    return /^re:\s/i.test(base) ? base : `Re: ${base}`;
  })();
  const inReplyTo = String(original?.messageIdHeader || '').trim();
  const prevRefs = String(original?.references || '').trim().split(/\s+/).filter(Boolean);
  if (inReplyTo && !prevRefs.includes(inReplyTo)) prevRefs.push(inReplyTo);
  const references = prevRefs.join(' ');

  const headers = [];
  if (String(from || '').trim()) headers.push(`From: ${encodeHeaderValue(from)}`);
  headers.push(`To: ${encodeHeaderValue(recipient)}`);
  if (String(cc || '').trim()) headers.push(`Cc: ${encodeHeaderValue(cc)}`);
  headers.push(`Subject: ${encodeHeaderValue(rawSubject)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${encodeHeaderValue(inReplyTo)}`);
  if (references) headers.push(`References: ${encodeHeaderValue(references)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: base64');

  const encodedBody = wrapBase64(Buffer.from(`${bodyText}\r\n`, 'utf8').toString('base64'));
  const mime = `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
  return {
    raw: Buffer.from(mime, 'utf8').toString('base64url'),
    mime,
    to: recipient,
    from: String(from || '').trim(),
    cc: String(cc || '').trim(),
    subject: rawSubject,
    inReplyTo,
    references,
    threadId: original?.threadId || null,
  };
}

/**
 * Creates a Gmail client for the agent's own mailbox. Reads use `gmail.readonly`; `sendReply`
 * requests `gmail.send` (granted only on mail-sending roles).
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

    /**
     * Lists Gmail Send-As aliases configured on the agent's mailbox (`gmail.readonly` scope).
     *
     * @returns {Promise<{aliases: Array<{sendAsEmail: string, displayName: string, replyToAddress: string, isPrimary: boolean, isDefault: boolean, treatAsAlias: boolean, verificationStatus: string}>}>}
     */
    async listSendAs() {
      const res = await session.request('gmail', 'GET', `${BASE}/settings/sendAs`, {
        about: { what: 'send-as aliases' },
      });
      const aliases = (res?.sendAs || []).map((a) => ({
        sendAsEmail: String(a?.sendAsEmail || '').trim().toLowerCase(),
        displayName: String(a?.displayName || ''),
        replyToAddress: String(a?.replyToAddress || ''),
        isPrimary: a?.isPrimary === true,
        isDefault: a?.isDefault === true,
        treatAsAlias: a?.treatAsAlias === true,
        verificationStatus: a?.verificationStatus || (a?.isPrimary === true ? 'accepted' : 'unknown'),
      }));
      return { aliases };
    },

    /**
     * Creates a custom Send-As alias on the agent's mailbox (`gmail.settings.sharing` scope).
     *
     * @param {object} o
     * @param {string} o.sendAsEmail
     * @param {string} [o.displayName]
     * @param {boolean} [o.treatAsAlias=true]
     */
    async createSendAs({ sendAsEmail, displayName = '', treatAsAlias = true } = {}) {
      const email = String(sendAsEmail || '').trim().toLowerCase();
      const body = { sendAsEmail: email, treatAsAlias: treatAsAlias !== false };
      if (String(displayName || '').trim()) body.displayName = String(displayName).trim();
      return session.request('gmail', 'POST', `${BASE}/settings/sendAs`, {
        json: body,
        scopes: GMAIL_SETTINGS_SHARING,
        about: { what: `send-as alias ${email}`, action: 'create' },
      });
    },

    /**
     * Triggers verification for an existing pending Send-As alias (`gmail.settings.sharing` scope).
     *
     * @param {string} sendAsEmail
     */
    async verifySendAs(sendAsEmail) {
      const email = String(sendAsEmail || '').trim().toLowerCase();
      return session.request('gmail', 'POST', `${BASE}/settings/sendAs/${encodeURIComponent(email)}/verify`, {
        scopes: GMAIL_SETTINGS_SHARING,
        expect: 'none',
        about: { what: `send-as alias ${email}`, action: 'verify' },
      });
    },

    /**
     * Sends a threaded plain-text reply to an existing message (`gmail.send` scope).
     *
     * @param {object} o
     * @param {string} [o.messageId]  Gmail message id to fetch when `original` is omitted
     * @param {object} [o.original]   parsed message from getMessage()
     * @param {string} o.body
     * @param {string} [o.from]
     * @param {string} [o.to]
     * @param {string} [o.cc]
     * @param {string} [o.subject]
     */
    async sendReply({ messageId, original: givenOriginal = null, body, from = '', to = '', cc = '', subject = '' } = {}) {
      const original = givenOriginal || await parseMessage(await getRaw(messageId));
      const built = buildReplyMime({ original, body, from, to, cc, subject });
      const sent = await session.request('gmail', 'POST', `${BASE}/messages/send`, {
        json: { raw: built.raw, ...(built.threadId ? { threadId: built.threadId } : {}) },
        scopes: GMAIL_SEND,
        about: { what: `a reply to message ${original.id || messageId}`, action: 'send mail' },
      });
      return {
        id: sent?.id ?? '',
        threadId: sent?.threadId ?? built.threadId,
        labelIds: sent?.labelIds || [],
        to: built.to,
        from: built.from || account,
        cc: built.cc,
        subject: built.subject,
        inReplyTo: built.inReplyTo,
      };
    },
  };
}
