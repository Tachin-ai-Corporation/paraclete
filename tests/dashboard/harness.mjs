// tests/dashboard/harness.mjs: a dashboard runtime against the Firestore fake, for the tests of
// dashboard/lib/server/. The runtime is the real one (createRuntime), pointed at the fake; requests
// carry a developer user (PARACLETE_DEV_USER) instead of IAP's header, except in the IAP tests.
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createRuntime, settingsFromEnv } from '../../dashboard/lib/server/runtime.mjs';
import { firestoreEncode } from '../../agent/storage/firestore.mjs';

export const PROJECT = 'your-gcp-project';

/**
 * Starts the Firestore fake and builds a runtime on it.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]   overrides for the environment
 * @param {Function} [options.fetch]               fetch for everything but Firestore (IAM, IAP keys...)
 * @returns {Promise<{runtime: object, firestore: object, lines: object[], seed: Function, doc: Function, stop: Function}>}
 */
export async function startDashboard({ env = {}, fetch } = {}) {
  const firestore = await startFirestore({ projectId: PROJECT });
  const settings = settingsFromEnv({
    PARACLETE_PROJECT: PROJECT,
    PARACLETE_PROJECT_NUMBER: '123456789012',
    PARACLETE_REGION: 'us-central1',
    PARACLETE_SERVICE: 'paraclete',
    PARACLETE_DEV_USER: 'admin@example.com',
    PARACLETE_FIRESTORE_HOST: firestore.origin,
    ...env,
  });
  const lines = [];
  // Firestore calls go to the fake through its host; any other call goes to the test's fetch.
  const routedFetch = (url, init) => (String(url).startsWith(firestore.origin) || !fetch ? globalThis.fetch(url, init) : fetch(url, init));
  const runtime = createRuntime(settings, {
    getAccessToken: async () => 'dashboard-token',
    fetch: routedFetch,
    log: (level, message) => lines.push({ level, message }),
  });

  /** Writes documents as `{ 'users/a@example.com': { role: 'admin' } }`, encoded the client's way. */
  async function seed(docs) {
    for (const [path, data] of Object.entries(docs)) await runtime.db.write(path, data, { strict: true });
  }
  /** Reads one document back, decoded. */
  const doc = (path) => runtime.db.read(path, { strict: true });

  return { runtime, firestore, lines, seed, doc, encode: firestoreEncode, stop: () => firestore.stop() };
}

/** A Headers object with the given values. */
export const headersOf = (values = {}) => new Headers(values);
