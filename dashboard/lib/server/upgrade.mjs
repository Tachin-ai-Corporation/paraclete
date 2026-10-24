// dashboard/lib/server/upgrade.mjs: an admin installs a release from the dashboard, and the dashboard
// follows it to the end. The VM moves first, then the dashboard, so a failed VM upgrade leaves the
// dashboard as it was:
//
//   vm      the signed `upgrade { ref: <version> }` command to the VM's control service, which runs that
//           release's own upgrader and restarts the agent's services on it (agent/services/control);
//   build   once that command is done and the agent reports ready on the release's commit: Cloud Build
//           builds the dashboard's image at that commit with the commit's own build config
//           (dashboard/cloudbuild.json, read from GitHub), as the dashboard's service account, in the
//           instance's region, unless the image exists already;
//   deploy  Cloud Run's Admin API (v2) rolls the dashboard's own service to that image: the service as
//           read, with only the image and PARACLETE_RELEASE and PARACLETE_COMMIT changed, so IAP and
//           every other setting stay as they are; once it serves, the automatic-update job
//           (contracts.auto_update.job_name, auto-update.mjs) is moved to the same image the same way,
//           when it exists, so the job always runs the dashboard's own code;
//   done | failed.
//
// The upgrade is one Firestore document, `config/upgrade`: { id, version, commit, requested_by,
// requested_at, state, vm_command_id, build_id, operation, error, updated_at }. Starting one
// creates or replaces it only if nobody changed it since it was read, so two admins cannot start two.
// Nothing runs in the background: every read of the upgrade (GET /api/upgrade, which the System tab
// polls while one runs) checks the current step and, when it finished, moves to the next. Each move is
// claimed first with a write guarded by the document's update time, then the call is made, then its
// id is recorded: of two dashboards reading at once, one claims and the other sees the claim, so a
// build or a rollout is started once. A claim whose call was never recorded (the dashboard stopped in
// between) fails after STEP_START_GRACE_SECONDS, and installing the same release again finishes it.
//
// The image is <region>-docker.pkg.dev/<project>/<repository>/<image name>:<commit>: the repository
// is IMAGE_REPOSITORY (install/lib/names.sh creates it; a test pins the two together); the image's
// name, the build config's path and the build's timeout come from config/contracts.json's `dashboard`
// section, which install/lib/dashboard.mjs reads too. Which releases exist and which one is installed:
// releases.mjs. Called by the /api/upgrade route, and by the automatic-update job (auto-update.mjs),
// which starts and follows an upgrade as the dashboard's own account.

import { commitUrl, isVersion } from '../../../agent/release/versions.mjs';
import { StoreConflict, StoreUnavailable } from '../../../agent/storage/firestore.mjs';
import { HttpError } from './errors.mjs';
import { newDocId, sendCommand } from './commands.mjs';
import { GitHubError, githubJson, installRefusal, loadReleases } from './releases.mjs';

/** The upgrade in progress, or the last one, under `config`. */
export const UPGRADE_DOC = 'upgrade';

/** The dashboard's Artifact Registry repository; install/lib/names.sh's IMAGE_REPOSITORY creates it. */
export const IMAGE_REPOSITORY = 'paraclete';

/** The states of an upgrade, in order. */
export const STATES = Object.freeze(['vm', 'build', 'deploy', 'done', 'failed']);

/** The states in which an upgrade is still running. */
export const RUNNING_STATES = Object.freeze(['vm', 'build', 'deploy']);

/** How long a claimed step may wait for its call to be recorded before it counts as interrupted. */
export const STEP_START_GRACE_SECONDS = 120;

/** Added to control's upgrade_max_seconds before a VM upgrade that never finished counts as failed. */
export const VM_MARGIN_SECONDS = 600;

/** How a Cloud Build build ends when it did not succeed. */
const BUILD_FAILED = new Set(['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);

const CLOUD_BUILD_API = 'https://cloudbuild.googleapis.com/v1';
const CLOUD_RUN_API = 'https://run.googleapis.com/v2';
const ARTIFACT_REGISTRY_API = 'https://artifactregistry.googleapis.com/v1';
const RAW_GITHUB = 'https://raw.githubusercontent.com';
const TIMEOUT_MS = 30_000;
const COMMIT = /^[0-9a-f]{40}$/;
const OPERATION = /^projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+$/;

// ---------------------------------------------------------------------------------------------------
// Pure parts: the image, the build, the new revision, the view.
// ---------------------------------------------------------------------------------------------------

/** The dashboard's image without its tag: <region>-docker.pkg.dev/<project>/<repository>/<image name>. */
export function imagePath(settings, contracts) {
  return `${settings.region}-docker.pkg.dev/${settings.project}/${IMAGE_REPOSITORY}/${contracts.dashboard.image_name}`;
}

/** Where a commit's own build config is read from. */
export function buildConfigUrl(repo, commit, contracts) {
  return `${RAW_GITHUB}/${repo}/${commit}/${contracts.dashboard.build_config_path}`;
}

/**
 * The parts of a commit's build config a build takes: its steps, images and options. Throws, saying
 * what is wrong, for anything else.
 *
 * @param {string} text
 * @returns {{steps: object[], images?: string[], options?: object}}
 */
export function parseBuildConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('it is not JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('it is not a JSON object');
  const { steps, images, options } = config;
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name)) {
    throw new Error('it names no build steps');
  }
  if (images !== undefined && !(Array.isArray(images) && images.every((i) => typeof i === 'string'))) throw new Error('its images are not a list of names');
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new Error('its options are not an object');
  return { steps, ...(images ? { images } : {}), ...(options ? { options } : {}) };
}

/**
 * The Cloud Build request that builds the dashboard at a commit: the commit from GitHub, its own
 * steps, as the dashboard's account, tagged with the commit (the same build install/install.sh runs
 * through gcloud).
 */
export function buildRequest({ config, repo, commit, image, project, account, timeoutSeconds }) {
  return {
    source: { gitSource: { url: `https://github.com/${repo}.git`, revision: commit } },
    ...config,
    substitutions: { _IMAGE: image, _COMMIT: commit },
    serviceAccount: `projects/${project}/serviceAccounts/${account}`,
    timeout: `${timeoutSeconds}s`,
  };
}

/**
 * The service as read from Cloud Run's v2 API, moved to a new image: the first container's image and
 * its PARACLETE_RELEASE and PARACLETE_COMMIT, nothing else. A revision name the template carried would
 * belong to the running revision, so it is left out and Cloud Run names the new one.
 *
 * @param {object} service
 * @param {{image: string, version: string, commit: string}} o
 * @returns {object} a new object; `service` is not changed
 */
export function rolloutService(service, { image, version, commit }) {
  const next = structuredClone(service);
  const container = next?.template?.containers?.[0];
  if (!container) throw new Error('the service has no container to move');
  moveContainer(container, { image, version, commit });
  delete next.template.revision;
  return next;
}

/**
 * The automatic-update job (a Cloud Run v2 Job, as its Admin API answers GET) moved to a new image:
 * the job as read, with only its container's image and PARACLETE_RELEASE and PARACLETE_COMMIT changed.
 *
 * @param {object} job
 * @param {{image: string, version: string, commit: string}} o
 * @returns {object} a new object; `job` is not changed
 */
export function rolloutJob(job, { image, version, commit }) {
  const next = structuredClone(job);
  const container = next?.template?.template?.containers?.[0];
  if (!container) throw new Error('the job has no container to move');
  moveContainer(container, { image, version, commit });
  return next;
}

function moveContainer(container, { image, version, commit }) {
  container.image = image;
  const env = Array.isArray(container.env) ? container.env : [];
  for (const [name, value] of [['PARACLETE_RELEASE', version], ['PARACLETE_COMMIT', commit]]) {
    const entry = env.find((e) => e?.name === name);
    if (entry) {
      entry.value = value;
      delete entry.valueSource;
    } else {
      env.push({ name, value });
    }
  }
  container.env = env;
}

/** The build's page in the Cloud console, where its log is. */
export function buildLogUrl({ project, region }, buildId) {
  return `https://console.cloud.google.com/cloud-build/builds;region=${region}/${encodeURIComponent(buildId)}?project=${project}`;
}

const text = (value) => (typeof value === 'string' && value ? value : null);

/**
 * The upgrade as the System tab shows it. `live` holds what this read learned about the current step
 * (the command's status, the build's) and a passing problem asking about it. Admins also see the ids
 * and the build's log.
 *
 * @param {object|null} data  config/upgrade
 * @param {{admin: boolean, settings: object, live?: object}} o
 */
export function upgradeView(data, { admin, settings, live = {} }) {
  if (!data || typeof data !== 'object') return null;
  const state = STATES.includes(data.state) ? data.state : 'failed';
  const buildId = text(data.build_id);
  return {
    id: text(data.id),
    version: text(data.version),
    commit: text(data.commit),
    requested_by: text(data.requested_by),
    requested_at: text(data.requested_at),
    state,
    running: RUNNING_STATES.includes(state),
    error: text(data.error) || (STATES.includes(data.state) ? null : `the upgrade record has an unknown state '${data.state}'`),
    updated_at: text(data.updated_at),
    vm: live.vm || null,
    build: live.build || null,
    notice: live.notice || null,
    ...(admin ? {
      vm_command_id: text(data.vm_command_id),
      build_id: buildId,
      build_log_url: buildId ? buildLogUrl(settings, buildId) : null,
      operation: text(data.operation),
    } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// Calls.
// ---------------------------------------------------------------------------------------------------

/**
 * One Google API call as the dashboard's service account. Never throws: `transient` marks a failure
 * worth asking again about (no answer, a 5xx, a 429); anything else is Google's refusal.
 *
 * @returns {Promise<{ok: boolean, status: number, body: any, message?: string, transient?: boolean}>}
 */
async function google(runtime, url, { method = 'GET', body } = {}) {
  let token;
  try {
    token = await runtime.getAccessToken();
  } catch (err) {
    return { ok: false, transient: true, status: 0, body: null, message: `the dashboard has no access token: ${err.message}` };
  }
  let response;
  try {
    response = await runtime.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, transient: true, status: 0, body: null, message: `no answer: ${err.message}` };
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    // no JSON: the status says enough
  }
  if (response.ok) return { ok: true, status: response.status, body: json };
  return {
    ok: false,
    transient: response.status >= 500 || response.status === 429,
    status: response.status,
    body: json,
    message: `${response.status}: ${json?.error?.message || 'no reason given'}`,
  };
}

/** Whether the image at this commit is in the repository already (a repeat of an upgrade needs no build). */
async function imageExists(runtime, commit) {
  const { project, region } = runtime.settings;
  const url = `${ARTIFACT_REGISTRY_API}/projects/${project}/locations/${region}/repositories/${IMAGE_REPOSITORY}`
    + `/packages/${encodeURIComponent(runtime.contracts.dashboard.image_name)}/tags/${commit}`;
  const res = await google(runtime, url);
  return res.ok;
}

/** The commit's own build config, from GitHub. Throws, saying why, when it cannot be read or used. */
async function fetchBuildConfig(runtime, commit) {
  const url = buildConfigUrl(runtime.settings.repo, commit, runtime.contracts);
  let response;
  try {
    response = await runtime.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`GitHub could not be reached: ${err.message}`);
  }
  if (response.status === 404) throw new Error(`the commit has no ${runtime.contracts.dashboard.build_config_path}`);
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  try {
    return parseBuildConfig(await response.text());
  } catch (err) {
    throw new Error(`${runtime.contracts.dashboard.build_config_path} cannot be used: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The record.
// ---------------------------------------------------------------------------------------------------

async function guarded(runtime, what, call) {
  try {
    return await call();
  } catch (err) {
    if (err instanceof StoreUnavailable) {
      runtime.log('WARN', `upgrade: ${what}: ${err.message}`);
      throw new HttpError(503, 'the dashboard could not read or write its database just now; try again in a moment');
    }
    throw err;
  }
}

const upgradePath = (runtime) => `${runtime.collections.config}/${UPGRADE_DOC}`;

/** config/upgrade with its update time, or null. */
function readRecord(runtime) {
  return guarded(runtime, 'read', () => runtime.db.readDoc(upgradePath(runtime)));
}

/**
 * Writes the whole record, only if it is unchanged since `read` (or, without one, only if there is
 * none). Null when someone else wrote it first.
 */
async function writeRecord(runtime, read, data) {
  try {
    const result = await guarded(runtime, 'write', () => runtime.db.commit([{
      path: upgradePath(runtime), data, precondition: read ? { updateTime: read.updateTime } : { exists: false },
    }]));
    return { data, updateTime: result?.writeResults?.[0]?.updateTime };
  } catch (err) {
    if (err instanceof StoreConflict) return null;
    throw err;
  }
}

/** Moves the record on from `read` by these fields. Null when someone else moved it first. */
function step(runtime, read, fields, now) {
  return writeRecord(runtime, read, { ...read.data, ...fields, updated_at: now.toISOString() });
}

/** The record as it is now, after another reader moved it. */
async function current(runtime, read) {
  return (await readRecord(runtime)) || read;
}

/** Ends the upgrade as failed, saying why. */
async function fail(runtime, read, error, now) {
  runtime.log('WARN', `upgrade ${read.data.id} to ${read.data.version} failed: ${error}`);
  return (await step(runtime, read, { state: 'failed', error }, now)) || current(runtime, read);
}

function ageSeconds(at, now) {
  const then = Date.parse(at);
  return Number.isFinite(then) ? (now.getTime() - then) / 1000 : Infinity;
}

/** Whether a claimed step's call should have been recorded by now. */
const interrupted = (up, now) => ageSeconds(up.updated_at, now) > STEP_START_GRACE_SECONDS;

const shortCommit = (commit) => String(commit || '').slice(0, 12);

// ---------------------------------------------------------------------------------------------------
// The steps.
// ---------------------------------------------------------------------------------------------------

/** vm: follows the command; when it is done and the agent is ready on the commit, starts the build. */
async function advanceVm(runtime, read, now, live) {
  const up = read.data;
  if (!up.vm_command_id) {
    if (interrupted(up, now)) {
      return fail(runtime, read, `the upgrade command never reached the agent (the dashboard stopped while sending it). Install ${up.version} again.`, now);
    }
    live.vm = { status: 'sending' };
    return read;
  }
  const command = await guarded(runtime, 'the command', () => runtime.db.read(`${runtime.collections.commands}/${up.vm_command_id}`, { strict: true }));
  if (!command) return fail(runtime, read, `the upgrade command ${up.vm_command_id} is no longer in Firestore`, now);
  live.vm = { status: text(command.status) || 'unknown', started_at: text(command.started_at) };
  if (command.status === 'failed') {
    return fail(runtime, read, `the agent could not move to ${up.version}: ${command.error || 'its control service gave no reason'}. `
      + `The dashboard stays on ${runtime.settings.release || 'its release'}.`, now);
  }
  if (command.status !== 'done') {
    const limit = runtime.contracts.control.upgrade_max_seconds + VM_MARGIN_SECONDS;
    if (ageSeconds(up.requested_at, now) > limit) {
      const why = command.status === 'pending' ? ': its control service never picked the command up, so the VM may be stopped' : '';
      return fail(runtime, read, `the agent has not finished moving to ${up.version} after ${Math.round(limit / 60)} minutes${why}. `
        + `If it finishes later, install ${up.version} again to move the dashboard.`, now);
    }
    return read;
  }
  const agent = await guarded(runtime, 'agent/instance', () => runtime.db.read(`${runtime.collections.agent}/instance`, { strict: true }));
  if (agent?.status !== 'ready' || String(agent?.commit || '').toLowerCase() !== up.commit) {
    return fail(runtime, read, `the agent's upgrade ended, but it reports ${agent?.status || 'nothing'} on ${shortCommit(agent?.commit) || 'no commit'}, `
      + `not ready on ${shortCommit(up.commit)} (${up.version}), so the dashboard is not moved`, now);
  }
  const claim = await step(runtime, read, { state: 'build', build_id: null, operation: null }, now);
  if (!claim) return current(runtime, read);
  return startBuild(runtime, claim, now, live);
}

/** build, just claimed: the build at the commit, or straight to the rollout when the image exists. */
async function startBuild(runtime, claim, now, live) {
  const { settings, contracts } = runtime;
  const up = claim.data;
  if (await imageExists(runtime, up.commit)) {
    runtime.log('INFO', `upgrade ${up.id}: the dashboard's image for ${up.commit} exists; not building it again`);
    const deploying = await step(runtime, claim, { state: 'deploy' }, now);
    if (!deploying) return current(runtime, claim);
    return startRollout(runtime, deploying, now);
  }
  let config;
  try {
    config = await fetchBuildConfig(runtime, up.commit);
  } catch (err) {
    return fail(runtime, claim, `${up.version}'s build config could not be read: ${err.message}`, now);
  }
  const image = imagePath(settings, contracts);
  const body = buildRequest({
    config, repo: settings.repo, commit: up.commit, image, project: settings.project, account: settings.dashboardAccount,
    timeoutSeconds: contracts.dashboard.build_timeout_seconds,
  });
  const res = await google(runtime, `${CLOUD_BUILD_API}/projects/${settings.project}/locations/${settings.region}/builds`, { method: 'POST', body });
  if (!res.ok) {
    const hint = res.status === 403 ? ` ${settings.dashboardAccount} needs Cloud Build Editor on the project and act-as on itself; install/install.sh grants both.` : '';
    return fail(runtime, claim, `Cloud Build did not start the dashboard's build (${res.message}).${hint}`, now);
  }
  const buildId = text(res.body?.metadata?.build?.id);
  if (!buildId) return fail(runtime, claim, 'Cloud Build answered without a build id', now);
  live.build = { status: text(res.body?.metadata?.build?.status) || 'QUEUED' };
  runtime.log('INFO', `upgrade ${up.id}: building the dashboard at ${up.commit}, build ${buildId}`);
  return (await step(runtime, claim, { build_id: buildId }, now)) || current(runtime, claim);
}

/** build: follows the build; when it succeeded, starts the rollout. */
async function advanceBuild(runtime, read, now, live) {
  const { settings } = runtime;
  const up = read.data;
  if (!up.build_id) {
    if (interrupted(up, now)) {
      return fail(runtime, read, `the dashboard's build was never started (the dashboard stopped while starting it). The agent runs ${up.version}: install it again to finish.`, now);
    }
    live.build = { status: 'starting' };
    return read;
  }
  const res = await google(runtime, `${CLOUD_BUILD_API}/projects/${settings.project}/locations/${settings.region}/builds/${encodeURIComponent(up.build_id)}`);
  if (!res.ok) {
    if (res.transient) {
      live.notice = `Cloud Build could not be asked about the build just now (${res.message}); asking again shortly`;
      return read;
    }
    return fail(runtime, read, `Cloud Build could not be asked about build ${up.build_id} (${res.message})`, now);
  }
  const status = text(res.body?.status) || 'STATUS_UNKNOWN';
  live.build = { status, started_at: text(res.body?.startTime) };
  if (BUILD_FAILED.has(status)) {
    const why = text(res.body?.statusDetail) || text(res.body?.failureInfo?.detail) || 'its log says why';
    return fail(runtime, read, `the dashboard's build ended ${status} (${why}). The agent runs ${up.version}; the dashboard stays on `
      + `${settings.release || 'its release'}. Install ${up.version} again to finish.`, now);
  }
  if (status !== 'SUCCESS') return read;
  const claim = await step(runtime, read, { state: 'deploy', operation: null }, now);
  if (!claim) return current(runtime, read);
  return startRollout(runtime, claim, now);
}

/** deploy, just claimed: reads the dashboard's service and asks Cloud Run for a revision on the new image. */
async function startRollout(runtime, claim, now) {
  const { settings, contracts } = runtime;
  const up = claim.data;
  const url = `${CLOUD_RUN_API}/projects/${settings.project}/locations/${settings.region}/services/${settings.service}`;
  const read = await google(runtime, url);
  if (!read.ok) return fail(runtime, claim, `Cloud Run's service ${settings.service} could not be read (${read.message})`, now);
  let service;
  try {
    service = rolloutService(read.body, { image: `${imagePath(settings, contracts)}:${up.commit}`, version: up.version, commit: up.commit });
  } catch (err) {
    return fail(runtime, claim, `the service ${settings.service} cannot be moved: ${err.message}`, now);
  }
  const res = await google(runtime, url, { method: 'PATCH', body: service });
  if (!res.ok) {
    const hint = res.status === 403 ? ` ${settings.dashboardAccount} needs Cloud Run Admin on the project and act-as on itself; install/install.sh grants both.` : '';
    return fail(runtime, claim, `Cloud Run did not take the new revision (${res.message}).${hint}`, now);
  }
  const operation = text(res.body?.name);
  if (!operation || !OPERATION.test(operation)) return fail(runtime, claim, 'Cloud Run answered without an operation to follow', now);
  runtime.log('INFO', `upgrade ${up.id}: rolling the dashboard to ${up.commit}, operation ${operation}`);
  return (await step(runtime, claim, { operation }, now)) || current(runtime, claim);
}

/** deploy: follows Cloud Run's operation to the end. */
async function advanceDeploy(runtime, read, now, live) {
  const up = read.data;
  if (!up.operation) {
    if (interrupted(up, now)) {
      return fail(runtime, read, `the new revision was never asked for (the dashboard stopped while asking). The agent runs ${up.version}: install it again to finish.`, now);
    }
    return read;
  }
  if (!OPERATION.test(up.operation)) return fail(runtime, read, `the recorded operation '${up.operation}' is not one of Cloud Run's`, now);
  const res = await google(runtime, `${CLOUD_RUN_API}/${up.operation}`);
  if (!res.ok) {
    if (res.transient) {
      live.notice = `Cloud Run could not be asked about the new revision just now (${res.message}); asking again shortly`;
      return read;
    }
    return fail(runtime, read, `Cloud Run could not be asked about the new revision (${res.message})`, now);
  }
  if (!res.body?.done) return read;
  if (res.body.error) {
    return fail(runtime, read, `Cloud Run could not start the new revision (${res.body.error.message || 'no reason given'}). The previous one keeps serving; `
      + `the agent runs ${up.version}: install it again to finish.`, now);
  }
  runtime.log('INFO', `upgrade ${up.id}: the dashboard runs ${up.version} (${up.commit})`);
  await moveUpdateJob(runtime, up);
  return (await step(runtime, read, { state: 'done', error: null }, now)) || current(runtime, read);
}

/**
 * Moves the automatic-update job to the image the dashboard now runs. Best effort: the upgrade is done
 * whatever happens here, a job that is not there (an instance installed before automatic updates) is
 * left alone, and re-running install/install.sh puts a missing or stale job right.
 */
async function moveUpdateJob(runtime, up) {
  const { settings, contracts } = runtime;
  const name = contracts.auto_update?.job_name;
  if (!name) return;
  const url = `${CLOUD_RUN_API}/projects/${settings.project}/locations/${settings.region}/jobs/${name}`;
  const read = await google(runtime, url);
  if (read.status === 404) {
    runtime.log('INFO', `upgrade ${up.id}: there is no ${name} job to move; install/install.sh creates it`);
    return;
  }
  if (!read.ok) {
    runtime.log('WARN', `upgrade ${up.id}: the ${name} job could not be read (${read.message}); it keeps its image until install/install.sh runs again`);
    return;
  }
  let job;
  try {
    job = rolloutJob(read.body, { image: `${imagePath(settings, contracts)}:${up.commit}`, version: up.version, commit: up.commit });
  } catch (err) {
    runtime.log('WARN', `upgrade ${up.id}: the ${name} job cannot be moved: ${err.message}`);
    return;
  }
  const res = await google(runtime, url, { method: 'PATCH', body: job });
  runtime.log(res.ok ? 'INFO' : 'WARN', res.ok
    ? `upgrade ${up.id}: the ${name} job runs ${up.version} (${up.commit}) from its next run`
    : `upgrade ${up.id}: the ${name} job did not take the new image (${res.message}); it keeps its image until install/install.sh runs again`);
}

async function advance(runtime, read, now, live) {
  try {
    if (read.data.state === 'vm') return await advanceVm(runtime, read, now, live);
    if (read.data.state === 'build') return await advanceBuild(runtime, read, now, live);
    if (read.data.state === 'deploy') return await advanceDeploy(runtime, read, now, live);
    return read;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    runtime.log('ERROR', `upgrade ${read.data.id}: checking its progress failed: ${err?.stack || err}`);
    live.notice = 'the dashboard could not check the upgrade just now; the error is in its log';
    return read;
  }
}

// ---------------------------------------------------------------------------------------------------
// The two entry points.
// ---------------------------------------------------------------------------------------------------

/** The settings an upgrade needs, by the environment variable that sets each. */
function missingSettings(settings) {
  return Object.entries({
    PARACLETE_PROJECT: settings.project, PARACLETE_REGION: settings.region, PARACLETE_SERVICE: settings.service, PARACLETE_REPO: settings.repo,
  }).filter(([, value]) => !value).map(([name]) => name);
}

/**
 * The upgrade in progress or the last one, moved on when its current step has finished. Any user may
 * read it; whoever reads moves it, as the dashboard's own account.
 *
 * @param {object} runtime
 * @param {{user: {role: string}, now?: Date}} o
 * @returns {Promise<{upgrade: object|null}>}
 */
export async function readUpgrade(runtime, { user, now = new Date() }) {
  let read = await readRecord(runtime);
  const live = {};
  if (read && RUNNING_STATES.includes(read.data.state)) read = await advance(runtime, read, now, live);
  return { upgrade: upgradeView(read?.data, { admin: user?.role === 'admin', settings: runtime.settings, live }) };
}

/**
 * Starts an upgrade to a published release: newer than the installed one, or the same one, which
 * finishes an upgrade left half-done. Resolves the tag's commit on GitHub, claims config/upgrade (no
 * other upgrade may be running), and sends the VM its `upgrade` command.
 *
 * @param {object} runtime
 * @param {object} o
 * @param {string} o.version
 * @param {{email: string, role: string}} o.user
 * @param {Date} [o.now]
 * @param {Function} [o.sign]  tests pass the command signer
 * @returns {Promise<{upgrade: object}>}
 */
export async function startUpgrade(runtime, { version, user, now = new Date(), sign }) {
  if (user?.role !== 'admin') throw new HttpError(403, 'only a dashboard admin can install a release');
  const wanted = String(version ?? '').trim();
  if (!isVersion(wanted)) throw new HttpError(400, `'${wanted.slice(0, 80)}' is not a release version (vYYYY.MM.DD.N.N)`);
  const missing = missingSettings(runtime.settings);
  if (missing.length) throw new HttpError(503, `the dashboard cannot upgrade itself without ${missing.join(', ')}, which install/install.sh sets`);

  const before = await readRecord(runtime);
  if (before && RUNNING_STATES.includes(before.data.state)) {
    throw new HttpError(409, `an upgrade to ${before.data.version}, started by ${before.data.requested_by || 'an admin'}, is still running`);
  }

  const { repo, installed, check, releases } = await loadReleases(runtime, { now });
  const refusal = installRefusal(wanted, installed.version);
  if (refusal) throw new HttpError(409, refusal);
  if (!releases.some((r) => r.version === wanted)) {
    const why = check?.error ? ` (the last look at GitHub failed: ${check.error})` : '';
    throw new HttpError(409, `${wanted} is not a published release of ${repo}${why}`);
  }

  let commit;
  try {
    const json = await githubJson(runtime, commitUrl(repo, wanted), `the commit of ${wanted} in ${repo}`);
    commit = String(json?.sha || '').toLowerCase();
  } catch (err) {
    if (err instanceof GitHubError) throw new HttpError(502, err.message);
    throw err;
  }
  if (!COMMIT.test(commit)) throw new HttpError(502, `GitHub gave no commit for ${wanted}`);

  const at = now.toISOString();
  const claimed = await writeRecord(runtime, before, {
    id: newDocId(), version: wanted, commit, requested_by: user.email, requested_at: at, state: 'vm',
    vm_command_id: null, build_id: null, operation: null, error: null, updated_at: at,
  });
  if (!claimed) throw new HttpError(409, 'another admin started an upgrade a moment ago');

  let command;
  try {
    command = await sendCommand(runtime, { type: 'upgrade', params: { ref: wanted }, user, now, sign });
  } catch (err) {
    await fail(runtime, claimed, `the upgrade command could not be sent to the agent: ${err instanceof HttpError ? err.message : 'writing it failed'}`, now);
    throw err;
  }
  runtime.log('INFO', `upgrade ${claimed.data.id}: ${user.email} asked for ${wanted} (${commit}); command ${command.id}`);
  const sent = (await step(runtime, claimed, { vm_command_id: command.id }, now)) || (await current(runtime, claimed));
  return { upgrade: upgradeView(sent.data, { admin: true, settings: runtime.settings, live: { vm: { status: 'pending' } } }) };
}
