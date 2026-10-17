// agent/services/service-runtime.mjs: what every service starts from. It loads and checks the
// contracts and the instance record, then builds the service's logger, its Firestore client, its
// paths and the gateway's address. Each service's main.mjs calls createServiceRuntime once at
// startup; a failure here stops the service before it does any work. Library packages never read
// configuration: services read it here and pass values down. It also holds what more than one
// service reads the same way: the admin settings a dashboard admin changes (readAdminSettings) and
// the skill directories (skillDirectories). What a setting means to a service stays in that service.

import { join } from 'node:path';
import { loadContracts } from '../../config/contracts.mjs';
import { loadInstance, dataPaths } from '../../config/instance.mjs';
import { createClient } from '../storage/firestore.mjs';
import { FIRESTORE_HOST, STORAGE_HOST } from '../storage/hosts.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from '../storage/collections.mjs';
import { getAccessToken as metadataToken } from '../auth/metadata-token.mjs';

/**
 * A logger that writes one JSON object per line, which journald keeps and `dev/logs` reads.
 *
 * @param {string} service the service's name, stamped on every line
 * @param {object} [options]
 * @param {Function} [options.write] where a line goes (default: stdout)
 * @param {Function} [options.now]   clock (injectable for tests)
 * @returns {(level: string, message: string, fields?: object) => void}
 */
export function createLogger(service, { write = (line) => process.stdout.write(`${line}\n`), now = () => new Date() } = {}) {
  return function log(level, message, fields) {
    write(JSON.stringify({ ...fields, time: now().toISOString(), level, service, message: String(message) }));
  };
}

/**
 * Builds a service's runtime from the contracts and the instance record.
 *
 * @param {object}   options
 * @param {string}   options.service          the service's name: brain, ears, mouth, control, gateway
 * @param {string}   [options.contractsPath]  default: config/contracts.json
 * @param {string}   [options.instancePath]   default: PARACLETE_INSTANCE, else /etc/paraclete/instance.json
 * @param {Function} [options.getAccessToken] token source (default: the VM's metadata server)
 * @param {Function} [options.fetch]          fetch implementation (injectable for tests)
 * @param {Function} [options.write]          where log lines go (injectable for tests)
 */
export function createServiceRuntime({
  service,
  contractsPath,
  instancePath,
  getAccessToken = metadataToken,
  fetch = globalThis.fetch,
  write,
} = {}) {
  if (!service) throw new Error('createServiceRuntime: service is required');
  const contracts = loadContracts(contractsPath ? { path: contractsPath } : {});
  const instance = loadInstance(instancePath ? { path: instancePath } : {});
  const log = createLogger(service, write ? { write } : {});

  const firestoreHost = instance.endpoints.firestore || FIRESTORE_HOST;
  const storageHost = instance.endpoints.storage || STORAGE_HOST;
  const db = createClient({
    projectId: instance.project,
    firestoreHost,
    getAccessToken,
    fetch,
    logger: (level, ...args) => log(level, args.join(' ')),
  });

  const installRoot = instance.install_root;
  const paths = Object.freeze({
    installRoot,
    prompts: join(installRoot, 'prompts'),
    skills: join(installRoot, 'skills'),
    roles: join(installRoot, 'roles'),
    genericRole: join(installRoot, 'roles', 'generic'),
    role: join(installRoot, 'roles', instance.role),
    data: dataPaths(instance),
  });

  return Object.freeze({
    service,
    contracts,
    instance,
    log,
    db,
    collections: COLLECTIONS,
    subcollections: SUBCOLLECTIONS,
    getAccessToken,
    fetch,
    firestoreHost,
    storageHost,
    paths,
    gatewayUrl: instance.endpoints.gateway || `http://${contracts.gateway.bind}:${contracts.gateway.port}`,
  });
}

/**
 * The admin settings document: what a dashboard admin changes (effort, Claude on or off). The
 * dashboard and the control service write it; the brain, the gateway and the control service read it.
 */
export const ADMIN_SETTINGS_PATH = `${COLLECTIONS.config}/settings`;

/**
 * Reads the admin settings document, decoded. An absent document is {}: the admin has changed
 * nothing, and each service applies its own defaults. What a field means is the reading service's
 * business: the brain's effort level, the gateway's Claude switch, the control service's view.
 *
 * With strict, a Firestore failure throws instead of reading as "the admin chose the defaults"; every
 * service reads it that way. Without it, a failure reads as an absent document, the storage client's
 * default.
 *
 * @param {object}  db                a client from agent/storage/firestore.mjs
 * @param {object}  [options]
 * @param {boolean} [options.strict]  throw StoreUnavailable when the document cannot be read
 * @returns {Promise<object>} the decoded document, or {} when there is none
 * @throws {StoreUnavailable} with strict, when the document could not be read
 */
export async function readAdminSettings(db, { strict = false } = {}) {
  const doc = await db.read(ADMIN_SETTINGS_PATH, { strict });
  return doc || {};
}

/**
 * The skill directories, in catalog order: the base skills, the generic role's, the chosen role's
 * (when it is not generic), then the skills the agent wrote for itself. The gateway builds its skill
 * catalog and its tools' skill-not-found hint from them; the brain builds its capability map.
 *
 * @param {object} paths a runtime's paths
 * @returns {string[]}
 */
export function skillDirectories(paths) {
  const dirs = [paths.skills, join(paths.genericRole, 'skills')];
  if (paths.role !== paths.genericRole) dirs.push(join(paths.role, 'skills'));
  dirs.push(paths.data.skills);
  return dirs;
}
