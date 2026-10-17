// Tests for tests/fakes/gcs-server.mjs. The fake is driven through the agent's real clients (the git
// store's remote store, the git store itself over both fakes, and the file store), and through raw
// JSON API calls where the shape on the wire is the point, so these tests are also the conformance
// check that the clients and the fake agree on the Cloud Storage API.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { start, crc32c } from './gcs-server.mjs';
import { start as startFirestore } from './firestore-server.mjs';
import { createGitStore, createRemoteStore } from '../../agent/storage/git-store.mjs';
import { createFileStore } from '../../agent/storage/file-store.mjs';
import { commitFile, git, initWorkingTree, isolatedGit, TEST_AUTHOR } from '../agent/storage/git-fixtures.mjs';

const TOKEN = 'test-token';
const getAccessToken = async () => TOKEN;
const BUCKET = 'your-gcp-project-test';

let gcs;
let firestore;
let remote;
before(async () => {
  gcs = await start({ bucket: BUCKET });
  firestore = await startFirestore();
  remote = createRemoteStore({ firestoreHost: firestore.origin, storageHost: gcs.origin, getAccessToken });
});
after(async () => {
  await gcs.stop();
  await firestore.stop();
});
beforeEach(() => {
  gcs.reset();
  firestore.reset();
});

const objectPath = (name, bucket = BUCKET) => `/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${gcs.origin}${path}`, { method, body, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.startsWith('application/json');
  return { status: res.status, headers: res.headers, text, json: isJson && text ? JSON.parse(text) : null };
}

describe('objects', () => {
  test('crc32c matches the published check value', () => {
    assert.equal(crc32c(Buffer.from('123456789')), Buffer.from('e3069283', 'hex').toString('base64'));
  });

  test("a media upload through the git store's call returns the JSON API's object resource", async () => {
    const data = Buffer.from('bundle bytes');
    const meta = await remote.gcsPut(BUCKET, 'git/r/bundles/abc.bundle', data);
    assert.equal(meta.kind, 'storage#object');
    assert.equal(meta.name, 'git/r/bundles/abc.bundle');
    assert.equal(meta.bucket, BUCKET);
    assert.equal(meta.size, String(data.length), 'int64 fields are strings');
    assert.match(meta.generation, /^\d+$/);
    assert.equal(meta.md5Hash, createHash('md5').update(data).digest('base64'));
    assert.equal(meta.crc32c, crc32c(data));
    assert.equal(meta.contentType, 'application/octet-stream');
    assert.equal(gcs.requests[0].query, `uploadType=media&name=${encodeURIComponent('git/r/bundles/abc.bundle')}`);
  });

  test('exists, download and metadata agree with what was uploaded', async () => {
    const data = Buffer.from([0, 1, 2, 255]);
    await remote.gcsPut(BUCKET, 'git/r/bundles/x.bundle', data);
    assert.equal(await remote.gcsExists(BUCKET, 'git/r/bundles/x.bundle'), true);
    assert.equal(await remote.gcsExists(BUCKET, 'git/r/bundles/none.bundle'), false);
    assert.deepEqual(await remote.gcsGet(BUCKET, 'git/r/bundles/x.bundle'), data);
    assert.equal(await remote.gcsGet(BUCKET, 'git/r/bundles/none.bundle'), null);

    const meta = await call('GET', objectPath('git/r/bundles/x.bundle'));
    assert.equal(meta.json.size, '4');
    const media = await call('GET', `${objectPath('git/r/bundles/x.bundle')}?alt=media`);
    assert.equal(media.headers.get('x-goog-hash'), `crc32c=${meta.json.crc32c},md5=${meta.json.md5Hash}`);
    assert.equal(media.headers.get('x-goog-generation'), meta.json.generation);
    const viaMediaLink = await fetch(meta.json.mediaLink);
    assert.deepEqual(Buffer.from(await viaMediaLink.arrayBuffer()), data);
  });

  test('delete answers 204, then 404 in the notFound shape; the git store counts both as done', async () => {
    await remote.gcsPut(BUCKET, 'git/r/bundles/d.bundle', Buffer.from('d'));
    const first = await call('DELETE', objectPath('git/r/bundles/d.bundle'));
    assert.deepEqual([first.status, first.text], [204, '']);
    const second = await call('DELETE', objectPath('git/r/bundles/d.bundle'));
    assert.equal(second.status, 404);
    const message = `No such object: ${BUCKET}/git/r/bundles/d.bundle`;
    assert.deepEqual(second.json, { error: { code: 404, message, errors: [{ message, domain: 'global', reason: 'notFound' }] } });
    assert.equal(await remote.gcsDelete(BUCKET, 'git/r/bundles/d.bundle'), true);
  });

  test('uploading over an object makes a new generation', async () => {
    const one = await remote.gcsPut(BUCKET, 'f.txt', Buffer.from('1'));
    const two = await remote.gcsPut(BUCKET, 'f.txt', Buffer.from('2'));
    assert.ok(BigInt(two.generation) > BigInt(one.generation));
    assert.equal(gcs.dump()['f.txt'].data.toString(), '2');
  });

  test('list filters by prefix, folds by delimiter and pages with tokens', async () => {
    for (const name of ['a/1', 'a/2', 'a/sub/3', 'b/4']) await remote.gcsPut(BUCKET, name, Buffer.from(name));
    const folded = await call('GET', `/storage/v1/b/${BUCKET}/o?prefix=a%2F&delimiter=%2F`);
    assert.deepEqual(folded.json.items.map((o) => o.name), ['a/1', 'a/2']);
    assert.deepEqual(folded.json.prefixes, ['a/sub/']);
    const names = [];
    let token = '';
    do {
      const page = await call('GET', `/storage/v1/b/${BUCKET}/o?prefix=a%2F&maxResults=2${token ? `&pageToken=${token}` : ''}`);
      names.push(...page.json.items.map((o) => o.name));
      token = page.json.nextPageToken || '';
    } while (token);
    assert.deepEqual(names, ['a/1', 'a/2', 'a/sub/3']);
    assert.deepEqual((await call('GET', `/storage/v1/b/${BUCKET}/o?prefix=zzz`)).json, { kind: 'storage#objects' });
  });

  test('requests record the bearer token', async () => {
    await remote.gcsPut(BUCKET, 'auth.txt', Buffer.from('x'));
    await remote.gcsGet(BUCKET, 'auth.txt');
    assert.ok(gcs.requests.length === 2 && gcs.requests.every((r) => r.token === TOKEN));
    await fetch(`${gcs.origin}${objectPath('auth.txt')}`);
    assert.equal(gcs.requests.at(-1).token, null);
  });
});

describe('refused and unsupported calls', () => {
  const upload = (query, body = 'x') => call('POST', `/upload/storage/v1/b/${BUCKET}/o?${query}`, { body });

  test('a malformed upload is a 400, as in the real API', async () => {
    const noName = await upload('uploadType=media');
    assert.equal(noName.status, 400);
    assert.deepEqual(noName.json.error.errors[0], { message: 'Required', domain: 'global', reason: 'required' });
    assert.equal((await upload('name=x')).status, 400, 'uploadType is required');
  });

  test('another bucket, or an object name with an unencoded slash, is a 404', async () => {
    const other = await call('GET', objectPath('x', 'some-other-bucket'));
    assert.deepEqual([other.status, other.json.error.message], [404, 'The specified bucket does not exist.']);
    assert.equal((await call('GET', `/storage/v1/b/${BUCKET}/o/a/b`)).status, 404);
  });

  test('multipart uploads, preconditions and ranged reads answer 501, never a guess', async () => {
    assert.equal((await upload('uploadType=multipart&name=x')).status, 501);
    assert.equal((await upload('uploadType=media&name=x&ifGenerationMatch=0')).status, 501);
    await remote.gcsPut(BUCKET, 'r.txt', Buffer.from('abc'));
    const ranged = await call('GET', `${objectPath('r.txt')}?alt=media`, { headers: { Range: 'bytes=0-0' } });
    assert.equal(ranged.status, 501);
  });
});

describe('the file store', () => {
  const env = isolatedGit('gcs-fake-files');
  after(() => env.cleanup());

  test("uploads a mission's files under files/out/<mission>/ with content types from their names", async () => {
    const dir = env.newDir('outgoing');
    writeFileSync(join(dir, 'report.md'), '# Report\n');
    writeFileSync(join(dir, 'data.json'), '{"a":1}');
    const store = createFileStore({ bucket: BUCKET, storageHost: gcs.origin, getAccessToken });
    const sent = await store.uploadOutgoing('m-1', [join(dir, 'report.md'), join(dir, 'data.json'), join(dir, 'missing.txt')]);
    assert.deepEqual(sent.map((f) => f.gcsPath), ['files/out/m-1/report.md', 'files/out/m-1/data.json']);
    const stored = gcs.dump();
    assert.equal(stored['files/out/m-1/report.md'].contentType, 'text/markdown');
    assert.equal(stored['files/out/m-1/data.json'].contentType, 'application/json');
    assert.equal(stored['files/out/m-1/report.md'].data.toString(), '# Report\n');
  });
});

describe('the git store over both fakes', () => {
  const env = isolatedGit('gcs-fake-git');
  after(() => env.cleanup());
  const config = { bucket: BUCKET, gcpProject: 'your-gcp-project', prefix: 'git/', defaultBranch: 'main', maxPushRetries: 3 };
  const newGitStore = () => createGitStore({ config, store: remote, author: TEST_AUTHOR, logger: () => {} });
  const bundles = () => Object.keys(gcs.dump()).filter((name) => name.startsWith('git/repo-1/bundles/'));

  test('push, clone, a refused stale ref write, branch listing and gc', async () => {
    const store = newGitStore();
    const repo = await store.ensureRepo('repo-1');
    assert.equal(repo.default_branch, 'main');
    assert.deepEqual(await store.ensureRepo('repo-1', { mergePolicy: 'gated' }), repo, 'the second call reads the first');

    const source = initWorkingTree(env.newDir('source'));
    const firstSha = commitFile(source, 'a.txt', 'one\n', 'first');
    assert.deepEqual(await store.pushBranch('repo-1', 'main', source, 'test'), { status: 'pushed', sha: firstSha });
    const ref = await store.readRef('repo-1', 'main');
    assert.equal(ref.sha, firstSha);
    assert.match(ref.updateTime, /\.\d{6}Z$/);

    const secondSha = commitFile(source, 'a.txt', 'two\n', 'second');
    assert.equal((await store.pushBranch('repo-1', 'main', source, 'test')).status, 'pushed');
    assert.equal(bundles().length, 2);

    // A writer that read the ref before the second push must lose the compare-and-swap.
    const fields = { sha: { stringValue: firstSha } };
    const stale = await remote.firestoreWrite('your-gcp-project', 'git_repos/repo-1/refs/main', fields, { updateTime: ref.updateTime });
    assert.equal(stale.ok, false);

    const clone = await store.cloneRepo('repo-1', 'main', env.newDir('clone'));
    assert.equal(clone.sha, secondSha);
    assert.equal(git(['show', 'HEAD:a.txt'], clone.dir), 'two');

    git(['checkout', '-b', 'feature/x'], source);
    commitFile(source, 'b.txt', 'feature\n', 'feature');
    await store.pushBranch('repo-1', 'feature/x', source, 'test');
    const refs = await store.listRefs('repo-1');
    assert.deepEqual(refs.map((r) => r.branch).sort(), ['feature/x', 'main']);

    const collected = await store.gc('repo-1', 'main');
    assert.equal(collected.bundle_keys.length, 1);
    const left = bundles().filter((name) => !name.includes(collected.bundle_keys[0]));
    assert.equal(left.length, 1, "only the feature branch's bundle is left beside the consolidated one");
    assert.equal((await store.cloneRepo('repo-1', 'main', env.newDir('after-gc'))).sha, secondSha);
  });
});
