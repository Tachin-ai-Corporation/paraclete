// Tests for agent/cli/project-manage.mjs. Includes the canonical-id listing case: a project's id comes
// from its document path, never a stored field, which once printed a placeholder dash.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/project-manage.mjs';
import { StoreConflict } from '../../../agent/storage/firestore.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const AGENT_EMAIL = 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com';

const project = (over = {}) => ({
  name: 'Site', description: 'The marketing site', goal: 'Keep it fast', status: 'active',
  parent_id: null, depends_on: [], context: {}, created_at: '2026-10-01T00:00:00.000Z', ...over,
});

function setup(initial = {}) {
  const db = fakeDb(initial);
  const runtime = fakeRuntime({ db });
  return { db, pm: (argv, deps = {}) => run(main, argv, { runtime, now: () => NOW, ...deps }) };
}

describe('list and get', () => {
  test('every listed id is the document id, whatever the stored body says', async () => {
    const { pm } = setup({
      'projects/site': project({ id: 'site' }),
      'projects/no-id-field': project({ name: 'Stored without id' }),
      'projects/copied': project({ id: 'copied-from-elsewhere', name: 'Copied', status: 'archived', parent_id: 'site', depends_on: ['site'], standardProcesses: ['p-plan'] }),
    });
    const r = await pm(['list']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([...r.out.matchAll(/^ {2}(\S+)$/gm)].map((m) => m[1]), ['copied', 'no-id-field', 'site']);
    assert.doesNotMatch(r.out, /^ {2}—$/m, 'no placeholder dash where an id belongs');
    assert.doesNotMatch(r.out, /copied-from-elsewhere/);
    assert.ok(r.out.includes([
      '  copied',
      '    Name:        Copied',
      '    Status:      archived',
      '    Description: The marketing site',
      '    Goal:        Keep it fast',
      '    Parent:      site',
      '    Depends on:  1 project(s)',
      '    Processes:   p-plan',
      '',
    ].join('\n')), r.out);
    assert.match(r.out, /Total: 3 projects\n$/);
  });

  test('no projects, and an outage, say so differently', async () => {
    const { db, pm } = setup();
    assert.equal((await pm(['list'])).out, 'No projects found.\n');
    db.state.down = true;
    const r = await pm(['list']);
    assert.equal(r.code, 1);
    assert.match(r.err, /could not be reached/);
  });

  test('get prints the project as JSON with its document id', async () => {
    const { pm } = setup({ 'projects/site': project({ id: 'wrong' }) });
    const r = await pm(['get', 'site']);
    assert.equal(JSON.parse(r.out).id, 'site');
    const missing = await pm(['get', 'nope']);
    assert.deepEqual([missing.code, missing.err], [1, 'ERROR: Project "nope" not found\n']);
  });
});

describe('create', () => {
  const body = (over = {}) => JSON.stringify({ id: 'docs', name: 'Docs', description: 'Product docs', goal: 'Accurate docs', context: {}, ...over });

  test('creates an active project with its id stamped, and no owner or team', async () => {
    const { db, pm } = setup();
    const r = await pm(['create', body({ owner: 'someone@example.com', team: ['x'] }), '--processes', 'p-plan, p-review']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, [
      "Created project 'docs'.",
      '  Name:        Docs',
      '  Status:      active',
      '  Description: Product docs',
      '  Goal:        Accurate docs',
      '  Processes:   p-plan, p-review',
      '',
    ].join('\n'));
    assert.match(r.err, /Ignored owner, team: projects have no owner or team/);
    const doc = db.docs.get('projects/docs');
    assert.equal(doc.id, 'docs');
    assert.equal(doc.created_by, 'agent');
    assert.equal(doc.created_at, NOW.toISOString());
    assert.deepEqual(doc.standardProcesses, ['p-plan', 'p-review']);
    for (const field of ['owner', 'team']) assert.ok(!(field in doc), field);
  });

  test('never overwrites an existing project', async () => {
    const { db, pm } = setup({ 'projects/docs': project({ name: 'Kept' }) });
    const r = await pm(['create', body()]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Project "docs" already exists; use update/);
    assert.equal(db.docs.get('projects/docs').name, 'Kept');
  });

  test('checks required fields, the id, the context and the parent', async () => {
    const { pm } = setup({
      'projects/a': project(), 'projects/b': project({ parent_id: 'a' }),
      'projects/c': project({ parent_id: 'b' }), 'projects/d': project({ parent_id: 'c' }),
    });
    const cases = [
      [JSON.stringify({ id: 'x', name: 'X' }), /Missing required fields: \['description', 'context', 'goal'\]/],
      [body({ id: 'Bad Id' }), /project id "Bad Id" must be lowercase/],
      [body({ context: [] }), /context must be a JSON object\/map/],
      [body({ context: { deploy_history: { kind: 'doc', ref: 'x' } } }), /context key "deploy_history": key names history/],
      [body({ context: { site_url: 'https://example.com' } }), /context key "site_url": value must be a resource packet/],
      [body({ parent_id: 'ghost' }), /parent_id "ghost" not found/],
      [body({ parent_id: 'd' }), /Project nesting depth exceeds maximum of 4/],
      [body({ parent_id: 'docs' }), /a project cannot be its own parent/],
    ];
    for (const [json, error] of cases) {
      const r = await pm(['create', json]);
      assert.equal(r.code, 1, json);
      assert.match(r.err, error, json);
    }
    assert.equal((await pm(['create', body({ parent_id: 'c' })])).code, 0, 'four levels deep is allowed');
  });
});

describe('update and status', () => {
  test('update merges context by key, checks status, and clears processes with --processes ""', async () => {
    const { db, pm } = setup({
      'projects/site': project({ context: { repo: { kind: 'repo', ref: 'site' } }, standardProcesses: ['p-plan'] }),
    });
    const r = await pm(['update', 'site', JSON.stringify({ goal: 'Faster', context: { drive_folder: { kind: 'drive_folder', ref: 'f1' } } }), '--processes', '']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "Updated project 'site'.\n");
    assert.match(r.err, /Cleared standardProcesses\./);
    const doc = db.docs.get('projects/site');
    assert.equal(doc.goal, 'Faster');
    assert.deepEqual(Object.keys(doc.context).sort(), ['drive_folder', 'repo']);
    assert.ok(!('standardProcesses' in doc));
    assert.equal(doc.updated_at, NOW.toISOString());
    const bad = await pm(['update', 'site', '{"status":"done"}']);
    assert.match(bad.err, /Invalid status "done"\. Must be one of: \['active', 'complete', 'paused', 'archived'\]/);
  });

  test('complete sets the status the rest of the agent reads, complete, with completed_at', async () => {
    // It used to write "completed", which nothing else recognized.
    const { db, pm } = setup({ 'projects/site': project() });
    const r = await pm(['complete', 'site']);
    assert.equal(r.out, "Completed project 'site'.\n");
    assert.equal(db.docs.get('projects/site').status, 'complete');
    assert.equal(db.docs.get('projects/site').completed_at, NOW.toISOString());
    await pm(['pause', 'site']);
    assert.equal(db.docs.get('projects/site').status, 'paused');
    assert.equal((await pm(['archive', 'site'])).out, "Archived project 'site'.\n");
  });

  test('a project changed by someone else meanwhile is not overwritten', async () => {
    const { db } = setup({ 'projects/site': project() });
    const racing = { ...db, commit: async () => { throw new StoreConflict('projects/site', 'FAILED_PRECONDITION'); } };
    const r = await run(main, ['pause', 'site'], { runtime: fakeRuntime({ db: racing }), now: () => NOW });
    assert.equal(r.code, 1);
    assert.match(r.err, /changed while this command ran; nothing was written/);
  });
});

describe('canon', () => {
  test('the first entry makes the agent the authority; entries update in place', async () => {
    const { db, pm } = setup({ 'projects/site': project() });
    let r = await pm(['canon-set', 'site', 'brand', 'Blue', 'is', 'the', 'brand', 'color']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `Added canon entry "brand" on project "site"\n  Key: brand\n  Text: Blue is the brand color\n  By: ${AGENT_EMAIL}\n`);
    r = await pm(['canon-set', 'site', 'brand', '--stdin'], { readStdin: () => "It's teal now" });
    assert.match(r.out, /^Updated canon entry "brand"/);
    const canon = db.docs.get('projects/site').canon;
    assert.deepEqual(canon.authority, [AGENT_EMAIL]);
    assert.equal(canon.entries.length, 1);
    assert.equal(canon.entries[0].text, "It's teal now");
    r = await pm(['canon-list', 'site']);
    assert.equal(r.out, [
      'Canon for project "site" (1 entries):',
      `Authority: ['${AGENT_EMAIL}']`,
      '',
      '  [1] brand',
      "      It's teal now",
      `      (by ${AGENT_EMAIL} at ${NOW.toISOString()})`,
      '',
      '',
    ].join('\n'));
  });

  test('only the authority list may change canon; the Workspace account is the agent\'s identity', async () => {
    const canon = { authority: ['owner@example.com'], entries: [{ key: 'k', text: 't' }] };
    const { db, pm } = setup({ 'projects/site': project({ canon }) });
    let r = await pm(['canon-remove', 'site', 'k']);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`${AGENT_EMAIL.replace(/\./g, '\\.')} is not in the canon authority list: \\['owner@example\\.com'\\]`));
    const runtime = fakeRuntime({
      db: fakeDb({ 'projects/site': project({ canon }) }),
      instance: { workspace: { account: 'owner@example.com', signer: 'signer@example.com' } },
    });
    r = await run(main, ['canon-remove', 'site', 'k'], { runtime, now: () => NOW });
    assert.equal(r.out, 'Removed canon entry "k" from project "site"\n');
    r = await run(main, ['canon-remove', 'site', 'k'], { runtime, now: () => NOW });
    assert.equal(r.out, 'Canon entry "k" not found on project "site".\n');
    r = await pm(['canon-authority', 'site', 'a@example.com', 'b@example.com']);
    assert.equal(r.out, 'Updated canon authority for project "site":\n  - a@example.com\n  - b@example.com\n');
    assert.deepEqual(db.docs.get('projects/site').canon.authority, ['a@example.com', 'b@example.com']);
  });
});

describe('context and processes', () => {
  test('add-context stores a packet, or plain text as a convention, stamped by the agent', async () => {
    const { db, pm } = setup({ 'projects/site': project() });
    let r = await pm(['add-context', 'site', 'drive_folder', '{"kind":"drive_folder","ref":"1AbC","name":"Site files"}']);
    assert.equal(r.out, 'Added context key "drive_folder" to project "site".\n');
    r = await pm(['add-context', 'site', 'tone', '-'], { readStdin: () => "Plain words; it's for everyone" });
    assert.equal(r.code, 0, r.err);
    const ctx = db.docs.get('projects/site').context;
    assert.deepEqual(ctx.drive_folder, { kind: 'drive_folder', ref: '1AbC', name: 'Site files', updatedAt: NOW.toISOString(), updatedBy: 'agent' });
    assert.deepEqual(ctx.tone, { kind: 'convention', summary: "Plain words; it's for everyone", updatedAt: NOW.toISOString(), updatedBy: 'agent' });
    r = await pm(['add-context', 'site', 'last_failure', 'it broke']);
    assert.equal(r.code, 1);
    assert.match(r.err, /context key "last_failure": key names history/);
  });

  test('add-process links a playbook once', async () => {
    const { db, pm } = setup({ 'projects/site': project() });
    assert.equal((await pm(['add-process', 'site', 'p-plan'])).out, 'Linked process "p-plan" to project "site".\n');
    assert.equal((await pm(['add-process', 'site', 'p-plan'])).out, 'Already linked: process "p-plan" is already in project "site".\n');
    assert.deepEqual(db.docs.get('projects/site').standardProcesses, ['p-plan']);
  });
});

test('help, and the commands that left with the team roster', async () => {
  const help = await run(main, ['help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /^Usage: project-manage <command> \[args\]/);
  assert.doesNotMatch(help.out, /team-|owner/i);
  const { pm } = setup({ 'projects/site': project() });
  const r = await pm(['team-add', 'site', 'a@example.com', 'editor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^Usage: project-manage/);
});
