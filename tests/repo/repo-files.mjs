// tests/repo/repo-files.mjs: the files that are, or are about to be, part of the repo. Used by the
// whole-repo tests. Includes untracked files git doesn't ignore, so a stray file fails the tests
// before anyone stages it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|ico|woff2?|pdf)$/i;

/** Repo-relative paths (forward slashes) of tracked files plus untracked files git doesn't ignore. */
export function repoFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return [...new Set(out.split('\0').filter(Boolean))].filter((path) => existsSync(join(repoRoot, path)));
}

export function isText(path) {
  return !BINARY_EXTENSIONS.test(path);
}

export function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}
