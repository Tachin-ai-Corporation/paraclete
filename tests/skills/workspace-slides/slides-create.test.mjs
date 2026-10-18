// Tests for skills/workspace-slides/slides-create.mjs: outlines in JSON and Markdown read into slides,
// a deck built from inline JSON or a file in the mission tree, an image Google cannot fetch reported
// (the deck kept, the command failing), and outlines refused with the entry at fault. Google is a fake.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as slidesCreate from '../../../skills/workspace-slides/slides-create.mjs';
import { createSlidesClient } from '../../../agent/providers/workspace-slides.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import { INSTANCE, json, grpcError, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';
import { driveRuntime, WORKSPACE } from '../drive/fakes.mjs';

const NEW_ID = '1NewDeckAbcdefghijklmnop';
function google() {
  return fakeGoogle([
    ['POST', '/drive/v3/files', (call) => json({ id: NEW_ID, ...call.json() })],
    ['GET', `/v1/presentations/${NEW_ID}`, () => json({ slides: [{ objectId: 'p', slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: 'pn' } } } }, { objectId: 'deck_s1', slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: 'n1' } } } }] })],
    ['POST', `/v1/presentations/${NEW_ID}:batchUpdate`, (call) => (JSON.stringify(call.json()).includes('private.example.com')
      ? grpcError(400, 'INVALID_ARGUMENT', 'Invalid requests[0].createImage: There was a problem retrieving the image.')
      : json({ replies: [] }))],
  ]);
}
const slidesFor = (g) => createSlidesClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

describe('outlines', () => {
  test('Markdown: title, subtitle, slides with nested bullets, an image and notes', () => {
    assert.deepEqual(slidesCreate.parseMarkdownOutline([
      '# Q4 plan', 'For the leadership meeting', '', '## Where we are', '- Revenue up', '  - new accounts', 'Notes: Start here.', 'Notes: Then pause.',
      '', '## Pipeline', '![chart](https://example.com/p.png)', 'A plain line',
    ].join('\n')), {
      title: 'Q4 plan', subtitle: 'For the leadership meeting',
      slides: [
        { title: 'Where we are', bullets: [{ text: 'Revenue up', level: 0 }, { text: 'new accounts', level: 1 }], notes: 'Start here.\nThen pause.' },
        { title: 'Pipeline', bullets: [{ text: 'A plain line', level: 0 }], image: 'https://example.com/p.png' },
      ],
    });
  });

  test('JSON: bullets as text or { text, level }; bad entries named', () => {
    const outline = slidesCreate.parseJsonOutline(JSON.stringify({ title: 'T', slides: [{ title: 'A', bullets: ['x', { text: 'y', level: 2 }], image: '' }] }));
    assert.deepEqual(outline.slides, [{ title: 'A', bullets: [{ text: 'x', level: 0 }, { text: 'y', level: 2 }] }]);
    assert.throws(() => slidesCreate.parseJsonOutline('{"slides": [{"title": "A", "image": "file:///tmp/x.png"}]}'), /slide 1: image must be a public http\(s\) URL/);
    assert.throws(() => slidesCreate.parseJsonOutline('{"slides": [{}]}'), /slide 1 is empty/);
    assert.throws(() => slidesCreate.parseJsonOutline('{"slides": [{"title": "A", "bullets": "x"}]}'), /slide 1: bullets is a list/);
    assert.throws(() => slidesCreate.parseJsonOutline('{"title": "x"}'), /the outline is \{ "title"/);
  });
});

describe('slides-create', () => {
  test('from inline JSON into a folder: a new file, the slides, the notes', async () => {
    const g = google();
    const outline = { title: 'Q4 plan', slides: [{ title: 'Where we are', bullets: ['Revenue up'], notes: 'Start here.' }] };
    const r = await run(slidesCreate, ['--outline', JSON.stringify(outline), '--folder', '1FolderAbcdefghijklmnopq'], { slides: slidesFor(g) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(g.calls[0].json(), { name: 'Q4 plan', mimeType: GOOGLE_TYPES.presentation, parents: ['1FolderAbcdefghijklmnopq'] });
    const updates = g.calls.filter((c) => c.path.endsWith(':batchUpdate')).map((c) => c.json().requests);
    assert.equal(updates.length, 2, 'the slides, then the notes');
    assert.deepEqual(updates[1], [{ insertText: { objectId: 'n1', insertionIndex: 0, text: 'Start here.' } }]);
    assert.equal(r.out, [
      'Created the presentation "Q4 plan": 2 slides (a title slide and 1 more)',
      `id: ${NEW_ID}`,
      `link: https://docs.google.com/presentation/d/${NEW_ID}/edit`,
      'In Drive folder 1FolderAbcdefghijklmnopq: whoever can open that folder can open it.',
      `Check it with slides-get ${NEW_ID} before you hand it over.`,
      '',
    ].join('\n'));
  });

  test('from a Markdown file in the mission tree; an image Google cannot fetch fails the command but keeps the deck', async () => {
    const runtime = driveRuntime({ workspace: WORKSPACE });
    mkdirSync(join(runtime.paths.data.missions, 'm-4'), { recursive: true });
    writeFileSync(join(runtime.paths.data.missions, 'm-4', 'deck.md'), '# Plan\n\n## Map\n![map](https://private.example.com/map.png)\n');
    const g = google();
    const r = await run(slidesCreate, ['--from', 'deck.md', '--mission', 'm-4', '--title', 'Plan v2'], { slides: slidesFor(g), runtime });
    assert.equal(r.code, 1);
    assert.match(r.out, /^Created the presentation "Plan v2"/);
    assert.match(r.err, /the deck was made, but 1 image could not be placed:\n- slide 2: https:\/\/private\.example\.com\/map\.png: Invalid requests\[0\]\.createImage: There was a problem retrieving the image\./);
  });

  test('mistakes are refused before anything is made', async () => {
    const g = google();
    for (const argv of [[], ['--outline', '{"slides": []}', '--title', 'x'], ['--outline', 'not json'], ['--outline', '{"slides": [{"title": "a"}]}'], ['--from', 'deck.md'], ['--outline', '{}', '--folder', 'nope']]) {
      assert.equal((await run(slidesCreate, argv, { slides: slidesFor(g) })).code, 2, argv.join(' '));
    }
    assert.equal(g.calls.length, 0);
    assert.equal((await run(slidesCreate, ['--help'])).code, 0);
  });
});
