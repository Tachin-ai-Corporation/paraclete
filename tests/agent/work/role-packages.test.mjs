// Tests for agent/work/role-packages.mjs: the installed role packages' responsibilities and playbooks,
// read from the generic role first and then the instance's role, the base winning a playbook id, and
// an unreadable file reported and skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readInstalledProcesses, readInstalledResponsibilities } from '../../../agent/work/role-packages.mjs';

/** A roles directory to write packages into, and the RoleDirs for an instance of a role. */
function roles() {
  const root = mkdtempSync(join(tmpdir(), 'roles-'));
  const pkg = (role, responsibilities, processes = {}) => {
    mkdirSync(join(root, role, 'processes'), { recursive: true });
    if (responsibilities) writeFileSync(join(root, role, 'responsibilities.json'), JSON.stringify({ responsibilities }));
    for (const [name, p] of Object.entries(processes)) writeFileSync(join(root, role, 'processes', name), typeof p === 'string' ? p : JSON.stringify(p));
  };
  const dirs = (role) => ({ genericDir: join(root, 'generic'), role, roleDir: join(root, role) });
  return { pkg, dirs };
}

test('installed responsibilities: the generic role first, then the instance\'s role', () => {
  const r = roles();
  r.pkg('generic', [{ id: 'r-a' }]);
  r.pkg('ops', [{ id: 'r-a', name: 'shadow' }, { id: 'r-ops' }]);
  assert.deepEqual(readInstalledResponsibilities(r.dirs('ops')), [
    { source: 'generic', responsibilities: [{ id: 'r-a' }] },
    { source: 'ops', responsibilities: [{ id: 'r-a', name: 'shadow' }, { id: 'r-ops' }] },
  ]);
  assert.equal(readInstalledResponsibilities(r.dirs('generic')).length, 1, 'the generic role is read once');
});

test('installed playbooks: the base wins an id, the role adds its own, an unreadable file is reported and skipped', () => {
  const r = roles();
  r.pkg('generic', null, { 'p-a.json': { id: 'p-a', name: 'Generic A' }, 'p-b.json': { id: 'p-b', name: 'B' } });
  r.pkg('ops', null, { 'p-a.json': { id: 'p-a', name: 'Ops A' }, 'p-deploy.json': { id: 'p-deploy', name: 'Deploy' }, 'broken.json': '{not json' });
  const errors = [];
  const processes = readInstalledProcesses(r.dirs('ops'), { onError: (file, e) => errors.push([file, e]) });
  assert.deepEqual(processes.map((p) => [p.id, p.name, p._source]), [
    ['p-a', 'Generic A', 'generic'],
    ['p-b', 'B', 'generic'],
    ['p-deploy', 'Deploy', 'ops'],
  ], 'the base stays authoritative');
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /broken\.json$/);
  assert.ok(errors[0][1] instanceof SyntaxError);
});

test('a package without the files contributes nothing', () => {
  const r = roles();
  assert.deepEqual(readInstalledResponsibilities(r.dirs('generic')), []);
  assert.deepEqual(readInstalledProcesses(r.dirs('ops')), []);
});
