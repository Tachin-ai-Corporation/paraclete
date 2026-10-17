// Tests for agent/storage/git-store.mjs. Runs the real git binary against an in-memory store that
// stands in for Cloud Storage (bundles) and Firestore (refs, with compare-and-swap).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allocateVersion,
  createGitStore,
  createRemoteStore,
  sanitizeRepoId,
} from '../../../agent/storage/git-store.mjs';
import {
  commitFile,
  git,
  initWorkingTree,
  isolatedGit,
  memoryStore,
  TEST_AUTHOR as AUTHOR,
  TEST_CONFIG as CONFIG,
} from './git-fixtures.mjs';

const env = isolatedGit('git-store-test');
after(() => env.cleanup());
const { scratch, newDir } = env;

const workingTree = (label) => initWorkingTree(newDir(label));

function newStore(overrides = {}) {
  const store = memoryStore();
  const gitStore = createGitStore({ config: CONFIG, store, author: AUTHOR, logger: () => {}, ...overrides });
  return { store, gitStore };
}

function firestoreField(store, path, field) {
  return store.docs.get(path)?.fields?.[field]?.stringValue;
}

describe('round trip', () => {
  const { store, gitStore } = newStore();
  const repoId = 'roundtrip';

  test('ensureRepo creates the repo document once and is idempotent', async () => {
    const repo = await gitStore.ensureRepo(repoId, { mergePolicy: 'auto' });
    assert.equal(repo.id, repoId);
    assert.equal(repo.default_branch, 'main');
    assert.equal(repo.merge_policy, 'auto');
    assert.ok(store.docs.has('repos-under-test/roundtrip'));
    const again = await gitStore.ensureRepo(repoId, { mergePolicy: 'gated' });
    assert.equal(again.merge_policy, 'auto', 'the stored policy wins over a later call');
    assert.equal(again.created_at, repo.created_at);
  });

  test('push, read the ref, clone, and get identical content', async () => {
    const source = workingTree('rt-source');
    writeFileSync(join(source, 'README.md'), '# Test Repo\nHello World\n');
    writeFileSync(join(source, 'data.json'), JSON.stringify({ key: 'value', nested: { a: 1 } }));
    git(['add', '-A'], source);
    git(['commit', '-m', 'v2026.07.04.1.0: initial commit'], source);
    const sha = git(['rev-parse', 'HEAD'], source);

    const push = await gitStore.pushBranch(repoId, 'main', source, 'agent');
    assert.deepEqual(push, { status: 'pushed', sha });

    const ref = await gitStore.readRef(repoId, 'main');
    assert.equal(ref.sha, sha);
    assert.equal(ref.bundle_keys.length, 1);
    assert.ok(store.objects.has(`test-bucket/git/${repoId}/bundles/${ref.bundle_keys[0]}.bundle`), 'bundle stored under the prefix');
    assert.equal(firestoreField(store, `repos-under-test/${repoId}/refs-under-test/main`, 'updated_by'), 'agent');

    const clone = newDir('rt-clone');
    const cloned = await gitStore.cloneRepo(repoId, 'main', clone);
    assert.equal(cloned.sha, sha);
    assert.equal(git(['rev-parse', 'HEAD'], clone), sha);
    assert.equal(readFileSync(join(clone, 'README.md'), 'utf8'), readFileSync(join(source, 'README.md'), 'utf8'));
    assert.equal(readFileSync(join(clone, 'data.json'), 'utf8'), readFileSync(join(source, 'data.json'), 'utf8'));

    assert.equal((await gitStore.pushBranch(repoId, 'main', source, 'agent')).status, 'up_to_date');
  });

  test('listRefs lists branches, decoding the separator', async () => {
    const dir = newDir('rt-branch');
    await gitStore.cloneRepo(repoId, 'main', dir);
    git(['checkout', '-b', 'mission/w-1'], dir);
    commitFile(dir, 'out.md', 'output', 'mission work');
    await gitStore.pushBranch(repoId, 'mission/w-1', dir, 'agent');
    const refs = await gitStore.listRefs(repoId);
    assert.deepEqual(refs.map((r) => r.branch).sort(), ['main', 'mission/w-1']);
    assert.ok(refs.every((r) => /^[0-9a-f]{40}$/.test(r.sha)));
  });
});

describe('concurrent pushes', () => {
  test('a push from a stale clone is NON_FAST_FORWARD; pushWithRetry rebases and keeps both commits', async () => {
    const { gitStore } = newStore();
    const repoId = 'push-race';
    await gitStore.ensureRepo(repoId);
    const dirA = workingTree('race-a');
    commitFile(dirA, 'file.txt', 'initial', 'v2026.07.04.1.0: init');
    assert.equal((await gitStore.pushBranch(repoId, 'main', dirA, 'a')).status, 'pushed');

    const dirB = newDir('race-b');
    await gitStore.cloneRepo(repoId, 'main', dirB);

    commitFile(dirA, 'file.txt', 'updated by A', 'v2026.07.04.2.0: update by A');
    assert.equal((await gitStore.pushBranch(repoId, 'main', dirA, 'a')).status, 'pushed');

    commitFile(dirB, 'other.txt', 'added by B', 'v2026.07.04.3.0: add by B');
    assert.equal((await gitStore.pushBranch(repoId, 'main', dirB, 'b')).status, 'NON_FAST_FORWARD');

    const retry = await gitStore.pushWithRetry(repoId, 'main', dirB, 'b');
    assert.equal(retry.status, 'pushed');
    assert.ok(retry.attempts >= 2, `took ${retry.attempts} attempts`);
    assert.equal((await gitStore.readRef(repoId, 'main')).sha, git(['rev-parse', 'HEAD'], dirB));

    const verify = newDir('race-verify');
    await gitStore.cloneRepo(repoId, 'main', verify);
    assert.equal(readFileSync(join(verify, 'file.txt'), 'utf8'), 'updated by A');
    assert.equal(readFileSync(join(verify, 'other.txt'), 'utf8'), 'added by B');
  });

  test("the loser's commit survives a race (the fetch never moves the checked-out branch)", async () => {
    const { gitStore } = newStore();
    const repoId = 'loser-survives';
    await gitStore.ensureRepo(repoId);
    const dirA = workingTree('loser-a');
    commitFile(dirA, 'shared.txt', 'initial content', 'v1.0.0: initial');
    await gitStore.pushBranch(repoId, 'main', dirA, 'a');
    const dirB = newDir('loser-b');
    await gitStore.cloneRepo(repoId, 'main', dirB);

    commitFile(dirA, 'file-a.txt', 'A data', 'v1.0.1: A work');
    assert.equal((await gitStore.pushBranch(repoId, 'main', dirA, 'a')).status, 'pushed');
    commitFile(dirB, 'file-b.txt', 'B data', 'v1.0.2: B work');
    assert.equal((await gitStore.pushWithRetry(repoId, 'main', dirB, 'b')).status, 'pushed');

    assert.ok(existsSync(join(dirB, 'file-a.txt')));
    assert.ok(existsSync(join(dirB, 'file-b.txt')));
    const verify = newDir('loser-verify');
    await gitStore.cloneRepo(repoId, 'main', verify);
    assert.equal(readFileSync(join(verify, 'file-a.txt'), 'utf8'), 'A data');
    assert.equal(readFileSync(join(verify, 'file-b.txt'), 'utf8'), 'B data');
  });

  test('push bundles HEAD, the commit the ref names, even with no local branch of that name', async () => {
    // The first push used to bundle the local branch named like the target while recording HEAD as
    // the ref. With HEAD elsewhere, the ref named a commit no bundle contained.
    const { gitStore } = newStore();
    const repoId = 'push-head';
    const dir = workingTree('push-head');
    git(['branch', 'older'], dir);
    commitFile(dir, 'new.txt', 'on main only', 'main moves on');
    assert.equal((await gitStore.pushBranch(repoId, 'older', dir, 'agent')).status, 'pushed');
    const clone = newDir('push-head-clone');
    await gitStore.cloneRepo(repoId, 'older', clone);
    assert.equal(readFileSync(join(clone, 'new.txt'), 'utf8'), 'on main only');
  });
});

describe('merge, gc and manifest', () => {
  const { store, gitStore } = newStore();
  const repoId = 'merge-gc';

  before(async () => {
    await gitStore.ensureRepo(repoId, { mergePolicy: 'auto' });
    const main = workingTree('mg-main');
    commitFile(main, 'base.md', '# Base\n', 'v2026.07.04.1.0: base');
    await gitStore.pushBranch(repoId, 'main', main, 'agent');
  });

  test('two missions merge into main and both file sets land', async () => {
    for (const n of [1, 2]) {
      const dir = newDir(`mission-${n}`);
      await gitStore.cloneRepo(repoId, 'main', dir);
      git(['checkout', '-b', `mission/m${n}`], dir);
      commitFile(dir, `mission${n}.txt`, `mission ${n} output`, `v1.0.${n}: mission ${n}`);
      await gitStore.pushBranch(repoId, `mission/m${n}`, dir, 'agent');
    }
    assert.equal((await gitStore.mergeBranch(repoId, 'mission/m1', 'main', 'auto', 'agent')).status, 'merged');
    const second = await gitStore.mergeBranch(repoId, 'mission/m2', 'main', 'auto', 'agent');
    assert.equal(second.status, 'merged');
    assert.equal((await gitStore.readRef(repoId, 'main')).sha, second.sha);

    const verify = newDir('merge-verify');
    await gitStore.cloneRepo(repoId, 'main', verify);
    for (const name of ['base.md', 'mission1.txt', 'mission2.txt']) assert.ok(existsSync(join(verify, name)), name);
    assert.equal(readFileSync(join(verify, 'mission2.txt'), 'utf8'), 'mission 2 output');
    const mergeAuthor = git(['log', '-1', '--format=%an <%ae>'], verify);
    assert.equal(mergeAuthor, 'paraclete <agent@example.com>', 'the merge commit carries the configured author');
  });

  test('a gated policy returns AWAITING_APPROVAL and merges nothing', async () => {
    const before = await gitStore.readRef(repoId, 'main');
    const result = await gitStore.mergeBranch(repoId, 'mission/m1', 'main', 'gated', 'agent');
    assert.deepEqual(result, { status: 'AWAITING_APPROVAL', sha: null });
    assert.equal((await gitStore.readRef(repoId, 'main')).sha, before.sha);
  });

  test('a conflicting merge fails and names the conflicting files', async () => {
    for (const [branch, text] of [['mission/c1', 'one'], ['mission/c2', 'two']]) {
      const dir = newDir('conflict');
      await gitStore.cloneRepo(repoId, 'main', dir);
      git(['checkout', '-b', branch], dir);
      commitFile(dir, 'base.md', `# ${text}\n`, `edit base to ${text}`);
      await gitStore.pushBranch(repoId, branch, dir, 'agent');
    }
    assert.equal((await gitStore.mergeBranch(repoId, 'mission/c1', 'main', 'auto', 'agent')).status, 'merged');
    const conflicted = await gitStore.mergeBranch(repoId, 'mission/c2', 'main', 'auto', 'agent');
    assert.equal(conflicted.status, 'failed');
    assert.equal(conflicted.reason, 'conflict');
    assert.deepEqual(conflicted.conflicts, ['base.md']);
  });

  test('gc consolidates the chain to one bundle, keeps the tip, and deletes the old bundles', async () => {
    const before = await gitStore.readRef(repoId, 'main');
    assert.ok(before.bundle_keys.length > 1);
    const result = await gitStore.gc(repoId, 'main');
    assert.equal(result.sha, before.sha);
    assert.equal(result.bundle_keys.length, 1);
    for (const key of before.bundle_keys) {
      assert.equal(store.objects.has(`test-bucket/git/${repoId}/bundles/${key}.bundle`), false, 'old bundle deleted');
    }
    assert.equal(firestoreField(store, `repos-under-test/${repoId}/refs-under-test/main`, 'updated_by'), 'gc');

    const verify = newDir('gc-verify');
    await gitStore.cloneRepo(repoId, 'main', verify);
    for (const name of ['base.md', 'mission1.txt', 'mission2.txt']) assert.ok(existsSync(join(verify, name)), name);
    assert.deepEqual(await gitStore.gc(repoId, 'main'), result, 'a single bundle is left alone');
  });

  test('buildManifest lists blob shas and sizes at the tip', async () => {
    const manifest = await gitStore.buildManifest(repoId, 'main', []);
    assert.equal(manifest.kind, 'artifact_manifest');
    assert.equal(manifest.repo, repoId);
    assert.equal(manifest.branch, 'main');
    assert.match(manifest.commit, /^[0-9a-f]{40}$/);
    const paths = manifest.files.map((f) => f.path);
    for (const name of ['base.md', 'mission1.txt', 'mission2.txt']) assert.ok(paths.includes(name), name);
    const mission1 = manifest.files.find((f) => f.path === 'mission1.txt');
    assert.match(mission1.blob_sha, /^[0-9a-f]{40}$/);
    assert.equal(mission1.size, 'mission 1 output'.length);
  });

  test('buildManifest takes only the paths it is given, and none outside the clone', async () => {
    const manifest = await gitStore.buildManifest(repoId, 'main', ['mission1.txt', '../escape.txt', 'missing.txt'], { summary: 'two missions' });
    assert.deepEqual(manifest.files.map((f) => f.path), ['mission1.txt']);
    assert.equal(manifest.summary, 'two missions');
  });

  test('mergeBranch needs an author to write merge commits', async () => {
    const anonymous = createGitStore({ config: CONFIG, store, logger: () => {} });
    await assert.rejects(anonymous.mergeBranch(repoId, 'mission/m1', 'main', 'auto', 'agent'), /author \{ name, email \} is required/);
  });
});

describe('broken chains fail hard', () => {
  test('a missing bundle is BUNDLE_MISSING, not a silent skip', async () => {
    const { store, gitStore } = newStore();
    const repoId = 'bundle-missing';
    const dir = workingTree('missing');
    commitFile(dir, 'data.txt', 'important data', 'v1.0.0: data');
    await gitStore.pushBranch(repoId, 'main', dir, 'agent');
    const { bundle_keys: [key] } = await gitStore.readRef(repoId, 'main');
    store.objects.delete(`test-bucket/git/${repoId}/bundles/${key}.bundle`);
    await assert.rejects(gitStore.fetchBranch(repoId, 'main', workingTree('missing-fetch')), /BUNDLE_MISSING/);
  });

  test('a chain that does not produce the ref commit is BUNDLE_CHAIN_BROKEN', async () => {
    // An unreadable bundle used to be logged and skipped, and the fetch still reported the ref's sha.
    const { store, gitStore } = newStore();
    const repoId = 'bundle-corrupt';
    const dir = workingTree('corrupt');
    commitFile(dir, 'data.txt', 'important data', 'v1.0.0: data');
    await gitStore.pushBranch(repoId, 'main', dir, 'agent');
    const { bundle_keys: [key] } = await gitStore.readRef(repoId, 'main');
    store.objects.set(`test-bucket/git/${repoId}/bundles/${key}.bundle`, Buffer.from('not a bundle'));
    await assert.rejects(gitStore.cloneRepo(repoId, 'main', newDir('corrupt-clone')), /BUNDLE_CHAIN_BROKEN/);
  });

  test('a ref whose sha is not a commit id is refused before it reaches git', async () => {
    // The sha is read from Firestore and used to be pasted into a shell command.
    const { store, gitStore } = newStore();
    store.docs.set('repos-under-test/tampered/refs-under-test/main', {
      name: 'x',
      fields: { sha: { stringValue: '$(touch pwned)' }, bundle_keys: { arrayValue: { values: [] } } },
      updateTime: 't-1',
    });
    await assert.rejects(gitStore.readRef('tampered', 'main'), /Corrupt ref tampered\/main/);
    store.docs.set('repos-under-test/tampered/refs-under-test/main', {
      name: 'x',
      fields: { sha: { stringValue: 'a'.repeat(40) }, bundle_keys: { arrayValue: { values: [{ stringValue: '../x' }] } } },
      updateTime: 't-1',
    });
    await assert.rejects(gitStore.readRef('tampered', 'main'), /bundle key/);
  });
});

describe('input validation', () => {
  const { gitStore } = newStore();

  test('sanitizeRepoId lowercases and strips invalid characters', () => {
    assert.throws(() => sanitizeRepoId(''), /repoId is required/);
    assert.equal(sanitizeRepoId('My Project!'), 'my-project');
    assert.equal(sanitizeRepoId('UPPER_CASE'), 'upper-case');
    assert.equal(sanitizeRepoId('x;rm -rf'), 'x-rm-rf');
    assert.equal(sanitizeRepoId('normal-repo-123'), 'normal-repo-123');
    assert.equal(sanitizeRepoId('!!!'), 'unnamed');
  });

  test('invalid repo ids and branches are rejected', async () => {
    await assert.rejects(gitStore.ensureRepo('Repo With Space'), /Invalid repoId/);
    await assert.rejects(gitStore.ensureRepo('UPPER'), /Invalid repoId/);
    await assert.rejects(gitStore.pushBranch('x;rm -rf /', 'main', scratch, 'agent'), /Invalid repoId/);
    await assert.rejects(gitStore.readRef('valid-repo', 'branch with space'), /Invalid branch/);
    await assert.rejects(gitStore.readRef('valid-repo', ''), /Invalid branch/);
  });

  test('a branch can never be read as a git option', async () => {
    await assert.rejects(gitStore.readRef('valid-repo', '--upload-pack=evil'), /Invalid branch/);
    await assert.rejects(gitStore.cloneRepo('valid-repo', '-b', newDir('option')), /Invalid branch/);
  });

  test('createGitStore needs a bucket and a project', () => {
    assert.throws(() => createGitStore({ config: { gcpProject: 'p' } }), /config.bucket is required/);
    assert.throws(() => createGitStore({ config: { bucket: 'b' } }), /config.gcpProject is required/);
  });

  test('ensureRepo re-reads after losing a concurrent create', async () => {
    const store = memoryStore();
    const racing = createGitStore({ config: CONFIG, store, logger: () => {} });
    const realWrite = store.firestoreWrite;
    store.firestoreWrite = async (project, path, fields, precondition) => {
      // Another writer creates the repo, as gated, between our read and our create.
      await realWrite(project, path, { ...fields, merge_policy: { stringValue: 'gated' } });
      return realWrite(project, path, fields, precondition);
    };
    const repo = await racing.ensureRepo('race', { mergePolicy: 'auto' });
    assert.equal(repo.merge_policy, 'gated');
  });
});

test('allocateVersion returns one more than the highest index committed today', () => {
  const dir = workingTree('version');
  const today = new Date();
  const stamp = today.toISOString().slice(0, 10).replace(/-/g, '.');
  assert.equal(allocateVersion(dir, 'main', today), 1);
  commitFile(dir, 'a.txt', 'a', `v${stamp}.1.1: first`);
  commitFile(dir, 'b.txt', 'b', `v${stamp}.3.1: third`);
  commitFile(dir, 'c.txt', 'c', 'v1999.01.01.9.1: another day');
  assert.equal(allocateVersion(dir, 'main', today), 4);
  assert.equal(allocateVersion(dir, 'no-such-ref', today), 1);
});

describe('createRemoteStore', () => {
  function fakeGoogle(responses) {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url, init });
      const next = responses.shift();
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body,
        text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
        arrayBuffer: async () => new TextEncoder().encode(next.body).buffer,
      };
    };
    return { calls, store: createRemoteStore({ fetch, getAccessToken: async () => 'tok' }) };
  }

  test('lists every page of a collection', async () => {
    // Listing used to read one page only, so a repo with many mission branches lost some silently.
    const { calls, store } = fakeGoogle([
      { status: 200, body: { documents: [{ name: 'a' }], nextPageToken: 'next/1' } },
      { status: 200, body: { documents: [{ name: 'b' }] } },
    ]);
    const docs = await store.firestoreList('your-gcp-project', 'repos/r/refs');
    assert.deepEqual(docs.map((d) => d.name), ['a', 'b']);
    assert.match(calls[1].url, /pageToken=next%2F1/);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  });

  test('a failed listing throws instead of reading as "no branches"; a missing collection is empty', async () => {
    const failing = fakeGoogle([{ status: 503, body: 'unavailable' }]).store;
    await assert.rejects(failing.firestoreList('your-gcp-project', 'repos/r/refs'), /Firestore list failed: 503/);
    const missing = fakeGoogle([{ status: 404, body: 'not found' }]).store;
    assert.deepEqual(await missing.firestoreList('your-gcp-project', 'repos/r/refs'), []);
  });

  test('reads: a 404 is absence and anything else throws', async () => {
    const { store } = fakeGoogle([
      { status: 404, body: 'nope' }, { status: 500, body: 'boom' },
      { status: 404, body: 'nope' }, { status: 500, body: 'boom' },
    ]);
    assert.equal(await store.firestoreRead('your-gcp-project', 'repos/r'), null);
    await assert.rejects(store.firestoreRead('your-gcp-project', 'repos/r'), /Firestore read failed: 500/);
    assert.equal(await store.gcsGet('test-bucket', 'git/r/bundles/x.bundle'), null);
    await assert.rejects(store.gcsGet('test-bucket', 'git/r/bundles/x.bundle'), /GCS GET failed: 500/);
  });

  test('a refused precondition is { ok: false }; any other commit failure throws', async () => {
    const { calls, store } = fakeGoogle([
      { status: 400, body: 'FAILED_PRECONDITION' },
      { status: 500, body: 'boom' },
      { status: 200, body: {} },
    ]);
    assert.equal((await store.firestoreWrite('your-gcp-project', 'repos/r', {}, { exists: false })).ok, false);
    await assert.rejects(store.firestoreWrite('your-gcp-project', 'repos/r', {}), /Firestore commit failed: 500/);
    assert.equal((await store.firestoreWrite('your-gcp-project', 'repos/r', {}, { updateTime: 't' })).ok, true);
    const body = JSON.parse(calls[2].init.body);
    assert.deepEqual(body.writes[0].currentDocument, { updateTime: 't' });
    assert.equal(body.writes[0].update.name, 'projects/your-gcp-project/databases/(default)/documents/repos/r');
  });
});
