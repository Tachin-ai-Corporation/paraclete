// agent/gateway/images.mjs: what the gateway knows about images, so an organ can look at one as
// pixels. It recognizes an image file by its first bytes, reads its size in pixels from its header (no
// decoder and no npm package), and keeps a turn's transcript from carrying every image the organ ever
// viewed. It reads no files and calls no model: the viewImage tool (tools.mjs) reads the file and uses
// the recognition; turn-loop.mjs applies the retention rule after each tool call; google-step.mjs and
// anthropic-step.mjs put the images still attached into each provider's request.
//
// Only types every model the gateway routes to accepts are viewable: PNG, JPEG and WebP. Gemini's
// multimodal function responses take exactly those image types; Claude takes them and GIF. A GIF is
// recognized only so the refusal can route it to a conversion: a GIF in the transcript would make a
// fallback from Claude to Gemini replay an image Gemini rejects, and the turn would fail twice.

/** The image types an organ can view, with the name a tool result uses for each. */
export const VIEWABLE_IMAGE_TYPES = Object.freeze({
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
});

// Magic bytes. GIF is listed so it is recognized, and then refused with a route.
const SIGNATURES = [
  { mimeType: 'image/png', kind: 'PNG', test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mimeType: 'image/jpeg', kind: 'JPEG', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mimeType: 'image/webp', kind: 'WebP', test: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { mimeType: 'image/gif', kind: 'GIF', test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) },
];

function startsWith(buf, bytes) {
  return buf.length >= bytes.length && bytes.every((v, i) => buf[i] === v);
}

/**
 * The image type a buffer's first bytes name, whether or not it is viewable.
 *
 * @param {Buffer} buf
 * @returns {{mimeType: string, kind: string, viewable: boolean}|null} null when it is not a known image
 */
export function sniffImage(buf) {
  if (!buf || buf.length === 0) return null;
  const hit = SIGNATURES.find((s) => s.test(buf));
  return hit ? { mimeType: hit.mimeType, kind: hit.kind, viewable: Object.hasOwn(VIEWABLE_IMAGE_TYPES, hit.mimeType) } : null;
}

/**
 * An image's size in pixels, read from its header. Null when the header is cut off or damaged: such a
 * file is refused before a model sees it, because a provider that cannot decode an image rejects the
 * whole request, on the fallback model too.
 *
 * @param {Buffer} buf
 * @param {string} mimeType from sniffImage()
 * @returns {{width: number, height: number}|null}
 */
export function imageDimensions(buf, mimeType) {
  try {
    switch (mimeType) {
      // The IHDR chunk comes first: its length and type after the 8-byte signature, then width, height.
      case 'image/png':
        if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
        return size(buf.readUInt32BE(16), buf.readUInt32BE(20));
      case 'image/jpeg':
        return jpegDimensions(buf);
      case 'image/webp':
        return webpDimensions(buf);
      case 'image/gif':
        if (buf.length < 10) return null;
        return size(buf.readUInt16LE(6), buf.readUInt16LE(8));
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function size(width, height) {
  return width > 0 && height > 0 ? { width, height } : null;
}

// Walks the segments to the first start-of-frame marker, which holds the height and then the width.
function jpegDimensions(buf) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // markers with no length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data before any frame header
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > buf.length) return null;
      return size(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
    }
    i += 2 + length;
  }
  return null;
}

// The first chunk after the 12-byte RIFF header: VP8X (extended), VP8L (lossless) or 'VP8 ' (lossy).
function webpDimensions(buf) {
  const chunk = buf.length >= 16 ? buf.toString('latin1', 12, 16) : '';
  if (chunk === 'VP8X') {
    if (buf.length < 30) return null;
    return size(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
  }
  if (chunk === 'VP8L') {
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8 ') {
    if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return size(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  return null;
}

/**
 * Whether a value is an image the transcript can carry: a viewable type and base64 data.
 *
 * @param {*} image
 * @returns {boolean}
 */
export function isTranscriptImage(image) {
  return Boolean(image) && typeof image.data === 'string' && image.data.length > 0
    && Object.hasOwn(VIEWABLE_IMAGE_TYPES, image.mimeType);
}

/**
 * The retention rule: only the `kept` most recent images stay attached to their tool messages. Every
 * request in a turn resends the whole transcript, so an image left attached is paid for, in tokens and
 * request bytes, on every later step. An older image is taken off its tool message, and the message's
 * text says so and how to see it again, so the model never takes a missing image for one it is still
 * looking at. Pure: returns a new array, and messages with nothing to change are the same objects.
 *
 * @param {Array<object>} transcript turn-loop.mjs's transcript; tool messages may carry `images`
 * @param {number} kept a positive integer
 * @returns {Array<object>}
 */
export function retainImages(transcript, kept) {
  const out = [...transcript];
  let seen = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (!Array.isArray(msg?.images) || msg.images.length === 0) continue;
    const room = Math.max(0, kept - seen);
    if (msg.images.length <= room) {
      seen += msg.images.length;
      continue;
    }
    const stay = room > 0 ? msg.images.slice(msg.images.length - room) : [];
    const gone = msg.images.slice(0, msg.images.length - room);
    seen += stay.length;
    const { images: _all, ...rest } = msg;
    out[i] = { ...rest, content: `${textOf(msg.content)}\n${droppedNote(gone, kept)}`, ...(stay.length ? { images: stay } : {}) };
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function droppedNote(gone, kept) {
  const many = gone.length > 1;
  const names = gone.map((img) => img.name).filter(Boolean);
  const what = names.length
    ? `${many ? 'the images of' : 'the image of'} ${names.join(', ')} ${many ? 'are' : 'is'}`
    : (many ? 'these images are' : 'this image is');
  const rule = kept === 1 ? 'only the most recent image viewed stays attached' : `only the ${kept} most recent images viewed stay attached`;
  return `[${what} no longer attached: in one turn ${rule}. Call viewImage again to look at ${many ? 'them' : 'it'} again.]`;
}
