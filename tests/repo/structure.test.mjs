// tests/repo/structure.test.mjs: the layout explains itself. Every top-level directory, agent package
// and role has a README.md, every skill has a SKILL.md, and every module the agent runs opens with a
// whole header comment. The root and agent/ READMEs map exactly the directories that exist. The
// guidance files point to DEVELOPING.md. The install manifest names only repo paths that exist, for
// every role, and nothing developer-only.
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

/**
 * The last line of a module's opening comment, and the line after the comment, or null when the
 * module opens with no comment.
 */
function openingComment(text) {
  const lines = text.split('\n');
  let i = lines[0]?.startsWith('#!') ? 1 : 0;
  const block = [];
  for (; i < lines.length && lines[i].startsWith('//'); i += 1) block.push(lines[i].replace(/^\/\/\s?/, '').trim());
  if (!block.length) return null;
  return { last: block.filter(Boolean).pop() || '', after: lines[i] ?? '' };
}

test('every module the agent runs opens with a whole header comment: it ends a sentence, and a blank line follows', () => {
  // DEVELOPING.md section 5: each file's header says what it does, what it does not do, and who calls
  // it. An edit that splices code into the header leaves it cut mid-sentence, with code right below.
  const modules = files.filter((f) => /^(agent|roles|skills|migrations)\//.test(f) && f.endsWith('.mjs'));
  assert.ok(modules.length > 100, `${modules.length} modules`);
  const broken = modules.filter((f) => {
    const header = openingComment(readRepoFile(f));
    return !header || !/[.:)`'"]$/.test(header.last) || header.after.trim() !== '';
  });
  assert.deepEqual(broken, []);
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
