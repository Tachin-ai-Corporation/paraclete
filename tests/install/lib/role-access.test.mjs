// Tests for install/lib/role-access.mjs: what a role's role.json may ask the installer for beyond its
// project roles. Its APIs are short names; its single-resource grants name the agent's own account or
// its own image repository, each with a short list of roles; the roles that would reach every service
// account or every image repository are refused project-wide. Generic and the role are read together,
// generic first, each entry once; and the command line install.sh calls prints exactly that, or stops.
// The installer offers every role but a development role (`listed: false`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_WIDE_REFUSED, RESOURCE_KINDS, accessProblems, cli, listedRoles, readRole, roleAccess,
} from '../../../install/lib/role-access.mjs';

const MODULE = fileURLToPath(new URL('../../../install/lib/role-access.mjs', import.meta.url));

/** A repository holding only roles/<id>/role.json for each given record. */
function repoWith(t, records) {
  const root = mkdtempSync(join(tmpdir(), 'paraclete-role-access-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [id, record] of Object.entries(records)) {
    mkdirSync(join(root, 'roles', id), { recursive: true });
    writeFileSync(join(root, 'roles', id, 'role.json'), typeof record === 'string' ? record : JSON.stringify({ id, ...record }));
  }
  return root;
}

const GENERIC = { gcp_roles: ['roles/aiplatform.user'], apis: ['bigquery'], resource_roles: [] };

test('a role that asks for nothing beyond project roles has no problems', () => {
  assert.deepEqual(accessProblems({ gcp_roles: ['roles/run.viewer'] }), []);
  assert.deepEqual(accessProblems({ gcp_roles: [], apis: [], resource_roles: [] }), []);
});

test('act-as, image-repository write and Cloud Run change are refused on the whole project, pointing at where to ask', () => {
  for (const name of PROJECT_WIDE_REFUSED) {
    const [problem, ...more] = accessProblems({ gcp_roles: [name] });
    assert.equal(more.length, 0, name);
    assert.match(problem, new RegExp(`^gcp_roles: ${name.replace(/\./g, '\\.')} is never granted on the whole project`));
  }
  assert.match(accessProblems({ gcp_roles: ['roles/iam.serviceAccountUser'] })[0], /ask for it in resource_roles, on agent-account$/);
  assert.match(accessProblems({ gcp_roles: ['roles/artifactregistry.writer'] })[0], /ask for it in resource_roles, on agent-repository$/);
  assert.match(accessProblems({ gcp_roles: ['roles/run.admin'] })[0], /ask for it in resource_roles, on project-except-paraclete$/);
  assert.doesNotMatch(accessProblems({ gcp_roles: ['roles/run.jobsExecutorWithOverrides'] })[0], /resource_roles/, 'not allowed anywhere');
  assert.doesNotMatch(accessProblems({ gcp_roles: ['roles/artifactregistry.admin'] })[0], /resource_roles/, 'not allowed anywhere');
});

test('apis are short names, each once', () => {
  assert.deepEqual(accessProblems({ apis: ['bigquery', 'calendar-json', 'firebasehosting'] }), []);
  for (const bad of ['bigquery.googleapis.com', 'BigQuery', '', 'big query', '-run', 7, null]) {
    assert.equal(accessProblems({ apis: [bad] }).length, 1, JSON.stringify(bad));
  }
  assert.deepEqual(accessProblems({ apis: ['bigquery', 'bigquery'] }), ['apis: has duplicates']);
  assert.deepEqual(accessProblems({ apis: 'bigquery' }), ['apis: must be a list of short API names, like bigquery']);
});

test('resource_roles name the agent\'s own account or repository, with the roles each allows', () => {
  assert.deepEqual(accessProblems({
    resource_roles: [
      { role: 'roles/iam.serviceAccountUser', on: 'agent-account' },
      { role: 'roles/iam.serviceAccountTokenCreator', on: 'agent-account' },
      { role: 'roles/artifactregistry.writer', on: 'agent-repository' },
      { role: 'roles/artifactregistry.reader', on: 'agent-repository' },
      { role: 'roles/run.admin', on: 'project-except-paraclete' },
    ],
  }), []);
  const one = (entry) => accessProblems({ resource_roles: [entry] });
  assert.match(one({ role: 'roles/iam.serviceAccountUser', on: 'project' })[0], /on must be one of agent-account, agent-repository, project-except-paraclete/);
  assert.match(one({ role: 'roles/iam.serviceAccountUser', on: 'project-except-paraclete' })[0], /on project-except-paraclete the role is one of/);
  assert.match(one({ role: 'roles/iam.serviceAccountUser', on: 'paraclete-dashboard' })[0], /on must be one of/);
  assert.match(one({ role: 'roles/artifactregistry.writer', on: 'agent-account' })[0], /on agent-account the role is one of/);
  assert.match(one({ role: 'roles/iam.serviceAccountUser', on: 'agent-repository' })[0], /on agent-repository the role is one of/);
  assert.match(one({ role: 'roles/artifactregistry.admin', on: 'agent-repository' })[0], /the role is one of/, 'admin changes who may read it');
  assert.match(one({ role: 'iam.serviceAccountUser', on: 'agent-account' })[0], /role must be a role name/);
  assert.match(one({ role: 'roles/iam.serviceAccountUser', on: 'agent-account', member: 'allUsers' })[0], /fields outside \{ role, on \}/);
  assert.match(one('roles/iam.serviceAccountUser')[0], /is not \{ role, on \}/);
  const twice = { role: 'roles/iam.serviceAccountUser', on: 'agent-account' };
  assert.deepEqual(accessProblems({ resource_roles: [twice, twice] }), [`resource_roles: ${JSON.stringify(twice)} is listed twice`]);
  assert.deepEqual(accessProblems({ resource_roles: {} }), ['resource_roles: must be a list of { role, on }']);
  assert.deepEqual(Object.keys(RESOURCE_KINDS), ['agent-account', 'agent-repository', 'project-except-paraclete']);
});

test('generic and the role together: generic first, each entry once', (t) => {
  const root = repoWith(t, {
    generic: GENERIC,
    builder: {
      gcp_roles: ['roles/run.viewer'],
      apis: ['firebase', 'bigquery'],
      resource_roles: [
        { role: 'roles/run.admin', on: 'project-except-paraclete' },
        { role: 'roles/iam.serviceAccountUser', on: 'agent-account' },
        { role: 'roles/artifactregistry.writer', on: 'agent-repository' },
      ],
    },
  });
  assert.deepEqual(roleAccess(root, 'builder'), {
    apis: ['bigquery', 'firebase'],
    resourceRoles: [
      { on: 'project-except-paraclete', role: 'roles/run.admin' },
      { on: 'agent-account', role: 'roles/iam.serviceAccountUser' },
      { on: 'agent-repository', role: 'roles/artifactregistry.writer' },
    ],
  });
  assert.deepEqual(roleAccess(root, 'generic'), { apis: ['bigquery'], resourceRoles: [] });
});

test('a problem in either file stops it, naming the file', (t) => {
  const root = repoWith(t, {
    generic: { gcp_roles: ['roles/iam.serviceAccountUser'] },
    broken: { apis: ['Not An API'] },
    garbled: '{ not json',
  });
  assert.throws(() => roleAccess(root, 'broken'), (err) => {
    assert.match(err.message, /^roles\/generic\/role\.json gcp_roles: roles\/iam\.serviceAccountUser is never granted/m);
    assert.match(err.message, /^roles\/broken\/role\.json apis: "Not An API" is not a short API name/m);
    return true;
  });
  assert.throws(() => roleAccess(root, 'garbled'), /roles\/garbled\/role\.json is not JSON/);
  assert.throws(() => readRole(root, 'missing'), /roles\/missing\/role\.json cannot be read \(ENOENT\)/);
  assert.throws(() => readRole(root, '../generic'), /is not a role id/);
});

test('the installer offers every role but a development role, sorted; an unreadable one stays offered', (t) => {
  const root = repoWith(t, {
    generic: GENERIC,
    'web-master': {},
    harness: { listed: false },
    builder: { listed: true },
    garbled: '{ not json',
  });
  mkdirSync(join(root, 'roles', 'no-role-json'));
  assert.deepEqual(listedRoles(root), ['builder', 'garbled', 'generic', 'web-master']);
  assert.equal(cli(['listed', root]), 'builder\ngarbled\ngeneric\nweb-master');
  assert.throws(() => cli(['listed']), /usage: listed <repo>/);
  assert.throws(() => cli(['listed', root, 'extra']), /usage: listed <repo>/);
  const run = spawnSync(process.execPath, [MODULE, 'listed', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'builder\ngarbled\ngeneric\nweb-master\n');
  assert.deepEqual(roleAccess(root, 'harness'), { apis: ['bigquery'], resourceRoles: [] }, 'an unlisted role still installs by name');
});

test('the command line prints what install.sh reads, and stops on a problem', (t) => {
  const root = repoWith(t, {
    generic: GENERIC,
    builder: { apis: ['firebase'], resource_roles: [{ role: 'roles/iam.serviceAccountUser', on: 'agent-account' }] },
    broken: { gcp_roles: ['roles/artifactregistry.writer'] },
  });
  assert.equal(cli(['apis', root, 'builder']), 'bigquery\nfirebase');
  assert.equal(cli(['resource-roles', root, 'builder']), 'agent-account\troles/iam.serviceAccountUser');
  assert.equal(cli(['resource-roles', root, 'generic']), '');
  assert.equal(cli(['check', root, 'builder']), '');
  assert.equal(cli(['project-wide-refused']), PROJECT_WIDE_REFUSED.join('\n'));
  assert.throws(() => cli(['grants', root, 'builder']), /unknown command 'grants'/);
  assert.throws(() => cli(['apis', root]), /usage: apis <repo> <role>/);

  const ok = spawnSync(process.execPath, [MODULE, 'resource-roles', root, 'builder'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'agent-account\troles/iam.serviceAccountUser\n');
  const refused = spawnSync(process.execPath, [MODULE, 'check', root, 'broken'], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /roles\/broken\/role\.json gcp_roles: roles\/artifactregistry\.writer is never granted on the whole project; ask for it in resource_roles, on agent-repository/);
});
