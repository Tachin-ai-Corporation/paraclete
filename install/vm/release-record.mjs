#!/usr/bin/env node
// install/vm/release-record.mjs: writes <install root>/release.json, the record of which release this
// VM runs. bootstrap.sh runs it on the staged release; the control service reports the file, and
// bootstrap.sh reads it at the next boot to decide whether anything needs installing.
//
// Its fields (install/README.md): `version` is the release version, a version as
// agent/release/versions.mjs defines one: the release tag when one was asked for, otherwise the
// version the commit's message starts with, looked up once from GitHub (best effort; null when neither
// gives one). `ref` is what was asked for, `commit` the 40-character commit installed, `repo` the
// owner/name it came from, `installed_at` when. `metadata` holds the VM metadata's paraclete-repo and
// paraclete-ref at that moment: a boot reinstalls from the metadata only once they change, so an
// upgrade the dashboard made survives a reboot.
//
//   node install/vm/release-record.mjs --out <file> --repo <owner/name> --ref <asked for>
//     --commit <sha> --metadata-repo <owner/name> --metadata-ref <sha>

import { renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isVersion, versionFromText } from '../../agent/release/versions.mjs';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** How long the one GitHub lookup may take before the version is left unknown. */
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * The release version: the ref itself when it is exactly a version (a release tag), else the version
 * the commit's message starts with, else null.
 *
 * @param {object} o
 * @param {string} o.ref            what was asked for
 * @param {string|null} [o.commitMessage]
 * @returns {string|null}
 */
export function releaseVersion({ ref, commitMessage }) {
  if (typeof ref === 'string' && ref === ref.trim() && isVersion(ref)) return ref;
  return versionFromText(commitMessage);
}

/**
 * A commit's message from GitHub's API, or null when it cannot be had (rate limit, outage, a private
 * repository). Never throws: the version is a label, and an install never fails for want of one.
 *
 * @param {object} o
 * @param {string} o.repo
 * @param {string} o.commit
 * @param {Function} [o.fetch]
 * @returns {Promise<string|null>}
 */
export async function lookupCommitMessage({ repo, commit, fetch = globalThis.fetch }) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits/${commit}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'paraclete-bootstrap' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.commit?.message === 'string' ? body.commit.message : null;
  } catch {
    return null;
  }
}

/**
 * The release record.
 *
 * @param {object} o
 * @returns {{version: string|null, ref: string, commit: string, repo: string, installed_at: string,
 *   metadata: {repo: string, ref: string}}}
 */
export function buildRelease({ version, ref, commit, repo, installedAt, metadataRepo, metadataRef }) {
  if (!COMMIT_PATTERN.test(commit ?? '')) throw new Error(`'${commit}' is not a 40-character commit`);
  for (const [name, value] of Object.entries({ ref, repo, metadataRepo, metadataRef })) {
    if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`);
  }
  return {
    version: version ?? null,
    ref,
    commit,
    repo,
    installed_at: installedAt,
    metadata: { repo: metadataRepo, ref: metadataRef },
  };
}

/**
 * The command line. Exits 0 once the record is written, 1 on a bad argument.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.now] () => ISO timestamp
 * @returns {Promise<number>} exit code
 */
export async function main(argv, {
  fetch = globalThis.fetch,
  now = () => new Date().toISOString(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        out: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        commit: { type: 'string' },
        'metadata-repo': { type: 'string' },
        'metadata-ref': { type: 'string' },
      },
    });
    if (!v.out) {
      stderr.write('Usage: release-record.mjs --out <file> --repo <owner/name> --ref <ref> --commit <sha> --metadata-repo <owner/name> --metadata-ref <sha>\n');
      return 2;
    }
    let version = releaseVersion({ ref: v.ref });
    if (!version && COMMIT_PATTERN.test(v.commit ?? '')) {
      const commitMessage = await lookupCommitMessage({ repo: v.repo, commit: v.commit, fetch });
      version = releaseVersion({ ref: v.ref, commitMessage });
      if (!version) stderr.write(`release-record: no version found for ${v.commit}; recording null\n`);
    }
    const record = buildRelease({
      version,
      ref: v.ref,
      commit: v.commit,
      repo: v.repo,
      installedAt: now(),
      metadataRepo: v['metadata-repo'],
      metadataRef: v['metadata-ref'],
    });
    const temp = `${v.out}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    renameSync(temp, v.out);
    stdout.write(`release ${record.version ?? '(no version)'} ${record.commit} recorded in ${v.out}\n`);
    return 0;
  } catch (err) {
    stderr.write(`release-record: ${err.message}\n`);
    return 1;
  }
}

// Exits explicitly: an idle connection from the lookup must not hold the install up.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
