// agent/work/platform-version.mjs: the release that creates a work envelope, stamped on it as
// `platform_version` (work-schema.mjs) so that a mission can be attributed to the code that ran it.
// The version is <install root>/release.json's `version` (install/vm/release-record.mjs writes it at
// every install), read once when the brain starts: an upgrade restarts the brain, so the code that runs
// and the version it stamps never drift apart. A missing or unreadable file, or a version that is not
// one (agent/release/versions.mjs), stamps null, and says so once.
//
// The brain stamps at one place, its Firestore client, rather than at each of the places that build an
// envelope: a whole-document write of a work envelope that carries no platform_version yet and was
// created since this brain started gets the version. Envelopes from before (written by an older release,
// or before envelopes carried a version) are left as they are when the brain saves them again, and a
// stamped envelope keeps its version for life. Built by agent/services/brain/main.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isVersion } from '../release/versions.mjs';
import { COLLECTIONS } from '../storage/collections.mjs';

/** The release record, relative to the install root. */
export const RELEASE_FILE = 'release.json';

/**
 * The version of the installed release, or null.
 *
 * @param {string} installRoot
 * @param {object} [deps]
 * @param {Function} [deps.readText] (path) => text
 * @param {Function} [deps.log]      (level, message)
 * @returns {string|null}
 */
export function readPlatformVersion(installRoot, { readText = (path) => readFileSync(path, 'utf8'), log = () => {} } = {}) {
  const path = join(installRoot, RELEASE_FILE);
  let record;
  try {
    record = JSON.parse(readText(path));
  } catch (err) {
    log('WARN', `${path} cannot be read (${err.code || err.message}), so the work this brain creates carries no release version`);
    return null;
  }
  if (!isVersion(record?.version)) {
    log('WARN', `${path} names no release version, so the work this brain creates carries none`);
    return null;
  }
  return record.version;
}

/** Whether a path is a work envelope itself (work/<id>), not something beneath one. */
function isEnvelopePath(path) {
  const parts = String(path).split('/');
  return parts.length === 2 && parts[0] === COLLECTIONS.work && parts[1] !== '';
}

/**
 * A Firestore client whose whole-document writes stamp `platform_version` on the work envelopes created
 * since `since`. Everything else, every other write and every other collection, passes through as it was.
 *
 * @param {object} db       a client from agent/storage/firestore.mjs
 * @param {object} o
 * @param {string|null} o.version  readPlatformVersion()
 * @param {number} o.since          when this brain started, in ms: envelopes created before it are not its own
 * @returns {object} the client, with its write() stamping
 */
export function stampPlatformVersion(db, { version, since }) {
  return {
    ...db,
    write(path, data, opts) {
      if (isEnvelopePath(path) && data && typeof data === 'object' && !Object.hasOwn(data, 'platform_version')
        && Date.parse(data.created_at) >= since) {
        data.platform_version = version ?? null;
      }
      return db.write(path, data, opts);
    },
  };
}
