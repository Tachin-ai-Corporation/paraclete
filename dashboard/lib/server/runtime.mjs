// dashboard/lib/server/runtime.mjs: what the dashboard's server code shares, built once per process.
// The instance's facts come from the environment install/install.sh sets on the Cloud Run service:
// which project, region and service this is, and which bucket and release. The Firestore client and
// the collection names are the agent's own (agent/storage/), so both sides read and write the same
// documents the same way.
//
// On a developer machine (`npm run dev` in dashboard/), the same variables come from the shell, a
// token from `gcloud auth print-access-token` stands in for the metadata server (GCP_TOKEN), and
// PARACLETE_DEV_USER names who is signed in, since there is no IAP in front. PARACLETE_DEV_USER is
// ignored on Cloud Run: there, only IAP's signed header says who someone is.

import contracts from '../../../config/contracts.json' with { type: 'json' };
import { createClient } from '../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';
import { createMetadataTokenSource } from '../../../agent/auth/metadata-token.mjs';

/** The dashboard's Cloud Run service account; install/lib/names.sh creates it under this name. */
export const DASHBOARD_ACCOUNT_ID = 'paraclete-dashboard';

/**
 * Reads the instance's facts from an environment.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object} frozen settings
 */
export function settingsFromEnv(env) {
  const project = env.PARACLETE_PROJECT || '';
  const region = env.PARACLETE_REGION || '';
  const service = env.PARACLETE_SERVICE || env.K_SERVICE || '';
  const projectNumber = env.PARACLETE_PROJECT_NUMBER || '';
  const onCloudRun = Boolean(env.K_SERVICE);
  const missing = Object.entries({ PARACLETE_PROJECT: project, PARACLETE_REGION: region, PARACLETE_PROJECT_NUMBER: projectNumber })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return Object.freeze({
    project,
    projectNumber,
    region,
    service,
    bucket: env.PARACLETE_BUCKET || (project ? `${project}-paraclete` : ''),
    repo: env.PARACLETE_REPO || '',
    release: env.PARACLETE_RELEASE || '',
    commit: env.PARACLETE_COMMIT || '',
    agentName: env.PARACLETE_AGENT_NAME || 'Paraclete',
    role: env.PARACLETE_ROLE || 'generic',
    // The role's `workspace` flag from its role.json, which the image does not carry: the installer
    // passes it. Only a role with it gets the Workspace setup.
    workspaceRole: env.PARACLETE_WORKSPACE_ROLE === 'true',
    dashboardAccount: project ? `${DASHBOARD_ACCOUNT_ID}@${project}.iam.gserviceaccount.com` : '',
    agentAccount: project ? `paraclete-agent@${project}.iam.gserviceaccount.com` : '',
    // IAP on a Cloud Run service signs its header for this audience.
    iapAudience: env.PARACLETE_IAP_AUDIENCE
      || (projectNumber && region && service ? `/projects/${projectNumber}/locations/${region}/services/${service}` : ''),
    onCloudRun,
    // Only off Cloud Run: a developer's stand-in for IAP.
    devUser: onCloudRun ? '' : String(env.PARACLETE_DEV_USER || '').trim().toLowerCase(),
    // Local fakes for development and tests (tests/fakes/); production hosts otherwise.
    firestoreHost: env.PARACLETE_FIRESTORE_HOST || undefined,
    storageHost: env.PARACLETE_STORAGE_HOST || undefined,
    missing,
  });
}

/**
 * Builds a runtime from settings. Tests pass their own token source and Firestore host.
 *
 * @param {object}   settings          from settingsFromEnv()
 * @param {object}   [deps]
 * @param {Function} [deps.getAccessToken]
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.log]
 * @returns {object}
 */
export function createRuntime(settings, deps = {}) {
  const log = deps.log || defaultLog;
  const getAccessToken = deps.getAccessToken || createMetadataTokenSource({ override: process.env.GCP_TOKEN });
  const fetch = deps.fetch || globalThis.fetch;
  const db = createClient({
    projectId: settings.project,
    getAccessToken,
    fetch,
    firestoreHost: settings.firestoreHost,
    logger: (level, ...args) => log(level, args.join(' ')),
  });
  return Object.freeze({ settings, contracts, collections: COLLECTIONS, db, getAccessToken, fetch, log });
}

let shared = null;

/** The process's runtime, built from process.env on first use. */
export function getRuntime() {
  if (!shared) {
    const settings = settingsFromEnv(process.env);
    if (settings.missing.length) {
      defaultLog('ERROR', `the dashboard is missing settings: ${settings.missing.join(', ')}`);
    }
    shared = createRuntime(settings);
  }
  return shared;
}

/** One JSON line per entry, which Cloud Logging reads as a structured entry. */
function defaultLog(level, message, extra = {}) {
  const severity = level === 'WARN' ? 'WARNING' : level;
  process.stdout.write(`${JSON.stringify({ severity, message, ...extra })}\n`);
}
