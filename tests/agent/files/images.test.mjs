// Tests for agent/files/images.mjs: an image's size in pixels from its header.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../../../agent/files/images.mjs';
import { pngBytes, scratch } from './helpers.mjs';

const dir = scratch('images-test-');
after(() => dir.cleanup());

function jpeg(width, height) {
  // SOI, an APP0 segment to skip, then a baseline frame header.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8 + 3, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

function webp(chunk, body) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write(chunk, 12, 'latin1');
  body(b);
  return b;
}

test('reads the size of PNG, JPEG, GIF, WebP and SVG images', () => {
  assert.deepEqual(imageSize(dir.file('a.png', pngBytes(640, 480)), 'png'), { width: 640, height: 480 });
  assert.deepEqual(imageSize(dir.file('a.jpg', jpeg(1024, 768)), 'jpg'), { width: 1024, height: 768 });
  const gif = Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1');
  assert.deepEqual(imageSize(dir.file('a.gif', gif), 'gif'), { width: 32, height: 16 });
  const lossy = webp('VP8 ', (b) => { b.writeUInt16LE(300, 26); b.writeUInt16LE(200, 28); });
  assert.deepEqual(imageSize(dir.file('a.webp', lossy), 'webp'), { width: 300, height: 200 });
  const extended = webp('VP8X', (b) => { b.writeUIntLE(799, 24, 3); b.writeUIntLE(599, 27, 3); });
  assert.deepEqual(imageSize(dir.file('b.webp', extended), 'webp'), { width: 800, height: 600 });
  const lossless = webp('VP8L', (b) => { b[20] = 0x2f; b.writeUInt32LE((99) | (49 << 14), 21); });
  assert.deepEqual(imageSize(dir.file('c.webp', lossless), 'webp'), { width: 100, height: 50 });
  assert.deepEqual(imageSize(dir.file('a.svg', '<svg width="120px" height="80">'), 'svg'), { width: 120, height: 80 });
  assert.deepEqual(imageSize(dir.file('b.svg', '<svg viewBox="0 0 300 150" width="100%">'), 'svg'), { width: 300, height: 150 });
});

test('an unreadable header or an unknown format says nothing rather than guessing', () => {
  assert.equal(imageSize(dir.file('bad.png', Buffer.from([0x89, 0x50])), 'png'), null);
  assert.equal(imageSize(dir.file('x.svg', '<svg>'), 'svg'), null);
  assert.equal(imageSize(dir.file('x.bmp', 'BM'), 'bmp'), null);
});
