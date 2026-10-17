// dashboard/lib/server/secrets.mjs: the agent's secrets, kept in the project's Secret Manager. An admin
// stores an API key, token or password here; the agent reads it with its `secret-read --name <name>`
// command (skills/secrets/). Called by the /api/secrets routes; admins only.
//
// Naming: a secret's Secret Manager id is exactly the name the admin gives it, with nothing added, so
// the name the dashboard shows is the name the agent passes to secret-read. The dashboard marks each
// secret it creates with the label paraclete=agent, and lists, replaces and deletes only those:
// secrets made some other way in the project are never shown or touched here. Each secret's data stays
// in the instance's region, and the agent's service account gets the Secret Accessor role on that one
// secret when it is created (no project-wide grant).
//
// A value goes in and is never sent back: nothing here reads a version's payload, and no response or
// log line carries one. The dashboard's service account holds roles/secretmanager.admin on the project
// (install/install.sh), which these calls need.

import { HttpError } from './errors.mjs';

export const SECRET_MANAGER_API = 'https://secretmanager.googleapis.com/v1';

/** The label on every secret this dashboard manages. */
export const MANAGED_LABEL = Object.freeze({ key: 'paraclete', value: 'agent' });

/** The role that lets the agent read a secret's value. */
export const SECRET_ACCESSOR_ROLE = 'roles/secretmanager.secretAccessor';

// Secret Manager's own id grammar, which secret-read checks too.
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
// Secret Manager stores at most 64 KiB per version.
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 500;
const ANNOTATION_DESCRIPTION = 'paraclete.description';
const ANNOTATION_CREATED_BY = 'paraclete.created-by';

const POLICY_VERSION = 3;
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 250;
const MAX_PAGES = 20;
const DETAIL_CONCURRENCY = 8;

function requireAdmin(actor) {
  if (actor?.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can manage secrets');
}

/**
 * A secret name as the agent will use it. Refuses anything Secret Manager would not accept as an id.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function checkSecretName(name) {
  const value = String(name ?? '').trim();
  if (!NAME_PATTERN.test(value)) {
    throw new HttpError(400, 'a secret name is 1 to 255 letters, digits, - and _ (e.g. github-token); the agent reads it by exactly this name');
  }
  return value;
}

function checkValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'the secret needs a value');
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw new HttpError(400, 'a secret value can be at most 64 KB');
  return value;
}

function checkDescription(description) {
  const value = String(description ?? '').trim();
  if (value.length > MAX_DESCRIPTION_CHARS) throw new HttpError(400, `a description can be at most ${MAX_DESCRIPTION_CHARS} characters`);
  return value;
}

function agentAccountOf(runtime) {
  const account = runtime.settings.agentAccount;
  if (!account) throw new HttpError(503, 'the dashboard does not know its project (PARACLETE_PROJECT), so it cannot name the agent\'s account');
  return account;
}

const projectPath = (runtime) => `projects/${runtime.settings.project}`;
const secretPath = (runtime, name) => `${projectPath(runtime)}/secrets/${name}`;

/** A Secret Manager call that failed: the HTTP status and Google's own error status (e.g. ABORTED). */
class SecretManagerError extends Error {
  constructor(message, { status = 0, reason = '' } = {}) {
    super(message);
    this.name = 'SecretManagerError';
    this.status = status;
    this.reason = reason;
  }
}

async function call(runtime, method, path, body) {
  let token;
  try {
    token = await runtime.getAccessToken();
  } catch (err) {
    throw new SecretManagerError(`the dashboard has no access token: ${err.message}`);
  }
  let response;
  try {
    response = await runtime.fetch(`${SECRET_MANAGER_API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SecretManagerError(`Secret Manager could not be reached: ${err.message}`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // a body that is not JSON (or none, as a delete may answer) leaves only the status
  }
  if (!response.ok) {
    throw new SecretManagerError(data?.error?.message || `HTTP ${response.status}`, { status: response.status, reason: data?.error?.status || '' });
  }
  return data || {};
}

/** A failed call as the person asking should read it. */
function explain(err, doing) {
  if (err instanceof HttpError || !(err instanceof SecretManagerError)) return err;
  if (err.status === 403) {
    return new HttpError(502, `the dashboard may not ${doing}: Secret Manager refused (${err.message}). Its service account needs roles/secretmanager.admin on the project; re-running the installer grants it`);
  }
  return new HttpError(502, `the dashboard could not ${doing}: ${err.status ? `Secret Manager answered ${err.status}: ` : ''}${err.message}`);
}

const isManaged = (secret) => secret?.labels?.[MANAGED_LABEL.key] === MANAGED_LABEL.value;

/** The secret's metadata, or a 404 when it does not exist or is not one this dashboard manages. */
async function managedSecret(runtime, name, doing) {
  try {
    const secret = await call(runtime, 'GET', secretPath(runtime, name));
    if (isManaged(secret)) return secret;
  } catch (err) {
    if (!(err instanceof SecretManagerError && err.status === 404)) throw explain(err, doing);
  }
  throw new HttpError(404, `there is no secret '${name}' managed by this dashboard`);
}

function holdsAccess(bindings, member) {
  return bindings.some((b) => b.role === SECRET_ACCESSOR_ROLE && (b.members || []).some((m) => String(m).toLowerCase() === member.toLowerCase()));
}

async function readPolicy(runtime, name) {
  const policy = await call(runtime, 'GET', `${secretPath(runtime, name)}:getIamPolicy?options.requestedPolicyVersion=${POLICY_VERSION}`);
  return { ...policy, bindings: Array.isArray(policy.bindings) ? policy.bindings : [] };
}

/**
 * Gives the agent's account the Secret Accessor role on one secret: read the policy, add the member,
 * write it back with the etag it was read with, and on a conflict (someone changed it in between)
 * once more on a fresh read.
 */
async function grantAgent(runtime, name) {
  const member = `serviceAccount:${agentAccountOf(runtime)}`;
  for (let attempt = 1; ; attempt += 1) {
    const policy = await readPolicy(runtime, name);
    if (holdsAccess(policy.bindings, member)) return { changed: false };
    const plain = policy.bindings.findIndex((b) => b.role === SECRET_ACCESSOR_ROLE && !b.condition);
    const bindings = plain === -1
      ? [...policy.bindings, { role: SECRET_ACCESSOR_ROLE, members: [member] }]
      : policy.bindings.map((b, i) => (i === plain ? { ...b, members: [...(b.members || []), member] } : b));
    try {
      await call(runtime, 'POST', `${secretPath(runtime, name)}:setIamPolicy`, { policy: { ...policy, version: POLICY_VERSION, bindings } });
      return { changed: true };
    } catch (err) {
      const conflict = err instanceof SecretManagerError && (err.status === 409 || err.reason === 'ABORTED');
      if (!conflict || attempt >= 2) throw err;
      runtime.log('WARN', `the access policy of secret ${name} changed while it was being updated; reading it again`);
    }
  }
}

/** Adds a version holding the value; returns the version's metadata (Secret Manager echoes no payload). */
function addVersion(runtime, name, value) {
  return call(runtime, 'POST', `${secretPath(runtime, name)}:addVersion`, {
    payload: { data: Buffer.from(value, 'utf8').toString('base64') },
  });
}

const versionNumber = (resourceName) => {
  const n = Number(String(resourceName || '').split('/').pop());
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** What the dashboard shows of a secret: never its value. */
function shape(secret, { latest = null, agentAccess = null, detailError = null } = {}) {
  return {
    name: String(secret.name || '').split('/').pop(),
    description: secret.annotations?.[ANNOTATION_DESCRIPTION] || '',
    created_at: secret.createTime ?? null,
    created_by: secret.annotations?.[ANNOTATION_CREATED_BY] || null,
    version: latest ? versionNumber(latest.name) : null,
    version_state: latest?.state ?? null,
    updated_at: latest?.createTime ?? null,
    agent_access: agentAccess,
    problem: detailError,
  };
}

/** The latest version's metadata and whether the agent may read the secret; a failure is reported, not thrown. */
async function details(runtime, secret) {
  const name = String(secret.name).split('/').pop();
  const member = `serviceAccount:${runtime.settings.agentAccount}`;
  const [latest, policy] = await Promise.allSettled([
    call(runtime, 'GET', `${secretPath(runtime, name)}/versions/latest`),
    readPolicy(runtime, name),
  ]);
  const problems = [latest, policy].filter((r) => r.status === 'rejected' && !(r.reason?.status === 404)).map((r) => r.reason.message);
  return shape(secret, {
    latest: latest.status === 'fulfilled' ? latest.value : null,
    agentAccess: policy.status === 'fulfilled' ? holdsAccess(policy.value.bindings, member) : null,
    detailError: problems.length ? problems.join('; ') : null,
  });
}

/**
 * The secrets this dashboard manages, by name: each with its description, who created it and when,
 * its latest version, and whether the agent's account may read it.
 *
 * @param {object} runtime
 * @param {{actor: {email: string, role: string}}} o
 * @returns {Promise<{secrets: object[], agent_account: string}>}
 */
export async function listSecrets(runtime, { actor }) {
  requireAdmin(actor);
  const found = [];
  try {
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ filter: `labels.${MANAGED_LABEL.key}=${MANAGED_LABEL.value}`, pageSize: String(PAGE_SIZE) });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await call(runtime, 'GET', `${projectPath(runtime)}/secrets?${query}`);
      found.push(...(data.secrets || []).filter(isManaged));
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
  } catch (err) {
    throw explain(err, 'list the secrets');
  }
  const secrets = [];
  for (let i = 0; i < found.length; i += DETAIL_CONCURRENCY) {
    secrets.push(...(await Promise.all(found.slice(i, i + DETAIL_CONCURRENCY).map((secret) => details(runtime, secret)))));
  }
  secrets.sort((a, b) => a.name.localeCompare(b.name));
  return { secrets, agent_account: runtime.settings.agentAccount };
}

/**
 * Creates a secret with its first value and lets the agent read it. All or nothing: if the value or
 * the grant cannot be added, the new secret is deleted again.
 *
 * @param {object} runtime
 * @param {{name: string, value: string, description?: string, actor: {email: string, role: string}}} o
 * @returns {Promise<object>} the secret as listed
 */
export async function createSecret(runtime, { name, value, description, actor }) {
  requireAdmin(actor);
  const id = checkSecretName(name);
  checkValue(value);
  const text = checkDescription(description);
  agentAccountOf(runtime);

  const { region } = runtime.settings;
  const body = {
    replication: region ? { userManaged: { replicas: [{ location: region }] } } : { automatic: {} },
    labels: { [MANAGED_LABEL.key]: MANAGED_LABEL.value },
    annotations: { [ANNOTATION_CREATED_BY]: actor.email, ...(text ? { [ANNOTATION_DESCRIPTION]: text } : {}) },
  };
  let secret;
  try {
    secret = await call(runtime, 'POST', `${projectPath(runtime)}/secrets?secretId=${encodeURIComponent(id)}`, body);
  } catch (err) {
    if (err instanceof SecretManagerError && err.status === 409) {
      throw new HttpError(409, `a secret named '${id}' already exists in this project's Secret Manager (one made outside the dashboard does not show here); choose another name`);
    }
    throw explain(err, `create the secret '${id}'`);
  }

  try {
    const latest = await addVersion(runtime, id, value);
    await grantAgent(runtime, id);
    return shape(secret, { latest, agentAccess: true });
  } catch (err) {
    const failure = explain(err, `store the secret '${id}'`);
    try {
      await call(runtime, 'DELETE', secretPath(runtime, id));
    } catch (undoErr) {
      runtime.log('ERROR', `secret ${id} was created but could not be finished or deleted again: ${undoErr.message}`);
      throw new HttpError(502, `${failure.message}; the half-made secret '${id}' could not be deleted again (${undoErr.message}), so delete it from the list`);
    }
    throw failure;
  }
}

/**
 * Replaces a secret's value: a new version, which the agent's next read of `latest` gets. Earlier
 * versions stay in Secret Manager.
 *
 * @param {object} runtime
 * @param {{name: string, value: string, actor: {email: string, role: string}}} o
 * @returns {Promise<{name: string, version: number|null, updated_at: string|null}>}
 */
export async function replaceSecretValue(runtime, { name, value, actor }) {
  requireAdmin(actor);
  const id = checkSecretName(name);
  checkValue(value);
  await managedSecret(runtime, id, `replace the secret '${id}'`);
  try {
    const latest = await addVersion(runtime, id, value);
    return { name: id, version: versionNumber(latest.name), updated_at: latest.createTime ?? null };
  } catch (err) {
    throw explain(err, `replace the secret '${id}'`);
  }
}

/**
 * Gives the agent access to a secret again, when its grant was removed outside the dashboard.
 *
 * @param {object} runtime
 * @param {{name: string, actor: {email: string, role: string}}} o
 * @returns {Promise<{name: string, changed: boolean}>}
 */
export async function grantSecretToAgent(runtime, { name, actor }) {
  requireAdmin(actor);
  const id = checkSecretName(name);
  agentAccountOf(runtime);
  await managedSecret(runtime, id, `grant the agent the secret '${id}'`);
  try {
    return { name: id, ...(await grantAgent(runtime, id)) };
  } catch (err) {
    throw explain(err, `grant the agent the secret '${id}'`);
  }
}

/**
 * Deletes a secret and every version of it. The agent can no longer read it.
 *
 * @param {object} runtime
 * @param {{name: string, actor: {email: string, role: string}}} o
 * @returns {Promise<{name: string}>}
 */
export async function deleteSecret(runtime, { name, actor }) {
  requireAdmin(actor);
  const id = checkSecretName(name);
  await managedSecret(runtime, id, `delete the secret '${id}'`);
  try {
    await call(runtime, 'DELETE', secretPath(runtime, id));
  } catch (err) {
    if (!(err instanceof SecretManagerError && err.status === 404)) throw explain(err, `delete the secret '${id}'`);
  }
  return { name: id };
}
