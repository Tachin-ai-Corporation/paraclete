#!/usr/bin/env node
// install/vm/instance-record.mjs: builds this instance's record, /etc/paraclete/instance.json, from the
// VM metadata bootstrap.sh read, and checks it with the release's own validateInstance() before
// anything is written: a record the release's services would refuse at startup stops the install
// instead. bootstrap.sh installs the file it writes; services and commands read it through
// config/instance.mjs. It reads no metadata itself and writes only the file it is given.
//
//   node install/vm/instance-record.mjs --out <file> --project <id> --zone <zone> --agent-name <name>
//     --role <role> --bucket <bucket> --release <what was asked for> --source-repo <owner/name>
//     --install-root /opt/paraclete --data-root /var/lib/paraclete
//     [--dashboard-url <url>] [--workspace-account <email> --workspace-signer <email>]

import { renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateInstance } from '../../config/instance.mjs';

/** A Compute Engine zone: its region and a one-letter suffix, e.g. us-central1-a. */
const ZONE_PATTERN = /^([a-z]+(?:-[a-z]+)*\d+)-[a-z]$/;

/**
 * The region a zone is in, e.g. us-central1 for us-central1-a.
 *
 * @param {string} zone
 * @returns {string}
 */
export function regionOf(zone) {
  const match = ZONE_PATTERN.exec(String(zone ?? ''));
  if (!match) throw new Error(`'${zone}' is not a Compute Engine zone like us-central1-a`);
  return match[1];
}

/**
 * The instance record, from the metadata. Optional values the metadata does not set are left out:
 * `dashboard_url` until the dashboard exists, `workspace` for a role without a Workspace account.
 *
 * @param {object} m
 * @param {string} m.project
 * @param {string} m.zone
 * @param {string} m.agentName
 * @param {string} m.role
 * @param {string} m.bucket
 * @param {string} m.release     what was asked for: a release tag, a branch name or the commit
 * @param {string} m.sourceRepo  owner/name the release came from
 * @param {string} m.installRoot
 * @param {string} m.dataRoot
 * @param {string} [m.dashboardUrl]
 * @param {string} [m.workspaceAccount]
 * @param {string} [m.workspaceSigner]
 * @returns {object}
 */
export function buildInstance(m) {
  const record = {
    project: m.project,
    region: regionOf(m.zone),
    zone: m.zone,
    agent_name: m.agentName,
    role: m.role,
    install_root: m.installRoot,
    data_root: m.dataRoot,
    bucket: m.bucket,
    release: m.release,
    source_repo: m.sourceRepo,
  };
  if (m.dashboardUrl) record.dashboard_url = m.dashboardUrl;
  if (m.workspaceAccount || m.workspaceSigner) {
    record.workspace = { account: m.workspaceAccount || '', signer: m.workspaceSigner || '' };
  }
  return record;
}

const OPTIONS = {
  out: { type: 'string' },
  project: { type: 'string' },
  zone: { type: 'string' },
  'agent-name': { type: 'string' },
  role: { type: 'string' },
  bucket: { type: 'string' },
  release: { type: 'string' },
  'source-repo': { type: 'string' },
  'install-root': { type: 'string' },
  'data-root': { type: 'string' },
  'dashboard-url': { type: 'string' },
  'workspace-account': { type: 'string' },
  'workspace-signer': { type: 'string' },
};

/**
 * The command line. Writes the record to --out (through a temporary file, so a reader never sees half
 * of one) and exits 0, or names every problem and exits 1 without writing.
 *
 * @param {string[]} argv
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 * @returns {number} exit code
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { values: v } = parseArgs({ args: argv, options: OPTIONS });
    if (!v.out) {
      stderr.write('Usage: instance-record.mjs --out <file> --project <id> --zone <zone> ... (see the file header)\n');
      return 2;
    }
    const record = buildInstance({
      project: v.project,
      zone: v.zone,
      agentName: v['agent-name'],
      role: v.role,
      bucket: v.bucket,
      release: v.release,
      sourceRepo: v['source-repo'],
      installRoot: v['install-root'],
      dataRoot: v['data-root'],
      dashboardUrl: v['dashboard-url'],
      workspaceAccount: v['workspace-account'],
      workspaceSigner: v['workspace-signer'],
    });
    const problems = validateInstance(record);
    for (const key of ['release', 'source_repo']) {
      if (typeof record[key] !== 'string' || record[key] === '') problems.push(`instance.${key} is required`);
    }
    if (problems.length) {
      stderr.write(`instance-record: the instance record would not be valid:\n- ${problems.join('\n- ')}\n`);
      return 1;
    }
    const temp = `${v.out}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    renameSync(temp, v.out);
    stdout.write(`instance record for ${record.project} (${record.role}) written to ${v.out}\n`);
    return 0;
  } catch (err) {
    stderr.write(`instance-record: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
