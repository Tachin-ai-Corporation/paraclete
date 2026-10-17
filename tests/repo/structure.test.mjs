// tests/repo/structure.test.mjs: the layout explains itself. Every top-level directory, agent package
// and role has a README.md, and every skill has a SKILL.md. The root and agent/ READMEs map exactly the
// directories that exist. The guidance files point to DEVELOPING.md. Nothing developer-only enters the
// install manifest, and every manifest line installs a file at its repo path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoFiles, readRepoFile } from './repo-files.mjs';

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

/** Non-comment lines of install/manifest.txt as [src, dest] pairs. */
function manifestEntries() {
  return readRepoFile('install/manifest.txt')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/));
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

test('nothing developer-only enters the install manifest', (t) => {
  if (!files.includes('install/manifest.txt')) return t.skip('install/manifest.txt arrives in build plan phase 5');
  const devOnly = manifestEntries()
    .map(([src]) => src)
    .filter((src) => /^(dev|docs|tests|\.github)\//.test(src) || /^[A-Z]+\.md$/.test(src));
  assert.deepEqual(devOnly, []);
});

test('every manifest line installs a file at its repo path', (t) => {
  if (!files.includes('install/manifest.txt')) return t.skip('install/manifest.txt arrives in build plan phase 5');
  const moved = manifestEntries().filter(([src, dest]) => src !== dest).map((pair) => pair.join(' '));
  const missing = manifestEntries().filter(([src]) => !files.includes(src)).map(([src]) => src);
  assert.deepEqual(moved, [], 'repo path must equal VM path');
  assert.deepEqual(missing, [], 'manifest lists files that do not exist');
});
