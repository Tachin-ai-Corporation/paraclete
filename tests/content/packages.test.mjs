// tests/content/packages.test.mjs: the agent-facing content packages are well formed. Every skill (in
// skills/ and roles/<id>/skills/) has a skill.json of the documented shape, organs the gateway knows, a
// SKILL.md that names every command the skill governs, and commands that exist: as a file in the skill's
// directory, or as a shared command in agent/cli/. Every role has a role.json of the documented shape,
// whose setup packages the VM bootstrap can install (npm and pip ones pinned to exact versions);
// every responsibility validates against agent/work/responsibility-schema.mjs; every process parses;
// every organ has a prompt. A role never asks for a project-wide grant that reaches every service
// account or image repository: those are single-resource grants (resource_roles) on the agent's own
// account or repository, and its APIs are short names (install/lib/role-access.mjs, which the installer
// runs). The wording of these files is checked by content-hygiene.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORGANS } from '../../agent/gateway/organs.mjs';
import { RESPONSIBILITY_SCHEMA } from '../../agent/work/responsibility-schema.mjs';
import { validate } from '../../agent/work/validate-schema.mjs';
import { checkCron } from '../../agent/work/responsibility-store.mjs';
import { ID_PATTERN } from '../../agent/work/work-ids.mjs';
import { SKILL_REQUIREMENTS } from '../../agent/context/skill-requirements.mjs';
import { parsePackage, roleSetup } from '../../install/vm/role-packages.mjs';
import { PROJECT_WIDE_REFUSED, RESOURCE_KINDS, accessProblems } from '../../install/lib/role-access.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const readJson = (...parts) => JSON.parse(read(...parts));
const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
const subdirs = (...parts) => {
  const dir = join(root, ...parts);
  return isDir(dir) ? readdirSync(dir).filter((name) => isDir(join(dir, name))).sort() : [];
};

/**
 * The shared commands in agent/cli/. They are being written in the same build phase as the skills, so
 * a skill may name one before its file lands; this list is the agreed set of names.
 */
const SHARED_COMMANDS = new Set([
  'git-store', 'core-memory-read', 'core-memory-write', 'core-memory-retire', 'session-summary',
  'update-deep-truths', 'responsibility-manage', 'project-manage', 'process-ops', 'work-log-read',
  'work-output-read', 'task-log-read', 'task-log-write', 'brain-telemetry-read', 'brain-telemetry-write',
  'agent-status',
]);

const ORGAN_IDS = Object.keys(ORGANS);
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SKILL_KEYS = ['id', 'name', 'version', 'when_to_use', 'organs', 'commands', 'requires'];
/** What a skill may require of its instance: agent/context/skill-requirements.mjs knows each one. */
const KNOWN_REQUIREMENTS = Object.keys(SKILL_REQUIREMENTS);
const ROLE_KEYS = ['id', 'title', 'summary', 'version', 'listed', 'workspace', 'skills', 'gcp_roles', 'apis', 'resource_roles', 'setup'];

/** Keys a package file may carry: the documented ones, plus `_`-prefixed documentation. */
function unexpectedKeys(object, allowed) {
  return Object.keys(object).filter((k) => !allowed.includes(k) && !k.startsWith('_'));
}

const skillPackages = [
  ...subdirs('skills').map((id) => ({ id, dir: join('skills', id) })),
  ...subdirs('roles').flatMap((role) => subdirs('roles', role, 'skills')
    .map((id) => ({ id, dir: join('roles', role, 'skills', id) }))),
];

const roles = subdirs('roles');

test('there are skills and roles to check', () => {
  assert.ok(skillPackages.length > 0, 'no skill packages found');
  assert.ok(roles.includes('generic'), 'the generic role package is missing');
});

test('skill ids are unique across the base skills and every role', () => {
  const ids = skillPackages.map((s) => s.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

for (const { id, dir } of skillPackages) {
  test(`skill ${dir}: skill.json has the documented shape`, () => {
    const path = join(root, dir, 'skill.json');
    assert.ok(existsSync(path), `${dir}/skill.json is missing`);
    const skill = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(unexpectedKeys(skill, SKILL_KEYS), [], 'skill.json has fields outside { id, name, version, when_to_use, organs, commands, requires }');
    assert.equal(skill.id, id, 'id must match the directory name');
    assert.match(skill.id, KEBAB);
    assert.equal(typeof skill.name, 'string');
    assert.ok(skill.name.trim(), 'name is empty');
    assert.ok(Number.isInteger(skill.version) && skill.version > 0, 'version must be a positive integer');
    assert.equal(typeof skill.when_to_use, 'string');
    assert.ok(skill.when_to_use.trim().length >= 20, 'when_to_use is too short to route by');
    assert.ok(Array.isArray(skill.organs) && skill.organs.length > 0, 'organs must be a non-empty array');
    assert.deepEqual(skill.organs.filter((o) => !ORGAN_IDS.includes(o)), [], `organs must be among ${ORGAN_IDS.join(', ')}`);
    assert.equal(new Set(skill.organs).size, skill.organs.length, 'organs has duplicates');
    assert.ok(Array.isArray(skill.commands), 'commands must be an array');
    assert.equal(new Set(skill.commands).size, skill.commands.length, 'commands has duplicates');
    for (const command of skill.commands) assert.match(command, KEBAB);
    if (skill.requires !== undefined) {
      assert.ok(Array.isArray(skill.requires) && skill.requires.length > 0, 'requires, when present, is a non-empty array');
      assert.deepEqual(skill.requires.filter((r) => !KNOWN_REQUIREMENTS.includes(r)), [], `requires may name only ${KNOWN_REQUIREMENTS.join(', ')}`);
      assert.equal(new Set(skill.requires).size, skill.requires.length, 'requires has duplicates');
    }
  });

  test(`skill ${dir}: SKILL.md exists and documents every command`, () => {
    const path = join(root, dir, 'SKILL.md');
    assert.ok(existsSync(path), `${dir}/SKILL.md is missing`);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^# \S/, 'SKILL.md starts with a title');
    const skill = readJson(dir, 'skill.json');
    const undocumented = skill.commands.filter((c) => !new RegExp(`(^|[^a-z0-9-])${c}([^a-z0-9-]|$)`, 'm').test(text));
    assert.deepEqual(undocumented, [], 'every command in skill.json must appear in SKILL.md with its syntax');
  });

  test(`skill ${dir}: every command exists, in the skill or in agent/cli`, () => {
    const skill = readJson(dir, 'skill.json');
    const problems = [];
    for (const command of skill.commands) {
      const local = existsSync(join(root, dir, `${command}.mjs`));
      const shared = existsSync(join(root, 'agent', 'cli', `${command}.mjs`)) || SHARED_COMMANDS.has(command);
      if (!local && !shared) problems.push(`${command}: neither ${dir}/${command}.mjs nor a shared command in agent/cli/`);
      if (local && shared) problems.push(`${command}: defined both in ${dir} and in agent/cli/; a command has one home`);
    }
    assert.deepEqual(problems, []);
  });

  test(`skill ${dir}: holds only its manifest, its procedure and the commands it lists`, () => {
    const skill = readJson(dir, 'skill.json');
    const allowed = new Set(['skill.json', 'SKILL.md', ...skill.commands.map((c) => `${c}.mjs`)]);
    const stray = readdirSync(join(root, dir)).filter((name) => !allowed.has(name));
    assert.deepEqual(stray, [], 'a script the skill does not list in commands is never installed as a command');
  });

  test(`skill ${dir}: its own commands are runnable Node commands`, () => {
    const skill = readJson(dir, 'skill.json');
    for (const command of skill.commands) {
      const path = join(root, dir, `${command}.mjs`);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, 'utf8');
      assert.ok(source.startsWith('#!/usr/bin/env node\n'), `${command}.mjs must start with a node shebang`);
      assert.match(source, /^\/\/ [a-z][\w/.-]+\.mjs: /m, `${command}.mjs needs its header comment`);
      assert.match(source, /export async function main\(argv, deps = \{\}\)/, `${command}.mjs must export main(argv, deps)`);
      assert.match(source, /process\.exitCode = await main\(process\.argv\.slice\(2\)\)/, `${command}.mjs must run main when invoked`);
      assert.doesNotMatch(source, /\/opt\/|\/var\/lib\//, `${command}.mjs must not hardcode install or data paths`);
    }
  });
}

for (const role of roles) {
  test(`role ${role}: role.json has the documented shape`, () => {
    const path = join(root, 'roles', role, 'role.json');
    assert.ok(existsSync(path), `roles/${role}/role.json is missing`);
    const r = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(unexpectedKeys(r, ROLE_KEYS), [], 'role.json has undocumented fields');
    assert.equal(r.id, role, 'id must match the directory name');
    for (const key of ['title', 'summary']) assert.ok(typeof r[key] === 'string' && r[key].trim(), `${key} is required`);
    assert.ok(Number.isInteger(r.version) && r.version > 0, 'version must be a positive integer');
    if ('listed' in r) assert.equal(typeof r.listed, 'boolean', 'listed (optional) is true or false');
    assert.equal(typeof r.workspace, 'boolean');
    assert.ok(Array.isArray(r.skills), 'skills must be an array');
    const known = new Set([...subdirs('skills'), ...subdirs('roles', role, 'skills')]);
    assert.deepEqual(r.skills.filter((s) => !known.has(s)), [], 'every listed skill must exist in skills/ or the role\'s skills/');
    assert.ok(Array.isArray(r.gcp_roles), 'gcp_roles must be an array');
    assert.deepEqual(r.gcp_roles.filter((g) => !/^roles\/[A-Za-z0-9_.]+$/.test(g)), [], 'gcp_roles are role names like roles/aiplatform.user');
    assert.equal(new Set(r.gcp_roles).size, r.gcp_roles.length, 'gcp_roles has duplicates');
    // apis (optional): short API names; resource_roles (optional): { role, on } on the agent's own
    // account or repository, each kind with its own short list of roles; nothing refused project-wide.
    assert.deepEqual(accessProblems(r), [], 'gcp_roles, apis and resource_roles as install/lib/role-access.mjs accepts them');
    assert.ok(r.setup && typeof r.setup === 'object', 'setup is required');
    assert.deepEqual(Object.keys(r.setup).sort(), ['apt', 'npm', 'pip']);
    for (const [manager, packages] of Object.entries(r.setup)) {
      assert.ok(Array.isArray(packages) && packages.every((p) => typeof p === 'string' && /^[A-Za-z0-9@._/=<>~+-]+$/.test(p)),
        `setup.${manager} must be a list of package names`);
    }
  });

  test(`role ${role}: the bootstrap can install its setup: Debian names, npm and pip pinned to exact versions`, () => {
    // install/vm/role-packages.mjs is what the VM bootstrap reads; it refuses a range, a tag or an
    // unpinned npm or pip package, and a package generic pins at another version.
    assert.doesNotThrow(() => roleSetup(root, role));
    const { setup } = readJson('roles', role, 'role.json');
    for (const kind of ['npm', 'pip']) {
      for (const spec of setup[kind]) assert.ok(parsePackage(kind, spec)?.version, `setup.${kind} ${spec} is pinned to one version`);
    }
  });

  test(`role ${role}: every organ prompt it appends belongs to a known organ`, () => {
    const dir = join(root, 'roles', role, 'prompts');
    if (!isDir(dir)) return;
    for (const file of readdirSync(dir)) {
      assert.ok(file.endsWith('.md') && ORGAN_IDS.includes(file.slice(0, -3)), `roles/${role}/prompts/${file} names no organ`);
      assert.ok(readFileSync(join(dir, file), 'utf8').trim(), `roles/${role}/prompts/${file} is empty`);
    }
  });

  test(`role ${role}: every process parses and has the playbook fields`, () => {
    const dir = join(root, 'roles', role, 'processes');
    if (!isDir(dir)) return;
    for (const file of readdirSync(dir)) {
      assert.ok(file.endsWith('.json'), `roles/${role}/processes/${file} is not a JSON playbook`);
      const p = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      assert.equal(p.id, file.slice(0, -5), `${file}: id must match the file name`);
      assert.match(p.id, ID_PATTERN);
      for (const key of ['name', 'description', 'narrative']) {
        assert.ok(typeof p[key] === 'string' && p[key].trim(), `${file}: ${key} is required`);
      }
      assert.equal(p.status, 'active', `${file}: an installed playbook is active`);
      if (p.intent_keywords !== undefined) {
        assert.ok(Array.isArray(p.intent_keywords) && p.intent_keywords.every((k) => typeof k === 'string' && k.trim()),
          `${file}: intent_keywords must be a list of phrases`);
      }
    }
  });

  test(`role ${role}: every responsibility validates against the responsibility schema`, () => {
    const path = join(root, 'roles', role, 'responsibilities.json');
    if (!existsSync(path)) return;
    const file = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(Array.isArray(file.responsibilities), 'responsibilities.json holds { version, responsibilities: [...] }');
    const playbooks = new Set(['generic', role].flatMap((r) => {
      const dir = join(root, 'roles', r, 'processes');
      return isDir(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, '')) : [];
    }));
    const ids = [];
    for (const r of file.responsibilities) {
      const { errors } = validate(RESPONSIBILITY_SCHEMA, r);
      assert.deepEqual(errors, [], `${r.id}: ${JSON.stringify(errors)}`);
      if (r.schedule) assert.equal(checkCron(r.schedule), null, `${r.id}: the scheduler cannot read its schedule`);
      if (r.timezone) assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: r.timezone }), `${r.id}: unknown timezone`);
      if (r.processRef) assert.ok(playbooks.has(r.processRef), `${r.id}: processRef '${r.processRef}' names no installed playbook`);
      ids.push(r.id);
    }
    assert.equal(new Set(ids).size, ids.length, 'responsibility ids must be unique');
  });

  test(`role ${role}: its first working memory fits the working-memory budget`, () => {
    const path = join(root, 'roles', role, 'memory.md');
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    const budget = readJson('config', 'contracts.json').memory.working_memory_target_chars;
    assert.ok(text.trim(), 'memory.md is empty');
    assert.ok(text.length <= budget, `memory.md is ${text.length} characters; working memory's target is ${budget}`);
  });
}

test('a role whose code reads the repo\'s dev/ tooling is a development role the installer does not offer', () => {
  // dev/ is never installed, so such a role works only beside a checkout of this repo.
  for (const role of roles) {
    const dir = join(root, 'roles', role, 'skills');
    const sources = isDir(dir)
      ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.mjs')).map((f) => readFileSync(join(dir, String(f)), 'utf8'))
      : [];
    const readsDev = sources.some((s) => /['"]dev['"]\s*,\s*['"]harness2['"]|['"]dev\/harness2\//.test(s));
    if (readsDev) assert.equal(readJson('roles', role, 'role.json').listed, false, `roles/${role} reads dev/: set "listed": false`);
  }
  assert.equal(readJson('roles', 'paraclete-h2', 'role.json').listed, false);
});

test('the generic role is the plain base: listed, no Workspace account and no skills of its own', () => {
  const generic = readJson('roles', 'generic', 'role.json');
  assert.notEqual(generic.listed, false, 'generic is always offered');
  assert.equal(generic.workspace, false);
  assert.deepEqual(generic.skills, []);
  assert.ok(generic.gcp_roles.includes('roles/aiplatform.user'), 'the agent needs Vertex AI');
  assert.ok(generic.gcp_roles.includes('roles/datastore.user'), 'the agent needs Firestore');
  assert.ok(!generic.gcp_roles.some((g) => /admin|owner|editor/i.test(g)), 'no project-wide admin role');
  for (const file of ['responsibilities.json', 'memory.md']) {
    assert.ok(existsSync(join(root, 'roles', 'generic', file)), `roles/generic/${file} is missing`);
  }
});

test('no role grants the agent a basic role, or one that hands out access', () => {
  // A role's gcp_roles are granted on the whole project. A basic role, or one that grants roles, keys
  // or service accounts, would let the agent widen its own access: a person makes those changes.
  const forbidden = /^roles\/(owner|editor|viewer|resourcemanager\.projectIamAdmin|iam\.securityAdmin|iam\.serviceAccountAdmin|iam\.serviceAccountKeyAdmin|iam\.serviceAccountTokenCreator|iam\.roleAdmin|serviceusage\.serviceUsageAdmin)$/;
  const found = roles.flatMap((role) => readJson('roles', role, 'role.json').gcp_roles
    .filter((g) => forbidden.test(g)).map((g) => `${role}: ${g}`));
  assert.deepEqual(found, []);
});

test('no role acts as any service account, pushes to any image repository or changes any Cloud Run resource project-wide', () => {
  // Project-wide, act-as reaches the dashboard's account, whose signature the VM's control service
  // obeys, Artifact Registry write reaches the dashboard's images, and Cloud Run change reaches the
  // dashboard's service and its update job. Act-as and write are granted only on the agent's own account
  // or repository, Cloud Run change only on the project minus paraclete's own.
  for (const name of ['roles/iam.serviceAccountUser', 'roles/iam.serviceAccountTokenCreator', 'roles/artifactregistry.writer',
    'roles/artifactregistry.admin', 'roles/artifactregistry.repoAdmin', 'roles/run.admin', 'roles/run.developer',
    'roles/run.jobsExecutorWithOverrides']) {
    assert.ok(PROJECT_WIDE_REFUSED.includes(name), `${name} is refused project-wide`);
  }
  const found = roles.flatMap((role) => readJson('roles', role, 'role.json').gcp_roles
    .filter((g) => PROJECT_WIDE_REFUSED.includes(g)).map((g) => `${role}: ${g}`));
  assert.deepEqual(found, []);
  // What a role may ask for on a single resource: acting as itself, its own images, and Cloud Run but
  // paraclete's own.
  assert.deepEqual(Object.keys(RESOURCE_KINDS), ['agent-account', 'agent-repository', 'project-except-paraclete']);
  assert.ok(RESOURCE_KINDS['agent-account'].includes('roles/iam.serviceAccountUser'));
  assert.ok(RESOURCE_KINDS['agent-repository'].includes('roles/artifactregistry.writer'));
  assert.ok(RESOURCE_KINDS['project-except-paraclete'].includes('roles/run.admin'));
  assert.ok(!RESOURCE_KINDS['project-except-paraclete'].includes('roles/run.jobsExecutorWithOverrides'), 'overrides run any command');
  assert.ok(!Object.values(RESOURCE_KINDS).flat().includes('roles/artifactregistry.admin'), 'admin would let it share its repository');
});

test('the DevOps Engineer changes Cloud Run but paraclete\'s own, acts as itself and pushes to its own repository, and nothing wider', () => {
  const devops = readJson('roles', 'devops-engineer', 'role.json');
  assert.deepEqual(devops.resource_roles, [
    { role: 'roles/run.admin', on: 'project-except-paraclete' },
    { role: 'roles/iam.serviceAccountUser', on: 'agent-account' },
    { role: 'roles/artifactregistry.writer', on: 'agent-repository' },
  ]);
  assert.ok(!devops.gcp_roles.some((g) => /^roles\/(iam|artifactregistry)\./.test(g)), 'no act-as or registry role on the project');
  assert.deepEqual(devops.gcp_roles.filter((g) => g.startsWith('roles/run.')), ['roles/run.viewer'], 'Cloud Run on the project is read-only');
});

test('the generic role installs its upkeep as locked responsibilities', () => {
  const { responsibilities } = readJson('roles', 'generic', 'responsibilities.json');
  const byId = Object.fromEntries(responsibilities.map((r) => [r.id, r]));
  assert.equal(byId['r-memory-consolidation']?.locked, true);
  assert.equal(byId['r-memory-consolidation']?.effect_scope, 'memory');
  assert.equal(byId['r-git-gc']?.locked, true);
  assert.match(byId['r-git-gc']?.instruction || '', /git-store gc <projectId> main/);
});

test("no role reuses an id of the generic role's responsibilities or playbooks", () => {
  // Installed defaults are layered generic first and the first id wins (collectDefaults in
  // agent/work/responsibility-store.mjs, readInstalledProcesses in agent/work/role-packages.mjs), so a
  // role's responsibility or playbook with a generic id would be dropped without a word.
  const genericResponsibilities = new Set(readJson('roles', 'generic', 'responsibilities.json').responsibilities.map((r) => r.id));
  const genericPlaybooks = new Set(readdirSync(join(root, 'roles', 'generic', 'processes')).map((f) => f.replace(/\.json$/, '')));
  const clashes = [];
  for (const role of roles.filter((r) => r !== 'generic')) {
    const path = join(root, 'roles', role, 'responsibilities.json');
    const own = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).responsibilities || [] : [];
    clashes.push(...own.filter((r) => genericResponsibilities.has(r.id)).map((r) => `roles/${role}: responsibility ${r.id}`));
    const dir = join(root, 'roles', role, 'processes');
    const playbooks = isDir(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, '')) : [];
    clashes.push(...playbooks.filter((id) => genericPlaybooks.has(id)).map((id) => `roles/${role}: playbook ${id}`));
  }
  assert.deepEqual(clashes, []);
});

test('a role skill that needs a Workspace account belongs to a Workspace role', () => {
  const misplaced = [];
  for (const role of roles.filter((r) => existsSync(join(root, 'roles', r, 'role.json')))) {
    if (readJson('roles', role, 'role.json').workspace === true) continue;
    for (const id of subdirs('roles', role, 'skills')) {
      const path = join(root, 'roles', role, 'skills', id, 'skill.json');
      if (existsSync(path) && (JSON.parse(readFileSync(path, 'utf8')).requires || []).includes('workspace')) {
        misplaced.push(`roles/${role}/skills/${id}`);
      }
    }
  }
  assert.deepEqual(misplaced, [], 'an instance of a role without a Workspace account could never use these skills');
});

test('every organ has a non-empty base prompt, and the identity exists', () => {
  const missing = [...ORGAN_IDS, 'identity']
    .filter((name) => !existsSync(join(root, 'prompts', `${name}.md`)) || !read('prompts', `${name}.md`).trim());
  assert.deepEqual(missing, []);
});

test('prompts/ holds only the organ prompts, the identity and its README', () => {
  const allowed = new Set([...ORGAN_IDS.map((o) => `${o}.md`), 'identity.md', 'README.md']);
  assert.deepEqual(readdirSync(join(root, 'prompts')).filter((f) => !allowed.has(f)), []);
});

test("the identity's opening, read alone as the agent's voice, is self-contained", () => {
  // agent/providers/notifications.mjs reads the first 500 characters as the voice of acknowledgments.
  const opening = read('prompts', 'identity.md').slice(0, 500);
  assert.match(opening, /You are a paraclete/);
  assert.doesNotMatch(opening, /\{\{|\}\}/, 'nothing fills template placeholders in');
});
