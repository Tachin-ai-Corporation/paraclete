// Tests for agent/services/control/workspace-check.mjs: the Workspace check against a fake Google
// (workspace-fakes.mjs). A complete grant passes every API, with Docs, Sheets and Slides proved by
// "not found"; a grant missing scopes names exactly those, and the client ID; no grant, an unknown
// user and a signer the agent cannot use stop every API with one fix; an API turned off, a Chat app not
// configured and Gmail off for the user each get their own fix, and Chat's bare "permission denied"
// names the project's Chat app record before the user's settings; a bad address is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkspace, tokenFailure, API_PROBES, DELEGATION_PAGE, PROBE_FILE_ID } from '../../../../agent/services/control/workspace-check.mjs';
import { WORKSPACE_SCOPES, WORKSPACE_APIS, CALENDAR, GMAIL_READ } from '../../../../agent/auth/workspace-scopes.mjs';
import {
  fakeGoogle, answers, ACCOUNT, CLIENT_ID, PROJECT, SIGNER, VM_TOKEN, PERSONAL, PERSONAL_LEGACY, OTHER_SERVICE_ACCOUNT,
} from './workspace-fakes.mjs';

const NOW = new Date('2026-10-18T09:00:00.000Z');

function run(google, account = ACCOUNT) {
  return checkWorkspace({ account, project: PROJECT, fetch: google.fetch, getVmAccessToken: async () => VM_TOKEN, now: () => NOW });
}

const byApi = (result) => Object.fromEntries(result.apis.map((entry) => [entry.api, entry]));

test('a complete grant: every API answers, and the result names the account, the signer and each API', async () => {
  const google = fakeGoogle();
  const result = await run(google, '  Agent@Example.COM ');
  assert.equal(result.account, ACCOUNT, 'the address is trimmed and lowercased');
  assert.equal(result.signer, SIGNER);
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing_scopes, []);
  assert.equal(result.client_id, null, 'the client ID is looked up only when the grant is at fault');
  assert.equal(result.checked_at, NOW.toISOString());
  assert.deepEqual(result.apis.map((a) => a.api), Object.keys(WORKSPACE_APIS));
  for (const entry of result.apis) {
    assert.deepEqual(entry, { api: entry.api, name: WORKSPACE_APIS[entry.api].name, scopes: [...WORKSPACE_APIS[entry.api].scopes], ok: true, error: null, fix: null });
  }

  // Signed as the signer, with the VM's own token, naming the account as the subject.
  for (const sign of google.of('signJwt')) {
    assert.ok(sign.url.endsWith(`/serviceAccounts/${encodeURIComponent(SIGNER)}:signJwt`));
    assert.equal(sign.headers.Authorization, `Bearer ${VM_TOKEN}`);
    assert.equal(sign.claims.iss, SIGNER);
    assert.equal(sign.claims.sub, ACCOUNT);
  }
  // The whole list first, then one token per API, each with that API's scopes only.
  const scopesAsked = google.of('token').map((t) => t.claims.scope);
  assert.equal(scopesAsked[0], WORKSPACE_SCOPES.join(' '));
  assert.deepEqual(scopesAsked.slice(1), Object.values(WORKSPACE_APIS).map((a) => a.scopes.join(' ')));
  // Every API call read only, with its own token.
  for (const call of google.of('api')) {
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.Authorization, `Bearer token:${ACCOUNT}:${WORKSPACE_APIS[call.api].scopes.join(' ')}`);
  }
  for (const api of ['docs', 'sheets', 'slides']) {
    assert.ok(google.of('api').find((c) => c.api === api).url.includes(PROBE_FILE_ID), `${api} is asked for a file that cannot exist`);
  }
  assert.equal(PROBE_FILE_ID.length, 44);
});

test('a grant missing scopes: exactly those are named, with the client ID, and only their APIs fail', async () => {
  const granted = WORKSPACE_SCOPES.filter((s) => !CALENDAR.includes(s) && !GMAIL_READ.includes(s));
  const google = fakeGoogle({ granted });
  const result = await run(google);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing_scopes, [...CALENDAR, ...GMAIL_READ]);
  assert.equal(result.client_id, CLIENT_ID);
  const apis = byApi(result);
  for (const api of ['chat', 'drive', 'docs', 'sheets', 'slides']) assert.equal(apis[api].ok, true, api);
  assert.equal(apis.calendar.ok, false);
  assert.equal(apis.calendar.error, `the domain-wide delegation entry lacks ${CALENDAR[0]}`);
  assert.match(apis.calendar.fix, new RegExp(`client ID ${CLIENT_ID}`));
  assert.ok(apis.calendar.fix.includes(DELEGATION_PAGE));
  assert.ok(apis.gmail.fix.includes(GMAIL_READ[0]));
  assert.ok(!apis.gmail.fix.includes(CALENDAR[0]), 'each API names only its own missing scopes');
  // Each scope was asked for alone once the whole list was refused; the failing APIs were not called.
  assert.ok(WORKSPACE_SCOPES.every((scope) => google.of('token').some((t) => t.claims.scope === scope)));
  assert.ok(!google.of('api').some((c) => c.api === 'calendar' || c.api === 'gmail'));
});

test('no grant at all: every API fails with one fix that names the client ID and says another one does not count', async () => {
  const result = await run(fakeGoogle({ granted: [] }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing_scopes, [...WORKSPACE_SCOPES]);
  const fixes = new Set(result.apis.map((a) => a.fix));
  assert.equal(fixes.size, 1);
  const [fix] = fixes;
  assert.match(fix, new RegExp(`no domain-wide delegation to client ID ${CLIENT_ID}`));
  assert.match(fix, /another one/);
  assert.ok(fix.includes(DELEGATION_PAGE));
  assert.ok(result.apis.every((a) => /unauthorized/.test(a.error)));

  const unknownId = await run(fakeGoogle({ granted: [], clientIdReadable: false }));
  assert.equal(unknownId.client_id, null);
  assert.ok(unknownId.apis[0].fix.includes(`client ID of ${SIGNER}`), 'without the number, the fix names whose client ID');
});

test('a user Google does not know stops every API at once, with the Admin console fix', async () => {
  const google = fakeGoogle({ userExists: false });
  const result = await run(google);
  assert.equal(result.ready, false);
  assert.equal(result.missing_scopes, null, 'the grant could not be judged');
  assert.equal(google.of('token').length, 1, 'no per-scope probing when the user is the problem');
  assert.equal(google.of('api').length, 0);
  for (const entry of result.apis) {
    assert.match(entry.error, /Invalid email or User ID/);
    assert.match(entry.fix, /does not know agent@example\.com as an active user/);
    assert.match(entry.fix, /suspended/);
  }
});

test('a signer that does not exist, or that the agent may not sign as, points at the installer', async () => {
  const missing = await run(fakeGoogle({ signerStatus: 404 }));
  assert.match(missing.apis[0].fix, new RegExp(`${SIGNER.replace(/[.]/g, '\\.')} does not exist`));
  assert.match(missing.apis[0].fix, /install\/install\.sh/);
  const refused = await run(fakeGoogle({ signerStatus: 403 }));
  assert.match(refused.apis[0].fix, /Service Account Token Creator/);
  assert.match(refused.apis[0].fix, new RegExp(`paraclete-agent@${PROJECT}`));
  assert.equal(refused.ready, false);
  assert.ok(refused.apis.every((a) => !a.ok && a.fix === refused.apis[0].fix));
});

test('an API off in the project, a Chat app not configured and Gmail off for the user each get their own fix', async () => {
  const google = fakeGoogle({
    apis: {
      sheets: answers.disabled('sheets.googleapis.com'),
      chat: answers.chatAppMissing(),
      gmail: answers.mailOff(),
      calendar: answers.status(403, 'The user has not been granted access to this service.'),
      drive: answers.status(503, 'Backend Error'),
    },
  });
  const result = await run(google);
  const apis = byApi(result);
  assert.equal(result.ready, false);
  assert.equal(apis.docs.ok, true);
  assert.match(apis.sheets.error, /^HTTP 403: sheets\.googleapis\.com has not been used/);
  assert.ok(apis.sheets.fix.includes(`https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=${PROJECT}`));
  assert.match(apis.chat.fix, /needs a Chat app record/);
  assert.ok(apis.chat.fix.includes(`chat.googleapis.com/hangouts-chat?project=${PROJECT}`));
  assert.match(apis.chat.fix, /turn Interactive features off/);
  assert.match(apis.gmail.fix, /Gmail is off for agent@example\.com/);
  assert.match(apis.calendar.fix, /Google Calendar is on for the user's organizational unit/);
  assert.match(apis.drive.fix, /Run Test again in a minute/);
});

test("Chat's bare permission denied names the project's Chat app record first, then Chat for the user", async () => {
  const google = fakeGoogle({ apis: { chat: answers.status(403, "Permission denied to perform the requested action on the specified resource, or the resource doesn't exist.") } });
  const apis = byApi(await run(google));
  assert.equal(apis.chat.ok, false);
  assert.ok(apis.chat.fix.includes(`chat.googleapis.com/hangouts-chat?project=${PROJECT}`));
  assert.ok(apis.chat.fix.indexOf('Chat app record') < apis.chat.fix.indexOf('organizational unit'), 'the project first, then the user');
  assert.equal(apis.drive.ok, true, 'the other APIs are unaffected');
});

test('without a network, every API says so', async () => {
  const result = await run(fakeGoogle({ offline: true }));
  assert.equal(result.ready, false);
  assert.ok(result.apis.every((a) => /could not be reached/.test(a.fix)));
});

test('an address that is not a Workspace user is refused before Google is asked', async () => {
  const google = fakeGoogle();
  for (const [account, reason] of [
    ['', /Workspace address/],
    [null, /Workspace address/],
    [['agent@example.com'], /Workspace address/],
    ['agent', /not an email address/],
    ['agent@localhost', /not an email address/],
    [PERSONAL, /personal Google account/],
    [PERSONAL_LEGACY, /personal Google account/],
    [SIGNER, /service account/],
    [OTHER_SERVICE_ACCOUNT, /service account/],
  ]) {
    await assert.rejects(run(google, account), reason, String(account));
  }
  assert.equal(google.calls.length, 0);
});

test('token failures are sorted by cause', () => {
  assert.deepEqual(tokenFailure(new Error('signJwt failed (HTTP 403): denied')).kind, 'signer');
  assert.equal(tokenFailure(new Error('signJwt failed (HTTP 404): gone')).status, 404);
  assert.equal(tokenFailure(new Error('Delegated token exchange failed: Client is unauthorized to retrieve access tokens using this method')).kind, 'grant');
  assert.equal(tokenFailure(new Error('Delegated token exchange failed: unauthorized_client')).kind, 'grant');
  assert.equal(tokenFailure(new Error('Delegated token exchange failed: Invalid email or User ID')).kind, 'user');
  assert.equal(tokenFailure(new TypeError('fetch failed')).kind, 'network');
  assert.equal(tokenFailure(new Error('metadata server said no')).kind, 'other');
});

test('every probe calls an API the installer turns on for a Workspace role', () => {
  assert.deepEqual(API_PROBES.map((p) => p.api), Object.keys(WORKSPACE_APIS));
  for (const probe of API_PROBES) {
    assert.match(probe.service, /^[a-z-]+\.googleapis\.com$/);
    assert.ok(probe.url.startsWith('https://'));
  }
});
