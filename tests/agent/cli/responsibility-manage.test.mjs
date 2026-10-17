// Tests for agent/cli/responsibility-manage.mjs. Ported from the responsibility-store command cases:
// the command writes the agent's store (record and revision together) and never an installed
// responsibilities file, which the next upgrade would reinstall over the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../../agent/cli/responsibility-manage.mjs';
import { StoreConflict } from '../../../agent/storage/firestore.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');

const consolidation = {
  id: 'r-memory-consolidation', name: 'Memory consolidation', schedule: '0 8 * * *', timezone: 'UTC', enabled: true, locked: true,
  instruction: 'Consolidate memory every night.', success_criteria: 'Memory was consolidated and reported.',
  context: { purpose: 'Keep memory lean.', process: ['gather', 'triage', 'report'] },
};
const digest = {
  id: 'r-weekly-digest', name: 'Weekly digest', schedule: '0 9 * * 1', timezone: 'UTC', enabled: true,
  instruction: 'Write a digest of the week\'s finished work.', success_criteria: 'A digest names every finished mission.',
  context: { purpose: 'Keep people current.', process: ['read the log', 'write', 'deliver'] },
};
const backup = {
  id: 'r-backup-check', name: 'Backup check', schedule: '0 3 * * *', timezone: 'UTC', enabled: true,
  instruction: 'Check that last night\'s backups exist.', success_criteria: 'Every backup was found and its size reported.',
  context: { purpose: 'Catch a failed backup early.', process: ['list', 'compare', 'report'] },
};
const own = {
  id: 'r-standup', name: 'Standup digest', schedule: '0 9 * * 1-5', timezone: 'UTC',
  instruction: 'Post a digest of yesterday\'s work to the dashboard.',
  success_criteria: 'A digest was posted and names each finished item.',
  context: { purpose: 'Keep everyone current.', process: ['read the ledger', 'write the digest', 'post it'] },
};

/** An install root with the generic and devops role packages' responsibilities. */
function installRoot() {
  const root = mkdtempSync(join(tmpdir(), 'resp-install-'));
  for (const [role, list] of [['generic', [consolidation, digest]], ['devops', [backup]]]) {
    mkdirSync(join(root, 'roles', role), { recursive: true });
    writeFileSync(join(root, 'roles', role, 'responsibilities.json'), JSON.stringify({ responsibilities: list }));
  }
  return root;
}

function setup(initial = {}) {
  const root = installRoot();
  const db = fakeDb(initial);
  const runtime = fakeRuntime({ db, instance: { install_root: root, role: 'devops' } });
  const manage = (argv, deps = {}) => run(main, argv, { runtime, now: () => NOW, ...deps });
  const installedFiles = () => ['generic', 'devops'].map((r) => readFileSync(join(root, 'roles', r, 'responsibilities.json'), 'utf8'));
  return { db, runtime, manage, installedFiles };
}

test('list shows the installed defaults of both role packages and the agent\'s own, with provenance', async () => {
  const { manage } = setup({
    'responsibilities/r-standup': { id: 'r-standup', mode: 'own', status: 'active', revision: 1, updated_by: 'agent', body: { ...own, enabled: true } },
    'responsibilities/r-weekly-digest': { id: 'r-weekly-digest', mode: 'override', status: 'active', revision: 2, updated_by: 'agent', patch: { enabled: false } },
  });
  const r = await manage(['list']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Responsibilities:\n/);
  assert.match(r.out, /r-memory-consolidation +0 8 \* \* \* UTC +enabled  generic \(locked\)/);
  assert.match(r.out, /r-weekly-digest +0 9 \* \* 1 UTC +DISABLED generic \+ override \(rev 2, by agent\)/);
  assert.match(r.out, /r-backup-check .* devops$/m);
  assert.match(r.out, /r-standup .* agent-owned \(rev 1, by agent\)/);
  assert.match(r.out, /Total: 4\n$/);
});

test('create writes the record and revision 1 together, as the agent, and never an installed file', async () => {
  const { db, manage, installedFiles } = setup();
  const before = installedFiles();
  const r = await manage(['--note', 'people asked for it', 'create', JSON.stringify(own)]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "Created 'r-standup' — revision 1. Live within a minute — no release or upgrade needed.\n");
  const doc = db.docs.get('responsibilities/r-standup');
  assert.equal(doc.mode, 'own');
  assert.equal(doc.updated_by, 'agent');
  assert.equal(doc.updated_at, NOW.toISOString());
  assert.equal(doc.note, 'people asked for it');
  assert.equal(doc.body.enabled, true);
  assert.deepEqual(db.docs.get('responsibilities/r-standup/revisions/1'), doc);
  assert.deepEqual(Object.keys(doc).sort(), ['body', 'id', 'mode', 'note', 'revision', 'status', 'updated_at', 'updated_by'],
    'the record names no agent: the store belongs to the one agent of the instance');
  assert.deepEqual(installedFiles(), before, 'the installed files are never written');
});

test('a body on --stdin keeps quotes and apostrophes; --process-ref is folded in', async () => {
  const { db, manage } = setup();
  const body = { ...own, instruction: 'Post "yesterday\'s" digest — it\'s for the team.' };
  const r = await manage(['create', '--stdin', '--process-ref', 'p-digest'], { readStdin: () => JSON.stringify(body) });
  assert.equal(r.code, 0, r.err);
  const stored = db.docs.get('responsibilities/r-standup').body;
  assert.equal(stored.instruction, body.instruction);
  assert.equal(stored.processRef, 'p-digest');
});

test('update on an installed default writes an override; toggle flips what runs', async () => {
  const { db, manage } = setup();
  let r = await manage(['update', 'r-weekly-digest', '{"schedule":"30 9 * * 1"}']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Overrode schedule on 'r-weekly-digest' — revision 1\./);
  assert.deepEqual(db.docs.get('responsibilities/r-weekly-digest').patch, { schedule: '30 9 * * 1' });
  r = await manage(['toggle', 'r-weekly-digest']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(db.docs.get('responsibilities/r-weekly-digest').patch, { schedule: '30 9 * * 1', enabled: false });
  r = await manage(['toggle', 'r-weekly-digest', 'on']);
  assert.equal(db.docs.get('responsibilities/r-weekly-digest').revision, 3);
});

test('locked upkeep and invalid bodies are refused with the reason', async () => {
  const { db, manage } = setup();
  let r = await manage(['toggle', 'r-memory-consolidation', 'off']);
  assert.equal(r.code, 1);
  assert.match(r.err, /installed upkeep \(locked\)/);
  r = await manage(['create', JSON.stringify({ ...own, schedule: '* * * * *' })]);
  assert.equal(r.code, 1);
  assert.match(r.err, /the floor between two fires is 15 minutes/);
  r = await manage(['create', '{not json']);
  assert.match(r.err, /the body is not valid JSON/);
  assert.equal(db.docs.size, 0);
});

test('history lists revisions newest first; revert restores one as a new revision', async () => {
  const { db, manage } = setup();
  await manage(['create', JSON.stringify(own)]);
  await manage(['update', 'r-standup', '{"schedule":"0 10 * * 1-5"}']);
  let r = await manage(['history', 'r-standup']);
  assert.match(r.out, /^History of r-standup:\n  rev 2 .*0 10 \* \* 1-5 UTC\n  rev 1 .*0 9 \* \* 1-5 UTC\n$/);
  r = await manage(['revert', 'r-standup', '--to', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /'r-standup' restored to revision 1 — revision 3\./);
  assert.equal(db.docs.get('responsibilities/r-standup').body.schedule, '0 9 * * 1-5');
  assert.equal(db.docs.get('responsibilities/r-standup').reverted_from, 1);
});

test('--json prints the data instead of the sentence', async () => {
  const { manage } = setup();
  const r = await manage(['--json', 'show', 'r-backup-check']);
  const shown = JSON.parse(r.out);
  assert.equal(shown.effective.id, 'r-backup-check');
  assert.equal(shown.store, null);
});

test('a change at the same moment exits 3, an outage 2, and --agent is not an option', async () => {
  const { db, runtime, manage } = setup();
  const racing = { ...db, commit: async () => { throw new StoreConflict('responsibilities/r-standup', 'FAILED_PRECONDITION'); } };
  let r = await manage(['create', JSON.stringify(own)], { runtime: { ...runtime, db: racing } });
  assert.equal(r.code, 3);
  assert.match(r.err, /run the command again/);
  db.state.down = true;
  r = await manage(['list']);
  assert.equal(r.code, 2);
  assert.match(r.err, /the responsibility store is unreachable/);
  r = await manage(['--agent', 'other', 'list']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option --agent/);
});

test('--help and no verb print the usage', async () => {
  for (const argv of [['--help'], []]) {
    const r = await run(main, argv);
    assert.equal(r.code, 0);
    assert.match(r.out, /^Usage: responsibility-manage \[--note "<why>"\] \[--json\] <verb>/);
  }
});
