// tests/repo/structure.test.mjs: the layout explains itself. Every top-level directory, agent package
// and role has a README.md, and every skill has a SKILL.md. The root and agent/ READMEs map exactly the
// directories that exist. The guidance files point to DEVELOPING.md. The install manifest names only
// repo paths that exist, for every role, and nothing developer-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoFiles, readRepoFile } from './repo-files.mjs';
import { parseManifest, expandManifest } from '../../install/vm/manifest.mjs';

const files = repoFiles();

/** Names of the non-hidden directories directly under `parent` ('' for the repo root). */
function childDirectories(parent) {
  const prefix = parent ? `${parent}/` : '';
  const names = files
    .filter((f) => f.startsWith(prefix) && f.slice(prefix.length).includes('/'))
    .map((f) => f.slice(prefix.length).split('/')[0]);
  return [...new Set(names)].filter((name) => !name.startsWith('.')).sort();
}

/** Directory names a README lists in table rows that start with | `name/` |. */
function mappedDirectories(readmePath) {
  const rows = readRepoFile(readmePath).matchAll(/^\| `([a-z0-9-]+)\/` \|/gm);
  return [...new Set([...rows].map((m) => m[1]))].sort();
}

/**
 * The repo paths install/manifest.txt installs, read with the parser bootstrap.sh uses, with {role}
 * expanded for every role in the repo (generic included). Directories keep their trailing slash.
 */
function manifestPaths() {
  const entries = parseManifest(readRepoFile('install/manifest.txt'));
  return [...new Set(childDirectories('roles').flatMap((role) => expandManifest(entries, role)))];
}

test('every top-level directory has a README.md', () => {
  const missing = childDirectories('').filter((dir) => !files.includes(`${dir}/README.md`));
  assert.deepEqual(missing, []);
});

test('every agent package and every role has a README.md', () => {
  const packages = [
    ...childDirectories('agent').map((dir) => `agent/${dir}`),
    ...childDirectories('roles').map((dir) => `roles/${dir}`),
  ];
  const missing = packages.filter((dir) => !files.includes(`${dir}/README.md`));
  assert.deepEqual(missing, []);
});

test('every skill has a SKILL.md', () => {
  const skills = [
    ...childDirectories('skills').map((dir) => `skills/${dir}`),
    ...childDirectories('roles').flatMap((role) =>
      childDirectories(`roles/${role}/skills`).map((dir) => `roles/${role}/skills/${dir}`)),
  ];
  const missing = skills.filter((dir) => !files.includes(`${dir}/SKILL.md`));
  assert.deepEqual(missing, []);
});

test('the root README map lists exactly the top-level directories', () => {
  assert.deepEqual(mappedDirectories('README.md'), childDirectories(''));
});

test('the agent README map lists exactly the agent packages', () => {
  assert.deepEqual(mappedDirectories('agent/README.md'), childDirectories('agent'));
});

test('the guidance files point to DEVELOPING.md', () => {
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    assert.match(readRepoFile(file), /\(DEVELOPING\.md\)/, `${file} must link to DEVELOPING.md`);
  }
});

test('nothing developer-only enters the install manifest', () => {
  const devOnly = manifestPaths().filter((path) =>
    /^(dev|docs|tests|dashboard|\.github)(\/|$)/.test(path) || (!path.includes('/') && /\.md$/i.test(path)));
  assert.deepEqual(devOnly, [], 'dev/, docs/, tests/, dashboard/, .github/ and the root guidance files are never installed');
});

test('every manifest path exists in the repo', () => {
  const missing = manifestPaths().filter((path) => (path.endsWith('/')
    ? !files.some((file) => file.startsWith(path))
    : !files.includes(path)));
  assert.deepEqual(missing, [], 'the manifest lists paths the repo does not have (a directory needs its trailing /, a file must not have one)');
});
