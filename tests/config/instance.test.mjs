// Tests for config/instance.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { loadInstance, validateInstance, dataPaths, agentIdentity, dashboardAccountEmail } from '../../config/instance.mjs';

const valid = () => ({
  project: 'your-gcp-project',
  region: 'us-central1',
  zone: 'us-central1-a',
  agent_name: 'Paraclete',
  role: 'generic',
  install_root: '/opt/paraclete',
  data_root: '/var/lib/paraclete',
  bucket: 'your-gcp-project-paraclete',
});

function writeTemp(content) {
  const path = join(mkdtempSync(join(tmpdir(), 'instance-')), 'instance.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

test('a complete record loads, with no Workspace account and production endpoints by default', () => {
  const instance = loadInstance({ path: writeTemp(valid()) });
  assert.equal(instance.role, 'generic');
  assert.equal(instance.workspace, null);
  assert.deepEqual(instance.endpoints, {});
  assert.equal(instance.gateway_token_file, '/etc/paraclete/gateway-token');
  assert.ok(Object.isFrozen(instance));
});

test('required fields, absolute roots and separate data are enforced', () => {
  const i = { ...valid(), project: '', data_root: '/opt/paraclete', role: 'Generic Role' };
  const problems = validateInstance(i);
  assert.ok(problems.includes('instance.project is required'));
  assert.ok(problems.some((p) => p.includes('data_root must differ')));
  assert.ok(problems.some((p) => p.includes('instance.role must be a role id')));
  assert.ok(validateInstance({ ...valid(), install_root: 'opt/paraclete' }).some((p) => p.includes('absolute path')));
});

test('a Workspace role names its account and signer', () => {
  assert.deepEqual(validateInstance({
    ...valid(),
    workspace: { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' },
  }), []);
  const problems = validateInstance({ ...valid(), workspace: { account: 'not-an-email' } });
  assert.equal(problems.length, 2);
});

test('endpoint overrides must be URLs (tests point services at local fakes this way)', () => {
  assert.deepEqual(validateInstance({ ...valid(), endpoints: { firestore: 'http://127.0.0.1:8080/v1' } }), []);
  assert.ok(validateInstance({ ...valid(), endpoints: { firestore: 'localhost' } }).length === 1);
});

test('loadInstance reports an unreadable or invalid record', () => {
  assert.throws(() => loadInstance({ path: join(tmpdir(), 'no-such-instance.json') }), /Cannot read the instance record/);
  assert.throws(() => loadInstance({ path: writeTemp({ ...valid(), bucket: '' }) }), /instance\.bucket is required/);
});

test('the agent\'s data lives under the data root, apart from installed code', () => {
  const paths = dataPaths(valid());
  for (const value of Object.values(paths)) {
    assert.ok(value.replace(/\\/g, '/').startsWith('/var/lib/paraclete'), value);
  }
  assert.match(paths.workingMemoryFile.replace(/\\/g, '/'), /\/memory\/MEMORY\.md$/);
});

test('the agent signs as its Workspace account when it has one, else as its service account', () => {
  const identity = agentIdentity({ ...valid(), workspace: null });
  assert.deepEqual({ ...identity }, { name: 'Paraclete', email: 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com' });
  assert.ok(Object.isFrozen(identity));
  assert.equal(agentIdentity({ ...valid(), workspace: { account: 'agent@example.com' } }).email, 'agent@example.com');
});

test('the dashboard account control trusts is the one the installer creates', () => {
  assert.equal(dashboardAccountEmail(valid()), 'paraclete-dashboard@your-gcp-project.iam.gserviceaccount.com');
  const names = readFileSync(new URL('../../install/lib/names.sh', import.meta.url), 'utf8');
  assert.match(names, /^DASHBOARD_ACCOUNT_ID=paraclete-dashboard$/m);
  assert.match(names, /^AGENT_ACCOUNT_ID=paraclete-agent$/m);
});
