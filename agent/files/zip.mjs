// agent/files/zip.mjs: reads entries out of a ZIP container, the format Word, Excel and PowerPoint
// files (.docx, .xlsx, .pptx) and the OpenDocument files (.odt, .ods, .odp) are stored in. It lists
// entry names, which tell those formats apart (formats.mjs), and inflates single entries, which is how
// a presentation's slide text is read (slides.mjs). Reading only, with Node's zlib: nothing here
// writes a ZIP, and ZIP64 archives (over 4 GB or 65535 entries) are refused.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
/** The end record sits in the last 22 bytes plus a comment of at most 65535 bytes. */
const EOCD_SEARCH = EOCD_SIZE + 0xffff;
/** An entry larger than this when inflated is refused: an office file's XML is far smaller. */
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

/**
 * The entries of a ZIP file, from its central directory.
 *
 * @param {string} path
 * @returns {Array<{name: string, method: number, compressedSize: number, size: number, localOffset: number, encrypted: boolean}>}
 * @throws {Error} when the file is not a ZIP, is damaged, or is a ZIP64 archive
 */
export function listZipEntries(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < EOCD_SIZE) throw new Error('not a ZIP file: too short');
    const tailLength = Math.min(size, EOCD_SEARCH);
    const tail = readAt(fd, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a ZIP file: no end of central directory');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    if (cdOffset + cdSize > size) throw new Error('damaged ZIP file: the central directory lies outside the file');
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new Error('damaged ZIP file: bad central directory entry');
      const flags = cd.readUInt16LE(p + 8);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      entries.push({
        name: cd.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1'),
        method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localOffset: cd.readUInt32LE(p + 42),
        encrypted: Boolean(flags & 1),
      });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * One entry's bytes, inflated.
 *
 * @param {string} path
 * @param {{name: string, method: number, compressedSize: number, size: number, localOffset: number, encrypted: boolean}} entry
 * @param {{maxBytes?: number}} [opts]
 * @returns {Buffer}
 */
export function readZipEntry(path, entry, { maxBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
  if (entry.size > maxBytes) throw new Error(`${entry.name} is larger than ${maxBytes} bytes unpacked`);
  const fd = openSync(path, 'r');
  try {
    const header = readAt(fd, entry.localOffset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`damaged ZIP file: no local header for ${entry.name}`);
    const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = readAt(fd, start, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new Error(`${entry.name} uses ZIP compression method ${entry.method}, which is not supported`);
    try {
      return inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch (err) {
      throw new Error(`${entry.name} could not be unpacked: ${err.message}`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * A ZIP file opened for reading by entry name.
 *
 * @param {string} path
 * @param {{maxBytes?: number}} [opts] the largest entry read
 * @returns {{names: string[], has: (name: string) => boolean, read: (name: string) => Buffer|null, text: (name: string) => string|null}}
 */
export function openZip(path, opts = {}) {
  const entries = listZipEntries(path);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name) => (byName.has(name) ? readZipEntry(path, byName.get(name), opts) : null);
  return {
    names: entries.map((e) => e.name),
    has: (name) => byName.has(name),
    read,
    text: (name) => read(name)?.toString('utf8') ?? null,
  };
}
