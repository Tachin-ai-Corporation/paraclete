// Tests for install/lib/dashboard.mjs: the names it reads from names.sh, the exact gcloud arguments of
// the dashboard's build and deploy, the environment file (any agent name survives it), the comparison
// that decides whether a deploy would change anything, the commit a deployed service runs, and the
// command line install.sh calls it through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  BUILD_CONFIG_PATH, IMAGE_NAME, NAMES, SERVICE_SETTINGS, buildArgs, buildConfigUrl, cli, dashboardAccount, deployArgs,
  deployedCommit, deployedEnv, describeArgs, envFileText, iapServiceAgent, imagePath, parseService, parseShellNames,
  serviceDrift, serviceEnv, tagsArgs,
} from '../../../install/lib/dashboard.mjs';
import { repoRoot } from '../harness.mjs';

const PROJECT = 'your-gcp-project';
const REGION = 'us-central1';
const COMMIT = 'a'.repeat(40);
const IMAGE = `us-central1-docker.pkg.dev/${PROJECT}/paraclete/dashboard`;
const ACCOUNT = `paraclete-dashboard@${PROJECT}.iam.gserviceaccount.com`;
const INPUTS = {
  project: PROJECT, projectNumber: '123456789012', region: REGION, bucket: `${PROJECT}-paraclete`, repo: 'your-org/paraclete',
  release: 'v2026.10.17.5.1', commit: COMMIT, agentName: 'Paraclete', role: 'generic',
};

/** A service as `gcloud run services describe --format=json` prints one that is as it should be. */
function goodService(over = {}) {
  return {
    metadata: { name: 'paraclete', annotations: { 'run.googleapis.com/iap-enabled': 'true', 'run.googleapis.com/ingress': 'all' } },
    spec: {
      template: {
        metadata: { annotations: { 'autoscaling.knative.dev/maxScale': '3' } },
        spec: {
          serviceAccountName: ACCOUNT,
          containers: [{
            image: `${IMAGE}:${COMMIT}`,
            env: Object.entries(serviceEnv(INPUTS)).map(([name, value]) => ({ name, value })),
            resources: { limits: { cpu: '1000m', memory: '1Gi' } },
            ...over.container,
          }],
        },
      },
    },
    status: { url: 'https://paraclete-123456789012.us-central1.run.app' },
  };
}

test('the names come from install/lib/names.sh, the one place they are defined', () => {
  assert.equal(NAMES.SERVICE_NAME, 'paraclete');
  assert.equal(NAMES.IMAGE_REPOSITORY, 'paraclete');
  assert.equal(NAMES.DASHBOARD_ACCOUNT_ID, 'paraclete-dashboard');
  assert.equal(NAMES.FIRESTORE_DATABASE, '(default)');
  assert.equal(NAMES.NETWORK_DESCRIPTION, 'Created by the paraclete installer');
  assert.deepEqual(parseShellNames("# A=1\nB=two # note\nC='x y'\nd=lower\nE=$(cmd)\nf() {\n  G=inner\n}\n"), { B: 'two', C: 'x y' });
});

test("the image, IAP's service agent, the build config and the dashboard's account", () => {
  assert.equal(imagePath({ project: PROJECT, region: REGION }), IMAGE);
  assert.equal(IMAGE_NAME, 'dashboard');
  const number = INPUTS.projectNumber;
  assert.equal(iapServiceAgent(number), `service-${number}@gcp-sa-iap.iam.gserviceaccount.com`);
  assert.equal(buildConfigUrl({ repo: 'your-org/paraclete', commit: COMMIT }),
    `https://raw.githubusercontent.com/your-org/paraclete/${COMMIT}/${BUILD_CONFIG_PATH}`);
  assert.equal(dashboardAccount(PROJECT), ACCOUNT);
  assert.throws(() => imagePath({ project: PROJECT }), /missing region/);
});

test('the build: the commit from GitHub, its own config, as the dashboard, in the region', () => {
  assert.deepEqual(buildArgs({ repo: 'your-org/paraclete', commit: COMMIT, configFile: '/tmp/x/cloudbuild.yaml', project: PROJECT, region: REGION }), [
    'builds', 'submit', 'https://github.com/your-org/paraclete', `--git-source-revision=${COMMIT}`, '--config=/tmp/x/cloudbuild.yaml',
    `--substitutions=_IMAGE=${IMAGE},_COMMIT=${COMMIT}`, `--service-account=projects/${PROJECT}/serviceAccounts/${ACCOUNT}`,
    '--region=us-central1', `--project=${PROJECT}`, '--quiet',
  ]);
  assert.deepEqual(tagsArgs({ project: PROJECT, region: REGION }),
    ['artifacts', 'docker', 'tags', 'list', IMAGE, `--project=${PROJECT}`, '--format=value(tag.basename())']);
  assert.throws(() => buildArgs({ repo: 'your-org/paraclete', commit: COMMIT, project: PROJECT, region: REGION }), /missing configFile/);
});

test('the deploy: the image at the commit, behind IAP, closed, sized, with its whole environment from a file', () => {
  assert.deepEqual(deployArgs({ project: PROJECT, region: REGION, commit: COMMIT, envFile: '/tmp/x/env.yaml' }), [
    'run', 'deploy', 'paraclete', `--image=${IMAGE}:${COMMIT}`, '--region=us-central1', `--service-account=${ACCOUNT}`,
    '--no-allow-unauthenticated', '--iap', '--ingress=all', '--cpu=1', '--memory=1Gi', '--max-instances=3',
    '--env-vars-file=/tmp/x/env.yaml', `--project=${PROJECT}`, '--quiet',
  ]);
  assert.deepEqual(describeArgs({ project: PROJECT, region: REGION }),
    ['run', 'services', 'describe', 'paraclete', '--region=us-central1', `--project=${PROJECT}`, '--format=json']);
  assert.deepEqual(SERVICE_SETTINGS, { cpu: '1', memory: '1Gi', maxInstances: '3', ingress: 'all' });
});

test("the environment file keeps any agent name exactly, quotes and commas included", () => {
  const env = serviceEnv({ ...INPUTS, agentName: `Ada O'Brien, "the second": #1` });
  const text = envFileText(env);
  const back = Object.fromEntries(text.trimEnd().split('\n').map((line) => {
    const m = /^([A-Z_]+): (".*")$/.exec(line);
    assert.ok(m, line);
    return [m[1], JSON.parse(m[2])];
  }));
  assert.deepEqual(back, env);
  assert.equal(env.PARACLETE_SERVICE, 'paraclete');
  assert.ok(!('PARACLETE_IAP_AUDIENCE' in env), 'the override stays unset');
  assert.throws(() => serviceEnv({ ...INPUTS, role: '' }), /missing role/);
});

test('a service as it should be needs no deploy, however Cloud Run spells its sizes', () => {
  const wanted = { project: PROJECT, region: REGION, commit: COMMIT, env: serviceEnv(INPUTS) };
  assert.deepEqual(serviceDrift(goodService(), wanted), []);
  const spelled = goodService({ container: { resources: { limits: { cpu: '1', memory: '1024Mi' } } } });
  assert.deepEqual(serviceDrift(spelled, wanted), []);
  const noIngress = goodService();
  delete noIngress.metadata.annotations['run.googleapis.com/ingress'];
  assert.deepEqual(serviceDrift(noIngress, wanted), [], "Cloud Run's default ingress is all");
});

test('every difference is named, and no service at all is "missing"', () => {
  const wanted = { project: PROJECT, region: REGION, commit: COMMIT, env: serviceEnv(INPUTS) };
  assert.deepEqual(serviceDrift(null, wanted), ['missing']);
  const off = goodService({
    container: {
      image: `${IMAGE}:${'b'.repeat(40)}`,
      env: [...goodService().spec.template.spec.containers[0].env, { name: 'EXTRA', value: '1' }],
      resources: { limits: { cpu: '2', memory: '512Mi' } },
    },
  });
  off.spec.template.spec.serviceAccountName = 'someone@example.com';
  off.metadata.annotations = { 'run.googleapis.com/ingress': 'internal' };
  off.spec.template.metadata.annotations = {};
  assert.deepEqual(serviceDrift(off, wanted),
    ['image', 'environment', 'service account', 'IAP', 'ingress', 'cpu', 'memory', 'max instances']);
  assert.deepEqual(serviceDrift(goodService(), { ...wanted, env: { ...wanted.env, PARACLETE_AGENT_NAME: 'Ada' } }), ['environment']);
});

test('the commit a service runs is its image tag, when that is a commit', () => {
  assert.equal(deployedCommit(goodService()), COMMIT);
  assert.equal(deployedCommit(goodService({ container: { image: `${IMAGE}:latest` } })), null);
  assert.equal(deployedCommit(goodService({ container: { image: `${IMAGE}@sha256:${'c'.repeat(64)}` } })), null);
  assert.equal(deployedCommit(null), null);
  assert.equal(deployedEnv(goodService()).PARACLETE_COMMIT, COMMIT);
  assert.deepEqual(deployedEnv(goodService({ container: { env: [{ name: 'S', valueFrom: { secretKeyRef: {} } }] } })), {});
  assert.equal(parseService(''), null);
  assert.equal(parseService('not json'), null);
  assert.equal(parseService(JSON.stringify(goodService())).status.url, 'https://paraclete-123456789012.us-central1.run.app');
});

test('the command line install.sh uses: argument lists one per line, the drift from stdin, refusals on stderr', () => {
  const pairs = Object.entries(INPUTS).map(([key, value]) => `${key}=${value}`);
  assert.equal(cli(['build-args', 'repo=your-org/paraclete', `commit=${COMMIT}`, 'configFile=/tmp/c.yaml', `project=${PROJECT}`, `region=${REGION}`]),
    buildArgs({ repo: 'your-org/paraclete', commit: COMMIT, configFile: '/tmp/c.yaml', project: PROJECT, region: REGION }).join('\n'));
  assert.equal(cli(['drift', ...pairs], JSON.stringify(goodService())), '');
  assert.equal(cli(['drift', ...pairs], ''), 'missing');
  assert.equal(cli(['drift', ...pairs.map((p) => (p.startsWith('agentName=') ? 'agentName=Ada=Lovelace' : p))], JSON.stringify(goodService())), 'environment');
  assert.throws(() => cli(['nothing']), /unknown command 'nothing'/);
  assert.throws(() => cli(['image', 'project']), /expected key=value, got 'project'/);

  const script = join(repoRoot, 'install', 'lib', 'dashboard.mjs');
  const ok = spawnSync(process.execPath, [script, 'image', `project=${PROJECT}`, `region=${REGION}`], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${IMAGE}\n`);
  const drift = spawnSync(process.execPath, [script, 'drift', ...pairs], { input: JSON.stringify(goodService()), encoding: 'utf8' });
  assert.equal(drift.status, 0, drift.stderr);
  assert.equal(drift.stdout, '');
  const bad = spawnSync(process.execPath, [script, 'image', `project=${PROJECT}`], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /missing region/);
});
