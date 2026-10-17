// tests/repo/boundaries.test.mjs: imports in agent/ follow the dependency table in agent/README.md.
// A package imports itself and the packages the table allows. Only services/ and cli/ may read
// config/. Only gateway/ imports npm packages, and only those agent/package.json declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, posix } from 'node:path';
import { repoFiles, readRepoFile } from './repo-files.mjs';

const files = repoFiles();
const agentModules = files.filter((path) => path.startsWith('agent/') && path.endsWith('.mjs'));
const CONFIG_READERS = new Set(['services', 'cli']);
const NPM_IMPORTERS = new Set(['gateway']);
const DECLARED = new Set(Object.keys(JSON.parse(readRepoFile('agent/package.json')).dependencies || {}));

/** The npm package a bare specifier names: '@scope/name/sub' -> '@scope/name', 'name/sub' -> 'name'. */
function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** { services: ['work', ...], auth: [] } from the "May import" table in agent/README.md. */
function allowedImports() {
  const table = {};
  for (const [, pkg, allowed] of readRepoFile('agent/README.md').matchAll(/^\| `([a-z-]+)\/` \| (.+?) \|$/gm)) {
    if (!/may import|nothing/i.test(allowed) && !allowed.includes('`')) continue;
    table[pkg] = [...allowed.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
  }
  return table;
}

/** Every module specifier a file imports or re-exports, statically or dynamically. */
function specifiers(source) {
  const found = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  return found;
}

const table = allowedImports();

test('the dependency table covers every agent package', () => {
  const packages = [...new Set(agentModules.map((path) => path.split('/')[1]))];
  const missing = packages.filter((pkg) => !(pkg in table));
  assert.deepEqual(missing, [], 'add these packages to the "May import" table in agent/README.md');
});

test('agent modules import only what the dependency table allows', () => {
  const violations = [];
  for (const path of agentModules) {
    const pkg = path.split('/')[1];
    const allowed = new Set([pkg, ...(table[pkg] || [])]);
    for (const spec of specifiers(readRepoFile(path))) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        if (!NPM_IMPORTERS.has(pkg)) violations.push(`${path}: npm import '${spec}' (only gateway/ imports npm packages)`);
        else if (!DECLARED.has(packageName(spec))) violations.push(`${path}: '${spec}' is not declared in agent/package.json`);
        continue;
      }
      const target = posix.normalize(posix.join(dirname(path), spec));
      const [top, targetPkg] = target.split('/');
      if (top === 'agent' && allowed.has(targetPkg)) continue;
      if (top === 'config' && CONFIG_READERS.has(pkg)) continue;
      violations.push(`${path}: imports ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});
