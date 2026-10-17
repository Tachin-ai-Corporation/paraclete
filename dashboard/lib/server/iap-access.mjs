// dashboard/lib/server/iap-access.mjs: who Identity-Aware Proxy lets through to the dashboard. IAP admits
// a person only when they hold roles/iap.httpsResourceAccessor on the dashboard's Cloud Run service;
// this module reads that grant list and adds or removes one person, through the IAP REST API's IAM
// policy calls. It knows nothing about user records: user-admin.mjs changes both together.
//
// The policy belongs to the IAP resource of the Cloud Run service,
//   projects/<project number>/iap_web/cloud_run-<region>/services/<service>
// (what `gcloud iap web add-iam-policy-binding --resource-type=cloud-run --region --service` changes).
// Every change is a read-modify-write: the policy is read with its etag and written back with it, so
// two admins changing access at once cannot overwrite each other; IAM refuses the stale write, and it is
// retried once on a fresh read. The dashboard's own service account holds roles/iap.admin on this
// resource (install/install.sh grants it), which is what lets it make these calls.

import { HttpError } from './errors.mjs';

export const IAP_API = 'https://iap.googleapis.com/v1';

/** The role IAP checks before it lets someone through to the service. */
export const IAP_ACCESSOR_ROLE = 'roles/iap.httpsResourceAccessor';

// Version 3 policies can carry conditional bindings; asking for less would hide them and writing back
// a lower version would be refused when one exists.
const POLICY_VERSION = 3;
const TIMEOUT_MS = 15_000;
const WRITE_ATTEMPTS = 2;

/**
 * The IAP resource name of the dashboard's Cloud Run service.
 *
 * @param {{projectNumber: string, region: string, service: string}} settings
 * @returns {string}
 */
export function iapResource({ projectNumber, region, service }) {
  if (!projectNumber || !region || !service) {
    throw new HttpError(503, 'the dashboard does not know its own Cloud Run service (PARACLETE_PROJECT_NUMBER, PARACLETE_REGION and the service name), so it cannot read or change who may sign in');
  }
  return `projects/${projectNumber}/iap_web/cloud_run-${region}/services/${service}`;
}

const resourceOf = (runtime) => iapResource(runtime.settings);

/** IAM's name for a person. Emails are compared lowercased; IAM keeps whatever case it was given. */
const memberOf = (email) => `user:${email}`;
const sameMember = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** An IAP call that failed: the HTTP status and Google's own error status (e.g. ABORTED). */
class IapCallError extends Error {
  constructor(message, { status = 0, reason = '' } = {}) {
    super(message);
    this.name = 'IapCallError';
    this.status = status;
    this.reason = reason;
  }
}

async function call(runtime, resource, method, body) {
  const url = `${IAP_API}/${resource}:${method}`;
  let token;
  try {
    token = await runtime.getAccessToken();
  } catch (err) {
    throw new IapCallError(`the dashboard has no access token: ${err.message}`);
  }
  let response;
  try {
    response = await runtime.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new IapCallError(`IAP could not be reached: ${err.message}`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // a body that is not JSON leaves only the status to report
  }
  if (!response.ok) {
    const detail = data?.error?.message || `HTTP ${response.status}`;
    throw new IapCallError(detail, { status: response.status, reason: data?.error?.status || '' });
  }
  return data || {};
}

/** A failed call as the person asking should read it. */
function explain(err, doing, resource) {
  if (err instanceof HttpError || !(err instanceof IapCallError)) return err;
  if (err.status === 403) {
    return new HttpError(502, `the dashboard may not ${doing}: IAP refused (${err.message}). Its service account needs roles/iap.admin on ${resource}; re-running the installer grants it`);
  }
  if (err.status === 404) {
    return new HttpError(502, `IAP has no policy for ${resource} (${err.message}); is IAP turned on for the dashboard's Cloud Run service?`);
  }
  return new HttpError(502, `the dashboard could not ${doing}: ${err.status ? `IAP answered ${err.status}: ` : ''}${err.message}`);
}

async function readPolicy(runtime, resource) {
  const policy = await call(runtime, resource, 'getIamPolicy', { options: { requestedPolicyVersion: POLICY_VERSION } });
  return { ...policy, bindings: Array.isArray(policy.bindings) ? policy.bindings : [] };
}

/**
 * Reads the policy, lets `change` return the new bindings (or null for "nothing to do"), and writes
 * it back with the etag it was read with. A write IAM refuses because the policy changed in between
 * (409, ABORTED) is retried once on a fresh read.
 */
async function changePolicy(runtime, resource, change) {
  for (let attempt = 1; ; attempt += 1) {
    const policy = await readPolicy(runtime, resource);
    const bindings = change(policy.bindings);
    if (!bindings) return { changed: false };
    try {
      await call(runtime, resource, 'setIamPolicy', { policy: { ...policy, version: POLICY_VERSION, bindings } });
      return { changed: true };
    } catch (err) {
      const conflict = err instanceof IapCallError && (err.status === 409 || err.reason === 'ABORTED');
      if (!conflict || attempt >= WRITE_ATTEMPTS) throw err;
      runtime.log('WARN', 'the IAP policy changed while it was being updated; reading it again');
    }
  }
}

/**
 * Who IAP lets through: the people (`user:` members) holding the accessor role, in any of its bindings,
 * conditional ones included, and every other kind of member (groups, domains, service accounts) that
 * also holds it. Deleted principals are left out.
 *
 * @param {object} runtime
 * @returns {Promise<{resource: string, users: string[], others: string[]}>} users as lowercase emails
 */
export async function readIapAccess(runtime) {
  const resource = resourceOf(runtime);
  let policy;
  try {
    policy = await readPolicy(runtime, resource);
  } catch (err) {
    throw explain(err, 'read who may sign in', resource);
  }
  const users = new Set();
  const others = new Set();
  for (const binding of policy.bindings) {
    if (binding?.role !== IAP_ACCESSOR_ROLE) continue;
    for (const member of binding.members || []) {
      const value = String(member);
      if (value.startsWith('deleted:')) continue;
      if (value.toLowerCase().startsWith('user:')) users.add(value.slice('user:'.length).toLowerCase());
      else others.add(value);
    }
  }
  return { resource, users: [...users].sort(), others: [...others].sort() };
}

/**
 * Lets one person through IAP. Someone who already holds the role, in any binding, is left as they
 * are: a conditional grant someone set up in the console (an access level, say) is never widened into
 * an unconditional one.
 *
 * @param {object} runtime
 * @param {string} email  normalized (users.mjs normalizeEmail)
 * @returns {Promise<{changed: boolean}>} changed is false when they already held it
 */
export async function grantIapAccess(runtime, email) {
  const resource = resourceOf(runtime);
  const member = memberOf(email);
  try {
    return await changePolicy(runtime, resource, (bindings) => {
      const holds = bindings.some((b) => b.role === IAP_ACCESSOR_ROLE && (b.members || []).some((m) => sameMember(m, member)));
      if (holds) return null;
      const plain = bindings.findIndex((b) => b.role === IAP_ACCESSOR_ROLE && !b.condition);
      if (plain === -1) return [...bindings, { role: IAP_ACCESSOR_ROLE, members: [member] }];
      return bindings.map((b, i) => (i === plain ? { ...b, members: [...(b.members || []), member] } : b));
    });
  } catch (err) {
    throw explain(err, `let ${email} sign in`, resource);
  }
}

/**
 * Takes one person's IAP access away: they are removed from every binding of the role, conditional
 * ones included, and a binding left with no members is dropped.
 *
 * @param {object} runtime
 * @param {string} email  normalized (users.mjs normalizeEmail)
 * @returns {Promise<{changed: boolean}>} changed is false when they held no grant
 */
export async function revokeIapAccess(runtime, email) {
  const resource = resourceOf(runtime);
  const member = memberOf(email);
  try {
    return await changePolicy(runtime, resource, (bindings) => {
      let removed = false;
      const next = [];
      for (const binding of bindings) {
        if (binding.role !== IAP_ACCESSOR_ROLE) {
          next.push(binding);
          continue;
        }
        const members = (binding.members || []).filter((m) => !sameMember(m, member));
        if (members.length !== (binding.members || []).length) removed = true;
        if (members.length) next.push({ ...binding, members });
      }
      return removed ? next : null;
    });
  } catch (err) {
    throw explain(err, `take ${email}'s sign-in access away`, resource);
  }
}
