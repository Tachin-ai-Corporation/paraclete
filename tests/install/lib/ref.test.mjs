// Tests for install/lib/ref.sh: the repository from a remote URL, and a tag, branch or commit turned
// into the full commit the VM installs. Pure functions, run through bash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callLib, needsBash, repoRoot, COMMITS, LISTING, OLDER_TAG, RELEASE_TAG } from '../harness.mjs';

const ref = (fn, ...args) => callLib(['ref'], fn, args);
const out = (result) => result.stdout.trim();
const CANONICAL = JSON.parse(readFileSync(join(repoRoot, 'config', 'contracts.json'), 'utf8')).versioning.canonical_regex;

test('reads owner/name from https and ssh GitHub remotes', { skip: needsBash }, () => {
  for (const url of [
    'https://github.com/your-org/paraclete.git',
    'https://github.com/your-org/paraclete',
    'https://github.com/your-org/paraclete/',
    'git@github.com:your-org/paraclete.git',
  ]) {
    assert.equal(out(ref('repo_from_remote_url', url)), 'your-org/paraclete', url);
  }
});

test('refuses a remote that is not on GitHub', { skip: needsBash }, () => {
  assert.equal(ref('repo_from_remote_url', 'https://example.com/your-org/paraclete.git').status, 1);
  assert.equal(ref('repo_from_remote_url', '').status, 1);
});

test('an annotated tag resolves to its commit, not to the tag object', { skip: needsBash }, () => {
  assert.equal(out(ref('ref_commit', LISTING, RELEASE_TAG)), COMMITS.release);
});

test('a lightweight tag, a branch and a full commit resolve', { skip: needsBash }, () => {
  assert.equal(out(ref('ref_commit', LISTING, OLDER_TAG)), COMMITS.olderRelease);
  assert.equal(out(ref('ref_commit', LISTING, 'dev-branch')), COMMITS.devBranch);
  assert.equal(out(ref('ref_commit', LISTING, 'refs/heads/dev-branch')), COMMITS.devBranch);
  assert.equal(out(ref('ref_commit', LISTING, COMMITS.devBranch)), COMMITS.devBranch);
});

test('a tag wins over a branch of the same name, as in git', { skip: needsBash }, () => {
  const listing = `${LISTING}\n${COMMITS.main}\trefs/heads/${OLDER_TAG}`;
  assert.equal(out(ref('ref_commit', listing, OLDER_TAG)), COMMITS.olderRelease);
});

test('an unknown ref or an abbreviated commit does not resolve', { skip: needsBash }, () => {
  assert.equal(ref('ref_commit', LISTING, 'no-such-branch').status, 1);
  assert.equal(ref('ref_commit', LISTING, COMMITS.devBranch.slice(0, 7)).status, 1);
  assert.equal(ref('ref_commit', LISTING, 'dev').status, 1, 'a prefix of a branch name is not that branch');
});

test('finds the default branch from the HEAD symref', { skip: needsBash }, () => {
  assert.equal(out(ref('default_branch', LISTING)), 'main');
  assert.equal(ref('default_branch', `${COMMITS.main}\tHEAD`).status, 1);
});

test('the newest release tag compares versions number by number', { skip: needsBash }, () => {
  const listing = [
    `${COMMITS.main}\trefs/tags/v2026.10.17.9.1`,
    `${COMMITS.devBranch}\trefs/tags/v2026.10.17.10.1`,
    `${COMMITS.devBranch}\trefs/tags/v2026.10.17.10.1^{}`,
    `${COMMITS.release}\trefs/tags/v2026.09.30.12.4`,
  ].join('\n');
  assert.equal(out(ref('newest_release_tag', listing, CANONICAL)), 'v2026.10.17.10.1');
  assert.equal(out(ref('newest_release_tag', LISTING, CANONICAL)), RELEASE_TAG);
});

test('only an exact release version counts as a release tag', { skip: needsBash }, () => {
  const listing = [
    `${COMMITS.main}\trefs/tags/v2027.01.01.1.1-rc1`,
    `${COMMITS.main}\trefs/tags/nightly`,
    `${COMMITS.main}\trefs/heads/v2027.01.01.1.1`,
  ].join('\n');
  assert.equal(out(ref('newest_release_tag', listing, CANONICAL)), '');
});

test('is_commit takes only a full lowercase commit id', { skip: needsBash }, () => {
  assert.equal(ref('is_commit', COMMITS.main).status, 0);
  assert.equal(ref('is_commit', COMMITS.main.toUpperCase().replace(/1/g, 'A')).status, 1);
  assert.equal(ref('is_commit', COMMITS.main.slice(1)).status, 1);
});
