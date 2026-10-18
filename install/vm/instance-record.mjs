#!/usr/bin/env node
// install/vm/instance-record.mjs: builds this instance's record, /etc/paraclete/instance.json, from the
// VM metadata bootstrap.sh read, and checks it with the release's own validateInstance() before
// anything is written: a record the release's services would refuse at startup stops the install
// instead. bootstrap.sh installs the file it writes; services and commands read it through
// config/instance.mjs. It reads no metadata itself and writes only the file it is given.
//
// The agent's Workspace account (a role flagged `workspace`) comes from the metadata keys when they are
// set, else from --workspace-file, /etc/paraclete/workspace.json, which the dashboard's setup wizard
// records through the control service (agent/services/control/workspace-account.mjs). That file is
// how the account survives every upgrade and reboot. One that cannot be used is left out with a
// warning on stderr, never a failure: the agent runs without its account rather than not at all.
// The file is read only for a role flagged `workspace` in the release being installed (its
// roles/<role>/role.json, beside this file's own release): after a move to a role without a Workspace
// account the record leaves the account out, and the file stays where it is, so moving back restores it.
//
//   node install/vm/instance-record.mjs --out <file> --project <id> --zone <zone> --agent-name <name>
//     --role <role> --bucket <bucket> --release <what was asked for> --source-repo <owner/name>
//     --install-root /opt/paraclete --data-root /var/lib/paraclete
//     [--dashboard-url <url>] [--workspace-account <email> --workspace-signer <email>]
//     [--workspace-file /etc/paraclete/workspace.json]

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateInstance } from '../../config/instance.mjs';

/** The release this file belongs to: bootstrap.sh runs the copy in the release it installs. */
const RELEASE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A role id is one path segment here. Whether it names a real role is config/instance.mjs's rule. */
const ROLE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

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

/**
 * The account the setup wizard recorded, from the text of /etc/paraclete/workspace.json
 * (`{ account, signer, recorded_at, recorded_by }`). Null when it records none (`account: null`, after
 * a removal); throws, saying why, when the text is not such a record.
 *
 * @param {string} text
 * @returns {{account: string, signer: string}|null}
 */
export function parseWorkspaceFile(text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    throw new Error(`it is not JSON (${err.message})`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('it is not a JSON object');
  if (record.account === null || record.account === undefined) return null;
  if (typeof record.account !== 'string' || typeof record.signer !== 'string' || !record.account || !record.signer) {
    throw new Error('its account and signer must both be email addresses');
  }
  return { account: record.account, signer: record.signer };
}

/**
 * The Workspace account to record: the metadata's when it sets either key, else the file's. A file
 * that is missing records none; one that cannot be used records none and says why in `warning`.
 *
 * @param {object}   o
 * @param {string}   [o.metadataAccount]
 * @param {string}   [o.metadataSigner]
 * @param {string}   [o.file]      the path of workspace.json
 * @param {Function} [o.readFile]  (path) => string
 * @returns {{account?: string, signer?: string, source: 'metadata'|'file'|'none', warning?: string}}
 */
export function workspaceSource({ metadataAccount, metadataSigner, file, readFile = (p) => readFileSync(p, 'utf8') }) {
  if (metadataAccount || metadataSigner) return { account: metadataAccount, signer: metadataSigner, source: 'metadata' };
  if (!file) return { source: 'none' };
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return { source: 'none' };
    return { source: 'none', warning: `${file} cannot be read (${err.message}); the agent starts without its Workspace account` };
  }
  try {
    const recorded = parseWorkspaceFile(text);
    return recorded ? { ...recorded, source: 'file' } : { source: 'none' };
  } catch (err) {
    return { source: 'none', warning: `${file} is not a Workspace record: ${err.message}; the agent starts without its Workspace account` };
  }
}

/**
 * Whether a role has a Workspace account: the `workspace` flag of roles/<role>/role.json in a release.
 * `{ error }`, saying why, when that file cannot tell.
 *
 * @param {string}   root      the release
 * @param {string}   role
 * @param {Function} [readFile] (path) => string
 * @returns {{workspace: boolean}|{error: string}}
 */
export function roleWorkspace(root, role, readFile = (p) => readFileSync(p, 'utf8')) {
  if (!ROLE_SEGMENT.test(String(role ?? ''))) return { error: `'${role}' is not a role id` };
  const path = join(root, 'roles', role, 'role.json');
  let record;
  try {
    record = JSON.parse(readFile(path));
  } catch (err) {
    return { error: `${path} cannot be read (${err.message})` };
  }
  if (typeof record?.workspace !== 'boolean') return { error: `${path} sets no workspace flag` };
  return { workspace: record.workspace };
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
  'workspace-file': { type: 'string' },
};

/**
 * The command line. Writes the record to --out (through a temporary file, so a reader never sees half
 * of one) and exits 0, or names every problem and exits 1 without writing.
 *
 * @param {string[]} argv
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}, readFile?: Function, releaseRoot?: string}} [deps]
 *   releaseRoot: the release whose roles/ says whether the role has a Workspace account (this file's own)
 * @returns {number} exit code
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr, readFile, releaseRoot = RELEASE_ROOT } = {}) {
  try {
    const { values: v } = parseArgs({ args: argv, options: OPTIONS });
    if (!v.out) {
      stderr.write('Usage: instance-record.mjs --out <file> --project <id> --zone <zone> ... (see the file header)\n');
      return 2;
    }
    // The recorded account belongs to a Workspace role. After a move to a role without one, the file is
    // left out of the record and left in place, so moving back restores the account.
    let file = v['workspace-file'];
    let leftOut = '';
    if (file && !v['workspace-account'] && !v['workspace-signer']) {
      const role = roleWorkspace(releaseRoot, v.role);
      if (role.error) {
        stderr.write(`instance-record: warning: ${role.error}; ${file} is left out, and the agent starts without its Workspace account\n`);
        file = undefined;
      } else if (!role.workspace) {
        leftOut = `; ${file} left out: role ${v.role} has no Workspace account (the file stays, for a move back)`;
        file = undefined;
      }
    }
    const workspace = workspaceSource({
      metadataAccount: v['workspace-account'],
      metadataSigner: v['workspace-signer'],
      file,
      ...(readFile ? { readFile } : {}),
    });
    if (workspace.warning) stderr.write(`instance-record: warning: ${workspace.warning}\n`);
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
      workspaceAccount: workspace.account,
      workspaceSigner: workspace.signer,
    });
    if (workspace.source === 'file') {
      const wrong = validateInstance(record).filter((problem) => problem.startsWith('instance.workspace'));
      if (wrong.length) {
        stderr.write(`instance-record: warning: ${v['workspace-file']} does not name a usable account (${wrong.join('; ')}); the agent starts without its Workspace account\n`);
        delete record.workspace;
      }
    }
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
    const account = record.workspace ? `, Workspace account ${record.workspace.account} (from ${workspace.source === 'file' ? v['workspace-file'] : 'the metadata'})` : '';
    stdout.write(`instance record for ${record.project} (${record.role})${account} written to ${v.out}${leftOut}\n`);
    return 0;
  } catch (err) {
    stderr.write(`instance-record: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
