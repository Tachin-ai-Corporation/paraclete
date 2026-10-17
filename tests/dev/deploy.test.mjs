// Tests for dev/deploy.mjs: a ref resolves to a 40-character commit on GitHub (a branch, an annotated
// tag through its peeled commit, or a full commit as given), an unpushed branch is refused and a
// diverged local branch warned about, the upgrader runs over IAP with the exact gcloud arguments and
// its output streamed, and the deploy waits for agent/instance to report ready on that commit. Then
// the dashboard: the commit's image is built with that commit's own build config unless it exists,
// and deployed with the service's environment moved to the commit unless the service runs it, with
// the same gcloud arguments install/install.sh uses; --vm-only and --dashboard-only move one half.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { main, githubRepoFromUrl, pickRemoteRef } from '../../dev/deploy.mjs';
import { buildArgs, deployArgs } from '../../install/lib/dashboard.mjs';
import { REPO_ROOT } from '../../dev/dev-env.mjs';
import { DEV_TOKEN, assertNoShell, devDeps, expectedSsh, fakeExec } from './fakes.mjs';

const MAIN = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);
const TAG_COMMIT = 'd'.repeat(40);
const LOCAL = 'e'.repeat(40);
const ORIGIN_URL = 'https://github.com/your-org/paraclete.git';

let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

const ready = (commit, over = {}) => db.write('agent/instance', {
  status: 'ready', release: 'main', commit, ready_at: '2026-10-17T12:01:00.000Z', ...over,
});

const PROJECT = 'your-gcp-project';
const IMAGE = `us-central1-docker.pkg.dev/${PROJECT}/paraclete/dashboard`;
const DASHBOARD = `paraclete-dashboard@${PROJECT}.iam.gserviceaccount.com`;
const DASHBOARD_URL = 'https://paraclete-123456789012.us-central1.run.app';
const CONFIG = "# the commit's own build config\nsteps: []\n";

/** The dashboard's environment as the installer set it, at a commit. */
const installedEnv = (commit, over = {}) => ({
  PARACLETE_PROJECT: PROJECT, PARACLETE_PROJECT_NUMBER: '123456789012', PARACLETE_REGION: 'us-central1',
  PARACLETE_SERVICE: 'paraclete', PARACLETE_BUCKET: `${PROJECT}-paraclete`, PARACLETE_REPO: 'your-org/paraclete',
  PARACLETE_RELEASE: 'v2026.10.16.1.1', PARACLETE_COMMIT: commit, PARACLETE_AGENT_NAME: "Ada O'Brien", PARACLETE_ROLE: 'generic', ...over,
});

/** The dashboard service as `gcloud run services describe --format=json` shows it, running a commit. */
function dashboardService(commit = OLD, env = installedEnv(commit)) {
  return {
    metadata: { name: 'paraclete', annotations: { 'run.googleapis.com/iap-enabled': 'true', 'run.googleapis.com/ingress': 'all' } },
    spec: {
      template: {
        metadata: { annotations: { 'autoscaling.knative.dev/maxScale': '3' } },
        spec: {
          serviceAccountName: DASHBOARD,
          containers: [{
            image: `${IMAGE}:${commit}`,
            env: Object.entries(env).map(([name, value]) => ({ name, value })),
            resources: { limits: { cpu: '1000m', memory: '1Gi' } },
          }],
        },
      },
    },
    status: { url: DASHBOARD_URL },
  };
}

/** The value of --name=value in an argument list. */
const flagOf = (args, name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** The env-vars file a deploy read, as an object. */
const envOf = (text) => Object.fromEntries(text.trimEnd().split('\n').map((line) => {
  const colon = line.indexOf(': ');
  return [line.slice(0, colon), JSON.parse(line.slice(colon + 2))];
}));

/**
 * The instance, its dashboard and GitHub as a script for the fake runner. `seen` collects the build
 * config and the environment each build and deploy read, while their files still exist.
 */
function instance({
  remote = `${MAIN}\trefs/heads/main\n`, local = MAIN, upgrade = { stdout: 'upgrade: fetching\nupgrade: done\n' }, onUpgrade,
  service = dashboardService(), tags = [OLD], show = { stdout: CONFIG }, build = { stdout: 'BUILD step 0: docker build\nDONE\n' },
  deploy = { stderr: 'Deploying container to Cloud Run service [paraclete]... Done.\n' },
} = {}) {
  const seen = { configs: [], envs: [], files: [] };
  const exec = fakeExec(async (program, args) => {
    if (program === 'git' && args.includes('ls-remote')) return { stdout: remote };
    if (program === 'git' && args[0] === 'rev-parse') return local ? { stdout: `${local}\n` } : { code: 1 };
    if (program === 'git' && args[0] === 'show') return show;
    if (program === 'gcloud' && args[0] === 'compute') {
      await onUpgrade?.(args);
      return upgrade;
    }
    const words = args.slice(0, 3).join(' ');
    if (words === 'run services describe') {
      return service ? { stdout: JSON.stringify(service) } : { code: 1, stderr: 'ERROR: (gcloud.run.services.describe) Cannot find service [paraclete]\n' };
    }
    if (words === 'artifacts docker tags') return { stdout: tags.map((tag) => `${tag}\n`).join('') };
    if (words.startsWith('builds submit')) {
      seen.files.push(flagOf(args, 'config'));
      seen.configs.push(readFileSync(flagOf(args, 'config'), 'utf8'));
      return build;
    }
    if (words === 'run deploy paraclete') {
      seen.files.push(flagOf(args, 'env-vars-file'));
      seen.envs.push(envOf(readFileSync(flagOf(args, 'env-vars-file'), 'utf8')));
      return deploy;
    }
    return undefined;
  });
  exec.seen = seen;
  return exec;
}

/** The dashboard's gcloud calls of a run, by their first words. */
const dashboardCalls = (exec) => exec.callsTo('gcloud')
  .filter((c) => ['run', 'artifacts', 'builds'].includes(c.args[0]))
  .map((c) => c.args.slice(0, c.args[0] === 'builds' ? 2 : 3).join(' '));

const upgradeCommand = (commit, repo = 'your-org/paraclete') => `sudo /opt/paraclete/install/upgrade.sh --ref ${commit} --repo ${repo}`;

test('a branch resolves on GitHub, the upgrader runs over IAP, and the deploy ends when agent/instance is ready on it', async () => {
  await ready(OLD);
  const exec = instance({ onUpgrade: () => ready(MAIN) });
  const deps = devDeps({ firestore, exec });
  const seeded = firestore.requests.length;
  assert.equal(await main(['main'], deps), 0, deps.stderr.text);

  assert.deepEqual(exec.callsTo('git').map((c) => c.args), [
    ['remote', 'get-url', 'origin'],
    ['-c', 'credential.helper=', 'ls-remote', ORIGIN_URL, 'refs/heads/main', 'refs/tags/main', 'refs/tags/main^{}'],
    ['rev-parse', '--verify', '--quiet', 'refs/heads/main'],
    ['show', `${MAIN}:dashboard/cloudbuild.yaml`],
  ]);
  assert.equal(exec.callsTo('git')[1].opts.env.GIT_TERMINAL_PROMPT, '0', 'GitHub is read anonymously, as the VM reads it');
  const ssh = exec.callsTo('gcloud').filter((c) => c.args[0] === 'compute');
  assert.deepEqual(ssh.map((c) => c.args), [expectedSsh(upgradeCommand(MAIN))]);
  assertNoShell(exec.calls);

  assert.match(deps.stdout.text, /main on your-org\/paraclete is a{40} \(branch\)\./);
  assert.match(deps.stdout.text, /upgrade: fetching\nupgrade: done\n/, "the upgrader's output is streamed through");
  assert.match(deps.stdout.text, /Done: the VM runs a{40} from your-org\/paraclete \(release main\), ready at 2026-10-17T12:01:00\.000Z\./);
  assert.match(deps.stdout.text, /Done: the dashboard runs a{40} from your-org\/paraclete, at https:\/\/paraclete-123456789012\.us-central1\.run\.app\./);
  const reads = firestore.requests.slice(seeded).filter((r) => r.method === 'GET');
  assert.ok(reads.length > 0 && reads.every((r) => r.token === DEV_TOKEN), 'agent/instance is read as the developer');
  assert.equal(deps.stderr.text, 'Deploying container to Cloud Run service [paraclete]... Done.\n', "only Cloud Run's own progress");
});

test('after the VM is ready, the dashboard is built at the commit with its own config and deployed as the installer does', async () => {
  await ready(OLD);
  const exec = instance({ onUpgrade: () => ready(MAIN) });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['main'], deps), 0, deps.stderr.text);

  const gcloud = exec.callsTo('gcloud').filter((c) => c.args[0] !== 'auth');
  assert.deepEqual(gcloud.map((c) => c.args.slice(0, 2).join(' ')),
    ['compute ssh', 'run services', 'artifacts docker', 'builds submit', 'run deploy'], 'the VM first, then the dashboard');
  const [, describe, tags, build, deploy] = gcloud.map((c) => c.args);
  assert.deepEqual(describe, ['run', 'services', 'describe', 'paraclete', '--region=us-central1', `--project=${PROJECT}`, '--format=json']);
  assert.deepEqual(tags, ['artifacts', 'docker', 'tags', 'list', IMAGE, `--project=${PROJECT}`, '--format=value(tag.basename())']);
  assert.deepEqual(build, buildArgs({ repo: 'your-org/paraclete', commit: MAIN, configFile: flagOf(build, 'config'), project: PROJECT, region: 'us-central1' }));
  assert.equal(flagOf(build, 'service-account'), `projects/${PROJECT}/serviceAccounts/${DASHBOARD}`);
  assert.equal(flagOf(build, 'substitutions'), `_IMAGE=${IMAGE},_COMMIT=${MAIN}`);
  assert.deepEqual(deploy, deployArgs({ project: PROJECT, region: 'us-central1', commit: MAIN, envFile: flagOf(deploy, 'env-vars-file') }));
  assert.ok(deploy.includes('--iap') && deploy.includes('--no-allow-unauthenticated'));

  assert.deepEqual(exec.seen.configs, [CONFIG], "the commit's own cloudbuild.yaml, from git show");
  assert.deepEqual(exec.seen.envs, [installedEnv(MAIN, { PARACLETE_RELEASE: 'main' })], 'only the commit, release and repo move');
  assert.ok(exec.seen.files.every((file) => !existsSync(file)), 'the temporary files are gone');
  assert.match(deps.stdout.text, /BUILD step 0: docker build\nDONE\n/, "the build's output is streamed through");
  assert.match(deps.stdout.text, /Deploying the dashboard at aaaaaaaaaaaa \(changing: image, environment\)/);
});

test('an image that exists is not built again, and a dashboard on the commit is not deployed again', async () => {
  await ready(OLD);
  const exec = instance({
    onUpgrade: () => ready(MAIN), tags: [OLD, MAIN],
    service: dashboardService(MAIN, installedEnv(MAIN, { PARACLETE_RELEASE: 'main' })),
  });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['main'], deps), 0, deps.stderr.text);
  assert.deepEqual(dashboardCalls(exec), ['run services describe', 'artifacts docker tags']);
  assert.match(deps.stdout.text, /The dashboard's image for aaaaaaaaaaaa exists; not building it again\./);
  assert.match(deps.stdout.text, /The dashboard already runs aaaaaaaaaaaa\./);
  assert.equal(exec.callsTo('git').some((c) => c.args[0] === 'show'), false);
});

test('--vm-only moves the VM alone, --dashboard-only the dashboard alone, and not both', async () => {
  await ready(OLD);
  let exec = instance({ onUpgrade: () => ready(MAIN) });
  let deps = devDeps({ firestore, exec });
  assert.equal(await main(['main', '--vm-only'], deps), 0, deps.stderr.text);
  assert.deepEqual(dashboardCalls(exec), []);
  assert.match(deps.stdout.text, /The dashboard stays as it is \(--vm-only\)/);

  exec = instance();
  deps = devDeps({ firestore, exec });
  assert.equal(await main(['main', '--dashboard-only'], deps), 0, deps.stderr.text);
  assert.equal(exec.calls.some((c) => c.args[0] === 'compute'), false, 'nothing runs on the VM');
  assert.deepEqual(dashboardCalls(exec), ['run services describe', 'artifacts docker tags', 'builds submit', 'run deploy paraclete']);
  assert.match(deps.stdout.text, /The VM stays as it is \(--dashboard-only\)/);

  deps = devDeps({ firestore, exec: instance() });
  assert.equal(await main(['main', '--vm-only', '--dashboard-only'], deps), 2);
  assert.match(deps.stderr.text, /--vm-only and --dashboard-only exclude each other/);
});

test('a dev instance without a dashboard is told to install one', async () => {
  const deps = devDeps({ firestore, exec: instance({ service: null }) });
  assert.equal(await main(['main', '--dashboard-only'], deps), 1);
  assert.match(deps.stderr.text, /your-gcp-project has no dashboard service paraclete in us-central1\. Install it once with install\/install\.sh --ref <branch>/);
});

test('a failed build or deploy stops with the reason, and a failed build deploys nothing', async () => {
  let exec = instance({ build: { code: 1, stdout: 'ERROR: build step 0 failed\n' } });
  let deps = devDeps({ firestore, exec });
  assert.equal(await main(['main', '--dashboard-only'], deps), 1);
  assert.match(deps.stderr.text, /the dashboard's build exited with code 1; read its output above\. The dashboard still runs b{40}\./);
  assert.ok(!dashboardCalls(exec).includes('run deploy paraclete'));

  exec = instance({ deploy: { code: 1, stderr: 'ERROR: revision failed to start\n' } });
  deps = devDeps({ firestore, exec });
  assert.equal(await main(['main', '--dashboard-only'], deps), 1);
  assert.match(deps.stderr.text, /the dashboard's deploy exited with code 1; read its output above\. It still runs b{40}/);
});

test("a commit this clone lacks builds with the working tree's config; one from before the dashboard is refused", async () => {
  let exec = instance({ show: { code: 128, stderr: `fatal: invalid object name '${MAIN}'.\n` } });
  let deps = devDeps({ firestore, exec });
  assert.equal(await main(['main', '--dashboard-only'], deps), 0, deps.stderr.text);
  assert.match(deps.stderr.text, /warning: this clone does not have aaaaaaaaaaaa \(git fetch gets it\); building with the working tree's dashboard\/cloudbuild\.yaml/);
  assert.deepEqual(exec.seen.configs, [readFileSync(join(REPO_ROOT, 'dashboard', 'cloudbuild.yaml'), 'utf8')]);

  exec = instance({ show: { code: 128, stderr: `fatal: path 'dashboard/cloudbuild.yaml' does not exist in '${MAIN}'\n` } });
  deps = devDeps({ firestore, exec });
  assert.equal(await main(['main', '--dashboard-only'], deps), 1);
  assert.match(deps.stderr.text, /a{40} has no dashboard\/cloudbuild\.yaml: it predates the dashboard\. Deploy it with --vm-only\./);
  assert.deepEqual(dashboardCalls(exec), ['run services describe', 'artifacts docker tags']);
});

test('the wait polls agent/instance until it reports the new commit', async () => {
  await ready(OLD);
  const exec = instance();
  const deps = devDeps({ firestore, exec, onSleep: async (n) => { if (n === 1) await ready(MAIN, { status: 'starting' }); if (n === 3) await ready(MAIN); } });
  assert.equal(await main(['main'], deps), 0, deps.stderr.text);
  assert.match(deps.stdout.text, /agent\/instance: ready on bbbbbbbbbbbb\nagent\/instance: starting on aaaaaaaaaaaa\nagent\/instance: ready on aaaaaaaaaaaa\n/);
});

test('an annotated tag deploys the commit it points at', async () => {
  const exec = instance({ remote: `${TAG_OBJECT}\trefs/tags/v2026.10.17.1.1\n${TAG_COMMIT}\trefs/tags/v2026.10.17.1.1^{}\n`, onUpgrade: () => ready(TAG_COMMIT) });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['v2026.10.17.1.1'], deps), 0, deps.stderr.text);
  assert.match(deps.stdout.text, /is d{40} \(tag\)/);
  assert.equal(exec.callsTo('git').filter((c) => c.args[0] === 'rev-parse').length, 0, 'a tag has no local branch to compare');
  assert.deepEqual(exec.calls.find((c) => c.args[0] === 'compute').args, expectedSsh(upgradeCommand(TAG_COMMIT)));
});

test('a full commit is deployed as given, without asking GitHub', async () => {
  const exec = instance({ onUpgrade: () => ready(MAIN) });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main([MAIN.toUpperCase()], deps), 0, deps.stderr.text);
  assert.equal(exec.calls.some((c) => c.args.includes('ls-remote')), false);
  assert.deepEqual(exec.calls.find((c) => c.args[0] === 'compute').args, expectedSsh(upgradeCommand(MAIN)));
});

test('a branch that is not on GitHub is refused before anything runs on the VM', async () => {
  const exec = instance({ remote: '' });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['feature-x'], deps), 1);
  assert.match(deps.stderr.text, /'feature-x' is not a branch or tag on your-org\/paraclete\. Push it first: git push -u origin feature-x/);
  assert.equal(exec.calls.some((c) => c.args[0] === 'compute'), false);
});

test('a local branch ahead of GitHub is warned about, and GitHub\'s commit is deployed', async () => {
  const exec = instance({ local: LOCAL, onUpgrade: () => ready(MAIN) });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['main'], deps), 0);
  assert.match(deps.stderr.text, /warning: your local main is at eeeeeeeeeeee, but GitHub has aaaaaaaaaaaa\. Deploying what GitHub has/);
  assert.deepEqual(exec.calls.find((c) => c.args[0] === 'compute').args, expectedSsh(upgradeCommand(MAIN)));
});

test('--repo deploys from a fork, checked against the fork and passed to the upgrader', async () => {
  const exec = instance({ onUpgrade: () => ready(MAIN) });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['main', '--repo', 'someone/paraclete'], deps), 0, deps.stderr.text);
  assert.ok(exec.calls.some((c) => c.args.includes('https://github.com/someone/paraclete.git')));
  assert.equal(exec.calls.some((c) => c.args[0] === 'rev-parse'), false, 'your local branch tracks origin, not the fork');
  assert.deepEqual(exec.calls.find((c) => c.args[0] === 'compute').args, expectedSsh(upgradeCommand(MAIN, 'someone/paraclete')));
});

test('short commits, odd refs, ambiguous names and a non-GitHub origin are refused', async () => {
  const run = async (argv, exec = instance({ remote: '' })) => {
    const deps = devDeps({ firestore, exec });
    return { code: await main(argv, deps), err: deps.stderr.text, exec };
  };
  let r = await run(['abc1234']);
  assert.equal(r.code, 2);
  assert.match(r.err, /looks like a short commit id: pass the full 40-character id/);

  r = await run(['--upload-pack=touch']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown option/);
  r = await run(['main..evil']);
  assert.match(r.err, /is not a branch, tag or commit name/);
  assert.equal(r.exec.calls.some((c) => c.args.includes('ls-remote')), false);

  r = await run(['main'], instance({ remote: `${MAIN}\trefs/heads/main\n${TAG_COMMIT}\trefs/tags/main\n` }));
  assert.match(r.err, /'main' is both a branch and a tag; pass refs\/heads\/main or refs\/tags\/main/);

  r = await run(['main'], fakeExec((program, args) => (args[0] === 'remote' ? { stdout: 'https://gitlab.example.com/a/b.git\n' } : undefined)));
  assert.equal(r.code, 2);
  assert.match(r.err, /origin is not a GitHub repository; pass --repo <owner>\/<name>/);
  r = await run(['main', '--repo', 'not a repo']);
  assert.match(r.err, /--repo must be <owner>\/<name> on GitHub/);
  r = await run([]);
  assert.match(r.err, /Name the branch, tag or commit to deploy/);
});

test('a failed upgrade stops the deploy without waiting', async () => {
  await ready(OLD);
  const exec = instance({ upgrade: { code: 1, stdout: 'upgrade: npm ci failed\n' } });
  const deps = devDeps({ firestore, exec });
  assert.equal(await main(['main'], deps), 1);
  assert.match(deps.stdout.text, /upgrade: npm ci failed/);
  assert.match(deps.stderr.text, /the upgrade exited with code 1\. The VM may still run its previous commit/);
  assert.doesNotMatch(deps.stdout.text, /Waiting up to/);
});

test('readiness that never comes, or a failure on the new commit, ends the deploy with an error', async () => {
  await ready(OLD);
  let deps = devDeps({ firestore, exec: instance() });
  assert.equal(await main(['main', '--timeout', '30'], deps), 1);
  assert.match(deps.stderr.text, /agent\/instance did not report ready on a{40} within 30 s/);

  deps = devDeps({ firestore, exec: instance({ onUpgrade: () => ready(MAIN, { status: 'failed', error: 'the gateway did not start' }) }) });
  assert.equal(await main(['main'], deps), 1);
  assert.match(deps.stderr.text, /agent\/instance reports failed: the gateway did not start/);
});

test('GitHub repositories are read from every remote URL form', () => {
  for (const url of [ORIGIN_URL, 'https://github.com/your-org/paraclete', 'https://github.com/your-org/paraclete.git/',
    'git@github.com:your-org/paraclete.git', 'ssh://git@github.com/your-org/paraclete.git']) {
    assert.equal(githubRepoFromUrl(url), 'your-org/paraclete', url);
  }
  assert.equal(githubRepoFromUrl('https://gitlab.example.com/your-org/paraclete.git'), null);
});

test('a full ref name picks exactly that ref', () => {
  const out = `${MAIN}\trefs/heads/v1\n${TAG_COMMIT}\trefs/tags/v1\n`;
  assert.deepEqual(pickRemoteRef(out, 'refs/tags/v1'), { commit: TAG_COMMIT, kind: 'tag', name: 'v1' });
  assert.deepEqual(pickRemoteRef(out, 'refs/heads/v1'), { commit: MAIN, kind: 'branch', name: 'v1' });
  assert.equal(pickRemoteRef(out, 'v2'), null);
});
