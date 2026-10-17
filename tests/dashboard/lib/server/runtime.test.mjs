// Tests for dashboard/lib/server/runtime.mjs: the instance's facts come from the environment the
// installer sets, the IAP audience is derived from them, and the developer stand-in for IAP exists
// only off Cloud Run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settingsFromEnv, DASHBOARD_ACCOUNT_ID } from '../../../../dashboard/lib/server/runtime.mjs';
import { readAgent } from '../../../../dashboard/lib/server/agent.mjs';
import { startDashboard } from '../../harness.mjs';

const ENV = {
  PARACLETE_PROJECT: 'your-gcp-project',
  PARACLETE_PROJECT_NUMBER: '123456789012',
  PARACLETE_REGION: 'us-central1',
  PARACLETE_SERVICE: 'paraclete',
  PARACLETE_AGENT_NAME: 'Ada Helper',
};

test('the installer\'s variables give the instance, its accounts and the IAP audience', () => {
  const settings = settingsFromEnv(ENV);
  assert.equal(settings.project, 'your-gcp-project');
  assert.equal(settings.bucket, 'your-gcp-project-paraclete');
  assert.equal(settings.agentName, 'Ada Helper');
  assert.equal(settings.dashboardAccount, 'paraclete-dashboard@your-gcp-project.iam.gserviceaccount.com');
  assert.equal(settings.agentAccount, 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com');
  assert.equal(settings.iapAudience, '/projects/123456789012/locations/us-central1/services/paraclete');
  assert.deepEqual(settings.missing, []);
  assert.ok(Object.isFrozen(settings));
});

test('Cloud Run\'s own service name is used when the installer sets none; an explicit audience wins', () => {
  const { PARACLETE_SERVICE, ...rest } = ENV;
  assert.equal(settingsFromEnv({ ...rest, K_SERVICE: 'paraclete' }).iapAudience, '/projects/123456789012/locations/us-central1/services/paraclete');
  assert.equal(settingsFromEnv({ ...ENV, PARACLETE_IAP_AUDIENCE: '/custom' }).iapAudience, '/custom');
});

test('missing settings are named, and leave no audience to accept', () => {
  const settings = settingsFromEnv({ PARACLETE_PROJECT: 'your-gcp-project' });
  assert.deepEqual(settings.missing, ['PARACLETE_REGION', 'PARACLETE_PROJECT_NUMBER']);
  assert.equal(settings.iapAudience, '');
});

test('the developer stand-in for IAP is honored off Cloud Run and ignored on it', () => {
  assert.equal(settingsFromEnv({ ...ENV, PARACLETE_DEV_USER: ' Dev@Example.com ' }).devUser, 'dev@example.com');
  assert.equal(settingsFromEnv({ ...ENV, PARACLETE_DEV_USER: 'dev@example.com', K_SERVICE: 'paraclete' }).devUser, '');
});

test('the dashboard account is the one the installer creates', () => {
  const names = readFileSync(new URL('../../../../install/lib/names.sh', import.meta.url), 'utf8');
  assert.match(names, new RegExp(`^DASHBOARD_ACCOUNT_ID=${DASHBOARD_ACCOUNT_ID}$`, 'm'));
});

test('the agent\'s install state comes from agent/instance, and reads as unknown before the first boot', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  assert.equal((await readAgent(dash.runtime)).status, 'unknown');
  await dash.seed({ 'agent/instance': { status: 'ready', release: 'v2027.01.15.1.1', commit: 'a'.repeat(40), ready_at: '2027-01-15T08:00:00.000Z' } });
  const agent = await readAgent(dash.runtime);
  assert.deepEqual(
    { status: agent.status, release: agent.release, ready_at: agent.ready_at, error: agent.error, name: agent.name },
    { status: 'ready', release: 'v2027.01.15.1.1', ready_at: '2027-01-15T08:00:00.000Z', error: null, name: 'Paraclete' },
  );
});
