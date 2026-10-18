#!/usr/bin/env node
// skills/files/file-share.mjs: the file-share command. Hands a finished file back to the people the
// mission works for: uploads it to the bucket as one of the mission's downloads
// (files/out/<mission>/<name>), writes its `files` record, and prints { name, size, gcs_path, file_id,
// drive }. The mission's reply carries it as an attachment, and the dashboard lists it on the mission.
// With --drive it also saves a new copy in Google Drive (the given folder, or the admin's output
// folder): always a new file, never one that replaces or changes a file already there. It refuses
// credentials and files over files.max_mb. The upload is agent/storage/file-store.mjs, the record
// agent/files/outgoing.mjs, the Drive call agent/providers/drive.mjs. Documented in
// skills/files/SKILL.md.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { missionOfPath, missionTreeExists } from '../../agent/files/mission-paths.mjs';
import { outgoingFileId, recordOutgoing } from '../../agent/files/outgoing.mjs';
import { createDriveClient, parseDriveLink } from '../../agent/providers/drive.mjs';
import { createFileStore, ShareRefused } from '../../agent/storage/file-store.mjs';

export const USAGE = 'Usage: file-share --mission <mission id> <path> [--name <name>] [--drive [<folder link or id>]]';

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Parses the arguments. `--drive` takes a folder only when the next word is a Drive folder link or id
 * and not a file that exists; `--drive=<folder>` always does.
 *
 * @param {string[]} argv
 * @param {{exists?: (path: string) => boolean}} [opts]
 * @returns {object} { help } | { error } | { mission, path, name, drive: boolean, folder: string|null }
 */
export function parseArgs(argv, { exists = existsSync } = {}) {
  const out = { mission: undefined, path: undefined, name: undefined, drive: false, folder: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--mission' || arg === '--name') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--drive' || arg.startsWith('--drive=')) {
      out.drive = true;
      const value = arg.startsWith('--drive=') ? arg.slice('--drive='.length) : argv[i + 1];
      const explicit = arg.startsWith('--drive=');
      if (value !== undefined && !value.startsWith('--') && (explicit || (parseDriveLink(value) && !exists(value)))) {
        out.folder = parseDriveLink(value);
        if (!out.folder) return { error: `'${value}' is not a Drive folder link or id` };
        if (!explicit) i += 1;
      }
    } else if (arg.startsWith('--')) {
      return { error: `unknown option ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) return { error: positionals.length ? `one file at a time, got ${positionals.length}` : 'the path of the file to share is required' };
  out.path = positionals[0];
  if (out.mission !== undefined && !MISSION_ID.test(out.mission)) return { error: `'${out.mission}' is not a mission id` };
  if (out.name !== undefined && !out.name.trim()) return { error: '--name needs a name' };
  return out;
}

/** The admin's Drive output folder, or null. Read strictly: an outage is an error, not "none set". */
async function outputFolder(runtime) {
  try {
    const settings = await runtime.db.read(`${runtime.collections.config}/settings`, { strict: true });
    const id = settings?.drive_output_folder;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch (err) {
    throw new Error(`cannot read the Drive output folder setting (${err.message}); pass --drive <folder link or id>`);
  }
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime]   from createCliRuntime(): contracts, instance, paths, db, collections, identity, getAccessToken, fetch, storageHost
 * @param {object} [deps.fileStore] from createFileStore(); default: one over the instance's bucket
 * @param {object} [deps.drive]     a Drive client (createDriveClient); default: one for the instance
 * @param {string} [deps.cwd]
 * @param {Function} [deps.now]
 * @returns {Promise<number>} 0; 1 when the file could not be shared, or not saved to Drive; 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  const fail = (message, code = 1) => { stderr.write(`file-share: ${message}\n`); return code; };

  const args = parseArgs(argv, { exists: (p) => existsSync(resolve(cwd, p)) });
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  let runtime;
  try {
    runtime = deps.runtime || createCliRuntime({ stderr });
  } catch (err) {
    return fail(err.message);
  }
  const { contracts, instance } = runtime;
  const missionsRoot = runtime.paths.data.missions;
  const path = resolve(cwd, args.path);
  const mission = args.mission || missionOfPath(missionsRoot, path);
  if (!mission) return fail(`--mission <mission id> is required: this mission's id, the last part of its working tree's path\n${USAGE}`, 2);
  if (!missionTreeExists(missionsRoot, mission)) {
    return fail(`there is no running mission '${mission}' (no tree at ${missionsRoot}/${mission}): use this mission's id, the last part of its working tree's path`, 2);
  }

  try {
    // Everything Drive needs is settled before anything is uploaded, so a refusal leaves nothing behind.
    let drive = null;
    let folder = null;
    if (args.drive) {
      drive = deps.drive || createDriveClient({ instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
      folder = args.folder || await outputFolder(runtime);
      const { kind, email } = drive.identity();
      if (!folder && kind === 'service_account') {
        return fail(`nothing was shared: no folder given and no Drive output folder is set. ${email} is a service account with no Drive storage of its own: it can create files only inside a shared drive it is a member of. Pass --drive <link to a folder in such a shared drive>, ask a dashboard admin to set the output folder in Settings, or share the file without --drive as a download only.`);
      }
    }

    const fileStore = deps.fileStore || createFileStore({
      bucket: instance.bucket,
      prefix: contracts.files.prefix,
      maxBytes: contracts.files.max_mb * 1024 * 1024,
      getAccessToken: runtime.getAccessToken,
      fetch: runtime.fetch,
      storageHost: runtime.storageHost,
    });
    const uploaded = await fileStore.uploadOne(mission, path, { name: args.name });

    let driveRecord = null;
    let driveError = null;
    if (drive) {
      try {
        // Always a new file: Drive allows two files of one name, and nothing someone shared is replaced.
        const created = await drive.create({ name: uploaded.name, parentId: folder || undefined, mimeType: uploaded.contentType, bytes: readFileSync(path) });
        driveRecord = { file_id: created.id, link: created.webViewLink || null, folder_id: folder || null };
      } catch (err) {
        driveError = err.message;
      }
    }

    try {
      await recordOutgoing(runtime.db, {
        missionId: mission, files: [uploaded], source: 'file-share', createdBy: runtime.identity.email, drive: driveRecord, now: deps.now, strict: true,
      });
    } catch (err) {
      return fail(`the file is uploaded (gs://${instance.bucket}/${uploaded.gcsPath}), but its record was not written, so the mission does not list it yet: ${err.message}. Run file-share again.`);
    }

    stdout.write(`${JSON.stringify({
      name: uploaded.name, size: uploaded.size, gcs_path: uploaded.gcsPath, file_id: outgoingFileId(mission, uploaded.name), drive: driveRecord,
    }, null, 2)}\n`);
    if (driveError) return fail(`shared as a download, but saving it to Drive failed: ${driveError}`);
    return 0;
  } catch (err) {
    if (err instanceof ShareRefused) return fail(`not shared: ${err.message}`);
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
