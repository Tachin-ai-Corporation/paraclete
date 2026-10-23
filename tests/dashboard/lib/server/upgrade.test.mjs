// Tests for dashboard/lib/server/upgrade.mjs, against the Firestore fake and a fake Google and GitHub:
// an admin starts an upgrade to a published release; the VM moves first (the signed `upgrade` command),
// then Cloud Build builds the dashboard at the release's commit with that commit's own build config,
// then Cloud Run rolls the dashboard's own service to the new image with nothing else changed. Also:
// who may start one and to which version; two admins, and two readers, at once; a repeat that finds
// the image built; every way a step can fail; a step interrupted between its claim and its call; and
// the names shared with the installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startDashboard } from '../../harness.mjs';
import {
  IMAGE_REPOSITORY, STEP_START_GRACE_SECONDS, UPGRADE_DOC, VM_MARGIN_SECONDS, buildRequest, imagePath, parseBuildConfig,
  readUpgrade, rolloutJob, rolloutService, startUpgrade, upgradeView,
} from '../../../../dashboard/lib/server/upgrade.mjs';
import { RELEASE_CHECK_DOC } from '../../../../dashboard/lib/server/releases.mjs';
import { NAMES, imagePath as installImagePath } from '../../../../install/lib/dashboard.mjs';

const admin = { email: 'admin@example.com', role: 'admin' };
const other = { email: 'other-admin@example.com', role: 'admin' };
const member = { email: 'member@example.com', role: 'member' };
const PROJECT = 'your-gcp-project';
const REGION = 'us-central1';
const V1 = 'v2027.01.10.1.1';
const V2 = 'v2027.01.15.2.1';
const V3 = 'v2027.01.20.1.1';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = new Date('2027-01-21T09:00:00.000Z');
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const ACCOUNT = `paraclete-dashboard@${PROJECT}.iam.gserviceaccount.com`;
const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/paraclete/dashboard`;
const SERVICE_URL = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/paraclete`;
const JOB_URL = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/paraclete-auto-update`;
const BUILDS_URL = `https://cloudbuild.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/builds`;
const OPERATION = `projects/${PROJECT}/locations/${REGION}/operations/op-1`;
const BUILD_CONFIG = readFileSync(new URL('../../../../dashboard/cloudbuild.json', import.meta.url), 'utf8');
const sign = async () => 'header.payload.signature';

/** The dashboard's Cloud Run service as the v2 API answers it: IAP on, sized, with its environment. */
function runService(commit = A, release = V1) {
  return {
    name: `projects/${PROJECT}/locations/${REGION}/services/paraclete`,
    uid: 'u-1',
    etag: '"etag-1"',
    ingress: 'INGRESS_TRAFFIC_ALL',
    iapEnabled: true,
    invokerIamDisabled: false,
    launchStage: 'GA',
    scaling: {},
    template: {
      revision: 'paraclete-00007-abc',
      serviceAccount: ACCOUNT,
      scaling: { maxInstanceCount: 3 },
      containers: [{
        image: `${IMAGE}:${commit}`,
        env: [
          { name: 'PARACLETE_PROJECT', value: PROJECT },
          { name: 'PARACLETE_REPO', value: 'your-org/paraclete' },
          { name: 'PARACLETE_RELEASE', value: release },
          { name: 'PARACLETE_COMMIT', value: commit },
          { name: 'PARACLETE_AGENT_NAME', value: 'Ada' },
        ],
        resources: { limits: { cpu: '1000m', memory: '1Gi' } },
        ports: [{ containerPort: 8080 }],
      }],
    },
    traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
  };
}

/** The automatic-update job as the v2 API answers it. */
function runJob(commit = A, version = V1) {
  return {
    name: `projects/${PROJECT}/locations/${REGION}/jobs/paraclete-auto-update`,
    etag: '"job-etag"',
    launchStage: 'GA',
    template: {
      taskCount: 1,
      template: {
        serviceAccount: ACCOUNT,
        timeout: '3600s',
        maxRetries: 0,
        containers: [{
          image: `${IMAGE}:${commit}`,
          command: ['node'],
          args: ['dashboard/jobs/auto-update.mjs'],
          env: [
            { name: 'PARACLETE_PROJECT', value: PROJECT },
            { name: 'PARACLETE_SERVICE', value: 'paraclete' },
            { name: 'PARACLETE_RELEASE', value: version },
            { name: 'PARACLETE_COMMIT', value: commit },
          ],
        }],
      },
    },
  };
}

const release = (tag) => ({ tag_name: tag, name: tag, body: `- ${tag}`, html_url: `https://github.com/your-org/paraclete/releases/tag/${tag}`, published_at: '2027-01-20T10:00:00Z' });

/**
 * GitHub, Cloud Build, Artifact Registry and Cloud Run, faked. `cloud` holds what each answers; every
 * call is recorded with its method and parsed body.
 */
function fakeCloud() {
  const cloud = {
    calls: [],
    releases: [release(V3), release(V2), release(V1)],
    commits: { [V1]: A, [V2]: B, [V3]: 'c'.repeat(40) },
    imageTags: [],
    buildConfig: BUILD_CONFIG,
    buildStart: { status: 200, body: { name: 'operations/build/x', metadata: { build: { id: 'build-1', status: 'QUEUED' } } } },
    build: { status: 'WORKING' },
    buildRead: 200,
    service: runService(),
    patch: { status: 200, body: { name: OPERATION, done: false } },
    operation: { name: OPERATION, done: false },
    job: null,
    jobPatch: { status: 200, body: { name: `projects/${PROJECT}/locations/${REGION}/operations/op-job`, done: false } },
  };
  const answer = (status, body) => new Response(JSON.stringify(body), { status });
  cloud.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    cloud.calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    await new Promise((resolve) => setImmediate(resolve));
    if (u === 'https://api.github.com/repos/your-org/paraclete/releases?per_page=30') return answer(200, cloud.releases);
    const commit = /^https:\/\/api\.github\.com\/repos\/your-org\/paraclete\/commits\/(.+)$/.exec(u);
    if (commit) return cloud.commits[commit[1]] ? answer(200, { sha: cloud.commits[commit[1]] }) : answer(422, { message: 'No commit found' });
    if (u.startsWith('https://raw.githubusercontent.com/your-org/paraclete/')) {
      return cloud.buildConfig === null ? new Response('404: Not Found', { status: 404 }) : new Response(cloud.buildConfig, { status: 200 });
    }
    const tag = /^https:\/\/artifactregistry\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/[^/]+\/repositories\/paraclete\/packages\/dashboard\/tags\/([0-9a-f]{40})$/.exec(u);
    if (tag) return cloud.imageTags.includes(tag[1]) ? answer(200, { name: u }) : answer(404, { error: { message: 'not found' } });
    if (u === BUILDS_URL && method === 'POST') return answer(cloud.buildStart.status, cloud.buildStart.body);
    if (u === `${BUILDS_URL}/build-1`) return answer(cloud.buildRead, cloud.buildRead === 200 ? cloud.build : { error: { message: 'backend unavailable' } });
    if (u === SERVICE_URL && method === 'GET') return answer(200, cloud.service);
    if (u === SERVICE_URL && method === 'PATCH') return answer(cloud.patch.status, cloud.patch.body);
    if (u === `https://run.googleapis.com/v2/${OPERATION}`) return answer(200, cloud.operation);
    if (u === JOB_URL && method === 'GET') return cloud.job ? answer(200, cloud.job) : answer(404, { error: { message: 'Job not found' } });
    if (u === JOB_URL && method === 'PATCH') return answer(cloud.jobPatch.status, cloud.jobPatch.body);
    return answer(599, { error: { message: `unexpected call ${method} ${u}` } });
  };
  cloud.to = (prefix, method) => cloud.calls.filter((c) => c.url.startsWith(prefix) && (!method || c.method === method));
  return cloud;
}

const ENV = { PARACLETE_REPO: 'your-org/paraclete', PARACLETE_RELEASE: V1, PARACLETE_COMMIT: A };

async function dashboard(t, { env = ENV, agent = { status: 'ready', release: V1, commit: A } } = {}) {
  const cloud = fakeCloud();
  const dash = await startDashboard({ env, fetch: cloud.fetch });
  t.after(dash.stop);
  if (agent) await dash.seed({ 'agent/instance': agent });
  const record = () => dash.doc(`config/${UPGRADE_DOC}`);
  /** The VM's side: control finishes the command, and the bootstrap reports ready on the commit. */
  async function vmFinishes(id, { status = 'done', error = null, commit = B, release: version = V2 } = {}) {
    await dash.runtime.db.patch(`commands/${id}`, ['status', 'error', 'finished_at'], dash.encode({ status, error, finished_at: NOW.toISOString() }), { strict: true });
    if (status === 'done') await dash.seed({ 'agent/instance': { status: 'ready', release: version, commit } });
  }
  return { ...dash, cloud, record, vmFinishes };
}

test('the names: the image repository is the installer\'s, and the image path the one install.sh builds into', async (t) => {
  assert.equal(IMAGE_REPOSITORY, NAMES.IMAGE_REPOSITORY);
  const dash = await dashboard(t);
  assert.equal(imagePath(dash.runtime.settings, dash.runtime.contracts), installImagePath({ project: PROJECT, region: REGION }));
});

test('an upgrade, start to end: the VM, then the build at the commit, then the rollout of the same service', async (t) => {
  const dash = await dashboard(t);
  const { upgrade: started } = await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  assert.equal(started.state, 'vm');
  assert.equal(started.version, V2);
  assert.equal(started.commit, B, "the tag's commit, from GitHub");
  assert.equal(started.requested_by, 'admin@example.com');
  assert.deepEqual(dash.cloud.to('https://api.github.com/repos/your-org/paraclete/commits/').map((c) => c.url), [`https://api.github.com/repos/your-org/paraclete/commits/${V2}`]);

  const stored = await dash.record();
  assert.deepEqual(Object.keys(stored).sort(),
    ['build_id', 'commit', 'error', 'id', 'operation', 'requested_at', 'requested_by', 'state', 'updated_at', 'version', 'vm_command_id']);
  const command = await dash.doc(`commands/${stored.vm_command_id}`);
  assert.deepEqual({ type: command.type, params: command.params, status: command.status, by: command.requested_by, signature: command.signature },
    { type: 'upgrade', params: { ref: V2 }, status: 'pending', by: 'admin@example.com', signature: 'header.payload.signature' });

  // While the VM works, nothing else moves.
  let { upgrade } = await readUpgrade(dash.runtime, { user: member, now: later(30) });
  assert.equal(upgrade.state, 'vm');
  assert.deepEqual(upgrade.vm, { status: 'pending', started_at: null });
  assert.equal(dash.cloud.to(BUILDS_URL).length, 0);

  await dash.vmFinishes(stored.vm_command_id);
  ({ upgrade } = await readUpgrade(dash.runtime, { user: member, now: later(300) }));
  assert.equal(upgrade.state, 'build');
  assert.ok(!('build_id' in upgrade), 'members see the progress, not the ids');
  const [start] = dash.cloud.to(BUILDS_URL, 'POST');
  assert.equal(start.auth, 'Bearer dashboard-token');
  const config = JSON.parse(BUILD_CONFIG);
  assert.deepEqual(start.body, {
    source: { gitSource: { url: 'https://github.com/your-org/paraclete.git', revision: B } },
    steps: config.steps,
    images: config.images,
    options: config.options,
    substitutions: { _IMAGE: IMAGE, _COMMIT: B },
    serviceAccount: `projects/${PROJECT}/serviceAccounts/${ACCOUNT}`,
    timeout: '1200s',
  });
  const raw = dash.cloud.calls.find((c) => c.url.startsWith('https://raw.githubusercontent.com/'));
  assert.equal(raw.url, `https://raw.githubusercontent.com/your-org/paraclete/${B}/dashboard/cloudbuild.json`, "the release's own build config");
  assert.equal((await dash.record()).build_id, 'build-1');

  ({ upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(400) }));
  assert.equal(upgrade.state, 'build');
  assert.equal(upgrade.build.status, 'WORKING');
  assert.equal(upgrade.build_log_url, `https://console.cloud.google.com/cloud-build/builds;region=${REGION}/build-1?project=${PROJECT}`);
  assert.equal(dash.cloud.to(SERVICE_URL).length, 0);

  dash.cloud.build = { status: 'SUCCESS' };
  ({ upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(500) }));
  assert.equal(upgrade.state, 'deploy');
  assert.equal(upgrade.operation, OPERATION);
  const [patch] = dash.cloud.to(SERVICE_URL, 'PATCH');
  const expected = runService();
  expected.template.containers[0].image = `${IMAGE}:${B}`;
  expected.template.containers[0].env.find((e) => e.name === 'PARACLETE_RELEASE').value = V2;
  expected.template.containers[0].env.find((e) => e.name === 'PARACLETE_COMMIT').value = B;
  delete expected.template.revision;
  assert.deepEqual(patch.body, expected, 'only the image and the release and commit move; IAP, the account, the size and the rest stay as read');

  ({ upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(520) }));
  assert.equal(upgrade.state, 'deploy', 'until Cloud Run says the operation is done');
  dash.cloud.operation = { name: OPERATION, done: true, response: { name: 'service' } };
  ({ upgrade } = await readUpgrade(dash.runtime, { user: member, now: later(540) }));
  assert.equal(upgrade.state, 'done');
  assert.equal(upgrade.running, false);
  assert.equal(upgrade.error, null);

  await readUpgrade(dash.runtime, { user: member, now: later(600) });
  assert.equal(dash.cloud.to(BUILDS_URL, 'POST').length, 1);
  assert.equal(dash.cloud.to(SERVICE_URL, 'PATCH').length, 1, 'a finished upgrade calls nothing');
});

test('once the dashboard serves the new release, the automatic-update job is moved to the same image; a job that is missing or refuses does not fail the upgrade', async (t) => {
  for (const [job, jobPatch] of [[runJob(), { status: 200 }], [null, null], [runJob(), { status: 403, body: { error: { message: 'denied' } } }]]) {
    const dash = await dashboard(t);
    dash.cloud.job = job;
    if (jobPatch) dash.cloud.jobPatch = { body: { name: 'op' }, ...jobPatch };
    await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
    await dash.vmFinishes((await dash.record()).vm_command_id);
    await readUpgrade(dash.runtime, { user: admin, now: later(300) });
    dash.cloud.build = { status: 'SUCCESS' };
    await readUpgrade(dash.runtime, { user: admin, now: later(500) });
    assert.equal(dash.cloud.to(JOB_URL).length, 0, 'the job is not touched before the dashboard serves');
    dash.cloud.operation = { name: OPERATION, done: true, response: { name: 'service' } };
    const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(540) });
    assert.equal(upgrade.state, 'done');
    const patches = dash.cloud.to(JOB_URL, 'PATCH');
    if (!job) {
      assert.deepEqual(patches, [], 'no job: nothing to move');
      assert.ok(dash.lines.some((l) => /there is no paraclete-auto-update job to move/.test(l.message)));
      continue;
    }
    const expected = runJob();
    expected.template.template.containers[0].image = `${IMAGE}:${B}`;
    expected.template.template.containers[0].env.find((e) => e.name === 'PARACLETE_RELEASE').value = V2;
    expected.template.template.containers[0].env.find((e) => e.name === 'PARACLETE_COMMIT').value = B;
    assert.deepEqual(patches.map((p) => p.body), [expected], 'only the image and the release and commit move');
    if (jobPatch.status !== 200) assert.ok(dash.lines.some((l) => /did not take the new image/.test(l.message)));
  }
});

test('rolloutJob refuses a job without a container, and leaves the one it read alone', () => {
  assert.throws(() => rolloutJob({ template: { template: { containers: [] } } }, { image: 'x', version: V2, commit: B }), /no container/);
  const job = runJob();
  const moved = rolloutJob(job, { image: `${IMAGE}:${B}`, version: V2, commit: B });
  assert.equal(job.template.template.containers[0].image, `${IMAGE}:${A}`);
  assert.equal(moved.template.template.containers[0].image, `${IMAGE}:${B}`);
});

test('a failed VM upgrade leaves the dashboard as it is', async (t) => {
  const dash = await dashboard(t);
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id, { status: 'failed', error: 'upgrade.sh exited with status 1' });
  const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(300) });
  assert.equal(upgrade.state, 'failed');
  assert.match(upgrade.error, /the agent could not move to v2027\.01\.15\.2\.1: upgrade\.sh exited with status 1\. The dashboard stays on v2027\.01\.10\.1\.1\./);
  assert.equal(dash.cloud.to(BUILDS_URL).length + dash.cloud.to(SERVICE_URL).length, 0);
});

test('a VM that reports another commit, or nothing ready, stops the upgrade before the dashboard moves', async (t) => {
  const dash = await dashboard(t);
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id, { commit: 'c'.repeat(40) });
  const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(300) });
  assert.equal(upgrade.state, 'failed');
  assert.match(upgrade.error, /reports ready on cccccccccccc, not ready on bbbbbbbbbbbb \(v2027\.01\.15\.2\.1\), so the dashboard is not moved/);
  assert.equal(dash.cloud.to(BUILDS_URL).length, 0);
});

test('a VM that never finishes fails the upgrade after control.upgrade_max_seconds and a margin', async (t) => {
  const dash = await dashboard(t);
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  const limit = dash.runtime.contracts.control.upgrade_max_seconds + VM_MARGIN_SECONDS;
  assert.equal((await readUpgrade(dash.runtime, { user: admin, now: later(limit - 1) })).upgrade.state, 'vm');
  const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(limit + 1) });
  assert.equal(upgrade.state, 'failed');
  assert.match(upgrade.error, /has not finished moving to v2027\.01\.15\.2\.1 after 40 minutes: its control service never picked the command up/);
});

test('two readers at once move the upgrade on once: one build is started', async (t) => {
  const dash = await dashboard(t);
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  const [first, second] = await Promise.all([
    readUpgrade(dash.runtime, { user: admin, now: later(300) }),
    readUpgrade(dash.runtime, { user: member, now: later(300) }),
  ]);
  assert.equal(dash.cloud.to(BUILDS_URL, 'POST').length, 1);
  assert.deepEqual([first.upgrade.state, second.upgrade.state], ['build', 'build']);
  assert.equal((await dash.record()).build_id, 'build-1');

  dash.cloud.build = { status: 'SUCCESS' };
  await Promise.all([1, 2, 3].map(() => readUpgrade(dash.runtime, { user: member, now: later(400) })));
  assert.equal(dash.cloud.to(SERVICE_URL, 'PATCH').length, 1, 'and one rollout');
});

test('two admins cannot start two upgrades, and none starts while one runs', async (t) => {
  const dash = await dashboard(t);
  const results = await Promise.allSettled([
    startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign }),
    startUpgrade(dash.runtime, { version: V3, user: other, now: NOW, sign }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost[0].reason.status, 409);
  assert.match(lost[0].reason.message, /another admin started an upgrade a moment ago|is still running/);
  const commands = await dash.runtime.db.query('', 'commands', [], { noOrderBy: true, strict: true });
  assert.equal(commands.length, 1, 'one command reached the VM');

  await assert.rejects(startUpgrade(dash.runtime, { version: V3, user: other, now: later(5), sign }),
    (err) => err.status === 409 && /an upgrade to v2027\.01\.(15\.2|20\.1)\.1, started by (other-)?admin@example\.com, is still running/.test(err.message));
});

test('who may start one, and to which version', async (t) => {
  const dash = await dashboard(t);
  await assert.rejects(startUpgrade(dash.runtime, { version: V2, user: member, now: NOW, sign }), (err) => err.status === 403);
  await assert.rejects(startUpgrade(dash.runtime, { version: 'main', user: admin, now: NOW, sign }), (err) => err.status === 400 && /'main' is not a release version/.test(err.message));
  await assert.rejects(startUpgrade(dash.runtime, { version: 'v2027.01.05.1.1', user: admin, now: NOW, sign }),
    (err) => err.status === 409 && /older than v2027\.01\.10\.1\.1/.test(err.message));
  await assert.rejects(startUpgrade(dash.runtime, { version: 'v2027.01.25.1.1', user: admin, now: NOW, sign }),
    (err) => err.status === 409 && /v2027\.01\.25\.1\.1 is not a published release of your-org\/paraclete/.test(err.message));
  assert.equal(await dash.record(), null, 'nothing was written');
  assert.deepEqual(await dash.runtime.db.query('', 'commands', [], { noOrderBy: true, strict: true }), []);

  const branch = await dashboard(t, { env: { ...ENV, PARACLETE_RELEASE: 'main' }, agent: { status: 'ready', release: 'main', commit: A } });
  await assert.rejects(startUpgrade(branch.runtime, { version: V2, user: admin, now: NOW, sign }),
    (err) => err.status === 409 && /does not run a release/.test(err.message));

  const bare = await dashboard(t, { env: { PARACLETE_RELEASE: V1, PARACLETE_COMMIT: A } });
  await assert.rejects(startUpgrade(bare.runtime, { version: V2, user: admin, now: NOW, sign }),
    (err) => err.status === 503 && /without PARACLETE_REPO/.test(err.message));
});

test('a tag GitHub cannot resolve starts nothing', async (t) => {
  const dash = await dashboard(t);
  delete dash.cloud.commits[V2];
  await assert.rejects(startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign }),
    (err) => err.status === 502 && /GitHub answered 422 for the commit of v2027\.01\.15\.2\.1/.test(err.message));
  assert.equal(await dash.record(), null);
});

test('a command that cannot be signed fails the upgrade it claimed, saying why', async (t) => {
  const dash = await dashboard(t);
  const refuse = async () => { throw new Error('denied'); };
  await assert.rejects(startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign: refuse }), (err) => err.status === 502);
  const stored = await dash.record();
  assert.equal(stored.state, 'failed');
  assert.match(stored.error, /the upgrade command could not be sent to the agent: the dashboard could not sign the command/);
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: later(10), sign });
  assert.equal((await dash.record()).state, 'vm', 'a failed upgrade may be started again');
});

test('installing the half-done release again finds its image and goes straight to the rollout', async (t) => {
  const dash = await dashboard(t, { agent: { status: 'ready', release: V2, commit: B } });
  dash.cloud.imageTags = [B];
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(60) });
  assert.equal(upgrade.state, 'deploy');
  assert.equal(dash.cloud.to(BUILDS_URL).length, 0, 'no build');
  assert.equal(dash.cloud.calls.some((c) => c.url.startsWith('https://raw.githubusercontent.com/')), false);
  assert.equal(dash.cloud.to(SERVICE_URL, 'PATCH')[0].body.template.containers[0].image, `${IMAGE}:${B}`);
});

test('a failed build stops before the dashboard moves, and says how to finish', async (t) => {
  const dash = await dashboard(t);
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  await readUpgrade(dash.runtime, { user: admin, now: later(300) });
  dash.cloud.build = { status: 'FAILURE', statusDetail: 'Build step 0 "gcr.io/cloud-builders/docker" failed: step exited with non-zero status: 1' };
  const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(400) });
  assert.equal(upgrade.state, 'failed');
  assert.match(upgrade.error, /the dashboard's build ended FAILURE \(Build step 0 .* failed.*\)\. The agent runs v2027\.01\.15\.2\.1; the dashboard stays on v2027\.01\.10\.1\.1\. Install v2027\.01\.15\.2\.1 again to finish\./);
  assert.equal(dash.cloud.to(SERVICE_URL).length, 0);
});

test('Cloud Build refusing the build, or a commit without a build config, fails the upgrade', async (t) => {
  let dash = await dashboard(t);
  dash.cloud.buildStart = { status: 403, body: { error: { message: 'The caller does not have permission' } } };
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  let { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(300) });
  assert.equal(upgrade.state, 'failed');
  assert.match(upgrade.error, /Cloud Build did not start the dashboard's build \(403: The caller does not have permission\)\. paraclete-dashboard@your-gcp-project\.iam\.gserviceaccount\.com needs Cloud Build Editor/);

  dash = await dashboard(t);
  dash.cloud.buildConfig = null;
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  ({ upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(300) }));
  assert.match(upgrade.error, /v2027\.01\.15\.2\.1's build config could not be read: the commit has no dashboard\/cloudbuild\.json/);
});

test('a passing Cloud Build outage is a notice, not a failure', async (t) => {
  const dash = await dashboard(t);
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  await readUpgrade(dash.runtime, { user: admin, now: later(300) });
  dash.cloud.buildRead = 503;
  const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(400) });
  assert.equal(upgrade.state, 'build');
  assert.match(upgrade.notice, /Cloud Build could not be asked about the build just now \(503: backend unavailable\)/);
});

test('a rollout Cloud Run refuses or cannot finish fails the upgrade; the previous revision keeps serving', async (t) => {
  let dash = await dashboard(t);
  dash.cloud.imageTags = [B];
  dash.cloud.patch = { status: 400, body: { error: { message: 'Invalid annotation' } } };
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  let { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(300) });
  assert.equal(upgrade.state, 'failed');
  assert.match(upgrade.error, /Cloud Run did not take the new revision \(400: Invalid annotation\)/);

  dash = await dashboard(t);
  dash.cloud.imageTags = [B];
  await startUpgrade(dash.runtime, { version: V2, user: admin, now: NOW, sign });
  await dash.vmFinishes((await dash.record()).vm_command_id);
  await readUpgrade(dash.runtime, { user: admin, now: later(300) });
  dash.cloud.operation = { name: OPERATION, done: true, error: { code: 9, message: 'Revision paraclete-00008 is not ready' } };
  ({ upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(360) }));
  assert.equal(upgrade.state, 'failed');
  assert.match(upgrade.error, /Cloud Run could not start the new revision \(Revision paraclete-00008 is not ready\)\. The previous one keeps serving/);
});

test('a step claimed but never started (the dashboard stopped in between) fails after the grace period', async (t) => {
  const dash = await dashboard(t);
  const base = {
    id: 'u1', version: V2, commit: B, requested_by: 'admin@example.com', requested_at: NOW.toISOString(),
    vm_command_id: null, build_id: null, operation: null, error: null, updated_at: NOW.toISOString(),
  };
  for (const [state, why] of [['vm', /never reached the agent/], ['build', /build was never started/], ['deploy', /new revision was never asked for/]]) {
    await dash.seed({ [`config/${UPGRADE_DOC}`]: { ...base, state, vm_command_id: state === 'vm' ? null : 'cmd' } });
    assert.equal((await readUpgrade(dash.runtime, { user: admin, now: later(STEP_START_GRACE_SECONDS - 1) })).upgrade.state, state);
    const { upgrade } = await readUpgrade(dash.runtime, { user: admin, now: later(STEP_START_GRACE_SECONDS + 1) });
    assert.equal(upgrade.state, 'failed', state);
    assert.match(upgrade.error, why);
  }
  assert.equal(dash.cloud.calls.filter((c) => !c.url.startsWith('https://api.github.com/')).length, 0);
});

test('no upgrade yet reads as none', async (t) => {
  const dash = await dashboard(t);
  assert.deepEqual(await readUpgrade(dash.runtime, { user: member, now: NOW }), { upgrade: null });
  assert.equal(await dash.doc(`config/${RELEASE_CHECK_DOC}`), null, 'reading the upgrade asks GitHub nothing');
});

test('the new revision: the image and two variables change, the input stays as it was, and a missing variable is added', () => {
  const service = runService();
  service.template.containers[0].env = [{ name: 'PARACLETE_RELEASE', valueSource: { secretKeyRef: { secret: 's' } } }];
  const before = structuredClone(service);
  const next = rolloutService(service, { image: `${IMAGE}:${B}`, version: V2, commit: B });
  assert.deepEqual(service, before);
  assert.deepEqual(next.template.containers[0].env, [{ name: 'PARACLETE_RELEASE', value: V2 }, { name: 'PARACLETE_COMMIT', value: B }]);
  assert.equal(next.template.revision, undefined);
  assert.equal(next.iapEnabled, true);
  assert.throws(() => rolloutService({ template: {} }, { image: 'x', version: V2, commit: B }), /no container/);
});

test("the build: this repo's own build config is taken; one without steps, or not JSON, is not", () => {
  const config = parseBuildConfig(BUILD_CONFIG);
  assert.deepEqual(Object.keys(config).sort(), ['images', 'options', 'steps']);
  const request = buildRequest({ config, repo: 'your-org/paraclete', commit: B, image: IMAGE, project: PROJECT, account: ACCOUNT, timeoutSeconds: 1200 });
  assert.equal(request.timeout, '1200s');
  assert.throws(() => parseBuildConfig('steps: []'), /not JSON/);
  assert.throws(() => parseBuildConfig('{"steps": []}'), /names no build steps/);
  assert.throws(() => parseBuildConfig('{"steps": [{"name": "x"}], "images": "y"}'), /not a list/);
  assert.deepEqual(parseBuildConfig('{"steps": [{"name": "x"}], "timeout": "9s", "serviceAccount": "z"}'), { steps: [{ name: 'x' }] },
    'only the steps, images and options are taken from it');
});

test('a record with a state it does not know reads as failed', () => {
  const view = upgradeView({ id: 'u', version: V2, state: 'paused' }, { admin: false, settings: {} });
  assert.equal(view.state, 'failed');
  assert.match(view.error, /unknown state 'paused'/);
  assert.equal(upgradeView(null, { admin: true, settings: {} }), null);
});
