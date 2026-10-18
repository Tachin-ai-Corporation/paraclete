// Tests for skills/workspace-docs/docs-comment.mjs: listing open comments (all with --all), adding one
// that quotes a passage the document holds, replying, and the refusals: a passage that is not there, and
// a mention that would make Google email someone. Commenting never changes the document's text.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as docsComment from '../../../skills/workspace-docs/docs-comment.mjs';
import { createDocsClient } from '../../../agent/providers/workspace-docs.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, docOf, run } from '../../agent/providers/workspace-fakes.mjs';

const DOC_ID = '1DocTheirsAbcdefghijklmn';
const COMMENTS = [
  { id: 'c1', content: 'Typo here', author: { displayName: 'Pat Example' }, createdTime: '2026-10-18T10:00:00Z', resolved: false },
  { id: 'c2', content: 'Fixed', author: { displayName: 'Lee' }, createdTime: '2026-10-17T10:00:00Z', resolved: true },
];
function google() {
  return fakeGoogle([
    ['GET', /\/comments$/, () => json({ comments: COMMENTS })],
    ['GET', /^\/v1\/documents\//, () => json(docOf('Contract', [{ text: 'The term is twelve months.' }]))],
    ['POST', /\/comments(\/c1\/replies)?$/, (call) => json({ id: call.path.endsWith('/replies') ? 'r1' : 'c9', ...call.json() })],
  ]);
}
const docsFor = (g) => createDocsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

describe('docs-comment', () => {
  test('lists the open comments, or all of them', async () => {
    const r = await run(docsComment, [DOC_ID], { docs: docsFor(google()) });
    assert.equal(r.out, `1 open comment on document ${DOC_ID}:\n1. [c1] Pat Example, 2026-10-18: Typo here\n`);
    const all = await run(docsComment, [DOC_ID, '--all'], { docs: docsFor(google()) });
    assert.match(all.out, /^2 comments on [\s\S]*\n2\. \[c2\] Lee, 2026-10-17 \(resolved\): Fixed\n$/);
  });

  test('adds a comment quoting a passage the document holds, and changes nothing else', async () => {
    const g = google();
    const r = await run(docsComment, [DOC_ID, '--text', 'Should this be eighteen months?', '--quote', 'twelve months'], { docs: docsFor(g) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(g.calls.at(-1).json(), { content: 'Should this be eighteen months?', quotedFileContent: { mimeType: 'text/plain', value: 'twelve months' } });
    assert.match(r.out, /^Commented on document .* \(comment id c9\), quoting "twelve months"\.\nThe document's text is unchanged\./);
    assert.ok(g.calls.every((c) => !c.path.includes(':batchUpdate')));
  });

  test('replies to a comment', async () => {
    const g = google();
    const r = await run(docsComment, [DOC_ID, '--reply', 'c1', '--text', 'Fixed in the new version.'], { docs: docsFor(g) });
    assert.equal(r.code, 0, r.err);
    assert.equal(g.calls[0].path, `/drive/v3/files/${DOC_ID}/comments/c1/replies`);
    assert.match(r.out, /^Replied to comment c1 .* \(reply id r1\)/);
  });

  test('a passage that is not there is refused, and nothing is posted', async () => {
    const g = google();
    const r = await run(docsComment, [DOC_ID, '--text', 'x', '--quote', 'six months'], { docs: docsFor(g) });
    assert.equal(r.code, 1);
    assert.match(r.err, /The quoted passage is not in the document/);
    assert.equal(g.calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('a mention, and other mistakes, are refused before any call', async () => {
    const g = google();
    for (const text of ['Ping @pat@example.com please', '+lee@example.com can you check?']) {
      const r = await run(docsComment, [DOC_ID, '--text', text], { docs: docsFor(g) });
      assert.equal(r.code, 2);
      assert.match(r.err, /never mentions people with @ or \+ before their address/);
    }
    assert.equal((await run(docsComment, [DOC_ID, '--text', 'Ask pat@example.com'], { docs: docsFor(fakeGoogle([['POST', /comments$/, () => json({ id: 'c3' })]])) })).code, 0, 'a plain address is not a mention');
    for (const argv of [[], [DOC_ID, '--quote', 'x'], [DOC_ID, '--text', ' '], [DOC_ID, '--reply', 'c1', '--text', 'x', '--quote', 'y'], [DOC_ID, '--text', 'x', '--all']]) {
      assert.equal((await run(docsComment, argv, { docs: docsFor(g) })).code, 2, argv.join(' '));
    }
    assert.equal(g.calls.length, 0);
  });
});
