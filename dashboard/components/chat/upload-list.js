// dashboard/components/chat/upload-list.js: the composer's files, apart from how they look and how they
// travel. Each file the person adds becomes an item that goes uploading -> done (it carries the
// attachment the server answered) or failed (with why, in words). These functions say what the list
// adds up to (can the message go, and with which files), turn a failed PUT into a reason, and read
// files out of a drop. Pure: no React, no network. Used by use-uploads.js, Composer.jsx and ChatView.jsx.

/** The most files one message carries: the server's MAX_ATTACHMENTS (lib/server/uploads.mjs). */
export const MAX_FILES = 10;

/**
 * A new item for a file the person added.
 *
 * @param {{name: string, size: number, type?: string}} file  a browser File
 * @param {string} key  unique within the list
 * @returns {object}
 */
export function newItem(file, key) {
  return { key, file, name: file.name, size: file.size, status: 'uploading', loaded: 0, error: null, attachment: null };
}

/**
 * What the list adds up to for the Send button.
 *
 * @param {object[]} items
 * @returns {{running: number, failed: number, attachments: Array<{name: string, size: number, gcsPath: string}>,
 *   blocked: string|null}} `blocked` says why the message cannot go yet, or null
 */
export function uploadSummary(items) {
  const running = items.filter((item) => item.status === 'uploading').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const attachments = items.filter((item) => item.status === 'done' && item.attachment).map((item) => item.attachment);
  let blocked = null;
  if (running) blocked = running === 1 ? 'a file is still uploading' : `${running} files are still uploading`;
  else if (failed) blocked = failed === 1 ? 'a file did not upload: remove it or try it again' : `${failed} files did not upload: remove them or try them again`;
  else if (items.length > MAX_FILES) blocked = `a message carries at most ${MAX_FILES} files`;
  return { running, failed, attachments, blocked };
}

/**
 * How far an upload has got, as a whole percentage.
 *
 * @param {number} loaded
 * @param {number} total
 * @returns {number} 0 to 100
 */
export function percent(loaded, total) {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
}

/**
 * Why the bucket refused a PUT, in words. Cloud Storage answers XML (`<Error><Code>...</Code>
 * <Message>...</Message></Error>`); status 0 means the request never got an answer the page may read,
 * which is a network failure or the bucket's CORS setting not allowing this dashboard.
 *
 * @param {number} status
 * @param {string} [body]
 * @returns {string}
 */
export function putFailure(status, body = '') {
  if (!status) return 'the upload could not reach the bucket: the connection failed, or the bucket does not accept uploads from this dashboard (its CORS setting)';
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1] || '';
  if (code === 'SignatureDoesNotMatch') return 'the bucket refused the upload link (its signature did not match)';
  if (code === 'ExpiredToken' || /expired/i.test(code)) return 'the upload link expired before the file was sent; try it again';
  if (code === 'EntityTooLarge') return 'the bucket refused the file as too large';
  if (status === 403) return `the bucket refused the upload (HTTP 403${code ? `, ${code}` : ''})`;
  return `the bucket answered HTTP ${status}${code ? ` (${code})` : ''}`;
}

/**
 * Whether a drag carries files (and not, say, selected text).
 *
 * @param {{types?: ArrayLike<string>}|null} dataTransfer
 * @returns {boolean}
 */
export function draggingFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files');
}

/**
 * The files a drop or a file picker holds, as an array.
 *
 * @param {{length: number}|null} fileList
 * @returns {object[]}
 */
export function filesOf(fileList) {
  return Array.from(fileList || []).filter((file) => file && typeof file.name === 'string');
}
