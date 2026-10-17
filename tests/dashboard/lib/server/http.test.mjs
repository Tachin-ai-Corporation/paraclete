// Tests for dashboard/lib/server/http.mjs and auth.mjs: every API route checks who is asking before
// it runs, admins-only routes refuse members, and errors come back as JSON with the right status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { route, json, readBody, HttpError } from '../../../../dashboard/lib/server/http.mjs';
import { requestUser, signedInEmail } from '../../../../dashboard/lib/server/auth.mjs';

const request = (method = 'GET', body, headers = {}) => new Request('http://dashboard.test/api/thing', {
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});

async function withUsers(t, users, env = {}) {
  const dash = await startDashboard({ env });
  t.after(dash.stop);
  await dash.seed(Object.fromEntries(Object.entries(users).map(([email, role]) => [`users/${email}`, { email, role }])));
  return dash;
}

test('a dashboard user reaches the route, with their record and the route params', async (t) => {
  const dash = await withUsers(t, { 'admin@example.com': 'admin' });
  let seen;
  const handler = route(async (ctx) => { seen = ctx; return { ok: true }; }, { runtime: () => dash.runtime });
  const response = await handler(request(), { params: Promise.resolve({ id: 'w-1' }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(seen.user.email, 'admin@example.com');
  assert.equal(seen.user.role, 'admin');
  assert.deepEqual(seen.params, { id: 'w-1' });
  assert.equal(seen.runtime, dash.runtime);
});

test('someone signed in without a users record is refused with a 403 that says what to do', async (t) => {
  const dash = await withUsers(t, {}, { PARACLETE_DEV_USER: 'stranger@example.com' });
  let ran = false;
  const handler = route(async () => { ran = true; }, { runtime: () => dash.runtime });
  const response = await handler(request());
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /not a user of this dashboard; ask one of its admins/);
  assert.equal(ran, false);
});

test('admin routes refuse members', async (t) => {
  const dash = await withUsers(t, { 'member@example.com': 'member' }, { PARACLETE_DEV_USER: 'member@example.com' });
  const handler = route(async () => ({ ok: true }), { admin: true, runtime: () => dash.runtime });
  const response = await handler(request('POST', {}));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /only a dashboard admin/);
  const open = route(async ({ user }) => ({ role: user.role }), { runtime: () => dash.runtime });
  assert.deepEqual(await (await open(request())).json(), { role: 'member' });
});

test('an HttpError keeps its status and message; anything else is a logged 500 without details', async (t) => {
  const dash = await withUsers(t, { 'admin@example.com': 'admin' });
  const refusing = route(async () => { throw new HttpError(409, 'already done'); }, { runtime: () => dash.runtime });
  const conflict = await refusing(request());
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'already done' });

  const crashing = route(async () => { throw new Error('secret internals'); }, { runtime: () => dash.runtime });
  const crash = await crashing(request());
  assert.equal(crash.status, 500);
  assert.doesNotMatch((await crash.json()).error, /secret internals/);
  assert.ok(dash.lines.some((l) => l.level === 'ERROR' && /GET \/api\/thing failed: Error: secret internals/.test(l.message)));
});

test('a Response from the route passes through untouched', async (t) => {
  const dash = await withUsers(t, { 'admin@example.com': 'admin' });
  const handler = route(async () => new Response('raw', { status: 202 }), { runtime: () => dash.runtime });
  const response = await handler(request());
  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'raw');
});

test('on Cloud Run the developer stand-in is ignored: without IAP\'s header the request is a 401', async (t) => {
  const dash = await withUsers(t, { 'admin@example.com': 'admin' }, { K_SERVICE: 'paraclete', PARACLETE_DEV_USER: 'admin@example.com' });
  assert.equal(dash.runtime.settings.devUser, '');
  const handler = route(async () => ({ ok: true }), { runtime: () => dash.runtime });
  const response = await handler(request());
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /sign-in could not be checked: the request did not come through IAP/);
  await assert.rejects(signedInEmail(dash.runtime, new Headers({ 'x-goog-authenticated-user-email': 'accounts.google.com:admin@example.com' })), /did not come through IAP/);
});

test('requestUser reads the record of whoever is signed in', async (t) => {
  const dash = await withUsers(t, { 'admin@example.com': 'admin' });
  assert.equal((await requestUser(dash.runtime, new Headers())).email, 'admin@example.com');
});

test('readBody accepts only a JSON object', async () => {
  assert.deepEqual(await readBody(request('POST', { a: 1 })), { a: 1 });
  await assert.rejects(readBody(request('POST', 'not json')), (err) => err.status === 400);
  await assert.rejects(readBody(request('POST', [1, 2])), (err) => err.status === 400);
});

test('json() answers with no caching', async () => {
  const response = json({ a: 1 }, 201);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await response.json(), { a: 1 });
});
