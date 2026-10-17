// agent/storage/git-store.mjs: the git artifact store. A project's repository lives in the bucket as
// git bundles (the objects) plus one Firestore document per branch (the ref), and a ref only moves by
// compare-and-swap. This module moves commits between a local working tree and the store. It does
// not decide what to commit or when to merge: artifacts.mjs and work/ do. The command-line front end
// lives in agent/cli.
//
// Three rules keep the store consistent without a server:
// - Objects before refs. A bundle is uploaded before the ref that names it is written, so a crash in
//   between leaves an unreferenced object, never a ref to a missing one.
// - Compare-and-swap refs. A ref advances only if it is unchanged since it was read; a concurrent
//   writer gets NON_FAST_FORWARD and retries on top of the new tip.
// - Content-addressed bundles. A bundle's object name is its sha256, so a retried upload is a no-op.
//
// Git runs as a child process with an argument list, never through a shell: a ref read from
// Firestore or a path from a caller is never parsed as shell syntax.

import { FIRESTORE_HOST, STORAGE_HOST } from './hosts.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { getAccessToken as getVmAccessToken } from '../auth/metadata-token.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from './collections.mjs';
import { firestoreDecode, firestoreEncode } from './firestore.mjs';

const DEFAULT_PREFIX = 'git/'; // default; callers pass the contracts value
const DEFAULT_BRANCH = 'main'; // default; callers pass the contracts value
const DEFAULT_MAX_PUSH_RETRIES = 5; // default; callers pass the contracts value

const GCS_TRANSFER_TIMEOUT_MS = 120_000;
const GCS_METADATA_TIMEOUT_MS = 10_000;
const FIRESTORE_TIMEOUT_MS = 10_000;
const FIRESTORE_LIST_PAGE_SIZE = 300;
const GIT_TIMEOUT_MS = 60_000;

const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The first character is alphanumeric so a branch can never be read as a git option.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BUNDLE_KEY_RE = /^[0-9a-f]{64}$/;

/** Private ref a fetch writes to. Never refs/heads/{branch}: moving a checked-out branch orphans local commits. */
const remoteRef = (branch) => `refs/git-store/remote/${branch}`;

// Helpers that need no store

/**
 * Turns a raw project id into a valid repo id: lowercased, anything but letters, digits and hyphens
 * replaced by a hyphen, runs collapsed, trimmed, at most 64 characters.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeRepoId(raw) {
  if (!raw) throw new Error('repoId is required');
  return raw.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'unnamed';
}

function validateRepoId(repoId) {
  if (!REPO_ID_RE.test(repoId)) throw new Error(`Invalid repoId: "${repoId}" (must match ${REPO_ID_RE})`);
}

function validateBranch(branch) {
  if (!BRANCH_RE.test(branch)) throw new Error(`Invalid branch: "${branch}" (must match ${BRANCH_RE})`);
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd || process.cwd(),
    timeout: opts.timeout || GIT_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Allocates the next daily version index for a commit message of the form `vYYYY.MM.DD.N.M: ...`:
 * scans today's commits on `targetRef` and returns one more than the highest N found, or 1.
 *
 * @param {string} gitDir - local working tree
 * @param {string} targetRef - ref to scan, e.g. 'main'
 * @param {Date} [date] - the day to allocate for (default: now)
 * @returns {number}
 */
export function allocateVersion(gitDir, targetRef, date) {
  const d = date || new Date();
  const day = d.toISOString().slice(0, 10);
  const pattern = new RegExp(`^v${day.replace(/-/g, '\\.')}\\.(\\d+)\\.`);
  try {
    const subjects = git(['log', targetRef, `--since=${day}T00:00:00Z`, '--format=%s'], { cwd: gitDir });
    const indices = subjects.split('\n').filter(Boolean)
      .map((s) => s.match(pattern)?.[1])
      .filter(Boolean)
      .map(Number);
    return Math.max(0, ...indices) + 1;
  } catch {
    return 1;
  }
}

// The remote store: bundles in Cloud Storage, refs in Firestore

/**
 * Creates the store the git store talks to by default: Cloud Storage for bundles and Firestore for
 * refs, over REST. Tests pass their own object with the same seven functions.
 *
 * @param {object}   [deps]
 * @param {Function} [deps.getAccessToken] token source; defaults to the VM's metadata server
 * @param {Function} [deps.fetch]          fetch implementation (injectable for tests)
 * @param {string}   [deps.firestoreHost]  Firestore API origin; defaults to production
 * @param {string}   [deps.storageHost]    Cloud Storage API origin; defaults to production
 */
export function createRemoteStore({
  getAccessToken = getVmAccessToken,
  fetch = globalThis.fetch,
  firestoreHost = FIRESTORE_HOST,
  storageHost = STORAGE_HOST,
} = {}) {
  const fsHost = firestoreHost.replace(/\/+$/, '');
  const gcsHost = storageHost.replace(/\/+$/, '');
  const firestoreBase = (projectId) => `${fsHost}/v1/projects/${projectId}/databases/(default)/documents`;
  const objectUrl = (bucket, name) => `${gcsHost}/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
  const auth = async () => ({ Authorization: `Bearer ${await getAccessToken()}` });

  async function gcsPut(bucket, objectName, data) {
    const url = `${gcsHost}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...(await auth()), 'Content-Type': 'application/octet-stream' },
      body: data,
      signal: AbortSignal.timeout(GCS_TRANSFER_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`GCS PUT failed: ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  async function gcsGet(bucket, objectName) {
    const resp = await fetch(`${objectUrl(bucket, objectName)}?alt=media`, {
      headers: await auth(),
      signal: AbortSignal.timeout(GCS_TRANSFER_TIMEOUT_MS),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GCS GET failed: ${resp.status} ${await resp.text()}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  // Any failure reads as "not there". That only costs a re-upload: bundles are content-addressed.
  async function gcsExists(bucket, objectName) {
    const resp = await fetch(objectUrl(bucket, objectName), {
      headers: await auth(),
      signal: AbortSignal.timeout(GCS_METADATA_TIMEOUT_MS),
    });
    return resp.ok;
  }

  async function gcsDelete(bucket, objectName) {
    const resp = await fetch(objectUrl(bucket, objectName), {
      method: 'DELETE',
      headers: await auth(),
      signal: AbortSignal.timeout(GCS_METADATA_TIMEOUT_MS),
    });
    return resp.ok || resp.status === 404;
  }

  /** The raw document ({ name, fields, updateTime }), or null if it does not exist. Throws on any other failure. */
  async function firestoreRead(projectId, docPath) {
    const resp = await fetch(`${firestoreBase(projectId)}/${docPath}`, {
      headers: await auth(),
      signal: AbortSignal.timeout(FIRESTORE_TIMEOUT_MS),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Firestore read failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return await resp.json();
  }

  /**
   * Writes a whole document through the commit endpoint so it can carry a precondition. A refused
   * precondition returns { ok: false }; any other failure throws.
   */
  async function firestoreWrite(projectId, docPath, fields, precondition) {
    const write = { update: { name: `projects/${projectId}/databases/(default)/documents/${docPath}`, fields } };
    if (precondition) write.currentDocument = precondition;
    const resp = await fetch(`${firestoreBase(projectId)}:commit`, {
      method: 'POST',
      headers: { ...(await auth()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: [write] }),
      signal: AbortSignal.timeout(FIRESTORE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 409 || text.includes('FAILED_PRECONDITION') || text.includes('ALREADY_EXISTS')) {
        return { ok: false, reason: 'PRECONDITION_FAILED', detail: text };
      }
      throw new Error(`Firestore commit failed: ${resp.status} ${text}`);
    }
    return { ok: true, result: await resp.json() };
  }

  /**
   * Every document in a collection, following page tokens. A missing collection is empty; any other
   * failure throws, because an empty list would read as "this repo has no branches".
   */
  async function firestoreList(projectId, collectionPath) {
    const documents = [];
    let pageToken = '';
    do {
      const query = `pageSize=${FIRESTORE_LIST_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const resp = await fetch(`${firestoreBase(projectId)}/${collectionPath}?${query}`, {
        headers: await auth(),
        signal: AbortSignal.timeout(FIRESTORE_TIMEOUT_MS),
      });
      if (resp.status === 404) return documents;
      if (!resp.ok) throw new Error(`Firestore list failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
      const page = await resp.json();
      documents.push(...(page.documents || []));
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    return documents;
  }

  return { gcsPut, gcsGet, gcsExists, gcsDelete, firestoreRead, firestoreWrite, firestoreList };
}

// The git store

/**
 * Creates a git store over one bucket and one Firestore database.
 *
 * @param {object}   options
 * @param {object}   options.config
 * @param {string}   options.config.bucket              bucket holding the bundles
 * @param {string}   options.config.gcpProject          project whose Firestore holds the refs
 * @param {string}   [options.config.prefix]            object prefix for bundles, e.g. 'git/'
 * @param {string}   [options.config.defaultBranch]     branch a new repo starts on
 * @param {number}   [options.config.maxPushRetries]    attempts for pushWithRetry and mergeBranch
 * @param {string}   [options.config.reposCollection]   overrides COLLECTIONS.gitRepos
 * @param {string}   [options.config.refsSubcollection] overrides SUBCOLLECTIONS.gitRefs
 * @param {object}   [options.store]          bundle and ref storage; defaults to createRemoteStore()
 * @param {{name: string, email: string}} [options.author] identity on merge commits; required by mergeBranch
 * @param {Function} [options.getAccessToken] token source for the default store
 * @param {Function} [options.fetch]          fetch for the default store
 * @param {Function} [options.logger]         logger; defaults to stderr, so stdout stays clean for a CLI
 */
export function createGitStore({ config, store, author, getAccessToken, fetch, logger } = {}) {
  if (!config?.bucket) throw new Error('createGitStore: config.bucket is required');
  if (!config.gcpProject) throw new Error('createGitStore: config.gcpProject is required');
  const reposCollection = config.reposCollection || COLLECTIONS.gitRepos;
  const refsSubcollection = config.refsSubcollection || SUBCOLLECTIONS.gitRefs;
  if (!reposCollection || !refsSubcollection) {
    throw new Error('createGitStore: name the git repo collections (COLLECTIONS.gitRepos, SUBCOLLECTIONS.gitRefs)');
  }
  const settings = {
    bucket: config.bucket,
    gcpProject: config.gcpProject,
    prefix: config.prefix ?? DEFAULT_PREFIX,
    defaultBranch: config.defaultBranch || DEFAULT_BRANCH,
    maxPushRetries: config.maxPushRetries || DEFAULT_MAX_PUSH_RETRIES,
  };
  const backend = store || createRemoteStore({ getAccessToken, fetch });
  const log = logger || ((...args) => console.error('[git-store]', ...args));

  const bundleObjectPath = (repoId, bundleSha) => `${settings.prefix}${repoId}/bundles/${bundleSha}.bundle`;
  const repoDocPath = (repoId) => `${reposCollection}/${repoId}`;
  const refsCollectionPath = (repoId) => `${repoDocPath(repoId)}/${refsSubcollection}`;
  // Firestore document ids cannot contain '/', so branch separators are stored as '__'.
  const refDocPath = (repoId, branch) => `${refsCollectionPath(repoId)}/${branch.replace(/\//g, '__')}`;

  function makeTmpDir(label) {
    return mkdtempSync(join(tmpdir(), `git-store-${label}-`));
  }

  function removeDir(dir) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }

  function sha256File(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  }

  function repoSummary(repoId, fields, fallbackPolicy) {
    const data = firestoreDecode(fields);
    return {
      id: repoId,
      default_branch: data.default_branch || settings.defaultBranch,
      merge_policy: data.merge_policy || fallbackPolicy,
      created_at: data.created_at || null,
      updated_at: data.updated_at || null,
    };
  }

  /**
   * Makes sure the repo document exists. Idempotent; a concurrent create is re-read, not overwritten.
   *
   * @param {string} repoId
   * @param {{mergePolicy?: 'auto'|'gated'}} [opts]
   * @returns {Promise<{id: string, default_branch: string, merge_policy: string, created_at: string, updated_at: string}>}
   */
  async function ensureRepo(repoId, opts = {}) {
    validateRepoId(repoId);
    const mergePolicy = opts.mergePolicy || 'auto';
    const docPath = repoDocPath(repoId);

    const existing = await backend.firestoreRead(settings.gcpProject, docPath);
    if (existing?.fields) {
      log('ensureRepo: repo already exists:', repoId);
      return repoSummary(repoId, existing.fields, mergePolicy);
    }

    const now = new Date().toISOString();
    const fields = firestoreEncode({
      id: repoId,
      default_branch: settings.defaultBranch,
      merge_policy: mergePolicy,
      created_at: now,
      updated_at: now,
    });
    const result = await backend.firestoreWrite(settings.gcpProject, docPath, fields, { exists: false });
    if (!result.ok) {
      log('ensureRepo: concurrent create, re-reading:', repoId);
      const reread = await backend.firestoreRead(settings.gcpProject, docPath);
      if (reread?.fields) return repoSummary(repoId, reread.fields, mergePolicy);
    }

    log('ensureRepo: created:', repoId);
    return { id: repoId, default_branch: settings.defaultBranch, merge_policy: mergePolicy, created_at: now, updated_at: now };
  }

  /**
   * Reads a branch ref. Throws if the stored commit id or bundle keys are malformed: they are passed
   * to git and used as object names, so a corrupt ref must stop here.
   *
   * @param {string} repoId
   * @param {string} branch
   * @returns {Promise<{sha: string|null, bundle_keys: string[], updateTime: string|null}|null>}
   */
  async function readRef(repoId, branch) {
    validateRepoId(repoId);
    validateBranch(branch);
    const doc = await backend.firestoreRead(settings.gcpProject, refDocPath(repoId, branch));
    if (!doc?.fields) return null;
    const data = firestoreDecode(doc.fields);
    const sha = data.sha || null;
    const bundleKeys = Array.isArray(data.bundle_keys) ? data.bundle_keys : [];
    if (sha && !COMMIT_RE.test(sha)) throw new Error(`Corrupt ref ${repoId}/${branch}: sha "${String(sha).slice(0, 80)}" is not a commit id`);
    const badKey = bundleKeys.find((key) => !BUNDLE_KEY_RE.test(key));
    if (badKey !== undefined) throw new Error(`Corrupt ref ${repoId}/${branch}: bundle key "${String(badKey).slice(0, 80)}" is not a sha256`);
    return { sha, bundle_keys: bundleKeys, updateTime: doc.updateTime || null };
  }

  /**
   * Lists every branch of a repo.
   *
   * @param {string} repoId
   * @returns {Promise<Array<{branch: string, sha: string|null}>>}
   */
  async function listRefs(repoId) {
    validateRepoId(repoId);
    const docs = await backend.firestoreList(settings.gcpProject, refsCollectionPath(repoId));
    return docs.map((doc) => ({
      branch: doc.name.split('/').pop().replace(/__/g, '/'),
      sha: firestoreDecode(doc.fields).sha || null,
    }));
  }

  /**
   * Applies a branch's bundle chain to a local git dir and points the private remote ref
   * (refs/git-store/remote/{branch}) at the branch tip. Never moves refs/heads.
   *
   * Fails hard when the chain is broken: a missing bundle, or a chain that does not produce the
   * ref's commit. Reporting success there would let a caller build on, or push over, a tree that is
   * not the branch.
   *
   * @param {string} repoId
   * @param {string} branch
   * @param {string} gitDir - local working tree
   * @returns {Promise<{sha: string|null, appliedBundles: string[]}>}
   */
  async function fetchBranch(repoId, branch, gitDir) {
    validateRepoId(repoId);
    validateBranch(branch);
    const ref = await readRef(repoId, branch);
    if (!ref) return { sha: null, appliedBundles: [] };

    const appliedBundles = [];
    const tmpDir = makeTmpDir('fetch');
    try {
      for (const bundleKey of ref.bundle_keys) {
        const objectPath = bundleObjectPath(repoId, bundleKey);
        const bundleData = await backend.gcsGet(settings.bucket, objectPath);
        if (!bundleData) throw new Error(`BUNDLE_MISSING: ${objectPath}: chain is broken, cannot advance ref`);
        const bundlePath = join(tmpDir, `${bundleKey}.bundle`);
        writeFileSync(bundlePath, bundleData);

        try {
          git(['bundle', 'verify', bundlePath], { cwd: gitDir });
        } catch (e) {
          // A bundle may list prerequisites the local repo already has in another form; unbundle decides.
          log('WARN', `Bundle verify warning (proceeding): ${e.message?.slice(0, 100)}`);
        }
        try {
          git(['bundle', 'unbundle', bundlePath], { cwd: gitDir });
          appliedBundles.push(bundleKey);
        } catch (e) {
          log('WARN', `Bundle unbundle warning: ${e.message?.slice(0, 100)}`);
        }
      }

      if (ref.sha) {
        try {
          git(['cat-file', '-e', `${ref.sha}^{commit}`], { cwd: gitDir });
        } catch {
          throw new Error(`BUNDLE_CHAIN_BROKEN: ${repoId}/${branch}: the bundles do not contain ${ref.sha.slice(0, 12)}`);
        }
        git(['update-ref', remoteRef(branch), ref.sha], { cwd: gitDir });
      }
    } finally {
      removeDir(tmpDir);
    }
    return { sha: ref.sha, appliedBundles };
  }

  /**
   * Clones a branch into a directory, creating and initializing it if needed. The one path that
   * moves refs/heads/{branch}, through a checkout.
   *
   * @param {string} repoId
   * @param {string} branch
   * @param {string} destDir
   * @returns {Promise<{repoId: string, branch: string, sha: string|null, dir: string}>}
   */
  async function cloneRepo(repoId, branch, destDir) {
    validateRepoId(repoId);
    validateBranch(branch);
    const dir = resolve(destDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, '.git'))) {
      git(['init'], { cwd: dir });
      git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: dir });
    }

    const { sha } = await fetchBranch(repoId, branch, dir);
    if (sha) {
      try {
        git(['checkout', '-B', branch, sha], { cwd: dir });
      } catch {
        try {
          git(['reset', '--hard', sha], { cwd: dir });
        } catch (e) {
          log('WARN', `checkout/reset failed: ${e.message?.slice(0, 100)}`);
        }
      }
    }
    return { repoId, branch, sha, dir };
  }

  /**
   * Pushes the working tree's HEAD to a branch. Objects first (the delta bundle), then the ref by
   * compare-and-swap. The bundle always holds HEAD, the commit the ref will name.
   *
   * @param {string} repoId
   * @param {string} branch
   * @param {string} gitDir
   * @param {string} actor - recorded on the ref as `updated_by`
   * @returns {Promise<{status: 'pushed'|'up_to_date'|'NON_FAST_FORWARD', sha: string|null}>}
   */
  async function pushBranch(repoId, branch, gitDir, actor) {
    validateRepoId(repoId);
    validateBranch(branch);

    const ref = await readRef(repoId, branch);
    const remoteSha = ref?.sha || null;

    let localHead;
    try {
      localHead = git(['rev-parse', 'HEAD'], { cwd: gitDir });
    } catch {
      return { status: 'up_to_date', sha: null }; // unborn HEAD: nothing to push
    }
    if (localHead === remoteSha) return { status: 'up_to_date', sha: localHead };

    if (remoteSha) {
      try {
        git(['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: gitDir });
      } catch {
        return { status: 'NON_FAST_FORWARD', sha: localHead };
      }
    }

    const tmpDir = makeTmpDir('push');
    try {
      const bundlePath = join(tmpDir, 'push.bundle');
      try {
        git(['bundle', 'create', bundlePath, remoteSha ? `${remoteSha}..HEAD` : 'HEAD'], { cwd: gitDir });
      } catch (e) {
        throw new Error(`Bundle creation failed: ${e.message}`);
      }
      const bundleSha = sha256File(bundlePath);
      const objectPath = bundleObjectPath(repoId, bundleSha);

      if (await backend.gcsExists(settings.bucket, objectPath)) {
        log('push: bundle already exists:', bundleSha.slice(0, 12));
      } else {
        await backend.gcsPut(settings.bucket, objectPath, readFileSync(bundlePath));
        log('push: bundle uploaded:', bundleSha.slice(0, 12));
      }

      const fields = firestoreEncode({
        sha: localHead,
        bundle_keys: [...(ref?.bundle_keys || []), bundleSha],
        updated_at: new Date().toISOString(),
        updated_by: actor,
      });
      const precondition = ref?.updateTime ? { updateTime: ref.updateTime } : { exists: false };
      const result = await backend.firestoreWrite(settings.gcpProject, refDocPath(repoId, branch), fields, precondition);
      if (!result.ok) {
        log('push: CAS failed (non-fast-forward):', result.reason);
        return { status: 'NON_FAST_FORWARD', sha: localHead };
      }
      log('push: ref advanced:', branch, '->', localHead.slice(0, 12));
      return { status: 'pushed', sha: localHead };
    } finally {
      removeDir(tmpDir);
    }
  }

  /**
   * Pushes, and on NON_FAST_FORWARD fetches the new tip, rebases local commits onto it and tries
   * again, up to maxPushRetries attempts.
   *
   * @param {string} repoId
   * @param {string} branch
   * @param {string} gitDir
   * @param {string} actor
   * @returns {Promise<{status: 'pushed'|'up_to_date'|'failed', sha: string|null, attempts: number}>}
   */
  async function pushWithRetry(repoId, branch, gitDir, actor) {
    validateRepoId(repoId);
    validateBranch(branch);
    const maxRetries = settings.maxPushRetries;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await pushBranch(repoId, branch, gitDir, actor);
      if (result.status !== 'NON_FAST_FORWARD') return { ...result, attempts: attempt };

      log(`push: attempt ${attempt}/${maxRetries} got NON_FAST_FORWARD, fetching + rebasing...`);
      await fetchBranch(repoId, branch, gitDir);
      // fetchBranch wrote the new tip to the private remote ref, never to refs/heads, so rebase onto that.
      try {
        git(['rebase', remoteRef(branch)], { cwd: gitDir });
      } catch (e) {
        try { git(['rebase', '--abort'], { cwd: gitDir }); } catch { /* nothing to abort */ }
        log('push: rebase failed:', e.message?.slice(0, 100));
        return { status: 'failed', sha: null, attempts: attempt };
      }
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
    return { status: 'failed', sha: null, attempts: maxRetries };
  }

  /**
   * Merges a source branch into a target branch in a scratch clone and pushes the result. Tries a
   * fast-forward first, then a merge commit. If the target moves during the merge, starts again from
   * the new tip. A 'gated' policy merges nothing and returns AWAITING_APPROVAL.
   *
   * @param {string} repoId
   * @param {string} sourceBranch
   * @param {string} targetBranch
   * @param {'auto'|'gated'} policy
   * @param {string} actor - recorded on the ref as `updated_by`
   * @returns {Promise<{status: 'merged'|'AWAITING_APPROVAL'|'failed', sha: string|null, reason?: string, conflicts?: string[]}>}
   */
  async function mergeBranch(repoId, sourceBranch, targetBranch, policy, actor) {
    validateRepoId(repoId);
    validateBranch(sourceBranch);
    validateBranch(targetBranch);
    if (policy === 'gated') {
      log('merge: gated policy, returning AWAITING_APPROVAL');
      return { status: 'AWAITING_APPROVAL', sha: null };
    }
    if (!author?.name || !author?.email) {
      throw new Error('createGitStore: author { name, email } is required to write merge commits');
    }
    // Author and committer of a merge commit, without touching the scratch clone's config.
    const identity = ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];

    const tmpDir = makeTmpDir('merge');
    try {
      for (let attempt = 0; attempt < settings.maxPushRetries; attempt++) {
        if (attempt === 0) {
          await cloneRepo(repoId, targetBranch, tmpDir);
        } else {
          await fetchBranch(repoId, targetBranch, tmpDir);
          try {
            git(['checkout', '-B', targetBranch, remoteRef(targetBranch)], { cwd: tmpDir });
          } catch {
            log('merge: failed to reset to remote target after re-fetch');
            return { status: 'failed', sha: null };
          }
        }

        await fetchBranch(repoId, sourceBranch, tmpDir);
        const sourceRef = remoteRef(sourceBranch);
        try {
          git(['merge', '--ff-only', sourceRef], { cwd: tmpDir });
        } catch {
          try {
            git([...identity, 'merge', sourceRef, '--no-edit', '-m', `Merge ${sourceBranch} into ${targetBranch}`], { cwd: tmpDir });
          } catch (e) {
            // Name the conflicting files before aborting: a bare "failed" gives the caller nothing to act on.
            let conflicts = [];
            try {
              conflicts = git(['diff', '--name-only', '--diff-filter=U'], { cwd: tmpDir })
                .split('\n').map((s) => s.trim()).filter(Boolean);
            } catch { /* no conflict list */ }
            log('merge: conflict:', `${e.message?.slice(0, 80)}`
              + (conflicts.length ? ` [conflicting files: ${conflicts.join(', ').slice(0, 200)}]` : ''));
            try { git(['merge', '--abort'], { cwd: tmpDir }); } catch { /* nothing to abort */ }
            return { status: 'failed', sha: null, reason: 'conflict', conflicts };
          }
        }

        const pushResult = await pushBranch(repoId, targetBranch, tmpDir, actor);
        if (pushResult.status === 'pushed' || pushResult.status === 'up_to_date') {
          return { status: 'merged', sha: git(['rev-parse', 'HEAD'], { cwd: tmpDir }) };
        }
        if (pushResult.status !== 'NON_FAST_FORWARD') return { status: 'failed', sha: null };
        log(`merge: target advanced during merge (attempt ${attempt + 1}), retrying...`);
      }
      return { status: 'failed', sha: null };
    } finally {
      removeDir(tmpDir);
    }
  }

  /**
   * Consolidates a branch's bundle chain into one full bundle. The ref moves by compare-and-swap
   * first; old bundles are deleted only after it succeeds. If the branch moved meanwhile, nothing changes.
   *
   * @param {string} repoId
   * @param {string} branch
   * @returns {Promise<{sha: string|null, bundle_keys: string[]}>}
   */
  async function gc(repoId, branch) {
    validateRepoId(repoId);
    validateBranch(branch);
    const ref = await readRef(repoId, branch);
    if (!ref || ref.bundle_keys.length <= 1) return { sha: ref?.sha || null, bundle_keys: ref?.bundle_keys || [] };

    log('gc: consolidating', ref.bundle_keys.length, 'bundles for', `${repoId}/${branch}`);
    const tmpDir = makeTmpDir('gc');
    try {
      const cloneDir = join(tmpDir, 'clone');
      await cloneRepo(repoId, branch, cloneDir);
      const fullBundlePath = join(tmpDir, 'full.bundle');
      git(['bundle', 'create', fullBundlePath, branch], { cwd: cloneDir });
      const fullBundleSha = sha256File(fullBundlePath);
      const objectPath = bundleObjectPath(repoId, fullBundleSha);
      if (!(await backend.gcsExists(settings.bucket, objectPath))) {
        await backend.gcsPut(settings.bucket, objectPath, readFileSync(fullBundlePath));
      }

      const fields = firestoreEncode({
        sha: ref.sha,
        bundle_keys: [fullBundleSha],
        updated_at: new Date().toISOString(),
        updated_by: 'gc',
      });
      const result = await backend.firestoreWrite(settings.gcpProject, refDocPath(repoId, branch), fields, { updateTime: ref.updateTime });
      if (!result.ok) {
        log('gc: CAS failed (ref was modified during gc), skipping');
        return { sha: ref.sha, bundle_keys: ref.bundle_keys };
      }

      for (const key of ref.bundle_keys.filter((k) => k !== fullBundleSha)) {
        await backend.gcsDelete(settings.bucket, bundleObjectPath(repoId, key));
      }
      log('gc: consolidated to 1 bundle:', fullBundleSha.slice(0, 12));
      return { sha: ref.sha, bundle_keys: [fullBundleSha] };
    } finally {
      removeDir(tmpDir);
    }
  }

  /**
   * Builds an artifact manifest (path, blob sha, size) for files on a branch's tip.
   *
   * @param {string} repoId
   * @param {string} branch
   * @param {string[]} changedPaths - files to include; empty means every tracked file
   * @param {{summary?: string}} [opts]
   * @returns {Promise<{kind: 'artifact_manifest', summary: string, repo: string, branch: string, commit: string,
   *   files: Array<{path: string, blob_sha: string, size: number}>}>}
   */
  async function buildManifest(repoId, branch, changedPaths, opts = {}) {
    validateRepoId(repoId);
    validateBranch(branch);
    const tmpDir = makeTmpDir('manifest');
    try {
      await cloneRepo(repoId, branch, tmpDir);
      const commitSha = git(['rev-parse', 'HEAD'], { cwd: tmpDir });
      const paths = changedPaths?.length
        ? changedPaths
        : git(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: tmpDir }).split('\n').filter(Boolean);

      const files = [];
      for (const p of paths) {
        const fullPath = resolve(tmpDir, p);
        // A path that leaves the clone is not part of this repo, whatever the caller passed.
        const inside = relative(tmpDir, fullPath);
        if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
        if (!existsSync(fullPath)) continue;
        try {
          const blobSha = git(['hash-object', '--', fullPath], { cwd: tmpDir });
          files.push({ path: p, blob_sha: blobSha, size: statSync(fullPath).size });
        } catch { /* not a file git can hash, e.g. a directory */ }
      }

      return {
        kind: 'artifact_manifest',
        summary: opts.summary || `${files.length} file(s) in ${repoId}/${branch}`,
        repo: repoId,
        branch,
        commit: commitSha,
        files,
      };
    } finally {
      removeDir(tmpDir);
    }
  }

  return {
    defaultBranch: settings.defaultBranch,
    ensureRepo,
    readRef,
    listRefs,
    fetchBranch,
    cloneRepo,
    pushBranch,
    pushWithRetry,
    mergeBranch,
    gc,
    buildManifest,
  };
}
