// Tests for dev/status.mjs: one SSH call with the exact gcloud arguments reads the release, the five
// units, the heartbeats and the gateway's /status (the token never on a command line); Firestore gives
// agent/instance and the newest missions; `gcloud run services describe` gives the dashboard's URL and
// commit; and the exit code says whether a service is down or hung, or the installed commit,
// agent/instance and the dashboard disagree.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { main, parseStatusProbe, statusProbeCommand } from '../../dev/status.mjs';
import { assertNoShell, devDeps, expectedSsh, fakeExec } from './fakes.mjs';

const COMMIT = 'a'.repeat(40);
const SERVICES = ['gateway', 'brain', 'ears', 'mouth', 'control'];
const { gateway } = loadContracts();
const PROBE = statusProbeCommand(`http://${gateway.bind}:${gateway.port}`);

let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

/** What the probe prints on a VM, part by part. */
function probeOutput({ units = {}, beats = {}, release = { version: 'v2026.10.17.5.1', ref: 'main', commit: COMMIT, repo: 'your-org/paraclete', installed_at: '2026-10-17T11:58:00Z' }, gatewayStatus } = {}) {
  const lines = ['@@release', release ? JSON.stringify(release) : '', '', '@@units'];
  for (const s of SERVICES) lines.push(units[s] || 'active');
  for (const s of SERVICES) {
    lines.push('', `@@health ${s}`);
    const beat = beats[s] === undefined ? (['brain', 'ears', 'mouth'].includes(s) ? '2026-10-17T11:59:58Z' : null) : beats[s];
    if (beat) lines.push(JSON.stringify({ beat_at: beat, last_ok_at: beat }));
  }
  lines.push('', '@@gateway', JSON.stringify(gatewayStatus ?? { uptime_sec: 120, requests: 4, sessions: [{ id: 's1' }], models: { cortex: 'vertex-google/gemini-4-argon', fast: 'vertex-google/gemini-3.8-flash' } }));
  lines.push('', '@@now', '2026-10-17T12:00:00Z', '');
  return lines.join('\n');
}

async function seed({ commit = COMMIT, status = 'ready' } = {}) {
  if (commit) await db.write('agent/instance', { status, release: 'main', commit, ready_at: '2026-10-17T11:59:00.000Z' });
  for (let i = 1; i <= 7; i += 1) {
    await db.write(`work/w-${i}`, { id: `w-${i}`, type: 'M', status: i === 7 ? 'active' : 'complete', created_at: `2026-10-17T10:0${i}:00.000Z`, instruction: `Mission number ${i}\nwith a second line` });
  }
  await db.write('work/t-9', { id: 't-9', type: 'T', status: 'complete', created_at: '2026-10-17T11:00:00.000Z', instruction: 'a task, not a mission' });
}

const DASHBOARD_URL = 'https://paraclete-123456789012.us-central1.run.app';
const IMAGE = 'us-central1-docker.pkg.dev/your-gcp-project/paraclete/dashboard';
const DESCRIBE = ['run', 'services', 'describe', 'paraclete', '--region=us-central1', '--project=your-gcp-project', '--format=json'];

/** What `gcloud run services describe --format=json` answers for a dashboard running image. */
const described = (image = `${IMAGE}:${COMMIT}`) => ({
  stdout: JSON.stringify({ metadata: { name: 'paraclete' }, spec: { template: { spec: { containers: [{ image }] } } }, status: { url: DASHBOARD_URL } }),
});

function run(argv, { output = probeOutput(), code = 0, dashboard = described() } = {}) {
  const exec = fakeExec((program, args) => {
    if (args[0] === 'compute') return { code, stdout: output };
    if (args.slice(0, 3).join(' ') === 'run services describe') return dashboard;
    return undefined;
  });
  const deps = devDeps({ firestore, exec });
  return main(argv, deps).then((exit) => ({ exit, exec, out: deps.stdout.text, err: deps.stderr.text }));
}

test('the probe is one command: release, units, heartbeats, the gateway with its token from a file, and the VM clock', () => {
  const parts = PROBE.split('; ');
  assert.ok(parts.includes('sudo cat /opt/paraclete/release.json'));
  assert.ok(parts.includes('systemctl is-active paraclete-gateway.service paraclete-brain.service paraclete-ears.service paraclete-mouth.service paraclete-control.service'));
  for (const s of SERVICES) assert.ok(parts.includes(`sudo cat /var/lib/paraclete/services/${s}/health.json 2>/dev/null`), s);
  assert.ok(parts.includes(`sudo sed 's/^/Authorization: Bearer /' /etc/paraclete/gateway-token | curl -s -m 5 -H @- http://127.0.0.1:${gateway.port}/status`),
    'the token goes from its file to curl on stdin, never into an argument');
  assert.ok(parts.includes('date -u +%Y-%m-%dT%H:%M:%SZ'));
});

test('a healthy instance: the release, every service, the gateway, agent/instance and the five newest missions', async () => {
  await seed();
  const r = await run([]);
  assert.equal(r.exit, 0, r.out + r.err);
  assert.deepEqual(r.exec.calls.filter((c) => c.args[0] === 'compute').map((c) => c.args), [expectedSsh(PROBE)]);
  assertNoShell(r.exec.calls);

  assert.match(r.out, /^VM paraclete in your-gcp-project \(us-central1-a\)$/m);
  assert.match(r.out, /release {8}v2026\.10\.17\.5\.1 {2}commit a{40} {2}ref main {2}repo your-org\/paraclete/);
  assert.match(r.out, /agent\/instance ready on a{40} since 2026-10-17T11:59:00\.000Z/);
  assert.match(r.out, /brain {4}active {5}heartbeat 2 s ago/);
  assert.match(r.out, /gateway {2}active {5}no heartbeat file/);
  assert.match(r.out, /gateway {8}up 120 s, 4 requests, 1 sessions; cortex=vertex-google\/gemini-4-argon, fast=vertex-google\/gemini-3\.8-flash/);
  assert.deepEqual(r.exec.calls.filter((c) => c.args[0] === 'run').map((c) => c.args), [DESCRIBE]);
  assert.match(r.out, new RegExp(`dashboard {6}${DASHBOARD_URL.replace(/\./g, '\\.')} {2}commit a{40} \\(the VM's commit\\)`));
  const missions = [...r.out.matchAll(/^ {2}(w-\d) /gm)].map((m) => m[1]);
  assert.deepEqual(missions, ['w-7', 'w-6', 'w-5', 'w-4', 'w-3'], 'missions only, newest first');
  assert.match(r.out, /w-7 {2}active {13}2026-10-17T10:07:00\.000Z {2}Mission number 7 with a second line/);
  assert.match(r.out, /All services up; the VM, agent\/instance and the dashboard are on the same commit\./);
});

test('a down unit, a stale heartbeat, a commit mismatch or a missing release fail the status', async () => {
  await seed({ commit: 'b'.repeat(40) });
  const r = await run([], { output: probeOutput({ units: { mouth: 'failed' }, beats: { ears: '2026-10-17T11:58:00Z' } }) });
  assert.equal(r.exit, 1);
  assert.match(r.out, /PROBLEMS:/);
  assert.match(r.out, /- mouth is failed/);
  assert.match(r.out, /- ears's heartbeat is stale \(120 s old\)/);
  assert.match(r.out, /ears {5}active {5}heartbeat 120 s ago \(STALE\)/);
  assert.match(r.out, /- the VM has a{40} installed but agent\/instance reports b{40}/);

  firestore.reset();
  const missing = await run([], { output: probeOutput({ release: null }) });
  assert.equal(missing.exit, 1);
  assert.match(missing.out, /- \/opt\/paraclete\/release\.json is missing/);
  assert.match(missing.out, /- agent\/instance does not exist/);
  assert.match(missing.out, /Newest missions \(0\)\n {2}none/);
});

test('an unreachable VM still shows what Firestore knows, and fails', async () => {
  await seed();
  const r = await run([], { output: '', code: 255 });
  assert.equal(r.exit, 1);
  assert.match(r.out, /- the VM could not be reached: gcloud compute ssh exited with code 255/);
  assert.match(r.out, /agent\/instance ready on a{40}/);
});

test('--json prints the report as one object', async () => {
  await seed();
  const r = await run(['--json']);
  const report = JSON.parse(r.out);
  assert.equal(r.exit, 0);
  assert.deepEqual(report.services.brain, { unit: 'paraclete-brain.service', active: 'active', heartbeat: { beat_at: '2026-10-17T11:59:58Z', age_sec: 2, stale: false } });
  assert.equal(report.services.control.heartbeat, null);
  assert.equal(report.release.commit, COMMIT);
  assert.equal(report.missions.length, 5);
  assert.deepEqual(report.dashboard, {
    service: 'paraclete', region: 'us-central1', url: DASHBOARD_URL, image: `${IMAGE}:${COMMIT}`, commit: COMMIT, matches_vm: true,
  });
  assert.deepEqual(report.problems, []);
  assert.equal((await run(['--verbose'])).exit, 2);
});

test('a dashboard on another commit, on an untagged image, or missing fails the status', async () => {
  await seed();
  const other = await run([], { dashboard: described(`${IMAGE}:${'c'.repeat(40)}`) });
  assert.equal(other.exit, 1);
  assert.match(other.out, /dashboard {6}\S+ {2}commit c{40} \(the VM has a{40}\)/);
  assert.match(other.out, /- the dashboard runs c{40} but the VM has a{40} installed/);

  const latest = await run([], { dashboard: described(`${IMAGE}:latest`) });
  assert.equal(latest.exit, 1);
  assert.match(latest.out, /- the dashboard runs \S+dashboard:latest, which is not tagged with a commit/);

  const missing = await run([], { dashboard: { code: 1, stderr: 'ERROR: (gcloud.run.services.describe) Cannot find service [paraclete]\n' } });
  assert.equal(missing.exit, 1);
  assert.match(missing.out, /dashboard {6}not checked: there is no service paraclete in us-central1/);
  assert.match(missing.out, /- the dashboard could not be checked: there is no service paraclete in us-central1/);

  const denied = await run([], { dashboard: { code: 1, stderr: 'ERROR: PERMISSION_DENIED: no\n' } });
  assert.match(denied.out, /- the dashboard could not be checked: gcloud run services describe failed: ERROR: PERMISSION_DENIED: no/);
});

test('the probe output parses with CRLF line ends and missing parts', () => {
  const parsed = parseStatusProbe(probeOutput({ gatewayStatus: {} }).replace(/\n/g, '\r\n'));
  assert.equal(parsed.units.brain, 'active');
  assert.equal(parsed.release.commit, COMMIT);
  assert.equal(parsed.now, '2026-10-17T12:00:00Z');
  const empty = parseStatusProbe('@@units\nactive\n@@gateway\nnot json\n');
  assert.deepEqual(empty.units, { gateway: 'active', brain: 'unknown', ears: 'unknown', mouth: 'unknown', control: 'unknown' });
  assert.equal(empty.release, null);
  assert.deepEqual(empty.gateway, { unreadable: 'not json' });
  assert.equal(empty.health.brain, null);
});
