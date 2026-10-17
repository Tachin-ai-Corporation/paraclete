// agent/cli/cli-runtime.mjs: what every command in agent/cli starts from. It loads and checks the
// contracts and the instance record, and builds a Firestore client, the instance's paths and the
// agent's identity (agentIdentity in config/instance.mjs), with plain stderr logging. It also holds
// the few helpers the commands share: checking an id, reading stdin, running a program, and the error
// type a command exits with. Reading the role packages' installed defaults is
// agent/work/role-packages.mjs. It is not a command itself: the installer gives no launcher to this
// file. Services start from agent/services/service-runtime.mjs instead; nothing here imports it.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContracts } from '../../config/contracts.mjs';
import { agentIdentity, loadInstance, dataPaths } from '../../config/instance.mjs';
import { createClient } from '../storage/firestore.mjs';
import { FIRESTORE_HOST, STORAGE_HOST } from '../storage/hosts.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from '../storage/collections.mjs';
import { getAccessToken as metadataToken } from '../auth/metadata-token.mjs';

/**
 * A failure a command reports and exits on. `code` is the exit code; the message is agent-facing.
 */
export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/**
 * An id from the command line, checked before it becomes part of a document path. It must be one
 * path segment: an id holding a slash would address a document in some other collection.
 *
 * @param {string} id
 * @param {string} [what] how the error names it
 * @returns {string} the id
 */
export function checkDocId(id, what = 'id') {
  if (typeof id !== 'string' || id.trim() === '' || id.includes('/') || id === '.' || id === '..') {
    throw new CliError(`${what} '${id ?? ''}' is not a valid id: it must be one word with no '/'`);
  }
  return id;
}

/**
 * The paths a command reads and writes, the same shape the services use: the install root and its
 * prompts, skills and role packages (read-only to the agent), and the data root's layout.
 *
 * @param {{install_root: string, data_root: string, role: string}} instance
 */
export function instancePaths(instance) {
  const installRoot = instance.install_root;
  return Object.freeze({
    installRoot,
    prompts: join(installRoot, 'prompts'),
    skills: join(installRoot, 'skills'),
    roles: join(installRoot, 'roles'),
    genericRole: join(installRoot, 'roles', 'generic'),
    role: join(installRoot, 'roles', instance.role),
    data: dataPaths(instance),
  });
}

/**
 * Builds a command's runtime from the contracts and the instance record. Throws, naming the problem,
 * when either is missing or invalid.
 *
 * @param {object}   [options]
 * @param {string}   [options.contractsPath]  default: config/contracts.json
 * @param {string}   [options.instancePath]   default: PARACLETE_INSTANCE, else /etc/paraclete/instance.json
 * @param {Function} [options.getAccessToken] token source (default: the VM's metadata server)
 * @param {Function} [options.fetch]          fetch implementation (injectable for tests)
 * @param {{write: Function}} [options.stderr] where the Firestore client's warnings go (default: stderr)
 */
export function createCliRuntime({
  contractsPath,
  instancePath,
  getAccessToken = metadataToken,
  fetch = globalThis.fetch,
  stderr = process.stderr,
} = {}) {
  const contracts = loadContracts(contractsPath ? { path: contractsPath } : {});
  const instance = loadInstance(instancePath ? { path: instancePath } : {});

  const firestoreHost = instance.endpoints.firestore || FIRESTORE_HOST;
  const storageHost = instance.endpoints.storage || STORAGE_HOST;
  const db = createClient({
    projectId: instance.project,
    firestoreHost,
    getAccessToken,
    fetch,
    logger: (level, ...args) => {
      if (level !== 'DEBUG') stderr.write(`[firestore] ${level} ${args.join(' ')}\n`);
    },
  });

  return Object.freeze({
    contracts,
    instance,
    db,
    collections: COLLECTIONS,
    subcollections: SUBCOLLECTIONS,
    paths: instancePaths(instance),
    identity: agentIdentity(instance),
    getAccessToken,
    fetch,
    firestoreHost,
    storageHost,
  });
}

/** Everything on stdin, as text. */
export function readStdin() {
  return readFileSync(0, 'utf8');
}

/**
 * Runs a program with an argument list, never through a shell. Resolves with its exit code and
 * output whatever the code; a program that is not installed resolves with code 127.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{input?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runProgram(file, args, { input, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve({ code: 127, stdout: '', stderr: `${file}: not found` });
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout || '', stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') });
    });
    // Close stdin either way, so a program that reads it never waits on a terminal that isn't there.
    child.stdin?.end(input ?? '');
  });
}
