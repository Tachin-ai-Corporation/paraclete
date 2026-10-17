// tests/agent/storage/git-fixtures.mjs: shared fixtures for the tests that run the real git binary
// against the git artifact store: an isolated git configuration, an in-memory stand-in for Cloud
// Storage and Firestore, and helpers that build working trees. Used by git-store.test.mjs and
// artifacts.test.mjs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Creates a scratch directory and points git at a throwaway global config inside it, so the
 * developer's own git settings (line endings, signing, identity) never change a test's outcome.
 * Returns the scratch directory, a `newDir(label)` helper and a `cleanup()`.
 */
export function isolatedGit(label) {
  const scratch = mkdtempSync(join(tmpdir(), `${label}-`));
  const gitConfig = join(scratch, 'gitconfig');
  writeFileSync(gitConfig, [
    '[user]', '  name = test', '  email = test@example.com',
    '[core]', '  autocrlf = false',
    '[commit]', '  gpgsign = false',
    '[init]', '  defaultBranch = main',
    '',
  ].join('\n'));
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  let count = 0;
  return {
    scratch,
    newDir(name) {
      count += 1;
      return mkdtempSync(join(scratch, `${name}-${count}-`));
    },
    cleanup() {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** Cloud Storage and Firestore in memory, with the same seven functions as createRemoteStore(). */
export function memoryStore() {
  const objects = new Map();
  const docs = new Map();
  let clock = 0;
  return {
    objects,
    docs,
    async gcsPut(bucket, name, data) { objects.set(`${bucket}/${name}`, Buffer.from(data)); return { name }; },
    async gcsGet(bucket, name) { return objects.get(`${bucket}/${name}`) || null; },
    async gcsExists(bucket, name) { return objects.has(`${bucket}/${name}`); },
    async gcsDelete(bucket, name) { objects.delete(`${bucket}/${name}`); return true; },
    async firestoreRead(_project, path) { return docs.has(path) ? structuredClone(docs.get(path)) : null; },
    async firestoreWrite(_project, path, fields, precondition) {
      const current = docs.get(path);
      if (precondition?.exists === false && current) return { ok: false, reason: 'PRECONDITION_FAILED' };
      if (precondition?.updateTime && current?.updateTime !== precondition.updateTime) {
        return { ok: false, reason: 'PRECONDITION_FAILED' };
      }
      clock += 1;
      docs.set(path, { name: `projects/p/databases/(default)/documents/${path}`, fields, updateTime: `t-${clock}` });
      return { ok: true };
    },
    async firestoreList(_project, collectionPath) {
      return [...docs.entries()]
        .filter(([path]) => path.startsWith(`${collectionPath}/`) && !path.slice(collectionPath.length + 1).includes('/'))
        .map(([, doc]) => structuredClone(doc));
    },
  };
}

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Initializes `dir` as a repository on `main` with one commit. */
export function initWorkingTree(dir) {
  git(['init'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  writeFileSync(join(dir, '.gitkeep'), '');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

/** Writes a file, commits everything, and returns the new HEAD. */
export function commitFile(dir, name, content, message) {
  writeFileSync(join(dir, name), content);
  git(['add', '-A'], dir);
  git(['commit', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/** Store settings the tests share. */
export const TEST_CONFIG = Object.freeze({
  bucket: 'test-bucket',
  gcpProject: 'your-gcp-project',
  prefix: 'git/',
  defaultBranch: 'main',
  maxPushRetries: 5,
  reposCollection: 'repos-under-test',
  refsSubcollection: 'refs-under-test',
});

export const TEST_AUTHOR = Object.freeze({ name: 'paraclete', email: 'agent@example.com' });
