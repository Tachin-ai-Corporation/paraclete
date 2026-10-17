// Tests for dev/trigger.mjs: the trigger document is field for field what the control service's "run
// now" writes, requested by the developer's gcloud account; the brain's real trigger pass claims it and
// fires it; and the command reports fired, an error, or a trigger nobody claimed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { start as startFirestore } from '../fakes/firestore-server.mjs';
import { createClient } from '../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { loadContracts } from '../../config/contracts.mjs';
import { runResponsibility } from '../../agent/services/control/responsibilities.mjs';
import { createEnvelopeStore } from '../../agent/services/brain/envelope-store.mjs';
import { createResponsibilities } from '../../agent/services/brain/responsibilities.mjs';
import { REPO_ROOT } from '../../dev/dev-env.mjs';
import { main, triggerDoc } from '../../dev/trigger.mjs';
import { DEV_EMAIL, START, assertNoShell, devDeps, fakeExec } from './fakes.mjs';

let firestore;
let db;
before(async () => {
  firestore = await startFirestore();
  db = createClient({ projectId: firestore.projectId, firestoreHost: firestore.origin, getAccessToken: async () => 't', logger: () => {} });
});
after(() => firestore.stop());
beforeEach(() => firestore.reset());

const triggerPaths = () => Object.keys(firestore.dump()).filter((p) => p.startsWith(`${COLLECTIONS.responsibilityTriggers}/`));

/** The brain's responsibilities with one triggerable daily responsibility, r-a. */
function brain() {
  const store = createEnvelopeStore({ db, clock: () => START, defaultProjectId: () => 'general' });
  const resp = createResponsibilities({
    db, store, contracts: loadContracts(), clock: () => START, recall: async () => ({ recalled: 'nothing' }),
    defaults: [{ source: 'generic', responsibilities: [{ id: 'r-a', name: 'r-a', schedule: '0 8 * * *', enabled: true, triggerable: true, instruction: 'Run the r-a cycle', success_criteria: 'It ran' }] }],
  });
  resp.scheduler.loadResponsibilities();
  return resp;
}

test('the trigger is stored exactly as the control service stores a "run now", requested by your account', async () => {
  const generic = join(REPO_ROOT, 'roles', 'generic');
  await runResponsibility({
    id: 'r-git-gc', commandId: 'cmd-ref', actor: DEV_EMAIL, db, collections: COLLECTIONS, contracts: loadContracts(),
    paths: { genericRole: generic, role: generic }, instance: { role: 'generic' }, nowIso: () => new Date(START).toISOString(),
  });
  let created = null;
  const exec = fakeExec();
  const deps = devDeps({ firestore, exec, onSleep: async () => { created ??= structuredClone(firestore.dump()); } });
  assert.equal(await main(['r-git-gc', '--timeout', '5'], deps), 1, 'nothing claims it in this test');

  const ours = Object.keys(created).find((p) => p.startsWith(`${COLLECTIONS.responsibilityTriggers}/`) && p !== `${COLLECTIONS.responsibilityTriggers}/cmd-ref`);
  const id = ours.split('/')[1];
  assert.match(id, /^[A-Za-z0-9]{20}$/);
  assert.match(deps.stdout.text, new RegExp(`^Trigger ${id} asks the brain to run r-git-gc now \\(requested by ${DEV_EMAIL}\\)\\.$`, 'm'));
  const control = created[`${COLLECTIONS.responsibilityTriggers}/cmd-ref`].fields;
  const dev = created[ours].fields;
  assert.deepEqual(dev, { ...control, command_id: { stringValue: id } }, 'same fields, same types, same values but its own id');
  assert.deepEqual(exec.calls.map((c) => c.args.join(' ')), ['config get-value account', 'auth print-access-token']);
  assertNoShell(exec.calls);
});

test('the brain claims the trigger and fires it; the command prints the outcome', async () => {
  const resp = brain();
  const deps = devDeps({ firestore, exec: fakeExec(), onSleep: async () => { await resp.checkTriggers(); } });
  assert.equal(await main(['r-a'], deps), 0, deps.stderr.text);
  assert.match(deps.stdout.text, /\nfired: r-a \(at 2026-10-17T12:00:00\.000Z\)\n/);
  assert.match(deps.stdout.text, /Its mission: node dev\/query\.mjs work --where type=M --where source_meta\.responsibility_id=r-a/);
  const [path] = triggerPaths();
  const stored = await db.read(path);
  assert.equal(stored.status, 'fired');
  assert.equal(stored.requested_by, DEV_EMAIL);
});

test('a responsibility the brain does not have comes back as an error', async () => {
  const resp = brain();
  const deps = devDeps({ firestore, exec: fakeExec(), onSleep: async () => { await resp.checkTriggers(); } });
  assert.equal(await main(['r-nope'], deps), 1);
  assert.match(deps.stdout.text, /\nerror: responsibility 'r-nope' not found/);
});

test('a trigger nobody claims is withdrawn when the wait runs out; a claimed one is left to the brain', async () => {
  const deps = devDeps({ firestore, exec: fakeExec() });
  assert.equal(await main(['r-a', '--timeout', '9'], deps), 1);
  assert.match(deps.stderr.text, /the brain did not mark trigger [A-Za-z0-9]{20} within 9 s \(it is pending\); it was withdrawn so it cannot fire later\. Is the brain running\?/);
  assert.deepEqual(triggerPaths(), [], 'nothing is left to fire later');

  const claiming = devDeps({
    firestore,
    exec: fakeExec(),
    onSleep: async () => {
      for (const path of triggerPaths()) await db.patch(path, ['status'], { status: { stringValue: 'firing' } });
    },
  });
  assert.equal(await main(['r-a', '--timeout', '9'], claiming), 1);
  assert.match(claiming.stderr.text, /within 9 s \(it is firing\)\. Is the brain running\?/);
  assert.equal(triggerPaths().length, 1, 'a claimed trigger is not taken back');
});

test('a malformed id is refused before anything is written or run', async () => {
  for (const argv of [['R-A'], ['r a'], ['../work'], [], ['r-a', 'r-b'], ['r-a', '--timeout', 'x']]) {
    const exec = fakeExec();
    const deps = devDeps({ firestore, exec });
    assert.equal(await main(argv, deps), 2, argv.join(' '));
    assert.equal(exec.calls.length, 0);
  }
  assert.deepEqual(triggerPaths(), []);
});

test('the document builder is the control shape', () => {
  assert.deepEqual(triggerDoc({ responsibilityId: 'r-a', triggerId: 'T1', requestedBy: DEV_EMAIL, requestedAt: '2026-10-17T12:00:00.000Z' }), {
    responsibility_id: 'r-a', status: 'pending', bypass_spacing: true, requested_by: DEV_EMAIL, requested_at: '2026-10-17T12:00:00.000Z', command_id: 'T1',
  });
});
