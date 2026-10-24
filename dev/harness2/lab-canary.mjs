// dev/harness2/lab-canary.mjs: the harness lab's canary, in a project of its own. Lab only: nothing here
// is in install/manifest.txt. The canary is a full paraclete install, and one Google Cloud project holds
// one paraclete (docs/canon/PRODUCT.md, P-1), so it never runs beside the driver: it gets its own
// project, `<lab project>-canary` unless --canary-project names one. This file says which project
// that is, what access the driver's agent account gets to it so that the harness can check the canary
// with the dev/ commands a developer runs against a dev instance (status, smoke, say, query, logs,
// trigger, and dev/deploy.mjs --vm-only), and what the driver's harness checkout reads the canary's
// coordinates from: `.local/instance.env`, in the dev/instance.env.example format, written by a root
// script that writes it as the checkout's owner. The canary runs main's head: its follow-main timer
// (lab-updater.mjs) moves it back there within one interval, so it is where main's head is checked,
// never where a branch is tested. It runs nothing itself: live-runner.mjs (buildGcpLabPlan,
// provisionGcpLab, inspectGcpLabStatus) makes the gcloud calls and runs the script over IAP SSH, for
// `node dev/harness2/cli.mjs lab-provision` and `lab-status`, and cli.mjs's `canary` takes its default
// VM from here.

import { FOLLOW_MAIN, remoteRootCommand } from './lab-updater.mjs';

/** A Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, from a letter, not ending in a hyphen. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PROJECT_ID_RULE = '6 to 30 lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen';

export const LAB_CANARY = Object.freeze({
  vm: 'paraclete-h2-canary',
  driverVm: 'paraclete-h2-driver',
  /** The canary's project is the lab's with this added, unless --canary-project names one. */
  projectSuffix: '-canary',
  /**
   * What the driver's account gets on the canary's project. dev-env.mjs reaches the VM with
   * `gcloud compute ssh --tunnel-through-iap` and sudo (deploy, status, smoke and logs), reads and
   * writes Firestore as the caller (all of them; say, smoke and trigger write messages and triggers),
   * and status asks Cloud Run for the dashboard. Each role is the least predefined one for its part.
   */
  driverProjectRoles: Object.freeze([
    'roles/iap.tunnelResourceAccessor',
    'roles/datastore.user',
    'roles/run.viewer',
  ]),
  /**
   * gcloud compute ssh puts the caller's key in the VM's metadata (the lab does not use OS Login). The
   * predefined roles that may set instance metadata can also create and delete VMs, so the driver gets
   * a custom role in the canary's project with what gcloud compute ssh calls, and no more: read the
   * project and the instance (whose metadata says how keys are taken), read the host keys from guest
   * attributes, set the instance's metadata, and wait for that operation.
   */
  sshRole: Object.freeze({
    id: 'paracleteLabDriverSsh',
    title: 'Harness lab driver: SSH to the canary',
    description: "Lets the harness lab's driver put its SSH key in the canary VM's metadata, for gcloud compute ssh over IAP. Lab only.",
    permissions: Object.freeze([
      'compute.instances.get',
      'compute.instances.getGuestAttributes',
      'compute.instances.setMetadata',
      'compute.projects.get',
      'compute.zoneOperations.get',
    ]),
  }),
  /** Setting metadata on a VM that runs as a service account takes actAs on that account. */
  driverServiceAccountRole: 'roles/iam.serviceAccountUser',
  /**
   * The user the driver logs in to the canary as. The driver's harness runs as the paraclete user, and
   * gcloud would log in under that name, which on every VM is the agent's own user (no login shell, and
   * never a sudoer).
   */
  sshUser: 'lab-driver',
  /** The canary's coordinates in the driver's harness checkout. .local/ is gitignored. */
  instanceEnvPath: `${FOLLOW_MAIN.harnessCheckout}/.local/instance.env`,
  /** The remote script's name ($0). */
  scriptName: 'paraclete-lab-canary-env',
});

/**
 * The canary's project: `canaryProjectId` when given, else the lab's with `-canary` added. Throws, with
 * what to do, when that is not a project id, or is the lab's own project.
 *
 * @param {string} labProjectId
 * @param {string|boolean|undefined} [canaryProjectId]  --canary-project as given
 * @returns {string}
 */
export function canaryProjectFor(labProjectId, canaryProjectId) {
  if (canaryProjectId === true || canaryProjectId === '') throw new Error('--canary-project needs a project id');
  if (canaryProjectId !== undefined && canaryProjectId !== null) {
    const id = String(canaryProjectId);
    if (!PROJECT_ID.test(id)) throw new Error(`--canary-project ${id.slice(0, 64)} is not a project id (${PROJECT_ID_RULE})`);
    if (id === labProjectId) {
      throw new Error(`--canary-project must name a project of its own, not the lab's (${labProjectId}): one project holds one paraclete`);
    }
    return id;
  }
  const fallback = `${labProjectId}${LAB_CANARY.projectSuffix}`;
  if (PROJECT_ID.test(fallback)) return fallback;
  const why = fallback.length > 30
    ? `the default, ${fallback}, is ${fallback.length} characters, and a project id has at most 30`
    : `the default, ${fallback}, is not a project id (${PROJECT_ID_RULE})`;
  throw new Error(`--canary-project is required: ${why}. Name the canary's project with --canary-project <id>.`);
}

/**
 * The bindings that give the driver's agent account its access to the canary's project.
 *
 * @param {object} o
 * @param {string} o.canaryProjectId
 * @param {string} o.driverServiceAccountEmail
 * @param {string} o.canaryServiceAccountEmail
 */
export function driverAccessOnCanary({ canaryProjectId, driverServiceAccountEmail, canaryServiceAccountEmail }) {
  const sshRoleName = `projects/${canaryProjectId}/roles/${LAB_CANARY.sshRole.id}`;
  return {
    projectId: canaryProjectId,
    member: `serviceAccount:${driverServiceAccountEmail}`,
    sshRole: { ...LAB_CANARY.sshRole, name: sshRoleName, permissions: [...LAB_CANARY.sshRole.permissions] },
    projectRoles: [...LAB_CANARY.driverProjectRoles, sshRoleName],
    serviceAccountRoles: [{ serviceAccount: canaryServiceAccountEmail, role: LAB_CANARY.driverServiceAccountRole }],
  };
}

/**
 * The canary's coordinates as `.local/instance.env` holds them (dev-env.mjs loadInstanceEnv reads
 * them). The canary has no dashboard, so there is no DASHBOARD_URL.
 *
 * @param {object} o
 * @param {string} o.projectId
 * @param {string} o.region
 * @param {string} o.zone
 * @param {string} [o.vm]
 * @param {string} [o.sshUser]
 * @returns {string}
 */
export function canaryInstanceEnv({ projectId, region, zone, vm = LAB_CANARY.vm, sshUser = LAB_CANARY.sshUser }) {
  return [
    '# The canary of the harness lab, for the dev/ commands in this checkout (dev/README.md, the harness lab).',
    '# Written by node dev/harness2/cli.mjs lab-provision, which writes it again on every run. Never commit it.',
    `PROJECT_ID=${projectId}`,
    `REGION=${region}`,
    `ZONE=${zone}`,
    `VM=${vm}`,
    `SSH_USER=${sshUser}`,
    '',
  ].join('\n');
}

/**
 * The root script that writes `text` to `<checkout>/.local/instance.env`. The checkout belongs to the
 * paraclete user, so the file is written as that user (runuser), never as root: a link put in the
 * checkout's place leads nowhere root would not go. The file is replaced by rename, and only when its
 * content differs. It writes nothing when there is no checkout yet, or one the paraclete user does not
 * own. Prints lab-canary.instance_env=<changed|unchanged|no-checkout|not-owned-by-paraclete|failed>.
 * Safe to run twice.
 *
 * @param {object} o
 * @param {string} o.text
 * @param {string} [o.checkout]
 * @param {string} [o.root]  prefix for the checkout's path, for the tests; '' on a VM
 * @returns {string}
 */
export function instanceEnvScript({ text, checkout = FOLLOW_MAIN.harnessCheckout, root = '' }) {
  if (root && !/^[A-Za-z0-9._:/ -]+$/.test(root)) throw new Error(`unusable root '${root}'`);
  if (!/^\/[A-Za-z0-9._/-]+$/.test(checkout)) throw new Error(`the harness checkout must be an absolute path without spaces, got '${checkout}'`);
  if (!/^[A-Za-z0-9 #._:/=(),-]*$/.test(text.replace(/\n/g, ''))) throw new Error('instance.env may hold only plain characters');
  return `set -euo pipefail
ROOT='${root}'
CHECKOUT="$ROOT${checkout}"
OWNER=paraclete
CONTENT='${text}'
write_instance_env() {  # write_instance_env <checkout> <content>, as the checkout's owner
  set -euo pipefail
  umask 022
  TMP=''
  trap 'rm -f "$TMP"' EXIT
  mkdir -p "$1/.local"
  TMP="$(mktemp "$1/.local/.instance.env.XXXXXX")"
  printf '%s' "$2" > "$TMP"
  if [[ -f "$1/.local/instance.env" && ! -L "$1/.local/instance.env" ]] && cmp -s "$TMP" "$1/.local/instance.env"; then
    printf 'unchanged'
  else
    chmod 0644 "$TMP"
    mv -fT "$TMP" "$1/.local/instance.env"
    TMP=''
    printf 'changed'
  fi
}
if [[ ! -e "$CHECKOUT/.git" ]]; then
  state=no-checkout
elif [[ "$(stat -c %U "$CHECKOUT" 2>/dev/null)" != "$OWNER" ]]; then
  state="not-owned-by-$OWNER"
else
  state="$(runuser -u "$OWNER" -- bash -c "$(declare -f write_instance_env); write_instance_env \\"\\$@\\"" ${LAB_CANARY.scriptName} "$CHECKOUT" "$CONTENT")" || state=failed
fi
printf 'lab-canary.instance_env=%s\\n' "$state"
`;
}

/**
 * The one-line remote command that runs instanceEnvScript() as root on the driver (lab-updater.mjs
 * remoteRootCommand).
 *
 * @param {object} o  as instanceEnvScript, without root
 * @returns {string}
 */
export function instanceEnvRemoteCommand({ text, checkout }) {
  return remoteRootCommand(instanceEnvScript({ text, checkout }), LAB_CANARY.scriptName);
}

const STATE_ERRORS = Object.freeze({
  'no-checkout': `there is no harness checkout at ${FOLLOW_MAIN.harnessCheckout} yet`,
  'not-owned-by-paraclete': `the harness checkout at ${FOLLOW_MAIN.harnessCheckout} is not the paraclete user's`,
  failed: 'the paraclete user could not write it',
});

/**
 * What the instance.env script's output says: ok when the file holds the canary's coordinates.
 *
 * @param {string} text  the script's output; anything but its lab-canary.<key>=<value> lines is ignored
 * @returns {{ok: boolean, state: string|null, error?: string}}
 */
export function instanceEnvResult(text) {
  let state = null;
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const m = /^lab-canary\.instance_env=(.*)$/.exec(line);
    if (m) state = m[1].trim();
  }
  const ok = state === 'changed' || state === 'unchanged';
  return { ok, state, ...(ok ? {} : { error: STATE_ERRORS[state] || 'the script that writes instance.env did not finish' }) };
}

/** The command that deletes a canary left in the lab's own project. */
export function oldCanaryDeleteCommand({ projectId, zone }) {
  return `gcloud compute instances delete ${LAB_CANARY.vm} --project=${projectId} --zone=${zone}`;
}
