#!/usr/bin/env node
// skills/drive/drive-export.mjs: the drive-export command. Exports one Google Doc, Sheet or Slides file
// as a standard file (Docs to docx, pdf, md or txt; Sheets to xlsx, csv or pdf; Slides to pptx, pdf or
// txt) as the agent's Drive identity, and saves it where drive-get would: a mission's inbox or a path.
// A file that is not Google-native is refused with the drive-get route. The Drive calls are
// agent/providers/drive.mjs; saving is drive-get.mjs's saveFile. Documented in skills/drive/SKILL.md.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../agent/cli/cli-runtime.mjs';
import {
  createDriveClient, parseDriveLink, exportMimeType, isGoogleNative, describeType, DriveError, EXPORT_FORMATS, SHORTCUT_MIME,
} from '../../agent/providers/drive.mjs';
import { destinationProblem, saveFile, savedReport } from './drive-get.mjs';

/** Every format some Google-native type exports to. */
export const FORMATS = Object.freeze([...new Set(Object.values(EXPORT_FORMATS).flatMap((f) => Object.keys(f)))]);

export const USAGE = `Usage: drive-export <drive link or id> --format ${FORMATS.join('|')} (--mission <mission id> | --out <path>) [--json]`;

/**
 * The exported file's name: the Drive name with the format's extension, unless it already ends so.
 *
 * @param {string} name
 * @param {string} format
 * @returns {string}
 */
export function exportName(name, format) {
  const base = String(name || 'export').trim() || 'export';
  return base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`;
}

/**
 * @param {string[]} argv
 * @returns {{help?: true, file?: string, format?: string, mission?: string, out?: string, json?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string' }, mission: { type: 'string' }, out: { type: 'string' },
        json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) return { error: positionals.length ? `one Drive file at a time, got ${positionals.length}` : 'a Drive link or file id is required' };
  const file = parseDriveLink(positionals[0]);
  if (!file) return { error: `'${positionals[0]}' is not a Drive link or file id` };
  const format = String(values.format ?? '').toLowerCase();
  if (!format) return { error: `--format is required: ${FORMATS.join(', ')}` };
  if (!FORMATS.includes(format)) return { error: `--format must be one of ${FORMATS.join(', ')}, not '${values.format}'` };
  const problem = destinationProblem(values);
  if (problem) return { error: problem };
  return { file, format, mission: values.mission, out: values.out, json: values.json === true };
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {object} [deps.runtime] from createCliRuntime(): instance, paths
 * @param {object} [deps.drive]   from createDriveClient()
 * @param {string} [deps.cwd]
 * @returns {Promise<number>} 0, 1 when Drive or the disk refused, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`drive-export: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const runtime = deps.runtime || createCliRuntime({ stderr });
    const drive = deps.drive || createDriveClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    let meta = await drive.getMeta(args.file);
    if (meta.mimeType === SHORTCUT_MIME && meta.shortcutDetails?.targetId) meta = await drive.getMeta(meta.shortcutDetails.targetId);
    const label = `"${meta.name}" (${meta.id})`;
    if (!isGoogleNative(meta.mimeType)) {
      return fail(`${label} is a ${meta.mimeType} file, not a Google Doc, Sheet or Slides: download it as it is with drive-get ${meta.id}`);
    }
    const mimeType = exportMimeType(meta.mimeType, args.format);
    if (!mimeType) {
      const formats = Object.keys(EXPORT_FORMATS[meta.mimeType] || {});
      return fail(formats.length
        ? `${label} is a ${describeType(meta.mimeType)}, which exports to ${formats.join(', ')}, not ${args.format}`
        : `${label} is a ${describeType(meta.mimeType)}, which cannot be exported`);
    }
    if (meta.capabilities?.canDownload === false) {
      return fail(`The owner of ${label} has turned off downloading, printing and copying for viewers and commenters, so ${drive.identity().email} cannot export it. Ask the owner for Editor access, or to allow downloads.`);
    }
    const bytes = await drive.export(meta.id, mimeType);
    const name = exportName(meta.name, args.format);
    const saved = saveFile({ bytes, name, mission: args.mission, out: args.out, missionsRoot: runtime.paths.data.missions, cwd: deps.cwd });
    stdout.write(savedReport(saved, { name, mimeType, id: meta.id, link: meta.webViewLink, json: args.json }));
    if (args.format === 'csv' && !args.json) stdout.write('Note: a CSV export holds only the first sheet. Export xlsx to get every sheet.\n');
    return 0;
  } catch (err) {
    return fail(err instanceof DriveError ? err.message : `failed: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
