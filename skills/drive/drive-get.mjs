#!/usr/bin/env node
// skills/drive/drive-get.mjs: the drive-get command. Downloads one binary Drive file (a PDF, an office
// file, an image, ...) as the agent's Drive identity, into a mission's inbox
// (<mission tree>/missions/<id>/inbox/) or to a path, and prints where it landed with its size and
// sha256. Google Docs, Sheets and Slides have no bytes to download: they are refused with the
// drive-export route. It also exports the saving helpers drive-export.mjs uses, so both commands land
// files the same way. The Drive calls are agent/providers/drive.mjs. Documented in
// skills/drive/SKILL.md.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import { createDriveClient, parseDriveLink, DriveError } from '../../agent/providers/drive.mjs';
import { sanitizeFileName } from '../../agent/storage/file-store.mjs';

export const USAGE = 'Usage: drive-get <drive link or id> (--mission <mission id> | --out <path>) [--json]';

/** A mission id is one plain path segment, as the mission trees name their directories. */
const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * A mission's inbox: <missions root>/<id>/missions/<id>/inbox. Inside the mission tree, under the
 * `missions/` directory its git excludes keep out of every commit.
 *
 * @param {string} missionsRoot dataPaths(instance).missions
 * @param {string} missionId
 * @returns {string}
 */
export function missionInbox(missionsRoot, missionId) {
  if (!MISSION_ID.test(String(missionId ?? ''))) throw new Error(`'${missionId}' is not a mission id`);
  return join(missionsRoot, missionId, 'missions', missionId, 'inbox');
}

/**
 * Checks the shared destination options: exactly one of --mission and --out.
 *
 * @param {{mission?: string, out?: string}} values
 * @returns {string|null} the problem, or null
 */
export function destinationProblem({ mission, out }) {
  if (mission === undefined && out === undefined) return 'say where the file goes: --mission <mission id> (its inbox) or --out <path>';
  if (mission !== undefined && out !== undefined) return 'use --mission or --out, not both';
  if (mission !== undefined && !MISSION_ID.test(mission)) return `'${mission}' is not a mission id`;
  if (out !== undefined && !out.trim()) return '--out needs a path';
  return null;
}

/**
 * Writes downloaded bytes where the command was told: the mission's inbox, a directory (`--out dir/`
 * or an existing directory) under the file's own name, or an exact path. Parent directories are made.
 * An earlier file at the same path is replaced: fetching the same file again refreshes it.
 *
 * @param {object} o
 * @param {Buffer} o.bytes
 * @param {string} o.name          the file's name, sanitized before use
 * @param {string} [o.mission]
 * @param {string} [o.out]
 * @param {string} o.missionsRoot
 * @param {string} [o.cwd]         where a relative --out starts from
 * @returns {{path: string, size: number, sha256: string, replaced: boolean}}
 */
export function saveFile({ bytes, name, mission, out, missionsRoot, cwd = process.cwd() }) {
  let path;
  if (mission !== undefined) path = join(missionInbox(missionsRoot, mission), sanitizeFileName(name));
  else {
    const target = resolve(cwd, out);
    const isDir = /[\\/]$/.test(out) || (existsSync(target) && statSync(target).isDirectory());
    path = isDir ? join(target, sanitizeFileName(name)) : target;
  }
  const replaced = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), replaced };
}

/** The lines a saved file is reported with, plain or as JSON. */
export function savedReport(saved, { name, mimeType, id, link, json }) {
  if (json) {
    return `${JSON.stringify({ path: saved.path, name, mime_type: mimeType, size: saved.size, sha256: saved.sha256, replaced: saved.replaced, drive: { id, link: link || null } }, null, 2)}\n`;
  }
  return [
    `Saved ${saved.path}${saved.replaced ? ' (replacing an earlier copy)' : ''}`,
    `${name} | ${mimeType} | ${saved.size} bytes | sha256 ${saved.sha256}`,
    `From Drive: ${id}${link ? ` ${link}` : ''}`,
    `Read it with: file-read ${saved.path}`,
    '',
  ].join('\n');
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, file?: string, mission?: string, out?: string, json?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: { mission: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one Drive file at a time, got ${positionals.length}` : 'a Drive link or file id is required' };
  const file = parseDriveLink(positionals[0]);
  if (!file) return { error: `'${positionals[0]}' is not a Drive link or file id` };
  const problem = destinationProblem(values);
  if (problem) return { error: problem };
  return { file, mission: values.mission, out: values.out, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, contracts, paths
 * @param {object} [deps.drive]   from createDriveClient()
 * @param {string} [deps.cwd]
 * @returns {Promise<number>} 0, 1 when Drive or the disk refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`drive-get: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const drive = deps.drive || createDriveClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const maxBytes = runtime.contracts.files.fetch_max_mb * 1024 * 1024;
    const got = await drive.download(args.file, { maxBytes });
    const saved = saveFile({ bytes: got.bytes, name: got.name, mission: args.mission, out: args.out, missionsRoot: runtime.paths.data.missions, cwd: deps.cwd });
    stdout.write(savedReport(saved, { name: got.name, mimeType: got.mimeType, id: got.file.id, link: got.file.webViewLink, json: args.json }));
    return 0;
  } catch (err) {
    return fail(err instanceof DriveError ? err.message : `failed: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
