// config/instance.mjs: this instance's identity, fixed at install: its project, role, agent name,
// bucket and directories. The installer writes it to /etc/paraclete/instance.json from the VM's
// metadata; services and command-line tools read it here. Also defines where the agent's own data
// lives, apart from the installed code, which the agent can only read, and who the agent is when it
// signs something (agentIdentity).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_INSTANCE_PATH = '/etc/paraclete/instance.json';

/** Name of the agent's service account; the installer creates it in the instance's project. */
const AGENT_SERVICE_ACCOUNT = 'paraclete-agent';
const DASHBOARD_SERVICE_ACCOUNT = 'paraclete-dashboard';

const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_PATTERN = /^https?:\/\/\S+$/;

/**
 * Every problem with an instance record, as readable strings. Empty means valid.
 * @param {object} i
 * @returns {string[]}
 */
export function validateInstance(i) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  if (!i || typeof i !== 'object') return ['instance must be an object'];

  for (const key of ['project', 'region', 'zone', 'agent_name', 'role', 'install_root', 'data_root', 'bucket']) {
    need(typeof i[key] === 'string' && i[key].trim() !== '', `instance.${key} is required`);
  }
  need(!i.role || ROLE_PATTERN.test(i.role), `instance.role must be a role id like 'generic', got ${JSON.stringify(i.role)}`);
  for (const key of ['install_root', 'data_root']) {
    need(!i[key] || i[key].startsWith('/'), `instance.${key} must be an absolute path`);
  }
  need(i.install_root !== i.data_root, 'instance.data_root must differ from install_root: installed code is read-only to the agent');

  if (i.workspace != null) {
    need(EMAIL_PATTERN.test(i.workspace.account || ''), "instance.workspace.account must be the agent's Workspace email");
    need(EMAIL_PATTERN.test(i.workspace.signer || ''), 'instance.workspace.signer must be the delegation signer service account');
  }
  for (const [name, url] of Object.entries(i.endpoints || {})) {
    need(URL_PATTERN.test(url), `instance.endpoints.${name} must be an http(s) URL`);
  }
  if (i.dashboard_url) need(URL_PATTERN.test(i.dashboard_url), 'instance.dashboard_url must be an http(s) URL');
  return problems;
}

/**
 * Reads and checks the instance record. Throws, naming every problem, when it doesn't check out.
 * The path comes from PARACLETE_INSTANCE when set (development and tests), else the installed one.
 * @param {object} [options]
 * @param {string} [options.path]
 * @returns {object} the frozen instance record
 */
export function loadInstance({ path = process.env.PARACLETE_INSTANCE || DEFAULT_INSTANCE_PATH } = {}) {
  let instance;
  try {
    instance = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read the instance record at ${path}: ${err.message}`);
  }
  const problems = validateInstance(instance);
  if (problems.length) throw new Error(`Invalid instance record at ${path}:\n- ${problems.join('\n- ')}`);
  return Object.freeze({ workspace: null, endpoints: {}, gateway_token_file: '/etc/paraclete/gateway-token', ...instance });
}

/**
 * Where the agent's own data lives, under the data root. Everything the agent writes goes here; the
 * install root holds only installed code and prompts.
 * @param {{data_root: string}} instance
 */
export function dataPaths(instance) {
  const root = instance.data_root;
  return Object.freeze({
    root,
    /** Working memory (MEMORY.md) and Deep Truths. */
    memory: join(root, 'memory'),
    workingMemoryFile: join(root, 'memory', 'MEMORY.md'),
    deepTruthsFile: join(root, 'memory', 'DEEP_TRUTHS.md'),
    /** One git working tree per mission. */
    missions: join(root, 'missions'),
    /** The motor organ's scratch workspace. */
    workspace: join(root, 'workspace'),
    /** Files fetched for, or made by, missions before they go out. */
    files: join(root, 'files'),
    /** Skills the agent wrote for itself. */
    skills: join(root, 'skills'),
    /** Each service's own state, such as its heartbeat: services/<service>/health.json. */
    services: join(root, 'services'),
  });
}

/**
 * Who the agent is when it signs something: a git commit, a canon entry. Its own Workspace address
 * on a Workspace role, otherwise its service account. The brain signs its mission commits with it;
 * the command-line tools sign merge commits and canon entries with it.
 *
 * @param {{agent_name: string, project: string, workspace?: {account: string}|null}} instance
 * @returns {{name: string, email: string}} frozen
 */
export function agentIdentity(instance) {
  return Object.freeze({
    name: instance.agent_name,
    email: instance.workspace?.account || `${AGENT_SERVICE_ACCOUNT}@${instance.project}.iam.gserviceaccount.com`,
  });
}

/**
 * The dashboard's service account: the only account whose signed commands the control service runs
 * (agent/auth/command-signature.mjs). install/lib/names.sh creates it under the same name.
 *
 * @param {{project: string}} instance
 * @returns {string}
 */
export function dashboardAccountEmail(instance) {
  return `${DASHBOARD_SERVICE_ACCOUNT}@${instance.project}.iam.gserviceaccount.com`;
}
