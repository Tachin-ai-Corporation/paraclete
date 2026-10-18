// install/lib/dashboard.mjs: how the dashboard is built and deployed, written once. install/install.sh
// (step 6) runs it as a small command-line program to get the exact gcloud arguments it prints and
// runs; dev/deploy.mjs imports it to move a dev instance's dashboard the same way, and dev/status.mjs
// to read which commit a deployed dashboard runs. It only builds argument lists, files and
// comparisons: it never calls gcloud or the network. The names it needs (the Cloud Run service, the
// image repository, the dashboard's account) come from install/lib/names.sh, their one definition.
//
// The build: Cloud Build fetches the repository at one commit from GitHub and runs that commit's own
// dashboard/cloudbuild.yaml (gcloud reads --config from this machine, so the caller downloads it
// first), as the dashboard's service account, in the instance's region. The image is
// <region>-docker.pkg.dev/<project>/<repository>/dashboard:<commit>, so whether a commit is built is a
// question of whether its tag exists.
//
// The deploy: Cloud Run runs that image as the dashboard's account, with IAP in front and no
// unauthenticated access, and with the environment dashboard/README.md defines.
//
// The uploads: the browser PUTs a file straight into the instance's bucket through a signed URL, so the
// bucket's CORS setting must let the dashboard's origins do that. This file builds that setting and
// tells whether a bucket already has it; install.sh applies it in step 6.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The image inside the repository. dashboard/cloudbuild.yaml tags it with the commit it was built from. */
export const IMAGE_NAME = 'dashboard';

/** Where a commit keeps its build config. Every commit is built with its own. */
export const BUILD_CONFIG_PATH = 'dashboard/cloudbuild.yaml';

/**
 * The Cloud Run service's size and reach. One agent and a handful of people: one CPU and 1 GiB run
 * the Next.js server with room to spare, it scales to zero while nobody has it open, and three
 * instances bound what a burst can cost. Ingress is `all` because IAP itself stands in front of the
 * service's URL; nothing reaches the container without passing it.
 */
export const SERVICE_SETTINGS = Object.freeze({ cpu: '1', memory: '1Gi', maxInstances: '3', ingress: 'all' });

/** The annotations Cloud Run keeps these settings in, as `gcloud run services describe` shows them. */
const IAP_ANNOTATION = 'run.googleapis.com/iap-enabled';
const INGRESS_ANNOTATION = 'run.googleapis.com/ingress';
const MAX_SCALE_ANNOTATION = 'autoscaling.knative.dev/maxScale';

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The `NAME=value` lines of a shell file such as names.sh: bare or single-quoted values, comments and
 * functions ignored.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseShellNames(text) {
  const names = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(?:'([^']*)'|([^\s'"$`;#]*))\s*(?:#.*)?$/.exec(line);
    if (m) names[m[1]] = m[2] ?? m[3];
  }
  return names;
}

/** install/lib/names.sh, read once: SERVICE_NAME, IMAGE_REPOSITORY, DASHBOARD_ACCOUNT_ID and the rest. */
export const NAMES = Object.freeze(parseShellNames(readFileSync(new URL('./names.sh', import.meta.url), 'utf8')));

function need(values, keys) {
  const missing = keys.filter((key) => values[key] === undefined || values[key] === null || values[key] === '');
  if (missing.length) throw new Error(`install/lib/dashboard.mjs: missing ${missing.join(', ')}`);
}

/** The dashboard's service account in a project. */
export function dashboardAccount(project) {
  return `${NAMES.DASHBOARD_ACCOUNT_ID}@${project}.iam.gserviceaccount.com`;
}

/** The image, without its tag: <region>-docker.pkg.dev/<project>/<repository>/dashboard. */
export function imagePath({ project, region }) {
  need({ project, region }, ['project', 'region']);
  return `${region}-docker.pkg.dev/${project}/${NAMES.IMAGE_REPOSITORY}/${IMAGE_NAME}`;
}

/** The service agent IAP reaches a Cloud Run service as. It needs the invoker role on the service. */
export function iapServiceAgent(projectNumber) {
  need({ projectNumber }, ['projectNumber']);
  return `service-${projectNumber}@gcp-sa-iap.iam.gserviceaccount.com`;
}

/** Where a commit's own build config is downloaded from. */
export function buildConfigUrl({ repo, commit }) {
  need({ repo, commit }, ['repo', 'commit']);
  return `https://raw.githubusercontent.com/${repo}/${commit}/${BUILD_CONFIG_PATH}`;
}

/** `gcloud` arguments that list the image's tags, one per line: a commit is built when its tag is listed. */
export function tagsArgs({ project, region }) {
  return ['artifacts', 'docker', 'tags', 'list', imagePath({ project, region }), `--project=${project}`,
    '--format=value(tag.basename())'];
}

/**
 * `gcloud` arguments that build the image at a commit. `--region` keeps the build, its logs and its
 * record in the instance's region, beside the image repository, whatever the caller's own
 * `builds/region` setting says; without it a build goes wherever that setting points, or to `global`,
 * which an organization's resource-location policy may forbid.
 */
export function buildArgs({ repo, commit, configFile, project, region }) {
  need({ repo, commit, configFile, project, region }, ['repo', 'commit', 'configFile', 'project', 'region']);
  return ['builds', 'submit', `https://github.com/${repo}`, `--git-source-revision=${commit}`, `--config=${configFile}`,
    `--substitutions=_IMAGE=${imagePath({ project, region })},_COMMIT=${commit}`,
    `--service-account=projects/${project}/serviceAccounts/${dashboardAccount(project)}`,
    `--region=${region}`, `--project=${project}`, '--quiet'];
}

/**
 * The service's environment, in dashboard/README.md's order. PARACLETE_IAP_AUDIENCE stays unset: it
 * only overrides the audience the dashboard derives from these. `workspaceRole` is the role's
 * `workspace` flag from its role.json (the image carries no roles/): 'true' shows the dashboard's
 * Workspace setup; anything else is 'false'.
 *
 * @returns {Record<string, string>}
 */
export function serviceEnv({ project, projectNumber, region, bucket, repo, release, commit, agentName, role, workspaceRole }) {
  const values = { project, projectNumber, region, bucket, repo, release, commit, agentName, role };
  need(values, Object.keys(values));
  return {
    PARACLETE_PROJECT: project,
    PARACLETE_PROJECT_NUMBER: String(projectNumber),
    PARACLETE_REGION: region,
    PARACLETE_SERVICE: NAMES.SERVICE_NAME,
    PARACLETE_BUCKET: bucket,
    PARACLETE_REPO: repo,
    PARACLETE_RELEASE: release,
    PARACLETE_COMMIT: commit,
    PARACLETE_AGENT_NAME: agentName,
    PARACLETE_ROLE: role,
    PARACLETE_WORKSPACE_ROLE: String(workspaceRole) === 'true' ? 'true' : 'false',
  };
}

/**
 * An environment as the YAML file `gcloud run deploy --env-vars-file` reads: one `KEY: "value"` line
 * each. A JSON string is a YAML string, so a name with spaces, quotes or commas needs no escaping.
 */
export function envFileText(env) {
  return `${Object.entries(env).map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`).join('\n')}\n`;
}

/** `gcloud` arguments that print the service as JSON (Cloud Run's Knative form). */
export function describeArgs({ project, region }) {
  need({ project, region }, ['project', 'region']);
  return ['run', 'services', 'describe', NAMES.SERVICE_NAME, `--region=${region}`, `--project=${project}`, '--format=json'];
}

/**
 * `gcloud` arguments that deploy the image at a commit. `--env-vars-file` replaces the whole
 * environment; `--no-allow-unauthenticated` and `--iap` make IAP the only way in (gcloud also grants
 * IAP's service agent the invoker role, which the installer checks for anyway).
 */
export function deployArgs({ project, region, commit, envFile }) {
  need({ project, region, commit, envFile }, ['project', 'region', 'commit', 'envFile']);
  return ['run', 'deploy', NAMES.SERVICE_NAME, `--image=${imagePath({ project, region })}:${commit}`, `--region=${region}`,
    `--service-account=${dashboardAccount(project)}`, '--no-allow-unauthenticated', '--iap',
    `--ingress=${SERVICE_SETTINGS.ingress}`, `--cpu=${SERVICE_SETTINGS.cpu}`, `--memory=${SERVICE_SETTINGS.memory}`,
    `--max-instances=${SERVICE_SETTINGS.maxInstances}`, `--env-vars-file=${envFile}`, `--project=${project}`, '--quiet'];
}

const container = (service) => service?.spec?.template?.spec?.containers?.[0] || {};

/** The image a described service runs, with its tag, or null. */
export function deployedImage(service) {
  return container(service).image || null;
}

/** The commit a described service runs (its image's tag), or null when the tag is not a commit. */
export function deployedCommit(service) {
  const image = deployedImage(service) || '';
  const tag = image.slice(image.lastIndexOf('/') + 1).split(':')[1] || '';
  return COMMIT.test(tag) ? tag : null;
}

/** A described service's plain environment variables, as { NAME: value }. */
export function deployedEnv(service) {
  return Object.fromEntries((container(service).env || []).filter((e) => e && 'value' in e).map((e) => [e.name, String(e.value)]));
}

/** CPU in cores: '1' and '1000m' are both 1. */
function cores(value) {
  const text = String(value ?? '');
  return text.endsWith('m') ? Number(text.slice(0, -1)) / 1000 : Number(text);
}

/** Memory in bytes: '1Gi' and '1024Mi' are the same. */
function bytes(value) {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|K|M|G|T)?$/.exec(String(value ?? ''));
  if (!m) return NaN;
  const unit = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] || 1;
  return Number(m[1]) * unit;
}

function sameEnv(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

/**
 * What a deploy would change on the service, from `gcloud run services describe --format=json`: an
 * empty list when it already runs the image at this commit with this environment, account and the
 * settings above; ['missing'] when there is no service.
 *
 * @param {object|null} service
 * @param {{project: string, region: string, commit: string, env: Record<string, string>}} wanted
 * @returns {string[]}
 */
export function serviceDrift(service, { project, region, commit, env }) {
  if (!service || typeof service !== 'object') return ['missing'];
  const changes = [];
  const template = service.spec?.template || {};
  const limits = container(service).resources?.limits || {};
  const annotations = service.metadata?.annotations || {};
  if (deployedImage(service) !== `${imagePath({ project, region })}:${commit}`) changes.push('image');
  if (!sameEnv(deployedEnv(service), env)) changes.push('environment');
  if (template.spec?.serviceAccountName !== dashboardAccount(project)) changes.push('service account');
  if (annotations[IAP_ANNOTATION] !== 'true') changes.push('IAP');
  if ((annotations[INGRESS_ANNOTATION] || 'all') !== SERVICE_SETTINGS.ingress) changes.push('ingress');
  if (cores(limits.cpu) !== cores(SERVICE_SETTINGS.cpu)) changes.push('cpu');
  if (bytes(limits.memory) !== bytes(SERVICE_SETTINGS.memory)) changes.push('memory');
  if (String(template.metadata?.annotations?.[MAX_SCALE_ANNOTATION] ?? '') !== SERVICE_SETTINGS.maxInstances) changes.push('max instances');
  return changes;
}

/** An object from gcloud's JSON, or null for nothing or anything unreadable. */
function parseObject(text) {
  try {
    const value = JSON.parse(String(text || '').trim() || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A described service from gcloud's JSON, or null for nothing or anything unreadable. */
export function parseService(text) {
  return parseObject(text);
}

// ---------------------------------------------------------------------------------------------------
// The bucket's CORS setting, for uploads from the dashboard.
// ---------------------------------------------------------------------------------------------------

/**
 * What the browser may do in the bucket from the dashboard's origins. It PUTs an upload's bytes to a V4
 * signed URL (dashboard/lib/server/signed-urls.mjs), sending the Content-Type that URL was signed with,
 * and reads Content-Type and ETag from the answer; GET and HEAD let it read back what it sent. Cloud
 * Storage keeps one list for the headers a request may send and the ones an answer may show. A browser
 * remembers a preflight answer for an hour. A header the dashboard starts signing goes in `headers`.
 */
export const UPLOAD_CORS = Object.freeze({
  methods: Object.freeze(['GET', 'HEAD', 'PUT']),
  headers: Object.freeze(['Content-Type', 'ETag']),
  maxAgeSeconds: 3600,
});

/** The annotation in which Cloud Run lists every URL of a service, as a JSON array. */
const URLS_ANNOTATION = 'run.googleapis.com/urls';

/** The service's deterministic URL, https://<service>-<project number>.<region>.run.app, which it has from its first deploy. */
export function serviceUrl({ projectNumber, region }) {
  need({ projectNumber, region }, ['projectNumber', 'region']);
  return `https://${NAMES.SERVICE_NAME}-${projectNumber}.${region}.run.app`;
}

/** The https origin of a URL, lowercase, or null. */
function httpsOrigin(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' ? parsed.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Every origin the dashboard answers at, sorted and each once: its deterministic URL, and every URL the
 * described service reports (`status.url`, which may be the older `<service>-<hash>-<region code>.a.run.app`
 * form, `status.address.url`, and the URLs annotation). With no service described (none deployed yet,
 * or a dry run before the first deploy), the deterministic URL alone.
 *
 * @param {object|null} service  `gcloud run services describe --format=json`
 * @param {{projectNumber: string, region: string}} o
 * @returns {string[]}
 */
export function dashboardOrigins(service, { projectNumber, region }) {
  const urls = [serviceUrl({ projectNumber, region }), service?.status?.url, service?.status?.address?.url];
  try {
    const listed = JSON.parse(service?.metadata?.annotations?.[URLS_ANNOTATION] || '[]');
    if (Array.isArray(listed)) urls.push(...listed);
  } catch {
    // An unreadable annotation adds nothing; the other URLs still count.
  }
  return [...new Set(urls.filter(Boolean).map(httpsOrigin).filter(Boolean))].sort();
}

/**
 * The file `gcloud storage buckets update --cors-file` reads: one rule, for these origins.
 *
 * @param {string[]} origins
 */
export function corsConfig(origins) {
  if (!Array.isArray(origins) || origins.length === 0) throw new Error('install/lib/dashboard.mjs: CORS needs at least one origin');
  return [{
    origin: [...origins],
    method: [...UPLOAD_CORS.methods],
    responseHeader: [...UPLOAD_CORS.headers],
    maxAgeSeconds: UPLOAD_CORS.maxAgeSeconds,
  }];
}

/** A described bucket from `gcloud storage buckets describe --format=json`, or null. */
export function parseBucket(text) {
  return parseObject(text);
}

/** One CORS rule in a form that compares equal however gcloud spells and orders it. */
function canonicalRule(rule) {
  const list = (value, normalize) => [...new Set((Array.isArray(value) ? value : []).map((item) => normalize(String(item))))].sort();
  return JSON.stringify({
    origin: list(rule?.origin, (o) => o.toLowerCase()),
    method: list(rule?.method, (m) => m.toUpperCase()),
    responseHeader: list(rule?.responseHeader ?? rule?.response_header, (h) => h.toLowerCase()),
    maxAgeSeconds: Number(rule?.maxAgeSeconds ?? rule?.max_age_seconds ?? 0),
  });
}

/**
 * What setting the CORS file for these origins would change on a described bucket: '' when it has
 * exactly that rule already (however ordered or cased), 'none set' when it has none, 'different'
 * otherwise. gcloud shows the setting as `cors_config`; the raw API calls it `cors`.
 *
 * @param {object|null} bucket
 * @param {string[]} origins
 * @returns {string}
 */
export function corsDrift(bucket, origins) {
  const current = bucket?.cors_config ?? bucket?.cors ?? [];
  if (!Array.isArray(current) || current.length === 0) return 'none set';
  const wanted = corsConfig(origins).map(canonicalRule).sort();
  const found = current.map(canonicalRule).sort();
  return JSON.stringify(found) === JSON.stringify(wanted) ? '' : 'different';
}

/** origins=a,b on the command line, as a list. */
function originList(value) {
  return String(value || '').split(',').filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------
// The command line install/install.sh uses: node install/lib/dashboard.mjs <command> [key=value]...
// Argument lists print one per line (no argument holds a newline); `drift` reads the described
// service on stdin and prints what would change, comma-separated, or nothing. `origins` reads the
// described service (or nothing) on stdin and prints the dashboard's origins, comma-separated;
// `cors-file` prints the CORS file for origins=a,b; `cors-drift` reads the described bucket (or
// nothing) on stdin and prints what setting that file would change, or nothing.
// ---------------------------------------------------------------------------------------------------

const COMMANDS = {
  image: (o) => imagePath(o),
  'iap-agent': (o) => iapServiceAgent(o.projectNumber),
  'build-config-url': (o) => buildConfigUrl(o),
  'tags-args': (o) => tagsArgs(o).join('\n'),
  'build-args': (o) => buildArgs(o).join('\n'),
  'env-file': (o) => envFileText(serviceEnv(o)).trimEnd(),
  'describe-args': (o) => describeArgs(o).join('\n'),
  'deploy-args': (o) => deployArgs(o).join('\n'),
  drift: (o, stdin) => serviceDrift(parseService(stdin), { ...o, env: serviceEnv(o) }).join(', '),
  origins: (o, stdin) => dashboardOrigins(parseService(stdin), o).join(','),
  'cors-file': (o) => JSON.stringify(corsConfig(originList(o.origins))),
  'cors-drift': (o, stdin) => corsDrift(parseBucket(stdin), originList(o.origins)),
};

/** The commands that read stdin. */
const READS_STDIN = new Set(['drift', 'origins', 'cors-drift']);

/**
 * Runs one command. Exported for the tests.
 *
 * @param {string[]} argv  <command> key=value...
 * @param {string}   [stdin]
 * @returns {string} what the command prints
 */
export function cli(argv, stdin = '') {
  const [command, ...pairs] = argv;
  if (!COMMANDS[command]) throw new Error(`install/lib/dashboard.mjs: unknown command '${command}'. Commands: ${Object.keys(COMMANDS).join(', ')}`);
  const options = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`install/lib/dashboard.mjs: expected key=value, got '${pair}'`);
    options[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return COMMANDS[command](options, stdin);
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
    const argv = process.argv.slice(2);
    const stdin = READS_STDIN.has(argv[0]) ? readFileSync(0, 'utf8') : '';
    const output = cli(argv, stdin);
    if (output) process.stdout.write(`${output}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}
