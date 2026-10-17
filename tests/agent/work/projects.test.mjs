// Tests for agent/work/projects.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry, DEFAULT_PROJECT_ID } from '../../../agent/work/projects.mjs';
import {
  createClient, firestoreDecode, firestoreEncode, StoreConflict, StoreUnavailable,
} from '../../../agent/storage/firestore.mjs';
import { COLLECTIONS, SUBCOLLECTIONS } from '../../../agent/storage/collections.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const USER = 'user@example.com';

// ── Fakes ─────────────────────────────────────────────────────────────

const plain = (v) => firestoreDecode({ v }).v;

/**
 * A Firestore in memory behind the client interface: documents by path, EQUAL, IN and
 * ARRAY_CONTAINS filters, create-only preconditions, and a switch that makes every query fail.
 */
function fakeDb(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([path, data]) => [path, structuredClone(data)]));
  const state = { queriesFail: false };
  const matches = (doc, f) => {
    const v = doc[f.field];
    if (f.op === 'EQUAL') return v === plain(f.value);
    if (f.op === 'IN') return f.value.arrayValue.values.map(plain).includes(v);
    if (f.op === 'ARRAY_CONTAINS') return Array.isArray(v) && v.includes(plain(f.value));
    throw new Error(`fake query: unsupported op ${f.op}`);
  };
  return {
    docs,
    state,
    async read(path) { return docs.has(path) ? structuredClone(docs.get(path)) : null; },
    async write(path, data) { docs.set(path, structuredClone(data)); return {}; },
    async patch(path, mask, fields) {
      const doc = docs.get(path) || {};
      const decoded = firestoreDecode(fields);
      for (const f of mask) doc[f] = decoded[f];
      docs.set(path, doc);
      return {};
    },
    async query(parent, collection, filters, opts = {}) {
      if (state.queriesFail) {
        if (opts.strict) throw new StoreUnavailable('query', collection, 503, 'unavailable');
        return [];
      }
      const prefix = parent ? `${parent}/${collection}/` : `${collection}/`;
      return [...docs.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, d]) => ({ id: path.slice(prefix.length), ...structuredClone(d) }))
        .filter((d) => filters.every((f) => matches(d, f)))
        .slice(0, opts.limit || 300);
    },
    async commit(writes) {
      for (const w of writes) {
        if (w.precondition?.exists === false && docs.has(w.path)) throw new StoreConflict(w.path, 'ALREADY_EXISTS');
      }
      for (const w of writes) docs.set(w.path, structuredClone(w.data));
      return {};
    },
  };
}

const P = (id) => `${COLLECTIONS.projects}/${id}`;
const W = (id) => `${COLLECTIONS.work}/${id}`;

function registry(initial, extra = {}) {
  const db = fakeDb(initial);
  const logs = [];
  const history = [];
  let n = 0;
  const projects = createProjectRegistry({
    db,
    logger: (level, msg) => logs.push(`${level} ${msg}`),
    generateId: (prefix) => `${prefix}-${++n}`,
    writeHistory: async (...args) => { history.push(args); },
    clock: () => NOW,
    ...extra,
  });
  return { db, projects, logs, history };
}

const project = (over = {}) => ({ name: 'Marketing site', description: 'The public site', status: 'active', ...over });

// ── Loading and identity ──────────────────────────────────────────────

describe('loading', () => {
  it('a project stored without an id in its body loads under its document id (through the real client)', async () => {
    const DOCS = 'projects/your-gcp-project/databases/(default)/documents';
    const fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ document: { name: `${DOCS}/${COLLECTIONS.projects}/marketing-site`, fields: firestoreEncode(project()) } }],
    });
    const db = createClient({ projectId: 'your-gcp-project', getAccessToken: async () => 'token', fetch, logger: () => {} });
    const projects = createProjectRegistry({ db, logger: () => {}, clock: () => NOW });
    await projects.load();
    assert.equal(projects.get('marketing-site')?.id, 'marketing-site');
    assert.deepEqual(projects.list().map((p) => p.id), ['marketing-site']);
  });

  it('skips archived projects, fills defaults and indexes children', async () => {
    const { projects } = registry({
      [P('site')]: project(),
      [P('site-blog')]: project({ name: 'Blog', parent_id: 'site' }),
      [P('old')]: project({ status: 'archived' }),
    });
    await projects.load();
    assert.deepEqual(Object.keys(projects.getAll()).sort(), ['site', 'site-blog']);
    const site = projects.get('site');
    assert.equal(site.goal, '');
    assert.equal(site.parent_id, null);
    assert.deepEqual(site.depends_on, []);
    assert.equal(site.context, null);
    assert.deepEqual(projects.getChildren(), { site: ['site-blog'] });
  });

  it('a failed load keeps the projects last loaded', async () => {
    const { db, projects, logs } = registry({ [P('site')]: project() });
    await projects.load();
    db.state.queriesFail = true;
    await projects.load();
    assert.deepEqual(projects.list().map((p) => p.id), ['site']);
    assert.ok(logs.some((l) => /WARN Failed to load projects .*keeping the 1 last loaded/.test(l)));
  });

  it('ensureLoaded reloads only when stale', async () => {
    let t = NOW;
    const { db, projects } = registry({ [P('site')]: project() }, { clock: () => t, refreshMs: 60_000 });
    await projects.ensureLoaded();
    db.docs.set(P('blog'), project({ name: 'Blog' }));
    t += 30_000;
    await projects.ensureLoaded();
    assert.equal(projects.get('blog'), undefined, 'fresh: no reload');
    t += 31_000;
    await projects.ensureLoaded();
    assert.equal(projects.get('blog').name, 'Blog');
  });
});

describe('the project listing always carries real ids', () => {
  // A project listing once showed a placeholder dash where the id belonged, and the agent had to
  // guess which project was meant.
  it('lists every project with its id, sorted', async () => {
    const { projects } = registry({ [P('site')]: project(), [P('blog')]: { status: 'active' } });
    await projects.load();
    assert.deepEqual(projects.list(), [
      { id: 'blog', name: 'blog', status: 'active', description: '', parent_id: null },
      { id: 'site', name: 'Marketing site', status: 'active', description: 'The public site', parent_id: null },
    ]);
  });

  it('a cache update carrying a blank or different id keeps the real one', async () => {
    const { projects } = registry({ [P('site')]: project() });
    await projects.load();
    projects.update('site', { id: '', name: 'Renamed' });
    projects.update('new-one', { id: undefined, name: 'New' });
    projects.update('blog', { id: 'something-else' });
    assert.equal(projects.get('site').id, 'site');
    assert.equal(projects.get('site').name, 'Renamed');
    assert.equal(projects.get('new-one').id, 'new-one');
    assert.equal(projects.get('blog').id, 'blog');
    assert.deepEqual(projects.list().map((p) => p.id), ['blog', 'new-one', 'site']);
    assert.ok(projects.list().every((p) => p.id && p.id !== '-'));
  });

  it('the rendered context names the project by its id too', async () => {
    const { projects } = registry({ [P('site')]: project() });
    await projects.load();
    assert.match(projects.buildContext('site'), /^## Project Context: Marketing site \(site\)/);
  });
});

describe('the default project', () => {
  it('is created when absent and then loaded', async () => {
    const { db, projects } = registry({});
    await projects.load();
    assert.equal(await projects.ensureDefault(), DEFAULT_PROJECT_ID);
    assert.equal(projects.getDefaultId(), DEFAULT_PROJECT_ID);
    const doc = db.docs.get(P(DEFAULT_PROJECT_ID));
    assert.equal(doc.id, DEFAULT_PROJECT_ID);
    assert.equal(doc.name, 'General');
    assert.equal(doc.created_at, NOW_ISO);
    assert.equal('team' in doc, false, 'no team: one project holds one agent');
    assert.equal(projects.get(DEFAULT_PROJECT_ID).name, 'General');
  });

  it('is never overwritten when the project list failed to load', async () => {
    // It used to be written whenever it was missing from the loaded list, so a failed load replaced
    // the real default project, and its context, with a blank one.
    const real = project({ name: 'General', context: { site_repo: { kind: 'repo', ref: 'example/site' } } });
    const { db, projects } = registry({ [P(DEFAULT_PROJECT_ID)]: real });
    db.state.queriesFail = true;
    await projects.load();
    await projects.ensureDefault();
    assert.deepEqual(db.docs.get(P(DEFAULT_PROJECT_ID)), real);
  });

  it('is assigned to a mission that names no project', async () => {
    const { projects } = registry({});
    await projects.ensureDefault();
    assert.equal(projects.validateMissionProject({ id: 'w-1', type: 'M' }).project_id, DEFAULT_PROJECT_ID);
    assert.equal(projects.validateMissionProject({ id: 'w-2', type: 'M', project_id: 'site' }).project_id, 'site');
    assert.equal(projects.validateMissionProject({ id: 'w-3', type: 'C' }).project_id, undefined);
  });
});

// ── Hierarchy and dependencies ────────────────────────────────────────

describe('hierarchy', () => {
  it('accumulates context root first, the most specific project winning, with no team', async () => {
    const { projects } = registry({
      [P('root')]: project({ context: { documentation: ['root.md'], configuration: { region: 'us', tone: 'formal' } } }),
      [P('leaf')]: project({ parent_id: 'root', context: { documentation: ['leaf.md'], configuration: { tone: 'plain' }, team: { a: 1 } } }),
    });
    await projects.load();
    const { chain, context } = projects.getAccumulatedContext('leaf');
    assert.deepEqual(chain.map((c) => c.id), ['root', 'leaf']);
    assert.deepEqual(context.documentation, ['root.md', 'leaf.md']);
    assert.deepEqual(context.configuration, { region: 'us', tone: 'plain' });
    assert.equal('team' in context, false);
  });

  it('refuses nesting deeper than the maximum', async () => {
    const { projects } = registry({
      [P('a')]: project(), [P('b')]: project({ parent_id: 'a' }),
      [P('c')]: project({ parent_id: 'b' }), [P('d')]: project({ parent_id: 'c' }),
    });
    await projects.load();
    assert.equal(projects.validateDepth('c'), true);
    assert.throws(() => projects.validateDepth('d'), /exceeds maximum of 4/);
  });

  it('detects a dependency cycle', () => {
    const { projects } = registry({});
    const envelopes = { b: { depends_on: ['c'] }, c: { depends_on: ['a'] } };
    assert.equal(projects.hasCircularDep('a', 'b', envelopes), true);
    assert.equal(projects.hasCircularDep('a', 'x', envelopes), false);
  });
});

describe('dependencies between missions', () => {
  it('a mission waits until every dependency is complete; a missing one does not block', async () => {
    const { projects } = registry({ [W('w-done')]: { status: 'complete' }, [W('w-busy')]: { status: 'active' } });
    assert.equal(await projects.checkDependencies({ depends_on: ['w-done', 'w-gone'] }), true);
    assert.equal(await projects.checkDependencies({ depends_on: ['w-done', 'w-busy'] }), false);
    assert.equal(await projects.checkDependencies({}), true);
  });

  it('a read failure fails open', async () => {
    const { db, projects } = registry({});
    db.read = async () => { throw new Error('HTTP 503'); };
    assert.equal(await projects.checkDependencies({ depends_on: ['w-x'] }), true);
  });

  it('activates the pending missions whose last dependency just completed', async () => {
    const { db, projects, history } = registry({
      [W('w-a')]: { status: 'complete' },
      [W('w-b')]: { status: 'active' },
      [W('w-ready')]: { id: 'w-ready', type: 'M', status: 'pending', depends_on: ['w-a'] },
      [W('w-still')]: { id: 'w-still', type: 'M', status: 'pending', depends_on: ['w-a', 'w-b'] },
      [W('w-task')]: { id: 'w-task', type: 'T', status: 'pending', depends_on: ['w-a'] },
    });
    await projects.activateDependents('w-a');
    assert.equal(db.docs.get(W('w-ready')).status, 'active');
    assert.equal(db.docs.get(W('w-ready')).started_at, NOW_ISO);
    assert.equal(db.docs.get(W('w-still')).status, 'pending');
    assert.equal(db.docs.get(W('w-task')).status, 'pending');
    assert.deepEqual(history, [['w-ready', 'pending', 'active', 'brain', 'Dependencies cleared — auto-activated']]);
  });
});

describe('project completion', () => {
  const world = (missionStatus) => registry({
    [P('parent')]: project({ auto_complete: true }),
    [P('child')]: project({ parent_id: 'parent', auto_complete: true }),
    [P('manual')]: project(),
    [W('w-1')]: { type: 'M', project_id: 'child', status: missionStatus },
  });

  it('an opted-in project with all work done completes, and so does its parent', async () => {
    const { db, projects } = world('complete');
    await projects.load();
    await projects.checkCompletion('child');
    assert.equal(db.docs.get(P('child')).status, 'complete');
    assert.equal(db.docs.get(P('child')).completed_at, NOW_ISO);
    assert.equal(db.docs.get(P('parent')).status, 'complete', 'the cascade reaches the parent');
    assert.equal(db.docs.get(P('child')).name, 'Marketing site', 'only the status fields are written');
  });

  it('an open mission keeps the project open', async () => {
    const { db, projects } = world('awaiting_approval');
    await projects.load();
    await projects.checkCompletion('child');
    assert.equal(db.docs.get(P('child')).status, 'active');
  });

  it('a project that did not opt in never completes itself', async () => {
    const { db, projects } = world('complete');
    await projects.load();
    await projects.checkCompletion('manual');
    assert.equal(db.docs.get(P('manual')).status, 'active');
  });

  it('a failed query leaves the project open', async () => {
    const { db, projects } = world('complete');
    await projects.load();
    db.state.queriesFail = true;
    await projects.checkCompletion('child');
    assert.equal(db.docs.get(P('child')).status, 'active');
  });
});

// ── Rendering ─────────────────────────────────────────────────────────

describe('buildContext', () => {
  const rich = project({
    canon: { entries: [{ key: 'brand', text: 'The product name is lowercase.' }, { key: 'empty' }] },
    deploy: { platform: 'firebase-hosting', gcp_project: 'marketing-site', hosting_site: 'acme-www' },
    context: {
      drive_folder: { kind: 'drive_folder', ref: 'folder-1', name: 'Site files' },
      style_guide: { kind: 'doc', ref: 'doc-1', name: 'Style guide', summary: 'Voice and tone.', updatedAt: '2026-10-01T00:00:00Z', updatedBy: USER },
      artifacts: { files: [{ name: 'home.html', url: 'https://example.com/home.html' }] },
    },
    team: [{ email: 'someone@example.com', name: 'Someone', role: 'lead' }],
  });

  it('renders canon first, then the deploy target, the context packets and the shared folder', async () => {
    const { projects } = registry({ [P('site')]: rich });
    await projects.load();
    const text = projects.buildContext('site');
    assert.match(text, /### ⚠️ CANON[^\n]*\n- \*\*brand\*\*: The product name is lowercase\./);
    assert.doesNotMatch(text, /\*\*empty\*\*/);
    assert.match(text, /## Deployment \(authoritative/);
    assert.match(text, /--site acme-www --project marketing-site/);
    assert.match(text, /style_guide \(doc\): Style guide\n {2}ID: doc-1 \| Updated: 2026-10-01 by user@example\.com\n {2}Voice and tone\./);
    assert.match(text, /## Shared Workspace \(Google Drive\)/);
    assert.match(text, /https:\/\/drive\.google\.com\/drive\/folders\/folder-1/);
    assert.match(text, /with the drive skill/);
    assert.match(text, /- home\.html — https:\/\/example\.com\/home\.html/);
    assert.ok(text.indexOf('CANON') < text.indexOf('Deployment'));
  });

  it('lists no people from a stray team field', async () => {
    const { projects } = registry({ [P('site')]: rich });
    await projects.load();
    const text = projects.buildContext('site');
    assert.doesNotMatch(text, /### Team/);
    assert.doesNotMatch(text, /someone@example\.com/);
  });

  it('an envelope\'s packets win over the project\'s, and artifacts without a folder still list', async () => {
    const { projects } = registry({ [P('site')]: project({ context: { notes_doc: { kind: 'doc', ref: 'd-1', name: 'Old' } } }) });
    await projects.load();
    const text = projects.buildContext('site', {
      notes_doc: { kind: 'doc', ref: 'd-2', name: 'New' },
      artifacts: { drive_url: 'https://drive.google.com/drive/folders/f', files: [{ name: 'a.pdf', driveId: 'x-1' }] },
    });
    assert.match(text, /notes_doc \(doc\): New/);
    assert.match(text, /## Project Artifacts \(Google Drive\)/);
    assert.match(text, /- a\.pdf — driveId: x-1/);
  });

  it('is null for an unknown project, or one with nothing to say', async () => {
    const { projects } = registry({ [P('bare')]: { status: 'active' } });
    await projects.load();
    assert.equal(projects.buildContext('nope'), null);
    assert.equal(projects.buildContext(null), null);
    assert.equal(projects.buildContext('bare'), null);
  });
});

// ── Context promotion ─────────────────────────────────────────────────

describe('suggestContextPromotions', () => {
  const mission = {
    id: 'w-m1',
    project_id: 'site',
    context: {
      site_repo: { kind: 'repo', ref: 'example/site', name: 'Site repo', url: 'https://example.com/site.git' },
      existing: { kind: 'doc', ref: 'd-9' },
      deploy_history: { kind: 'resource', summary: 'Three attempts' },
      resources: { kind: 'resource', summary: 'the mission ledger' },
      bare: 'just a string',
    },
  };

  it('writes only durable resource references as candidates for a person to approve', async () => {
    const { db, projects, logs } = registry({ [P('site')]: project({ context: { existing: { kind: 'doc', ref: 'd-1' } } }) });
    await projects.load();
    await projects.suggestContextPromotions(mission);
    const candidates = [...db.docs.entries()].filter(([path]) => path.startsWith(`${P('site')}/${SUBCOLLECTIONS.projectPromotions}/`));
    assert.equal(candidates.length, 1);
    const [path, doc] = candidates[0];
    assert.equal(path, `${P('site')}/${SUBCOLLECTIONS.projectPromotions}/promo-1`);
    assert.equal(doc.key, 'site_repo');
    assert.deepEqual(doc.entry, mission.context.site_repo);
    assert.equal(doc.source_mission_id, 'w-m1');
    assert.equal(doc.status, 'pending');
    assert.equal(doc.suggested_at, NOW_ISO);
    assert.ok(logs.some((l) => /skipped 'deploy_history'/.test(l)), 'a history key is refused');
    assert.ok(logs.some((l) => /skipped 'bare'/.test(l)), 'a bare value is refused');
    assert.ok(!logs.some((l) => /skipped 'resources'/.test(l)), 'the resource ledger is skipped silently');
  });

  it('auto-promotion merges in every field of every entry', async () => {
    // An earlier encoder kept only kind, ref, name and summary, so every promotion stripped the
    // URLs and update stamps from the project's existing entries.
    const existing = { kind: 'url', url: 'https://example.com', name: 'Live site', updatedAt: '2026-10-01T00:00:00Z', updatedBy: USER };
    const { db, projects } = registry({ [P('site')]: project({ context: { live_site: existing } }) }, { promotionAuto: true });
    await projects.load();
    await projects.suggestContextPromotions(mission);
    const context = db.docs.get(P('site')).context;
    assert.deepEqual(context.live_site, existing);
    assert.deepEqual(context.site_repo, mission.context.site_repo);
    assert.equal(db.docs.get(P('site')).name, 'Marketing site', 'only the context field is written');
    assert.deepEqual(projects.get('site').context.site_repo, mission.context.site_repo, 'and the cache follows');
  });

  it('does nothing for a mission without a known project or context', async () => {
    const { db, projects } = registry({ [P('site')]: project() });
    await projects.load();
    const before = db.docs.size;
    await projects.suggestContextPromotions({ id: 'w-1', project_id: 'nope', context: mission.context });
    await projects.suggestContextPromotions({ id: 'w-2', project_id: 'site' });
    assert.equal(db.docs.size, before);
  });
});
