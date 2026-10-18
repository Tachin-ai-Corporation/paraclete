// Tests for agent/providers/workspace.mjs: the session acts only as the instance's Workspace account,
// asks for a token carrying just the scopes of the API it calls, builds exact URLs, and turns every
// Google failure (token exchange, scope, disabled API, quota, not found, not shared, wrong file type)
// into a plain sentence with Google's message and the fix. The ownership rule refuses a file the agent
// does not own before anything is changed. Google is a fake fetch.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspaceSession, workspaceAccount, classifyError, tokenError, mapLimit, sameEmail, WorkspaceError, API_HOSTS,
} from '../../../agent/providers/workspace.mjs';
import { DOCS, DRIVE, CALENDAR, GMAIL_READ } from '../../../agent/auth/workspace-scopes.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import {
  INSTANCE, NO_WORKSPACE, ACCOUNT, SIGNER, json, googleError, grpcError, fakeTokens, fakeGoogle, driveFile, driveFilesRoute,
} from './workspace-fakes.mjs';

const session = (fetch, extra = {}) => createWorkspaceSession({ instance: INSTANCE, fetch, getDwdToken: fakeTokens(), ...extra });

describe('the account', () => {
  test('is the instance record\'s Workspace account, signed for by its signer', () => {
    assert.deepEqual(workspaceAccount(INSTANCE), { account: ACCOUNT, signer: SIGNER });
    const s = session(fakeGoogle().fetch);
    assert.equal(s.account, ACCOUNT);
    assert.equal(s.signer, SIGNER);
  });

  test('an instance without one is refused in plain words, before any call', () => {
    for (const instance of [NO_WORKSPACE, {}, { workspace: { account: ACCOUNT } }]) {
      assert.throws(() => createWorkspaceSession({ instance, fetch: () => assert.fail('no call') }), (err) => err instanceof WorkspaceError
        && err.kind === 'no_account' && /no Workspace account/.test(err.message) && /Settings \(Workspace\)/.test(err.message));
    }
  });

  test('sameEmail ignores case and spaces, and never matches nothing', () => {
    assert.equal(sameEmail('Agent@Example.com ', 'agent@example.com'), true);
    assert.equal(sameEmail('', ''), false);
    assert.equal(sameEmail(null, undefined), false);
  });
});

describe('requests', () => {
  test('each API gets a token with only its own scopes, through domain-wide delegation as the agent', async () => {
    const google = fakeGoogle([['GET', /.*/, () => json({ ok: true })]]);
    const tokens = fakeTokens();
    const s = session(google.fetch, { getDwdToken: tokens });
    await s.request('docs', 'GET', '/v1/documents/abc');
    await s.request('calendar', 'GET', '/calendar/v3/calendars/primary');
    await s.request('gmail', 'GET', '/gmail/v1/users/me/profile');
    assert.deepEqual(tokens.asked, [
      { signerServiceAccount: SIGNER, subjectEmail: ACCOUNT, scopes: [...DOCS] },
      { signerServiceAccount: SIGNER, subjectEmail: ACCOUNT, scopes: [...CALENDAR] },
      { signerServiceAccount: SIGNER, subjectEmail: ACCOUNT, scopes: [...GMAIL_READ] },
    ]);
    assert.equal(google.calls[0].url, `${API_HOSTS.docs}/v1/documents/abc`);
    assert.equal(google.calls[0].headers.Authorization, 'Bearer tok-documents');
    assert.equal(google.calls[1].url, 'https://www.googleapis.com/calendar/v3/calendars/primary');
    assert.equal(google.calls[2].url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  });

  test('query values: arrays repeat, empty ones are left out; a JSON body is sent as JSON', async () => {
    const google = fakeGoogle([['POST', /.*/, () => json({})]]);
    await session(google.fetch).request('gmail', 'POST', '/x', { query: { a: ['1', '2'], b: '', c: undefined, d: 0 }, json: { k: 'v' } });
    assert.equal(google.calls[0].url, 'https://gmail.googleapis.com/x?a=1&a=2&d=0');
    assert.equal(google.calls[0].headers['Content-Type'], 'application/json; charset=UTF-8');
    assert.deepEqual(google.calls[0].json(), { k: 'v' });
  });

  test("the instance record's endpoints override an API's origin", async () => {
    const google = fakeGoogle([['GET', /.*/, () => json({})]]);
    const s = createWorkspaceSession({ instance: { ...INSTANCE, endpoints: { sheets: 'http://127.0.0.1:9099/' } }, fetch: google.fetch, getDwdToken: fakeTokens() });
    await s.request('sheets', 'GET', '/v4/spreadsheets/x');
    assert.equal(google.calls[0].url, 'http://127.0.0.1:9099/v4/spreadsheets/x');
  });

  test('bytes and empty answers', async () => {
    const google = fakeGoogle([['GET', '/bytes', () => new Response('abc')], ['DELETE', '/none', () => new Response(null, { status: 204 })]]);
    const s = session(google.fetch);
    assert.equal((await s.request('drive', 'GET', '/bytes', { expect: 'bytes' })).toString(), 'abc');
    assert.equal(await s.request('drive', 'DELETE', '/none'), null);
  });
});

describe('failures in plain words', () => {
  async function failure(response, about = {}, api = 'docs') {
    const s = session(fakeGoogle([['GET', /.*/, () => response]]).fetch);
    return s.request(api, 'GET', '/v1/documents/1DocAbc', { about: { what: 'document 1DocAbc', ...about } }).then(
      () => assert.fail('expected a failure'),
      (err) => { assert.ok(err instanceof WorkspaceError); return err; },
    );
  }

  test('a scope missing from the grant names the scope and where an admin adds it', async () => {
    const err = await failure(grpcError(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'));
    assert.equal(err.kind, 'scope');
    assert.equal(err.reason, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    assert.match(err.message, /^Google Docs refused agent@example\.com: the domain-wide delegation grant does not include https:\/\/www\.googleapis\.com\/auth\/documents\./);
    assert.match(err.message, /Admin console \(Security, Access and data control, API controls, Domain-wide delegation\)/);
    assert.match(err.message, /\(Google: Request had insufficient authentication scopes\.\)$/);
    const legacy = await failure(googleError(403, 'insufficientPermissions', 'Insufficient Permission'), {}, 'calendar');
    assert.equal(legacy.kind, 'scope');
    assert.match(legacy.message, /auth\/calendar/);
  });

  test('401 is the credentials, with the scope the grant may lack', async () => {
    const err = await failure(grpcError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'));
    assert.equal(err.kind, 'auth');
    assert.match(err.message, /refused the credentials of agent@example\.com\. The domain-wide delegation grant may lack https:\/\/www\.googleapis\.com\/auth\/documents/);
  });

  test('a turned-off API, a quota, a server failure', async () => {
    const disabled = await failure(grpcError(403, 'PERMISSION_DENIED', 'Google Docs API has not been used in project 123 before or it is disabled.', 'SERVICE_DISABLED'));
    assert.equal(disabled.kind, 'api_disabled');
    assert.match(disabled.message, /The Google Docs API is turned off in this Google Cloud project/);
    for (const r of [grpcError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', 'RATE_LIMIT_EXCEEDED'), googleError(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded')]) {
      const quota = await failure(r);
      assert.equal(quota.kind, 'quota');
      assert.match(quota.message, /is limiting requests from agent@example\.com .*do not retry in a loop/);
    }
    const down = await failure(json({ error: { code: 503, message: 'The service is currently unavailable.' } }, 503));
    assert.equal(down.kind, 'unavailable');
    assert.match(down.message, /failed to answer \(HTTP 503\)/);
  });

  test('not found says it may not be shared, and never to edit an id', async () => {
    const err = await failure(grpcError(404, 'NOT_FOUND', 'Requested entity was not found.'));
    assert.equal(err.kind, 'not_found');
    assert.match(err.message, /^Google Docs has no document 1DocAbc that agent@example\.com can see: the id or link is wrong, or it is not shared with agent@example\.com\. .*never edit an id and retry/);
    const mail = await failure(googleError(404, 'notFound', 'Not Found'), { notFound: 'There is no message x in the mailbox.' }, 'gmail');
    assert.equal(mail.message, 'There is no message x in the mailbox. (Google: Not Found)');
  });

  test('forbidden on a file is "not shared" for a read, and the action for a write', async () => {
    const read = await failure(grpcError(403, 'PERMISSION_DENIED', 'The caller does not have permission'));
    assert.equal(read.kind, 'permission');
    assert.match(read.message, /^agent@example\.com is not allowed to open document 1DocAbc\. Ask its owner to share it with agent@example\.com\./);
    const write = await failure(grpcError(403, 'PERMISSION_DENIED', 'The caller does not have permission'), { action: 'change' });
    assert.match(write.message, /^agent@example\.com is not allowed to change document 1DocAbc\./);
  });

  test('an uploaded Office file is not a Google file', async () => {
    const err = await failure(grpcError(400, 'FAILED_PRECONDITION', 'This operation is not supported for this document'));
    assert.equal(err.kind, 'wrong_type');
    assert.match(err.message, /not a native Google file .*drive-get and file-read/);
  });

  test('a bad request keeps Google\'s message, which says what is wrong', async () => {
    const err = await failure(grpcError(400, 'INVALID_ARGUMENT', 'Invalid requests[0].replaceAllText: text must not be empty.'));
    assert.equal(err.kind, 'bad_request');
    assert.match(err.message, /refused the request \(HTTP 400\).*\(Google: Invalid requests\[0\]\.replaceAllText: text must not be empty\.\)$/);
  });

  test('an unreachable API', async () => {
    const s = session(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    await assert.rejects(s.request('slides', 'GET', '/v1/presentations/x'), (err) => err.kind === 'unavailable' && /^Google Slides could not be reached: getaddrinfo ENOTFOUND/.test(err.message));
  });

  test('classifyError on its own', () => {
    assert.equal(classifyError(403, [], null, 'Request had insufficient authentication scopes.'), 'scope');
    assert.equal(classifyError(400, [], 'INVALID_ARGUMENT', 'The required revision ID does not match'), 'conflict');
    assert.equal(classifyError(409, []), 'conflict');
    assert.equal(classifyError(418, []), 'bad_request');
  });
});

describe('token failures', () => {
  const who = { account: ACCOUNT, signer: SIGNER };

  test('a grant without the scope is named, with the scope and the Workspace check', () => {
    const err = tokenError('calendar', new Error('Delegated token exchange failed: Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.'), who);
    assert.equal(err.kind, 'scope');
    assert.match(err.message, /^Cannot get a Google Calendar token for agent@example\.com: Google refused the domain-wide delegation \(.*\)\. The grant must include https:\/\/www\.googleapis\.com\/auth\/calendar; .*Workspace check in Settings/);
  });

  test('an unknown or suspended account, and a signer the VM cannot sign as', () => {
    assert.equal(tokenError('gmail', new Error('Delegated token exchange failed: invalid_grant'), who).kind, 'account');
    const sign = tokenError('docs', new Error('signJwt failed (HTTP 403): denied'), who);
    assert.equal(sign.kind, 'token');
    assert.match(sign.message, /could not sign as paraclete-dwd@your-gcp-project\.iam\.gserviceaccount\.com .*re-running the installer repairs it/);
  });

  test('the session turns a failed token into that error, before any API call', async () => {
    const google = fakeGoogle();
    const s = session(google.fetch, { getDwdToken: async () => { throw new Error('Delegated token exchange failed: unauthorized_client'); } });
    await assert.rejects(s.request('sheets', 'GET', '/v4/spreadsheets/x'), (err) => err.kind === 'scope' && err.message.includes('auth/spreadsheets'));
    assert.equal(google.calls.length, 0);
  });
});

describe('ownership', () => {
  const MINE = driveFile('1MineAbcdefghij', { name: 'Plan' });
  const THEIRS = driveFile('1TheirsAbcdefgh', { name: 'Budget', owner: 'pat@example.com' });
  const SHARED_DRIVE = driveFile('1SharedAbcdefgh', { name: 'Team notes', driveId: '0ASharedDrive' });
  const UPLOAD = driveFile('1UploadAbcdefgh', { name: 'contract.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const files = { [MINE.id]: MINE, [THEIRS.id]: THEIRS, [SHARED_DRIVE.id]: SHARED_DRIVE, [UPLOAD.id]: UPLOAD };

  test('a Google file the agent owns passes, read with the Drive scope and the owner fields', async () => {
    const google = fakeGoogle([driveFilesRoute(files)]);
    const info = await session(google.fetch).ownedFile(MINE.id, { type: GOOGLE_TYPES.document });
    assert.equal(info.name, 'Plan');
    const call = google.calls[0];
    assert.equal(call.path, `/drive/v3/files/${MINE.id}`);
    assert.equal(call.params.get('supportsAllDrives'), 'true');
    assert.match(call.params.get('fields'), /ownedByMe/);
    assert.equal(call.headers.Authorization, `Bearer tok-${DRIVE[0].split('/').pop()}`);
  });

  test("someone else's file is refused, naming its owner and what to do instead", async () => {
    const s = session(fakeGoogle([driveFilesRoute(files)]).fetch);
    await assert.rejects(s.ownedFile(THEIRS.id, { type: GOOGLE_TYPES.document, action: 'change' }), (err) => err.kind === 'not_owner'
      && /^You may not change "Budget": it belongs to Pat Example <pat@example\.com>, not to agent@example\.com\./.test(err.message)
      && /Comment on it instead, or make a new file/.test(err.message));
    await assert.rejects(s.ownedFile(SHARED_DRIVE.id, { type: GOOGLE_TYPES.document }), (err) => err.kind === 'not_owner' && /in a shared drive, where files have no single owner/.test(err.message));
  });

  test('a file of the wrong type is refused, even when the agent owns it', async () => {
    const s = session(fakeGoogle([driveFilesRoute(files)]).fetch);
    await assert.rejects(s.ownedFile(UPLOAD.id, { type: GOOGLE_TYPES.document }), (err) => err.kind === 'wrong_type' && /is application\/vnd.*, not a Google Doc/.test(err.message));
  });

  test('an owner matched by address counts when Drive does not say ownedByMe', async () => {
    const google = fakeGoogle([driveFilesRoute({ x1234567890: { ...MINE, id: 'x1234567890', ownedByMe: undefined, owners: [{ emailAddress: 'AGENT@example.com' }] } })]);
    assert.equal((await session(google.fetch).ownedFile('x1234567890')).id, 'x1234567890');
  });
});

describe('Drive helpers', () => {
  test('createEmpty makes a Google file in a folder, or in My Drive', async () => {
    const google = fakeGoogle([['POST', '/drive/v3/files', (call) => json({ id: 'new1', ...call.json() })]]);
    const s = session(google.fetch);
    await s.createEmpty({ name: 'Deck', mimeType: GOOGLE_TYPES.presentation, parentId: 'folder1' });
    await s.createEmpty({ name: 'Deck 2', mimeType: GOOGLE_TYPES.presentation });
    assert.deepEqual(google.calls[0].json(), { name: 'Deck', mimeType: GOOGLE_TYPES.presentation, parents: ['folder1'] });
    assert.equal(google.calls[0].params.get('supportsAllDrives'), 'true');
    assert.deepEqual(google.calls[1].json(), { name: 'Deck 2', mimeType: GOOGLE_TYPES.presentation });
  });

  test('the session\'s Drive client is the same account, with the Drive scope from the same token source', async () => {
    const google = fakeGoogle([['GET', '/drive/v3/about', () => json({ user: { emailAddress: ACCOUNT } })]]);
    const tokens = fakeTokens();
    const s = session(google.fetch, { getDwdToken: tokens });
    assert.deepEqual(s.drive.identity(), { kind: 'workspace', email: ACCOUNT });
    await s.drive.about();
    assert.deepEqual(tokens.asked[0].scopes, [...DRIVE]);
    assert.equal(s.drive, s.drive, 'made once');
  });
});

test('mapLimit keeps the order and runs at most `limit` at once', async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, n));
    running -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(most, 2);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});
