// Tests for agent/providers/workspace-docs.mjs: a document read as Markdown and as exact text (every
// tab, lists, headings, marks, tables), the section a heading owns, Markdown turned into the exact Docs
// requests that rewrite it, and the client: exact URLs and bodies, comments anchored to a passage that
// must be in the document, and in-place changes only on a Doc the agent's account owns (refused before
// anything is sent otherwise), each guarded by the revision it was planned on. Google is a fake fetch.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDocsClient, renderDocument, documentTabs, findSection, findTab, parseMarkdownBlocks, sectionRequests, containsPassage,
} from '../../../agent/providers/workspace-docs.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, driveFile, driveFilesRoute } from './workspace-fakes.mjs';

/** Paragraph and table elements with real start and end indexes, after the section break at 0. */
function body(...specs) {
  const content = [{ endIndex: 1, sectionBreak: {} }];
  let at = 1;
  for (const s of specs) {
    if (s.table) {
      const length = 10;
      content.push({ startIndex: at, endIndex: at + length, table: { tableRows: s.table.map((row) => ({ tableCells: row.map((cell) => ({ content: [para(cell)] })) })) } });
      at += length;
      continue;
    }
    const runs = s.runs || [{ text: s.text }];
    const elements = runs.map((r, i) => ({ textRun: { content: `${r.text}${i === runs.length - 1 ? '\n' : ''}`, textStyle: r.style || {} } }));
    const length = elements.reduce((n, e) => n + e.textRun.content.length, 0);
    content.push({ startIndex: at, endIndex: at + length, paragraph: { elements, paragraphStyle: { namedStyleType: s.style || 'NORMAL_TEXT' }, ...(s.bullet ? { bullet: s.bullet } : {}) } });
    at += length;
  }
  return { content };
}
function para(text) {
  return { paragraph: { elements: [{ textRun: { content: `${text}\n`, textStyle: {} } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } };
}

const LISTS = {
  l1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }] } },
  l2: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } },
};
const REPORT = body(
  { text: 'Weekly report', style: 'TITLE' },
  { text: 'Status', style: 'HEADING_1' },
  { runs: [{ text: 'Things are ' }, { text: 'fine', style: { bold: true } }, { text: '.' }] },
  { text: 'Alpha', bullet: { listId: 'l1' } },
  { text: 'Beta', bullet: { listId: 'l1', nestingLevel: 1 } },
  { text: 'First', bullet: { listId: 'l2' } },
  { text: 'Details', style: 'HEADING_2' },
  { runs: [{ text: 'More text with a ' }, { text: 'link', style: { link: { url: 'https://example.com/x' } } }] },
  { table: [['A', 'B'], ['1', '2|3']] },
  { text: 'Next steps', style: 'HEADING_1' },
  { text: 'Ship it.' },
);
const DOC = { documentId: '1DocAbcdefghij', title: 'Weekly report', revisionId: 'rev-7', tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: REPORT, lists: LISTS } }] };

describe('reading a document', () => {
  test('as Markdown: headings, nested and numbered lists, marks, links and tables', () => {
    assert.equal(renderDocument(DOC), [
      '# Weekly report', '', '# Status', '', 'Things are **fine**.', '', '- Alpha', '  - Beta', '1. First', '', '## Details', '',
      'More text with a [link](https://example.com/x)', '', '| A | B |', '| --- | --- |', '| 1 | 2\\|3 |', '', '# Next steps', '', 'Ship it.', '',
    ].join('\n'));
  });

  test('as exact text: every paragraph as written, table cells tab-separated', () => {
    assert.equal(renderDocument(DOC, { format: 'text' }), 'Weekly report\nStatus\nThings are fine.\nAlpha\nBeta\nFirst\nDetails\nMore text with a link\nA\tB\n1\t2|3\nNext steps\nShip it.\n');
  });

  test('several tabs: each named, child tabs after their parent; one tab by id or title', () => {
    const tabbed = {
      tabs: [
        { tabProperties: { tabId: 't.a', title: 'Plan' }, documentTab: { body: body({ text: 'Plan text' }) }, childTabs: [{ tabProperties: { tabId: 't.b', title: 'Risks' }, documentTab: { body: body({ text: 'Risk text' }) } }] },
      ],
    };
    assert.deepEqual(documentTabs(tabbed).map((t) => [t.id, t.title]), [['t.a', 'Plan'], ['t.b', 'Risks']]);
    assert.equal(renderDocument(tabbed), '--- Tab "Plan" (tab id t.a) ---\n\nPlan text\n\n--- Tab "Risks" (tab id t.b) ---\n\nRisk text\n');
    assert.equal(renderDocument(tabbed, { tab: 'risks' }), 'Risk text\n');
    assert.equal(findTab(tabbed, 't.b').title, 'Risks');
    assert.throws(() => findTab(tabbed, 'Budget'), /no tab 'Budget'\. Its tabs: "Plan" \(id t\.a\), "Risks" \(id t\.b\)/);
    assert.equal(documentTabs({ body: body({ text: 'old style' }) }).length, 1, 'a document read without tabs is one tab');
  });

  test('a passage is found exactly, or with its spacing collapsed', () => {
    assert.equal(containsPassage('Things are  fine.\nNext', 'are fine. Next'), true);
    assert.equal(containsPassage('Things are fine.', 'are great'), false);
  });
});

describe('sections', () => {
  test('a heading owns everything up to the next heading of its level or higher', () => {
    const status = findSection(REPORT, '  status ');
    const heading = REPORT.content.find((e) => e.paragraph?.elements[0].textRun.content === 'Status\n');
    const next = REPORT.content.find((e) => e.paragraph?.elements[0].textRun.content === 'Next steps\n');
    assert.deepEqual(status, { level: 1, headingText: 'Status', start: heading.endIndex, end: next.startIndex, atEnd: false, bodyEnd: REPORT.content.at(-1).endIndex });
    const last = findSection(REPORT, 'Next steps');
    assert.equal(last.atEnd, true);
    assert.equal(last.end, last.bodyEnd - 1, 'the body\'s last newline stays');
  });

  test('a heading that is missing or repeats is refused with the headings there are', () => {
    assert.throws(() => findSection(REPORT, 'Budget'), (err) => err.kind === 'heading_not_found'
      && /"Budget" is not a heading in it\. The document's headings: "Weekly report", "Status", "Details", "Next steps"/.test(err.message));
    const twice = body({ text: 'Notes', style: 'HEADING_2' }, { text: 'a' }, { text: 'Notes', style: 'HEADING_2' });
    assert.throws(() => findSection(twice, 'Notes'), /appears 2 times/);
  });

  test('Markdown becomes styled paragraphs with inline marks as spans', () => {
    assert.deepEqual(parseMarkdownBlocks('Intro with **bold** and\n*soft* [link](https://example.com).\n\n- one\n  - two\n1. first\n## Sub ##\n'), [
      { text: 'Intro with bold and soft link.', style: 'NORMAL_TEXT', list: null, nesting: 0, spans: [{ start: 11, end: 15, bold: true }, { start: 20, end: 24, italic: true }, { start: 25, end: 29, link: 'https://example.com' }] },
      { text: 'one', style: 'NORMAL_TEXT', list: 'bullet', nesting: 0, spans: [] },
      { text: 'two', style: 'NORMAL_TEXT', list: 'bullet', nesting: 1, spans: [] },
      { text: 'first', style: 'NORMAL_TEXT', list: 'number', nesting: 0, spans: [] },
      { text: 'Sub', style: 'HEADING_2', list: null, nesting: 0, spans: [] },
    ]);
  });

  const SMALL = body({ text: 'Plan', style: 'HEADING_1' }, { text: 'Old text' }, { text: 'Next', style: 'HEADING_1' }, { text: 'Tail' });

  test('the rewrite: delete, insert, style each paragraph, reset marks, then lists last-first', () => {
    const section = findSection(SMALL, 'Plan');
    assert.deepEqual([section.start, section.end], [6, 15]);
    const requests = sectionRequests(section, parseMarkdownBlocks('Intro with **bold**.\n\n- one\n  - two\n\n## Sub'));
    assert.deepEqual(requests, [
      { deleteContentRange: { range: { startIndex: 6, endIndex: 15 } } },
      { insertText: { location: { index: 6 }, text: 'Intro with bold.\none\n\ttwo\nSub\n' } },
      { deleteParagraphBullets: { range: { startIndex: 6, endIndex: 35 } } },
      { updateParagraphStyle: { range: { startIndex: 6, endIndex: 22 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType,alignment,indentStart,indentFirstLine,indentEnd,spaceAbove,spaceBelow,lineSpacing' } },
      { updateParagraphStyle: { range: { startIndex: 23, endIndex: 26 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType,alignment,indentStart,indentFirstLine,indentEnd,spaceAbove,spaceBelow,lineSpacing' } },
      { updateParagraphStyle: { range: { startIndex: 27, endIndex: 31 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType,alignment,indentStart,indentFirstLine,indentEnd,spaceAbove,spaceBelow,lineSpacing' } },
      { updateParagraphStyle: { range: { startIndex: 32, endIndex: 35 }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType,alignment,indentStart,indentFirstLine,indentEnd,spaceAbove,spaceBelow,lineSpacing' } },
      { updateTextStyle: { range: { startIndex: 6, endIndex: 35 }, textStyle: {}, fields: 'bold,italic,underline,strikethrough,smallCaps,link,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset' } },
      { updateTextStyle: { range: { startIndex: 17, endIndex: 21 }, textStyle: { bold: true }, fields: 'bold' } },
      { createParagraphBullets: { range: { startIndex: 23, endIndex: 31 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    ]);
  });

  test('the last section keeps the body\'s final newline; a heading that ends the body is written after', () => {
    const last = sectionRequests(findSection(SMALL, 'Next'), parseMarkdownBlocks('New tail'), { tabId: 't.0' });
    assert.deepEqual(last.slice(0, 2), [
      { deleteContentRange: { range: { startIndex: 20, endIndex: 24, tabId: 't.0' } } },
      { insertText: { location: { index: 20, tabId: 't.0' }, text: 'New tail' } },
    ]);
    const bare = body({ text: 'Plan', style: 'HEADING_1' });
    const after = sectionRequests(findSection(bare, 'Plan'), parseMarkdownBlocks('Hello'));
    assert.deepEqual(after[0], { insertText: { location: { index: 5 }, text: '\nHello' } });
    assert.deepEqual(after[2].updateParagraphStyle.range, { startIndex: 6, endIndex: 11 });
    assert.deepEqual(sectionRequests(findSection(SMALL, 'Plan'), []), [{ deleteContentRange: { range: { startIndex: 6, endIndex: 15 } } }], 'emptying a section only deletes');
  });
});

describe('the client', () => {
  const MINE = driveFile('1DocAbcdefghij', { name: 'Weekly report' });
  const THEIRS = driveFile('1TheirsAbcdefg', { name: 'Contract', owner: 'pat@example.com' });
  const files = { [MINE.id]: MINE, [THEIRS.id]: THEIRS };

  function google(extra = []) {
    return fakeGoogle([
      driveFilesRoute(files),
      ['GET', /^\/v1\/documents\/([^/:]+)$/, (call, m) => json({ ...DOC, documentId: m[1] })],
      ['POST', /^\/v1\/documents\/[^/]+:batchUpdate$/, (call) => json({ replies: call.json().requests.map((r) => (r.replaceAllText ? (r.replaceAllText.containsText.text === 'nothing' ? { replaceAllText: {} } : { replaceAllText: { occurrencesChanged: 2 } }) : {})) })],
      ...extra,
    ]);
  }
  const client = (g) => createDocsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

  test('get reads every tab, with the documents token', async () => {
    const g = google();
    await client(g).get(MINE.id);
    assert.equal(g.calls[0].url, `https://docs.googleapis.com/v1/documents/${MINE.id}?includeTabsContent=true`);
    assert.equal(g.calls[0].headers.Authorization, 'Bearer tok-documents');
  });

  test('find and replace in an owned Doc: one change, guarded by the revision read, counts per pair', async () => {
    const g = google();
    const { results } = await client(g).replaceText(MINE.id, [{ find: 'Q3', replace: 'Q4' }, { find: 'nothing', replace: 'x', matchCase: true }]);
    assert.deepEqual(results, [{ find: 'Q3', replace: 'Q4', occurrences: 2 }, { find: 'nothing', replace: 'x', occurrences: 0 }]);
    assert.deepEqual(g.calls.map((c) => `${c.method} ${c.path}`), [`GET /drive/v3/files/${MINE.id}`, `GET /v1/documents/${MINE.id}`, `POST /v1/documents/${MINE.id}:batchUpdate`]);
    assert.deepEqual(g.calls[2].json(), {
      requests: [
        { replaceAllText: { containsText: { text: 'Q3', matchCase: false }, replaceText: 'Q4' } },
        { replaceAllText: { containsText: { text: 'nothing', matchCase: true }, replaceText: 'x' } },
      ],
      writeControl: { requiredRevisionId: 'rev-7' },
    });
  });

  test("a Doc the agent does not own is refused before the document is even read", async () => {
    const g = google();
    await assert.rejects(client(g).replaceText(THEIRS.id, [{ find: 'a', replace: 'b' }]), (err) => err.kind === 'not_owner' && /"Contract": it belongs to Pat Example <pat@example\.com>/.test(err.message));
    await assert.rejects(client(g).replaceSection(THEIRS.id, { heading: 'Status', markdown: 'x' }), (err) => err.kind === 'not_owner');
    assert.deepEqual(g.calls.map((c) => c.path), [`/drive/v3/files/${THEIRS.id}`, `/drive/v3/files/${THEIRS.id}`]);
  });

  test('a section rewrite sends the requests for that section, on the tab asked for', async () => {
    const g = google();
    const result = await client(g).replaceSection(MINE.id, { heading: 'Next steps', markdown: '- Ship on Friday', tab: 'Tab 1' });
    assert.equal(result.paragraphs, 1);
    const sent = g.calls.at(-1).json();
    assert.equal(sent.writeControl.requiredRevisionId, 'rev-7');
    assert.ok(sent.requests.every((r) => JSON.stringify(r).includes('"tabId":"t.0"')));
    assert.deepEqual(sent.requests[1], { insertText: { location: { index: findSection(REPORT, 'Next steps').start, tabId: 't.0' }, text: 'Ship on Friday' } });
  });

  test('comments: open ones by default, resolved ones when asked, with the fields Drive requires', async () => {
    const comments = [
      { id: 'c1', content: 'Is this right?', quotedFileContent: { value: 'fine' }, author: { displayName: 'Pat' }, resolved: false, replies: [] },
      { id: 'c2', content: 'Done', resolved: true },
      { id: 'c3', content: 'gone', deleted: true },
    ];
    const g = google([['GET', /\/comments$/, () => json({ comments })]]);
    const docs = client(g);
    assert.deepEqual((await docs.comments(MINE.id)).map((c) => c.id), ['c1']);
    assert.deepEqual((await docs.comments(MINE.id, { includeResolved: true })).map((c) => c.id), ['c1', 'c2']);
    const call = g.calls[0];
    assert.equal(call.path, `/drive/v3/files/${MINE.id}/comments`);
    assert.match(call.params.get('fields'), /^nextPageToken,comments\(id,content,quotedFileContent\(value\),author/);
    assert.equal(call.headers.Authorization, 'Bearer tok-drive');
  });

  test('a comment quoting a passage checks the passage is there first', async () => {
    const g = google([['POST', /\/comments(\/c1\/replies)?$/, (call) => json({ id: 'c9', ...call.json() })]]);
    const docs = client(g);
    const made = await docs.addComment(THEIRS.id, { content: 'Should this say Q4?', quote: 'Things are fine.' });
    assert.equal(made.id, 'c9');
    assert.deepEqual(g.calls.at(-1).json(), { content: 'Should this say Q4?', quotedFileContent: { mimeType: 'text/plain', value: 'Things are fine.' } });
    await assert.rejects(docs.addComment(THEIRS.id, { content: 'x', quote: 'not in it' }), (err) => err.kind === 'quote_not_found' && /docs-get --format text/.test(err.message));
    assert.equal(g.calls.filter((c) => c.method === 'POST').length, 1, 'nothing posted for a missing passage');
    assert.ok(g.calls.every((c) => !c.path.includes(':batchUpdate')), 'a comment never changes the document');
    await docs.reply(THEIRS.id, 'c1', 'Fixed in the new version.');
    assert.equal(g.calls.at(-1).path, `/drive/v3/files/${THEIRS.id}/comments/c1/replies`);
    assert.deepEqual(g.calls.at(-1).json(), { content: 'Fixed in the new version.' });
  });

  test('create uploads the Markdown for Drive to convert into a Doc', async () => {
    const g = google([['POST', '/upload/drive/v3/files', () => json({ id: '1NewDocAbcdefg', name: 'Notes', webViewLink: 'https://docs.google.com/document/d/1NewDocAbcdefg/edit' })]]);
    const file = await client(g).create({ title: 'Notes', markdown: '# Notes\n\nHello', folderId: '1FolderAbcdefghij' });
    assert.equal(file.id, '1NewDocAbcdefg');
    const call = g.calls[0];
    assert.equal(call.params.get('uploadType'), 'multipart');
    const sent = call.body.toString();
    assert.ok(sent.includes(JSON.stringify({ name: 'Notes', parents: ['1FolderAbcdefghij'], mimeType: GOOGLE_TYPES.document })));
    assert.ok(sent.includes('Content-Type: text/markdown\r\n\r\n# Notes\n\nHello'));
    assert.equal(call.headers.Authorization, 'Bearer tok-drive');
  });
});
