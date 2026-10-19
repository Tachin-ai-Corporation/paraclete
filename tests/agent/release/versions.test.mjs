// Tests for agent/release/versions.mjs: parsing and ordering versions, the version a commit message
// carries, GitHub's release list, which releases are newer than the installed one, and the URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, isVersion, versionFromText, compareVersions, isNewer, releasesFromGitHub, newerReleases,
  releasesUrl, commitUrl, RELEASES_PAGE_SIZE,
} from '../../../agent/release/versions.mjs';
import { loadContracts } from '../../../config/contracts.mjs';

test('a version is v, a date, an index and a subindex, whole', () => {
  assert.deepEqual(parseVersion('v2026.10.18.9.4'), { version: 'v2026.10.18.9.4', parts: [2026, 10, 18, 9, 4] });
  assert.deepEqual(parseVersion(' v2026.01.02.10.12 '), { version: 'v2026.01.02.10.12', parts: [2026, 1, 2, 10, 12] });
  for (const bad of ['2026.10.18.9.4', 'v2026.10.18.9', 'v2026.10.18.9.4.1', 'v2026.13.01.1.1', 'v2026.10.00.1.1',
    'v2026.10.18.9.4: text', 'main', '', null, undefined, 42]) {
    assert.equal(parseVersion(bad), null, String(bad));
    assert.equal(isVersion(bad), false, String(bad));
  }
});

test('the version a commit message starts with', () => {
  assert.equal(versionFromText('v2026.10.18.9.4: phase 8 is checked live'), 'v2026.10.18.9.4');
  assert.equal(versionFromText('v2026.10.18.9.4'), 'v2026.10.18.9.4');
  assert.equal(versionFromText('Merge branch main'), null);
  assert.equal(versionFromText('v2026.10.18.9.4.7: too many parts'), null);
  assert.equal(versionFromText('fix v2026.10.18.9.4'), null, 'only at the start');
});

test('the format is the contracts\' versioning.canonical_regex', () => {
  const canonical = new RegExp(loadContracts().versioning.canonical_regex);
  for (const text of ['v2026.10.18.9.4: x', 'v2026.01.02.10.12', 'v1999.12.31.0.0: y']) {
    assert.equal(versionFromText(text), canonical.exec(text)?.[1] ?? null, text);
  }
});

test('versions order by date, then index, then subindex, numerically', () => {
  assert.equal(compareVersions('v2026.10.18.9.4', 'v2026.10.18.9.4'), 0);
  assert.equal(compareVersions('v2026.10.18.9.4', 'v2026.10.18.9.10'), -1, '10 is after 4');
  assert.equal(compareVersions('v2026.10.18.10.1', 'v2026.10.18.9.9'), 1);
  assert.equal(compareVersions('v2026.10.19.1.1', 'v2026.10.18.99.99'), 1);
  assert.equal(compareVersions('v2027.01.01.1.1', 'v2026.12.31.9.9'), 1);
  assert.equal(compareVersions('v2026.10.18.9.4', 'main'), null);
  assert.equal(isNewer('v2026.10.19.1.1', 'v2026.10.18.9.4'), true);
  assert.equal(isNewer('v2026.10.18.9.4', 'v2026.10.18.9.4'), false);
  assert.equal(isNewer('v2026.10.19.1.1', null), false);
});

const gh = (tag, over = {}) => ({
  tag_name: tag, name: `Release ${tag}`, body: `notes for ${tag}`, html_url: `https://github.com/your-org/paraclete/releases/tag/${tag}`,
  published_at: '2026-10-19T10:00:00Z', draft: false, prerelease: false, ...over,
});

test("GitHub's release list: published version tags only, newest first", () => {
  const releases = releasesFromGitHub([
    gh('v2026.10.18.9.4'),
    gh('v2026.10.19.1.1'),
    gh('v2026.10.19.2.1', { draft: true }),
    gh('v2026.10.19.3.1', { prerelease: true }),
    gh('nightly'),
    gh('v2026.10.18.10.1', { name: '', body: null, html_url: 7 }),
    gh('v2026.10.19.1.1'),
    null,
    'junk',
  ]);
  assert.deepEqual(releases.map((r) => r.version), ['v2026.10.19.1.1', 'v2026.10.18.10.1', 'v2026.10.18.9.4']);
  assert.deepEqual(releases[1], { version: 'v2026.10.18.10.1', name: 'v2026.10.18.10.1', notes: '', url: null, published_at: '2026-10-19T10:00:00Z' });
  assert.equal(releases[0].notes, 'notes for v2026.10.19.1.1');
  assert.deepEqual(releasesFromGitHub({ message: 'API rate limit exceeded' }), [], 'an error answer is no releases');
});

test('the releases newer than the installed one, newest first; none when the installed one is unknown', () => {
  const releases = releasesFromGitHub([gh('v2026.10.18.9.4'), gh('v2026.10.19.1.1'), gh('v2026.10.20.1.1')]);
  assert.deepEqual(newerReleases(releases, 'v2026.10.18.9.4').map((r) => r.version), ['v2026.10.20.1.1', 'v2026.10.19.1.1']);
  assert.deepEqual(newerReleases(releases, 'v2026.10.20.1.1'), []);
  assert.deepEqual(newerReleases(releases, null), []);
  assert.deepEqual(newerReleases(releases, 'a1b2c3'), []);
});

test("the URLs for a repository's releases and a tag's commit; anything else is refused", () => {
  assert.equal(releasesUrl('your-org/paraclete'), `https://api.github.com/repos/your-org/paraclete/releases?per_page=${RELEASES_PAGE_SIZE}`);
  assert.equal(commitUrl('your-org/paraclete', 'v2026.10.19.1.1'), 'https://api.github.com/repos/your-org/paraclete/commits/v2026.10.19.1.1');
  assert.equal(commitUrl('your-org/paraclete', 'a'.repeat(40)), `https://api.github.com/repos/your-org/paraclete/commits/${'a'.repeat(40)}`);
  assert.throws(() => releasesUrl('not a repo'), /not a GitHub repository/);
  assert.throws(() => releasesUrl('../x'), /not a GitHub repository/);
  assert.throws(() => commitUrl('your-org/paraclete', 'main'), /neither a version nor a commit/);
  assert.throws(() => commitUrl('your-org/paraclete', 'v1/../x'), /neither a version nor a commit/);
});
