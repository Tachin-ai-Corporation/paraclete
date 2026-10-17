// Tests for agent/cli/git-store.mjs: arguments reach the right store call, configuration comes from
// the contracts and the instance record, and a real push and merge run end to end through the
// command against an in-memory bucket and Firestore.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { main, gitStoreFromRuntime } from '../../../agent/cli/git-store.mjs';
import { commitFile, git, initWorkingTree, isolatedGit, memoryStore } from '../storage/git-fixtures.mjs';
import { fakeRuntime, run } from './fakes.mjs';

/** A store that records each call and answers with a canned result. */
function recordingStore(results = {}) {
  const calls = [];
  const store = { defaultBranch: 'main' };
  for (const fn of ['ensureRepo', 'cloneRepo', 'fetchBranch', 'pushWithRetry', 'mergeBranch', 'gc', 'buildManifest', 'readRef', 'listRefs']) {
    store[fn] = async (...args) => {
      calls.push([fn, ...args]);
      if (results[fn] instanceof Error) throw results[fn];
      return fn in results ? results[fn] : { ok: fn };
    };
  }
  return { store, calls };
}

const runtime = fakeRuntime();

describe('arguments', () => {
  test('--help and no command print the usage; an unknown command lists the commands', async () => {
    for (const argv of [['--help'], []]) {
      const r = await run(main, argv);
      assert.equal(r.code, 0);
      assert.match(r.out, /^Usage: git-store <command>/);
      assert.match(r.out, /merge <repoId> <source> \[target\] \[policy\] \[actor\]/);
    }
    const r = await run(main, ['frobnicate'], { runtime });
    assert.equal(r.code, 1);
    assert.match(r.err, /\[git-store\] Unknown command: frobnicate\n\[git-store\] Available: ensure, clone, fetch, push, merge, gc, manifest, read-ref, list-refs/);
  });

  test('each command calls its store function with the defaults filled in, and prints JSON', async () => {
    const { store, calls } = recordingStore({ readRef: null });
    const deps = { runtime, gitStore: store };
    const cases = [
      [['ensure', 'site'], ['ensureRepo', 'site', { mergePolicy: 'auto' }]],
      [['ensure', 'site', '--merge-policy', 'gated'], ['ensureRepo', 'site', { mergePolicy: 'gated' }]],
      [['fetch', 'site'], ['fetchBranch', 'site', 'main', '.']],
      [['push', 'site', 'mission-1', '/tmp/w'], ['pushWithRetry', 'site', 'mission-1', '/tmp/w', 'Paraclete']],
      [['push', 'site', 'main', '.', 'motor'], ['pushWithRetry', 'site', 'main', '.', 'motor']],
      [['merge', 'site', 'mission-1'], ['mergeBranch', 'site', 'mission-1', 'main', 'auto', 'Paraclete']],
      [['gc', 'site'], ['gc', 'site', 'main']],
      [['manifest', 'site', 'main', 'a.md', 'b.md'], ['buildManifest', 'site', 'main', ['a.md', 'b.md']]],
      [['list-refs', 'site'], ['listRefs', 'site']],
    ];
    for (const [argv, expected] of cases) {
      calls.length = 0;
      const r = await run(main, argv, deps);
      assert.equal(r.code, 0, `${argv.join(' ')}: ${r.err}`);
      assert.deepEqual(calls[0], expected, argv.join(' '));
      assert.deepEqual(JSON.parse(r.out), { ok: expected[0] });
    }
    const ref = await run(main, ['read-ref', 'site'], deps);
    assert.deepEqual(JSON.parse(ref.out), { sha: null, bundle_keys: [] }, 'a missing ref reads as an empty one');
  });

  test('clone takes --ref and --dir in any order, and a bare --ref never becomes the directory', async () => {
    const { store, calls } = recordingStore();
    const deps = { runtime, gitStore: store };
    const cases = [
      [['clone', 'site'], ['site', 'main', './site']],
      [['clone', 'site', '--dir', '/w/site'], ['site', 'main', '/w/site']],
      [['clone', 'site', '--ref', 'feature'], ['site', 'feature', './site']],
      [['clone', 'site', '--dir', '/w', '--ref', 'feature'], ['site', 'feature', '/w']],
      [['clone', 'site', 'feature', '/w'], ['site', 'feature', '/w']],
    ];
    for (const [argv, expected] of cases) {
      calls.length = 0;
      assert.equal((await run(main, argv, deps)).code, 0);
      assert.deepEqual(calls[0], ['cloneRepo', ...expected], argv.join(' '));
    }
  });

  test('a missing argument or a store error prints [git-store] ERROR and exits 1', async () => {
    const { store } = recordingStore({ pushWithRetry: new Error('BUNDLE_MISSING: git/site/bundles/x.bundle') });
    const deps = { runtime, gitStore: store };
    let r = await run(main, ['merge', 'site'], deps);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[git-store\] ERROR: Usage: merge <repoId> <source>/);
    r = await run(main, ['ensure', 'site', '--merge-policy', 'sometimes'], deps);
    assert.match(r.err, /--merge-policy must be auto or gated/);
    r = await run(main, ['push', 'site'], deps);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[git-store\] ERROR: BUNDLE_MISSING/);
    assert.equal(r.out, '', 'stdout stays clean for a caller that parses it');
  });
});

describe('configuration', () => {
  test('the bucket and project come from the instance, the prefix and default branch from the contracts', async () => {
    const backend = memoryStore();
    const store = gitStoreFromRuntime(runtime, { store: backend, logger: () => {} });
    assert.equal(store.defaultBranch, runtime.contracts.git.default_branch);
    const repo = await store.ensureRepo('site');
    assert.equal(repo.default_branch, 'main');
    assert.ok(backend.docs.has('git_repos/site'), 'refs live in the root git_repos collection');
  });

  test('the default store talks to the instance endpoints with the runtime token', async () => {
    const calls = [];
    const wired = {
      ...runtime,
      firestoreHost: 'http://127.0.0.1:8085',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      },
    };
    const r = await run(main, ['read-ref', 'site', 'mission/m1'], { runtime: wired });
    assert.equal(r.code, 0, r.err);
    assert.equal(calls[0].url, 'http://127.0.0.1:8085/v1/projects/your-gcp-project/databases/(default)/documents/git_repos/site/refs/mission__m1');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  });
});

describe('end to end', () => {
  const env = isolatedGit('git-store-cli');
  after(() => env.cleanup());

  test('push and merge through the command; the merge commit is signed by the agent', async () => {
    const backend = memoryStore();
    const identityRuntime = fakeRuntime({ instance: { workspace: { account: 'agent@example.com', signer: 'x@example.com' } } });
    const deps = { runtime: identityRuntime, gitStore: gitStoreFromRuntime(identityRuntime, { store: backend, logger: () => {} }) };

    const main1 = initWorkingTree(env.newDir('main'));
    assert.equal((await run(main, ['push', 'site', 'main', main1], deps)).code, 0);
    const mission = env.newDir('mission');
    assert.equal((await run(main, ['clone', 'site', '--dir', mission], deps)).code, 0);
    git(['checkout', '-b', 'mission-1'], mission);
    commitFile(mission, 'report.md', '# Report\n', 'mission work');
    const pushed = await run(main, ['push', 'site', 'mission-1', mission], deps);
    assert.equal(JSON.parse(pushed.out).status, 'pushed');
    assert.ok([...backend.objects.keys()].every((k) => k.startsWith('your-gcp-project-paraclete/git/site/bundles/')),
      'bundles go to the instance bucket under the contracts prefix');
    commitFile(main1, 'notes.md', 'main moved on\n', 'main work');
    assert.equal(JSON.parse((await run(main, ['push', 'site', 'main', main1], deps)).out).status, 'pushed');

    const merged = await run(main, ['merge', 'site', 'mission-1'], deps);
    assert.equal(JSON.parse(merged.out).status, 'merged', merged.err);
    const verify = join(env.newDir('verify'), 'site');
    await run(main, ['clone', 'site', '--dir', verify], deps);
    assert.equal(git(['log', '-1', '--format=%an <%ae>'], verify), 'Paraclete <agent@example.com>');
  });
});
