// Tests for dashboard/lib/server/releases.mjs, against the Firestore fake and a fake GitHub: what the
// instance runs (the VM's ready release, else the dashboard's own); GitHub's list, kept in
// config/release_check for the contracts' time and asked for again after it; an admin's early
// refresh, at most every five minutes; a failed check keeping the releases it had; a check stored by
// another dashboard first winning; and which versions may be installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import {
  MAX_NOTES_CHARS, RELEASE_CHECK_DOC, REFRESH_FLOOR_SECONDS, installRefusal, installedVersion, readReleases,
} from '../../../../dashboard/lib/server/releases.mjs';

const admin = { email: 'admin@example.com', role: 'admin' };
const member = { email: 'member@example.com', role: 'member' };
const V1 = 'v2027.01.10.1.1';
const V2 = 'v2027.01.15.2.1';
const V3 = 'v2027.01.20.1.1';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = new Date('2027-01-21T09:00:00.000Z');
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const ENV = { PARACLETE_REPO: 'your-org/paraclete', PARACLETE_RELEASE: V1, PARACLETE_COMMIT: A };
const RELEASES_URL = 'https://api.github.com/repos/your-org/paraclete/releases?per_page=30';

const release = (tag, extra = {}) => ({
  tag_name: tag, name: `Release ${tag}`, body: `- what ${tag} changed`, html_url: `https://github.com/your-org/paraclete/releases/tag/${tag}`,
  published_at: '2027-01-20T10:00:00Z', draft: false, prerelease: false, ...extra,
});

/** GitHub's releases API: answers `releases`, or a refusal, counting each call. */
function fakeGitHub({ releases = [release(V2), release(V1), release('v2027.01.30.1.1', { draft: true }), release('v2027.01.31.1.1', { prerelease: true })] } = {}) {
  const github = { calls: [], releases, status: 200, onCall: null };
  github.fetch = async (url, init = {}) => {
    github.calls.push({ url: String(url), headers: init.headers || {} });
    if (github.onCall) await github.onCall();
    if (github.status === 403) {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2027-01-21T10:00:00Z') / 1000) },
      });
    }
    return new Response(JSON.stringify(github.releases), { status: github.status });
  };
  return github;
}

async function dashboard(t, { env = ENV, github = fakeGitHub(), agent = { status: 'ready', release: V1, commit: A } } = {}) {
  const dash = await startDashboard({ env, fetch: github.fetch });
  t.after(dash.stop);
  if (agent) await dash.seed({ 'agent/instance': agent });
  return { ...dash, github };
}

test('what the instance runs: the VM when it reports a ready release, else the dashboard, and never a branch', () => {
  const same = installedVersion({ status: 'ready', release: V2, commit: B }, { release: V2, commit: B });
  assert.deepEqual({ version: same.version, source: same.source, matched: same.matched, repair: same.repair }, { version: V2, source: 'agent', matched: true, repair: null });

  const half = installedVersion({ status: 'ready', release: V2, commit: B }, { release: V1, commit: A });
  assert.deepEqual({ version: half.version, matched: half.matched, repair: half.repair }, { version: V2, matched: false, repair: V2 },
    'the VM moved and the dashboard did not: installing V2 again finishes it');

  const failed = installedVersion({ status: 'failed', release: V2, commit: B }, { release: V1, commit: A });
  assert.deepEqual({ version: failed.version, source: failed.source, repair: failed.repair }, { version: V1, source: 'dashboard', repair: null },
    'a failed run names the release it tried, not the one it kept');

  const byCommit = installedVersion({ status: 'ready', release: A, commit: A }, { release: V1, commit: A });
  assert.equal(byCommit.version, V1, 'a VM moved to the commit by dev/deploy.mjs: the dashboard names its release');

  const branch = installedVersion({ status: 'ready', release: 'main', commit: A }, { release: 'main', commit: A });
  assert.deepEqual({ version: branch.version, source: branch.source, matched: branch.matched }, { version: null, source: null, matched: true });
  assert.equal(installedVersion(null, {}).agent.status, 'unknown');
});

test("GitHub's list is read once, stored, and shown newest first: drafts and prereleases left out, the newer ones with notes", async (t) => {
  const dash = await dashboard(t);
  const view = await readReleases(dash.runtime, { user: admin, now: NOW });
  assert.equal(dash.github.calls.length, 1);
  assert.equal(dash.github.calls[0].url, RELEASES_URL);
  assert.equal(dash.github.calls[0].headers['User-Agent'], 'paraclete-dashboard', 'GitHub refuses a request without a user agent');
  assert.equal(view.repo, 'your-org/paraclete');
  assert.equal(view.installed.version, V1);
  assert.deepEqual(view.newer.map((r) => r.version), [V2]);
  assert.deepEqual(view.newer[0], {
    version: V2, name: `Release ${V2}`, notes: `- what ${V2} changed`, url: `https://github.com/your-org/paraclete/releases/tag/${V2}`, published_at: '2027-01-20T10:00:00Z',
  });
  assert.equal(view.latest.version, V2);
  assert.equal(view.current.version, V1);
  assert.equal(view.error, null);
  assert.equal(view.checked_at, NOW.toISOString());
  assert.equal(view.refresh_at, later(REFRESH_FLOOR_SECONDS).toISOString(), 'admins learn when they may ask again');

  const stored = await dash.doc(`config/${RELEASE_CHECK_DOC}`);
  assert.deepEqual(Object.keys(stored).sort(), ['checked_at', 'error', 'releases', 'repo']);
  assert.deepEqual(stored.releases.map((r) => r.version), [V2, V1]);

  const forMember = await readReleases(dash.runtime, { user: member, now: later(60) });
  assert.equal(dash.github.calls.length, 1, 'within the time the contracts give, nobody asks GitHub again');
  assert.deepEqual(forMember.newer.map((r) => r.version), [V2]);
  assert.ok(!('refresh_at' in forMember));
});

test('the stored list is asked for again once it is older than release_check_ttl_seconds', async (t) => {
  const dash = await dashboard(t);
  const ttl = dash.runtime.contracts.dashboard.release_check_ttl_seconds;
  await readReleases(dash.runtime, { user: member, now: NOW });
  dash.github.releases = [release(V3), release(V2), release(V1)];
  await readReleases(dash.runtime, { user: member, now: later(ttl - 1) });
  assert.equal(dash.github.calls.length, 1);
  const view = await readReleases(dash.runtime, { user: member, now: later(ttl + 1) });
  assert.equal(dash.github.calls.length, 2);
  assert.deepEqual(view.newer.map((r) => r.version), [V3, V2]);
});

test('an admin may ask again early, but not twice within five minutes; a member may not', async (t) => {
  const dash = await dashboard(t);
  await readReleases(dash.runtime, { user: admin, now: NOW });
  await assert.rejects(readReleases(dash.runtime, { user: member, refresh: true, now: later(600) }), (err) => err.status === 403);
  await assert.rejects(readReleases(dash.runtime, { user: admin, refresh: true, now: later(100) }),
    (err) => err.status === 429 && /asked 100 s ago; ask again in 200 s/.test(err.message));
  assert.equal(dash.github.calls.length, 1);
  await readReleases(dash.runtime, { user: admin, refresh: true, now: later(REFRESH_FLOOR_SECONDS) });
  assert.equal(dash.github.calls.length, 2);
});

test("a failed check keeps the releases it had and says why, with the time GitHub's limit lifts", async (t) => {
  const dash = await dashboard(t);
  const ttl = dash.runtime.contracts.dashboard.release_check_ttl_seconds;
  await readReleases(dash.runtime, { user: member, now: NOW });
  dash.github.status = 403;
  const view = await readReleases(dash.runtime, { user: member, now: later(ttl + 1) });
  assert.match(view.error, /GitHub's limit of 60 requests an hour from the dashboard's address is used up until 2027-01-21T10:00:00\.000Z/);
  assert.deepEqual(view.newer.map((r) => r.version), [V2], 'the releases it had stay');
  const stored = await dash.doc(`config/${RELEASE_CHECK_DOC}`);
  assert.equal(stored.checked_at, later(ttl + 1).toISOString(), 'and GitHub is not asked again for another hour');
  assert.ok(dash.lines.some((l) => l.level === 'WARN' && /release check: GitHub's limit/.test(l.message)));

  dash.github.status = 500;
  const unreachable = await readReleases(dash.runtime, { user: admin, refresh: true, now: later(ttl + 1 + REFRESH_FLOOR_SECONDS) });
  assert.match(unreachable.error, /GitHub answered 500 for the releases of your-org\/paraclete/);
});

test('a list stored by another dashboard while this one asked GitHub is the one kept', async (t) => {
  const dash = await dashboard(t);
  dash.github.onCall = async () => {
    dash.github.onCall = null;
    await dash.seed({ [`config/${RELEASE_CHECK_DOC}`]: { repo: 'your-org/paraclete', checked_at: NOW.toISOString(), releases: [{ version: V3, name: 'Other', notes: '' }], error: null } });
  };
  const view = await readReleases(dash.runtime, { user: member, now: NOW });
  assert.deepEqual(view.newer.map((r) => r.version), [V3]);
  assert.equal((await dash.doc(`config/${RELEASE_CHECK_DOC}`)).releases[0].name, 'Other');
});

test('another repository, no repository, and notes too long to keep', async (t) => {
  const dash = await dashboard(t);
  await dash.seed({ [`config/${RELEASE_CHECK_DOC}`]: { repo: 'someone/fork', checked_at: NOW.toISOString(), releases: [], error: null } });
  dash.github.releases = [release(V2, { body: 'x'.repeat(MAX_NOTES_CHARS + 50) })];
  const view = await readReleases(dash.runtime, { user: member, now: NOW });
  assert.equal(dash.github.calls.length, 1, "a list kept for another repository is not this one's");
  assert.equal(view.newer[0].notes.length < MAX_NOTES_CHARS + 100, true);
  assert.match(view.newer[0].notes, /The notes go on at the release's page on GitHub\.\)$/);

  const bare = await dashboard(t, { env: { PARACLETE_RELEASE: V1, PARACLETE_COMMIT: A } });
  const none = await readReleases(bare.runtime, { user: admin, now: NOW });
  assert.equal(none.repo, null);
  assert.match(none.error, /does not know which repository it was installed from \(PARACLETE_REPO/);
  assert.deepEqual(none.newer, []);
  assert.equal(bare.github.calls.length, 0);
});

test('an instance installed from a branch is offered nothing', async (t) => {
  const dash = await dashboard(t, { env: { ...ENV, PARACLETE_RELEASE: 'main' }, agent: { status: 'ready', release: 'main', commit: A } });
  const view = await readReleases(dash.runtime, { user: admin, now: NOW });
  assert.equal(view.installed.version, null);
  assert.deepEqual(view.newer, []);
  assert.equal(view.latest.version, V2);
});

test('the release an upgrade left half-done is offered again while it is published', async (t) => {
  const dash = await dashboard(t, { agent: { status: 'ready', release: V2, commit: B } });
  const view = await readReleases(dash.runtime, { user: admin, now: NOW });
  assert.equal(view.installed.version, V2);
  assert.equal(view.repair, V2);
  assert.deepEqual(view.newer, []);
});

test('a newer release may be installed, or the same one again; an older one, or any on a branch install, may not', () => {
  assert.equal(installRefusal(V2, V1), null);
  assert.equal(installRefusal(V2, V2), null);
  assert.match(installRefusal(V1, V2), /v2027\.01\.10\.1\.1 is older than v2027\.01\.15\.2\.1.*only installs newer releases/);
  assert.match(installRefusal(V2, null), /does not run a release .* install\/install\.sh --ref <version>/);
});
