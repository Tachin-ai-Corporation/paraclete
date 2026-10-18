// dashboard/components/settings/drive-settings.js: the Drive item of the Setup tab, as data. Two jobs,
// both pure (no React, no fetching), used by DriveCard.jsx and setup-checklist.js:
//   - parseDriveFolder: what an admin pasted as the output folder (a Drive folder link, or its id) to
//     the id PATCH /api/settings/drive stores;
//   - driveCheckView: the drive_check command's result (agent/services/control/README.md) as plain
//     sentences: who the agent is on Drive, whether Drive answers, what is shared with it, its shared
//     drives, the output folder's state, and the advice it gave.

/** A Drive id: what lib/server/settings.mjs DRIVE_ID accepts. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;

/** Hosts a Drive folder link may come from. */
const DRIVE_HOSTS = new Set(['drive.google.com']);

/**
 * The folder id in what someone pasted: a link such as https://drive.google.com/drive/folders/<id>
 * (with /u/<n>/, a query string or a resource key), https://drive.google.com/open?id=<id>, or the bare
 * id. Empty input clears the setting. Links to a file or a Docs editor are refused, with why.
 *
 * @param {string} input
 * @returns {{id: string|null, error: string|null}}
 */
export function parseDriveFolder(input) {
  const text = String(input ?? '').trim();
  if (!text) return { id: null, error: null };
  if (DRIVE_ID.test(text)) return { id: text, error: null };

  const generic = { id: null, error: 'Paste a Drive folder link or a folder id.' };
  if (!/[./]/.test(text)) return generic;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return generic;
  }
  if (/(^|\.)docs\.google\.com$/.test(url.hostname) || /\/file\/d\//.test(url.pathname)) {
    return { id: null, error: 'That is a link to a file, not a folder. Open the folder in Drive and copy its link.' };
  }
  if (!DRIVE_HOSTS.has(url.hostname)) return { id: null, error: 'That is not a Google Drive link.' };
  const inPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  const id = inPath || url.searchParams.get('id') || '';
  if (!DRIVE_ID.test(id)) return { id: null, error: 'No folder id found in that link. Open the folder in Drive and copy its link.' };
  return { id, error: null };
}

/**
 * The browser link to a Drive folder.
 *
 * @param {string} id
 * @returns {string}
 */
export function folderLink(id) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function identityText(identity) {
  const email = identity?.email || 'an unknown address';
  return identity?.kind === 'workspace' ? `its Google Workspace account, ${email}` : `its service account, ${email}`;
}

function sharedText(shared) {
  const count = Number(shared?.count) || 0;
  if (count === 0) return 'Nothing is shared with it yet.';
  const what = plural(count, 'file or folder is', 'files and folders are');
  return `${shared?.capped ? 'At least ' : ''}${what} shared with it.`;
}

function drivesText(drives) {
  if (!Array.isArray(drives) || drives.length === 0) return 'It is not a member of any shared drive.';
  const named = drives.map((d) => `${d?.name || d?.id}${d?.can_add_files === false ? ' (cannot add files)' : ''}`);
  return `It is a member of ${plural(drives.length, 'shared drive', 'shared drives')}: ${named.join(', ')}.`;
}

function folderText(folder) {
  if (!folder) return { text: 'No output folder is set.', problem: false };
  const name = folder.name ? `"${folder.name}"` : folder.id;
  const where = folder.drive_id ? ' in a shared drive' : '';
  // Writable, with an error: the test file went in but could not be removed again.
  if (folder.writable) return { text: `The output folder ${name}${where} can be written to${folder.error ? ` (${folder.error})` : ''}.`, problem: false };
  return { text: `The output folder ${name}${where} cannot be written to${folder.error ? `: ${folder.error}` : '.'}`, problem: true };
}

/**
 * The drive_check result as sentences, and whether it found a problem: Drive did not answer, or the
 * output folder cannot be written to. Nothing shared yet is not a problem.
 *
 * @param {object|null} result  { identity, reachable, error, shared_with_me, shared_drives, output_folder, advice }
 * @returns {{ok: boolean, headline: string, lines: Array<{label: string, text: string, problem: boolean}>,
 *   sample: Array<{id: string, name: string, owner: string|null}>, advice: string[]}|null}
 */
export function driveCheckView(result) {
  if (!result || typeof result !== 'object') return null;
  const advice = (Array.isArray(result.advice) ? result.advice : []).filter((line) => typeof line === 'string' && line.trim());
  const who = identityText(result.identity);
  if (!result.reachable) {
    const text = `It could not reach Drive as ${who}${result.error ? `: ${result.error}` : '.'}`;
    return { ok: false, headline: text, lines: [{ label: 'Drive', text, problem: true }], sample: [], advice };
  }
  const shared = sharedText(result.shared_with_me);
  const folder = folderText(result.output_folder);
  const sample = (Array.isArray(result.shared_with_me?.sample) ? result.shared_with_me.sample : [])
    .filter((file) => file && file.name)
    .map((file) => ({ id: String(file.id || file.name), name: String(file.name), owner: file.owner ? String(file.owner) : null }));
  const lines = [
    { label: 'Identity', text: `It reaches Drive as ${who}.`, problem: false },
    { label: 'Shared with it', text: shared, problem: false },
    { label: 'Shared drives', text: drivesText(result.shared_drives), problem: false },
    { label: 'Output folder', text: folder.text, problem: folder.problem },
  ];
  const ok = !folder.problem;
  const headline = ok ? `It reaches Drive as ${who}. ${shared}` : folder.text;
  return { ok, headline, lines, sample, advice };
}
