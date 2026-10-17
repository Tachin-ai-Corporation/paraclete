// Tests for agent/services/control/responsibilities.mjs: the dashboard sees the same merge the
// scheduler runs; a switch is a store revision (with its copy) and never an edit of an installed file;
// locked upkeep refuses; and "run now" queues exactly one trigger per command for the brain. Fake
// Firestore; role packages in a temp install root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import {
  rolePackages, listResponsibilities, setResponsibilityEnabled, runResponsibility,
} from '../../../../agent/services/control/responsibilities.mjs';
import { fakeDb, controlRuntime } from './fakes.mjs';

const CONSOLIDATION = {
  id: 'r-memory-consolidation', name: 'Nightly memory consolidation', schedule: '0 8 * * *', timezone: 'UTC',
  enabled: true, locked: true, min_spacing_minutes: 720, triggerable: true, singleton: true, effect_scope: 'memory',
  instruction: 'Consolidate working memory and Core Memory.', success_criteria: 'Working memory is under its target size.',
};
const DIGEST = {
  id: 'r-weekly-digest', name: 'Weekly digest', schedule: '0 9 * * 1', enabled: true,
  instruction: 'Write the weekly digest of finished work.', success_criteria: 'A digest was delivered to the owner.',
  context: { process: ['gather the finished missions', 'write the digest'] },
};
const ANALYST_REVIEW = {
  id: 'r-data-review', name: 'Data review', event: 'on_complete', enabled: true,
  instruction: 'Review the data a mission produced.', success_criteria: 'Every table was checked for gaps.',
};
const NOW = new Date('2026-10-17T12:00:00.000Z');
const nowIso = () => NOW.toISOString();

function setup({ role = 'generic', db = fakeDb() } = {}) {
  const runtime = controlRuntime({ role, db });
  writeFileSync(join(runtime.paths.genericRole, 'responsibilities.json'), JSON.stringify({ version: 1, responsibilities: [CONSOLIDATION, DIGEST] }));
  if (role !== 'generic') writeFileSync(join(runtime.paths.role, 'responsibilities.json'), JSON.stringify([ANALYST_REVIEW]));
  const store = {
    db, collections: runtime.collections, subcollections: runtime.subcollections, contracts: runtime.contracts,
    paths: runtime.paths, instance: runtime.instance, log: runtime.log, nowIso,
  };
  return { runtime, db, store };
}

test('role packages: generic first, then the chosen role; a missing file has none, a broken one is skipped', () => {
  const { runtime } = setup({ role: 'analyst' });
  const packages = rolePackages({ paths: runtime.paths, instance: runtime.instance });
  assert.deepEqual(packages.map((p) => [p.source, p.responsibilities.map((r) => r.id)]), [
    ['generic', ['r-memory-consolidation', 'r-weekly-digest']],
    ['analyst', ['r-data-review']],
  ]);

  const bare = controlRuntime();
  assert.deepEqual(rolePackages({ paths: bare.paths, instance: bare.instance, log: bare.log }), []);
  assert.equal(bare.lines.length, 0, 'a role without responsibilities is not a problem');

  writeFileSync(join(bare.paths.genericRole, 'responsibilities.json'), '{ not json');
  assert.deepEqual(rolePackages({ paths: bare.paths, instance: bare.instance, log: bare.log }), []);
  assert.match(bare.lines[0].message, /is not valid JSON; its responsibilities are left out/);
});

test('the list is the merge the scheduler runs, with provenance and the next fire time', async () => {
  const { db, store } = setup();
  db.set('responsibilities/r-weekly-digest', { id: 'r-weekly-digest', mode: 'override', patch: { enabled: false }, revision: 2, status: 'active', updated_by: 'admin@example.com' });
  const { responsibilities, issues, store_error } = await listResponsibilities({ ...store, now: () => NOW });
  assert.equal(store_error, null);
  assert.deepEqual(issues, []);
  const byId = Object.fromEntries(responsibilities.map((r) => [r.id, r]));
  assert.equal(byId['r-memory-consolidation'].enabled, true);
  assert.equal(byId['r-memory-consolidation'].locked, true);
  assert.equal(byId['r-memory-consolidation'].origin, 'default');
  assert.equal(byId['r-memory-consolidation'].next_fire, '2026-10-18T08:00:00.000Z');
  assert.equal(byId['r-weekly-digest'].enabled, false);
  assert.equal(byId['r-weekly-digest'].origin, 'override');
  assert.equal(byId['r-weekly-digest'].revision, 2);
  assert.equal(byId['r-weekly-digest'].updated_by, 'admin@example.com');
  assert.equal(byId['r-weekly-digest'].next_fire, null, 'a disabled responsibility has no next fire');
  assert.equal(byId['r-weekly-digest'].process_steps, 2);
  assert.match(byId['r-weekly-digest'].source, /generic \+ override \(rev 2, by admin@example\.com\)/);
});

test('an unreadable store shows the installed defaults and says why', async () => {
  const { db, store } = setup();
  db.failOnce('query', new StoreUnavailable('query', 'responsibilities', 503, 'unavailable'));
  const { responsibilities, store_error } = await listResponsibilities({ ...store, now: () => NOW });
  assert.equal(responsibilities.length, 2);
  assert.match(store_error, /HTTP 503/);
});

test('a switch writes the next store revision and its copy in one commit, never the installed file', async () => {
  const { db, store, runtime } = setup();
  const installedFile = join(runtime.paths.genericRole, 'responsibilities.json');
  const before = readFileSync(installedFile, 'utf8');

  const off = await setResponsibilityEnabled({ ...store, id: 'r-weekly-digest', enabled: false, actor: 'admin@example.com' });
  assert.equal(off.revision, 1);
  assert.match(off.message, /'r-weekly-digest' is off \(revision 1\)\. The scheduler picks it up within 60 seconds, and it survives upgrades\./);
  const doc = db.get('responsibilities/r-weekly-digest');
  assert.equal(doc.mode, 'override');
  assert.deepEqual(doc.patch, { enabled: false });
  assert.equal(doc.updated_by, 'admin@example.com');
  assert.equal(doc.updated_at, nowIso());
  assert.deepEqual(db.get('responsibilities/r-weekly-digest/revisions/1'), doc);

  const on = await setResponsibilityEnabled({ ...store, id: 'r-weekly-digest', enabled: true });
  assert.equal(on.revision, 2);
  assert.ok(db.get('responsibilities/r-weekly-digest/revisions/2'));
  assert.equal(readFileSync(installedFile, 'utf8'), before);
});

test('locked upkeep, an unknown id, a malformed id and a non-boolean are refused without writing', async () => {
  const { db, store } = setup();
  await assert.rejects(setResponsibilityEnabled({ ...store, id: 'r-memory-consolidation', enabled: false }), /installed upkeep \(locked\)/);
  await assert.rejects(setResponsibilityEnabled({ ...store, id: 'r-nope', enabled: false }), /is not one of the agent's responsibilities/);
  for (const id of ['../config/settings', 'R-Upper', '', undefined]) {
    await assert.rejects(setResponsibilityEnabled({ ...store, id, enabled: false }), /params\.id must be a responsibility id/);
  }
  await assert.rejects(setResponsibilityEnabled({ ...store, id: 'r-weekly-digest', enabled: 'false' }), /params\.enabled must be true or false/);
  assert.equal(db.calls.filter((c) => c.op === 'commit').length, 0);
});

test('a record that changed while it was being switched writes nothing and says so', async () => {
  const { db, store } = setup();
  const readDoc = db.readDoc;
  db.readDoc = async (path) => {
    const doc = await readDoc(path);
    db.set('responsibilities/r-weekly-digest', { id: 'r-weekly-digest', mode: 'override', patch: { enabled: true }, revision: 1, status: 'active' });
    return doc;
  };
  await assert.rejects(setResponsibilityEnabled({ ...store, id: 'r-weekly-digest', enabled: false }), /changed while it was being switched; nothing was written/);
  assert.equal(db.get('responsibilities/r-weekly-digest/revisions/1'), null);
});

test('run now queues one trigger for the brain, keyed by the command', async () => {
  const { db, store } = setup();
  const result = await runResponsibility({ ...store, id: 'r-memory-consolidation', commandId: 'cmd1', actor: 'admin@example.com' });
  assert.deepEqual(result, {
    id: 'r-memory-consolidation', name: 'Nightly memory consolidation', trigger_id: 'cmd1',
    message: "'Nightly memory consolidation' is queued; the brain starts it within a few seconds.",
  });
  assert.deepEqual(db.get('responsibility_triggers/cmd1'), {
    responsibility_id: 'r-memory-consolidation', status: 'pending', bypass_spacing: true,
    requested_by: 'admin@example.com', requested_at: nowIso(), command_id: 'cmd1',
  });
  await assert.rejects(runResponsibility({ ...store, id: 'r-memory-consolidation', commandId: 'cmd1' }), /already queued by this command/);
});

test('run now refuses a responsibility the agent does not have', async () => {
  const { db, store } = setup();
  await assert.rejects(runResponsibility({ ...store, id: 'r-unknown', commandId: 'cmd2' }), /responsibility 'r-unknown' not found/);
  assert.deepEqual(db.paths('responsibility_triggers/'), []);
});
