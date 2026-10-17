// Tests for agent/work/process-registry.mjs. The Firestore side runs through the real client from
// agent/storage/firestore.mjs over a fake fetch, so document identity is derived exactly as it is
// on a VM.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessRegistry } from '../../../agent/work/process-registry.mjs';
import { createClient, firestoreEncode } from '../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const DOCS = 'projects/your-gcp-project/databases/(default)/documents';

/** A Firestore REST endpoint that answers runQuery from `state.rows`, or fails with `state.status`. */
function fakeFirestore(state) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (state.status && state.status !== 200) {
      return { ok: false, status: state.status, text: async () => 'unavailable', json: async () => ({}) };
    }
    const rows = state.rows.map(([id, body]) => ({ document: { name: `${DOCS}/${COLLECTIONS.processes}/${id}`, fields: firestoreEncode(body) } }));
    return { ok: true, status: 200, json: async () => rows };
  };
  const db = createClient({ projectId: 'your-gcp-project', getAccessToken: async () => 'token', fetch, logger: () => {} });
  return { db, requests };
}

const narrative = 'Gather the inputs first, then write from the full set rather than the first match.';

describe('process registry', () => {
  it('a playbook stored without an id in its body loads under its document id', async () => {
    // A writer that stored a playbook at processes/p-plan but left `id` out of the body made a
    // record every loader that required a truthy id skipped: the dashboard reported success and the
    // agent never saw it.
    const { db } = fakeFirestore({ rows: [['p-plan', { name: 'Plan', narrative }]] });
    const registry = createProcessRegistry({ db, logger: () => {} });
    await registry.loadProcesses();
    assert.equal(registry.getProcess('p-plan')?.id, 'p-plan');
    assert.equal(registry.getProcess('p-plan').name, 'Plan');
  });

  it('queries the root processes collection', async () => {
    const { db, requests } = fakeFirestore({ rows: [] });
    await createProcessRegistry({ db, logger: () => {} }).loadProcesses();
    assert.equal(requests[0].url, `https://firestore.googleapis.com/v1/${DOCS}:runQuery`);
    assert.deepEqual(requests[0].body.structuredQuery.from, [{ collectionId: COLLECTIONS.processes }]);
  });

  it('a stored playbook overrides the installed one with the same id; deprecated ones are dropped', async () => {
    const { db } = fakeFirestore({ rows: [
      ['p-plan', { name: 'Plan, as the agent evolved it', narrative }],
      ['p-old', { name: 'Old', narrative, status: 'deprecated' }],
    ] });
    const registry = createProcessRegistry({
      db,
      defaults: [
        { id: 'p-plan', name: 'Plan, as installed', narrative },
        { id: 'p-review', name: 'Review', narrative },
        { id: 'p-retired', name: 'Retired', narrative, status: 'deprecated' },
        { name: 'no id', narrative },
      ],
      logger: () => {},
    });
    await registry.loadProcesses();
    assert.deepEqual(Object.keys(registry.getAllProcesses()).sort(), ['p-plan', 'p-review']);
    assert.equal(registry.getProcess('p-plan').name, 'Plan, as the agent evolved it');
  });

  it('an unreadable store keeps the stored playbooks last read', async () => {
    // A failed read used to leave only the installed playbooks until the next refresh, quietly
    // replacing every playbook the agent had evolved with the installed version.
    const state = { rows: [['p-plan', { name: 'Plan, as the agent evolved it', narrative }]] };
    const { db } = fakeFirestore(state);
    const logs = [];
    const registry = createProcessRegistry({
      db, defaults: [{ id: 'p-plan', name: 'Plan, as installed', narrative }], logger: (l, m) => logs.push(`${l} ${m}`),
    });
    await registry.loadProcesses();
    state.status = 503;
    await registry.loadProcesses();
    assert.equal(registry.getProcess('p-plan').name, 'Plan, as the agent evolved it');
    assert.ok(logs.some((l) => /WARN Failed to load stored processes .*keeping the 1 last read/.test(l)));
  });

  it('works with installed playbooks alone', async () => {
    const registry = createProcessRegistry({ defaults: [{ id: 'p-review', name: 'Review', narrative }], logger: () => {} });
    await registry.loadProcesses();
    assert.equal(registry.getProcess('p-review').name, 'Review');
    assert.equal(registry.getProcess('p-missing'), undefined);
  });

  it('ensureLoaded reloads only when the last load is stale', async () => {
    let t = 0;
    const { db, requests } = fakeFirestore({ rows: [] });
    const registry = createProcessRegistry({ db, refreshMs: 60_000, clock: () => t, logger: () => {} });
    await registry.ensureLoaded();
    t = 30_000;
    await registry.ensureLoaded();
    assert.equal(requests.length, 1, 'fresh: no reload');
    t = 61_000;
    await registry.ensureLoaded();
    assert.equal(requests.length, 2, 'stale: reloaded');
  });
});
