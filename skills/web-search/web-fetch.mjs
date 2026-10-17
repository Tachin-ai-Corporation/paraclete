#!/usr/bin/env node
// skills/web-search/web-fetch.mjs: the web-fetch command. Fetches one http(s) page and prints its
// readable text (title, description, image links, then the body text) or its raw HTML. It reads at most
// a byte cap and says when it cut the page. A document that is not a web page (PDF, office file, image,
// archive) is refused with the route to the files skill instead of being printed as noise. Searching is
// web-search.mjs. Documented in skills/web-search/SKILL.md.

import { pathToFileURL } from 'node:url';

export const USAGE = 'Usage: web-fetch --url <url> [--format text|html] [--max <bytes>] [--timeout <seconds>]';

const DEFAULTS = Object.freeze({ format: 'text', max: 500_000, timeout: 10 });
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentResearch/1.0)';
// Readable text runs to about 60% of a page's HTML, so the text budget follows the byte cap.
const TEXT_SHARE = 0.6;
const MAX_IMAGES = 10;
const SKIP_IMAGE = /pixel|tracking|spacer|blank|icon|1x1|logo/i;

const FILES_ROUTE = 'fetch it with the files skill (file-get <url>) and read it from there';

/**
 * @param {string[]} argv
 * @returns {{help?: true, url?: string, format?: string, max?: number, timeout?: number, error?: string}}
 */
export function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = argv[i + 1];
    if (!['--url', '--format', '--max', '--timeout'].includes(arg)) return { error: `unknown argument: ${arg}` };
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
    i += 1;
    if (arg === '--url') out.url = value;
    else if (arg === '--format') out.format = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return { error: `${arg} must be a positive whole number` };
      out[arg.slice(2)] = n;
    }
  }
  if (!out.url) return { error: '--url is required' };
  if (!/^https?:\/\//i.test(out.url)) return { error: 'only http:// and https:// URLs are supported' };
  if (!['text', 'html'].includes(out.format)) return { error: `--format must be text or html, not '${out.format}'` };
  return out;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };

/** Decodes the HTML entities a page's text commonly carries. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return match; }
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * The readable form of an HTML page. Pure.
 *
 * @param {string} html
 * @param {number} maxChars the most body text to keep
 * @returns {string}
 */
export function extractText(html, maxChars) {
  let raw = html;
  for (const tag of ['script', 'style', 'nav', 'footer', 'noscript', 'svg']) {
    raw = raw.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  raw = raw.replace(/<!--[\s\S]*?-->/g, ' ');

  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || '').trim()).replace(/\s+/g, ' ');
  const descMatch = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(raw)
    || /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(raw);
  const description = descMatch ? decodeEntities(descMatch[1].trim()) : '';
  const images = [...raw.matchAll(/<img[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi)]
    .map((m) => m[1])
    .filter((src) => !SKIP_IMAGE.test(src));

  // The head's title and description are printed above; the rest of the head is not readable text.
  let text = raw
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}...[truncated: the page's text is longer than ${maxChars} characters]`;

  const lines = [];
  if (title) lines.push(`TITLE: ${title}`);
  if (description) lines.push(`DESCRIPTION: ${description}`);
  if (images.length > 0) lines.push(`IMAGES (${images.length} found): ${images.slice(0, MAX_IMAGES).join(' | ')}`);
  lines.push('', text);
  return lines.join('\n');
}

const BINARY_SIGNATURES = [
  { kind: 'a PDF', magic: Buffer.from('%PDF') },
  { kind: 'an office document or ZIP archive', magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  { kind: 'a PNG image', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { kind: 'a JPEG image', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  { kind: 'a GIF image', magic: Buffer.from('GIF8') },
  { kind: 'a gzip archive', magic: Buffer.from([0x1f, 0x8b]) },
];

/**
 * What a response body is, when it is not text: from its leading bytes, then its content type. Pure.
 *
 * @param {Buffer} head the first bytes of the body
 * @param {string} contentType
 * @returns {string|null} a description, or null for text
 */
export function binaryKind(head, contentType) {
  for (const sig of BINARY_SIGNATURES) {
    if (head.length >= sig.magic.length && head.subarray(0, sig.magic.length).equals(sig.magic)) return sig.kind;
  }
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!type) return null;
  if (type.startsWith('text/') || /(json|xml|javascript|csv|yaml|x-www-form-urlencoded)/.test(type)) return null;
  return `'${type}'`;
}

/** Reads a body up to `max` bytes, then stops. */
async function readCapped(response, max) {
  if (!response.body) return { bytes: Buffer.alloc(0), cut: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
    if (size >= max) {
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = Buffer.concat(chunks);
  return { bytes: bytes.subarray(0, max), cut: cut && bytes.length >= max };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.fetch]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const fail = (message) => { stderr.write(`[web-fetch] ${message}\n`); return 1; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  let response;
  try {
    response = await fetchImpl(args.url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(args.timeout * 1000),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `no answer within ${args.timeout} seconds` : err.message;
    return fail(`the request failed (${reason}): ${args.url}`);
  }
  if (response.status >= 400) return fail(`HTTP ${response.status} for ${args.url}`);

  let body;
  try {
    body = await readCapped(response, args.max);
  } catch (err) {
    return fail(`reading the page failed: ${err.message}`);
  }
  const kind = binaryKind(body.bytes.subarray(0, 16), response.headers.get('content-type'));
  if (kind) return fail(`${args.url} is ${kind}, not a web page: ${FILES_ROUTE}.`);

  const finalUrl = response.url && response.url !== args.url ? `URL: ${response.url}\n` : '';
  const html = body.bytes.toString('utf8');
  const cutNote = body.cut ? `\n...[cut at ${args.max} bytes: the page is longer; raise --max to read more]` : '';
  if (args.format === 'html') {
    stdout.write(`${finalUrl}${html}${cutNote}\n`);
    return 0;
  }
  const type = (response.headers.get('content-type') || '').toLowerCase();
  const looksHtml = type.includes('html') || /<(html|body|head|p|div)\b/i.test(html.slice(0, 4096));
  const text = looksHtml ? extractText(html, Math.floor(args.max * TEXT_SHARE)) : html;
  stdout.write(`${finalUrl}${text}${cutNote}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
