// agent/files/images.mjs: an image's size in pixels, read from its header (PNG, JPEG, GIF, WebP) or
// its markup (SVG), with no decoder. file-read reports it for an image, since an image has no text to
// read: the organ looks at the image itself with the gateway's viewImage tool. Converting images is
// converters.mjs's.

import { closeSync, openSync, readSync } from 'node:fs';

/** How much of a file is read to find its size. A JPEG's frame header can sit after large metadata. */
const HEAD_BYTES = 512 * 1024;

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function pngSize(b) {
  return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
}

function gifSize(b) {
  return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null;
}

function jpegSize(b) {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) { p += 1; continue; }
    const marker = b[p + 1];
    if (marker === 0xff) { p += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const length = b.readUInt16BE(p + 2);
    // Start-of-frame markers carry the size; 0xc4 (Huffman), 0xc8 and 0xcc (arithmetic) do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5) };
    }
    p += 2 + length;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

/** An SVG length in pixels: plain numbers and px only; percentages and other units say nothing. */
function svgLength(value) {
  const m = /^\s*([0-9.]+)\s*(px)?\s*$/.exec(value || '');
  return m ? Math.round(Number(m[1])) : null;
}

function svgSize(b) {
  const text = b.toString('utf8');
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attr = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  const width = svgLength(attr('width'));
  const height = svgLength(attr('height'));
  if (width && height) return { width, height };
  const box = (attr('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite)) return { width: Math.round(box[2]), height: Math.round(box[3]) };
  return null;
}

const READERS = { png: pngSize, jpg: jpegSize, gif: gifSize, webp: webpSize, svg: svgSize };

/**
 * An image's size in pixels.
 *
 * @param {string} path
 * @param {string} format one of png, jpg, gif, webp, svg (formats.mjs)
 * @returns {{width: number, height: number}|null} null when the header does not say
 */
export function imageSize(path, format) {
  const reader = READERS[format];
  if (!reader) return null;
  try {
    const size = reader(readHead(path));
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}
