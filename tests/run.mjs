// tests/run.mjs: finds every *.test.mjs under tests/ and runs them with Node's built-in test runner.
// `npm test` calls this. It exists so one command runs every suite, with no glob support needed from
// the shell or the Node version. It passes the files relative to the repo root and runs from there:
// their absolute paths, in a checkout deep enough (a git worktree, say), would make one command line
// longer than Windows allows.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const testsDir = join(repoRoot, 'tests');

function findTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : findTestFiles(path);
    return entry.name.endsWith('.test.mjs') ? [path] : [];
  });
}

const files = findTestFiles(testsDir).map((path) => relative(repoRoot, path)).sort();
if (files.length === 0) {
  console.error('No *.test.mjs files found under tests/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: repoRoot, stdio: 'inherit' });
if (result.error) {
  console.error(`tests/run.mjs: could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
