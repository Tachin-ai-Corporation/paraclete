#!/usr/bin/env node
// skills/drive/drive-put.mjs: the drive-put command. Hands a mission's result back through Drive: it
// uploads one local file as a NEW Drive file, as the agent's Drive identity, into a folder: the one
// given, else the admin's Drive output folder (config/settings drive_output_folder). With --convert it
// becomes a Google Doc, Sheet or Slides. Prints the new file's id and link. It only ever creates: it
// never overwrites, moves, renames or deletes a Drive file, and a file of the same name already in the
// folder is left as it is. A service account has no Drive storage of its own, so without a folder in a
// shared drive it refuses and says why. The Drive calls are agent/providers/drive.mjs. Documented in
// skills/drive/SKILL.md.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import {
  createDriveClient, parseDriveLink, conversionFor, describeType, CONVERT_TARGETS,
} from '../../agent/providers/drive.mjs';
import { contentTypeFor, sanitizeFileName } from '../../agent/storage/file-store.mjs';

export const USAGE = 'Usage: drive-put --mission <mission id> <path> [--folder <drive folder link or id>] [--name <name>] [--convert] [--json]';

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Names that hold credentials. They never leave the VM, whatever the path. */
const CREDENTIAL_NAME = /(\.pem|\.key|-key\.json)$|^\.env(\..*)?$|^\.gateway-token$|credentials[^/]*\.json$/i;

/**
 * The local file to send to Drive, checked: a relative path starts from the mission tree
 * (<missions root>/<mission id>); the file must exist, be a file, sit under the agent's data root once
 * links are resolved, not be a credential, and fit under the size cap.
 *
 * @param {string} path
 * @param {object} o
 * @param {string} o.mission
 * @param {object} o.paths      a runtime's paths (paths.data.root, paths.data.missions)
 * @param {number} o.maxBytes
 * @returns {{path: string, name: string, size: number, mimeType: string, bytes: Buffer}}
 */
export function localFile(path, { mission, paths, maxBytes }) {
  const base = join(paths.data.missions, mission);
  const full = isAbsolute(path) ? path : resolve(base, path);
  if (!existsSync(full)) throw new Error(`${full} does not exist${isAbsolute(path) ? '' : ` (a relative path starts from the mission tree ${base})`}`);
  const stat = statSync(full);
  if (!stat.isFile()) throw new Error(`${full} is not a file`);
  const real = realpathSync(full);
  const root = realpathSync(paths.data.root);
  const inside = relative(root, real);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${full} is outside the agent's data directory ${paths.data.root}; only files from the agent's own work can go to Drive`);
  if (CREDENTIAL_NAME.test(basename(real)) || /[\\/]keys[\\/]/.test(real)) throw new Error(`${full} holds credentials, which never leave the VM`);
  if (stat.size > maxBytes) throw new Error(`${full} is ${(stat.size / 1048576).toFixed(1)} MB, more than the ${(maxBytes / 1048576).toFixed(0)} MB a file sent to Drive may be`);
  const name = basename(full);
  return { path: full, name, size: stat.size, mimeType: contentTypeFor(name), bytes: readFileSync(full) };
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, mission?: string, path?: string, folder?: string|null, name?: string, convert?: boolean, json?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        mission: { type: 'string' }, folder: { type: 'string' }, name: { type: 'string' },
        convert: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.mission === undefined) return { error: '--mission <mission id> is required' };
  if (!MISSION_ID.test(values.mission)) return { error: `'${values.mission}' is not a mission id` };
  if (positionals.length !== 1) return { error: positionals.length ? `one file at a time, got ${positionals.length}` : 'the path of the file to upload is required' };
  let folder = null;
  if (values.folder !== undefined) {
    folder = parseDriveLink(values.folder);
    if (!folder) return { error: `'${values.folder}' is not a Drive folder link or id` };
  }
  if (values.name !== undefined && !values.name.trim()) return { error: '--name needs a name' };
  return { mission: values.mission, path: positionals[0], folder, name: values.name, convert: values.convert === true, json: values.json === true };
}

/** The admin's Drive output folder, or null. Read strictly: an outage is an error, not "none set". */
async function outputFolder(runtime) {
  try {
    const settings = await runtime.db.read(`${runtime.collections.config}/settings`, { strict: true });
    const id = settings?.drive_output_folder;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch (err) {
    throw new Error(`cannot read the Drive output folder setting (${err.message}); pass --folder <drive folder link or id>`);
  }
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): contracts, paths, db, collections
 * @param {object} [deps.drive]   from createDriveClient()
 * @returns {Promise<number>} 0, 1 when Drive, the disk or the setting refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`drive-put: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const drive = deps.drive || createDriveClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const file = localFile(args.path, { mission: args.mission, paths: runtime.paths, maxBytes: runtime.contracts.files.max_mb * 1024 * 1024 });

    let convertTo;
    if (args.convert) {
      convertTo = conversionFor(file.mimeType);
      if (!convertTo) {
        return fail(`${file.name} (${file.mimeType}) cannot become a Google file. Drive converts .docx, .md, .txt and .html into a Doc, .xlsx and .csv into a Sheet, and .pptx into Slides.`);
      }
    }
    // A Google file carries no extension; anything else keeps the file's own name.
    const chosen = sanitizeFileName(args.name || file.name);
    const name = convertTo && !args.name ? chosen.slice(0, chosen.length - extname(chosen).length) || chosen : chosen;

    const folder = args.folder || await outputFolder(runtime);
    const { kind, email } = drive.identity();
    if (!folder && kind === 'service_account') {
      return fail(`no folder given and no Drive output folder is set. ${email} is a service account with no Drive storage of its own: it can create files only inside a shared drive it is a member of. Pass --folder <link to a folder in such a shared drive>, or ask a dashboard admin to set the output folder in Settings.`);
    }

    const created = await drive.create({ name, parentId: folder || undefined, mimeType: file.mimeType, bytes: file.bytes, convertTo });
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: created.id, name: created.name ?? name, mime_type: created.mimeType ?? null, link: created.webViewLink ?? null, folder_id: folder || null }, null, 2)}\n`);
      return 0;
    }
    const where = folder ? `Drive folder ${folder}` : `the My Drive of ${email}`;
    const type = convertTo ? describeType(CONVERT_TARGETS[convertTo]) : file.mimeType;
    stdout.write([
      `Created "${created.name ?? name}" (${type}) in ${where}`,
      `id: ${created.id}`,
      `link: ${created.webViewLink ?? '(none returned)'}`,
      '',
    ].join('\n'));
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
