// Tests for agent/work/responsibility-store.mjs. Writers that edited the installed responsibilities
// file in place lost every change at the next upgrade; these pin the replacement: the agent's own
// store layered over the installed defaults, merged by one module that the scheduler, the dashboard
// and the responsibility command share. The scheduler's side lives in scheduler.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronNextFire } from '../../../agent/work/scheduler.mjs';
import {
  mergeResponsibilities, planWrite, applyPatch, checkCron, checkFrequency, collectDefaults,
  resolvePolicy, describeProvenance, readStore, storeSignature, validateBody,
  DEFAULT_POLICY, STORE_COLLECTION, RESPONSIBILITY_BODY_SCHEMA,
} from '../../../agent/work/responsibility-store.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const installedExec = () => ({
  id: 'r-exec',
  name: 'Weekly Exec',
  schedule: '15 10 * * 4',
  timezone: 'America/Chicago',
  enabled: true,
  singleton: true,
  instruction: 'Produce this week\'s executive update from the meeting notes.',
  success_criteria: 'One doc for this week exists and its sections were read back.',
  context: { purpose: 'Run the weekly exec sync.', process: ['gather', 'synthesize', 'deliver'] },
  _source: 'assistant',
});
const lockedBase = () => ({
  id: 'r-memory-consolidation', name: 'Consolidation', schedule: '0 8 * * *', enabled: true, locked: true,
  instruction: 'Consolidate memory every night.', context: { success_criteria: 'Memory was consolidated and reported.' },
  _source: 'generic',
});
const own = (over = {}) => ({
  id: 'r-standup', name: 'Standup digest', schedule: '0 9 * * 1-5', timezone: 'UTC', enabled: true,
  instruction: 'Post a digest of yesterday\'s work to the dashboard.',
  success_criteria: 'A digest was posted and names each finished item.',
  context: { purpose: 'Keep everyone current.', process: ['read the ledger', 'write the digest', 'post it'] },
  ...over,
});
const opts = { policy: DEFAULT_POLICY, nextFire: cronNextFire };

describe('layering: installed defaults, overrides, and the agent\'s own', () => {
  it('an override changes only the fields it names; the rest keeps flowing from the default', () => {
    const doc = { id: 'r-exec', mode: 'override', status: 'active', revision: 2, updated_by: 'agent', patch: { schedule: '20 10 * * 4', context: { process: ['gather by name', 'deliver'] } } };
    const { effective, issues } = mergeResponsibilities([installedExec()], [doc], opts);
    assert.deepEqual(issues, []);
    const r = effective[0];
    assert.equal(r.schedule, '20 10 * * 4');
    assert.equal(r.timezone, 'America/Chicago', 'untouched fields come from the installed default');
    assert.deepEqual(r.context.process, ['gather by name', 'deliver']);
    assert.equal(r.context.purpose, 'Run the weekly exec sync.', 'context merges key by key');
    assert.equal(r._provenance.origin, 'override');
    assert.equal(r._provenance.revision, 2);
    assert.equal(describeProvenance(r), 'assistant + override (rev 2, by agent)');
  });

  it('a responsibility the agent created is added; one it adopted replaces the default', () => {
    const docs = [
      { id: 'r-standup', mode: 'own', status: 'active', revision: 1, updated_by: 'agent', body: own() },
      { id: 'r-exec', mode: 'own', status: 'active', revision: 1, updated_by: 'agent', adopted_from: 'assistant', body: { ...installedExec(), _source: undefined, instruction: 'The agent\'s own version of the weekly update.' } },
    ];
    const { effective } = mergeResponsibilities([installedExec()], docs, opts);
    const byId = Object.fromEntries(effective.map((r) => [r.id, r]));
    assert.equal(byId['r-standup']._provenance.origin, 'agent');
    assert.equal(byId['r-exec'].instruction, 'The agent\'s own version of the weekly update.');
    assert.match(describeProvenance(byId['r-exec']), /adopted from assistant/);
  });

  it('a locked default ignores every store record', () => {
    const doc = { id: 'r-memory-consolidation', mode: 'override', status: 'active', revision: 1, updated_by: 'agent', patch: { enabled: false } };
    const { effective, issues } = mergeResponsibilities([lockedBase()], [doc], opts);
    assert.equal(effective[0].enabled, true, 'consolidation keeps running');
    assert.match(issues[0].reason, /locked/);
    assert.equal(describeProvenance(effective[0]), 'generic (locked)');
  });

  it('a bad store record never takes a responsibility away; the default keeps running', () => {
    const docs = [
      { id: 'r-exec', mode: 'override', status: 'active', revision: 3, updated_by: 'x', patch: { schedule: 'every thursday' } },
      { id: 'r-loop', mode: 'own', status: 'active', revision: 1, updated_by: 'x', body: own({ id: 'r-loop', schedule: '*/5 * * * *' }) },
      { id: 'r-gone', mode: 'override', status: 'active', revision: 1, updated_by: 'x', patch: { enabled: false } },
      { id: 'r-old', mode: 'own', status: 'removed', revision: 2, updated_by: 'x', body: own({ id: 'r-old' }) },
      { id: 'r-odd', mode: 'mystery', status: 'active', revision: 1 },
    ];
    const { effective, issues } = mergeResponsibilities([installedExec()], docs, opts);
    assert.deepEqual(effective.map((r) => r.id), ['r-exec']);
    assert.equal(effective[0].schedule, '15 10 * * 4', 'an unreadable override falls back to the default');
    assert.equal(effective[0]._provenance.origin, 'default');
    const reasons = issues.map((i) => `${i.id}: ${i.reason}`).join('\n');
    assert.match(reasons, /r-exec: .*five-field|r-exec: .*schedule/);
    assert.match(reasons, /r-loop: .*5 minute\(s\) apart/);
    assert.match(reasons, /r-gone: .*no installed default/);
    assert.match(reasons, /r-odd: .*unknown mode 'mystery'/);
    assert.doesNotMatch(reasons, /r-old/, 'a removed record is history, not an issue');
  });

  it('an adopted responsibility outlives its default', () => {
    const adopted = { id: 'r-exec', mode: 'own', status: 'active', revision: 1, adopted_from: 'assistant', body: { ...installedExec(), _source: undefined } };
    const { effective } = mergeResponsibilities([], [adopted], opts);
    assert.deepEqual(effective.map((r) => r.id), ['r-exec'], 'still runs once the default is gone');
    assert.equal(effective[0]._provenance.source, 'store');
  });
});

describe('collectDefaults: the installed role packages as one list', () => {
  it('tags each record with its package and lets the first package win an id', () => {
    const list = collectDefaults([
      { source: 'generic', responsibilities: [{ id: 'r-a', name: 'generic a' }, { id: 'r-b' }] },
      { source: 'devops', responsibilities: [{ id: 'r-a', name: 'role a' }, { id: 'r-c' }, null, { name: 'no id' }] },
    ]);
    assert.deepEqual(list.map((r) => `${r.id}:${r._source}`), ['r-a:generic', 'r-b:generic', 'r-c:devops']);
    assert.equal(list[0].name, 'generic a');
  });

  it('accepts nothing at all', () => {
    assert.deepEqual(collectDefaults(undefined), []);
    assert.deepEqual(collectDefaults([{ source: 'generic' }]), []);
  });
});

describe('authoring: planWrite decides every write', () => {
  const base = { actor: 'agent', policy: DEFAULT_POLICY, nextFire: cronNextFire, now: '2026-09-26T00:00:00.000Z' };

  it('create writes the agent\'s own record: complete, valid, and never over an installed id', () => {
    const ok = planWrite({ ...base, verb: 'create', id: 'r-standup', input: own() });
    assert.equal(ok.ok, true);
    assert.equal(ok.doc.mode, 'own');
    assert.equal(ok.doc.revision, 1);
    assert.equal(ok.doc.updated_by, 'agent');
    assert.equal(ok.doc.updated_at, '2026-09-26T00:00:00.000Z');
    const missing = planWrite({ ...base, verb: 'create', id: 'r-x', input: { id: 'r-x', name: 'X', schedule: '0 9 * * *' } });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /instruction/);
    assert.match(missing.error, /context\.purpose/);
    const clash = planWrite({ ...base, verb: 'create', id: 'r-exec', input: own({ id: 'r-exec' }), installed: installedExec() });
    assert.match(clash.error, /use update to change it, or adopt/);
    const mismatch = planWrite({ ...base, verb: 'create', id: 'r-a', input: own({ id: 'r-b' }) });
    assert.match(mismatch.error, /does not match/);
  });

  it('update on an installed default stores only the change, as an override', () => {
    const p = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { schedule: '20 10 * * 4' }, installed: installedExec() });
    assert.equal(p.ok, true);
    assert.equal(p.doc.mode, 'override');
    assert.deepEqual(p.doc.patch, { schedule: '20 10 * * 4' });
    const next = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { enabled: false }, installed: installedExec(), current: { ...p.doc, updateTime: 't' } });
    assert.deepEqual(next.doc.patch, { schedule: '20 10 * * 4', enabled: false }, 'patches accumulate');
    assert.equal(next.doc.revision, 2);
  });

  it('a dashboard user is recorded as the writer', () => {
    const p = planWrite({ ...base, actor: 'user@example.com', verb: 'update', id: 'r-exec', input: { enabled: false }, installed: installedExec() });
    assert.equal(p.doc.updated_by, 'user@example.com');
  });

  it('refuses what the scheduler could not run: bad cron, unknown zone, a schedule under the floor', () => {
    const cron = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { schedule: '15 10 * * THU' }, installed: installedExec() });
    assert.match(cron.error, /day of week 'THU'/);
    const zone = planWrite({ ...base, verb: 'update', id: 'r-exec', input: { timezone: 'Central' }, installed: installedExec() });
    assert.match(zone.error, /not an IANA zone/);
    const fast = planWrite({ ...base, verb: 'create', id: 'r-fast', input: own({ id: 'r-fast', schedule: '*/10 * * * *' }) });
    assert.match(fast.error, /10 minute\(s\) apart; the floor between two fires is 15/);
  });

  it('locked upkeep cannot be changed, disabled, adopted or reset, and nobody can lock their own', () => {
    for (const verb of ['update', 'adopt', 'reset']) {
      const p = planWrite({ ...base, verb, id: 'r-memory-consolidation', input: verb === 'update' ? { enabled: false } : {}, installed: lockedBase() });
      assert.equal(p.ok, false, verb);
      assert.match(p.error, /locked/);
    }
    const self = planWrite({ ...base, verb: 'create', id: 'r-mine', input: own({ id: 'r-mine', locked: true }) });
    assert.match(self.error, /reserved for installed upkeep/);
  });

  it('remove deletes only what the agent created; reset drops changes to a default', () => {
    const current = { id: 'r-standup', mode: 'own', status: 'active', revision: 4, body: own(), updateTime: 't' };
    const rm = planWrite({ ...base, verb: 'remove', id: 'r-standup', current });
    assert.equal(rm.doc.status, 'removed');
    assert.equal(rm.doc.revision, 5, 'removal is a revision; the history keeps it');
    const defaultRm = planWrite({ ...base, verb: 'remove', id: 'r-exec', installed: installedExec() });
    assert.match(defaultRm.error, /enabled: false, or drop your changes with reset/);
    const override = { id: 'r-exec', mode: 'override', status: 'active', revision: 1, patch: { enabled: false }, updateTime: 't' };
    const reset = planWrite({ ...base, verb: 'reset', id: 'r-exec', current: override, installed: installedExec() });
    assert.equal(reset.doc.status, 'removed');
    assert.match(planWrite({ ...base, verb: 'reset', id: 'r-exec', installed: installedExec() }).error, /no changes to reset/);
  });

  it('reset will not silently delete an adopted responsibility whose default is gone', () => {
    const adopted = { id: 'r-exec', mode: 'own', status: 'active', revision: 1, adopted_from: 'assistant', body: { ...installedExec(), _source: undefined }, updateTime: 't' };
    const reset = planWrite({ ...base, verb: 'reset', id: 'r-exec', current: adopted, installed: null });
    assert.match(reset.error, /no longer an installed default/);
    assert.equal(planWrite({ ...base, verb: 'remove', id: 'r-exec', current: adopted }).doc.status, 'removed', 'remove still deletes it on purpose');
    const back = planWrite({ ...base, verb: 'reset', id: 'r-exec', current: adopted, installed: installedExec() });
    assert.equal(back.doc.status, 'removed');
    assert.equal(back.doc.adopted_from, 'assistant');
  });

  it('adopt copies the running definition (default + override) into the agent\'s own record', () => {
    const override = { id: 'r-exec', mode: 'override', status: 'active', revision: 1, patch: { schedule: '20 10 * * 4' }, updateTime: 't' };
    const p = planWrite({ ...base, verb: 'adopt', id: 'r-exec', current: override, installed: installedExec() });
    assert.equal(p.ok, true);
    assert.equal(p.doc.mode, 'own');
    assert.equal(p.doc.body.schedule, '20 10 * * 4', 'the override it already had is kept');
    assert.equal(p.doc.adopted_from, 'assistant');
    assert.equal(p.doc.body._source, undefined, 'scratch fields never reach the store');
    assert.match(planWrite({ ...base, verb: 'adopt', id: 'r-none' }).error, /not an installed default/);
  });

  it('revert restores an earlier revision as a new one', () => {
    const current = { id: 'r-standup', mode: 'own', status: 'active', revision: 3, body: own({ schedule: '0 7 * * 1-5' }), updateTime: 't' };
    const rev1 = { id: 'r-standup', mode: 'own', status: 'active', revision: 1, body: own() };
    const p = planWrite({ ...base, verb: 'revert', id: 'r-standup', current, revisionDoc: rev1 });
    assert.equal(p.doc.revision, 4);
    assert.equal(p.doc.reverted_from, 1);
    assert.equal(p.doc.body.schedule, '0 9 * * 1-5');
    assert.match(planWrite({ ...base, verb: 'revert', id: 'r-standup', current }).error, /no such revision/);
  });

  it('caps what the agent may own outright', () => {
    const p = planWrite({ ...base, verb: 'create', id: 'r-26', input: own({ id: 'r-26' }), ownCount: DEFAULT_POLICY.max_own });
    assert.match(p.error, /limit is 25/);
  });

  it('refuses an unknown verb and a missing id', () => {
    assert.match(planWrite({ ...base, verb: 'rename', id: 'r-a' }).error, /unknown verb/);
    assert.match(planWrite({ ...base, verb: 'create', id: '' }).error, /id is required/);
  });

  it('every installed default can be turned off by the agent, except locked upkeep', () => {
    // A toggle is the smallest override, and it must never be refused over a field the agent did not
    // touch: a template may ship a placeholder project id.
    const templated = { ...installedExec(), project_id: 'YOUR_PROJECT_ID' };
    assert.equal(planWrite({ ...base, verb: 'update', id: 'r-exec', input: { enabled: false }, installed: templated }).ok, true);
    assert.equal(planWrite({ ...base, verb: 'update', id: 'r-memory-consolidation', input: { enabled: false }, installed: lockedBase() }).ok, false);
  });
});

describe('cron validation matches what the scheduler can read', () => {
  it('accepts the forms the matcher implements and refuses the rest', () => {
    for (const ok of ['0 8 * * *', '20 10 * * 4', '*/15 * * * *', '0 9 * * 1-5', '0 9,17 * * *', '0 9 1 * *']) {
      assert.equal(checkCron(ok), null, ok);
    }
    for (const bad of ['0 8 * *', '0 25 * * *', '0 9 * * 7', '0 9 * * MON', '0 9 1-5/2 * *', '*/0 * * * *']) {
      assert.notEqual(checkCron(bad), null, bad);
    }
    assert.equal(checkFrequency('0 9 * * *', 15, cronNextFire), null);
    assert.match(checkFrequency('0,5 9 * * *', 15, cronNextFire), /5 minute/);
  });

  it('applyPatch never lets a patch rename a responsibility', () => {
    assert.equal(applyPatch({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }).id, 'a');
  });

  it('a body needs success criteria somewhere, and a schedule or an event but not both', () => {
    const body = own();
    assert.deepEqual(validateBody(body, opts), []);
    const nested = { ...body, success_criteria: undefined, context: { ...body.context, success_criteria: 'Posted and named each item.' } };
    assert.deepEqual(validateBody(nested, opts), []);
    assert.match(validateBody({ ...body, success_criteria: undefined }, opts).join('\n'), /success_criteria is required/);
    assert.match(validateBody({ ...body, event: 'on_failure' }, opts).join('\n'), /not both/);
    assert.match(validateBody({ ...body, schedule: null }, opts).join('\n'), /can never fire/);
    assert.match(validateBody({ ...body, owner: 'someone' }, opts).join('\n'), /owner: is not a declared field/);
    assert.equal(RESPONSIBILITY_BODY_SCHEMA.spec.properties.success_criteria.required, false);
  });
});

describe('policy and storage', () => {
  it('the policy is a contracts value, with defaults for anything missing or invalid', () => {
    assert.deepEqual(resolvePolicy({}), { refresh_ms: 60000, min_interval_minutes: 15, max_own: 25 });
    assert.deepEqual(
      resolvePolicy({ responsibility_store: { refresh_ms: 30000, min_interval_minutes: -1, max_own: 10 } }),
      { refresh_ms: 30000, min_interval_minutes: 15, max_own: 10 });
  });

  it('the store is the root responsibilities collection, read strictly so an outage throws', async () => {
    assert.equal(STORE_COLLECTION, COLLECTIONS.responsibilities);
    const calls = [];
    const db = { query: async (...args) => { calls.push(args); return [{ id: 'r-a' }]; } };
    assert.deepEqual(await readStore(db), [{ id: 'r-a' }]);
    assert.equal(calls[0][0], '', 'at the database root');
    assert.equal(calls[0][1], COLLECTIONS.responsibilities);
    assert.equal(calls[0][3].strict, true);
    assert.equal(calls[0][3].noOrderBy, true);
  });

  it('the signature changes when a record\'s revision or status does', () => {
    const a = storeSignature([{ id: 'r-b', revision: 1, status: 'active' }, { id: 'r-a', revision: 2, status: 'active' }]);
    assert.equal(a, 'r-a@2:active|r-b@1:active');
    assert.notEqual(a, storeSignature([{ id: 'r-b', revision: 1, status: 'removed' }, { id: 'r-a', revision: 2, status: 'active' }]));
  });
});
