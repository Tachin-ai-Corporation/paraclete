// agent/files/shared-files.mjs: the block that tells an organ which files a person shared with a
// request, and the exact file-get command that brings each into the mission's inbox. The brain puts
// it in a new mission's context and in a resumed mission's reply (services/brain/intake-handlers.mjs);
// a task message can render it from the mission's `context.inbound_files` the same way. It also reads
// an upload's id from its object path, the id of the upload's `files` record.

/** An upload's object path names its upload id: <prefix>in/<u-<ms>-<8 hex>>/<name>. */
const UPLOAD_IN_PATH = /(?:^|\/)in\/(u-\d+-[0-9a-f]{8})\//;

/**
 * The upload id in an incoming file's object path, or null.
 *
 * @param {string} gcsPath e.g. files/in/u-1760000000000-1a2b3c4d/report.pdf
 * @returns {string|null}
 */
export function uploadIdOf(gcsPath) {
  return UPLOAD_IN_PATH.exec(String(gcsPath ?? ''))?.[1] ?? null;
}

/** An argument as the shell reads it back unchanged: quoted only when it needs to be. */
export function shellArg(text) {
  const s = String(text);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The files a person shared, as a block an organ reads: each with the exact command that fetches it.
 *
 * @param {Array<{name: string, size?: number, gcsPath?: string}>} attachments
 * @param {string} [missionId] the mission that takes them; without it the command names a placeholder
 * @returns {string} '' when there are none
 */
export function sharedFilesBlock(attachments, missionId = null) {
  const files = (attachments || []).filter((a) => a && a.name);
  if (files.length === 0) return '';
  const mission = missionId ? shellArg(missionId) : "<this mission's id>";
  const lines = files.map((a) => {
    const size = a.size ? ` (${a.size} bytes)` : '';
    return a.gcsPath
      ? `- ${a.name}${size}: \`file-get --mission ${mission} ${shellArg(a.gcsPath)}\``
      : `- ${a.name}${size}: no stored copy`;
  });
  return [
    '## Files shared with this request',
    'They are stored with the request, not yet on this host. Fetch each into the mission\'s inbox with the command shown (the files skill), then read it with `file-read <the path file-get prints>`.',
    ...lines,
  ].join('\n');
}

/**
 * Two lists of shared files as one, each object once (by gcsPath, or by name when it has none).
 *
 * @param {Array<object>} earlier
 * @param {Array<object>} later
 * @returns {Array<{name: string, size: number, gcsPath: string}>}
 */
export function mergeSharedFiles(earlier, later) {
  const out = [];
  const seen = new Set();
  for (const a of [...(earlier || []), ...(later || [])]) {
    if (!a || !a.name) continue;
    const key = a.gcsPath || `name:${a.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: a.name, size: Number(a.size) || 0, gcsPath: a.gcsPath || '' });
  }
  return out;
}
