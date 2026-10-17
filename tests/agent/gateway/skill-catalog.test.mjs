// Tests for agent/gateway/skill-catalog.mjs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillCatalog, findSkills } from '../../../agent/gateway/skill-catalog.mjs';

let root;
function skill(dir, name, manifest) {
  mkdirSync(join(dir, name), { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(join(dir, name, 'skill.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}`);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-catalog-'));
  const base = join(root, 'skills');
  const role = join(root, 'roles', 'generic', 'skills');
  skill(base, 'web-fetch', { id: 'web-fetch', name: 'Web fetch', when_to_use: 'Read a page by URL.', organs: ['motor', 'temporal-research'] });
  skill(base, 'files', { id: 'files', name: 'Files', description: 'Convert and produce files.' });
  skill(base, 'planning', { id: 'planning', name: 'Planning', when_to_use: 'Structure a plan.', organs: ['cortex', 'prefrontal'] });
  skill(base, 'broken', '{ not json');
  skill(base, 'no-manifest');
  skill(role, 'notes', { id: 'notes', name: 'Notes', when_to_use: 'Keep notes.', organs: 'motor' });
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('buildSkillCatalog', () => {
  it('lists every skill a tool-using organ may use, with the path of its SKILL.md', () => {
    const text = buildSkillCatalog([join(root, 'skills'), join(root, 'roles', 'generic', 'skills')]);
    assert.ok(text.startsWith('\n\n## Available Skills\nBefore using any command tool, read the relevant SKILL.md:\n'));
    assert.ok(text.includes(`- Web fetch (web-fetch): Read a page by URL.\n  → readFile ${join(root, 'skills', 'web-fetch', 'SKILL.md')}`));
    assert.ok(text.includes('- Files (files): Convert and produce files.'), 'description stands in for when_to_use; no organs means every organ');
    assert.ok(text.includes('- Notes (notes): Keep notes.'), 'the role directory is read too');
    assert.ok(text.endsWith('Do NOT guess skill paths. Only the paths listed above exist.\n'));
  });

  it('leaves out planning-only skills, invalid manifests and directories without one', () => {
    const text = buildSkillCatalog([join(root, 'skills')]);
    assert.doesNotMatch(text, /Planning|broken|no-manifest/);
  });

  it('is byte-stable: directories in the order given, skills sorted by name', () => {
    const dirs = [join(root, 'skills'), join(root, 'roles', 'generic', 'skills')];
    assert.equal(buildSkillCatalog(dirs), buildSkillCatalog([...dirs]));
    assert.deepEqual(findSkills(dirs).map((s) => s.id), ['files', 'planning', 'web-fetch', 'notes']);
  });

  it('is empty with no skills, or directories that do not exist', () => {
    assert.equal(buildSkillCatalog([]), '');
    assert.equal(buildSkillCatalog([join(root, 'missing')]), '');
  });
});
