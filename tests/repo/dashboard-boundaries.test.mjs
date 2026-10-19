// tests/repo/dashboard-boundaries.test.mjs: what the dashboard may import. dashboard/README.md
// explains why:
//   - outside dashboard/, only the agent libraries the two share (agent/auth, agent/storage,
//     agent/work, agent/release) and config/*.json. Never config/*.mjs: config/contracts.mjs finds its JSON through
//     `new URL(..., import.meta.url)`, which a bundler rewrites into an asset URL;
//   - code the browser runs ('use client') never imports lib/server/, which holds the Firestore client
//     and the signing calls;
//   - npm packages only when dashboard/package.json declares them;
//   - the image (dashboard/Dockerfile) copies in every agent package the dashboard imports.
// The agent never imports the dashboard: tests/repo/boundaries.test.mjs refuses any agent import
// outside its table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, posix } from 'node:path';
import { repoFiles, readRepoFile } from './repo-files.mjs';

const files = repoFiles().filter((path) => path.startsWith('dashboard/') && /\.(mjs|js|jsx)$/.test(path)
  && !/^dashboard\/(next\.config\.mjs)$/.test(path));
const DECLARED = new Set(Object.keys(JSON.parse(readRepoFile('dashboard/package.json')).dependencies || {}));
const SHARED = /^(agent\/(auth|storage|work|release)\/[^/]+\.mjs|config\/[^/]+\.json)$/;

function specifiers(source) {
  const found = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  return found;
}

/** The repo path a specifier names, resolving the `@/` alias (dashboard/jsconfig.json); null for npm. */
function resolve(fromPath, spec) {
  if (spec.startsWith('@/')) return posix.join('dashboard', spec.slice(2));
  if (spec.startsWith('.')) return posix.normalize(posix.join(dirname(fromPath), spec));
  return null;
}

const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

const isClient = (source) => /^\s*['"]use client['"];?/m.test(source.split('\n').find((line) => line.trim() && !line.trim().startsWith('//')) || '');

test('the dashboard imports only its own code, the shared agent libraries and declared packages', () => {
  const violations = [];
  for (const path of files) {
    for (const spec of specifiers(readRepoFile(path))) {
      if (spec.startsWith('node:')) continue;
      const target = resolve(path, spec);
      if (target === null) {
        if (!DECLARED.has(packageName(spec))) violations.push(`${path}: '${spec}' is not declared in dashboard/package.json`);
        continue;
      }
      if (target.startsWith('dashboard/')) continue;
      if (!SHARED.test(target)) violations.push(`${path}: imports ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('code the browser runs never imports the server libraries', () => {
  const violations = [];
  for (const path of files) {
    const source = readRepoFile(path);
    if (!isClient(source)) continue;
    for (const spec of specifiers(source)) {
      const target = resolve(path, spec);
      if (target && (target.startsWith('dashboard/lib/server/') || target.startsWith('agent/') || target.startsWith('config/'))) {
        violations.push(`${path}: a client component imports ${target}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the server libraries never import client code', () => {
  const violations = [];
  for (const path of files.filter((p) => p.startsWith('dashboard/lib/server/'))) {
    for (const spec of specifiers(readRepoFile(path))) {
      const target = resolve(path, spec);
      if (target && (target.startsWith('dashboard/components/') || target.startsWith('dashboard/lib/client/'))) {
        violations.push(`${path}: imports ${target}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the image copies in every agent package the dashboard imports', () => {
  const imported = new Set();
  for (const path of files) {
    for (const spec of specifiers(readRepoFile(path))) {
      const target = resolve(path, spec);
      const m = target && /^agent\/([^/]+)\//.exec(target);
      if (m) imported.add(m[1]);
    }
  }
  const copied = new Set([...readRepoFile('dashboard/Dockerfile').matchAll(/^COPY agent\/([a-z-]+) agent\/\1$/gm)].map((m) => m[1]));
  assert.deepEqual([...imported].filter((pkg) => !copied.has(pkg)).sort(), [], 'dashboard/Dockerfile must COPY each of these');
});
