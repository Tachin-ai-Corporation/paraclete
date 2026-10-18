#!/usr/bin/env node
// skills/drive/drive-find.mjs: the drive-find command. Searches the Drive files the agent's Drive
// identity can see (shared with it, or in a shared drive it belongs to) by words in the content or the
// name, type, folder or shared drive, and prints each match's name, type, id, owner and link. `--whoami`
// prints the identity people share files with; `--drives` lists the shared drives it belongs to. The
// Drive calls are agent/providers/drive.mjs. Documented in skills/drive/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createDriveClient, parseDriveLink, describeType, GOOGLE_TYPES, FOLDER_MIME } from '../../agent/providers/drive.mjs';
import { contentTypeFor } from '../../agent/storage/file-store.mjs';

export const USAGE = [
  'Usage: drive-find [<words>] [--name <words>] [--type <type>] [--folder <drive folder link or id>] [--drive <shared drive id>] [--shared-with-me] [--limit <n>] [--json]',
  '       drive-find --whoami',
  '       drive-find --drives',
  '<type> is doc, sheet, slides, folder, pdf, docx, xlsx, pptx, csv, or a MIME type.',
].join('\n');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/** The short type names --type takes, beyond file extensions and MIME types. */
const TYPE_NAMES = Object.freeze({ doc: GOOGLE_TYPES.document, sheet: GOOGLE_TYPES.spreadsheet, slides: GOOGLE_TYPES.presentation, folder: FOLDER_MIME });

/**
 * The MIME type a --type value names, or null.
 *
 * @param {string} type
 * @returns {string|null}
 */
export function mimeTypeFor(type) {
  const t = String(type || '').trim().toLowerCase();
  if (TYPE_NAMES[t]) return TYPE_NAMES[t];
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t)) return t;
  const byExtension = /^[a-z0-9]{2,5}$/.test(t) ? contentTypeFor(`file.${t}`) : null;
  return byExtension && byExtension !== 'application/octet-stream' ? byExtension : null;
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { whoami } | { drives } | { search: {...}, json } | { error }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        name: { type: 'string' }, type: { type: 'string' }, folder: { type: 'string' }, drive: { type: 'string' },
        'shared-with-me': { type: 'boolean' }, limit: { type: 'string' }, json: { type: 'boolean' },
        whoami: { type: 'boolean' }, drives: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const json = values.json === true;
  if (values.whoami) return { whoami: true, json };
  if (values.drives) return { drives: true, json };

  const search = { query: positionals.join(' ').trim() || undefined, name: values.name, sharedWithMe: values['shared-with-me'] === true };
  if (values.type !== undefined) {
    search.mimeType = mimeTypeFor(values.type);
    if (!search.mimeType) return { error: `--type '${values.type}' is not a type: doc, sheet, slides, folder, pdf, docx, xlsx, pptx, csv, or a MIME type` };
  }
  if (values.folder !== undefined) {
    search.folderId = parseDriveLink(values.folder);
    if (!search.folderId) return { error: `'${values.folder}' is not a Drive folder link or id` };
  }
  if (values.drive !== undefined) {
    search.driveId = parseDriveLink(values.drive);
    if (!search.driveId) return { error: `'${values.drive}' is not a shared drive id` };
  }
  search.limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { error: `--limit must be a whole number from 1 to ${MAX_LIMIT}` };
    search.limit = n;
  }
  return { search, json };
}

/** One match, plainly: name, type, id, modified, owner, then its link. */
function line(file, i) {
  const owner = file.owners?.[0];
  const parts = [
    `${i + 1}. ${file.name}`,
    describeType(file.mimeType),
    `id ${file.id}`,
    file.modifiedTime ? `modified ${String(file.modifiedTime).slice(0, 10)}` : null,
    owner ? `owner ${owner.displayName ? `${owner.displayName} <${owner.emailAddress}>` : owner.emailAddress}` : (file.driveId ? `shared drive ${file.driveId}` : null),
  ].filter(Boolean);
  return `${parts.join(' | ')}${file.webViewLink ? `\n   ${file.webViewLink}` : ''}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance
 * @param {object} [deps.drive]   from createDriveClient()
 * @returns {Promise<number>} 0, 1 when Drive refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`drive-find: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const drive = deps.drive || (() => {
      const runtime = deps.runtime || createCliRuntime({ stderr });
      return createDriveClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    })();
    const me = drive.identity();
    const print = (human, data) => stdout.write(`${args.json ? JSON.stringify(data, null, 2) : human}\n`);

    if (args.whoami) {
      const human = me.kind === 'workspace'
        ? `You act on Drive as your own Google Workspace account, ${me.email}. People share files with that address; you create new files in its My Drive or in a folder shared with it as Editor.`
        : `You act on Drive as the service account ${me.email}. People share files and folders with that address; you create new files only inside a shared drive it is a member of.`;
      print(human, me);
      return 0;
    }

    if (args.drives) {
      const drives = await drive.listSharedDrives();
      print(drives.length
        ? [`${me.email} is a member of ${drives.length} shared drive${drives.length === 1 ? '' : 's'}:`,
          ...drives.map((d) => `- ${d.name} | id ${d.id} | ${d.canAddChildren ? 'can add files' : 'read only: cannot add files'}`)].join('\n')
        : `${me.email} is a member of no shared drive.`, { identity: me, shared_drives: drives });
      return 0;
    }

    const found = await drive.find(args.search);
    if (args.json) {
      print(null, { identity: me, files: found.files, capped: found.capped, incomplete: found.incomplete });
      return 0;
    }
    const lines = found.files.length
      ? [`${found.files.length} file${found.files.length === 1 ? '' : 's'} that ${me.email} can see:`, ...found.files.map(line)]
      : [`No files found that ${me.email} can see. A file that exists but is not listed has not been shared with ${me.email}.`];
    if (found.capped) lines.push(`More files match: narrow the search, or raise --limit (at most ${MAX_LIMIT}).`);
    if (found.incomplete) lines.push('Drive did not search every shared drive; search one with --drive <shared drive id> to be sure.');
    print(lines.join('\n'));
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
