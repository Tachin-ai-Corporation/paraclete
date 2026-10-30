// Tests for install/install.sh, run with bash against tests/install/fake-cloud.mjs (no Google Cloud,
// no GitHub, no Vertex AI). A dry run's printed plan is checked step by step: the order, the APIs, the
// accounts and their grants, Firestore, the bucket, the dashboard (its image repository, build,
// service, sign-in grants, first admin and the bucket's CORS setting for its uploads), the network and
// the VM with its metadata. Then: a dry run
// changes nothing; a real run followed by a re-run creates nothing twice; a new --ref rebuilds the
// dashboard and moves the VM; each piece of the dashboard that already exists is left alone; the model
// check retries and then stops with a reason; and each check in step 1 stops the install before
// anything changes. A role's own APIs are turned on; its grants on single resources (the DevOps
// Engineer's act-as on its own account and push to its own `agent-images` repository) are made exactly
// so, and taken back on a move away, the repository and its images staying; act-as, image push and
// Cloud Run change are never granted project-wide, and one found there is taken back. Every install
// tags the dashboard's service and update job paraclete=managed, and the DevOps Engineer's run.admin
// holds the condition that leaves those two out. In token mode (an access token file and the account
// it belongs to) a run installs and uninstalls with no gcloud login at all; --events writes every step
// and command as JSON lines, ending with done or error; and the project carries paraclete=<role>.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentIdentity } from '../../config/instance.mjs';
import { API_PROBES } from '../../agent/services/control/workspace-check.mjs';
import {
  bash, bashWith, createSandbox, find, flag, freshProject, needsBash, repoRoot, steps,
  COMMITS, OLDER_TAG, PROJECT, RELEASE_TAG, REPO, WORKSPACE_ROLE,
} from './harness.mjs';

const readJson = (...path) => JSON.parse(readFileSync(join(repoRoot, ...path), 'utf8'));
/** The repo's roles the installer offers: each with a role.json, less development roles (`listed: false`). */
const listedRepoRoles = () => readdirSync(join(repoRoot, 'roles'))
  .filter((id) => existsSync(join(repoRoot, 'roles', id, 'role.json')) && readJson('roles', id, 'role.json').listed !== false);
const contracts = readJson('config', 'contracts.json');
const genericRole = readJson('roles', 'generic', 'role.json');
const devopsRole = readJson('roles', 'devops-engineer', 'role.json');
const indexesFile = readJson('install', 'firestore.indexes.json');

const AGENT = `paraclete-agent@${PROJECT}.iam.gserviceaccount.com`;
const DASHBOARD = `paraclete-dashboard@${PROJECT}.iam.gserviceaccount.com`;
const DWD = `paraclete-dwd@${PROJECT}.iam.gserviceaccount.com`;
const BUCKET = `${PROJECT}-paraclete`;
const IMAGE = `us-central1-docker.pkg.dev/${PROJECT}/paraclete/dashboard`;
const IAP_AGENT = `serviceAccount:service-${freshProject().projectNumber}@gcp-sa-iap.iam.gserviceaccount.com`;
const OWNER = 'owner@example.com';
const MODEL = contracts.vertex.models.cortex.split('/')[1];
const MODEL_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${contracts.vertex.location}/publishers/google/models/${MODEL}:generateContent`;

/** Every PARACLETE_* variable in dashboard/README.md's Environment table (its rows, not the notes under it). */
const README_ENV = (() => {
  const readme = readFileSync(join(repoRoot, 'dashboard', 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Environment')).split(/\n## /)[0];
  const rows = section.split('\n').filter((line) => line.startsWith('|')).join('\n');
  return [...new Set(rows.match(/PARACLETE_[A-Z_]+/g))];
})();

/** The commands of a run that step 6 prints, in order. */
const DASHBOARD_COMMANDS = [['gcloud', 'artifacts'], ['gcloud', 'builds'], ['gcloud', 'run'], ['gcloud', 'iap'],
  ['gcloud', 'beta'], ['curl']];
/** Step 3's write of the project label goes through curl too (install/lib/project-label.sh). */
const isProjectLabelWrite = (command) => command[0] === 'curl'
  && String(command.at(-1)).includes('cloudresourcemanager.googleapis.com/v3/projects/');
const dashboardCommands = (commands) => commands.filter((command) => !isProjectLabelWrite(command)
  && DASHBOARD_COMMANDS.some((words) => words.every((word, i) => command[i] === word)));
/** Where the first of step 6's REST calls (the first admin's record) is. */
const firstDashboardCurl = (commands) => commands.findIndex((command) => command[0] === 'curl' && !isProjectLabelWrite(command));

const BASE_APIS = ['compute', 'run', 'firestore', 'iam', 'iamcredentials', 'aiplatform', 'artifactregistry',
  'cloudbuild', 'secretmanager', 'storage', 'iap', 'drive', 'cloudresourcemanager', 'cloudscheduler'].map((api) => `${api}.googleapis.com`);
const WORKSPACE_APIS = ['chat', 'gmail', 'calendar-json', 'docs', 'sheets', 'slides', 'people', 'admin']
  .map((api) => `${api}.googleapis.com`);

/** Calls that would change something, including any the fake doesn't know (write: null). */
const writes = (calls) => calls.filter((call) => call.write !== false);

const enabledApis = (commands) => find(commands, 'gcloud', 'services', 'enable')
  .flatMap((command) => command.filter((arg) => arg.endsWith('.googleapis.com')));

/** The project roles a run grants an account without a condition. */
const projectGrants = (commands, email) => find(commands, 'gcloud', 'projects', 'add-iam-policy-binding')
  .filter((command) => flag(command, 'member') === `serviceAccount:${email}` && flag(command, 'condition') === 'None')
  .map((command) => flag(command, 'role'));

/** Roles that would reach every service account, image repository or Cloud Run resource (install/lib/role-access.mjs). */
const REACHES_EVERYTHING = /^roles\/(iam\.(serviceAccountUser|serviceAccountTokenCreator|serviceAccountOpenIdTokenCreator|workloadIdentityUser)|artifactregistry\.\w+|run\.(admin|developer|sourceDeveloper|jobsExecutor|jobsExecutorWithOverrides))$/;

/** The fence's condition, as the installer passes it (install/lib/iam.sh, fence_condition). */
const FENCE = `^;^title=paraclete-unmanaged;description=Every resource but the paraclete dashboard and its update job;expression=!resource.matchTag("${PROJECT}/paraclete", "managed")`;
/** The tag, and the full names of the two resources that carry it. */
const TAG_KEY = `${PROJECT}/paraclete`;
const TAG_VALUE = `${PROJECT}/paraclete/managed`;
const TAGGED_SERVICE = `//run.googleapis.com/projects/${PROJECT}/locations/us-central1/services/paraclete`;
const TAGGED_JOB = `//run.googleapis.com/projects/${PROJECT}/locations/us-central1/jobs/${contracts.auto_update.job_name}`;
const FENCED_GRANT = ['gcloud', 'projects', 'add-iam-policy-binding', PROJECT, `--member=serviceAccount:${AGENT}`,
  '--role=roles/run.admin', `--condition=${FENCE}`, '--quiet'];
/** The agent's project bindings: [role, condition title], the title '' for none. */
const agentBindings = (state) => state.projectPolicy.filter(([, member]) => member === `serviceAccount:${AGENT}`)
  .map(([role, , title = '']) => [role, title]);

/** The agent's own Docker repository, and the commands a role asking for grants on it and on its account prints. */
const AGENT_IMAGES = 'agent-images';
const AGENT_RESOURCE_COMMANDS = [
  ['gcloud', 'iam', 'service-accounts', 'add-iam-policy-binding', AGENT, `--project=${PROJECT}`,
    `--member=serviceAccount:${AGENT}`, '--role=roles/iam.serviceAccountUser', '--quiet'],
  ['gcloud', 'artifacts', 'repositories', 'create', AGENT_IMAGES, '--repository-format=docker', '--location=us-central1',
    '--description=Images the paraclete agent builds', `--project=${PROJECT}`, '--quiet'],
  ['gcloud', 'artifacts', 'repositories', 'add-iam-policy-binding', AGENT_IMAGES, '--location=us-central1', `--project=${PROJECT}`,
    `--member=serviceAccount:${AGENT}`, '--role=roles/artifactregistry.writer', '--quiet'],
];

/** The commands of a run that touch the agent's own account policy or its image repository. */
const agentResourceCommands = (commands) => commands.filter((command) =>
  (command[1] === 'iam' && command[2] === 'service-accounts' && /-iam-policy-binding$/.test(command[3]) && command[4] === AGENT)
  || (command[1] === 'artifacts' && command[2] === 'repositories' && command[4] === AGENT_IMAGES));

/** The --metadata=key=value,... of a VM command, as an object. */
function metadataOf(command) {
  return Object.fromEntries(flag(command, 'metadata').split(',').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
}

/** The indented file a dry run prints under "<label>:". */
function shownFile(stdout, label) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${label}:`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

/** The env-vars file a dry run shows, as an object. */
function shownEnv(stdout) {
  return Object.fromEntries(shownFile(stdout, 'dashboard-env.yaml').split('\n').map((line) => {
    const colon = line.indexOf(': ');
    return [line.slice(0, colon), JSON.parse(line.slice(colon + 2))];
  }));
}

/** The environment the dashboard should have for a release, by dashboard/README.md's names. */
function dashboardEnv({ commit = COMMITS.release, release = RELEASE_TAG, name = 'Paraclete', role = 'generic', workspace = false } = {}) {
  return {
    PARACLETE_PROJECT: PROJECT,
    PARACLETE_PROJECT_NUMBER: freshProject().projectNumber,
    PARACLETE_REGION: 'us-central1',
    PARACLETE_SERVICE: 'paraclete',
    PARACLETE_BUCKET: BUCKET,
    PARACLETE_REPO: REPO,
    PARACLETE_RELEASE: release,
    PARACLETE_COMMIT: commit,
    PARACLETE_AGENT_NAME: name,
    PARACLETE_ROLE: role,
    PARACLETE_WORKSPACE_ROLE: String(workspace),
  };
}

const position = (commands, ...words) => commands.findIndex((command) => words.every((word, i) => command[i] === word));

/** The dashboard's deterministic URL, the origin every install lets upload into the bucket. */
const SERVICE_ORIGIN = `https://paraclete-${freshProject().projectNumber}.us-central1.run.app`;

/** The bucket's CORS setting for uploads from these origins, as install.sh writes it. */
const uploadCors = (origins) => [{
  origin: origins, method: ['GET', 'HEAD', 'PUT'], responseHeader: ['Content-Type', 'ETag'], maxAgeSeconds: 3600,
}];

/** The commands that set the bucket's CORS setting. */
const corsUpdates = (commands) => find(commands, 'gcloud', 'storage', 'buckets', 'update')
  .filter((command) => flag(command, 'cors-file') !== undefined);

test('install.sh, uninstall.sh and their library parse', { skip: needsBash }, () => {
  const scripts = ['install.sh', 'uninstall.sh',
    ...readdirSync(join(repoRoot, 'install', 'lib')).filter((f) => f.endsWith('.sh')).map((f) => `lib/${f}`)];
  for (const script of scripts) {
    const result = spawnSync(bash, ['-n', join(repoRoot, 'install', script).replace(/\\/g, '/')], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('install.sh and uninstall.sh are committed executable, so install/install.sh runs as written', (t) => {
  const listed = spawnSync('git', ['ls-files', '-s', '--', 'install/install.sh', 'install/uninstall.sh'], { cwd: repoRoot, encoding: 'utf8' });
  const lines = listed.stdout.split('\n').filter(Boolean);
  if (lines.length === 0) return t.skip('not committed yet');
  for (const line of lines) assert.match(line, /^100755 /, `${line}: commit it with git add --chmod=+x`);
});

test("the agent's account is the one config/instance.mjs signs as", { skip: needsBash }, () => {
  const names = join(repoRoot, 'install', 'lib', 'names.sh').replace(/\\/g, '/');
  const email = bashWith(`source "${names}"; account_email "$AGENT_ACCOUNT_ID" "\${words[0]}"`, [PROJECT]).stdout.trim();
  assert.equal(email, agentIdentity({ project: PROJECT, agent_name: 'Paraclete' }).email);
});

describe('a dry run on a fresh project', { skip: needsBash, concurrency: true }, () => {
  let box;
  let run;
  before(async () => {
    box = createSandbox();
    run = await box.run('install.sh', ['--dry-run', '--yes']);
  });

  test('succeeds and walks the nine steps in order', () => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(steps(run.stdout), [
      [1, 'check'], [2, 'apis'], [3, 'accounts'], [4, 'firestore'], [5, 'bucket'],
      [6, 'dashboard'], [7, 'network'], [8, 'vm'], [9, 'wait'],
    ]);
  });

  test('changes nothing: every call it makes only reads', () => {
    assert.deepEqual(writes(run.calls), []);
    assert.deepEqual(box.state(), freshProject());
    assert.match(run.stdout, /Dry run complete: nothing was changed/);
  });

  test('still runs the read-only checks', () => {
    const made = run.calls.map((call) => call.command);
    for (const check of ['auth list', 'testIamPermissions', 'billing projects describe', 'projects get-ancestors', 'ls-remote', 'raw']) {
      assert.ok(made.includes(check), `missing check: ${check}`);
    }
  });

  test('enables the base APIs only, for a role without Workspace', () => {
    assert.deepEqual(enabledApis(run.commands).sort(), [...BASE_APIS].sort());
    for (const command of find(run.commands, 'gcloud', 'services', 'enable')) {
      assert.equal(flag(command, 'project'), PROJECT);
    }
  });

  test('creates the agent and dashboard accounts, and no Workspace signer', () => {
    const created = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'create').map((command) => command[4]);
    assert.deepEqual(created, ['paraclete-agent', 'paraclete-dashboard']);
  });

  test("grants the agent the generic role's gcp_roles on the project, and nothing on single resources", () => {
    assert.deepEqual(projectGrants(run.commands, AGENT), genericRole.gcp_roles);
    assert.deepEqual(agentResourceCommands(run.commands), [], 'generic asks for no resource_roles: no agent-images, no act-as');
    assert.deepEqual(find(run.commands, 'gcloud', 'projects', 'remove-iam-policy-binding'), []);
  });

  test('grants the dashboard what phase 6 needs, and itself only on its own account', () => {
    assert.deepEqual(projectGrants(run.commands, DASHBOARD), [
      'roles/datastore.user', 'roles/secretmanager.admin', 'roles/cloudbuild.builds.editor', 'roles/run.admin',
      'roles/logging.logWriter',
    ]);
    const onAccounts = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'add-iam-policy-binding')
      .map((command) => [command[4], flag(command, 'member'), flag(command, 'role')]);
    assert.deepEqual(onAccounts, [
      [DASHBOARD, `serviceAccount:${DASHBOARD}`, 'roles/iam.serviceAccountUser'],
      [DASHBOARD, `serviceAccount:${DASHBOARD}`, 'roles/iam.serviceAccountTokenCreator'],
    ]);
    for (const command of find(run.commands, 'gcloud', 'projects', 'add-iam-policy-binding')) {
      assert.equal(flag(command, 'condition'), 'None');
      assert.doesNotMatch(flag(command, 'role'), /^roles\/(owner|editor|storage\..*)$/, 'no basic role, and storage only on the bucket');
    }
  });

  test('creates the Native mode database in the region, with delete protection', () => {
    const [create, ...more] = find(run.commands, 'gcloud', 'firestore', 'databases', 'create');
    assert.equal(more.length, 0);
    assert.equal(flag(create, 'database'), '(default)');
    assert.equal(flag(create, 'location'), 'us-central1');
    assert.equal(flag(create, 'type'), 'firestore-native');
    assert.ok(create.includes('--delete-protection'));
  });

  test('creates every index in firestore.indexes.json, and the TTL policy', () => {
    const created = find(run.commands, 'gcloud', 'firestore', 'indexes', 'composite', 'create').map((command) => ({
      group: flag(command, 'collection-group'),
      scope: flag(command, 'query-scope'),
      fields: command.filter((arg) => arg.startsWith('--field-config=')).map((arg) => arg.slice('--field-config='.length)),
    }));
    assert.deepEqual(created, indexesFile.indexes.map((index) => ({
      group: index.collectionGroup,
      scope: 'collection',
      fields: index.fields.map((f) => `field-path=${f.fieldPath},order=${f.order.toLowerCase()}`),
    })));
    const [ttl, ...moreTtls] = find(run.commands, 'gcloud', 'firestore', 'fields', 'ttls', 'update');
    assert.equal(moreTtls.length, 0);
    assert.equal(ttl[5], 'expire_at');
    assert.equal(flag(ttl, 'collection-group'), 'tool_results');
    assert.ok(ttl.includes('--enable-ttl'));
  });

  test('creates the bucket private, uniform and with the inbox lifecycle from the contracts', () => {
    const [create] = find(run.commands, 'gcloud', 'storage', 'buckets', 'create');
    assert.equal(create[4], `gs://${BUCKET}`);
    assert.equal(flag(create, 'location'), 'us-central1');
    assert.ok(create.includes('--uniform-bucket-level-access'));
    assert.ok(create.includes('--public-access-prevention'));
    assert.match(flag(create, 'lifecycle-file'), /lifecycle\.json$/);
    assert.deepEqual(JSON.parse(shownFile(run.stdout, 'lifecycle.json')), {
      lifecycle: {
        rule: [{
          action: { type: 'Delete' },
          condition: { age: contracts.files.inbox_retention_days, matchesPrefix: [`${contracts.files.prefix}in/`] },
        }],
      },
    });
  });

  test('grants both accounts object admin on the bucket only', () => {
    const grants = find(run.commands, 'gcloud', 'storage', 'buckets', 'add-iam-policy-binding')
      .map((command) => [command[4], flag(command, 'member'), flag(command, 'role')]);
    assert.deepEqual(grants, [
      [`gs://${BUCKET}`, `serviceAccount:${AGENT}`, 'roles/storage.objectAdmin'],
      [`gs://${BUCKET}`, `serviceAccount:${DASHBOARD}`, 'roles/storage.objectAdmin'],
    ]);
  });

  test("skips the model check, saying a real run makes it, and never calls Vertex AI", () => {
    assert.match(run.stdout, new RegExp(`dry run: a real run checks here that ${PROJECT} can call ${MODEL}`));
    assert.ok(!run.calls.some((call) => call.command === 'vertex generateContent'));
  });

  test("builds with the release's own cloudbuild.json, downloaded at its commit", () => {
    const raw = run.calls.filter((call) => call.command === 'raw').map((call) => call.args.find((arg) => arg.startsWith('https://')));
    assert.ok(raw.includes(`https://raw.githubusercontent.com/${REPO}/${COMMITS.release}/dashboard/cloudbuild.json`));
    assert.equal(shownFile(run.stdout, 'cloudbuild.json'), readFileSync(join(repoRoot, 'dashboard', 'cloudbuild.json'), 'utf8').trimEnd());
  });

  test('creates the Docker image repository in the region, and lets the dashboard push to it alone', () => {
    const [create, ...more] = find(run.commands, 'gcloud', 'artifacts', 'repositories', 'create');
    assert.equal(more.length, 0);
    assert.deepEqual(create.slice(0, 5), ['gcloud', 'artifacts', 'repositories', 'create', 'paraclete']);
    assert.equal(flag(create, 'repository-format'), 'docker');
    assert.equal(flag(create, 'location'), 'us-central1');
    assert.equal(flag(create, 'project'), PROJECT);
    const grants = find(run.commands, 'gcloud', 'artifacts', 'repositories', 'add-iam-policy-binding')
      .map((command) => [command[4], flag(command, 'location'), flag(command, 'member'), flag(command, 'role')]);
    assert.deepEqual(grants, [['paraclete', 'us-central1', `serviceAccount:${DASHBOARD}`, 'roles/artifactregistry.writer']]);
  });

  test("builds the image at the release's commit with Cloud Build, as the dashboard's account, in the region", () => {
    const [build, ...more] = find(run.commands, 'gcloud', 'builds', 'submit');
    assert.equal(more.length, 0);
    assert.equal(build[3], `https://github.com/${REPO}`);
    assert.equal(flag(build, 'git-source-revision'), COMMITS.release);
    assert.match(flag(build, 'config'), /cloudbuild\.json$/);
    assert.equal(flag(build, 'timeout'), '1200s', "the contracts' bound on one build");
    assert.equal(flag(build, 'substitutions'), `_IMAGE=${IMAGE},_COMMIT=${COMMITS.release}`);
    assert.equal(flag(build, 'service-account'), `projects/${PROJECT}/serviceAccounts/${DASHBOARD}`);
    assert.equal(flag(build, 'region'), 'us-central1');
    assert.equal(flag(build, 'project'), PROJECT);
    assert.ok(build.includes('--quiet'));
  });

  test("deploys that image as the dashboard's account, behind IAP, closed to everyone else", () => {
    const [deploy, ...more] = find(run.commands, 'gcloud', 'run', 'deploy');
    assert.equal(more.length, 0);
    assert.equal(deploy[3], 'paraclete');
    assert.equal(flag(deploy, 'image'), `${IMAGE}:${COMMITS.release}`);
    assert.equal(flag(deploy, 'region'), 'us-central1');
    assert.equal(flag(deploy, 'service-account'), DASHBOARD);
    assert.ok(deploy.includes('--no-allow-unauthenticated'));
    assert.ok(deploy.includes('--iap'));
    assert.ok(!deploy.some((arg) => /allow-unauthenticated$/.test(arg) && arg !== '--no-allow-unauthenticated'));
    assert.equal(flag(deploy, 'ingress'), 'all');
    assert.equal(flag(deploy, 'cpu'), '1');
    assert.equal(flag(deploy, 'memory'), '1Gi');
    assert.equal(flag(deploy, 'max-instances'), '3');
    assert.match(flag(deploy, 'env-vars-file'), /dashboard-env\.yaml$/);
    assert.equal(flag(deploy, 'project'), PROJECT);
  });

  test("sets every variable of dashboard/README.md's Environment table but the audience override", () => {
    const env = shownEnv(run.stdout);
    assert.deepEqual(env, dashboardEnv());
    assert.deepEqual(Object.keys(env).sort(), README_ENV.filter((name) => name !== 'PARACLETE_IAP_AUDIENCE').sort());
  });

  test("asks for IAP's service agent before the first deploy, and lets it invoke the service", () => {
    const [identity, ...more] = find(run.commands, 'gcloud', 'beta', 'services', 'identity', 'create');
    assert.equal(more.length, 0);
    assert.equal(flag(identity, 'service'), 'iap.googleapis.com');
    assert.equal(flag(identity, 'project'), PROJECT);
    assert.ok(position(run.commands, 'gcloud', 'beta') < position(run.commands, 'gcloud', 'run', 'deploy'));
    const [invoker, ...others] = find(run.commands, 'gcloud', 'run', 'services', 'add-iam-policy-binding');
    assert.equal(others.length, 0);
    assert.deepEqual([invoker[4], flag(invoker, 'region'), flag(invoker, 'member'), flag(invoker, 'role')],
      ['paraclete', 'us-central1', IAP_AGENT, 'roles/run.invoker']);
  });

  test('lets the installer sign in, and the dashboard manage who else may', () => {
    const grants = find(run.commands, 'gcloud', 'iap', 'web', 'add-iam-policy-binding').map((command) => ({
      type: flag(command, 'resource-type'), service: flag(command, 'service'), region: flag(command, 'region'),
      member: flag(command, 'member'), role: flag(command, 'role'), condition: flag(command, 'condition'), project: flag(command, 'project'),
    }));
    const common = { type: 'cloud-run', service: 'paraclete', region: 'us-central1', condition: 'None', project: PROJECT };
    assert.deepEqual(grants, [
      { ...common, member: `user:${OWNER}`, role: 'roles/iap.httpsResourceAccessor' },
      { ...common, member: `serviceAccount:${DASHBOARD}`, role: 'roles/iap.admin' },
    ]);
  });

  test('makes the installer the first admin with a create-only Firestore write, its token kept off the command line', () => {
    const [write, ...more] = find(run.commands, 'curl').filter((c) => !isProjectLabelWrite(c));
    assert.equal(more.length, 0);
    assert.equal(write.at(-1), `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${OWNER}?currentDocument.exists=false`);
    assert.equal(write[write.indexOf('-X') + 1], 'PATCH');
    assert.ok(write.includes('--fail-with-body'));
    assert.match(write[write.indexOf('--data-binary') + 1], /^@.+first-admin\.json$/);
    assert.ok(!write.some((arg) => /Bearer/.test(arg)), 'the token is in a header file');
    assert.match(write.find((arg, i) => write[i - 1] === '-H' && arg.startsWith('@')), /firestore-headers$/);
    const { fields } = JSON.parse(shownFile(run.stdout, 'first-admin.json'));
    assert.deepEqual(Object.keys(fields), ['email', 'role', 'added_by', 'added_at']);
    assert.deepEqual([fields.email, fields.role, fields.added_by], [{ stringValue: OWNER }, { stringValue: 'admin' }, { stringValue: 'install.sh' }]);
    assert.match(fields.added_at.stringValue, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test('does the dashboard in order: the repository, the image, the service, then who may reach it', () => {
    const order = [
      ['gcloud', 'artifacts', 'repositories', 'create'], ['gcloud', 'artifacts', 'repositories', 'add-iam-policy-binding'],
      ['gcloud', 'builds', 'submit'], ['gcloud', 'run', 'deploy'], ['gcloud', 'run', 'services', 'add-iam-policy-binding'],
      ['gcloud', 'iap', 'web', 'add-iam-policy-binding'],
    ].map((words) => position(run.commands, ...words)).concat(firstDashboardCurl(run.commands));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(order.every((i) => i > position(run.commands, 'gcloud', 'storage', 'buckets', 'create')));
    assert.ok(order.every((i) => i < position(run.commands, 'gcloud', 'compute', 'instances', 'create')));
  });

  test('creates the automatic-update job from the dashboard image, and a schedule that starts it as the dashboard', () => {
    const [job, ...moreJobs] = find(run.commands, 'gcloud', 'run', 'jobs', 'deploy');
    assert.equal(moreJobs.length, 0);
    assert.equal(job[4], 'paraclete-auto-update');
    assert.equal(flag(job, 'image'), `${IMAGE}:${COMMITS.release}`);
    assert.equal(flag(job, 'service-account'), DASHBOARD);
    assert.deepEqual([flag(job, 'command'), flag(job, 'args')], ['node', 'dashboard/jobs/auto-update.mjs']);
    assert.equal(flag(job, 'task-timeout'), `${contracts.auto_update.job_timeout_seconds}s`);
    assert.deepEqual([flag(job, 'tasks'), flag(job, 'max-retries')], ['1', '0']);
    const [schedule, ...moreSchedules] = find(run.commands, 'gcloud', 'scheduler', 'jobs', 'create', 'http');
    assert.equal(moreSchedules.length, 0);
    assert.equal(schedule[5], 'paraclete-auto-update');
    assert.equal(flag(schedule, 'schedule'), contracts.auto_update.schedule);
    assert.equal(flag(schedule, 'time-zone'), 'Etc/UTC');
    assert.equal(flag(schedule, 'uri'), `https://run.googleapis.com/v2/projects/${PROJECT}/locations/us-central1/jobs/paraclete-auto-update:run`);
    assert.equal(flag(schedule, 'http-method'), 'POST');
    assert.equal(flag(schedule, 'oauth-service-account-email'), DASHBOARD);
    assert.ok(position(run.commands, 'gcloud', 'run', 'deploy') < run.commands.indexOf(job), 'after the service');
    assert.ok(run.commands.indexOf(job) < run.commands.indexOf(schedule), 'the job before the schedule that starts it');
    assert.deepEqual(find(run.commands, 'curl').filter((c) => c.some((a) => a.includes('/documents/config/settings'))), [],
      'automatic updates stay at their default, on: nothing is written');
    assert.match(run.stdout, /updates {5}new releases install automatically/);
  });

  test("lets the browser upload into the bucket from the dashboard's URL, once the service is planned", () => {
    const [cors, ...more] = corsUpdates(run.commands);
    assert.equal(more.length, 0);
    assert.equal(cors[4], `gs://${BUCKET}`);
    assert.match(flag(cors, 'cors-file'), /cors\.json$/);
    assert.ok(cors.includes('--quiet'));
    assert.deepEqual(JSON.parse(shownFile(run.stdout, 'cors.json')), uploadCors([SERVICE_ORIGIN]),
      'before the first deploy, the deterministic URL is the one the service will have');
    const at = run.commands.indexOf(cors);
    assert.ok(at > position(run.commands, 'gcloud', 'run', 'deploy') && at > firstDashboardCurl(run.commands), 'after the service exists');
    assert.ok(at < position(run.commands, 'gcloud', 'compute', 'firewall-rules', 'create'), 'within step 6');
    assert.match(run.stdout, new RegExp(`gs://${BUCKET}: letting the dashboard upload from ${SERVICE_ORIGIN.replace(/\./g, '\\.')} \\(its CORS setting: none set\\)`));
  });

  test('uses the default network, opens SSH from IAP only, and denies everything else inbound', () => {
    assert.deepEqual(find(run.commands, 'gcloud', 'compute', 'networks', 'create'), []);
    const rules = find(run.commands, 'gcloud', 'compute', 'firewall-rules', 'create');
    assert.equal(rules.length, 2);
    const [allow, deny] = rules;
    assert.equal(allow[4], 'paraclete-allow-iap-ssh');
    assert.equal(flag(allow, 'network'), 'default');
    assert.equal(flag(allow, 'direction'), 'INGRESS');
    assert.equal(flag(allow, 'action'), 'ALLOW');
    assert.equal(flag(allow, 'rules'), 'tcp:22');
    assert.equal(flag(allow, 'source-ranges'), '35.235.240.0/20');
    assert.equal(flag(allow, 'target-tags'), 'paraclete');
    assert.equal(flag(allow, 'priority'), '1000');
    // A default network allows SSH and RDP from anywhere at 65534; this deny outranks those for the
    // VM's tag, and the IAP allow outranks the deny.
    assert.equal(deny[4], 'paraclete-deny-ingress');
    assert.equal(flag(deny, 'action'), 'DENY');
    assert.equal(flag(deny, 'rules'), 'all');
    assert.equal(flag(deny, 'source-ranges'), '0.0.0.0/0');
    assert.equal(flag(deny, 'target-tags'), 'paraclete');
    assert.ok(Number(flag(deny, 'priority')) > Number(flag(allow, 'priority')));
    assert.ok(Number(flag(deny, 'priority')) < 65534);
  });

  test('creates the VM as the agent, sized and shielded as the plan says', () => {
    const [vm, ...more] = find(run.commands, 'gcloud', 'compute', 'instances', 'create');
    assert.equal(more.length, 0);
    assert.equal(vm[4], 'paraclete');
    assert.equal(flag(vm, 'zone'), 'us-central1-a');
    assert.equal(flag(vm, 'machine-type'), 'e2-standard-2');
    assert.equal(flag(vm, 'boot-disk-size'), '50GB');
    assert.equal(flag(vm, 'boot-disk-type'), 'pd-balanced');
    assert.equal(flag(vm, 'image-family'), 'debian-12');
    assert.equal(flag(vm, 'image-project'), 'debian-cloud');
    assert.equal(flag(vm, 'service-account'), AGENT);
    assert.equal(flag(vm, 'scopes'), 'cloud-platform,https://www.googleapis.com/auth/drive');
    assert.equal(flag(vm, 'tags'), 'paraclete');
    assert.equal(flag(vm, 'network'), 'default');
    for (const shield of ['--shielded-secure-boot', '--shielded-vtpm', '--shielded-integrity-monitoring']) assert.ok(vm.includes(shield));
    assert.ok(!vm.some((arg) => /no-address|address=/.test(arg)), 'keeps the default external IP for outbound traffic');
  });

  test('writes the contract metadata, with the newest release resolved to its 40-character commit', () => {
    const [vm] = find(run.commands, 'gcloud', 'compute', 'instances', 'create');
    // No paraclete-dashboard-url: in a dry run the service is only planned.
    assert.deepEqual(metadataOf(vm), {
      'paraclete-repo': REPO,
      'paraclete-ref': COMMITS.release,
      'paraclete-release': RELEASE_TAG,
      'paraclete-role': 'generic',
      'paraclete-agent-name': 'Paraclete',
      'paraclete-bucket': BUCKET,
    });
    assert.match(metadataOf(vm)['paraclete-ref'], /^[0-9a-f]{40}$/);
    assert.match(flag(vm, 'metadata-from-file'), /^startup-script=.+startup-script\.sh$/);
  });

  test("the startup script fetches bootstrap.sh at the metadata's repo and commit and runs it as root", () => {
    const script = shownFile(run.stdout, 'startup-script');
    assert.match(script, /^#!\/bin\/bash\n/);
    assert.match(script, /attribute paraclete-repo/);
    assert.match(script, /attribute paraclete-ref/);
    assert.match(script, /curl --fail [^\n]*--retry/);
    assert.ok(script.includes('"https://raw.githubusercontent.com/${repo}/${ref}/install/bootstrap.sh"'));
    assert.match(script, /systemd-run --unit=paraclete-bootstrap[^\n]*--wait/);
    assert.match(script, /--property=StandardOutput=journal/);
    assert.match(script, /\/bin\/bash \/run\/paraclete-bootstrap\/bootstrap\.sh\s*$/);
  });

  test('says what it would wait for, and does not poll', () => {
    assert.match(run.stdout, new RegExp(`would wait up to 20 minutes for Firestore agent/instance to report ready on ${COMMITS.release}`));
    assert.ok(!run.calls.some((call) => call.command === 'firestore get agent/instance'));
  });
});

describe('a Workspace role', { skip: needsBash, concurrency: true }, () => {
  let run;
  before(async () => {
    run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--role', WORKSPACE_ROLE.id]);
  });

  test('adds the Workspace APIs', () => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(enabledApis(run.commands).sort(), [...BASE_APIS, ...WORKSPACE_APIS].sort());
  });

  test('turns on every API the Workspace check calls', () => {
    const enabled = enabledApis(run.commands);
    for (const probe of API_PROBES) assert.ok(enabled.includes(probe.service), `${probe.api}: ${probe.service}`);
  });

  test('adds the signer account, which only the agent may sign as, and whose client ID the dashboard may read', () => {
    const created = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'create').map((command) => command[4]);
    assert.deepEqual(created, ['paraclete-agent', 'paraclete-dashboard', 'paraclete-dwd']);
    const onSigner = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'add-iam-policy-binding')
      .filter((command) => command[4] === DWD)
      .map((command) => [flag(command, 'member'), flag(command, 'role')]);
    assert.deepEqual(onSigner, [
      [`serviceAccount:${AGENT}`, 'roles/iam.serviceAccountTokenCreator'],
      [`serviceAccount:${DASHBOARD}`, 'roles/iam.serviceAccountViewer'],
    ]);
    assert.deepEqual(projectGrants(run.commands, DWD), [], 'the signer holds no project role');
    assert.ok(!projectGrants(run.commands, AGENT).includes('roles/iam.serviceAccountTokenCreator'), 'never project-wide');
    assert.ok(!projectGrants(run.commands, DASHBOARD).includes('roles/iam.serviceAccountViewer'), 'never project-wide');
  });

  test('tells the dashboard the role has a Workspace account', () => {
    assert.deepEqual(shownEnv(run.stdout), dashboardEnv({ role: WORKSPACE_ROLE.id, workspace: true }));
  });

  test("adds the role's gcp_roles to the generic ones, each once", () => {
    const expected = [...new Set([...genericRole.gcp_roles, ...WORKSPACE_ROLE.gcp_roles])];
    assert.deepEqual(projectGrants(run.commands, AGENT), expected);
  });

  test('writes the role, and neither Workspace key before the account they pair with exists', () => {
    const metadata = metadataOf(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0]);
    assert.equal(metadata['paraclete-role'], WORKSPACE_ROLE.id);
    assert.ok(!('paraclete-workspace-account' in metadata));
    assert.ok(!('paraclete-workspace-signer' in metadata));
  });

  test('a re-run keeps Workspace keys the VM already has', async () => {
    const state = freshProject();
    const workspace = { 'paraclete-workspace-account': 'agent@example.com', 'paraclete-workspace-signer': DWD };
    state.instances.paraclete = { zone: 'us-central1-a', metadata: { ...workspace } };
    const box = createSandbox(state);
    const again = await box.run('install.sh', ['--yes', '--role', WORKSPACE_ROLE.id]);
    assert.equal(again.status, 0, again.stderr);
    const metadata = box.state().instances.paraclete.metadata;
    assert.equal(metadata['paraclete-workspace-account'], workspace['paraclete-workspace-account']);
    assert.equal(metadata['paraclete-workspace-signer'], DWD);
    assert.equal(metadata['paraclete-role'], WORKSPACE_ROLE.id);
  });
});

describe('the DevOps Engineer role: APIs, and grants on its own account and repository only', { skip: needsBash, concurrency: true }, () => {
  let run;
  before(async () => {
    run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--role', 'devops-engineer']);
  });

  test("turns on the role's APIs with the base ones", () => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(enabledApis(run.commands).sort(),
      [...BASE_APIS, 'firebasehosting.googleapis.com', 'firebase.googleapis.com'].sort());
    assert.deepEqual(devopsRole.apis, ['firebasehosting', 'firebase']);
  });

  test("grants generic's and the role's project roles, and none that reaches every account, repository or Cloud Run resource", () => {
    assert.deepEqual(projectGrants(run.commands, AGENT), [...new Set([...genericRole.gcp_roles, ...devopsRole.gcp_roles])]);
    // The dashboard's own account is the one exception, for Cloud Run: its upgrade deploys its own service.
    const everywhere = find(run.commands, 'gcloud', 'projects', 'add-iam-policy-binding')
      .filter((c) => flag(c, 'condition') === 'None')
      .filter((c) => !(flag(c, 'member') === `serviceAccount:${DASHBOARD}` && flag(c, 'role') === 'roles/run.admin'))
      .map((c) => flag(c, 'role')).filter((role) => REACHES_EVERYTHING.test(role));
    assert.deepEqual(everywhere, [], 'act-as, image push and Cloud Run change are never granted on the whole project, to anyone else');
  });

  test('changes every Cloud Run resource but the two tagged paraclete=managed, granted in step 3', () => {
    const fenced = find(run.commands, 'gcloud', 'projects', 'add-iam-policy-binding').filter((c) => flag(c, 'condition') !== 'None');
    assert.deepEqual(fenced, [FENCED_GRANT]);
    const at = run.commands.indexOf(fenced[0]);
    assert.ok(at > position(run.commands, 'gcloud', 'resource-manager', 'tags', 'values', 'create'), 'after the tag it names exists');
    assert.ok(at < position(run.commands, 'gcloud', 'firestore', 'databases', 'create'), 'within step 3');
  });

  test('acts as itself only, and pushes to agent-images only: exactly these commands, in step 3', () => {
    assert.deepEqual(agentResourceCommands(run.commands), AGENT_RESOURCE_COMMANDS);
    const last = run.commands.indexOf(agentResourceCommands(run.commands).at(-1));
    assert.ok(last > position(run.commands, 'gcloud', 'iam', 'service-accounts', 'create'), 'after the account exists');
    assert.ok(last < position(run.commands, 'gcloud', 'firestore', 'databases', 'create'), 'within step 3');
    // The dashboard's repository is still the dashboard's alone.
    const onDashboardImages = find(run.commands, 'gcloud', 'artifacts', 'repositories', 'add-iam-policy-binding')
      .filter((c) => c[4] === 'paraclete').map((c) => flag(c, 'member'));
    assert.deepEqual(onDashboardImages, [`serviceAccount:${DASHBOARD}`]);
    // Nobody is let act as the dashboard's account but the dashboard itself.
    const onDashboardAccount = find(run.commands, 'gcloud', 'iam', 'service-accounts', 'add-iam-policy-binding')
      .filter((c) => c[4] === DASHBOARD).map((c) => flag(c, 'member'));
    assert.ok(onDashboardAccount.every((member) => member === `serviceAccount:${DASHBOARD}`));
  });

  test('a real run, then a re-run, creates its repository and grants once', async () => {
    const box = createSandbox();
    const first = await box.run('install.sh', ['--yes', '--role', 'devops-engineer']);
    assert.equal(first.status, 0, first.stderr);
    const state = box.state();
    assert.deepEqual(state.accountPolicies[AGENT], [['roles/iam.serviceAccountUser', `serviceAccount:${AGENT}`]]);
    assert.deepEqual(agentBindings(state).filter(([role]) => role.startsWith('roles/run.')),
      [['roles/run.viewer', ''], ['roles/run.admin', 'paraclete-unmanaged']]);
    assert.deepEqual(state.tagValues[TAG_VALUE], [TAGGED_SERVICE, TAGGED_JOB]);
    assert.ok(state.imageRepositories.includes(`us-central1/${AGENT_IMAGES}`));
    assert.deepEqual(state.repositoryPolicies[`us-central1/${AGENT_IMAGES}`], [['roles/artifactregistry.writer', `serviceAccount:${AGENT}`]]);
    assert.ok(state.services.includes('firebasehosting.googleapis.com') && state.services.includes('firebase.googleapis.com'));
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(writes(again.calls).map((call) => call.command), ['storage buckets update']);
    assert.match(again.stdout, new RegExp(`serviceAccount:${AGENT.replace(/\./g, '\\.')} has roles/iam\\.serviceAccountUser on ${AGENT.replace(/\./g, '\\.')}`));
    assert.match(again.stdout, new RegExp(`image repository ${AGENT_IMAGES} exists in us-central1`));
    assert.match(again.stdout, /has roles\/run\.admin on everything but paraclete's own/);
  });
});

describe("the tag on paraclete's own Cloud Run resources", { skip: needsBash, concurrency: true }, () => {
  test('every install makes the tag in step 3 and binds it to the service and the update job in step 6', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(find(run.commands, 'gcloud', 'resource-manager'), [
      ['gcloud', 'resource-manager', 'tags', 'keys', 'create', 'paraclete', `--parent=projects/${PROJECT}`,
        '--description=Marks the paraclete dashboard and its update job', '--quiet'],
      ['gcloud', 'resource-manager', 'tags', 'values', 'create', 'managed', `--parent=${TAG_KEY}`,
        '--description=The paraclete dashboard and its update job', '--quiet'],
      ['gcloud', 'resource-manager', 'tags', 'bindings', 'create', `--tag-value=${TAG_VALUE}`, `--parent=${TAGGED_SERVICE}`,
        '--location=us-central1', '--quiet'],
      ['gcloud', 'resource-manager', 'tags', 'bindings', 'create', `--tag-value=${TAG_VALUE}`, `--parent=${TAGGED_JOB}`,
        '--location=us-central1', '--quiet'],
    ]);
    const [key, , service, job] = find(run.commands, 'gcloud', 'resource-manager');
    assert.ok(run.commands.indexOf(key) < position(run.commands, 'gcloud', 'projects', 'add-iam-policy-binding'), 'before the grants');
    assert.ok(run.commands.indexOf(service) > position(run.commands, 'gcloud', 'run', 'deploy'), 'after the service exists');
    assert.ok(run.commands.indexOf(job) > position(run.commands, 'gcloud', 'run', 'jobs', 'deploy'), 'after the job exists');
    assert.deepEqual(find(run.commands, 'gcloud', 'projects', 'add-iam-policy-binding').filter((c) => flag(c, 'condition') !== 'None'), [],
      'the generic role holds no fenced grant');
  });

  test('a real run makes and binds it once; a re-run finds it all in place', async () => {
    const box = createSandbox();
    const first = await box.run('install.sh', ['--yes']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(box.state().tagKeys, [TAG_KEY]);
    assert.deepEqual(box.state().tagValues, { [TAG_VALUE]: [TAGGED_SERVICE, TAGGED_JOB] });
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(find(again.commands, 'gcloud', 'resource-manager'), []);
    assert.match(again.stdout, new RegExp(`the tag key ${TAG_KEY} exists`));
    assert.match(again.stdout, /paraclete carries the tag paraclete=managed/);
    assert.match(again.stdout, new RegExp(`${contracts.auto_update.job_name} carries the tag paraclete=managed`));
  });

  test('an instance installed before the fence: the fenced grant comes first, then the project-wide run.admin goes, then the tag', async () => {
    const box = createSandbox();
    const first = await box.run('install.sh', ['--yes', '--role', 'devops-engineer']);
    assert.equal(first.status, 0, first.stderr);
    // What an older installer left: run.admin on the whole project, and no tag.
    box.update((state) => {
      state.projectPolicy = state.projectPolicy.filter(([role, member]) => !(role === 'roles/run.admin' && member === `serviceAccount:${AGENT}`));
      state.projectPolicy.push(['roles/run.admin', `serviceAccount:${AGENT}`]);
      state.tagKeys = [];
      state.tagValues = {};
    });
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    const granted = again.commands.findIndex((c) => c.join(' ') === FENCED_GRANT.join(' '));
    const revoked = position(again.commands, 'gcloud', 'projects', 'remove-iam-policy-binding');
    assert.ok(granted !== -1 && granted < revoked, 'the agent never holds neither');
    assert.equal(flag(again.commands[revoked], 'role'), 'roles/run.admin');
    assert.equal(flag(again.commands[revoked], 'condition'), 'None');
    assert.ok(revoked < position(again.commands, 'gcloud', 'resource-manager', 'tags', 'bindings', 'create'));
    assert.deepEqual(agentBindings(box.state()).filter(([role]) => role === 'roles/run.admin'), [['roles/run.admin', 'paraclete-unmanaged']]);
    assert.deepEqual(box.state().tagValues[TAG_VALUE], [TAGGED_SERVICE, TAGGED_JOB]);
  });
});

describe("every role's APIs are turned on, each once, and never turned off", { skip: needsBash, concurrency: true }, () => {
  const roles = readdirSync(join(repoRoot, 'roles'))
    .filter((id) => existsSync(join(repoRoot, 'roles', id, 'role.json')))
    .map((id) => readJson('roles', id, 'role.json'))
    .filter((role) => role.apis?.length && role.id !== 'devops-engineer');

  test('some roles ask for APIs', () => {
    assert.deepEqual(roles.map((role) => role.id).sort(), ['data-engineer', 'finance-analyst', 'security-engineer', 'web-master']);
  });

  for (const role of roles) {
    test(`${role.id}: ${role.apis.join(', ')}`, async () => {
      const run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--role', role.id]);
      assert.equal(run.status, 0, run.stderr);
      const expected = new Set([...BASE_APIS, ...(role.workspace ? WORKSPACE_APIS : []), ...role.apis.map((api) => `${api}.googleapis.com`)]);
      assert.deepEqual(enabledApis(run.commands).sort(), [...expected].sort());
      assert.deepEqual(agentResourceCommands(run.commands), [], `${role.id} asks for no single-resource grant`);
    });
  }

  test('an API already on is not turned on again', async () => {
    const state = freshProject();
    state.services = [...BASE_APIS, 'bigquery.googleapis.com'];
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes', '--role', 'data-engineer']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(enabledApis(run.commands), []);
    assert.match(run.stdout, new RegExp(`all ${BASE_APIS.length + 1} are on`));
  });
});

describe('step 1 refuses a role that asks for too much', { skip: needsBash, concurrency: true }, () => {
  /** A sandbox with one more role, `wide`, holding these fields. */
  function withRole(fields) {
    const box = createSandbox();
    mkdirSync(join(box.repo, 'roles', 'wide'), { recursive: true });
    writeFileSync(join(box.repo, 'roles', 'wide', 'role.json'), JSON.stringify({
      id: 'wide', title: 'Wide', summary: 'A test role.', version: 1, workspace: false, skills: [], gcp_roles: [],
      setup: { apt: [], pip: [], npm: [] }, ...fields,
    }));
    return box;
  }

  for (const [name, fields, message] of [
    ['act-as on the whole project', { gcp_roles: ['roles/run.admin', 'roles/iam.serviceAccountUser'] },
      /roles\/wide\/role\.json gcp_roles: roles\/iam\.serviceAccountUser is never granted on the whole project; ask for it in resource_roles, on agent-account/],
    ['image push on the whole project', { gcp_roles: ['roles/artifactregistry.writer'] }, /artifactregistry\.writer is never granted on the whole project/],
    ['Cloud Run change on the whole project', { gcp_roles: ['roles/run.developer'] },
      /run\.developer is never granted on the whole project; ask for it in resource_roles, on project-except-paraclete/],
    ['a grant on a resource that is not its own', { resource_roles: [{ role: 'roles/iam.serviceAccountUser', on: 'dashboard-account' }] },
      /on must be one of agent-account, agent-repository/],
    ['an API given by its full name', { apis: ['bigquery.googleapis.com'] }, /is not a short API name/],
  ]) {
    test(name, async () => {
      const run = await withRole(fields).run('install.sh', ['--yes', '--role', 'wide']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /error: the role cannot be installed as it is:/);
      assert.match(run.stderr, message);
      assert.deepEqual(writes(run.calls), []);
      assert.deepEqual(steps(run.stdout).map(([n]) => n), [1]);
    });
  }
});

describe('the agent never keeps act-as, image push or Cloud Run change on the whole project', { skip: needsBash, concurrency: false }, () => {
  const AGENT_MEMBER = `serviceAccount:${AGENT}`;

  test('a re-run takes back what an older DevOps definition, or a person, granted project-wide, and nothing else', async () => {
    const box = createSandbox();
    const first = await box.run('install.sh', ['--yes', '--role', 'devops-engineer']);
    assert.equal(first.status, 0, first.stderr);
    box.update((state) => {
      for (const role of ['roles/iam.serviceAccountUser', 'roles/artifactregistry.writer', 'roles/run.admin', 'roles/bigquery.dataViewer']) {
        state.projectPolicy.push([role, AGENT_MEMBER]);
      }
    });
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    const removed = find(again.commands, 'gcloud', 'projects', 'remove-iam-policy-binding');
    assert.deepEqual(removed.map((c) => [flag(c, 'member'), flag(c, 'role'), flag(c, 'condition')]), [
      [AGENT_MEMBER, 'roles/iam.serviceAccountUser', 'None'],
      [AGENT_MEMBER, 'roles/artifactregistry.writer', 'None'],
      [AGENT_MEMBER, 'roles/run.admin', 'None'],
    ]);
    assert.match(again.stdout, /the agent's account holds roles\/iam\.serviceAccountUser on the whole project, which reaches the dashboard's own account, images or service: taking it back/);
    const held = agentBindings(box.state());
    assert.ok(!held.some(([role, title]) => !title && REACHES_EVERYTHING.test(role)));
    assert.ok(held.some(([role]) => role === 'roles/bigquery.dataViewer'), 'a grant that reaches no account, repository or Cloud Run resource stays');
    assert.ok(held.some(([role, title]) => role === 'roles/run.admin' && title === 'paraclete-unmanaged'), 'the fenced run.admin stays');
    assert.deepEqual(box.state().accountPolicies[AGENT], [['roles/iam.serviceAccountUser', AGENT_MEMBER]], 'act-as on itself stays');
  });
});

describe('a move to and from the DevOps Engineer role', { skip: needsBash, concurrency: false }, () => {
  const AGENT_MEMBER = `serviceAccount:${AGENT}`;
  const REPOSITORY = `us-central1/${AGENT_IMAGES}`;
  const BUILT = `us-central1-docker.pkg.dev/${PROJECT}/${AGENT_IMAGES}/site`;
  let box;
  before(async () => {
    box = createSandbox();
    const installed = await box.run('install.sh', ['--yes']);
    assert.equal(installed.status, 0, installed.stderr);
  });

  test("moving to it adds its APIs, its repository and its two grants, and the project roles it declares", async () => {
    const moved = await box.run('install.sh', ['--yes', '--role', 'devops-engineer']);
    assert.equal(moved.status, 0, moved.stderr);
    assert.deepEqual(agentResourceCommands(moved.commands), AGENT_RESOURCE_COMMANDS);
    assert.deepEqual(enabledApis(moved.commands), ['firebasehosting.googleapis.com', 'firebase.googleapis.com']);
    const state = box.state();
    assert.deepEqual(state.accountPolicies[AGENT], [['roles/iam.serviceAccountUser', AGENT_MEMBER]]);
    assert.deepEqual(state.repositoryPolicies[REPOSITORY], [['roles/artifactregistry.writer', AGENT_MEMBER]]);
    assert.equal(state.instances.paraclete.metadata['paraclete-role'], 'devops-engineer');
    // The agent builds an image there.
    box.update((s) => { s.images[BUILT] = ['v1']; });
  });

  test('moving away takes both grants back, and leaves the repository, its images and the APIs', async () => {
    const moved = await box.run('install.sh', ['--yes', '--role', 'generic']);
    assert.equal(moved.status, 0, moved.stderr);
    assert.deepEqual(agentResourceCommands(moved.commands), [
      ['gcloud', 'iam', 'service-accounts', 'remove-iam-policy-binding', AGENT, `--project=${PROJECT}`,
        `--member=${AGENT_MEMBER}`, '--role=roles/iam.serviceAccountUser', '--quiet'],
      ['gcloud', 'artifacts', 'repositories', 'remove-iam-policy-binding', AGENT_IMAGES, '--location=us-central1', `--project=${PROJECT}`,
        `--member=${AGENT_MEMBER}`, '--role=roles/artifactregistry.writer', '--quiet'],
    ]);
    assert.match(moved.stdout, new RegExp(`image repository ${AGENT_IMAGES} stays in us-central1, with its images`));
    const state = box.state();
    assert.deepEqual(state.accountPolicies[AGENT], []);
    assert.deepEqual(state.repositoryPolicies[REPOSITORY], []);
    assert.ok(state.imageRepositories.includes(REPOSITORY), 'the repository stays');
    assert.deepEqual(state.images[BUILT], ['v1'], 'with the images the agent built');
    assert.ok(state.services.includes('firebase.googleapis.com'), 'an API is never turned off');
    assert.ok(!moved.calls.some((call) => /services disable/.test(call.command)));
    const held = state.projectPolicy.filter(([, member]) => member === AGENT_MEMBER).map(([role]) => role);
    assert.deepEqual(held.sort(), [...genericRole.gcp_roles].sort(), "only generic's project roles are left: the fenced run.admin went too");
    assert.deepEqual(find(moved.commands, 'gcloud', 'projects', 'remove-iam-policy-binding')
      .filter((c) => flag(c, 'role') === 'roles/run.admin').map((c) => flag(c, 'condition')), [FENCE]);
  });

  test('a re-run after the move takes nothing more back', async () => {
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(agentResourceCommands(again.commands), []);
    assert.deepEqual(writes(again.calls).map((call) => call.command), ['storage buckets update']);
  });
});

describe('token mode: an access token instead of a gcloud login', { skip: needsBash, concurrency: false }, () => {
  /** A sandbox with no gcloud login, and the token file and events file paths, as bash takes them. */
  function tokenBox() {
    const state = freshProject();
    state.account = '';
    const box = createSandbox(state);
    const dir = join(box.repo, '..');
    writeFileSync(join(dir, 'token'), 'fake-token\n');
    const bashPath = (name) => join(dir, name).replace(/\\/g, '/');
    return { box, token: bashPath('token'), events: bashPath('events.jsonl'), readEvents: () => readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)) };
  }
  const tokenArgs = (token) => ['--yes', '--project', PROJECT, '--access-token-file', token, '--account', OWNER];

  test('installs with no login at all, the account named the first admin, then uninstalls the same way', async () => {
    const { box, token } = tokenBox();
    const installed = await box.run('install.sh', tokenArgs(token));
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, new RegExp(`acting as ${OWNER.replace(/\./g, '\\.')}, with an access token`));
    assert.ok(!installed.calls.some((call) => /^(auth |config get-value)/.test(call.command)), 'no gcloud login was read');
    const state = box.state();
    assert.ok(state.instances.paraclete, 'the VM exists');
    assert.equal(state.users[OWNER]?.role, 'admin');
    assert.deepEqual(state.projectLabels, { paraclete: 'generic' });

    const removed = await box.run('uninstall.sh', tokenArgs(token));
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!removed.calls.some((call) => /^(auth |config get-value)/.test(call.command)));
    assert.deepEqual(box.state().instances, {});
    assert.deepEqual(box.state().projectLabels, {});
  });

  test('refuses a token without its account or project, and an account without a token, before any call', async () => {
    const { box, token } = tokenBox();
    for (const [args, message] of [
      [['--yes', '--project', PROJECT, '--access-token-file', token], /--access-token-file needs --account/],
      [['--yes', '--access-token-file', token, '--account', OWNER], /--access-token-file needs --project/],
      [['--yes', '--project', PROJECT, '--account', OWNER], /--account is for token mode/],
      [['--yes', '--project', PROJECT, '--access-token-file', `${token}-missing`, '--account', OWNER], /is missing or empty/],
    ]) {
      for (const script of ['install.sh', 'uninstall.sh']) {
        const run = await box.run(script, args);
        assert.equal(run.status, 1, `${script} ${args.join(' ')}`);
        assert.match(run.stderr, message);
        assert.deepEqual(run.calls, [], 'nothing was called');
      }
    }
  });

  test('--events: every step in order, every command printed, a done event with the dashboard, never the token', async () => {
    const { box, token, events, readEvents } = tokenBox();
    const run = await box.run('install.sh', [...tokenArgs(token), '--events', events]);
    assert.equal(run.status, 0, run.stderr);
    const list = readEvents();
    assert.deepEqual(list.filter((e) => e.type === 'step').map((e) => [e.step, e.total, e.name]),
      steps(run.stdout).map(([n, name]) => [n, 9, name]));
    assert.deepEqual(list.filter((e) => e.type === 'step').map((e) => e.step), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(list.filter((e) => e.type === 'command').length, run.commands.length);
    assert.ok(list.every((e) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(e.t)));
    const done = list.at(-1);
    assert.equal(done.type, 'done');
    assert.match(done.dashboard, /^https:\/\/paraclete-/);
    assert.equal(done.commit, box.state().instances.paraclete.metadata['paraclete-ref']);
    assert.ok(!readFileSync(join(box.repo, '..', 'events.jsonl'), 'utf8').includes('fake-token'), 'the token is never an event');
  });

  test('--events: a run that stops ends with an error event naming why', async () => {
    const { box, token, events, readEvents } = tokenBox();
    box.update((s) => { s.deniedPermissions = ['iam.serviceAccounts.create']; });
    const run = await box.run('install.sh', [...tokenArgs(token), '--events', events]);
    assert.equal(run.status, 1);
    const last = readEvents().at(-1);
    assert.equal(last.type, 'error');
    assert.match(last.text, /iam\.serviceAccounts\.create/);
  });

  test('--events in a dry run, and for uninstall: each ends with done', async () => {
    const { box, token, events, readEvents } = tokenBox();
    const dry = await box.run('install.sh', [...tokenArgs(token), '--dry-run', '--events', events]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(readEvents().at(-1).type, 'done');
    assert.equal(readEvents().filter((e) => e.type === 'command').length, dry.commands.length);
    const nothing = await box.run('uninstall.sh', [...tokenArgs(token), '--events', events]);
    assert.equal(nothing.status, 0, nothing.stderr);
    assert.deepEqual(readEvents().map((e) => e.type).slice(-2), ['text', 'done'], 'a fresh project: nothing to remove, then done');
  });
});

describe('the project label paraclete=<role>', { skip: needsBash, concurrency: false }, () => {
  test('a dry run plans it in step 3, and keeps every other label', async () => {
    const state = freshProject();
    state.projectLabels = { env: 'prod' };
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    const [patch, ...more] = run.commands.filter((c) => c[0] === 'curl' && c.some((a) => a.includes('cloudresourcemanager.googleapis.com/v3/projects/')));
    assert.equal(more.length, 0);
    assert.ok(patch.at(-1).endsWith(`/v3/projects/${state.projectNumber}?updateMask=labels`));
    assert.match(run.stdout, /"labels":\{"env":"prod","paraclete":"generic"\}/);
    const at = run.commands.indexOf(patch);
    assert.ok(at > position(run.commands, 'gcloud', 'iam', 'service-accounts', 'create'));
    assert.ok(at < position(run.commands, 'gcloud', 'firestore', 'databases', 'create'), 'within step 3');
  });

  test('a real run sets it once, a move to another role changes it, and other labels stay', async () => {
    const state = freshProject();
    state.projectLabels = { env: 'prod' };
    const box = createSandbox(state);
    assert.equal((await box.run('install.sh', ['--yes'])).status, 0);
    assert.deepEqual(box.state().projectLabels, { env: 'prod', paraclete: 'generic' });
    const again = await box.run('install.sh', ['--yes']);
    assert.ok(!again.calls.some((call) => call.command === 'project labels'), 'a label in place is not written again');
    assert.match(again.stdout, /the project is labeled paraclete=generic/);
    assert.equal((await box.run('install.sh', ['--yes', '--role', 'devops-engineer'])).status, 0);
    assert.deepEqual(box.state().projectLabels, { env: 'prod', paraclete: 'devops-engineer' });
  });
});

describe('choosing what to install', { skip: needsBash, concurrency: true }, () => {
  const vmMetadata = (run) => metadataOf(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0]);

  test('--ref names a branch', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--ref', 'dev-branch']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.devBranch);
    assert.equal(vmMetadata(run)['paraclete-release'], 'dev-branch');
  });

  test('--ref names an older release tag', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--yes', `--ref=${OLDER_TAG}`]);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.olderRelease);
    assert.equal(vmMetadata(run)['paraclete-release'], OLDER_TAG);
  });

  test('--ref names a full commit', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--ref', COMMITS.main]);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.main);
  });

  test('without release tags, the default branch', async () => {
    const state = freshProject();
    state.remotes[Object.keys(state.remotes)[0]] = state.remotes[Object.keys(state.remotes)[0]]
      .split('\n').filter((line) => !line.includes('refs/tags/')).join('\n');
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.main);
    assert.equal(vmMetadata(run)['paraclete-release'], 'main');
  });

  test('--repo installs from a fork', async () => {
    const state = freshProject();
    state.remotes['https://github.com/someone/paraclete.git'] = `${COMMITS.devBranch}\trefs/heads/main`;
    state.rawFiles.push(`someone/paraclete/${COMMITS.devBranch}/install/bootstrap.sh`);
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes', '--repo', 'someone/paraclete', '--ref', 'main']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(vmMetadata(run)['paraclete-repo'], 'someone/paraclete');
    assert.equal(vmMetadata(run)['paraclete-ref'], COMMITS.devBranch);
    assert.ok(run.calls.find((call) => call.command === 'ls-remote').args.includes('https://github.com/someone/paraclete.git'));
  });

  test('a ref that does not resolve stops before any change', async () => {
    for (const ref of ['no-such-branch', COMMITS.devBranch.slice(0, 7)]) {
      const run = await createSandbox().run('install.sh', ['--yes', '--ref', ref]);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /is not a tag, branch or full 40-character commit/);
      assert.deepEqual(writes(run.calls), []);
    }
  });

  test('a commit without install/bootstrap.sh stops before any change', async () => {
    const state = freshProject();
    state.rawFiles = [];
    const run = await createSandbox(state).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /has no install\/bootstrap\.sh/);
    assert.deepEqual(writes(run.calls), []);
  });

  test('a repository it cannot read, or a clone without a GitHub origin, stops', async () => {
    const state = freshProject();
    state.remotes = {};
    let run = await createSandbox(state).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /must exist and be public/);
    const noOrigin = freshProject();
    noOrigin.gitRemote = '';
    run = await createSandbox(noOrigin).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Pass --repo/);
  });
});

describe('step 1 stops a project that cannot hold a paraclete', { skip: needsBash, concurrency: true }, () => {
  const cases = [
    ['gcloud is not logged in', (s) => { s.account = ''; }, /not logged in/],
    ['no project is given or configured', (s) => { s.configProject = ''; }, /no project given/],
    ['the caller is not an owner', (s) => { s.deniedPermissions = ['resourcemanager.projects.setIamPolicy', 'compute.instances.create']; },
      /needs roles\/owner on your-gcp-project\. Missing: resourcemanager\.projects\.setIamPolicy compute\.instances\.create/],
    ['billing is off', (s) => { s.billingEnabled = false; }, /billing is not enabled/],
    ['the project is outside an organization', (s) => { s.ancestors = ['project']; }, /not inside a Google Cloud organization/],
  ];
  for (const [name, change, message] of cases) {
    test(name, async () => {
      const state = freshProject();
      change(state);
      const run = await createSandbox(state).run('install.sh', ['--yes']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, message);
      assert.deepEqual(writes(run.calls), []);
      assert.deepEqual(steps(run.stdout).map(([n]) => n), [1]);
    });
  }

  test('an unknown role, a bad name or a zone outside the region', async () => {
    // Every role the sandbox offers, sorted: the repo's roles and the fixture, less development roles.
    const roles = [...listedRepoRoles(), WORKSPACE_ROLE.id].sort();
    for (const [args, message] of [
      [['--role', 'no-such-role'], new RegExp(`there is no role 'no-such-role'\\. Roles: ${roles.join(' ')}\\n`)],
      [['--name', 'Bad,Name'], /the agent's name must be/],
      [['--region', 'europe-west1', '--zone', 'us-central1-a'], /the zone must be in europe-west1/],
    ]) {
      const run = await createSandbox().run('install.sh', ['--yes', ...args]);
      assert.equal(run.status, 1, args.join(' '));
      assert.match(run.stderr, message);
      assert.deepEqual(writes(run.calls), []);
    }
  });

  test('a database in Datastore mode', async () => {
    const state = freshProject();
    state.database = { type: 'DATASTORE_MODE', location: 'us-central1' };
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /is in DATASTORE_MODE\. paraclete needs Native mode/);
  });

  test('an unknown option', async () => {
    const run = await createSandbox().run('install.sh', ['--colour', 'blue']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unknown option: --colour/);
    assert.deepEqual(run.calls, []);
  });
});

describe('questions', { skip: needsBash, concurrency: true }, () => {
  test('asks for the role and the name when no flag or --yes answers them', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run'], { input: `${WORKSPACE_ROLE.id}\nAda Lovelace\n` });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Which role should the agent have\? \[generic\]/);
    assert.match(run.stderr, /What should the agent be called\? \[Paraclete\]/);
    const metadata = metadataOf(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0]);
    assert.equal(metadata['paraclete-role'], WORKSPACE_ROLE.id);
    assert.equal(metadata['paraclete-agent-name'], 'Ada Lovelace');
  });

  test('offers every role but a development role, which --role still installs', async () => {
    const asked = await createSandbox().run('install.sh', ['--dry-run'], { input: 'generic\nAda\n' });
    assert.equal(asked.status, 0, asked.stderr);
    const offered = /Roles: ([^\n]*)\n/.exec(`${asked.stdout}${asked.stderr}`)?.[1].split(' ') || [];
    assert.deepEqual(offered, [...listedRepoRoles(), WORKSPACE_ROLE.id].sort());
    assert.ok(!offered.includes('paraclete-h2'), 'a development role is not offered');

    const named = await createSandbox().run('install.sh', ['--dry-run', '--yes', '--role', 'paraclete-h2']);
    assert.equal(named.status, 0, named.stderr);
    assert.match(named.stdout, /paraclete-h2 is a development role \(listed: false in its role\.json\)/);
    assert.equal(metadataOf(find(named.commands, 'gcloud', 'compute', 'instances', 'create')[0])['paraclete-role'], 'paraclete-h2');
  });

  test('asks nothing the flags answered', async () => {
    const run = await createSandbox().run('install.sh', ['--dry-run', '--role', 'generic', '--name', 'Ada']);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /Which role|What should/);
  });

  test('changes nothing unless the confirmation is answered yes', async () => {
    const run = await createSandbox().run('install.sh', ['--role', 'generic', '--name', 'Ada'], { input: 'n\n' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Go ahead\? \[y\/N\]/);
    assert.match(run.stderr, /nothing was changed/);
    assert.deepEqual(writes(run.calls), []);
  });
});

describe('a real run, then re-runs', { skip: needsBash, concurrency: false }, () => {
  let box;
  let first;
  before(async () => {
    box = createSandbox();
    first = await box.run('install.sh', ['--yes']);
  });

  test('installs, waits for the agent and says how to watch it', () => {
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`the agent is ready on ${RELEASE_TAG} \\(${COMMITS.release}\\)`));
    assert.match(first.stdout, /gcloud compute ssh paraclete --zone=us-central1-a --project=your-gcp-project --tunnel-through-iap -- sudo journalctl -u 'paraclete-\*' -f/);
    const state = box.state();
    assert.equal(state.instances.paraclete.metadata['paraclete-ref'], COMMITS.release);
    assert.match(state.instances.paraclete.metadata['startup-script'], /bootstrap\.sh/);
    assert.deepEqual(state.buckets[BUCKET].policy.map(([role]) => role), ['roles/storage.objectAdmin', 'roles/storage.objectAdmin']);
    assert.equal(state.indexes.length, indexesFile.indexes.length);
    assert.equal(state.database.deleteProtection, true);
  });

  test('checks the model once, at the global endpoint, as the installer of this project', () => {
    const [call, ...more] = first.calls.filter((c) => c.command === 'vertex generateContent');
    assert.equal(more.length, 0);
    assert.ok(call.args.includes(MODEL_URL));
    assert.ok(call.args.includes(`x-goog-user-project: ${PROJECT}`));
    assert.ok(call.args.includes('Authorization: Bearer fake-token'));
    assert.match(call.args[call.args.indexOf('--data') + 1], /"role":"user".*"text":/);
    assert.match(first.stdout, new RegExp(`${MODEL} answers in ${PROJECT} \\(Vertex AI, global\\)`));
    assert.ok(first.calls.indexOf(call) < first.calls.findIndex((c) => c.command === 'iam service-accounts create'), 'before step 3');
  });

  test('deploys the dashboard at the release, makes the installer its first admin and tells the VM where it is', () => {
    const state = box.state();
    const service = state.runServices.paraclete;
    assert.equal(service.image, `${IMAGE}:${COMMITS.release}`);
    assert.deepEqual(service.env, dashboardEnv());
    assert.equal(service.account, DASHBOARD);
    assert.equal(service.iap, true);
    assert.deepEqual(service.policy, [['roles/run.invoker', IAP_AGENT]]);
    assert.deepEqual(state.iapPolicies['us-central1/paraclete'], [
      ['roles/iap.httpsResourceAccessor', `user:${OWNER}`], ['roles/iap.admin', `serviceAccount:${DASHBOARD}`],
    ]);
    assert.deepEqual(state.repositoryPolicies['us-central1/paraclete'], [['roles/artifactregistry.writer', `serviceAccount:${DASHBOARD}`]]);
    const [build] = state.builds;
    assert.deepEqual([build.source, build.revision, build.region, build.serviceAccount],
      [`https://github.com/${REPO}`, COMMITS.release, 'us-central1', `projects/${PROJECT}/serviceAccounts/${DASHBOARD}`]);
    assert.equal(build.config, readFileSync(join(repoRoot, 'dashboard', 'cloudbuild.json'), 'utf8'));
    assert.equal(build.timeout, '1200s');
    assert.deepEqual(Object.keys(state.users), [OWNER]);
    assert.deepEqual({ ...state.users[OWNER], added_at: 'when' }, { email: OWNER, role: 'admin', added_by: 'install.sh', added_at: 'when' });
    assert.equal(state.instances.paraclete.metadata['paraclete-dashboard-url'], service.url);
    assert.match(first.stdout, new RegExp(`Dashboard: ${service.url.replace(/\./g, '\\.')} \\(sign in as ${OWNER}`));
  });

  test('runs the update job at the release, starts it on schedule, and leaves automatic updates at their default', () => {
    const state = box.state();
    const job = state.runJobs['paraclete-auto-update'];
    assert.equal(job.image, `${IMAGE}:${COMMITS.release}`);
    assert.deepEqual(job.env, dashboardEnv(), "the service's environment, PARACLETE_SERVICE included");
    assert.equal(job.account, DASHBOARD);
    assert.deepEqual([job.command, job.args], [['node'], ['dashboard/jobs/auto-update.mjs']]);
    const schedule = state.schedules['paraclete-auto-update'];
    assert.deepEqual([schedule.schedule, schedule.account, schedule.httpMethod], [contracts.auto_update.schedule, DASHBOARD, 'POST']);
    assert.equal(state.settings, null, 'nothing stored: the default, on, applies');
  });

  test("lets the browser upload into the bucket from the dashboard's URL", () => {
    const state = box.state();
    assert.equal(state.runServices.paraclete.url, SERVICE_ORIGIN);
    assert.deepEqual(state.buckets[BUCKET].cors, uploadCors([SERVICE_ORIGIN]));
    assert.equal(corsUpdates(first.commands).length, 1);
  });

  test('a re-run creates nothing again and only repairs the bucket settings', async () => {
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(writes(again.calls).map((call) => call.command), ['storage buckets update']);
    assert.deepEqual(corsUpdates(again.commands), [], 'the CORS setting is compared first, and it is already right');
    assert.match(again.stdout, new RegExp(`gs://${BUCKET} lets the dashboard upload from ${SERVICE_ORIGIN.replace(/\./g, '\\.')}`));
    assert.match(again.stdout, new RegExp(`the image ${IMAGE}:${COMMITS.release} exists`));
    assert.match(again.stdout, new RegExp(`paraclete already runs ${COMMITS.release}`));
    assert.match(again.stdout, new RegExp(`${OWNER} is a dashboard user already`));
    assert.match(again.stdout, /paraclete exists and its metadata already names/);
    assert.match(again.stdout, /the agent is ready/);
  });

  test('a re-run with another --ref rebuilds and redeploys the dashboard and moves the VM instead of creating one', async () => {
    const moved = await box.run('install.sh', ['--yes', '--ref', 'dev-branch']);
    assert.equal(moved.status, 0, moved.stderr);
    assert.deepEqual(writes(moved.calls).map((call) => call.command),
      ['storage buckets update', 'builds submit', 'run deploy', 'run jobs deploy', 'compute instances add-metadata']);
    const service = box.state().runServices.paraclete;
    assert.equal(service.image, `${IMAGE}:${COMMITS.devBranch}`);
    assert.deepEqual(service.env, dashboardEnv({ commit: COMMITS.devBranch, release: 'dev-branch' }));
    assert.match(moved.stdout, /paraclete exists; deploying because of: image, environment/);
    const [update] = find(moved.commands, 'gcloud', 'compute', 'instances', 'add-metadata');
    assert.equal(flag(update, 'zone'), 'us-central1-a');
    assert.equal(metadataOf(update)['paraclete-ref'], COMMITS.devBranch);
    assert.equal(box.state().instances.paraclete.metadata['paraclete-release'], 'dev-branch');
    assert.match(moved.stdout, /picks up dev-branch \([0-9a-f]{40}\) at its next boot/);
    assert.match(moved.stdout, /gcloud compute instances reset paraclete --zone=us-central1-a --project=your-gcp-project/);
    assert.match(moved.stdout, new RegExp(`sudo /opt/paraclete/install/upgrade\\.sh --ref ${COMMITS.devBranch}`));
    assert.ok(!moved.calls.some((call) => call.command === 'firestore get agent/instance'), 'nothing to wait for yet');
  });

  test('the same --ref again builds and deploys nothing', async () => {
    const again = await box.run('install.sh', ['--yes', '--ref', 'dev-branch']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(writes(again.calls).map((call) => call.command), ['storage buckets update']);
  });
});

describe('--no-auto-update', { skip: needsBash, concurrency: false }, () => {
  test('stores auto_update false with a field-masked write, and a re-run without the flag leaves it', async () => {
    const box = createSandbox();
    const run = await box.run('install.sh', ['--yes', '--no-auto-update']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /updates {5}installed from the dashboard's System tab only \(--no-auto-update\)/);
    const state = box.state();
    assert.equal(state.settings.auto_update, false);
    assert.equal(state.settings.auto_update_updated_by, OWNER);
    assert.ok(state.schedules['paraclete-auto-update'], 'the schedule exists either way: the setting decides');
    const [write, ...more] = find(run.commands, 'curl').filter((c) => c.some((a) => a.includes('/documents/config/settings')));
    assert.equal(more.length, 0);
    assert.match(write.at(-1), /\?updateMask\.fieldPaths=auto_update&updateMask\.fieldPaths=auto_update_updated_at&updateMask\.fieldPaths=auto_update_updated_by$/);
    assert.ok(!write.join(' ').includes('fake-token'), 'the token stays off the command line');
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(box.state().settings.auto_update, false, "a re-run never undoes an admin's choice");
  });
});

describe('a dashboard that partly exists', { skip: needsBash, concurrency: true }, () => {
  let installed;
  before(async () => {
    const box = createSandbox();
    const run = await box.run('install.sh', ['--yes']);
    assert.equal(run.status, 0, run.stderr);
    installed = box.state();
  });

  /** A dry run on the installed project after change(state). */
  async function plan(change, args = []) {
    const state = structuredClone(installed);
    change(state);
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes', ...args]);
    assert.equal(run.status, 0, run.stderr);
    return run;
  }

  test('all of it: step 6 plans nothing', async () => {
    const run = await plan(() => {});
    assert.deepEqual(dashboardCommands(run.commands), []);
    assert.deepEqual(corsUpdates(run.commands), []);
    assert.deepEqual(writes(run.calls), []);
  });

  test("a bucket without the uploads' CORS setting, or with another one, gets it, and nothing else in step 6 changes", async () => {
    for (const [change, why] of [
      [(s) => { delete s.buckets[BUCKET].cors; }, 'none set'],
      [(s) => { s.buckets[BUCKET].cors = uploadCors(['https://elsewhere.example.com']); }, 'different'],
      [(s) => { s.buckets[BUCKET].cors[0].method = ['GET']; }, 'different'],
    ]) {
      const run = await plan(change);
      assert.deepEqual(dashboardCommands(run.commands), []);
      assert.equal(corsUpdates(run.commands).length, 1, why);
      assert.deepEqual(JSON.parse(shownFile(run.stdout, 'cors.json')), uploadCors([SERVICE_ORIGIN]));
      assert.match(run.stdout, new RegExp(`\\(its CORS setting: ${why}\\)`));
    }
    const reordered = await plan((s) => {
      s.buckets[BUCKET].cors = [{ maxAgeSeconds: 3600, responseHeader: ['etag', 'content-type'], method: ['put', 'HEAD', 'GET'], origin: [SERVICE_ORIGIN] }];
    });
    assert.deepEqual(corsUpdates(reordered.commands), [], 'the same setting, spelled another way, is left alone');
  });

  test("a service that also answers at Cloud Run's older URL lets both upload", async () => {
    const older = 'https://paraclete-abcdefghij-uc.a.run.app';
    const run = await plan((s) => {
      s.runServices.paraclete.url = older;
      s.runServices.paraclete.urls = [SERVICE_ORIGIN, older];
    });
    assert.equal(corsUpdates(run.commands).length, 1);
    assert.deepEqual(JSON.parse(shownFile(run.stdout, 'cors.json')), uploadCors([older, SERVICE_ORIGIN].sort()));
  });

  test('the repository without its grant: only the grant', async () => {
    const run = await plan((s) => { s.repositoryPolicies = {}; });
    assert.deepEqual(dashboardCommands(run.commands).map((c) => c.slice(0, 4).join(' ')), ['gcloud artifacts repositories add-iam-policy-binding']);
    assert.match(run.stdout, /image repository paraclete exists in us-central1/);
  });

  test("the image built, the service on another commit: deployed again, not rebuilt, and IAP's agent not asked for", async () => {
    const run = await plan((s) => {
      s.images[IMAGE].push(COMMITS.olderRelease);
      s.runServices.paraclete.image = `${IMAGE}:${COMMITS.olderRelease}`;
    });
    assert.deepEqual(dashboardCommands(run.commands).map((c) => c.slice(0, 3).join(' ')), ['gcloud run deploy']);
    assert.match(run.stdout, /paraclete exists; deploying because of: image$/m);
  });

  test('a service opened to everyone, or changed by hand, is deployed again as it should be', async () => {
    let run = await plan((s) => { s.runServices.paraclete.policy.push(['roles/run.invoker', 'allUsers']); });
    assert.match(run.stdout, /deploying because of: public access$/m);
    assert.ok(find(run.commands, 'gcloud', 'run', 'deploy')[0].includes('--no-allow-unauthenticated'));
    run = await plan((s) => {
      Object.assign(s.runServices.paraclete, { iap: false, cpu: '2000m', memory: '512Mi', maxInstances: '100', account: AGENT });
    });
    assert.match(run.stdout, /deploying because of: service account, IAP, cpu, memory, max instances$/m);
  });

  test('a schedule changed by hand is updated, and the job left alone', async () => {
    const run = await plan((s) => { s.schedules['paraclete-auto-update'].schedule = '0 3 * * *'; });
    assert.match(run.stdout, /the update schedule paraclete-auto-update exists; updating because of: schedule$/m);
    assert.equal(find(run.commands, 'gcloud', 'scheduler', 'jobs', 'update', 'http').length, 1);
    assert.deepEqual(find(run.commands, 'gcloud', 'run', 'jobs', 'deploy'), []);
  });

  test('an update job on another image is deployed again at the release', async () => {
    const run = await plan((s) => { s.runJobs['paraclete-auto-update'].image = `${IMAGE}:${COMMITS.olderRelease}`; s.images[IMAGE].push(COMMITS.olderRelease); });
    assert.match(run.stdout, /the update job paraclete-auto-update exists; deploying because of: image$/m);
    assert.equal(flag(find(run.commands, 'gcloud', 'run', 'jobs', 'deploy')[0], 'image'), `${IMAGE}:${COMMITS.release}`);
  });

  test('a new agent name changes only the environment', async () => {
    const run = await plan(() => {}, ['--name', "Ada O'Brien"]);
    assert.match(run.stdout, /deploying because of: environment$/m);
    assert.equal(shownEnv(run.stdout).PARACLETE_AGENT_NAME, "Ada O'Brien");
    // The update job runs with the service's environment, so it follows.
    assert.match(run.stdout, /the update job paraclete-auto-update exists; deploying because of: environment$/m);
    assert.deepEqual(dashboardCommands(run.commands).map((c) => c.slice(0, 3).join(' ')), ['gcloud run deploy', 'gcloud run jobs']);
  });

  test('missing sign-in grants are added, and only those', async () => {
    const run = await plan((s) => {
      s.iapPolicies['us-central1/paraclete'] = [['roles/iap.httpsResourceAccessor', `user:${OWNER}`]];
      s.runServices.paraclete.policy = [];
    });
    const planned = dashboardCommands(run.commands).map((c) => [c.slice(0, 4).join(' '), flag(c, 'role')]);
    assert.deepEqual(planned, [
      ['gcloud beta services identity', undefined],
      ['gcloud run services add-iam-policy-binding', 'roles/run.invoker'],
      ['gcloud iap web add-iam-policy-binding', 'roles/iap.admin'],
    ]);
  });

  test('an existing users record is never rewritten, whatever it says', async () => {
    const state = structuredClone(installed);
    state.users[OWNER] = { email: OWNER, role: 'member', added_by: 'admin@example.com', added_at: '2026-10-01T00:00:00.000Z' };
    const box = createSandbox(state);
    const run = await box.run('install.sh', ['--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.calls.some((call) => call.command === 'firestore create user'));
    assert.deepEqual(box.state().users[OWNER], state.users[OWNER]);
  });

  test('the installer is named in lowercase, in IAP and in its record', async () => {
    const state = freshProject();
    state.account = 'Owner@Example.COM';
    const box = createSandbox(state);
    const run = await box.run('install.sh', ['--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(Object.keys(box.state().users), [OWNER]);
    assert.ok(box.state().iapPolicies['us-central1/paraclete'].some(([, member]) => member === `user:${OWNER}`));
  });

  test('a commit from before the first release installs without a dashboard', async () => {
    const state = freshProject();
    state.rawFiles = state.rawFiles.filter((path) => path !== `${REPO}/${COMMITS.olderRelease}/dashboard/cloudbuild.json`);
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes', '--ref', OLDER_TAG]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`${OLDER_TAG} has no dashboard/cloudbuild.json: it is older than the first release, so no dashboard is deployed`));
    assert.deepEqual(dashboardCommands(run.commands), []);
    assert.deepEqual(corsUpdates(run.commands), [], 'no dashboard, so nothing uploads');
    assert.ok(find(run.commands, 'gcloud', 'compute', 'instances', 'create').length === 1, 'the agent still installs');
  });

  test('a failed build stops the install before anything is deployed', async () => {
    const state = freshProject();
    state.buildFails = true;
    const box = createSandbox(state);
    const run = await box.run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /this command failed: gcloud builds submit/);
    assert.deepEqual(box.state().runServices, {});
    assert.deepEqual(box.state().instances, {});
  });
});

describe('the model check', { skip: needsBash, concurrency: true }, () => {
  const quick = { MODEL_CHECK_ATTEMPTS: '3', MODEL_CHECK_DELAY_SECONDS: '0' };

  async function install(answers) {
    const state = freshProject();
    state.modelAnswers = answers;
    const run = await createSandbox(state).run('install.sh', ['--yes'], { env: quick });
    return { run, asked: run.calls.filter((call) => call.command === 'vertex generateContent').length };
  }

  test('waits out an API that is still turning on', async () => {
    const { run, asked } = await install(['disabled', 'disabled', 'ok']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(asked, 3);
    assert.equal((run.stderr.match(/did not answer \(PERMISSION_DENIED: Vertex AI API has not been used/g) || []).length, 2);
  });

  const failures = [
    ['quota', new RegExp(`${PROJECT} has no quota for ${MODEL} yet\\. Ask for it under IAM & Admin, Quotas`)],
    ['not-found', new RegExp(`${MODEL} is not available to ${PROJECT} at Vertex AI's global endpoint\\. Enable it for the project in Model Garden`)],
    ['disabled', /the Vertex AI API is still turning on for your-gcp-project\. Wait a few minutes/],
    ['unreachable', /Vertex AI could not be reached, or did not answer as expected.*UNREACHABLE: fake curl: Could not resolve host/],
  ];
  for (const [answer, reason] of failures) {
    test(`stops after its tries when the answer stays ${answer}, saying why, before step 3`, async () => {
      const { run, asked } = await install([answer]);
      assert.equal(run.status, 1);
      assert.equal(asked, 3);
      assert.match(run.stderr, /error: the agent cannot use its model: /);
      assert.match(run.stderr, reason);
      assert.match(run.stderr, /Then run install\/install\.sh again/);
      assert.deepEqual(writes(run.calls).map((call) => call.command), ['services enable', 'services enable']);
      assert.deepEqual(steps(run.stdout).map(([n]) => n), [1, 2]);
    });
  }
});

describe('the VM and the network as found', { skip: needsBash, concurrency: true }, () => {
  test('a VM in another zone is updated where it is', async () => {
    const state = freshProject();
    state.instances.paraclete = { zone: 'us-central1-f', metadata: { 'paraclete-ref': COMMITS.olderRelease } };
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes', '--zone', 'us-central1-a']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(find(run.commands, 'gcloud', 'compute', 'instances', 'create'), []);
    assert.equal(flag(find(run.commands, 'gcloud', 'compute', 'instances', 'add-metadata')[0], 'zone'), 'us-central1-f');
    assert.match(run.stdout, /already runs in us-central1-f/);
  });

  test("without flags, an existing instance keeps its role, its name and its VM's region", async () => {
    const state = freshProject();
    state.instances.paraclete = {
      zone: 'europe-west1-b',
      metadata: { 'paraclete-ref': COMMITS.olderRelease, 'paraclete-role': WORKSPACE_ROLE.id, 'paraclete-agent-name': 'Ada' },
    };
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /region {6}europe-west1, VM in europe-west1-b/);
    assert.doesNotMatch(run.stdout, /moved from/);
    const metadata = metadataOf(find(run.commands, 'gcloud', 'compute', 'instances', 'add-metadata')[0]);
    assert.equal(metadata['paraclete-role'], WORKSPACE_ROLE.id);
    assert.equal(metadata['paraclete-agent-name'], 'Ada');

    const asked = await createSandbox(state).run('install.sh', ['--dry-run'], { input: '\n\n' });
    assert.equal(asked.status, 0, asked.stderr);
    assert.match(asked.stderr, new RegExp(`Which role should the agent have\\? \\[${WORKSPACE_ROLE.id}\\]`));
    assert.match(asked.stderr, /What should the agent be called\? \[Ada\]/);
  });

  test("without a default network, it creates paraclete's own and puts the VM on it", async () => {
    const state = freshProject();
    state.networks = {};
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes']);
    const [network] = find(run.commands, 'gcloud', 'compute', 'networks', 'create');
    assert.equal(network[4], 'paraclete');
    assert.equal(flag(network, 'subnet-mode'), 'auto');
    assert.equal(flag(network, 'description'), 'Created by the paraclete installer');
    assert.equal(flag(find(run.commands, 'gcloud', 'compute', 'firewall-rules', 'create')[0], 'network'), 'paraclete');
    assert.equal(flag(find(run.commands, 'gcloud', 'compute', 'instances', 'create')[0], 'network'), 'paraclete');
  });

  test('a bootstrap that reports failure fails the install, with its reason', async () => {
    const state = freshProject();
    state.bootstrapReports = 'failed';
    state.bootstrapError = 'npm ci failed';
    const run = await createSandbox(state).run('install.sh', ['--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /the agent's install failed: npm ci failed/);
    assert.match(run.stdout, /journalctl -u 'paraclete-\*' -u google-startup-scripts/);
  });
});

describe('moving an instance to another role', { skip: needsBash, concurrency: false }, () => {
  const AGENT_MEMBER = `serviceAccount:${AGENT}`;
  let box;
  let installed;
  before(async () => {
    box = createSandbox();
    installed = await box.run('install.sh', ['--yes', '--role', WORKSPACE_ROLE.id, '--name', 'Ada']);
    box.update((state) => { state.projectPolicy.push(['roles/bigquery.dataViewer', AGENT_MEMBER]); });
  });

  test('--role on an existing instance moves it: new metadata, the old role\'s own grants taken back, the reboot named', async () => {
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(box.state().projectPolicy.some(([role, member]) => role === 'roles/example.viewer' && member === AGENT_MEMBER));

    const moved = await box.run('install.sh', ['--yes', '--role', 'generic']);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, new RegExp(`moved from ${WORKSPACE_ROLE.id} at the VM's next boot`));
    const state = box.state();
    assert.equal(state.instances.paraclete.metadata['paraclete-role'], 'generic');
    assert.equal(state.instances.paraclete.metadata['paraclete-agent-name'], 'Ada', 'the name it was installed with stays');
    const agentRoles = state.projectPolicy.filter(([, member]) => member === AGENT_MEMBER).map(([role]) => role);
    assert.ok(!agentRoles.includes('roles/example.viewer'), 'only the old role needed it');
    assert.ok(agentRoles.includes('roles/aiplatform.user'), 'generic needs it too, so it stays');
    assert.ok(agentRoles.includes('roles/bigquery.dataViewer'), 'a grant no role of this instance declared is never touched');
    assert.deepEqual(find(moved.commands, 'gcloud', 'projects', 'remove-iam-policy-binding').map((c) => flag(c, 'role')), ['roles/example.viewer']);
    assert.equal(flag(find(moved.commands, 'gcloud', 'projects', 'remove-iam-policy-binding')[0], 'condition'), 'None');
    assert.match(moved.stdout, new RegExp(`paraclete moves from role ${WORKSPACE_ROLE.id} to generic at its next boot`));
    assert.match(moved.stdout, /gcloud compute instances reset paraclete --zone=us-central1-a --project=your-gcp-project/);
    assert.match(moved.stdout, new RegExp(`sudo /opt/paraclete/install/upgrade\.sh --ref ${COMMITS.release}`));
    assert.equal(state.runServices.paraclete.env.PARACLETE_ROLE, 'generic', 'the dashboard follows the role');
  });

  test('the same role again moves nothing and takes nothing back', async () => {
    const again = await box.run('install.sh', ['--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /moved from|moves from role/);
    assert.deepEqual(find(again.commands, 'gcloud', 'projects', 'remove-iam-policy-binding'), []);
    assert.equal(box.state().instances.paraclete.metadata['paraclete-role'], 'generic');
  });

  test('a previous role this clone does not have takes no grant back, and says so', async () => {
    const state = freshProject();
    state.instances.paraclete = { zone: 'us-central1-a', metadata: { 'paraclete-ref': COMMITS.release, 'paraclete-role': 'retired-role' } };
    const run = await createSandbox(state).run('install.sh', ['--dry-run', '--yes', '--role', 'generic']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /this clone has no role 'retired-role', so the grants it added cannot be told apart/);
    assert.deepEqual(find(run.commands, 'gcloud', 'projects', 'remove-iam-policy-binding'), []);
  });
});
