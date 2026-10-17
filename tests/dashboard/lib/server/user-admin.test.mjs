// Tests for dashboard/lib/server/user-admin.mjs: users on the Firestore fake, their IAP grants on a fake
// of the IAP policy calls. What matters is that the record and the grant change together, in the right
// order, and that a half-done change is undone or reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { StoreConflict } from '../../../../agent/storage/firestore.mjs';
import { addUser } from '../../../../dashboard/lib/server/users.mjs';
import {
  addDashboardUser, grantUserAccess, listUserAccess, removeDashboardUser, revokeAccessWithoutUser, setDashboardUserRole,
} from '../../../../dashboard/lib/server/user-admin.mjs';

const RESOURCE = 'projects/123456789012/iap_web/cloud_run-us-central1/services/paraclete';
const GET_URL = `https://iap.googleapis.com/v1/${RESOURCE}:getIamPolicy`;
const SET_URL = `https://iap.googleapis.com/v1/${RESOURCE}:setIamPolicy`;
const ROLE = 'roles/iap.httpsResourceAccessor';
const NOW = new Date('2027-01-15T08:00:00.000Z');
const ADMIN = { email: 'zoe@example.com', role: 'admin' };
const MEMBER = { email: 'ada@example.com', role: 'member' };

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * IAP's policy for the service, holding `members` in one binding. `onCall` sees each call first;
 * `failGet` and `failSet` answer instead of the fake when they return a response.
 */
function fakeIap(members = [], { failGet, failSet, onCall } = {}) {
  const calls = [];
  let policy = { version: 3, etag: 'BwE1', bindings: members.length ? [{ role: ROLE, members: [...members] }] : [] };
  const fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (onCall) await onCall(String(url), body);
    if (String(url) === GET_URL) return failGet?.() || reply(200, policy);
    if (String(url) === SET_URL) {
      const failure = failSet?.();
      if (failure) return failure;
      policy = { ...body.policy, etag: `${body.policy.etag}x` };
      return reply(200, policy);
    }
    return reply(404, { error: { code: 404, message: 'no such route' } });
  };
  const holders = () => policy.bindings.filter((b) => b.role === ROLE).flatMap((b) => b.members);
  return { fetch, calls, holders };
}

const refused = (message) => () => reply(403, { error: { code: 403, status: 'PERMISSION_DENIED', message } });

async function start(iap) {
  const dash = await startDashboard({ fetch: iap.fetch });
  await addUser(dash.runtime, { email: ADMIN.email, role: 'admin', addedBy: 'installer@example.com', now: NOW });
  return dash;
}

/** The same runtime with a Firestore whose commit fails as given. */
const withCommitFailing = (runtime, error) => ({ ...runtime, db: { ...runtime.db, commit: async () => { throw error; } } });

test('only admins manage users', async (t) => {
  const iap = fakeIap();
  const dash = await start(iap);
  t.after(dash.stop);
  const { runtime } = dash;
  const attempts = [
    listUserAccess(runtime, { actor: MEMBER }),
    addDashboardUser(runtime, { email: 'eve@example.com', role: 'member', actor: MEMBER }),
    setDashboardUserRole(runtime, { email: 'zoe@example.com', role: 'member', actor: MEMBER }),
    removeDashboardUser(runtime, { email: 'zoe@example.com', actor: MEMBER }),
    grantUserAccess(runtime, { email: 'zoe@example.com', actor: MEMBER }),
    revokeAccessWithoutUser(runtime, { email: 'eve@example.com', actor: MEMBER }),
  ];
  for (const attempt of attempts) await assert.rejects(attempt, (err) => err.status === 403);
  assert.equal(iap.calls.length, 0);
});

test('adding a user grants IAP access first, then writes the record', async (t) => {
  const iap = fakeIap(['user:zoe@example.com'], {
    onCall: async (url) => {
      if (url === SET_URL) assert.equal(await dash.doc('users/ada@example.com'), null, 'no record before the grant');
    },
  });
  const dash = await start(iap);
  t.after(dash.stop);
  const added = await addDashboardUser(dash.runtime, { email: ' Ada@Example.com ', role: 'member', actor: ADMIN, now: NOW });
  assert.deepEqual(added, {
    user: { email: 'ada@example.com', role: 'member', added_by: 'zoe@example.com', added_at: NOW.toISOString(), updated_by: null, updated_at: null },
    access: 'granted',
  });
  assert.deepEqual(iap.holders(), ['user:zoe@example.com', 'user:ada@example.com']);
  assert.equal((await dash.doc('users/ada@example.com')).role, 'member');
});

test('someone already let through in the console is added without touching IAP', async (t) => {
  const iap = fakeIap(['user:zoe@example.com', 'user:ada@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  const added = await addDashboardUser(dash.runtime, { email: 'ada@example.com', role: 'admin', actor: ADMIN, now: NOW });
  assert.equal(added.access, 'already_granted');
  assert.deepEqual(iap.calls.map((c) => c.url), [GET_URL]);
});

test('a bad role, a bad email or an existing user is refused before IAP is asked', async (t) => {
  const iap = fakeIap(['user:zoe@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  await assert.rejects(addDashboardUser(dash.runtime, { email: 'ada@example.com', role: 'owner', actor: ADMIN }), (err) => err.status === 400);
  await assert.rejects(addDashboardUser(dash.runtime, { email: 'not-an-email', role: 'member', actor: ADMIN }), (err) => err.status === 400);
  await assert.rejects(addDashboardUser(dash.runtime, { email: 'ZOE@example.com', role: 'member', actor: ADMIN }), (err) => err.status === 409 && /already a user/.test(err.message));
  assert.equal(iap.calls.length, 0);
});

test('when IAP refuses the grant, no record is written', async (t) => {
  const iap = fakeIap([], { failSet: refused('denied') });
  const dash = await start(iap);
  t.after(dash.stop);
  await assert.rejects(addDashboardUser(dash.runtime, { email: 'ada@example.com', role: 'member', actor: ADMIN }), (err) => err.status === 502 && /roles\/iap\.admin/.test(err.message));
  assert.equal(await dash.doc('users/ada@example.com'), null);
});

test('when the record cannot be written, the grant just made is taken back', async (t) => {
  const iap = fakeIap(['user:zoe@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  const runtime = withCommitFailing(dash.runtime, new Error('Firestore is down'));
  await assert.rejects(addDashboardUser(runtime, { email: 'ada@example.com', role: 'member', actor: ADMIN }), /Firestore is down/);
  assert.deepEqual(iap.calls.map((c) => c.url), [GET_URL, SET_URL, GET_URL, SET_URL]);
  assert.deepEqual(iap.holders(), ['user:zoe@example.com']);
});

test('a grant that was already there is not taken back when the record fails', async (t) => {
  const iap = fakeIap(['user:zoe@example.com', 'user:ada@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  const runtime = withCommitFailing(dash.runtime, new Error('Firestore is down'));
  await assert.rejects(addDashboardUser(runtime, { email: 'ada@example.com', role: 'member', actor: ADMIN }), /Firestore is down/);
  assert.deepEqual(iap.holders(), ['user:zoe@example.com', 'user:ada@example.com']);
});

test('someone added by another admin at the same moment keeps the grant', async (t) => {
  const iap = fakeIap(['user:zoe@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  const runtime = withCommitFailing(dash.runtime, new StoreConflict('users/ada@example.com', 'ALREADY_EXISTS'));
  await assert.rejects(addDashboardUser(runtime, { email: 'ada@example.com', role: 'member', actor: ADMIN }), (err) => err.status === 409);
  assert.deepEqual(iap.holders(), ['user:zoe@example.com', 'user:ada@example.com']);
});

test('when the grant cannot be taken back either, the admin is told both', async (t) => {
  let sets = 0;
  const iap = fakeIap(['user:zoe@example.com'], { failSet: () => (++sets > 1 ? refused('no longer allowed')() : null) });
  const dash = await start(iap);
  t.after(dash.stop);
  const runtime = withCommitFailing(dash.runtime, new Error('Firestore is down'));
  await assert.rejects(
    addDashboardUser(runtime, { email: 'ada@example.com', role: 'member', actor: ADMIN }),
    (err) => err.status === 500 && /Firestore is down/.test(err.message) && /could not be taken back/.test(err.message) && /no longer allowed/.test(err.message),
  );
  assert.ok(dash.lines.some((l) => l.level === 'ERROR' && /taking the grant back failed/.test(l.message)));
});

test('removing a user deletes the record first, then the grant', async (t) => {
  const iap = fakeIap(['user:zoe@example.com', 'user:ada@example.com'], {
    onCall: async (url) => {
      if (url === GET_URL) assert.equal(await dash.doc('users/ada@example.com'), null, 'the record is gone before IAP is asked');
    },
  });
  const dash = await start(iap);
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'ada@example.com', role: 'member', addedBy: ADMIN.email });
  const removed = await removeDashboardUser(dash.runtime, { email: 'ADA@example.com', actor: ADMIN });
  assert.equal(removed.user.email, 'ada@example.com');
  assert.equal(removed.access, 'revoked');
  assert.deepEqual(iap.holders(), ['user:zoe@example.com']);
});

test('a grant that cannot be removed is reported, and the user is still gone', async (t) => {
  const iap = fakeIap(['user:zoe@example.com', 'user:ada@example.com'], { failSet: refused('denied') });
  const dash = await start(iap);
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'ada@example.com', role: 'member', addedBy: ADMIN.email });
  const removed = await removeDashboardUser(dash.runtime, { email: 'ada@example.com', actor: ADMIN });
  assert.equal(removed.access, 'revoke_failed');
  assert.match(removed.access_error, /denied/);
  assert.equal(await dash.doc('users/ada@example.com'), null);
});

test('a user without a grant is removed with nothing to revoke', async (t) => {
  const iap = fakeIap(['user:zoe@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'ada@example.com', role: 'member', addedBy: ADMIN.email });
  assert.equal((await removeDashboardUser(dash.runtime, { email: 'ada@example.com', actor: ADMIN })).access, 'not_granted');
  assert.deepEqual(iap.calls.map((c) => c.url), [GET_URL]);
});

test('nobody removes themself, the last admin stays, and a stranger is a 404, all without touching IAP', async (t) => {
  const iap = fakeIap(['user:zoe@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'max@example.com', role: 'admin', addedBy: ADMIN.email });
  await assert.rejects(removeDashboardUser(dash.runtime, { email: 'Zoe@example.com', actor: ADMIN }), (err) => err.status === 409 && /yourself/.test(err.message));
  await setDashboardUserRole(dash.runtime, { email: 'max@example.com', role: 'member', actor: ADMIN });
  await assert.rejects(removeDashboardUser(dash.runtime, { email: 'zoe@example.com', actor: { email: 'max@example.com', role: 'admin' } }), (err) => err.status === 409 && /only admin/.test(err.message));
  await assert.rejects(removeDashboardUser(dash.runtime, { email: 'nobody@example.com', actor: ADMIN }), (err) => err.status === 404);
  assert.equal(iap.calls.length, 0);
});

test('a role change records who made it and leaves IAP alone', async (t) => {
  const iap = fakeIap(['user:zoe@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'ada@example.com', role: 'member', addedBy: ADMIN.email });
  const changed = await setDashboardUserRole(dash.runtime, { email: 'ada@example.com', role: 'admin', actor: ADMIN, now: NOW });
  assert.equal(changed.role, 'admin');
  assert.equal(changed.updated_by, 'zoe@example.com');
  await assert.rejects(setDashboardUserRole(dash.runtime, { email: 'ada@example.com', role: 'owner', actor: ADMIN }), (err) => err.status === 400);
  assert.equal(iap.calls.length, 0);
});

test('the list joins records and grants, so either side missing shows', async (t) => {
  const iap = fakeIap(['user:zoe@example.com', 'user:Eve@example.com', 'group:team@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'ada@example.com', role: 'member', addedBy: ADMIN.email });
  const listed = await listUserAccess(dash.runtime, { actor: ADMIN });
  assert.deepEqual(listed.users.map((u) => [u.email, u.role, u.iap]), [['zoe@example.com', 'admin', true], ['ada@example.com', 'member', false]]);
  assert.deepEqual(listed.access, {
    checked: true, error: null, resource: RESOURCE, without_user: ['eve@example.com'], other_members: ['group:team@example.com'],
  });
});

test('when IAP cannot be read, the users still list and the reason shows', async (t) => {
  const iap = fakeIap([], { failGet: refused('denied') });
  const dash = await start(iap);
  t.after(dash.stop);
  const listed = await listUserAccess(dash.runtime, { actor: ADMIN });
  assert.deepEqual(listed.users.map((u) => [u.email, u.iap]), [['zoe@example.com', null]]);
  assert.equal(listed.access.checked, false);
  assert.match(listed.access.error, /roles\/iap\.admin/);
  assert.deepEqual(listed.access.without_user, []);
});

test('each side can be fixed on its own: grant a user, revoke a grant without a user', async (t) => {
  const iap = fakeIap(['user:zoe@example.com', 'user:eve@example.com']);
  const dash = await start(iap);
  t.after(dash.stop);
  await addUser(dash.runtime, { email: 'ada@example.com', role: 'member', addedBy: ADMIN.email });

  assert.deepEqual(await grantUserAccess(dash.runtime, { email: 'ada@example.com', actor: ADMIN }), { email: 'ada@example.com', changed: true });
  await assert.rejects(grantUserAccess(dash.runtime, { email: 'eve@example.com', actor: ADMIN }), (err) => err.status === 404);

  assert.deepEqual(await revokeAccessWithoutUser(dash.runtime, { email: 'Eve@example.com', actor: ADMIN }), { email: 'eve@example.com', changed: true });
  await assert.rejects(revokeAccessWithoutUser(dash.runtime, { email: 'ada@example.com', actor: ADMIN }), (err) => err.status === 409 && /remove the user/.test(err.message));
  assert.deepEqual(iap.holders(), ['user:zoe@example.com', 'user:ada@example.com']);
});
