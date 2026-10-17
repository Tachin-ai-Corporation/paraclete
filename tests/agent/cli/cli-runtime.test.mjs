// Tests for agent/cli/cli-runtime.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDocId, CliError, createCliRuntime, runProgram } from '../../../agent/cli/cli-runtime.mjs';
import { sink } from './fakes.mjs';

const record = (over = {}) => ({
  project: 'your-gcp-project', region: 'us-central1', zone: 'us-central1-a', agent_name: 'Paraclete',
  role: 'generic', install_root: '/opt/paraclete', data_root: '/var/lib/paraclete',
  bucket: 'your-gcp-project-paraclete', ...over,
});

function instanceFile(over = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'cli-runtime-')), 'instance.json');
  writeFileSync(path, JSON.stringify(record(over)));
  return path;
}

test('a runtime carries the contracts, the instance, the collections and the same paths the services use', () => {
  const runtime = createCliRuntime({ instancePath: instanceFile({ role: 'devops' }) });
  assert.equal(runtime.contracts.git.default_branch, 'main');
  assert.equal(runtime.instance.role, 'devops');
  assert.equal(runtime.collections.coreMemory, 'core_memory');
  assert.equal(runtime.subcollections.responsibilityRevisions, 'revisions');
  const slash = (p) => p.replace(/\\/g, '/');
  assert.equal(slash(runtime.paths.genericRole), '/opt/paraclete/roles/generic');
  assert.equal(slash(runtime.paths.role), '/opt/paraclete/roles/devops');
  assert.equal(slash(runtime.paths.data.deepTruthsFile), '/var/lib/paraclete/memory/DEEP_TRUTHS.md');
  assert.equal(slash(runtime.paths.data.workingMemoryFile), '/var/lib/paraclete/memory/MEMORY.md');
  assert.equal(runtime.firestoreHost, 'https://firestore.googleapis.com');
  assert.equal(runtime.storageHost, 'https://storage.googleapis.com');
});

test('the Firestore client goes to the instance endpoint with the injected token, and logs to stderr', async () => {
  const calls = [];
  const stderr = sink();
  const runtime = createCliRuntime({
    instancePath: instanceFile({ endpoints: { firestore: 'http://127.0.0.1:8085', storage: 'http://127.0.0.1:9023' } }),
    getAccessToken: async () => 'test-token',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
    },
    stderr,
  });
  assert.equal(await runtime.db.read('work/w-1'), null);
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:8085\/v1\/projects\/your-gcp-project\/databases\/\(default\)\/documents\/work\/w-1$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.match(stderr.text, /^\[firestore\] WARN /);
  assert.equal(runtime.storageHost, 'http://127.0.0.1:9023');
});

test('a bad instance record stops the command before it does anything', () => {
  assert.throws(() => createCliRuntime({ instancePath: instanceFile({ bucket: '' }) }), /instance\.bucket is required/);
});

test('an id from the command line is one path segment', () => {
  assert.equal(checkDocId('r-standup'), 'r-standup');
  for (const bad of ['', ' ', 'a/b', '..', '.']) assert.throws(() => checkDocId(bad), CliError, bad);
});

test('runProgram reports an exit code, output, and a missing program as 127', async () => {
  const ok = await runProgram(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello' });
  assert.deepEqual([ok.code, ok.stdout], [0, 'hello']);
  const fail = await runProgram(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(fail.code, 3);
  assert.equal((await runProgram('no-such-program-anywhere', [])).code, 127);
});
