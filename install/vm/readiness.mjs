#!/usr/bin/env node
// install/vm/readiness.mjs: writes the readiness document, Firestore agent/instance, at the end of every
// bootstrap run: `{ status: 'ready', release, commit, version, ready_at }` once the services are up,
// or `{ status: 'failed', release, commit, error, failed_at }` when the run failed. `release` and
// `commit` name what the run installed or tried to install (`release` is the ref asked for: a tag, or
// a commit); `version` is the installed release.json's version, so the dashboard can name the release
// however it was asked for. install.sh and the dev/ scripts wait on it. It writes only the fields it
// names (a field mask), so whatever else the document holds stays; a `ready` clears the last run's
// error, and a `failed` keeps the last `ready_at` and `version` (a failed run leaves the release that
// was running). bootstrap.sh runs it as root with the VM's own credentials (the metadata server). It
// does nothing else.
//
//   node install/vm/readiness.mjs --project <id> --status ready|failed --release <ref> --commit <sha>
//     [--release-file <install root>/release.json] [--error <text>]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createClient, firestoreEncode } from '../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { isVersion } from '../../agent/release/versions.mjs';

/** The readiness document's path. */
export const READINESS_DOC = `${COLLECTIONS.agent}/instance`;

/** An error is a sentence or a few, never a log: the journal holds the rest. */
export const MAX_ERROR_CHARS = 2000;

/**
 * The fields one readiness write sets, and the field mask that goes with them. Fields in the mask
 * but not in `fields` are deleted.
 *
 * @param {object} o
 * @param {'ready'|'failed'} o.status
 * @param {string} o.release
 * @param {string} o.commit
 * @param {string|null} [o.version] the installed release's version; a ready write only
 * @param {string} [o.error]
 * @param {string} o.now ISO 8601 UTC
 * @returns {{fieldPaths: string[], fields: object}}
 */
export function readinessUpdate({ status, release, commit, version, error, now }) {
  if (status === 'ready') {
    return {
      fieldPaths: ['status', 'release', 'commit', 'version', 'ready_at', 'error', 'failed_at'],
      fields: { status, release: release || null, commit: commit || null, version: isVersion(version) ? version : null, ready_at: now },
    };
  }
  if (status === 'failed') {
    const text = String(error || 'the bootstrap failed; its log is in the VM journal');
    return {
      fieldPaths: ['status', 'release', 'commit', 'error', 'failed_at'],
      fields: {
        status,
        release: release || null,
        commit: commit || null,
        error: text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text,
        failed_at: now,
      },
    };
  }
  throw new Error(`status must be 'ready' or 'failed', got ${JSON.stringify(status)}`);
}

/**
 * The version a release.json records, or null when the file is missing, unreadable or names none.
 *
 * @param {string} path
 * @param {Function} [readFile]
 * @returns {string|null}
 */
export function releaseFileVersion(path, readFile = (p) => readFileSync(p, 'utf8')) {
  try {
    const version = JSON.parse(readFile(path))?.version;
    return isVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Writes one readiness update. Throws when Firestore does not take it.
 *
 * @param {object} db from createClient()
 * @param {object} update the readinessUpdate() arguments
 */
export async function writeReadiness(db, update) {
  const { fieldPaths, fields } = readinessUpdate(update);
  await db.patch(READINESS_DOC, fieldPaths, firestoreEncode(fields), { strict: true });
  return fields;
}

/**
 * The command line. Exits 0 once the document is written, 1 when it could not be.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {Function} [deps.getAccessToken]
 * @param {Function} [deps.fetch]
 * @param {string}   [deps.firestoreHost]
 * @param {Function} [deps.now]
 * @returns {Promise<number>}
 */
export async function main(argv, {
  getAccessToken,
  fetch,
  firestoreHost,
  now = () => new Date().toISOString(),
  readFile,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        project: { type: 'string' },
        status: { type: 'string' },
        release: { type: 'string' },
        commit: { type: 'string' },
        'release-file': { type: 'string' },
        error: { type: 'string' },
      },
    });
    if (!v.project || !v.status) {
      stderr.write('Usage: readiness.mjs --project <id> --status ready|failed --release <ref> --commit <sha> [--release-file <path>] [--error <text>]\n');
      return 2;
    }
    const version = v['release-file'] ? releaseFileVersion(v['release-file'], readFile) : null;
    const db = createClient({
      projectId: v.project,
      ...(getAccessToken ? { getAccessToken } : {}),
      ...(fetch ? { fetch } : {}),
      ...(firestoreHost ? { firestoreHost } : {}),
      logger: (level, ...args) => stderr.write(`readiness: ${level} ${args.join(' ')}\n`),
    });
    await writeReadiness(db, { status: v.status, release: v.release, commit: v.commit, version, error: v.error, now: now() });
    stdout.write(`readiness: ${READINESS_DOC} is ${v.status} (${version || v.release || '?'} ${v.commit || '?'})\n`);
    return 0;
  } catch (err) {
    stderr.write(`readiness: could not write ${READINESS_DOC}: ${err.message}\n`);
    return 1;
  }
}

// Exits explicitly: an idle connection to Firestore must not hold the bootstrap up.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
