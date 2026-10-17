// Tests for dashboard/lib/server/iap-access.mjs, against a fake of the IAP API's IAM policy calls that
// keeps a policy with an etag and refuses a write made with a stale one, as IAM does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import { grantIapAccess, iapResource, IAP_ACCESSOR_ROLE, readIapAccess, revokeIapAccess } from '../../../../dashboard/lib/server/iap-access.mjs';

const RESOURCE = 'projects/123456789012/iap_web/cloud_run-us-central1/services/paraclete';
const GET_URL = `https://iap.googleapis.com/v1/${RESOURCE}:getIamPolicy`;
const SET_URL = `https://iap.googleapis.com/v1/${RESOURCE}:setIamPolicy`;
const ROLE = IAP_ACCESSOR_ROLE;

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const googleError = (code, status, message) => reply(code, { error: { code, status, message } });

/**
 * A fake IAP policy endpoint. `conflicts` is how many writes to refuse as if someone changed the
 * policy in between; `fail` answers every get or set with an error instead.
 */
function fakeIap({ policy = { version: 1, etag: 'BwE1', bindings: [] }, conflicts = 0, fail = {} } = {}) {
  const calls = [];
  let current = structuredClone(policy);
  let etags = 1;
  const fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, body, auth: init.headers?.Authorization });
    if (String(url) === GET_URL) {
      if (fail.get) return fail.get();
      return reply(200, current);
    }
    if (String(url) === SET_URL) {
      if (fail.set) return fail.set();
      if (conflicts > 0) {
        conflicts -= 1;
        etags += 1;
        current = { ...current, etag: `BwE${etags}` };
        return googleError(409, 'ABORTED', 'There were concurrent policy changes.');
      }
      if (body.policy.etag !== current.etag) return googleError(409, 'ABORTED', 'stale etag');
      etags += 1;
      current = { ...body.policy, etag: `BwE${etags}` };
      return reply(200, current);
    }
    return reply(404, { error: { code: 404, message: `no route ${url}` } });
  };
  return { fetch, calls, policy: () => current };
}

async function dashboardWith(iap, env) {
  return startDashboard({ fetch: iap.fetch, env });
}

test("the IAP resource is the Cloud Run service's, by project number and region", () => {
  assert.equal(iapResource({ projectNumber: '123456789012', region: 'us-central1', service: 'paraclete' }), RESOURCE);
  assert.throws(() => iapResource({ projectNumber: '', region: 'us-central1', service: 'paraclete' }), (err) => err.status === 503);
});

test('reading access asks IAP for the version 3 policy and lists the people holding the role', async (t) => {
  const iap = fakeIap({
    policy: {
      version: 3,
      etag: 'BwE1',
      bindings: [
        { role: ROLE, members: ['user:Zoe@Example.com', 'group:team@example.com', 'deleted:user:old@example.com?uid=1'] },
        { role: ROLE, members: ['user:ada@example.com', 'domain:example.com'], condition: { title: 'office', expression: 'true' } },
        { role: 'roles/iap.admin', members: ['user:boss@example.com'] },
      ],
    },
  });
  const dash = await dashboardWith(iap);
  t.after(dash.stop);
  assert.deepEqual(await readIapAccess(dash.runtime), {
    resource: RESOURCE,
    users: ['ada@example.com', 'zoe@example.com'],
    others: ['domain:example.com', 'group:team@example.com'],
  });
  assert.deepEqual(iap.calls, [{ url: GET_URL, method: 'POST', body: { options: { requestedPolicyVersion: 3 } }, auth: 'Bearer dashboard-token' }]);
});

test('a grant joins the unconditional binding and is written back with the etag it was read with', async (t) => {
  const iap = fakeIap({
    policy: {
      version: 1,
      etag: 'BwE1',
      bindings: [
        { role: 'roles/iap.admin', members: ['serviceAccount:paraclete-dashboard@your-gcp-project.iam.gserviceaccount.com'] },
        { role: ROLE, members: ['user:zoe@example.com'] },
      ],
    },
  });
  const dash = await dashboardWith(iap);
  t.after(dash.stop);
  assert.deepEqual(await grantIapAccess(dash.runtime, 'ada@example.com'), { changed: true });
  assert.deepEqual(iap.calls.map((c) => c.url), [GET_URL, SET_URL]);
  assert.deepEqual(iap.calls[1].body, {
    policy: {
      version: 3,
      etag: 'BwE1',
      bindings: [
        { role: 'roles/iap.admin', members: ['serviceAccount:paraclete-dashboard@your-gcp-project.iam.gserviceaccount.com'] },
        { role: ROLE, members: ['user:zoe@example.com', 'user:ada@example.com'] },
      ],
    },
  });
});

test('a grant with no binding for the role yet adds one', async (t) => {
  const iap = fakeIap({ policy: { etag: 'ACAB' } });
  const dash = await dashboardWith(iap);
  t.after(dash.stop);
  assert.deepEqual(await grantIapAccess(dash.runtime, 'ada@example.com'), { changed: true });
  assert.deepEqual(iap.calls[1].body, { policy: { etag: 'ACAB', version: 3, bindings: [{ role: ROLE, members: ['user:ada@example.com'] }] } });
});

test('someone who already holds the role, even conditionally or in another case, is left as they are', async (t) => {
  const iap = fakeIap({
    policy: { version: 3, etag: 'BwE1', bindings: [{ role: ROLE, members: ['user:Ada@Example.com'], condition: { title: 'office', expression: 'true' } }] },
  });
  const dash = await dashboardWith(iap);
  t.after(dash.stop);
  assert.deepEqual(await grantIapAccess(dash.runtime, 'ada@example.com'), { changed: false });
  assert.deepEqual(iap.calls.map((c) => c.url), [GET_URL]);
});

test('a revoke takes the person out of every binding of the role and drops the ones left empty', async (t) => {
  const iap = fakeIap({
    policy: {
      version: 3,
      etag: 'BwE7',
      bindings: [
        { role: ROLE, members: ['user:zoe@example.com', 'user:ADA@example.com'] },
        { role: ROLE, members: ['user:ada@example.com'], condition: { title: 'office', expression: 'true' } },
        { role: 'roles/iap.admin', members: ['user:ada@example.com'] },
      ],
    },
  });
  const dash = await dashboardWith(iap);
  t.after(dash.stop);
  assert.deepEqual(await revokeIapAccess(dash.runtime, 'ada@example.com'), { changed: true });
  assert.deepEqual(iap.calls[1].body, {
    policy: {
      version: 3,
      etag: 'BwE7',
      bindings: [
        { role: ROLE, members: ['user:zoe@example.com'] },
        { role: 'roles/iap.admin', members: ['user:ada@example.com'] },
      ],
    },
  });
  assert.deepEqual(await revokeIapAccess(dash.runtime, 'ada@example.com'), { changed: false });
  assert.equal(iap.calls.length, 3, 'nothing to revoke writes nothing');
});

test('a write refused because the policy changed meanwhile is retried once on a fresh read', async (t) => {
  const iap = fakeIap({ policy: { version: 1, etag: 'BwE1', bindings: [] }, conflicts: 1 });
  const dash = await dashboardWith(iap);
  t.after(dash.stop);
  assert.deepEqual(await grantIapAccess(dash.runtime, 'ada@example.com'), { changed: true });
  assert.deepEqual(iap.calls.map((c) => c.url), [GET_URL, SET_URL, GET_URL, SET_URL]);
  assert.equal(iap.calls[1].body.policy.etag, 'BwE1');
  assert.equal(iap.calls[3].body.policy.etag, 'BwE2', 'the retry carries the etag of the fresh read');
  assert.deepEqual(iap.policy().bindings, [{ role: ROLE, members: ['user:ada@example.com'] }]);
  assert.ok(dash.lines.some((l) => l.level === 'WARN' && /changed while/.test(l.message)));
});

test('a second conflict is not retried again: the admin is told', async (t) => {
  const iap = fakeIap({ conflicts: 2 });
  const dash = await dashboardWith(iap);
  t.after(dash.stop);
  await assert.rejects(grantIapAccess(dash.runtime, 'ada@example.com'), (err) => err.status === 502 && /concurrent policy changes/.test(err.message));
  assert.equal(iap.calls.length, 4);
});

test("IAP refusing the dashboard names the role its service account needs; other failures aren't retried", async (t) => {
  const refused = fakeIap({ fail: { get: () => googleError(403, 'PERMISSION_DENIED', 'The caller does not have permission') } });
  const dash = await dashboardWith(refused);
  t.after(dash.stop);
  await assert.rejects(readIapAccess(dash.runtime), (err) => err.status === 502 && /roles\/iap\.admin/.test(err.message) && /does not have permission/.test(err.message));

  const broken = fakeIap({ fail: { set: () => googleError(400, 'INVALID_ARGUMENT', 'bad policy') } });
  const other = await dashboardWith(broken);
  t.after(other.stop);
  await assert.rejects(grantIapAccess(other.runtime, 'zoe@example.com'), (err) => err.status === 502 && /IAP answered 400: bad policy/.test(err.message));
  assert.equal(broken.calls.filter((c) => c.url === SET_URL).length, 1);
});

test('without its project number the dashboard refuses before calling IAP', async (t) => {
  const iap = fakeIap();
  const dash = await dashboardWith(iap, { PARACLETE_PROJECT_NUMBER: '' });
  t.after(dash.stop);
  await assert.rejects(grantIapAccess(dash.runtime, 'ada@example.com'), (err) => err.status === 503);
  assert.equal(iap.calls.length, 0);
});
