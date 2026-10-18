// Tests for agent/files/slides.mjs: a presentation's slides in presentation order, with titles, text,
// tables, picture descriptions and speaker notes, read from the .pptx XML.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNotesXml, parseSlideXml, readPptx, readSlides, renderSlide } from '../../../agent/files/slides.mjs';
import { fakeRunner, scratch, zipBytes } from './helpers.mjs';

const dir = scratch('slides-test-');
after(() => dir.cleanup());

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const shape = (ph, ...paras) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.map((p) => `<a:p><a:pPr/>${p}</a:p>`).join('')}</p:txBody></p:sp>`;
const run = (t) => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`;

const SLIDE_ONE = `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${shape('ctrTitle', run('Q3 &amp; Q4 Review'))}${shape(null, run('Revenue up'), `${run('Costs')}${run(' flat')}`, '<a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld>')}<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture" descr="Revenue chart"/></p:nvPicPr></p:pic></p:spTree></p:cSld></p:sld>`;
const SLIDE_TWO = `<?xml version="1.0"?><p:sld ${NS} show="0"><p:cSld><p:spTree>${shape('title', run('Regions'))}<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p>${run('North')}</a:p></a:txBody></a:tc><a:tc><a:txBody><a:p>${run('120')}</a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`;
const NOTES = `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${shape('sldImg')}${shape('body', run('Mention the &lt;new&gt; office'))}${shape('sldNum', run('2'))}</p:spTree></p:cSld></p:notes>`;

function deck() {
  // slide2.xml is shown first: order comes from the presentation's slide list, not the file names.
  return zipBytes({
    '[Content_Types].xml': '<Types/>',
    'ppt/presentation.xml': `<p:presentation ${NS}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Target="slides/slide2.xml" Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>',
    'ppt/slides/slide1.xml': SLIDE_ONE,
    'ppt/slides/slide2.xml': SLIDE_TWO,
    'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide7.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide7.xml': NOTES,
  });
}

test('a slide gives its title, its text in order, pictures by description, and no slide numbers', () => {
  assert.deepEqual(parseSlideXml(SLIDE_ONE), { title: 'Q3 & Q4 Review', lines: ['Revenue up', 'Costs flat', '[image: Revenue chart]'], hidden: false });
  assert.deepEqual(parseSlideXml(SLIDE_TWO), { title: 'Regions', lines: ['North | 120'], hidden: true });
  assert.deepEqual(parseNotesXml(NOTES), ['Mention the <new> office']);
});

test('slides come in presentation order, with the notes each links to', () => {
  const slides = readPptx(dir.file('deck.pptx', deck()));
  assert.deepEqual(slides.map((s) => [s.number, s.title, s.notes]), [[1, 'Regions', ['Mention the <new> office']], [2, 'Q3 & Q4 Review', []]]);
});

test('without a usable slide list, slide parts are read by number', () => {
  const path = dir.file('bare.pptx', zipBytes({
    'ppt/presentation.xml': `<p:presentation ${NS}/>`,
    'ppt/slides/slide10.xml': SLIDE_TWO,
    'ppt/slides/slide2.xml': SLIDE_ONE,
  }));
  assert.deepEqual(readPptx(path).map((s) => s.title), ['Q3 & Q4 Review', 'Regions']);
  assert.throws(() => readPptx(dir.file('not.pptx', zipBytes({ 'word/document.xml': '<w/>' }))), /not a PowerPoint presentation/);
});

test('a .ppt or .odp is read through LibreOffice', async () => {
  const runner = fakeRunner({ soffice: (args) => { writeFileSync(join(args[args.indexOf('--outdir') + 1], 'old.pptx'), deck()); } });
  const slides = await readSlides(dir.file('old.odp', 'x'), 'odp', { runner });
  assert.equal(slides.length, 2);
  assert.equal(runner.calls[0].args[runner.calls[0].args.indexOf('--convert-to') + 1], 'pptx');
});

test('a slide renders as Markdown or plain text', () => {
  const slide = { number: 3, title: 'Plan', lines: ['One', 'Two\nlines'], notes: ['Say hi'], hidden: true };
  assert.equal(renderSlide(slide, 'md'), '## Slide 3: Plan (hidden)\n\n- One\n- Two lines\n\n> Notes: Say hi');
  assert.equal(renderSlide(slide, 'text'), 'Slide 3: Plan (hidden)\nOne\nTwo\nlines\nNotes:\nSay hi');
  assert.equal(renderSlide({ number: 1, title: '', lines: [], notes: [], hidden: false }, 'md'), '## Slide 1\n\n(no text)');
});
