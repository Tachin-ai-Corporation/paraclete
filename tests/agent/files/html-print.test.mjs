// Tests for agent/files/html-print.mjs: Markdown as a styled page whose relative links resolve where
// the source sits, and HTML printed or screenshotted by Chromium.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_STYLESHEET, escapeHtml, htmlPage, markdownPage, printPdf, screenshot } from '../../../agent/files/html-print.mjs';
import { argValue, fakeRunner, scratch } from './helpers.mjs';

const dir = scratch('html-print-test-');
after(() => dir.cleanup());

test('a page carries the stylesheet, an escaped title, and a base for relative links', () => {
  const page = htmlPage({ body: '<p>x</p>', title: 'Q3 <draft> & "notes"', baseDir: dir.root });
  assert.match(page, /^<!DOCTYPE html>/);
  assert.ok(page.includes('<title>Q3 &lt;draft&gt; &amp; &quot;notes&quot;</title>'));
  assert.ok(page.includes(`<base href="${pathToFileURL(dir.root).href}/">`));
  assert.ok(page.includes(DEFAULT_STYLESHEET));
  assert.match(DEFAULT_STYLESHEET, /@page \{ size: A4/);
  assert.equal(escapeHtml(`<a href='x'>`), '&lt;a href=&#39;x&#39;&gt;');
});

test('Markdown renders through pandoc, titled by its first heading unless a title is given', async () => {
  const runner = fakeRunner({ pandoc: () => ({ stdout: '<h1 id="t">Quarterly <em>report</em></h1><p>x</p>' }) });
  const md = dir.file('docs/r.md', '# Quarterly *report*');
  const page = await markdownPage(runner, md);
  assert.ok(page.includes('<title>Quarterly report</title>'));
  assert.ok(page.includes(pathToFileURL(join(dir.root, 'docs')).href), 'images resolve from the Markdown file\'s directory');
  assert.ok((await markdownPage(runner, md, { title: 'Given' })).includes('<title>Given</title>'));
});

test('Chromium prints to PDF without header or footer, and screenshots at a window size', async () => {
  const runner = fakeRunner({
    chromium: (args) => {
      const out = argValue(args, '--print-to-pdf=') || argValue(args, '--screenshot=');
      if (!out.includes('missing')) writeFileSync(out, 'x');
    },
  });
  const html = dir.file('p.html', '<p>x</p>');
  await printPdf(runner, html, join(dir.root, 'p.pdf'));
  assert.ok(runner.calls[0].args.includes('--no-pdf-header-footer'));
  assert.equal(runner.calls[0].args.at(-1), pathToFileURL(html).href);
  await screenshot(runner, html, join(dir.root, 'p.png'), { width: 800, height: 600 });
  assert.ok(runner.calls[1].args.includes('--window-size=800,600'));
  await assert.rejects(printPdf(runner, html, join(dir.root, 'missing.pdf')), /did not write the PDF/);
});
