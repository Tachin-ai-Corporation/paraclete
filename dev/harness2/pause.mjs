// dev/harness2/pause.mjs: the harness's off switch. While the file dev/harness2/PAUSED exists in a
// checkout, or PARACLETE_H2_PAUSED is set to anything but '' or '0', nothing in the harness opens,
// updates or merges a promotion pull request, and no cycle starts. Committed to main, the file pauses
// the merger at its next run and every lab driver within one follow-main interval; its first line, if
// any, is the reason each refusal shows. Removing it from main resumes everything.
//
// It does not stop a run already in progress, and it changes nothing itself. A promotion cannot add or
// remove it: dev/ is off the mutable surface (surface.mjs). Called by dev/harness2/cli.mjs before a
// cycle and by dev/harness2/merge.mjs before it merges.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The off switch, relative to the repo root. */
export const PAUSE_FILE = 'dev/harness2/PAUSED';

/** The environment variable that pauses one process, whatever the checkout holds. */
export const PAUSE_ENV = 'PARACLETE_H2_PAUSED';

/**
 * Whether the harness is paused, and why.
 *
 * @param {object} [o]
 * @param {string} [o.repoRoot]                 the checkout to read the switch from
 * @param {object} [o.env]
 * @param {(path: string) => boolean} [o.exists]
 * @param {(path: string) => string} [o.read]
 * @returns {{paused: boolean, source: 'env'|'file'|null, reason: string|null}}
 */
export function pauseState({
  repoRoot = process.cwd(), env = process.env, exists = existsSync, read = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const value = env[PAUSE_ENV];
  if (value !== undefined && value !== '' && value !== '0') {
    return { paused: true, source: 'env', reason: `${PAUSE_ENV} is set` };
  }
  const file = join(repoRoot, PAUSE_FILE);
  if (!exists(file)) return { paused: false, source: null, reason: null };
  let first = '';
  try {
    first = read(file).split(/\r?\n/)[0].trim();
  } catch {
    first = '';
  }
  return { paused: true, source: 'file', reason: first ? `${PAUSE_FILE}: ${first}` : `${PAUSE_FILE} exists` };
}
