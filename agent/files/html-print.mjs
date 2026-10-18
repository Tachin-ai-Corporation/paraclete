// agent/files/html-print.mjs: HTML pages for printing, and printing them. It renders the agent's
// Markdown to an HTML page with a clean default stylesheet (pandoc for the Markdown, the page around it
// here), and turns an HTML file into a PDF or a PNG with headless Chromium. Used by converters.mjs and
// makers.mjs; which conversion needs a page is theirs to decide.

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolError } from './runner.mjs';

/** The default look of a page made from Markdown: readable type, ruled tables, A4 with margins. */
export const DEFAULT_STYLESHEET = `
@page { size: A4; margin: 18mm 16mm; }
html { font-family: "Liberation Sans", "DejaVu Sans", Arial, Helvetica, sans-serif; font-size: 11pt; color: #1f2328; }
body { max-width: 46em; margin: 2em auto; padding: 0 1em; line-height: 1.5; }
@media print { body { max-width: none; margin: 0; padding: 0; } }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; break-after: avoid; }
h1 { font-size: 1.9em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.25em; }
h2 { font-size: 1.45em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.2em; }
h3 { font-size: 1.2em; }
p, ul, ol, table, pre, blockquote { margin: 0 0 0.9em; }
a { color: #0969da; text-decoration: none; }
img { max-width: 100%; }
table { border-collapse: collapse; width: auto; max-width: 100%; font-size: 0.95em; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { border: 1px solid #d0d7de; padding: 0.35em 0.65em; text-align: left; vertical-align: top; }
th { background: #f3f5f7; font-weight: 600; }
tbody tr:nth-child(even) td { background: #fafbfc; }
code { font-family: "DejaVu Sans Mono", "Liberation Mono", monospace; font-size: 0.9em; background: #f3f5f7; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f3f5f7; padding: 0.8em 1em; border-radius: 4px; white-space: pre-wrap; word-wrap: break-word; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #d0d7de; color: #57606a; padding: 0 1em; margin-left: 0; }
hr { border: none; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
`;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe inside HTML. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * A complete HTML page around a body fragment. `baseDir` makes the fragment's relative links and
 * images resolve where its source sits, wherever the page itself is written.
 *
 * @param {object} o
 * @param {string} o.body       HTML fragment
 * @param {string} [o.title]
 * @param {string} [o.baseDir]  directory relative URLs resolve against
 * @param {string} [o.css]      default: DEFAULT_STYLESHEET
 * @returns {string}
 */
export function htmlPage({ body, title = '', baseDir = null, css = DEFAULT_STYLESHEET }) {
  const base = baseDir ? `<base href="${escapeHtml(pathToFileURL(resolve(baseDir)).href)}/">\n` : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${base}<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * Markdown (GitHub style) as an HTML page, rendered by pandoc.
 *
 * @param {object} runner     runner.mjs's
 * @param {string} mdPath
 * @param {{title?: string, baseDir?: string}} [opts] baseDir default: the Markdown file's directory
 * @returns {Promise<string>}
 */
export async function markdownPage(runner, mdPath, { title = '', baseDir = null } = {}) {
  const { stdout } = await runner.check('pandoc', ['--from', 'gfm', '--to', 'html5', '--wrap=none', mdPath]);
  const body = stdout.toString('utf8');
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1]?.replace(/<[^>]+>/g, '').trim();
  return htmlPage({ body, title: title || heading || '', baseDir: baseDir || dirname(resolve(mdPath)) });
}

/**
 * Writes an HTML page into a scratch directory and returns its path.
 *
 * @param {string} dir
 * @param {string} html
 */
export function writePage(dir, html) {
  const path = join(dir, 'page.html');
  writeFileSync(path, html);
  return path;
}

/**
 * Prints an HTML file to PDF with headless Chromium, with no header or footer. Paper size and margins
 * come from the page's CSS (`@page`).
 *
 * @param {object} runner
 * @param {string} htmlPath
 * @param {string} outPath
 */
export async function printPdf(runner, htmlPath, outPath) {
  await runner.chromium(['--no-pdf-header-footer', `--print-to-pdf=${outPath}`, pathToFileURL(resolve(htmlPath)).href]);
  if (!existsSync(outPath)) throw new ToolError('Chromium did not write the PDF', { program: 'chromium' });
  return outPath;
}

/**
 * A PNG screenshot of an HTML file's first screen, at a window size.
 *
 * @param {object} runner
 * @param {string} htmlPath
 * @param {string} outPath
 * @param {{width?: number, height?: number}} [size] default 1280 by 1600
 */
export async function screenshot(runner, htmlPath, outPath, { width = 1280, height = 1600 } = {}) {
  await runner.chromium([`--window-size=${width},${height}`, `--screenshot=${outPath}`, pathToFileURL(resolve(htmlPath)).href]);
  if (!existsSync(outPath)) throw new ToolError('Chromium did not write the screenshot', { program: 'chromium' });
  return outPath;
}
