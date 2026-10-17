// Tests for dev/deploy.mjs: a ref resolves to a 40-character commit on GitHub (a branch, an annotated
// tag through its peeled commit, or a full commit as given), an unpushed branch is refused and a
// diverged local branch warned about, the upgrader runs over IAP with the exact gcloud arguments and
// its output streamed, and the deploy waits for agent/instance to report ready on that commit.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { main, githubRepoFromUrl, pickRemoteRef } from '../../dev/deploy.mjs';
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

/** The instance and GitHub as a script for the fake runner. */
function instance({ remote = `${MAIN}\trefs/heads/main\n`, local = MAIN, upgrade = { stdout: 'upgrade: fetching\nupgrade: done\n' }, onUpgrade } = {}) {
  return fakeExec(async (program, args) => {
    if (program === 'git' && args.includes('ls-remote')) return { stdout: remote };
    if (program === 'git' && args[0] === 'rev-parse') return local ? { stdout: `${local}\n` } : { code: 1 };
    if (program === 'gcloud' && args[0] === 'compute') {
      await onUpgrade?.(args);
      return upgrade;
    }
    return undefined;
  });
}

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
  ]);
  assert.equal(exec.callsTo('git')[1].opts.env.GIT_TERMINAL_PROMPT, '0', 'GitHub is read anonymously, as the VM reads it');
  const ssh = exec.callsTo('gcloud').filter((c) => c.args[0] === 'compute');
  assert.deepEqual(ssh.map((c) => c.args), [expectedSsh(upgradeCommand(MAIN))]);
  assertNoShell(exec.calls);

  assert.match(deps.stdout.text, /main on your-org\/paraclete is a{40} \(branch\)\./);
  assert.match(deps.stdout.text, /upgrade: fetching\nupgrade: done\n/, "the upgrader's output is streamed through");
  assert.match(deps.stdout.text, /Done: the VM runs a{40} from your-org\/paraclete \(release main\), ready at 2026-10-17T12:01:00\.000Z\./);
  assert.match(deps.stdout.text, /Only the VM moved: deploying the dashboard arrives with build plan phase 6\./);
  const reads = firestore.requests.slice(seeded).filter((r) => r.method === 'GET');
  assert.ok(reads.length > 0 && reads.every((r) => r.token === DEV_TOKEN), 'agent/instance is read as the developer');
  assert.equal(deps.stderr.text, '');
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
