// Tests for agent/providers/drive.mjs: the identity it acts as (the VM's service account, or the agent's
// Workspace account through domain-wide delegation), the exact Drive URLs it calls (supportsAllDrives
// on files calls, includeItemsFromAllDrives on lists, neither where Drive takes neither), query
// escaping, the multipart and resumable upload bodies, trashing (never deleting or changing) a file,
// Drive links, and Google's errors in plain words. Drive is a fake fetch; nothing leaves the process.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDriveClient, parseDriveLink, escapeQueryValue, exportMimeType, conversionFor, describeType, isGoogleNative,
  DriveError, DRIVE_SCOPE, GOOGLE_TYPES, EXPORT_FORMATS,
} from '../../../agent/providers/drive.mjs';
import { agentIdentity } from '../../../config/instance.mjs';

const INSTANCE = Object.freeze({ project: 'your-gcp-project', agent_name: 'Paraclete', workspace: null, endpoints: {} });
const WORKSPACE_INSTANCE = Object.freeze({
  ...INSTANCE,
  workspace: { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' },
});
const SA_EMAIL = 'paraclete-agent@your-gcp-project.iam.gserviceaccount.com';
const DOC_ID = '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const PDF_ID = '1PdfAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const FOLDER_ID = '1FolderBcDeFgHiJkLmNoPqRsTuVwXyz01';
const DRIVE_ID = '0AExampleSharedDrv9PVA';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const googleError = (status, reason, message, extra = {}) => json({ error: { code: status, message, errors: [{ message, domain: 'global', reason }], ...extra } }, status);

/** A fake fetch: `respond(call)` answers each request; every call is recorded with its URL parts. */
function fakeFetch(respond = () => json({})) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { url: String(url), method: init.method || 'GET', path: u.pathname, params: u.searchParams, headers: init.headers || {}, body: init.body };
    calls.push(call);
    return respond(call);
  };
  fn.calls = calls;
  return fn;
}

function client(fetch, extra = {}) {
  return createDriveClient({ instance: INSTANCE, getAccessToken: async () => 'vm-token', fetch, ...extra });
}

const META = {
  [DOC_ID]: { id: DOC_ID, name: 'Plan', mimeType: GOOGLE_TYPES.document, capabilities: { canDownload: true, canEdit: true } },
  [PDF_ID]: { id: PDF_ID, name: 'report.pdf', mimeType: 'application/pdf', size: '5', capabilities: { canDownload: true } },
};

describe('identity', () => {
  test('without a Workspace account it is the service account, with the address config/instance.mjs gives it', async () => {
    const fetch = fakeFetch(() => json({ user: { emailAddress: SA_EMAIL } }));
    let dwdCalls = 0;
    const drive = client(fetch, { getDwdToken: async () => { dwdCalls += 1; return 'dwd'; } });
    assert.deepEqual(drive.identity(), { kind: 'service_account', email: SA_EMAIL });
    assert.equal(drive.identity().email, agentIdentity(INSTANCE).email, 'the copied account name matches agentIdentity');
    await drive.about();
    assert.equal(fetch.calls[0].headers.Authorization, 'Bearer vm-token');
    assert.equal(dwdCalls, 0);
  });

  test("with a Workspace account it is that account, through a Drive-scoped domain-wide delegation token", async () => {
    const fetch = fakeFetch(() => json({}));
    const asked = [];
    const drive = createDriveClient({
      instance: WORKSPACE_INSTANCE, fetch,
      getAccessToken: async () => { throw new Error('the VM token is not used directly'); },
      getDwdToken: async (request) => { asked.push(request); return 'dwd-token'; },
    });
    assert.deepEqual(drive.identity(), { kind: 'workspace', email: 'agent@example.com' });
    assert.equal(drive.identity().email, agentIdentity(WORKSPACE_INSTANCE).email);
    await drive.about();
    assert.deepEqual(asked, [{ signerServiceAccount: WORKSPACE_INSTANCE.workspace.signer, subjectEmail: 'agent@example.com', scopes: [DRIVE_SCOPE] }]);
    assert.equal(fetch.calls[0].headers.Authorization, 'Bearer dwd-token');
  });

  test('the default Workspace token source signs as the signer with the VM token, over the same fetch', async () => {
    const fetch = fakeFetch((call) => {
      if (call.url.includes(':signJwt')) return json({ signedJwt: 'signed' });
      if (call.url.startsWith('https://oauth2.googleapis.com/')) return json({ access_token: 'dwd-token', expires_in: 3600 });
      return json({ user: {} });
    });
    const drive = createDriveClient({ instance: WORKSPACE_INSTANCE, fetch, getAccessToken: async () => 'vm-token', now: () => 1_000_000 });
    await drive.about();
    const sign = fetch.calls[0];
    assert.equal(sign.url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(WORKSPACE_INSTANCE.workspace.signer)}:signJwt`);
    assert.equal(sign.headers.Authorization, 'Bearer vm-token');
    const claims = JSON.parse(JSON.parse(sign.body).payload);
    assert.equal(claims.sub, 'agent@example.com');
    assert.equal(claims.scope, DRIVE_SCOPE);
    assert.equal(fetch.calls[2].headers.Authorization, 'Bearer dwd-token');
  });

  test('a token that cannot be had is a plain error naming the identity and the grant', async () => {
    const drive = createDriveClient({ instance: WORKSPACE_INSTANCE, fetch: fakeFetch(), getDwdToken: async () => { throw new Error('signJwt failed (HTTP 403).'); } });
    await assert.rejects(drive.about(), (err) => err instanceof DriveError && err.kind === 'token'
      && /^Cannot get a Drive token for agent@example\.com: signJwt failed \(HTTP 403\)\. Check the domain-wide delegation grant/.test(err.message)
      && err.message.includes(DRIVE_SCOPE));
  });

  test('a client needs a project to name the service account', () => {
    assert.throws(() => createDriveClient({ instance: {} }), /instance\.project is required/);
  });

  test("the instance record's drive endpoint overrides the API origin", async () => {
    const fetch = fakeFetch(() => json({}));
    await client(fetch, { instance: { ...INSTANCE, endpoints: { drive: 'http://127.0.0.1:9099/' } } }).about();
    assert.match(fetch.calls[0].url, /^http:\/\/127\.0\.0\.1:9099\/drive\/v3\/about\?/);
  });
});

describe('reading', () => {
  test('about asks for the user and the quota, without the all-drives flag about.get does not take', async () => {
    const fetch = fakeFetch(() => json({ user: { emailAddress: SA_EMAIL } }));
    const about = await client(fetch).about();
    assert.equal(about.user.emailAddress, SA_EMAIL);
    assert.equal(fetch.calls[0].url, `${API}/about?fields=user%28displayName%2CemailAddress%29%2CstorageQuota%28limit%2Cusage%29`);
  });

  test('find builds a safe query and searches every drive, newest first', async () => {
    const fetch = fakeFetch(() => json({ files: [{ id: PDF_ID, name: "O'Brien.pdf", size: '12' }] }));
    const found = await client(fetch).find({ name: "O'Brien \\ notes", mimeType: 'application/pdf', folderId: FOLDER_ID, limit: 10 });
    assert.deepEqual(found, { files: [{ id: PDF_ID, name: "O'Brien.pdf", size: 12 }], capped: false, incomplete: false });
    const { params, path } = fetch.calls[0];
    assert.equal(path, '/drive/v3/files');
    assert.equal(params.get('q'), `trashed = false and name contains 'O\\'Brien \\\\ notes' and mimeType = 'application/pdf' and '${FOLDER_ID}' in parents`);
    assert.equal(params.get('supportsAllDrives'), 'true');
    assert.equal(params.get('includeItemsFromAllDrives'), 'true');
    assert.equal(params.get('corpora'), 'allDrives');
    assert.equal(params.get('orderBy'), 'modifiedTime desc');
    assert.equal(params.get('pageSize'), '10');
    assert.match(params.get('fields'), /^nextPageToken,incompleteSearch,files\(id,name,mimeType,size,modifiedTime,owners\(displayName,emailAddress\),parents,driveId,webViewLink/);
    assert.equal(params.has('driveId'), false);
  });

  test('find by content leaves the order to relevance; shared-with-me and one shared drive pick their corpus', async () => {
    const fetch = fakeFetch(() => json({ files: [] }));
    const drive = client(fetch);
    await drive.find({ query: 'budget 2026' });
    assert.equal(fetch.calls[0].params.get('q'), "trashed = false and fullText contains 'budget 2026'");
    assert.equal(fetch.calls[0].params.has('orderBy'), false);
    await drive.find({ sharedWithMe: true });
    assert.equal(fetch.calls[1].params.get('q'), 'trashed = false and sharedWithMe = true');
    assert.equal(fetch.calls[1].params.get('corpora'), 'user');
    await drive.find({ driveId: DRIVE_ID });
    assert.equal(fetch.calls[2].params.get('corpora'), 'drive');
    assert.equal(fetch.calls[2].params.get('driveId'), DRIVE_ID);
  });

  test('find follows pages up to its limit and says when there were more', async () => {
    const pages = [
      { files: [{ id: 'a'.repeat(20) }, { id: 'b'.repeat(20) }], nextPageToken: 'p2' },
      { files: [{ id: 'c'.repeat(20) }], nextPageToken: 'p3', incompleteSearch: true },
    ];
    const fetch = fakeFetch(() => json(pages.shift()));
    const found = await client(fetch).find({ limit: 3 });
    assert.equal(found.files.length, 3);
    assert.equal(found.capped, true);
    assert.equal(found.incomplete, true);
    assert.equal(fetch.calls[1].params.get('pageToken'), 'p2');
    assert.equal(fetch.calls[1].params.get('pageSize'), '1');
  });

  test('getMeta asks for the fields callers need, with the size as a number', async () => {
    const fetch = fakeFetch(() => json(META[PDF_ID]));
    const meta = await client(fetch).getMeta(PDF_ID);
    assert.equal(meta.size, 5);
    assert.equal(fetch.calls[0].path, `/drive/v3/files/${PDF_ID}`);
    assert.equal(fetch.calls[0].params.get('supportsAllDrives'), 'true');
    assert.match(fetch.calls[0].params.get('fields'), /capabilities\(canDownload,canEdit,canAddChildren,canDelete,canTrash,canCopy\)/);
  });

  test('an id that is not one is refused before any request', async () => {
    const fetch = fakeFetch();
    await assert.rejects(client(fetch).getMeta('../files'), (err) => err.kind === 'bad_request');
    assert.equal(fetch.calls.length, 0);
  });
});

describe('download and export', () => {
  const driveFor = (meta, media = Buffer.from('%PDF-')) => fakeFetch((call) => {
    if (call.params.get('alt') === 'media') return new Response(media, { status: 200 });
    const id = call.path.split('/').pop();
    return meta[id] ? json(meta[id]) : googleError(404, 'notFound', `File not found: ${id}.`);
  });

  test('a binary file comes down as bytes', async () => {
    const fetch = driveFor(META);
    const got = await client(fetch).download(PDF_ID);
    assert.equal(got.bytes.toString(), '%PDF-');
    assert.equal(got.name, 'report.pdf');
    assert.equal(got.mimeType, 'application/pdf');
    assert.equal(fetch.calls[1].url, `${API}/files/${PDF_ID}?supportsAllDrives=true&alt=media`);
  });

  test('a Google Doc is refused with the formats to export it to, and nothing is downloaded', async () => {
    const fetch = driveFor(META);
    await assert.rejects(client(fetch).download(DOC_ID), (err) => err.kind === 'google_native'
      && err.message.includes(`drive-export ${DOC_ID} --format docx|pdf|md|txt`));
    assert.equal(fetch.calls.length, 1);
  });

  test('a shortcut is followed to its target', async () => {
    const shortcutId = '1ShortcutAbCdEfGhIjKlMnOpQrStUvW';
    const meta = { ...META, [shortcutId]: { id: shortcutId, name: 'link', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: PDF_ID } } };
    const got = await client(driveFor(meta)).download(shortcutId);
    assert.equal(got.name, 'report.pdf');
  });

  test('downloads the owner blocked, and files over the cap, are refused before the transfer', async () => {
    const blocked = { [PDF_ID]: { ...META[PDF_ID], capabilities: { canDownload: false } } };
    const fetch = driveFor(blocked);
    await assert.rejects(client(fetch).download(PDF_ID), (err) => err.kind === 'download_blocked' && /turned off downloading/.test(err.message));
    const big = driveFor(META);
    await assert.rejects(client(big).download(PDF_ID, { maxBytes: 4 }), (err) => err.kind === 'too_large');
    assert.equal(fetch.calls.length + big.calls.length, 2, 'only the metadata was read');
  });

  test('export asks for the format, without the all-drives flag files.export does not take', async () => {
    const fetch = fakeFetch(() => new Response('# Plan\n', { status: 200 }));
    const bytes = await client(fetch).export(DOC_ID, 'text/markdown');
    assert.equal(bytes.toString(), '# Plan\n');
    assert.equal(fetch.calls[0].url, `${API}/files/${DOC_ID}/export?mimeType=text%2Fmarkdown`);
  });

  test("Google's 10 MB export limit is named on failure", async () => {
    const fetch = fakeFetch(() => googleError(403, 'exportSizeLimitExceeded', 'This file is too large to be exported.'));
    await assert.rejects(client(fetch).export(DOC_ID, 'application/pdf'), (err) => err.kind === 'export_too_large'
      && /at most 10 MB/.test(err.message) && /\(Google: This file is too large to be exported\.\)$/.test(err.message));
  });

  test('the export formats are the documented ones', () => {
    assert.deepEqual(Object.keys(EXPORT_FORMATS[GOOGLE_TYPES.document]), ['docx', 'pdf', 'md', 'txt']);
    assert.deepEqual(Object.keys(EXPORT_FORMATS[GOOGLE_TYPES.spreadsheet]), ['xlsx', 'csv', 'pdf']);
    assert.deepEqual(Object.keys(EXPORT_FORMATS[GOOGLE_TYPES.presentation]), ['pptx', 'pdf', 'txt']);
    assert.equal(exportMimeType(GOOGLE_TYPES.document, 'MD'), 'text/markdown');
    assert.equal(exportMimeType(GOOGLE_TYPES.spreadsheet, 'docx'), null);
    assert.equal(exportMimeType('application/pdf', 'pdf'), null);
  });
});

/** The parts of a multipart/related body: [{ headers, body }]. */
function multipartParts(call) {
  const boundary = /boundary=(\S+)/.exec(call.headers['Content-Type'])[1];
  const text = Buffer.from(call.body).toString('latin1');
  assert.ok(text.endsWith(`\r\n--${boundary}--\r\n`), 'the body closes with the boundary');
  return text.split(`--${boundary}`).slice(1, -1).map((chunk) => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    return { head, body: rest.join('\r\n\r\n').replace(/\r\n$/, '') };
  });
}

describe('writing', () => {
  const created = (call) => json({ id: '1NewFileAbCdEfGhIjKlMnOpQrStUvWx', name: 'x', webViewLink: 'https://drive.google.com/file/d/1NewFileAbCdEfGhIjKlMnOpQrStUvWx/view', size: '3' }, 200);

  test('create sends one multipart request: the metadata, then the bytes', async () => {
    const fetch = fakeFetch(created);
    const file = await client(fetch).create({ name: 'notes.md', parentId: FOLDER_ID, mimeType: 'text/markdown', bytes: Buffer.from('# Hi') });
    assert.equal(file.id, '1NewFileAbCdEfGhIjKlMnOpQrStUvWx');
    const call = fetch.calls[0];
    assert.equal(call.method, 'POST');
    assert.match(call.url, new RegExp(`^${UPLOAD.replace(/\./g, '\\.')}/files\\?supportsAllDrives=true&uploadType=multipart&fields=`));
    assert.match(call.headers['Content-Type'], /^multipart\/related; boundary=paraclete-[0-9a-f]{24}$/);
    const [meta, media] = multipartParts(call);
    assert.equal(meta.head, 'Content-Type: application/json; charset=UTF-8');
    assert.deepEqual(JSON.parse(meta.body), { name: 'notes.md', parents: [FOLDER_ID] });
    assert.equal(media.head, 'Content-Type: text/markdown');
    assert.equal(media.body, '# Hi');
  });

  test('convertTo asks Drive for a Google-native file', async () => {
    const fetch = fakeFetch(created);
    await client(fetch).create({ name: 'Budget', parentId: FOLDER_ID, mimeType: 'text/csv', bytes: 'a,b\n', convertTo: 'sheet' });
    assert.deepEqual(JSON.parse(multipartParts(fetch.calls[0])[0].body), { name: 'Budget', parents: [FOLDER_ID], mimeType: GOOGLE_TYPES.spreadsheet });
    await assert.rejects(client(fetch).create({ name: 'x', mimeType: 'text/plain', bytes: 'x', convertTo: 'pdf' }), /convertTo must be one of doc, sheet, slides/);
  });

  test('a file over 5 MB goes up in a resumable session on the same host', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
    const session = `${UPLOAD}/files?uploadType=resumable&upload_id=abc`;
    const fetch = fakeFetch((call) => (call.method === 'POST' ? new Response(null, { status: 200, headers: { location: session } }) : created(call)));
    await client(fetch).create({ name: 'big.pdf', parentId: FOLDER_ID, mimeType: 'application/pdf', bytes: big });
    const [start, put] = fetch.calls;
    assert.equal(start.params.get('uploadType'), 'resumable');
    assert.equal(start.params.get('supportsAllDrives'), 'true');
    assert.equal(start.headers['X-Upload-Content-Type'], 'application/pdf');
    assert.equal(start.headers['X-Upload-Content-Length'], String(big.length));
    assert.deepEqual(JSON.parse(start.body), { name: 'big.pdf', parents: [FOLDER_ID] });
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, session);
    assert.equal(put.body.length, big.length);

    const elsewhere = fakeFetch(() => new Response(null, { status: 200, headers: { location: 'https://upload.example.com/x' } }));
    await assert.rejects(client(elsewhere).create({ name: 'big.pdf', mimeType: 'application/pdf', bytes: big }), (err) => err.kind === 'unavailable');
    assert.equal(elsewhere.calls.length, 1, 'the bytes never go to another host');
  });

  test('the client adds files and never changes one: no update, move, rename, copy or delete', () => {
    const drive = client(fakeFetch());
    for (const verb of ['update', 'move', 'rename', 'copy', 'delete', 'trash']) assert.equal(drive[verb], undefined, verb);
  });

  test('shared drives are listed page by page with what membership allows, without the all-drives flag drives.list does not take', async () => {
    const pages = [
      { drives: [{ id: DRIVE_ID, name: 'Team', kind: 'drive#drive', capabilities: { canAddChildren: true, canTrashChildren: true, canDeleteChildren: false } }], nextPageToken: 'n' },
      { drives: [{ id: '0BAnotherSharedDrv9PVA', name: 'Ops' }] },
    ];
    const fetch = fakeFetch(() => json(pages.shift()));
    assert.deepEqual(await client(fetch).listSharedDrives(), [
      { id: DRIVE_ID, name: 'Team', canAddChildren: true, canTrashChildren: true, canDeleteChildren: false },
      { id: '0BAnotherSharedDrv9PVA', name: 'Ops', canAddChildren: false, canTrashChildren: false, canDeleteChildren: false },
    ]);
    assert.equal(fetch.calls[0].url, `${API}/drives?pageSize=100&fields=nextPageToken%2Cdrives%28id%2Cname%2Ccapabilities%28canAddChildren%2CcanTrashChildren%2CcanDeleteChildren%29%29`);
    assert.equal(fetch.calls[1].params.get('pageToken'), 'n');
  });

  test('remove moves the file to the trash, which a Content manager in a shared drive may do, rather than deleting it', async () => {
    const fetch = fakeFetch(() => json({ id: PDF_ID, trashed: true }));
    await client(fetch).remove(PDF_ID);
    const call = fetch.calls[0];
    assert.equal(call.method, 'PATCH');
    assert.equal(call.url, `${API}/files/${PDF_ID}?supportsAllDrives=true&fields=id%2Ctrashed`);
    assert.deepEqual(JSON.parse(call.body), { trashed: true });
    assert.equal(call.headers['Content-Type'], 'application/json; charset=UTF-8');
  });
});

describe("Google's errors, in plain words", () => {
  const fails = (response) => fakeFetch(() => response);

  test('not found names the identity to share with, and keeps Google\'s message', async () => {
    await assert.rejects(client(fails(googleError(404, 'notFound', `File not found: ${PDF_ID}.`))).getMeta(PDF_ID), (err) => err.kind === 'not_found'
      && err.status === 404 && err.reason === 'notFound'
      && err.message === `Drive has no file ${PDF_ID} that ${SA_EMAIL} can see: it does not exist, or it is not shared with ${SA_EMAIL}. Ask its owner to share it with ${SA_EMAIL}. (Google: File not found: ${PDF_ID}.)`);
  });

  test('missing permission to write asks for Editor access', async () => {
    const response = googleError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
    await assert.rejects(client(fails(response)).create({ name: 'a.txt', parentId: FOLDER_ID, mimeType: 'text/plain', bytes: 'a' }), (err) => err.kind === 'permission'
      && err.message.startsWith(`${SA_EMAIL} is not allowed to create a file in folder ${FOLDER_ID}: it needs Editor access (Content manager in a shared drive).`));
    await assert.rejects(client(fails(response)).getMeta(PDF_ID), (err) => err.kind === 'permission'
      && err.message.startsWith(`${SA_EMAIL} is not allowed to read file ${PDF_ID}. Ask its owner to share it with ${SA_EMAIL}.`));
  });

  test('a service account creating outside a shared drive is told why and where to create instead', async () => {
    const response = googleError(403, 'storageQuotaExceeded', 'Service Accounts do not have storage quota.');
    await assert.rejects(client(fails(response)).create({ name: 'a.txt', parentId: FOLDER_ID, mimeType: 'text/plain', bytes: 'a' }), (err) => err.kind === 'storage_quota'
      && /is a service account and has no Drive storage of its own/.test(err.message)
      && /inside a shared drive that paraclete-agent@your-gcp-project\.iam\.gserviceaccount\.com is a member of/.test(err.message));
    const workspace = createDriveClient({ instance: WORKSPACE_INSTANCE, fetch: fails(googleError(403, 'storageQuotaExceeded', 'quota')), getDwdToken: async () => 't' });
    await assert.rejects(workspace.create({ name: 'a.txt', mimeType: 'text/plain', bytes: 'a' }), (err) => /The Drive storage of agent@example\.com is full/.test(err.message));
  });

  test('downloads the owner turned off, domain policy, the API off and a missing scope each say what to do', async () => {
    const cases = [
      [googleError(403, 'cannotDownloadFile', 'Only the owner can download.'), 'download_blocked', /turned off downloading/],
      [googleError(403, 'domainPolicy', 'The domain administrators have disabled Drive apps.'), 'domain_policy', /organization's Drive policy/],
      [json({ error: { code: 403, message: 'Google Drive API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }], details: [{ reason: 'SERVICE_DISABLED' }] } }, 403), 'api_disabled', /Drive API is turned off/],
      [json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }], details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 403), 'scope', /lacks the Drive scope.*re-run the installer/],
      [googleError(429, 'rateLimitExceeded', 'Rate Limit Exceeded'), 'rate_limit', /Wait a minute/],
      [googleError(401, 'authError', 'Invalid Credentials'), 'auth', /refused the credentials/],
      [new Response('<html>oops</html>', { status: 502 }), 'unavailable', /HTTP 502/],
    ];
    for (const [response, kind, pattern] of cases) {
      await assert.rejects(client(fails(response)).getMeta(PDF_ID), (err) => err.kind === kind && pattern.test(err.message), kind);
    }
  });

  test('a network failure is a plain error, not a stack', async () => {
    const fetch = async () => { throw new Error('getaddrinfo ENOTFOUND www.googleapis.com'); };
    await assert.rejects(client(fetch).about(), (err) => err.kind === 'unavailable' && /Drive could not be reached: getaddrinfo ENOTFOUND/.test(err.message));
  });
});

describe('Drive links', () => {
  test('reads the id from every kind of link, and a bare id', () => {
    const cases = {
      [`https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`]: DOC_ID,
      [`https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=0`]: DOC_ID,
      [`https://docs.google.com/presentation/u/1/d/${DOC_ID}/view`]: DOC_ID,
      [`https://drive.google.com/file/d/${PDF_ID}/view?usp=drive_link`]: PDF_ID,
      [`https://drive.google.com/open?id=${PDF_ID}`]: PDF_ID,
      [`https://drive.google.com/uc?export=download&id=${PDF_ID}`]: PDF_ID,
      [`https://drive.google.com/drive/folders/${FOLDER_ID}`]: FOLDER_ID,
      [`https://drive.google.com/drive/u/0/folders/${DRIVE_ID}?resourcekey=x`]: DRIVE_ID,
      [`Please read (https://docs.google.com/document/d/${DOC_ID}/edit) today`]: DOC_ID,
      [`  ${PDF_ID}  `]: PDF_ID,
    };
    for (const [text, id] of Object.entries(cases)) assert.equal(parseDriveLink(text), id, text);
  });

  test('anything else is null', () => {
    for (const text of ['', null, 'report', 'quarterly report', 'https://example.com/d/1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123',
      'https://docs.google.com/document/d/e/2PACX-1vTabcdefghijklmnop/pub', 'https://drive.google.com/drive/my-drive', '../../etc/passwd']) {
      assert.equal(parseDriveLink(text), null, String(text));
    }
  });
});

test('query values escape backslashes before quotes', () => {
  assert.equal(escapeQueryValue("a\\'b"), "a\\\\\\'b");
  assert.equal(escapeQueryValue("it's"), "it\\'s");
});

test('uploads map to the Google-native type they can become, and types read plainly', () => {
  assert.equal(conversionFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'doc');
  assert.equal(conversionFor('text/markdown'), 'doc');
  assert.equal(conversionFor('text/csv; charset=utf-8'), 'sheet');
  assert.equal(conversionFor('application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'slides');
  assert.equal(conversionFor('application/pdf'), null);
  assert.equal(describeType(GOOGLE_TYPES.spreadsheet), 'Google Sheet');
  assert.equal(describeType('application/pdf'), 'application/pdf');
  assert.equal(isGoogleNative(GOOGLE_TYPES.presentation), true);
  assert.equal(isGoogleNative('application/pdf'), false);
});
