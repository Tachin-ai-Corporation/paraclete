// Tests for skills/workspace-docs/docs-get.mjs: a Doc as Markdown or exact text under a line saying who
// owns it and what the agent may do with it, its comments, a long one cut and said so, the whole of it
// saved into the mission's inbox, and a file that is not a Google Doc sent to drive-get. Google is a
// fake; files go to a temp data root.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as docsGet from '../../../skills/workspace-docs/docs-get.mjs';
import { createDocsClient } from '../../../agent/providers/workspace-docs.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, driveFile, driveFilesRoute, docOf, run } from '../../agent/providers/workspace-fakes.mjs';
import { driveRuntime, WORKSPACE } from '../drive/fakes.mjs';

const MINE = driveFile('1DocMineAbcdefghijklmnop', { name: 'Weekly report' });
const THEIRS = driveFile('1DocTheirsAbcdefghijklmn', { name: 'Contract', owner: 'pat@example.com' });
const PDF = driveFile('1PdfAbcdefghijklmnopqrst', { name: 'scan.pdf', mimeType: 'application/pdf' });
const DOC = docOf('Weekly report', [{ text: 'Status', style: 'HEADING_1' }, { text: 'All good.' }]);
const COMMENTS = [{ id: 'c1', content: 'Is this right?', quotedFileContent: { value: 'All good.' }, author: { displayName: 'Pat Example' }, createdTime: '2026-10-18T10:00:00Z', replies: [{ content: 'Yes.', author: { me: true }, createdTime: '2026-10-18T11:00:00Z' }] }];

function google() {
  return fakeGoogle([
    driveFilesRoute({ [MINE.id]: MINE, [THEIRS.id]: THEIRS, [PDF.id]: PDF }),
    ['GET', /^\/v1\/documents\/([^/]+)$/, () => json(DOC)],
    ['GET', /\/comments$/, () => json({ comments: COMMENTS })],
  ]);
}
const docsFor = (g) => createDocsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

describe('docs-get', () => {
  test('a Doc the agent owns, as Markdown, from its link', async () => {
    const r = await run(docsGet, [`https://docs.google.com/document/d/${MINE.id}/edit?tab=t.0`], { docs: docsFor(google()) });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, [
      `"Weekly report" | Google Doc | ${MINE.webViewLink}`,
      'You own it: you may change it in place (docs-replace).',
      '',
      '# Status',
      '',
      'All good.',
      '',
    ].join('\n'));
  });

  test("someone else's Doc says read and comment only; exact text; comments with replies", async () => {
    const r = await run(docsGet, [THEIRS.id, '--format', 'text', '--comments'], { docs: docsFor(google()) });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, [
      `"Contract" | Google Doc | ${THEIRS.webViewLink}`,
      'It is owned by Pat Example <pat@example.com>: you may read and comment, never change it. Changes go in a new document (docs-create), or in comments (docs-comment).',
      '',
      'Status\nAll good.',
      '',
      'Comments (1 open):',
      '1. [c1] Pat Example, 2026-10-18 on "All good.": Is this right?',
      '   - you, 2026-10-18: Yes.',
      '',
    ].join('\n'));
  });

  test('a long Doc is cut on screen; --mission saves the whole of it', async () => {
    const cut = await run(docsGet, [MINE.id, '--max-chars', '100'], { docs: docsFor(fakeGoogle([
      driveFilesRoute({ [MINE.id]: MINE }), ['GET', /^\/v1\/documents\//, () => json(docOf('Long', [{ text: 'y'.repeat(300) }]))],
    ])) });
    assert.match(cut.out, /\ny{100}\n\[cut: 201 more characters\. Save the whole document with --mission <mission id> and read the file\]\n$/);
    const runtime = driveRuntime({ workspace: WORKSPACE });
    const saved = await run(docsGet, [MINE.id, '--mission', 'm-7'], { docs: docsFor(google()), runtime });
    assert.equal(saved.code, 0, saved.err);
    const path = join(runtime.paths.data.missions, 'm-7', 'missions', 'm-7', 'inbox', 'Weekly report.md');
    assert.equal(readFileSync(path, 'utf8'), '# Status\n\nAll good.\n');
    assert.match(saved.out, /^Saved .*Weekly report\.md\n"Weekly report" as Markdown \| 20 bytes/);
  });

  test('a file that is not a Google Doc goes to drive-get', async () => {
    const r = await run(docsGet, [PDF.id], { docs: docsFor(google()) });
    assert.equal(r.code, 1);
    assert.match(r.err, /"scan\.pdf" is application\/pdf, not a Google Doc\. Read it with drive-get 1PdfAbcdefghijklmnopqrst --mission <mission id>/);
  });

  test('mistakes are refused before any call', async () => {
    const g = google();
    for (const argv of [[], ['not a link'], [MINE.id, '--format', 'html'], [MINE.id, '--mission', 'm-1', '--comments'], [MINE.id, '--mission', 'm-1', '--out', 'x']]) {
      assert.equal((await run(docsGet, argv, { docs: docsFor(g) })).code, 2, argv.join(' '));
    }
    assert.equal(g.calls.length, 0);
    assert.equal((await run(docsGet, ['--help'])).code, 0);
  });
});
