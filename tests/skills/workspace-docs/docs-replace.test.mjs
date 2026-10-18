// Tests for skills/workspace-docs/docs-replace.mjs: find and replace (one pair, or a JSON file of
// pairs) and a section rewrite, only in a Doc the agent's account owns; a Doc someone else owns is
// refused before anything is sent; nothing matched is a failure that says how to find the exact text.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as docsReplace from '../../../skills/workspace-docs/docs-replace.mjs';
import { createDocsClient } from '../../../agent/providers/workspace-docs.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, driveFile, driveFilesRoute, docOf, run } from '../../agent/providers/workspace-fakes.mjs';
import { driveRuntime, WORKSPACE } from '../drive/fakes.mjs';

const MINE = driveFile('1DocMineAbcdefghijklmnop', { name: 'Weekly report' });
const THEIRS = driveFile('1DocTheirsAbcdefghijklmn', { name: 'Contract', owner: 'pat@example.com' });
const DOC = docOf('Weekly report', [{ text: 'Status', style: 'HEADING_1' }, { text: 'Q3 is fine.' }, { text: 'Next', style: 'HEADING_1' }, { text: 'Ship.' }], { revisionId: 'rev-9' });

function google() {
  return fakeGoogle([
    driveFilesRoute({ [MINE.id]: MINE, [THEIRS.id]: THEIRS }),
    ['GET', /^\/v1\/documents\/[^/:]+$/, () => json(DOC)],
    ['POST', /:batchUpdate$/, (call) => json({ replies: call.json().requests.map((r) => (r.replaceAllText ? { replaceAllText: r.replaceAllText.containsText.text === 'Q3' ? { occurrencesChanged: 1 } : {} } : {})) })],
  ]);
}
const docsFor = (g) => createDocsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });
const updates = (g) => g.calls.filter((c) => c.path.endsWith(':batchUpdate'));

describe('docs-replace', () => {
  test('find and replace in a Doc the agent owns', async () => {
    const g = google();
    const r = await run(docsReplace, [MINE.id, '--find', 'Q3', '--replace', 'Q4'], { docs: docsFor(g) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(updates(g)[0].json(), { requests: [{ replaceAllText: { containsText: { text: 'Q3', matchCase: false }, replaceText: 'Q4' } }], writeControl: { requiredRevisionId: 'rev-9' } });
    assert.equal(r.out, 'Changed "Weekly report": 1 replacement.\n- "Q3" -> "Q4": 1 replaced\n');
  });

  test("a Doc someone else owns is refused, and nothing is sent to Docs", async () => {
    const g = google();
    const r = await run(docsReplace, [THEIRS.id, '--find', 'twelve', '--replace', 'eighteen'], { docs: docsFor(g) });
    assert.equal(r.code, 1);
    assert.match(r.err, /^docs-replace: You may not change "Contract": it belongs to Pat Example <pat@example\.com>, not to agent@example\.com\./);
    assert.equal(updates(g).length, 0);
    assert.ok(g.calls.every((c) => c.path.startsWith('/drive/')), 'not even read through Docs');
  });

  test('pairs from a JSON file; one that matched nothing is listed with how to find the exact text', async () => {
    const runtime = driveRuntime({ workspace: WORKSPACE });
    mkdirSync(join(runtime.paths.data.missions, 'm-5'), { recursive: true });
    writeFileSync(join(runtime.paths.data.missions, 'm-5', 'pairs.json'), JSON.stringify([{ find: 'Q3', replace: 'Q4' }, { find: 'Q2', replace: 'Q3', match_case: true }]));
    const g = google();
    const r = await run(docsReplace, [MINE.id, '--pairs', 'pairs.json', '--mission', 'm-5'], { docs: docsFor(g), runtime });
    assert.equal(r.code, 0, r.err);
    assert.equal(updates(g)[0].json().requests[1].replaceAllText.containsText.matchCase, true);
    assert.match(r.out, /- "Q2" -> "Q3": not found\nText not found is not in the document as written: copy it exactly from docs-get .* --format text/);
    const none = await run(docsReplace, [MINE.id, '--find', 'Q1', '--replace', 'x'], { docs: docsFor(google()) });
    assert.equal(none.code, 1, 'nothing changed is not success');
    assert.match(none.out, /^Nothing in "Weekly report" matched, so nothing changed\./);
  });

  test('a section rewrite from inline Markdown (a value starting with a dash goes after =)', async () => {
    const g = google();
    const r = await run(docsReplace, [MINE.id, '--section', 'status', '--text=- Q4 on track\n- Hiring two'], { docs: docsFor(g) });
    assert.equal(r.code, 0, r.err);
    const sent = updates(g)[0].json();
    assert.equal(sent.writeControl.requiredRevisionId, 'rev-9');
    assert.deepEqual(sent.requests[0], { deleteContentRange: { range: { startIndex: 8, endIndex: 20 } } });
    assert.deepEqual(sent.requests[1], { insertText: { location: { index: 8 }, text: 'Q4 on track\nHiring two\n' } });
    assert.match(r.out, /^Rewrote the section "Status" of "Weekly report": removed 12 characters, wrote 2 paragraphs\./);
  });

  test('an unknown heading lists the headings', async () => {
    const r = await run(docsReplace, [MINE.id, '--section', 'Budget', '--text', 'x'], { docs: docsFor(google()) });
    assert.equal(r.code, 1);
    assert.match(r.err, /"Budget" is not a heading in it\. The document's headings: "Status", "Next"/);
  });

  test('mistakes are refused before any call', async () => {
    const g = google();
    for (const argv of [
      [MINE.id], [MINE.id, '--find', 'a'], [MINE.id, '--replace', 'b'], [MINE.id, '--find', 'a', '--replace', 'b', '--section', 'S', '--text', 'x'],
      [MINE.id, '--pairs', 'p.json'], [MINE.id, '--section', 'S'], [MINE.id, '--section', 'S', '--with', 'a.md'], [MINE.id, '--find', 'a', '--replace', 'b', '--tab', 't.0'],
    ]) {
      assert.equal((await run(docsReplace, argv, { docs: docsFor(g) })).code, 2, argv.join(' '));
    }
    assert.equal(g.calls.length, 0);
    assert.throws(() => docsReplace.parsePairs('[{"find": ""}]'), /pair 1 needs "find"/);
    assert.equal((await run(docsReplace, ['--help'])).code, 0);
  });
});
