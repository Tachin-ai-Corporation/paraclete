// Tests for dashboard/lib/server/users.mjs, against the Firestore fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { addUser, getUser, listUsers, normalizeEmail, removeUser, setUserRole } from '../../../../dashboard/lib/server/users.mjs';

const NOW = new Date('2027-01-15T08:00:00.000Z');

test('emails are trimmed and lowercased, and anything else is refused with a 400', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  for (const bad of ['', 'ada', 'ada@', 'a/b@example.com', null]) {
    assert.throws(() => normalizeEmail(bad), (err) => err.status === 400);
  }
});

test('a user is added once, read back by any spelling of their email, and listed admins first', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  await addUser(runtime, { email: 'Zoe@example.com', role: 'admin', addedBy: 'installer@example.com', now: NOW });
  await addUser(runtime, { email: 'ada@example.com', role: 'member', addedBy: 'zoe@example.com', now: NOW });
  await assert.rejects(addUser(runtime, { email: 'ADA@example.com', role: 'admin', addedBy: 'x@example.com' }), (err) => err.status === 409);

  assert.deepEqual(await getUser(runtime, 'ZOE@example.com'), {
    email: 'zoe@example.com', role: 'admin', added_by: 'installer@example.com', added_at: NOW.toISOString(), updated_by: null, updated_at: null,
  });
  assert.equal(await getUser(runtime, 'nobody@example.com'), null);
  assert.deepEqual((await listUsers(runtime)).map((u) => `${u.role}:${u.email}`), ['admin:zoe@example.com', 'member:ada@example.com']);
  assert.deepEqual(await dash.doc('users/ada@example.com'), { email: 'ada@example.com', role: 'member', added_by: 'zoe@example.com', added_at: NOW.toISOString() });
});

test('a record with no valid role is no user at all', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  await dash.seed({ 'users/eve@example.com': { email: 'eve@example.com', role: 'owner' } });
  assert.equal(await getUser(dash.runtime, 'eve@example.com'), null);
  await assert.rejects(addUser(dash.runtime, { email: 'eve@example.com', role: 'superuser', addedBy: 'a@example.com' }), (err) => err.status === 400);
});

test('roles change with who changed them, but the last admin stays an admin', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  await addUser(runtime, { email: 'zoe@example.com', role: 'admin', addedBy: 'installer@example.com' });
  await addUser(runtime, { email: 'ada@example.com', role: 'member', addedBy: 'zoe@example.com' });

  await assert.rejects(setUserRole(runtime, { email: 'zoe@example.com', role: 'member', changedBy: 'zoe@example.com' }), (err) => err.status === 409 && /only admin/.test(err.message));
  const promoted = await setUserRole(runtime, { email: 'ada@example.com', role: 'admin', changedBy: 'zoe@example.com', now: NOW });
  assert.equal(promoted.role, 'admin');
  assert.equal((await dash.doc('users/ada@example.com')).updated_by, 'zoe@example.com');
  await setUserRole(runtime, { email: 'zoe@example.com', role: 'member', changedBy: 'ada@example.com' });
  assert.equal((await getUser(runtime, 'zoe@example.com')).role, 'member');
  await assert.rejects(setUserRole(runtime, { email: 'nobody@example.com', role: 'member', changedBy: 'ada@example.com' }), (err) => err.status === 404);
});

test('a user is removed, but never the last admin', async (t) => {
  const dash = await startDashboard();
  t.after(dash.stop);
  const { runtime } = dash;
  await addUser(runtime, { email: 'zoe@example.com', role: 'admin', addedBy: 'installer@example.com' });
  await addUser(runtime, { email: 'ada@example.com', role: 'member', addedBy: 'zoe@example.com' });
  await assert.rejects(removeUser(runtime, { email: 'zoe@example.com' }), (err) => err.status === 409);
  const removed = await removeUser(runtime, { email: 'ada@example.com' });
  assert.equal(removed.email, 'ada@example.com');
  assert.equal(await getUser(runtime, 'ada@example.com'), null);
  await assert.rejects(removeUser(runtime, { email: 'ada@example.com' }), (err) => err.status === 404);
});
