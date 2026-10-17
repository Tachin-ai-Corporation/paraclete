// Tests for agent/cli/process-ops.mjs: the playbook library as the brain sees it (installed
// playbooks under the stored ones), and writes that go only to the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../../agent/cli/process-ops.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');

function setup(initial = {}) {
  const root = mkdtempSync(join(tmpdir(), 'process-install-'));
  const dir = join(root, 'roles', 'generic', 'processes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'p-plan.json'), JSON.stringify({ id: 'p-plan', name: 'Planning', description: 'Plan work well', narrative: 'Fix the outcome first.' }));
  writeFileSync(join(dir, 'p-review.json'), JSON.stringify({ id: 'p-review', name: 'Review', description: 'Review a change', narrative: 'Read it twice.' }));
  const db = fakeDb(initial);
  const runtime = fakeRuntime({ db, instance: { install_root: root } });
  return { db, ops: (argv, deps = {}) => run(main, argv, { runtime, now: () => NOW, ...deps }) };
}

test('list shows installed and stored playbooks; a stored one overrides, a deprecated one is hidden', async () => {
  const { ops } = setup({
    'processes/p-review': { name: 'Review (evolved)', description: 'Review with a checklist', narrative: 'Use the checklist.' },
    'processes/p-deploy': { id: 'wrong-id', name: 'Deploy', description: 'Ship it', narrative: '' },
    'processes/p-old': { id: 'p-old', name: 'Old', status: 'deprecated' },
  });
  const r = await ops(['list']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    '3 process playbook(s):',
    `  ${'p-deploy'.padEnd(24)}  ${'Deploy'.padEnd(34)}  [NO narrative]  Ship it`,
    `  ${'p-plan'.padEnd(24)}  ${'Planning'.padEnd(34)}  [narrative]  Plan work well`,
    `  ${'p-review'.padEnd(24)}  ${'Review (evolved)'.padEnd(34)}  [narrative]  Review with a checklist`,
    '',
  ].join('\n'));
});

test('list fails on an outage instead of showing only the installed playbooks', async () => {
  const { db, ops } = setup();
  db.state.down = true;
  const r = await ops(['list']);
  assert.equal(r.code, 1);
  assert.match(r.err, /could not reach the playbook library/);
});

test('get prints a stored playbook under its document id, or an installed one', async () => {
  const { ops } = setup({ 'processes/p-deploy': { name: 'Deploy', narrative: 'Ship it carefully.', updated_by: 'agent', updated_at: '2026-10-16T00:00:00Z' } });
  let r = await ops(['get', 'p-deploy']);
  assert.equal(r.out, [
    'id         : p-deploy', 'name       : Deploy', 'description: ', 'status     : active',
    'updated_by : agent  updated_at: 2026-10-16T00:00:00Z', '', 'narrative:', 'Ship it carefully.', '',
  ].join('\n'));
  r = await ops(['get', 'p-plan']);
  assert.match(r.out, /^id {9}: p-plan\nname {7}: Planning\n/);
  assert.match(r.out, /updated_by : installed \(generic\)/);
});

test('get takes the id itself: a flag in its place is refused, and a missing id says how to find one', async () => {
  const { ops } = setup();
  let r = await ops(['get', '--name', 'p-plan']);
  assert.equal(r.code, 2);
  assert.match(r.err, /process-ops get takes the playbook id itself/);
  r = await ops(['get', 'p-none']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no playbook 'p-none' in the library — process-ops list shows the ids/);
});

test('write stores the fields it is given, keeps created_at, and takes a quote-safe narrative on stdin', async () => {
  const { db, ops } = setup({ 'processes/p-deploy': { id: 'p-deploy', name: 'Deploy', created_at: '2026-01-01T00:00:00Z' } });
  const narrative = 'Check the "live" URL; it\'s done only on a 2xx — $(never) run';
  const r = await ops(['write', 'p-deploy', '--description', 'Ship and verify', '--stdin', '--tags', 'ship, verify', '--project', 'site'],
    { readStdin: () => narrative });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "✅ process 'p-deploy' written to the process library (id updated_by updated_at status created_at description narrative scope)\n");
  assert.deepEqual(db.docs.get('processes/p-deploy'), {
    id: 'p-deploy', name: 'Deploy', created_at: '2026-01-01T00:00:00Z', updated_by: 'agent', updated_at: '2026-10-17T12:00:00Z',
    status: 'active', description: 'Ship and verify', narrative, scope: { project_id: 'site', tags: ['ship', 'verify'] },
  });
});

test('the first write over an installed playbook keeps the fields it does not change', async () => {
  const { db, ops } = setup();
  await ops(['write', 'p-plan', '--narrative', 'Fix the outcome, then the steps.']);
  const doc = db.docs.get('processes/p-plan');
  assert.deepEqual([doc.name, doc.description, doc.narrative, doc.created_at], ['Planning', 'Plan work well', 'Fix the outcome, then the steps.', '2026-10-17T12:00:00Z']);
  assert.match((await ops(['write', 'Bad/Id', '--name', 'x'])).err, /is not a playbook id/);
});

test('retire deprecates a stored playbook and never creates one', async () => {
  const { db, ops } = setup({ 'processes/p-deploy': { name: 'Deploy', status: 'active' } });
  let r = await ops(['retire', 'p-deploy']);
  assert.equal(r.out, "✅ process 'p-deploy' retired (status=deprecated)\n");
  assert.equal(db.docs.get('processes/p-deploy').status, 'deprecated');
  r = await ops(['retire', 'p-ghost']);
  assert.equal(r.code, 1);
  assert.equal(db.docs.has('processes/p-ghost'), false);
  r = await ops(['retire', 'p-plan']);
  assert.equal(r.code, 1);
  assert.match(r.err, /installed playbook with no stored version/);
});

test('no command prints the usage on stderr; --help on stdout', async () => {
  let r = await run(main, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /process-ops write <id> --name/);
  r = await run(main, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /process-ops retire <id>/);
});
