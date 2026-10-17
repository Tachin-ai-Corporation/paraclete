// Tests for dashboard/lib/server/library.mjs: playbooks and projects read back the way the agent's own
// commands write them (process-ops, project-manage, the projects registry's promotion candidates), and
// a "run now" trigger followed from the control service's write to the brain's verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDashboard } from '../../harness.mjs';
import { listProcesses, getProcess, listProjects, getProject, readTrigger } from '../../../../dashboard/lib/server/library.mjs';
import { StoreUnavailable } from '../../../../agent/storage/firestore.mjs';
import { main as processOps } from '../../../../agent/cli/process-ops.mjs';
import { main as projectManage } from '../../../../agent/cli/project-manage.mjs';
import { createProjectRegistry } from '../../../../agent/work/projects.mjs';
import { runResponsibility } from '../../../../agent/services/control/responsibilities.mjs';
import { createEnvelopeStore } from '../../../../agent/services/brain/envelope-store.mjs';
import { createResponsibilities } from '../../../../agent/services/brain/responsibilities.mjs';
import { fakeRuntime, run } from '../../../agent/cli/fakes.mjs';
import { controlRuntime } from '../../../agent/services/control/fakes.mjs';

const NOW = new Date('2027-01-15T08:00:00.000Z');

async function setup(t) {
  const dash = await startDashboard();
  t.after(dash.stop);
  const agent = fakeRuntime({ db: dash.runtime.db });
  const cli = async (main, argv, at = NOW) => {
    const r = await run(main, argv, { runtime: agent, now: () => at });
    assert.equal(r.code, 0, r.err);
    return r;
  };
  return { dash, cli };
}

test('stored playbooks are listed active first, then by name, as process-ops writes them', async (t) => {
  const { dash, cli } = await setup(t);
  await cli(processOps, ['write', 'p-review', '--name', 'Review', '--description', 'Review a change', '--narrative', 'Read it twice.', '--tags', 'code,review']);
  await cli(processOps, ['write', 'p-audit', '--name', 'Audit', '--description', 'Audit a system', '--narrative', 'Start from the logs.']);
  await cli(processOps, ['write', 'p-old', '--name', 'Aardvark', '--description', 'An old way', '--narrative', 'Gone.']);
  await cli(processOps, ['retire', 'p-old']);

  const { processes, limited } = await listProcesses(dash.runtime);
  assert.equal(limited, false);
  assert.deepEqual(processes.map((p) => `${p.status}:${p.id}`), ['active:p-audit', 'active:p-review', 'deprecated:p-old']);
  assert.deepEqual(processes[1], {
    id: 'p-review',
    name: 'Review',
    description: 'Review a change',
    status: 'active',
    version: null,
    intent_keywords: [],
    scope: { project_id: null, tags: ['code', 'review'] },
    has_narrative: true,
    updated_by: 'agent',
    updated_at: '2027-01-15T08:00:00Z',
    created_at: '2027-01-15T08:00:00Z',
  });
});

test('one playbook comes with its narrative and its earlier versions, newest first', async (t) => {
  const { dash, cli } = await setup(t);
  await cli(processOps, ['write', 'p-plan', '--name', 'Plan and Build', '--description', 'Plan, then build', '--narrative', 'Small, verified steps.']);
  await dash.seed({
    'processes/p-plan/revisions/r1': { revision: 1, name: 'Plan', narrative: 'Build it all at once.', updated_by: 'agent', updated_at: '2027-01-01T00:00:00Z' },
    'processes/p-plan/revisions/r2': { revision: 2, name: 'Plan and Build', narrative: 'Build in steps.', updated_by: 'admin@example.com', updated_at: '2027-01-08T00:00:00.000Z' },
  });
  const detail = await getProcess(dash.runtime, 'p-plan');
  assert.equal(detail.narrative, 'Small, verified steps.');
  assert.equal(detail.name, 'Plan and Build');
  assert.deepEqual(detail.revisions.map((r) => [r.id, r.revision, r.updated_by]), [['r2', 2, 'admin@example.com'], ['r1', 1, 'agent']]);

  await assert.rejects(getProcess(dash.runtime, 'p-missing'), (err) => err.status === 404);
  for (const bad of ['../users', 'a/b', '.', '__name__', '', null]) {
    await assert.rejects(getProcess(dash.runtime, bad), (err) => err.status === 400);
  }
});

test('projects are listed by status, archived ones included, with what each holds', async (t) => {
  const { dash, cli } = await setup(t);
  const create = (body) => cli(projectManage, ['create', JSON.stringify({ description: '', goal: '', context: {}, ...body })]);
  await create({ id: 'website', name: 'Website', goal: 'Keep the site current', context: { site_repo: { kind: 'repo', ref: 'your-org/site' } } });
  await create({ id: 'blog', name: 'Blog', parent_id: 'website' });
  await create({ id: 'old-site', name: 'Old site' });
  await cli(projectManage, ['archive', 'old-site']);
  await create({ id: 'launch', name: 'Launch', depends_on: ['website'] });
  await cli(projectManage, ['pause', 'launch']);
  await cli(projectManage, ['canon-set', 'website', 'domain', 'The site lives at example.com']);

  const { projects } = await listProjects(dash.runtime);
  assert.deepEqual(projects.map((p) => `${p.status}:${p.id}`), ['active:blog', 'active:website', 'paused:launch', 'archived:old-site']);
  const website = projects.find((p) => p.id === 'website');
  assert.deepEqual(
    [website.goal, website.context_count, website.canon_count, website.created_by],
    ['Keep the site current', 1, 1, 'agent'],
  );
  assert.equal(projects.find((p) => p.id === 'blog').parent_id, 'website');
  assert.deepEqual(projects.find((p) => p.id === 'launch').depends_on, ['website']);
});

test('one project shows its context, canon, linked playbooks, deploy target and suggested context', async (t) => {
  const { dash, cli } = await setup(t);
  await cli(projectManage, ['create', JSON.stringify({
    id: 'website', name: 'Website', description: 'The public site', goal: 'Keep it current',
    context: { site_repo: { kind: 'repo', ref: 'your-org/site', url: 'https://example.com/site.git' } },
    deploy: { platform: 'firebase-hosting', gcp_project: 'your-gcp-project', site: 'www', source: { kind: 'repo', ref: 'your-org/site' } },
  }), '--processes', 'p-release,p-review']);
  await cli(projectManage, ['add-context', 'website', 'tone', 'Plain words, short sentences.']);
  await cli(projectManage, ['canon-set', 'website', 'domain', 'The site lives at example.com']);

  // A finished mission's new context becomes candidates for a person to approve.
  const registry = createProjectRegistry({ db: dash.runtime.db, logger: () => {}, generateId: (p) => `${p}-1`, clock: () => NOW.getTime() });
  await registry.load();
  await registry.suggestContextPromotions({
    id: 'w-mission-1', project_id: 'website',
    context: { brand_guide: { kind: 'doc', ref: '1XyZ', name: 'Brand guide', summary: 'Colors and type' }, deploy_log: { kind: 'doc', ref: 'x' } },
  });
  await dash.seed({ 'projects/website/promotions/promo-0': { key: 'old_folder', entry: { kind: 'drive_folder', ref: 'abc' }, status: 'accepted', suggested_at: '2027-01-02T00:00:00Z' } });

  const p = await getProject(dash.runtime, 'website');
  assert.deepEqual([p.name, p.description, p.goal, p.status], ['Website', 'The public site', 'Keep it current', 'active']);
  assert.deepEqual(p.context.map((c) => c.key), ['site_repo', 'tone']);
  assert.deepEqual(p.context[0], {
    key: 'site_repo', kind: 'repo', name: null, ref: 'your-org/site', url: 'https://example.com/site.git', summary: null,
    updated_at: null, updated_by: null, value: null,
  });
  assert.deepEqual([p.context[1].kind, p.context[1].summary, p.context[1].updated_by, p.context[1].updated_at], ['convention', 'Plain words, short sentences.', 'agent', NOW.toISOString()]);
  assert.deepEqual(p.canon.authority, ['paraclete-agent@your-gcp-project.iam.gserviceaccount.com']);
  assert.deepEqual(p.canon.entries.map((e) => [e.key, e.text]), [['domain', 'The site lives at example.com']]);
  assert.deepEqual(p.standard_processes, ['p-release', 'p-review']);
  assert.deepEqual(p.deploy, { platform: 'firebase-hosting', gcp_project: 'your-gcp-project', hosting_site: 'www', source: { kind: 'git', ref: 'your-org/site' }, flow: '' });
  assert.deepEqual(p.promotions.map((x) => [x.id, x.key, x.status]), [['promo-1', 'brand_guide', 'pending'], ['promo-0', 'old_folder', 'accepted']]);
  assert.deepEqual(
    [p.promotions[0].kind, p.promotions[0].name, p.promotions[0].summary, p.promotions[0].source_mission_id, p.promotions[0].suggested_at],
    ['doc', 'Brand guide', 'Colors and type', 'w-mission-1', NOW.toISOString()],
  );

  await assert.rejects(getProject(dash.runtime, 'nowhere'), (err) => err.status === 404);
});

test('context written before resource packets existed still shows, as its value', async (t) => {
  const { dash } = await setup(t);
  await dash.seed({ 'projects/legacy': { name: 'Legacy', context: { documentation: ['README', 'GUIDE'], owner_note: 'ask first' }, canon: 'not a map' } });
  const p = await getProject(dash.runtime, 'legacy');
  assert.deepEqual(p.context.map((c) => [c.key, c.value]), [['documentation', '["README","GUIDE"]'], ['owner_note', 'ask first']]);
  assert.deepEqual(p.canon, { authority: [], entries: [] });
  assert.equal(p.deploy, null);
});

test('a run-now trigger is followed from the control service writing it to the brain firing it', async (t) => {
  const { dash } = await setup(t);
  const control = controlRuntime({ db: dash.runtime.db });
  const digest = { id: 'r-weekly-digest', name: 'Weekly digest', schedule: '0 9 * * 1', enabled: true, triggerable: true, instruction: 'Write the digest', success_criteria: 'A digest was delivered' };
  writeFileSync(join(control.paths.genericRole, 'responsibilities.json'), JSON.stringify({ responsibilities: [digest] }));

  const queued = await runResponsibility({ ...control, id: 'r-weekly-digest', commandId: 'Cmd123', actor: 'admin@example.com', nowIso: () => NOW.toISOString() });
  const pending = await readTrigger(dash.runtime, queued.trigger_id);
  assert.deepEqual(pending, {
    id: 'Cmd123', responsibility_id: 'r-weekly-digest', status: 'pending', finished: false, detail: null,
    requested_by: 'admin@example.com', requested_at: NOW.toISOString(), claimed_at: null, fired_at: null,
  });

  const store = createEnvelopeStore({ db: dash.runtime.db, clock: () => NOW.getTime(), defaultProjectId: () => 'general' });
  const brain = createResponsibilities({
    db: dash.runtime.db, store, contracts: dash.runtime.contracts, defaults: [{ source: 'generic', responsibilities: [digest] }],
    recall: async () => ({}), clock: () => NOW.getTime(),
  });
  brain.scheduler.loadResponsibilities();
  await brain.checkTriggers();
  const fired = await readTrigger(dash.runtime, 'Cmd123');
  assert.deepEqual([fired.status, fired.finished, fired.detail, fired.fired_at], ['fired', true, 'Weekly digest', NOW.toISOString()]);
  assert.equal(fired.claimed_at, NOW.toISOString());

  await dash.seed({ 'responsibility_triggers/Cmd999': { responsibility_id: 'r-gone', status: 'pending', requested_by: 'admin@example.com' } });
  await brain.checkTriggers();
  const failed = await readTrigger(dash.runtime, 'Cmd999');
  assert.deepEqual([failed.status, failed.finished, failed.detail], ['error', true, "responsibility 'r-gone' not found"]);

  await assert.rejects(readTrigger(dash.runtime, 'NoSuchTrigger'), (err) => err.status === 404);
  await assert.rejects(readTrigger(dash.runtime, 'bad/id'), (err) => err.status === 400);
});

test('an outage is an error, never an empty library', async (t) => {
  const { dash } = await setup(t);
  const down = () => new StoreUnavailable('query', 'x', 503, 'unavailable');
  const db = {
    query: async (parent, collection, filters, opts = {}) => { if (opts.strict) throw down(); return []; },
    read: async (path, opts = {}) => { if (opts.strict) throw down(); return null; },
  };
  const runtime = { ...dash.runtime, db };
  await assert.rejects(listProcesses(runtime), StoreUnavailable);
  await assert.rejects(listProjects(runtime), StoreUnavailable);
  await assert.rejects(getProcess(runtime, 'p-plan'), StoreUnavailable);
  await assert.rejects(getProject(runtime, 'website'), StoreUnavailable);
  await assert.rejects(readTrigger(runtime, 'Cmd123'), StoreUnavailable);
});
