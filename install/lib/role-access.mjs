// install/lib/role-access.mjs: what a role asks the installer to give its agent, read and checked in one
// place. A role's role.json names project roles (`gcp_roles`), the Google APIs it needs turned on
// (`apis`, short names: `bigquery` is bigquery.googleapis.com) and grants on single resources
// (`resource_roles`, each `{ role, on }`). install/install.sh runs this file as a small command-line
// program (steps 1 to 3); tests/content/packages.test.mjs imports it, so the rules every role package
// must follow and the rules the installer enforces are one definition. It reads role.json files and
// prints; it never calls gcloud.
//
// Why single-resource grants exist: some roles must never be granted on the whole project. Acting as a
// service account (`iam.serviceAccountUser`) project-wide reaches every account, the dashboard's
// included, whose signature the VM's control service trusts; writing to Artifact Registry project-wide
// reaches the dashboard's own image repository. A role that needs them gets them on one resource that
// is its agent's own:
//
//   agent-account     the agent's service account, paraclete-agent@: the agent may act as itself only
//   agent-repository  the Artifact Registry Docker repository `agent-images` in the instance's region,
//                     which the installer creates when a role asks for it
//
//   node install/lib/role-access.mjs check <repo> <role>           nothing, or the problems (exit 2)
//   node install/lib/role-access.mjs apis <repo> <role>            short API names, one per line
//   node install/lib/role-access.mjs resource-roles <repo> <role>  <kind> TAB <role>, one per line
//   node install/lib/role-access.mjs project-wide-refused          PROJECT_WIDE_REFUSED, one per line
//
// The commands that take a role cover generic and that role together (every instance has both),
// generic's first, each entry once, and check both files first: a problem in either stops them. The
// repository is an argument of its own, not key=value, so Git for Windows' bash hands Node a path it
// can open.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The resources a `resource_roles` entry may name, and the roles each may carry there. */
export const RESOURCE_KINDS = Object.freeze({
  // Acting as itself: Cloud Build runs the agent's builds as this account, and the services it deploys
  // run as it unless an admin lets it act as another runtime account. Signing as itself adds nothing the
  // VM's own credentials do not already allow.
  'agent-account': Object.freeze(['roles/iam.serviceAccountUser', 'roles/iam.serviceAccountTokenCreator']),
  // Its own images. Not roles/artifactregistry.admin: that also changes who may read the repository.
  'agent-repository': Object.freeze(['roles/artifactregistry.reader', 'roles/artifactregistry.writer', 'roles/artifactregistry.repoAdmin']),
});

/**
 * Roles never granted on the whole project, by any role. The first four let the agent act as, or mint
 * credentials for, every service account in the project, the dashboard's included; the rest let it
 * write to every Artifact Registry repository, the dashboard's included. A role that needs act-as or
 * image push asks for it in `resource_roles`, on its own account or repository (RESOURCE_KINDS).
 */
export const PROJECT_WIDE_REFUSED = Object.freeze([
  'roles/iam.serviceAccountUser',
  'roles/iam.serviceAccountTokenCreator',
  'roles/iam.serviceAccountOpenIdTokenCreator',
  'roles/iam.workloadIdentityUser',
  'roles/artifactregistry.writer',
  'roles/artifactregistry.repoAdmin',
  'roles/artifactregistry.admin',
  'roles/artifactregistry.createOnPushWriter',
  'roles/artifactregistry.createOnPushRepoAdmin',
]);

/** A short API name: the part before .googleapis.com, e.g. bigquery, calendar-json. */
export const API_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A predefined or custom role name, as gcloud takes it. */
const GCP_ROLE_NAME = /^roles\/[A-Za-z0-9_.]+$/;

/** A role id is one path segment. */
const ROLE_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Everything wrong with a role record's grants and APIs; an empty list when nothing is.
 *
 * @param {object} role a parsed role.json
 * @returns {string[]}
 */
export function accessProblems(role) {
  const problems = [];
  const gcpRoles = Array.isArray(role?.gcp_roles) ? role.gcp_roles : [];
  for (const name of gcpRoles.filter((g) => PROJECT_WIDE_REFUSED.includes(g))) {
    const kind = Object.keys(RESOURCE_KINDS).find((k) => RESOURCE_KINDS[k].includes(name));
    problems.push(`gcp_roles: ${name} is never granted on the whole project${kind ? `; ask for it in resource_roles, on ${kind}` : ''}`);
  }
  if (role?.apis !== undefined) {
    if (!Array.isArray(role.apis)) {
      problems.push('apis: must be a list of short API names, like bigquery');
    } else {
      for (const api of role.apis) {
        if (typeof api !== 'string' || !API_NAME.test(api)) {
          problems.push(`apis: ${JSON.stringify(api)} is not a short API name like bigquery (the part before .googleapis.com)`);
        }
      }
      if (new Set(role.apis).size !== role.apis.length) problems.push('apis: has duplicates');
    }
  }
  if (role?.resource_roles !== undefined) {
    if (!Array.isArray(role.resource_roles)) {
      problems.push('resource_roles: must be a list of { role, on }');
    } else {
      const seen = new Set();
      for (const entry of role.resource_roles) {
        const label = JSON.stringify(entry);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          problems.push(`resource_roles: ${label} is not { role, on }`);
          continue;
        }
        const extra = Object.keys(entry).filter((key) => key !== 'role' && key !== 'on');
        if (extra.length) problems.push(`resource_roles: ${label} has fields outside { role, on }`);
        const allowed = RESOURCE_KINDS[entry.on];
        if (!allowed) {
          problems.push(`resource_roles: ${label}: on must be one of ${Object.keys(RESOURCE_KINDS).join(', ')}`);
        } else if (typeof entry.role !== 'string' || !GCP_ROLE_NAME.test(entry.role)) {
          problems.push(`resource_roles: ${label}: role must be a role name like roles/iam.serviceAccountUser`);
        } else if (!allowed.includes(entry.role)) {
          problems.push(`resource_roles: ${label}: on ${entry.on} the role is one of ${allowed.join(', ')}`);
        }
        const key = `${entry.on}\t${entry.role}`;
        if (seen.has(key)) problems.push(`resource_roles: ${label} is listed twice`);
        seen.add(key);
      }
    }
  }
  return problems;
}

/**
 * One role's record, from <root>/roles/<id>/role.json.
 *
 * @param {string} root
 * @param {string} id
 * @param {(path: string) => string} [readFile]
 * @returns {object}
 */
export function readRole(root, id, readFile = (path) => readFileSync(path, 'utf8')) {
  if (!ROLE_ID.test(String(id))) throw new Error(`'${id}' is not a role id`);
  const path = join(root, 'roles', id, 'role.json');
  let text;
  try {
    text = readFile(path);
  } catch (err) {
    throw new Error(`roles/${id}/role.json cannot be read (${err.code || err.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`roles/${id}/role.json is not JSON (${err.message})`);
  }
}

/**
 * What generic and the role ask for together, generic's first, each entry once. Throws, naming every
 * problem in either file.
 *
 * @param {string} root the repository (or release) holding roles/
 * @param {string} id   the instance's role
 * @param {{readFile?: (path: string) => string}} [deps]
 * @returns {{apis: string[], resourceRoles: {on: string, role: string}[]}}
 */
export function roleAccess(root, id, { readFile } = {}) {
  const ids = id === 'generic' ? ['generic'] : ['generic', id];
  const records = ids.map((roleId) => [roleId, readRole(root, roleId, readFile)]);
  const problems = records.flatMap(([roleId, record]) => accessProblems(record).map((p) => `roles/${roleId}/role.json ${p}`));
  if (problems.length) throw new Error(problems.join('\n'));
  const apis = [...new Set(records.flatMap(([, record]) => record.apis || []))];
  const resourceRoles = [];
  const seen = new Set();
  for (const [, record] of records) {
    for (const { on, role } of record.resource_roles || []) {
      if (seen.has(`${on}\t${role}`)) continue;
      seen.add(`${on}\t${role}`);
      resourceRoles.push({ on, role });
    }
  }
  return { apis, resourceRoles };
}

// ---------------------------------------------------------------------------------------------------
// The command line install/install.sh uses: node install/lib/role-access.mjs <command> [<repo> <role>]
// ---------------------------------------------------------------------------------------------------

/** The commands that read a role, given what generic and the role ask for together. */
const ROLE_COMMANDS = {
  check: () => '',
  apis: (access) => access.apis.join('\n'),
  'resource-roles': (access) => access.resourceRoles.map(({ on, role }) => `${on}\t${role}`).join('\n'),
};

/**
 * Runs one command. Exported for the tests.
 *
 * @param {string[]} argv <command> [<repo> <role>]
 * @param {{readFile?: (path: string) => string}} [deps]
 * @returns {string} what the command prints
 */
export function cli(argv, deps = {}) {
  const [command, ...args] = argv;
  if (command === 'project-wide-refused' && args.length === 0) return PROJECT_WIDE_REFUSED.join('\n');
  if (!ROLE_COMMANDS[command]) {
    throw new Error(`install/lib/role-access.mjs: unknown command '${command}'. Commands: ${[...Object.keys(ROLE_COMMANDS), 'project-wide-refused'].join(', ')}`);
  }
  const [root, role, ...rest] = args;
  if (!root || !role || rest.length) throw new Error(`install/lib/role-access.mjs: usage: ${command} <repo> <role>`);
  return ROLE_COMMANDS[command](roleAccess(root, role, deps));
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (path) => {
    try { return realpathSync(path); } catch { return path; }
  };
  const norm = (path) => (process.platform === 'win32' ? real(path).toLowerCase() : real(path));
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isMain()) {
  try {
    const output = cli(process.argv.slice(2));
    if (output) process.stdout.write(`${output}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}
