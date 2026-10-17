// Tests for dashboard/lib/server/secrets.mjs, against a fake of the Secret Manager v1 REST API: secrets
// with labels and annotations, versions, and per-secret IAM policies with etags. The fake never serves
// a version's payload: a call to `:access` fails the test, since the dashboard must never read a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../../harness.mjs';
import {
  checkSecretName, createSecret, deleteSecret, grantSecretToAgent, listSecrets, replaceSecretValue,
} from '../../../../dashboard/lib/server/secrets.mjs';

const BASE = 'https://secretmanager.googleapis.com/v1/projects/your-gcp-project';
const AGENT = 'serviceAccount:paraclete-agent@your-gcp-project.iam.gserviceaccount.com';
const ACCESSOR = 'roles/secretmanager.secretAccessor';
const ADMIN = { email: 'zoe@example.com', role: 'admin' };
const MEMBER = { email: 'ada@example.com', role: 'member' };
const CREATED = '2027-01-15T08:00:00.000000Z';

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const googleError = (code, status, message) => reply(code, { error: { code, status, message } });

/**
 * A fake Secret Manager. `secrets` seeds it as { id: { labels, annotations, versions, bindings } }.
 * `fail[op]` answers that operation instead when it returns a response; `conflicts` refuses that many
 * policy writes as if the policy changed in between; `pageSize` paginates the list.
 */
function fakeSecretManager({ secrets = {}, fail = {}, conflicts = 0, pageSize = 100 } = {}) {
  const calls = [];
  const store = new Map();
  let etags = 0;
  const nextEtag = () => `BwS${(etags += 1)}`;
  for (const [id, seed] of Object.entries(secrets)) {
    store.set(id, {
      secret: { name: `projects/123456789012/secrets/${id}`, createTime: CREATED, labels: seed.labels || {}, annotations: seed.annotations || {} },
      versions: (seed.versions || []).map((createTime, i) => ({ name: `projects/123456789012/secrets/${id}/versions/${i + 1}`, createTime, state: 'ENABLED' })),
      policy: { version: 1, etag: nextEtag(), bindings: seed.bindings || [] },
    });
  }

  const failed = (op) => fail[op]?.();
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, url: String(input), body });
    assert.ok(!url.pathname.endsWith(':access'), 'the dashboard never reads a secret value');
    const path = decodeURIComponent(url.pathname).replace('/v1/projects/your-gcp-project/', '');

    if (path === 'secrets' && method === 'GET') {
      const filter = url.searchParams.get('filter');
      const [key, value] = filter.replace(/^labels\./, '').split('=');
      const all = [...store.values()].map((s) => s.secret).filter((s) => s.labels[key] === value);
      const start = Number(url.searchParams.get('pageToken') || 0);
      const page = all.slice(start, start + pageSize);
      return reply(200, { secrets: page, ...(start + pageSize < all.length ? { nextPageToken: String(start + pageSize) } : {}) });
    }
    if (path === 'secrets' && method === 'POST') {
      const id = url.searchParams.get('secretId');
      if (store.has(id)) return googleError(409, 'ALREADY_EXISTS', `Secret [${id}] already exists.`);
      const secret = { name: `projects/123456789012/secrets/${id}`, createTime: CREATED, ...body };
      store.set(id, { secret, versions: [], policy: { version: 1, etag: nextEtag(), bindings: [] } });
      return reply(200, secret);
    }
    const match = path.match(/^secrets\/([^/:]+)(.*)$/);
    const entry = match && store.get(match[1]);
    const rest = match?.[2];
    if (!entry) return googleError(404, 'NOT_FOUND', 'Secret not found');
    if (rest === '' && method === 'GET') return reply(200, entry.secret);
    if (rest === '' && method === 'DELETE') {
      const failure = failed('delete');
      if (failure) return failure;
      store.delete(match[1]);
      return reply(200, {});
    }
    if (rest === ':addVersion' && method === 'POST') {
      const failure = failed('addVersion');
      if (failure) return failure;
      const version = { name: `${entry.secret.name}/versions/${entry.versions.length + 1}`, createTime: '2027-01-16T09:00:00.000000Z', state: 'ENABLED' };
      entry.versions.push({ ...version, data: body.payload.data });
      return reply(200, version);
    }
    if (rest === '/versions/latest' && method === 'GET') {
      const latest = entry.versions.at(-1);
      if (!latest) return googleError(404, 'NOT_FOUND', 'no versions');
      const { data, ...meta } = latest;
      return reply(200, meta);
    }
    if (rest === ':getIamPolicy' && method === 'GET') {
      return failed('getIamPolicy') || reply(200, entry.policy);
    }
    if (rest === ':setIamPolicy' && method === 'POST') {
      const failure = failed('setIamPolicy');
      if (failure) return failure;
      if (conflicts > 0) {
        conflicts -= 1;
        entry.policy = { ...entry.policy, etag: nextEtag() };
        return googleError(409, 'ABORTED', 'There were concurrent policy changes.');
      }
      if (body.policy.etag !== entry.policy.etag) return googleError(409, 'ABORTED', 'stale etag');
      entry.policy = { ...body.policy, etag: nextEtag() };
      return reply(200, entry.policy);
    }
    return googleError(400, 'INVALID_ARGUMENT', `the fake does not serve ${method} ${path}`);
  };
  return { fetch, calls, store };
}

const MANAGED = { labels: { paraclete: 'agent' } };

async function start(sm, env) {
  return startDashboard({ fetch: sm.fetch, env });
}

test('secret names follow Secret Manager, which secret-read reads them by', () => {
  assert.equal(checkSecretName(' github-token '), 'github-token');
  assert.equal(checkSecretName('API_KEY_2'), 'API_KEY_2');
  for (const bad of ['', 'has space', 'a/b', 'dots.no', 'x'.repeat(256), null]) {
    assert.throws(() => checkSecretName(bad), (err) => err.status === 400);
  }
});

test('only admins manage secrets', async (t) => {
  const sm = fakeSecretManager({ secrets: { 'github-token': MANAGED } });
  const dash = await start(sm);
  t.after(dash.stop);
  const { runtime } = dash;
  for (const attempt of [
    listSecrets(runtime, { actor: MEMBER }),
    createSecret(runtime, { name: 'x', value: 'v', actor: MEMBER }),
    replaceSecretValue(runtime, { name: 'github-token', value: 'v', actor: MEMBER }),
    grantSecretToAgent(runtime, { name: 'github-token', actor: MEMBER }),
    deleteSecret(runtime, { name: 'github-token', actor: MEMBER }),
  ]) await assert.rejects(attempt, (err) => err.status === 403);
  assert.equal(sm.calls.length, 0);
});

test('creating a secret stores it in the region, labelled, with its value, and grants the agent on it', async (t) => {
  const sm = fakeSecretManager();
  const dash = await start(sm);
  t.after(dash.stop);
  const created = await createSecret(dash.runtime, { name: 'github-token', value: 'ghp_s3cret', description: ' Pushes to the docs repo ', actor: ADMIN });

  assert.deepEqual(sm.calls.map((c) => `${c.method} ${c.url}`), [
    `POST ${BASE}/secrets?secretId=github-token`,
    `POST ${BASE}/secrets/github-token:addVersion`,
    `GET ${BASE}/secrets/github-token:getIamPolicy?options.requestedPolicyVersion=3`,
    `POST ${BASE}/secrets/github-token:setIamPolicy`,
  ]);
  assert.deepEqual(sm.calls[0].body, {
    replication: { userManaged: { replicas: [{ location: 'us-central1' }] } },
    labels: { paraclete: 'agent' },
    annotations: { 'paraclete.created-by': 'zoe@example.com', 'paraclete.description': 'Pushes to the docs repo' },
  });
  assert.deepEqual(sm.calls[1].body, { payload: { data: Buffer.from('ghp_s3cret').toString('base64') } });
  assert.deepEqual(sm.calls[3].body, { policy: { version: 3, etag: 'BwS1', bindings: [{ role: ACCESSOR, members: [AGENT] }] } });

  assert.deepEqual(created, {
    name: 'github-token',
    description: 'Pushes to the docs repo',
    created_at: CREATED,
    created_by: 'zoe@example.com',
    version: 1,
    version_state: 'ENABLED',
    updated_at: '2027-01-16T09:00:00.000000Z',
    agent_access: true,
    problem: null,
  });
  const answer = JSON.stringify(created);
  assert.ok(!answer.includes('ghp_s3cret') && !answer.includes(Buffer.from('ghp_s3cret').toString('base64')), 'the value never comes back');
});

test('a bad name, an empty or oversized value, or a long description is refused before Secret Manager is asked', async (t) => {
  const sm = fakeSecretManager();
  const dash = await start(sm);
  t.after(dash.stop);
  const { runtime } = dash;
  for (const input of [
    { name: 'bad name', value: 'v' },
    { name: 'ok', value: '' },
    { name: 'ok', value: '   ' },
    { name: 'ok', value: 42 },
    { name: 'ok', value: 'x'.repeat(64 * 1024 + 1) },
    { name: 'ok', value: 'v', description: 'd'.repeat(501) },
  ]) await assert.rejects(createSecret(runtime, { ...input, actor: ADMIN }), (err) => err.status === 400);
  assert.equal(sm.calls.length, 0);
});

test('a name already taken in Secret Manager, by the dashboard or not, is a 409', async (t) => {
  const sm = fakeSecretManager({ secrets: { 'made-elsewhere': {} } });
  const dash = await start(sm);
  t.after(dash.stop);
  await assert.rejects(createSecret(dash.runtime, { name: 'made-elsewhere', value: 'v', actor: ADMIN }), (err) => err.status === 409 && /already exists/.test(err.message));
  assert.equal(sm.store.get('made-elsewhere').versions.length, 0);
});

test('a secret whose value or grant cannot be added is deleted again', async (t) => {
  for (const op of ['addVersion', 'setIamPolicy']) {
    const sm = fakeSecretManager({ fail: { [op]: () => googleError(500, 'INTERNAL', `${op} broke`) } });
    const dash = await start(sm);
    t.after(dash.stop);
    await assert.rejects(createSecret(dash.runtime, { name: 'api-key', value: 'v', actor: ADMIN }), (err) => err.status === 502 && err.message.includes(`${op} broke`));
    assert.equal(sm.calls.at(-1).method, 'DELETE');
    assert.equal(sm.store.has('api-key'), false, `${op} failing leaves nothing behind`);
  }
});

test('when the half-made secret cannot be deleted either, the admin is told both', async (t) => {
  const sm = fakeSecretManager({ fail: { addVersion: () => googleError(500, 'INTERNAL', 'no version'), delete: () => googleError(500, 'INTERNAL', 'no delete') } });
  const dash = await start(sm);
  t.after(dash.stop);
  await assert.rejects(createSecret(dash.runtime, { name: 'api-key', value: 'v', actor: ADMIN }), (err) => /no version/.test(err.message) && /could not be deleted again \(no delete\)/.test(err.message));
  assert.ok(dash.lines.some((l) => l.level === 'ERROR' && /api-key/.test(l.message)));
});

test('the list shows only the secrets the dashboard manages, with version and agent access, never a value', async (t) => {
  const sm = fakeSecretManager({
    pageSize: 1,
    secrets: {
      'b-token': { ...MANAGED, versions: ['2027-01-01T00:00:00Z', '2027-01-02T00:00:00Z'], bindings: [{ role: ACCESSOR, members: [AGENT] }] },
      'a-key': { labels: { paraclete: 'agent' }, annotations: { 'paraclete.description': 'Weather API', 'paraclete.created-by': 'zoe@example.com' }, versions: ['2027-01-03T00:00:00Z'] },
      'not-ours': { labels: { team: 'data' }, versions: ['2027-01-01T00:00:00Z'], bindings: [{ role: ACCESSOR, members: [AGENT] }] },
      'no-value': MANAGED,
    },
  });
  const dash = await start(sm);
  t.after(dash.stop);
  const listed = await listSecrets(dash.runtime, { actor: ADMIN });
  assert.equal(listed.agent_account, 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com');
  assert.deepEqual(listed.secrets.map((s) => [s.name, s.version, s.agent_access, s.problem]), [
    ['a-key', 1, false, null],
    ['b-token', 2, true, null],
    ['no-value', null, false, null],
  ]);
  assert.deepEqual(listed.secrets[0], {
    name: 'a-key', description: 'Weather API', created_at: CREATED, created_by: 'zoe@example.com',
    version: 1, version_state: 'ENABLED', updated_at: '2027-01-03T00:00:00Z', agent_access: false, problem: null,
  });
  const lists = sm.calls.filter((c) => /\/secrets\?/.test(c.url)).map((c) => c.url);
  assert.equal(lists[0], `${BASE}/secrets?filter=labels.paraclete%3Dagent&pageSize=250`);
  assert.equal(lists.length, 3, 'every page is read');
  assert.ok(!sm.calls.some((c) => c.url.includes('not-ours')), 'a secret the dashboard does not manage is never looked into');
});

test("a secret whose access can't be read still lists, with the problem", async (t) => {
  const sm = fakeSecretManager({ secrets: { 'a-key': { ...MANAGED, versions: ['2027-01-03T00:00:00Z'] } }, fail: { getIamPolicy: () => googleError(403, 'PERMISSION_DENIED', 'no policy for you') } });
  const dash = await start(sm);
  t.after(dash.stop);
  const [secret] = (await listSecrets(dash.runtime, { actor: ADMIN })).secrets;
  assert.equal(secret.agent_access, null);
  assert.match(secret.problem, /no policy for you/);
});

test('replacing a value adds a version to a managed secret only', async (t) => {
  const sm = fakeSecretManager({ secrets: { 'a-key': { ...MANAGED, versions: ['2027-01-03T00:00:00Z'] }, 'not-ours': { versions: ['2027-01-01T00:00:00Z'] } } });
  const dash = await start(sm);
  t.after(dash.stop);
  const replaced = await replaceSecretValue(dash.runtime, { name: 'a-key', value: 'new value', actor: ADMIN });
  assert.deepEqual(replaced, { name: 'a-key', version: 2, updated_at: '2027-01-16T09:00:00.000000Z' });
  assert.deepEqual(sm.calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/secrets/a-key`, `POST ${BASE}/secrets/a-key:addVersion`]);
  assert.equal(sm.store.get('a-key').versions.at(-1).data, Buffer.from('new value').toString('base64'));

  for (const name of ['not-ours', 'missing']) {
    await assert.rejects(replaceSecretValue(dash.runtime, { name, value: 'v', actor: ADMIN }), (err) => err.status === 404);
  }
  assert.equal(sm.store.get('not-ours').versions.length, 1);
  await assert.rejects(replaceSecretValue(dash.runtime, { name: 'a-key', value: '', actor: ADMIN }), (err) => err.status === 400);
});

test('deleting removes a managed secret and refuses any other', async (t) => {
  const sm = fakeSecretManager({ secrets: { 'a-key': MANAGED, 'not-ours': {} } });
  const dash = await start(sm);
  t.after(dash.stop);
  assert.deepEqual(await deleteSecret(dash.runtime, { name: 'a-key', actor: ADMIN }), { name: 'a-key' });
  assert.deepEqual(sm.calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}/secrets/a-key`, `DELETE ${BASE}/secrets/a-key`]);
  assert.equal(sm.store.has('a-key'), false);
  await assert.rejects(deleteSecret(dash.runtime, { name: 'not-ours', actor: ADMIN }), (err) => err.status === 404);
  assert.equal(sm.store.has('not-ours'), true);
});

test('granting the agent again joins the existing binding, retrying once when the policy changed meanwhile', async (t) => {
  const reader = 'serviceAccount:reader@your-gcp-project.iam.gserviceaccount.com';
  const sm = fakeSecretManager({ conflicts: 1, secrets: { 'a-key': { ...MANAGED, bindings: [{ role: ACCESSOR, members: [reader] }] } } });
  const dash = await start(sm);
  t.after(dash.stop);
  assert.deepEqual(await grantSecretToAgent(dash.runtime, { name: 'a-key', actor: ADMIN }), { name: 'a-key', changed: true });
  const sets = sm.calls.filter((c) => c.url.endsWith(':setIamPolicy'));
  assert.equal(sets.length, 2);
  assert.notEqual(sets[0].body.policy.etag, sets[1].body.policy.etag, 'the retry carries the fresh etag');
  assert.deepEqual(sm.store.get('a-key').policy.bindings, [{ role: ACCESSOR, members: [reader, AGENT] }]);
  assert.deepEqual(await grantSecretToAgent(dash.runtime, { name: 'a-key', actor: ADMIN }), { name: 'a-key', changed: false });
});

test("Secret Manager refusing the dashboard names the role it needs", async (t) => {
  const sm = fakeSecretManager({ fail: { addVersion: () => googleError(403, 'PERMISSION_DENIED', 'Permission denied on secret') }, secrets: { 'a-key': MANAGED } });
  const dash = await start(sm);
  t.after(dash.stop);
  await assert.rejects(replaceSecretValue(dash.runtime, { name: 'a-key', value: 'v', actor: ADMIN }), (err) => err.status === 502 && /roles\/secretmanager\.admin/.test(err.message));
});

test('without a region the secret replicates automatically', async (t) => {
  const sm = fakeSecretManager();
  const dash = await start(sm, { PARACLETE_REGION: '' });
  t.after(dash.stop);
  await createSecret(dash.runtime, { name: 'api-key', value: 'v', actor: ADMIN });
  assert.deepEqual(sm.calls[0].body.replication, { automatic: {} });
});
