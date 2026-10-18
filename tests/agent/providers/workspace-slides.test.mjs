// Tests for agent/providers/workspace-slides.mjs: a presentation read as text (titles, nested bullets,
// tables, images, speaker notes), the exact requests that build a deck from an outline, and the client:
// a new file made first, the slides and text in one change, each image on its own so one Google cannot
// fetch is reported instead of losing the deck, and notes written once the slides exist. It never
// changes an existing presentation. Google is a fake fetch.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlidesClient, presentationSlides, deckRequests, imageRequest, notesRequests, shapeLines, MAX_SLIDES,
} from '../../../agent/providers/workspace-slides.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import { INSTANCE, json, grpcError, fakeTokens, fakeGoogle } from './workspace-fakes.mjs';

const text = (...paragraphs) => ({
  textElements: paragraphs.flatMap((p) => [
    { paragraphMarker: p.bullet ? { bullet: { nestingLevel: p.level || 0 } } : {} },
    { textRun: { content: `${p.text}\n` } },
  ]),
});

const DECK = {
  presentationId: '1DeckAbcdefghij',
  slides: [
    {
      objectId: 's1',
      pageElements: [
        { objectId: 'e1', shape: { placeholder: { type: 'CENTERED_TITLE' }, text: text({ text: 'Q3 review' }) } },
        { objectId: 'e2', shape: { placeholder: { type: 'SUBTITLE' }, text: text({ text: 'October 2026' }) } },
      ],
      slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: 'n1' }, pageElements: [{ objectId: 'n1', shape: { text: text({ text: 'Welcome everyone.' }) } }] } },
    },
    {
      objectId: 's2',
      pageElements: [
        { objectId: 'e3', shape: { placeholder: { type: 'TITLE' }, text: text({ text: 'Results' }) } },
        { objectId: 'e4', shape: { placeholder: { type: 'BODY' }, text: text({ text: 'Revenue up', bullet: true }, { text: 'mostly new accounts', bullet: true, level: 1 }) } },
        { objectId: 'e5', table: { tableRows: [{ tableCells: [{ text: text({ text: 'Region' }) }, { text: text({ text: 'Growth' }) }] }] } },
        { objectId: 'e6', image: {}, title: 'Chart of growth' },
        { objectId: 'g1', elementGroup: { children: [{ objectId: 'e7', shape: { text: text({ text: 'Grouped note' }) } }] } },
      ],
    },
  ],
};

describe('reading a presentation', () => {
  test('each slide\'s title, body lines, tables, images and speaker notes', () => {
    assert.deepEqual(presentationSlides(DECK), [
      { number: 1, id: 's1', title: 'Q3 review', lines: ['October 2026'], notes: 'Welcome everyone.' },
      { number: 2, id: 's2', title: 'Results', lines: ['- Revenue up', '  - mostly new accounts', '| Region | Growth |', '[image: Chart of growth]', 'Grouped note'], notes: '' },
    ]);
    assert.deepEqual(shapeLines({ text: { textElements: [{ textRun: { content: 'no marker\n' } }] } }), [{ text: 'no marker', bullet: false, nesting: 0 }]);
  });
});

describe('building a deck', () => {
  const OUTLINE = {
    title: 'Plan', subtitle: 'For the team',
    slides: [
      { title: 'Goals', bullets: [{ text: 'Grow', level: 0 }, { text: 'in the north', level: 1 }] },
      { title: 'Map', image: 'https://example.com/map.png' },
      { title: 'Both', bullets: [{ text: 'Left side', level: 0 }], image: 'https://example.com/b.png', notes: 'Say this.' },
    ],
  };

  test('a title slide, a slide per entry, then the slides the new file came with are removed', () => {
    const requests = deckRequests({ ...OUTLINE, existing: ['p'] });
    assert.deepEqual(requests.slice(0, 3), [
      { createSlide: { objectId: 'deck_title', insertionIndex: 0, slideLayoutReference: { predefinedLayout: 'TITLE' }, placeholderIdMappings: [{ layoutPlaceholder: { type: 'CENTERED_TITLE', index: 0 }, objectId: 'deck_title_t' }, { layoutPlaceholder: { type: 'SUBTITLE', index: 0 }, objectId: 'deck_title_s' }] } },
      { insertText: { objectId: 'deck_title_t', insertionIndex: 0, text: 'Plan' } },
      { insertText: { objectId: 'deck_title_s', insertionIndex: 0, text: 'For the team' } },
    ]);
    assert.deepEqual(requests.slice(3, 7), [
      { createSlide: { objectId: 'deck_s1', insertionIndex: 1, slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' }, placeholderIdMappings: [{ layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: 'deck_s1_t' }, { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: 'deck_s1_b' }] } },
      { insertText: { objectId: 'deck_s1_t', insertionIndex: 0, text: 'Goals' } },
      { insertText: { objectId: 'deck_s1_b', insertionIndex: 0, text: 'Grow\n\tin the north' } },
      { createParagraphBullets: { objectId: 'deck_s1_b', textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    ]);
    assert.equal(requests[7].createSlide.slideLayoutReference.predefinedLayout, 'TITLE_ONLY', 'an image slide has room under its title');
    const both = requests.find((r) => r.createShape);
    assert.equal(both.createShape.objectId, 'deck_s3_b', 'bullets beside an image go in a text box on the left');
    assert.deepEqual(both.createShape.elementProperties.transform, { scaleX: 1, scaleY: 1, translateX: 548640, translateY: 1234440, unit: 'EMU' });
    assert.deepEqual(requests.at(-1), { deleteObject: { objectId: 'p' } });
    assert.equal(deckRequests({ title: 'T', slides: [] })[0].createSlide.placeholderIdMappings.length, 1, 'no subtitle, no subtitle mapping');
  });

  test('images fill the slide, or sit beside the bullets', () => {
    assert.deepEqual(imageRequest(2, OUTLINE.slides[1]).createImage.elementProperties.size, { width: { magnitude: 7315200, unit: 'EMU' }, height: { magnitude: 3497580, unit: 'EMU' } });
    assert.equal(imageRequest(3, OUTLINE.slides[2]).createImage.elementProperties.transform.translateX, 5212080);
    assert.equal(imageRequest(2, OUTLINE.slides[1]).createImage.url, 'https://example.com/map.png');
  });

  test('notes go into each slide\'s speaker-notes shape once it exists', () => {
    const made = { slides: [{ objectId: 'deck_s3', slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: 'notes3' } } } }] };
    assert.deepEqual(notesRequests(made, OUTLINE.slides), [{ insertText: { objectId: 'notes3', insertionIndex: 0, text: 'Say this.' } }]);
  });
});

describe('the client', () => {
  const OUTLINE = {
    title: 'Plan',
    slides: [
      { title: 'Map', image: 'https://example.com/map.png', notes: 'Point at the north.' },
      { title: 'Broken', image: 'https://example.com/missing.png' },
    ],
  };

  function google() {
    const updates = [];
    const g = fakeGoogle([
      ['POST', '/drive/v3/files', (call) => json({ id: '1NewDeckAbcdefg', name: call.json().name, mimeType: call.json().mimeType })],
      ['GET', '/v1/presentations/1NewDeckAbcdefg', () => json({
        pageSize: { width: { magnitude: 9144000 }, height: { magnitude: 5143500 } },
        slides: updates.length ? [{ objectId: 'deck_s1', slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: 'n-s1' } } } }] : [{ objectId: 'p' }],
      })],
      ['POST', '/v1/presentations/1NewDeckAbcdefg:batchUpdate', (call) => {
        updates.push(call.json());
        return call.json().requests[0].createImage?.url.includes('missing')
          ? grpcError(400, 'INVALID_ARGUMENT', 'Invalid requests[0].createImage: There was a problem retrieving the image.')
          : json({ replies: [] });
      }],
    ]);
    return { ...g, updates };
  }

  test('makes a new file, builds it, places each image on its own, then writes the notes', async () => {
    const g = google();
    const slides = createSlidesClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });
    const result = await slides.create({ ...OUTLINE, folderId: '1FolderAbcdefghij' });
    assert.deepEqual(g.calls[0].json(), { name: 'Plan', mimeType: GOOGLE_TYPES.presentation, parents: ['1FolderAbcdefghij'] });
    assert.equal(g.calls[1].headers.Authorization, 'Bearer tok-presentations');
    assert.equal(g.updates.length, 4, 'the slides, two images, the notes');
    assert.deepEqual(g.updates[0].requests.at(-1), { deleteObject: { objectId: 'p' } });
    assert.deepEqual(g.updates[3], { requests: [{ insertText: { objectId: 'n-s1', insertionIndex: 0, text: 'Point at the north.' } }] });
    assert.equal(result.slideCount, 3);
    assert.equal(result.file.webViewLink, 'https://docs.google.com/presentation/d/1NewDeckAbcdefg/edit');
    assert.deepEqual(result.imageFailures, [{ slide: 3, url: 'https://example.com/missing.png', reason: 'Invalid requests[0].createImage: There was a problem retrieving the image.' }]);
    assert.ok(g.calls.every((c) => c.method !== 'PATCH' && c.method !== 'DELETE'), 'nothing existing is changed');
  });

  test('an outline longer than the limit is refused before a file is made', async () => {
    const g = google();
    const slides = createSlidesClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });
    await assert.rejects(slides.create({ title: 'Too long', slides: Array.from({ length: MAX_SLIDES + 1 }, () => ({ title: 'x' })) }), /at most 100 slides/);
    assert.equal(g.calls.length, 0);
  });
});
