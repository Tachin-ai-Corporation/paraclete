// tests/run.mjs: finds every *.test.mjs under tests/ and runs them with Node's built-in test runner.
// `npm test` calls this. It exists so one command runs every suite, with no glob support needed from
// the shell or the Node version.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = fileURLToPath(new URL('.', import.meta.url));

function findTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : findTestFiles(path);
    return entry.name.endsWith('.test.mjs') ? [path] : [];
  });
}

const files = findTestFiles(testsDir).sort();
if (files.length === 0) {
  console.error('No *.test.mjs files found under tests/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
