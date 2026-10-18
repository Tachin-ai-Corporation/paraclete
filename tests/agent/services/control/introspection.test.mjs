// Tests for agent/services/control/introspection.mjs: the status view covers every service and still
// answers when one cannot be read; skills are listed from every directory in catalog order; the
// configuration view never carries the token; and file contents stay inside the Firestore document
// limit with every cut marked. Fake systemd; files in a temp tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contentBudget, readRelease, readStatus, readSkills, readConfig, readWorkspace, readHeartbeat, heartbeatFile,
  HEARTBEAT_STALE_SECONDS,
} from '../../../../agent/services/control/introspection.mjs';
import { controlRuntime, fakeSystemd, GATEWAY_TOKEN } from './fakes.mjs';

function skill(dir, id, manifest = {}, md = `# ${id}\nHow to use ${id}.`) {
  mkdirSync(join(dir, id), { recursive: true });
  if (manifest !== null) writeFileSync(join(dir, id, 'skill.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ id, name: id, version: '1.0.0', ...manifest }));
  if (md !== null) writeFileSync(join(dir, id, 'SKILL.md'), md);
}

test('the content budget cuts each file and then the total, and marks every cut', () => {
  const budget = contentBudget(100 * 1024);
  const big = budget('x'.repeat(70 * 1024));
  assert.equal(big.content.length, 64 * 1024);
  assert.equal(big.truncated, true);
  assert.deepEqual(budget('short'), { content: 'short', truncated: false });
  assert.deepEqual(budget('y'.repeat(40 * 1024)), { content: null, truncated: true });
});

test('the release record is read from the install root, and its absence is null', () => {
  const runtime = controlRuntime();
  assert.equal(readRelease(runtime.paths.installRoot), null);
  writeFileSync(join(runtime.paths.installRoot, 'release.json'), JSON.stringify({ version: 'v2026.10.17.1.1', commit: 'abc' }));
  assert.deepEqual(readRelease(runtime.paths.installRoot), { version: 'v2026.10.17.1.1', commit: 'abc' });
  writeFileSync(join(runtime.paths.installRoot, 'release.json'), 'not json');
  assert.equal(readRelease(runtime.paths.installRoot), null);
});

test('status reports every service, the gateway, the release and the host, even when one unit cannot be read', async () => {
  const runtime = controlRuntime();
  const systemd = fakeSystemd({ states: { ears: { active: 'failed', sub: 'failed', result: 'exit-code' }, mouth: new Error('dbus timeout') } });
  const status = await readStatus({
    systemd, probe: async () => ({ reachable: true, ready: true }), installRoot: runtime.paths.installRoot,
    dataRoot: runtime.paths.data.root, now: () => new Date('2026-10-17T12:00:00.000Z'),
  });
  assert.equal(status.checked_at, '2026-10-17T12:00:00.000Z');
  assert.deepEqual(Object.keys(status.services), ['gateway', 'brain', 'ears', 'mouth', 'control']);
  assert.equal(status.services.brain.active, 'active');
  assert.equal(status.services.brain.heartbeat, null, 'no health file, no heartbeat');
  assert.equal(status.services.ears.active, 'failed');
  assert.deepEqual(status.services.mouth, { service: 'mouth', error: 'dbus timeout', heartbeat: null });
  assert.deepEqual(status.gateway, { reachable: true, ready: true });
  assert.equal(status.release, null);
  assert.equal(typeof status.host.hostname, 'string');
  assert.equal(status.control.pid, process.pid);
});

test('a heartbeat is the service health file plus its age; an old or missing beat is stale', () => {
  const runtime = controlRuntime();
  const root = runtime.paths.data.root;
  const now = () => new Date('2026-10-17T12:00:00.000Z');
  const write = (service, body) => {
    mkdirSync(join(root, 'services', service), { recursive: true });
    writeFileSync(heartbeatFile(root, service), typeof body === 'string' ? body : JSON.stringify(body));
  };
  write('ears', { service: 'ears', beat_at: '2026-10-17T11:59:50.000Z', dashboard: { last_ok_at: '2026-10-17T11:59:50.000Z', last_error: null } });
  write('mouth', { service: 'mouth', beat_at: '2026-10-17T11:55:00.000Z', last_error: 'delivery poll failed' });
  write('brain', 'half a file');
  write('gateway', { service: 'gateway' });

  const ears = readHeartbeat(root, 'ears', { now });
  assert.equal(ears.age_sec, 10);
  assert.equal(ears.stale, false);
  assert.deepEqual(ears.dashboard, { last_ok_at: '2026-10-17T11:59:50.000Z', last_error: null });
  assert.equal(ears.file.replace(/\\/g, '/').endsWith('/services/ears/health.json'), true);

  const mouth = readHeartbeat(root, 'mouth', { now });
  assert.equal(mouth.age_sec, 300);
  assert.equal(mouth.stale, true, `older than ${HEARTBEAT_STALE_SECONDS}s`);
  assert.equal(mouth.last_error, 'delivery poll failed');

  assert.deepEqual(readHeartbeat(root, 'brain', { now }), { file: heartbeatFile(root, 'brain'), stale: true, error: 'the health file is not valid JSON' });
  assert.equal(readHeartbeat(root, 'gateway', { now }).stale, true, 'a health file without a beat is stale');
  assert.equal(readHeartbeat(root, 'control', { now }), null);
});

test('status carries each service heartbeat beside its systemd state', async () => {
  const runtime = controlRuntime();
  const root = runtime.paths.data.root;
  mkdirSync(join(root, 'services', 'ears'), { recursive: true });
  writeFileSync(heartbeatFile(root, 'ears'), JSON.stringify({ beat_at: '2026-10-17T11:59:59.000Z' }));
  const status = await readStatus({
    systemd: fakeSystemd(), probe: async () => ({}), installRoot: runtime.paths.installRoot, dataRoot: root,
    now: () => new Date('2026-10-17T12:00:00.000Z'),
  });
  assert.equal(status.services.ears.active, 'active');
  assert.equal(status.services.ears.heartbeat.age_sec, 1);
  assert.equal(status.services.ears.heartbeat.stale, false);
});

test('skills come from the base, the generic role, the chosen role and the agent, in that order', () => {
  const runtime = controlRuntime({ role: 'analyst' });
  const { paths } = runtime;
  skill(paths.skills, 'files', { when_to_use: 'Working with files', organs: ['motor'], commands: ['file-convert'] });
  skill(paths.skills, 'drive');
  skill(join(paths.genericRole, 'skills'), 'memory-consolidate', { organs: ['temporal-memory'] });
  skill(join(paths.role, 'skills'), 'sql');
  skill(paths.data.skills, 'my-report', {}, null);
  skill(paths.data.skills, 'broken', '{ nope');
  mkdirSync(join(paths.data.skills, 'empty-dir'));

  const { skills } = readSkills({ paths, instance: runtime.instance });
  assert.deepEqual(skills.map((s) => [s.origin, s.id]), [
    ['base', 'drive'], ['base', 'files'], ['role:generic', 'memory-consolidate'], ['role:analyst', 'sql'],
    ['agent', 'broken'], ['agent', 'my-report'],
  ]);
  const files = skills.find((s) => s.id === 'files');
  assert.equal(files.when_to_use, 'Working with files');
  assert.deepEqual(files.organs, ['motor']);
  assert.deepEqual(files.commands, ['file-convert']);
  assert.match(files.skill_md, /How to use files/);
  assert.equal(files.skill_md_truncated, false);
  assert.equal(skills.find((s) => s.id === 'my-report').problem, 'no SKILL.md');
  assert.match(skills.find((s) => s.id === 'broken').problem, /skill\.json is not valid JSON/);
});

test('a skill that needs a Workspace account is marked unavailable on an instance without one', () => {
  const runtime = controlRuntime();
  const { paths } = runtime;
  skill(paths.skills, 'workspace-calendar', { requires: ['workspace'], organs: ['motor'] });
  skill(paths.skills, 'files', { organs: ['motor'] });

  const without = readSkills({ paths, instance: runtime.instance });
  const calendar = without.skills.find((s) => s.id === 'workspace-calendar');
  assert.deepEqual(calendar.requires, ['workspace']);
  assert.equal(calendar.unavailable, 'needs a Workspace account');
  const files = without.skills.find((s) => s.id === 'files');
  assert.deepEqual(files.requires, []);
  assert.equal('unavailable' in files, false);

  const workspace = { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' };
  const withAccount = readSkills({ paths, instance: { ...runtime.instance, workspace } });
  assert.equal('unavailable' in withAccount.skills.find((s) => s.id === 'workspace-calendar'), false);
});

test('the configuration view carries the instance, settings and contracts, never the token itself', () => {
  const runtime = controlRuntime();
  const view = readConfig({ contracts: runtime.contracts, instance: runtime.instance, settings: { claude_enabled: false, effort: 'medium' }, release: null });
  assert.equal(view.instance.project, 'your-gcp-project');
  assert.equal(view.instance.gateway_token_file, runtime.instance.gateway_token_file);
  assert.equal(view.contracts.gateway.port, runtime.contracts.gateway.port);
  assert.equal(JSON.stringify(view).includes(GATEWAY_TOKEN), false);
});

test('the workspace view: memory with content first, the prompts the gateway loads, and a bare listing', () => {
  const runtime = controlRuntime({ role: 'analyst' });
  const { paths } = runtime;
  writeFileSync(join(paths.data.memory, 'MEMORY.md'), '# Working memory\n- one fact');
  writeFileSync(join(paths.data.memory, 'DEEP_TRUTHS.md'), '# Deep Truths');
  writeFileSync(join(paths.data.memory, 'notes.txt'), 'not markdown');
  writeFileSync(join(paths.prompts, 'cortex.md'), 'You decide the next step.');
  mkdirSync(join(paths.role, 'prompts'), { recursive: true });
  writeFileSync(join(paths.role, 'prompts', 'motor.md'), 'Domain rules.');
  writeFileSync(join(paths.data.workspace, 'report.csv'), 'a,b\n1,2\n');
  mkdirSync(join(paths.data.workspace, 'scratch'));

  const view = readWorkspace({ paths, instance: runtime.instance });
  assert.deepEqual(view.memory.map((f) => [f.name, f.content]), [['DEEP_TRUTHS.md', '# Deep Truths'], ['MEMORY.md', '# Working memory\n- one fact']]);
  assert.deepEqual(view.prompts.map((p) => [p.name, p.source, p.content]), [
    ['cortex.md', 'base', 'You decide the next step.'], ['motor.md', 'role:analyst', 'Domain rules.'],
  ]);
  assert.deepEqual(view.workspace.map((e) => [e.name, e.kind, e.size_bytes]), [['report.csv', 'file', 8], ['scratch', 'dir', null]]);
  assert.equal(view.workspace_truncated, false);
  assert.equal('content' in view.workspace[0], false, 'the workspace listing carries no content');
});

test('a workspace view of huge prompts stays under the document limit, memory first', () => {
  const runtime = controlRuntime();
  const { paths } = runtime;
  writeFileSync(join(paths.data.memory, 'MEMORY.md'), 'm'.repeat(8_000));
  for (let i = 0; i < 15; i += 1) writeFileSync(join(paths.prompts, `p${String(i).padStart(2, '0')}.md`), 'p'.repeat(60 * 1024));
  const view = readWorkspace({ paths, instance: runtime.instance });
  assert.equal(view.memory[0].content.length, 8_000);
  assert.ok(JSON.stringify(view).length < 800 * 1024);
  assert.ok(view.prompts.some((p) => p.content === null && p.truncated === true));
});

test('views of directories that do not exist are empty, not errors', () => {
  const runtime = controlRuntime();
  const paths = { ...runtime.paths, skills: join(runtime.base, 'missing'), data: { ...runtime.paths.data, memory: join(runtime.base, 'gone'), workspace: join(runtime.base, 'gone2') } };
  assert.deepEqual(readSkills({ paths, instance: runtime.instance }), { skills: [] });
  const view = readWorkspace({ paths, instance: runtime.instance });
  assert.deepEqual(view.memory, []);
  assert.deepEqual(view.workspace, []);
});
