// Tests for skills/workspace-slides/slides-get.mjs: a deck slide by slide with titles, text and notes,
// a selection of slides, notes left out on request, JSON, and the mistakes refused. Google is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as slidesGet from '../../../skills/workspace-slides/slides-get.mjs';
import { createSlidesClient } from '../../../agent/providers/workspace-slides.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';

const DECK_ID = '1DeckAbcdefghijklmnopqrs';
const text = (...lines) => ({ textElements: lines.flatMap((l) => [{ paragraphMarker: {} }, { textRun: { content: `${l}\n` } }]) });
const DECK = {
  presentationId: DECK_ID, title: 'Q3 review',
  slides: [
    { objectId: 's1', pageElements: [{ objectId: 't1', shape: { placeholder: { type: 'CENTERED_TITLE' }, text: text('Q3 review') } }] },
    {
      objectId: 's2',
      pageElements: [{ objectId: 't2', shape: { placeholder: { type: 'TITLE' }, text: text('Results') } }, { objectId: 'b2', shape: { placeholder: { type: 'BODY' }, text: text('Up 12%') } }],
      slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: 'n2' }, pageElements: [{ objectId: 'n2', shape: { text: text('Lead with this.', 'Then pause.') } }] } },
    },
  ],
};
const google = () => fakeGoogle([['GET', `/v1/presentations/${DECK_ID}`, () => json(DECK)]]);
const slidesFor = (g) => createSlidesClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

test('slide by slide, with speaker notes', async () => {
  const g = google();
  const r = await run(slidesGet, [`https://docs.google.com/presentation/d/${DECK_ID}/edit#slide=id.s2`], { slides: slidesFor(g) });
  assert.equal(r.code, 0, r.err);
  assert.equal(g.calls[0].headers.Authorization, 'Bearer tok-presentations');
  assert.equal(r.out, [
    `"Q3 review" | Google Slides | 2 slides | https://docs.google.com/presentation/d/${DECK_ID}/edit`,
    '',
    'Slide 1 (id s1): Q3 review',
    '',
    'Slide 2 (id s2): Results',
    '  Up 12%',
    '  Notes: Lead with this.',
    '         Then pause.',
    '',
  ].join('\n'));
});

test('some slides, without notes; JSON; mistakes', async () => {
  const r = await run(slidesGet, [DECK_ID, '--slides', '2', '--no-notes'], { slides: slidesFor(google()) });
  assert.match(r.out, /^"Q3 review" \| Google Slides \| 2 slides \(showing 2\)/);
  assert.doesNotMatch(r.out, /Slide 1|Notes/);
  const js = JSON.parse((await run(slidesGet, [DECK_ID, '--json'], { slides: slidesFor(google()) })).out);
  assert.equal(js.slides[1].notes, 'Lead with this.\nThen pause.');
  const tooFar = await run(slidesGet, [DECK_ID, '--slides', '9'], { slides: slidesFor(google()) });
  assert.equal(tooFar.code, 2);
  assert.match(tooFar.err, /slide 9 does not exist: there are 2 slides/);
  const g = google();
  for (const argv of [[], ['nope'], [DECK_ID, '--slides', 'all']]) assert.equal((await run(slidesGet, argv, { slides: slidesFor(g) })).code, 2, argv.join(' '));
  assert.equal(g.calls.length, 0);
  assert.equal((await run(slidesGet, ['--help'])).code, 0);
});
