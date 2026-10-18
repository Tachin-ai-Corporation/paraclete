// Tests for dashboard/lib/server/setup.mjs, against the Firestore fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { addUser } from '../../../../dashboard/lib/server/users.mjs';
import { readSetup } from '../../../../dashboard/lib/server/setup.mjs';

test('a fresh instance: one admin, Claude off, a generic role that needs no Workspace account', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'zoe@example.com', role: 'admin', addedBy: 'installer@example.com' });
  assert.deepEqual(await readSetup(dash.runtime), {
    users: { total: 1, admins: 1 },
    role: 'generic',
    workspace_role: false,
    claude_enabled: false,
  });
});

test('users are counted, never listed, and Claude is on only when the setting is exactly true', async (t) => {
  const dash = await startDashboard({ env: { PARACLETE_ROLE: 'project-manager', PARACLETE_WORKSPACE_ROLE: 'true' } });
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'zoe@example.com', role: 'admin', addedBy: 'installer@example.com' });
  await addUser(dash.runtime, { email: 'ada@example.com', role: 'member', addedBy: 'zoe@example.com' });
  await dash.seed({ 'config/settings': { claude_enabled: 'yes' } });
  const setup = await readSetup(dash.runtime);
  assert.deepEqual(setup.users, { total: 2, admins: 1 });
  assert.equal(setup.claude_enabled, false);
  assert.equal(setup.workspace_role, true);
  assert.ok(!JSON.stringify(setup).includes('ada@example.com'));

  await dash.seed({ 'config/settings': { claude_enabled: true } });
  assert.equal((await readSetup(dash.runtime)).claude_enabled, true);
});
