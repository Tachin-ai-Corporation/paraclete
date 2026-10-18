// agent/services/control/workspace-account.mjs: the agent's own Google Workspace account, as the VM
// keeps it. On a role flagged `workspace` the agent acts as a Google user of the organization, through
// domain-wide delegation; that user exists only once an admin has created it and granted the
// delegation, so the dashboard's setup wizard records it afterwards with the set_workspace_account
// command, which this file carries out. It also holds what the Workspace check shares with it: the rule
// for an account address and the delegation signer's name. commands.mjs calls it; workspace-check.mjs
// uses its address rule and signer.
//
// What set_workspace_account changes, and nothing else:
//   /etc/paraclete/workspace.json  `{ account, signer, recorded_at, recorded_by }`, what the wizard
//       recorded (`account: null` once removed). install/vm/instance-record.mjs merges it into the
//       instance record at every boot and upgrade when the VM metadata names no account, so the
//       account survives both.
//   /etc/paraclete/instance.json   the instance record (config/instance.mjs), rewritten at once with
//       `workspace` set or removed and every other field kept, so the services see it on restart
//       without waiting for a boot. Checked with validateInstance() before it is written.
//   config/workspace_account       the same record in Firestore, for the dashboard, which cannot read
//       the VM's files. The Workspace check adds its last outcome there (`last_check`).
// Each file is written beside itself and renamed into place, so no reader sees half of one; a write
// to any other path is refused here, whatever the caller passes (the unit lets control write
// /etc/paraclete, README.md says why). Then the services that read the record restart: the gateway
// (waited for), the brain, ears and mouth, and control itself last.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { firestoreEncode } from '../../storage/firestore.mjs';
import { DEFAULT_INSTANCE_PATH, validateInstance } from '../../../config/instance.mjs';

/** The wizard's record of the account. install/bootstrap.sh names the same file (WORKSPACE_FILE). */
export const WORKSPACE_FILE = '/etc/paraclete/workspace.json';

/** The instance record the services load (config/instance.mjs). */
export const INSTANCE_FILE = DEFAULT_INSTANCE_PATH;

/** The only files control ever writes on disk. */
export const WRITABLE_FILES = Object.freeze([WORKSPACE_FILE, INSTANCE_FILE]);

/**
 * The delegation signer's account id. install/lib/names.sh creates it (DWD_ACCOUNT_ID) for a role
 * flagged workspace; tests pin the two together.
 */
export const SIGNER_ACCOUNT_ID = 'paraclete-dwd';

/** The Firestore document, under `config`, that mirrors the record for the dashboard. */
export const WORKSPACE_RECORD_DOC = 'workspace_account';

/** The services restarted after the record changes, in order. Control follows, once the command is recorded. */
export const RESTARTED_SERVICES = Object.freeze(['gateway', 'brain', 'ears', 'mouth']);

const RECORD_FIELDS = Object.freeze(['account', 'signer', 'recorded_at', 'recorded_by']);

/** A Google account address: Google allows letters, digits and . _ ' - + before the @. */
const ADDRESS = /^[a-z0-9._'+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const MAX_ADDRESS_LENGTH = 254;
/** Personal Google accounts, which no organization can delegate to. */
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The delegation signer of an instance: paraclete-dwd@<project>.iam.gserviceaccount.com.
 *
 * @param {string} project
 * @returns {string}
 */
export function signerFor(project) {
  if (!project) throw new Error('the instance has no project, so the delegation signer cannot be named');
  return `${SIGNER_ACCOUNT_ID}@${project}.iam.gserviceaccount.com`;
}

/**
 * Checks an address for the agent's Workspace account and returns it trimmed and lowercased. Throws,
 * saying why, for anything that is not a user in an organization's domain: not an address, a personal
 * Gmail account, or a service account.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function checkWorkspaceAccount(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error("params.account must be the agent's Workspace address, such as agent@example.com");
  }
  const account = value.trim().toLowerCase();
  if (account.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(account)) {
    throw new Error(`'${account.slice(0, 80)}' is not an email address like agent@example.com`);
  }
  const domain = account.slice(account.indexOf('@') + 1);
  if (CONSUMER_DOMAINS.has(domain)) {
    throw new Error(`${account} is a personal Google account; the agent needs a user in your organization's Workspace domain`);
  }
  if (domain === 'gserviceaccount.com' || domain.endsWith('.gserviceaccount.com')) {
    throw new Error(`${account} is a service account; the agent needs a user in your organization's Workspace domain`);
  }
  return account;
}

/**
 * Writes one of the two files, through a sibling file renamed into place. Any other path is refused.
 *
 * @param {object} files  { writeFileSync, chmodSync, renameSync }
 * @param {string} path
 * @param {object} value  written as indented JSON
 */
function writeFenced(files, path, value) {
  if (!WRITABLE_FILES.includes(path)) {
    throw new Error(`control writes only ${WRITABLE_FILES.join(' and ')}, never ${path}`);
  }
  const temp = `${path}.control-next`;
  files.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  files.chmodSync(temp, 0o644);
  files.renameSync(temp, path);
}

/** Whether the installed role is flagged workspace in its role.json. */
function roleHasWorkspace(paths, readText) {
  let role;
  try {
    role = JSON.parse(readText(join(paths.role, 'role.json')));
  } catch (err) {
    throw new Error(`the installed role's role.json cannot be read: ${err.message}`);
  }
  return role?.workspace === true;
}

/**
 * The instance record as the file holds it (not the loaded copy, which carries defaults).
 *
 * @param {object} files
 * @returns {object}
 */
function readInstanceFile(files) {
  try {
    const record = JSON.parse(files.readFileSync(INSTANCE_FILE, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('it is not a JSON object');
    return record;
  } catch (err) {
    throw new Error(`${INSTANCE_FILE} cannot be read: ${err.message}`);
  }
}

const sameWorkspace = (a, b) => (a?.account || null) === (b?.account || null) && (a?.signer || null) === (b?.signer || null);

/**
 * Writes the record's fields of config/workspace_account (the last check stays).
 *
 * @param {object} db
 * @param {object} collections
 * @param {object} record { account, signer, recorded_at, recorded_by }
 */
export async function writeAccountRecord(db, collections, record) {
  await db.patch(`${collections.config}/${WORKSPACE_RECORD_DOC}`, [...RECORD_FIELDS], firestoreEncode(record), { strict: true });
}

/**
 * Writes a Workspace check's outcome as `last_check` on config/workspace_account (the record stays).
 *
 * @param {object} db
 * @param {object} collections
 * @param {object} check  the workspace_check result, with `checked_by`
 */
export async function writeLastCheck(db, collections, check) {
  await db.patch(`${collections.config}/${WORKSPACE_RECORD_DOC}`, ['last_check'], firestoreEncode({ last_check: check }), { strict: true });
}

/**
 * Records the agent's Workspace account, or removes it with `account: null`. Writes the two files
 * and the Firestore record, then, when the instance record changed, restarts the services that read
 * it. A Firestore or restart failure fails the command with the result so far: the files are written
 * by then, and running the command again is safe.
 *
 * @param {object}   o
 * @param {object}   o.params        { account: string | null }
 * @param {string}   [o.actor]       who asked (the command's requested_by)
 * @param {object}   o.instance      the loaded instance record (for its project)
 * @param {object}   o.paths         the runtime's paths (for the installed role's role.json)
 * @param {Function} o.readText      (path) => string
 * @param {object}   [o.files]       { readFileSync, writeFileSync, chmodSync, renameSync } (node:fs)
 * @param {object}   o.db
 * @param {object}   o.collections
 * @param {Function} o.restart       async (service) => state; throws when it does not come back
 * @param {Function} [o.nowIso]
 * @returns {Promise<object>} the command result. Its `files` name INSTANCE_FILE when the record
 *   changed; the caller then restarts control as well, once the command is recorded
 */
export async function setWorkspaceAccount({
  params, actor, instance, paths, readText, files = nodeFs, db, collections, restart, nowIso = () => new Date().toISOString(),
}) {
  if (!params || typeof params !== 'object' || !Object.hasOwn(params, 'account')) {
    throw new Error("params.account is required: the agent's Workspace address, or null to remove it");
  }
  const account = params.account === null ? null : checkWorkspaceAccount(params.account);
  if (account && !roleHasWorkspace(paths, readText)) {
    throw new Error(`the ${instance.role} role has no Workspace account (its role.json does not set workspace), so none can be recorded`);
  }
  const signer = account ? signerFor(instance.project) : null;

  const current = readInstanceFile(files);
  const next = { ...current };
  if (account) next.workspace = { account, signer };
  else delete next.workspace;
  const problems = validateInstance(next);
  if (problems.length) throw new Error(`the instance record would not be valid:\n- ${problems.join('\n- ')}`);

  const record = { account, signer, recorded_at: nowIso(), recorded_by: actor || null };
  const changed = !sameWorkspace(current.workspace, next.workspace);
  writeFenced(files, WORKSPACE_FILE, record);
  if (changed) writeFenced(files, INSTANCE_FILE, next);

  const result = {
    account,
    signer,
    previous: current.workspace?.account || null,
    recorded_at: record.recorded_at,
    recorded_by: record.recorded_by,
    files: changed ? [WORKSPACE_FILE, INSTANCE_FILE] : [WORKSPACE_FILE],
    restarted: [],
    message: '',
  };
  const problemsAfter = [];
  try {
    await writeAccountRecord(db, collections, record);
  } catch (err) {
    problemsAfter.push(`the dashboard's record (config/${WORKSPACE_RECORD_DOC}) could not be written: ${err.message}`);
  }

  if (changed) {
    for (const service of RESTARTED_SERVICES) {
      try {
        await restart(service);
        result.restarted.push(service);
      } catch (err) {
        problemsAfter.push(`${service}: ${err.message}`);
      }
    }
  }

  const what = account ? `The agent's Workspace account is ${account}` : "The agent's Workspace account is removed";
  if (problemsAfter.length) {
    result.message = `${what} on the VM, but ${problemsAfter.join('; ')}. Running the command again is safe.`;
    throw Object.assign(new Error(result.message), { result });
  }
  result.message = changed
    ? `${what}; the gateway, brain, ears and mouth restarted with it, and the control service restarts next.`
    : `${what}, as it already was; nothing needed a restart.`;
  return result;
}
