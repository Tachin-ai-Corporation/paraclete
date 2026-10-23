// Tests for dashboard/lib/server/auto-update.mjs: what one run of the automatic-update job decides
// (off; following an upgrade in progress; an instance installed from a branch or commit, never moved;
// up to date; the newest release; finishing a half-done upgrade; waiting for an idle agent, at most
// idle_wait_max_hours), and whole runs against the Firestore fake and a fake GitHub: an upgrade started
// as the dashboard's own account and followed until the run's time is up, its outcome kept in
// config/auto_update for the System tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import {
  AUTO_UPDATE_DOC, autoUpdateActor, autoUpdateDecision, readAutoUpdateStatus, runAutoUpdate,
} from '../../../../dashboard/lib/server/auto-update.mjs';
import { UPGRADE_DOC } from '../../../../dashboard/lib/server/upgrade.mjs';
import { installedVersion } from '../../../../dashboard/lib/server/releases.mjs';

const PROJECT = 'your-gcp-project';
const ACCOUNT = `paraclete-dashboard@${PROJECT}.iam.gserviceaccount.com`;
const V1 = 'v2027.01.10.1.1';
const V2 = 'v2027.01.15.2.1';
const V3 = 'v2027.01.20.1.1';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const NOW = new Date('2027-01-21T09:00:00.000Z');
const hours = (h) => new Date(NOW.getTime() + h * 3_600_000);
const sign = async () => 'header.payload.signature';
const releases = [V3, V2, V1].map((version) => ({ version }));

/** installedVersion() for an agent on `release` at `commit` and a dashboard on `dashboard`. */
const installed = (release, commit = A, dashboard = { release, commit }) => installedVersion({ status: 'ready', release, commit, version: release }, dashboard);

const decide = (o) => autoUpdateDecision({
  enabled: true, upgrade: null, installed: installed(V1), releases, busy: false, now: NOW, idleWaitMaxHours: 24, ...o,
});

test('off, an upgrade in progress, and an instance not installed from a release', () => {
  assert.equal(decide({ enabled: false }).action, 'off');
  const following = decide({ upgrade: { state: 'build', version: V2 } });
  assert.deepEqual([following.action, following.version], ['follow', V2]);
  assert.equal(decide({ upgrade: { state: 'done', version: V2 } }).action, 'install', 'a finished upgrade is history');
  for (const release of [A, 'my-feature-branch', '']) {
    const d = decide({ installed: installed(release, A, { release: 'main', commit: A }) });
    assert.equal(d.action, 'skip', release);
    assert.match(d.reason, /installed from a branch or commit: only an instance installed from a release updates itself/);
  }
  assert.equal(decide({ installed: installedVersion({ status: 'starting', release: V1, commit: A }, {}) }).action, 'skip');
});

test('the newest release, forward only; up to date; finishing a half-done upgrade first', () => {
  assert.deepEqual(decide({}).version, V3, 'the newest, not the next');
  assert.match(decide({}).reason, /v2027\.01\.20\.1\.1 is newer than v2027\.01\.10\.1\.1/);
  assert.equal(decide({ installed: installed(V3, C) }).action, 'none');
  assert.equal(decide({ installed: installed(V3, C), releases: [{ version: V1 }] }).action, 'none', 'never backward');
  const repair = decide({ installed: installed(V2, B, { release: V1, commit: A }) });
  assert.deepEqual([repair.action, repair.version], ['install', V2]);
  assert.match(repair.reason, /finishing the upgrade to v2027\.01\.15\.2\.1/);
  const unknown = decide({ releases: [], checkError: 'GitHub answered 403' });
  assert.deepEqual([unknown.action, unknown.reason], ['skip', 'the releases are not known: GitHub answered 403']);
});

test('a busy agent: wait from the first run that found it busy, for at most idle_wait_max_hours, then install', () => {
  const first = decide({ busy: true });
  assert.deepEqual([first.action, first.version, first.waiting_since], ['wait', V3, NOW.toISOString()]);
  const still = decide({ busy: true, now: hours(23), waitingSince: NOW.toISOString(), waitingFor: V3 });
  assert.deepEqual([still.action, still.waiting_since], ['wait', NOW.toISOString()]);
  const overdue = decide({ busy: true, now: hours(24), waitingSince: NOW.toISOString(), waitingFor: V3 });
  assert.equal(overdue.action, 'install');
  assert.match(overdue.reason, /stayed busy for 24 h, so it installs now/);
  const newTarget = decide({ busy: true, now: hours(30), waitingSince: NOW.toISOString(), waitingFor: V2 });
  assert.deepEqual([newTarget.action, newTarget.waiting_since], ['wait', hours(30).toISOString()], 'a wait for another release starts again');
  assert.equal(decide({ busy: false, waitingSince: NOW.toISOString(), waitingFor: V3 }).action, 'install');
});

/** GitHub, faked: the releases and their commits. */
function fakeGitHub() {
  const answer = (status, body) => new Response(JSON.stringify(body), { status });
  const commits = { [V1]: A, [V2]: B, [V3]: C };
  return async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/your-org/paraclete/releases?per_page=30') {
      return answer(200, [V3, V2, V1].map((tag) => ({ tag_name: tag, name: tag, body: `- ${tag}`, html_url: `https://github.com/x/${tag}`, published_at: '2027-01-20T10:00:00Z' })));
    }
    const commit = /^https:\/\/api\.github\.com\/repos\/your-org\/paraclete\/commits\/(.+)$/.exec(u);
    if (commit && commits[commit[1]]) return answer(200, { sha: commits[commit[1]] });
    return answer(599, { error: { message: `unexpected call ${u}` } });
  };
}

/** A dashboard on V1 (agent and dashboard alike), with a virtual clock its runs advance. */
async function instance(t, { agent = { status: 'ready', release: V1, commit: A, version: V1 }, docs = {} } = {}) {
  const dash = await startDashboard({ env: { PARACLETE_REPO: 'your-org/paraclete', PARACLETE_RELEASE: V1, PARACLETE_COMMIT: A }, fetch: fakeGitHub() });
  t.after(dash.stop);
  await dash.seed({ 'agent/instance': agent, ...docs });
  let ms = NOW.getTime();
  const sleeps = [];
  const run = (at = NOW) => {
    ms = at.getTime();
    return runAutoUpdate(dash.runtime, {
      clock: () => new Date(ms), sleep: async (d) => { sleeps.push(d); ms += d; }, budgetMs: 60_000, sign,
    });
  };
  return { ...dash, run, sleeps };
}

test('a run on an idle instance starts the upgrade to the newest release as the dashboard, follows it, and records the outcome', async (t) => {
  const dash = await instance(t);
  const result = await dash.run();
  assert.deepEqual([result.action, result.version], ['install', V3]);
  assert.equal(result.upgrade.state, 'vm', 'the VM is still working when the run is out of time');
  assert.ok(dash.sleeps.length > 0 && dash.sleeps.every((d) => d === dash.runtime.contracts.auto_update.advance_interval_seconds * 1000));

  const upgrade = await dash.doc(`config/${UPGRADE_DOC}`);
  assert.deepEqual([upgrade.version, upgrade.commit, upgrade.requested_by], [V3, C, ACCOUNT]);
  const command = await dash.doc(`commands/${upgrade.vm_command_id}`);
  assert.deepEqual({ type: command.type, params: command.params, by: command.requested_by, signature: command.signature },
    { type: 'upgrade', params: { ref: V3 }, by: ACCOUNT, signature: 'header.payload.signature' }, 'the same signed command the Install button sends');

  const status = await readAutoUpdateStatus(dash.runtime);
  assert.deepEqual([status.action, status.version, status.upgrade_state, status.checked_at], ['install', V3, 'vm', NOW.toISOString()]);
  assert.deepEqual(autoUpdateActor(dash.runtime), { email: ACCOUNT, role: 'admin' });

  const next = await dash.run(hours(0.5));
  assert.deepEqual([next.action, next.version], ['follow', V3], 'the next run picks the upgrade up');
});

test('turned off: nothing is read from GitHub and nothing is started', async (t) => {
  const dash = await instance(t, { docs: { 'config/settings': { auto_update: false } } });
  const result = await dash.run();
  assert.equal(result.action, 'off');
  assert.equal(await dash.doc(`config/${UPGRADE_DOC}`), null);
  assert.equal((await dash.doc(`config/${AUTO_UPDATE_DOC}`)).action, 'off');
  assert.equal(await dash.doc('config/release_check'), null, 'GitHub is not asked');
});

test('a dev instance deployed from a commit is never moved', async (t) => {
  const dash = await instance(t, { agent: { status: 'ready', release: A, commit: A, version: 'v2027.01.21.5.1' } });
  const result = await dash.run();
  assert.equal(result.action, 'skip');
  assert.equal(await dash.doc(`config/${UPGRADE_DOC}`), null);
});

test('a running mission makes runs wait, then the run after idle_wait_max_hours installs anyway', async (t) => {
  const dash = await instance(t, { docs: { 'work/w-1': { id: 'w-1', type: 'M', status: 'active', created_at: NOW.toISOString() } } });
  const first = await dash.run();
  assert.equal(first.action, 'wait');
  assert.equal(await dash.doc(`config/${UPGRADE_DOC}`), null);
  const waiting = await readAutoUpdateStatus(dash.runtime);
  assert.deepEqual([waiting.waiting_since, waiting.waiting_for], [NOW.toISOString(), V3]);
  assert.equal((await dash.run(hours(12))).action, 'wait');
  assert.equal((await readAutoUpdateStatus(dash.runtime)).waiting_since, NOW.toISOString(), 'the wait counts from the first run');
  const overdue = await dash.run(hours(24));
  assert.equal(overdue.action, 'install');
  assert.equal((await dash.doc(`config/${UPGRADE_DOC}`)).version, V3);
});

test('an upgrade an admin started is followed, not started again', async (t) => {
  const dash = await instance(t, {
    docs: { [`config/${UPGRADE_DOC}`]: { id: 'u-1', version: V2, commit: B, requested_by: 'admin@example.com', requested_at: NOW.toISOString(), state: 'vm', vm_command_id: null, build_id: null, operation: null, error: null, updated_at: NOW.toISOString() } },
  });
  const result = await dash.run();
  assert.deepEqual([result.action, result.version], ['follow', V2]);
  assert.equal((await dash.doc(`config/${UPGRADE_DOC}`)).requested_by, 'admin@example.com');
});
