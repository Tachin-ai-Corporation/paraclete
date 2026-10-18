// Tests for agent/gateway/images.mjs: images recognized by their bytes, their size read from the
// header, and the retention rule that keeps only the most recent images attached in a turn.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sniffImage, imageDimensions, isTranscriptImage, retainImages, VIEWABLE_IMAGE_TYPES,
} from '../../../agent/gateway/images.mjs';
import { pngHeader, jpegHeader, webpHeader } from './fakes.mjs';

// A real 1x1 PNG, decodable end to end.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

describe('sniffImage', () => {
  it('names PNG, JPEG and WebP as viewable, and GIF as recognized but not viewable', () => {
    assert.deepEqual(sniffImage(PNG_1X1), { mimeType: 'image/png', kind: 'PNG', viewable: true });
    assert.deepEqual(sniffImage(jpegHeader(4, 3)), { mimeType: 'image/jpeg', kind: 'JPEG', viewable: true });
    assert.deepEqual(sniffImage(webpHeader('VP8 ', 4, 3)), { mimeType: 'image/webp', kind: 'WebP', viewable: true });
    assert.deepEqual(sniffImage(Buffer.from('GIF89a\x02\x00\x01\x00', 'latin1')), { mimeType: 'image/gif', kind: 'GIF', viewable: false });
    assert.deepEqual(Object.keys(VIEWABLE_IMAGE_TYPES), ['image/png', 'image/jpeg', 'image/webp'], 'what every routed model accepts');
  });

  it('is null for anything else: text, PDF, a RIFF that is not WebP, a cut-off PNG signature, nothing', () => {
    for (const buf of [
      Buffer.from('# heading\n'), Buffer.from('%PDF-1.7'), Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(0),
    ]) {
      assert.equal(sniffImage(buf), null, buf.toString('latin1'));
    }
    assert.equal(sniffImage(undefined), null);
  });
});

describe('imageDimensions', () => {
  it('reads width and height from each header', () => {
    assert.deepEqual(imageDimensions(PNG_1X1, 'image/png'), { width: 1, height: 1 });
    assert.deepEqual(imageDimensions(pngHeader(1920, 1080), 'image/png'), { width: 1920, height: 1080 });
    assert.deepEqual(imageDimensions(jpegHeader(640, 480), 'image/jpeg'), { width: 640, height: 480 });
    assert.deepEqual(imageDimensions(webpHeader('VP8 ', 300, 200), 'image/webp'), { width: 300, height: 200 });
    assert.deepEqual(imageDimensions(webpHeader('VP8L', 300, 200), 'image/webp'), { width: 300, height: 200 });
    assert.deepEqual(imageDimensions(webpHeader('VP8X', 9000, 200), 'image/webp'), { width: 9000, height: 200 });
    assert.deepEqual(imageDimensions(Buffer.from('GIF89a\x02\x00\x01\x00', 'latin1'), 'image/gif'), { width: 2, height: 1 });
  });

  it('skips fill bytes and segments before the JPEG frame header', () => {
    const jpeg = jpegHeader(800, 600);
    const withFill = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff]), jpeg.subarray(2)]);
    assert.deepEqual(imageDimensions(withFill, 'image/jpeg'), { width: 800, height: 600 });
  });

  it('is null for a damaged or cut-off header, which a model would reject', () => {
    assert.equal(imageDimensions(pngHeader(10, 10).subarray(0, 20), 'image/png'), null, 'cut inside IHDR');
    assert.equal(imageDimensions(pngHeader(0, 10), 'image/png'), null, 'zero width');
    assert.equal(imageDimensions(jpegHeader(10, 10).subarray(0, 22), 'image/jpeg'), null, 'no frame header');
    assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08]), 'image/jpeg'), null, 'scan before frame');
    assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56]), 'image/jpeg'), null, 'garbage after SOI');
    const badVp8 = webpHeader('VP8 ', 10, 10);
    badVp8[23] = 0;
    assert.equal(imageDimensions(badVp8, 'image/webp'), null, 'no VP8 start code');
    assert.equal(imageDimensions(webpHeader('VP8X', 10, 10).subarray(0, 26), 'image/webp'), null);
    assert.equal(imageDimensions(PNG_1X1, 'image/tiff'), null, 'an unknown type');
  });
});

describe('isTranscriptImage', () => {
  it('takes a viewable type with base64 data, nothing else', () => {
    assert.equal(isTranscriptImage({ mimeType: 'image/png', data: 'AAAA' }), true);
    for (const bad of [null, {}, { mimeType: 'image/gif', data: 'AAAA' }, { mimeType: 'image/png', data: '' }, { mimeType: 'image/png', data: 7 }]) {
      assert.equal(isTranscriptImage(bad), false, JSON.stringify(bad));
    }
  });
});

describe('retainImages: only the most recent images stay attached', () => {
  const img = (name) => ({ mimeType: 'image/png', data: `data-${name}`, name });
  const view = (id, name) => [
    { role: 'assistant', content: null, toolCalls: [{ id, name: 'viewImage', args: { path: name } }] },
    { role: 'tool', toolCallId: id, name: 'viewImage', content: `Viewing ${name}`, images: [img(name)] },
  ];
  const transcript = [
    { role: 'user', content: 'compare the charts' },
    ...view('c1', 'a.png'),
    ...view('c2', 'b.png'),
    { role: 'user', content: '[WARNING] a nudge' },
    ...view('c3', 'c.png'),
  ];
  const attached = (t) => t.flatMap((m) => (m.images || []).map((i) => i.name));

  it('keeps the newest `kept`, takes the older ones off, and says so in their text', () => {
    const out = retainImages(transcript, 2);
    assert.deepEqual(attached(out), ['b.png', 'c.png']);
    const dropped = out[2];
    assert.equal('images' in dropped, false);
    assert.equal(dropped.content, 'Viewing a.png\n[the image of a.png is no longer attached: in one turn only the 2 most recent images viewed stay attached. Call viewImage again to look at it again.]');
    assert.equal(dropped.toolCallId, 'c1', 'the message keeps its place and pairing');
  });

  it('is pure: the input is unchanged, and messages with nothing to change are the same objects', () => {
    const before = structuredClone(transcript);
    const out = retainImages(transcript, 2);
    assert.deepEqual(transcript, before);
    assert.equal(out.length, transcript.length);
    for (const i of [0, 1, 3, 4, 5, 6, 7]) assert.equal(out[i], transcript[i], `message ${i}`);
    assert.notEqual(out[2], transcript[2]);
  });

  it('changes nothing when the images fit, and is stable when applied again', () => {
    assert.deepEqual(retainImages(transcript, 3), transcript);
    const once = retainImages(transcript, 1);
    assert.deepEqual(retainImages(once, 1), once);
    assert.deepEqual(attached(once), ['c.png']);
    assert.match(once[2].content, /only the most recent image viewed stays attached/);
  });

  it('keeps the newest images of a message that carries several', () => {
    const many = [{ role: 'tool', toolCallId: 'x', name: 'shots', content: 'three shots', images: [img('1.png'), img('2.png'), img('3.png')] }];
    const out = retainImages(many, 2);
    assert.deepEqual(attached(out), ['2.png', '3.png']);
    assert.match(out[0].content, /the image of 1\.png is no longer attached/);
    const none = retainImages([{ ...many[0], images: [{ mimeType: 'image/png', data: 'x' }, { mimeType: 'image/png', data: 'y' }] }, ...view('c9', 'z.png')], 1);
    assert.match(none[0].content, /these images are no longer attached: .* look at them again/);
  });
});
