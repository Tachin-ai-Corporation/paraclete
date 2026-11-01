// Tests for dev/loop/modules.mjs and its registry, dev/loop/modules.json: every file the repo tracks
// has an owner, every module owns something, a lane is never given a file of the referee, the organ
// modules own what the plan gives them, a test belongs to its mirror's module, a change's tasks follow
// the product's loading rules, and a change for a module keeps to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathRefusal } from '../../../dev/loop/config.mjs';
import {
  globToRegExp, impactedTasks, issueModule, loadModules, moduleProblems, ownerOf, readRegistry,
} from '../../../dev/loop/modules.mjs';
import { selectModelTasks } from '../../../dev/harness2/model-suite.mjs';
import { repoFiles, repoRoot } from '../../repo/repo-files.mjs';

const files = repoFiles();
const modules = loadModules({ files });
const owner = (p) => ownerOf(p, modules)?.id ?? null;

test('a glob matches within a segment with *, across segments with **', () => {
  assert.equal(globToRegExp('roles/*/role.json').test('roles/designer/role.json'), true);
  assert.equal(globToRegExp('roles/*/role.json').test('roles/designer/skills/x/role.json'), false);
  assert.equal(globToRegExp('skills/drive/**').test('skills/drive/drive-get.mjs'), true);
  assert.equal(globToRegExp('skills/drive/**').test('skills/drive-x/a.mjs'), false);
  assert.equal(globToRegExp('*').test('README.md'), true);
  assert.equal(globToRegExp('*').test('docs/README.md'), false);
  assert.equal(globToRegExp('**/x.md').test('a/b/x.md'), true);
  assert.equal(globToRegExp('**/x.md').test('x.md'), true);
  assert.equal(globToRegExp('prompts/cortex.md').test('prompts/cortexXmd'), false, 'a dot is a dot');
});

test('every file the repo tracks has an owner, and every module owns one', () => {
  const unowned = files.filter((f) => !ownerOf(f, modules));
  assert.deepEqual(unowned, []);
  const owned = new Set(files.map(owner));
  assert.deepEqual(modules.map((m) => m.id).filter((id) => !owned.has(id)), [], 'no module the registry keeps for nothing');
  assert.equal(new Set(modules.map((m) => m.id)).size, modules.length, 'ids are unique');
  for (const m of readRegistry().modules.filter((e) => !e.each)) {
    for (const glob of m.owns.filter((g) => !/[*{]/.test(g))) assert.ok(existsSync(join(repoRoot, glob)), `${m.id} names ${glob}, which does not exist`);
  }
});

test('a lane is never given a file of the referee or a secret', () => {
  const refereeInLanes = files
    .filter((f) => !f.startsWith('tests/') && ownerOf(f, modules)?.lane)
    .filter((f) => pathRefusal(f, 'M'));
  assert.deepEqual(refereeInLanes, []);
});

test('the organ modules own their prompts, instruction files and skills; the rest has the owner the plan gives it', () => {
  const expected = {
    'prompts/cerebellum.md': 'organ:cerebellum',
    'agent/work/checkpoint-verify.mjs': 'organ:cerebellum',
    'skills/verification/SKILL.md': 'organ:cerebellum',
    'agent/services/brain/memory.mjs': 'organ:temporal-memory',
    'skills/memory-recall/SKILL.md': 'organ:temporal-memory',
    'agent/cli/core-memory-write.mjs': 'organ:temporal-memory',
    'skills/plan-structuring/SKILL.md': 'organ:prefrontal',
    'prompts/motor.md': 'organ:motor',
    'agent/services/brain/actions/wait.mjs': 'organ:cortex',
    'skills/web-search/SKILL.md': 'organ:temporal-research',
    'skills/drive/SKILL.md': 'skill:drive',
    'roles/designer/prompts/cortex.md': 'role:designer',
    'roles/designer/role.json': 'platform:role-grants',
    'roles/generic/responsibilities.json': 'role:generic',
    'roles/README.md': 'platform:content-index',
    'prompts/README.md': 'platform:content-index',
    'agent/work/checkpoint-executor.mjs': 'platform:brain-spine',
    'agent/services/brain/actions/checkpoint-plan.mjs': 'platform:brain-spine',
    'agent/services/control/main.mjs': 'platform:services',
    'agent/storage/firestore.mjs': 'platform:agent-foundation',
    'config/contracts.json': 'platform:config',
    'install/manifest.txt': 'platform:install',
    'dev/loop/cycle.mjs': 'repo:loop',
    'dev/harness2/model-suite.mjs': 'repo:loop',
    'dev/say.mjs': 'repo:dev-tools',
    'docs/GLOSSARY.md': 'repo:docs',
    'README.md': 'repo:root',
    'tests/run.mjs': 'repo:rules',
    'tests/repo/docs.test.mjs': 'repo:rules',
  };
  for (const [p, id] of Object.entries(expected)) assert.equal(owner(p), id, p);
  // Every role and skill directory has a module of its own, and only the organs' skills are taken.
  for (const dir of new Set(files.filter((f) => /^roles\/[^/]+\//.test(f)).map((f) => f.split('/')[1]))) {
    assert.ok(modules.some((m) => m.id === `role:${dir}` && m.lane), dir);
  }
  const organSkills = ['verification', 'memory-recall', 'memory-consolidate', 'plan-structuring', 'web-search'];
  const skillModules = modules.filter((m) => m.kind === 'skill').map((m) => m.id.slice('skill:'.length));
  const orphaned = skillModules.filter((name) => organSkills.includes(name));
  assert.deepEqual(orphaned.filter((name) => files.some((f) => owner(f) === `skill:${name}`)), [], "an organ's skill is the organ's");
});

test("a test belongs to the module of the path it mirrors, unless a module names it", () => {
  assert.equal(owner('tests/agent/work/verdict.test.mjs'), 'organ:cerebellum');
  assert.equal(owner('tests/agent/context/work-recall.test.mjs'), 'organ:temporal-memory');
  assert.equal(owner('tests/skills/drive/drive-get.test.mjs'), 'skill:drive');
  assert.equal(owner('tests/roles/designer/contrast-check.test.mjs'), 'role:designer');
  assert.equal(owner('tests/dev/loop/cycle.test.mjs'), 'repo:loop');
  assert.equal(owner('tests/content/packages.test.mjs'), 'repo:rules');
  assert.equal(owner('tests/agent/work/verdict-twice.test.mjs'), 'organ:cerebellum', "a new test named after a file of a module is that module's");
  assert.equal(owner('tests/agent/work/checkpoint-verify-attack.test.mjs'), 'organ:cerebellum', 'the longest stem wins');
  assert.equal(owner('tests/agent/work/a-new-thing.test.mjs'), 'platform:brain-spine', "named after nothing: its directory's owner");
});

test("a change's tasks follow the product's loading rules: a role's files reach only its own tasks", () => {
  const suite = selectModelTasks();
  const all = suite.map((t) => t.id);
  const designer = suite.filter((t) => t.role === 'designer').map((t) => t.id);
  assert.ok(designer.length > 0);
  assert.deepEqual(impactedTasks(['roles/designer/prompts/cortex.md']), designer);
  assert.deepEqual(impactedTasks(['roles/designer/skills/accessibility-checks/SKILL.md']), designer);
  assert.deepEqual(impactedTasks(['roles/generic/processes/p-x.json']), all, "generic's reach every role");
  assert.deepEqual(impactedTasks(['prompts/motor.md']), all);
  assert.deepEqual(impactedTasks(['agent/work/verdict.mjs']), all);
  assert.deepEqual(impactedTasks(['roles/designer/role.json', 'docs/GLOSSARY.md', 'dev/say.mjs']), [], 'nothing the agent reads');
  assert.deepEqual(impactedTasks(['roles/paraclete-h2/prompts/cortex.md']), [], 'a role without tasks cannot be measured');
  const finance = suite.filter((t) => t.role === 'finance-analyst').map((t) => t.id);
  assert.deepEqual(impactedTasks(['roles/finance-analyst/memory.md', 'roles/designer/README.md']), all.filter((id) => [...designer, ...finance].includes(id)), 'in suite order');
});

test('a change for a module keeps to its files and tests; a module it does not have, or with no lane, is refused', () => {
  assert.equal(issueModule('Fix it.\n<!-- loop-module: organ:cerebellum -->'), 'organ:cerebellum');
  assert.equal(issueModule('no marker'), null);
  const inside = [{ path: 'prompts/cerebellum.md' }, { path: 'agent/work/verdict.mjs' }, { path: 'tests/agent/work/verdict-twice.test.mjs' }];
  assert.deepEqual(moduleProblems(inside, 'organ:cerebellum', modules), []);
  assert.deepEqual(moduleProblems([...inside, { path: 'prompts/motor.md' }, { path: 'docs/plan/OPEN_ITEMS.md' }], 'organ:cerebellum', modules), [
    'it changes files outside its module organ:cerebellum: prompts/motor.md (organ:motor), docs/plan/OPEN_ITEMS.md (repo:docs)',
  ]);
  assert.match(moduleProblems([{ path: 'agent/work/verdict.mjs', oldPath: 'agent/work/checkpoint-executor.mjs' }], 'organ:cerebellum', modules)[0],
    /agent\/work\/checkpoint-executor\.mjs \(platform:brain-spine\)/, "a rename's old path counts");
  assert.deepEqual(moduleProblems(inside, 'organ:spleen', modules), ['its issue names the module organ:spleen, which dev/loop/modules.json does not have']);
  assert.deepEqual(moduleProblems(inside, 'platform:brain-spine', modules), ['its issue names the module platform:brain-spine, which has no lane: only a person changes it']);
  // A skill a change adds has its module once the change's files are counted.
  const withNew = loadModules({ files: [...files, 'skills/brand-new/SKILL.md'] });
  assert.deepEqual(moduleProblems([{ path: 'skills/brand-new/SKILL.md' }, { path: 'skills/brand-new/skill.json' }], 'skill:brand-new', withNew), []);
});
