// Tests for skills/files/file-get.mjs: arguments, the mission's inbox as the destination, the printed
// record, and a private repository's token read from Secret Manager and handed only to git. Network
// calls go to a fake fetch, git to a fake runner, Drive to a fake client.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadContracts } from '../../../config/contracts.mjs';
import * as fileGet from '../../../skills/files/file-get.mjs';
import { fakeRunner, PDF_BYTES, runCommand, scratch } from '../../agent/files/helpers.mjs';

const dir = scratch('file-get-test-');
after(() => dir.cleanup());
const contracts = loadContracts();
const missions = dir.dir('missions');
dir.dir('missions/w-1');

function runtime(fetch) {
  return {
    contracts,
    instance: { project: 'your-gcp-project', bucket: 'your-gcp-project-paraclete', endpoints: {} },
    paths: { data: { missions } },
    getAccessToken: async () => 'tok',
    fetch,
    storageHost: 'https://storage.example.com',
  };
}

test('--help; a missing mission, source or bad option exits 2', async () => {
  assert.match((await runCommand(fileGet, ['--help'])).out, /^Usage: file-get --mission <mission id> <source>/);
  const cases = [
    [['https://example.com/a.pdf'], /--mission <mission id> is required/],
    [['--mission', '../x', 'https://example.com/a.pdf'], /not a mission id/],
    [['--mission', 'w-1'], /the source to fetch is required/],
    [['--mission', 'w-1', 'a', 'b'], /one source at a time/],
    [['--mission', 'w-1', 'a', '--kind', 'ftp'], /--kind must be one of upload, gcs, http, git, drive/],
    [['--mission', 'w-1', 'a', '--token-secret', 'bad/name'], /not a secret id/],
  ];
  for (const [argv, message] of cases) {
    const { code, err } = await runCommand(fileGet, argv, { runtime: runtime(), runner: fakeRunner(), drive: {} });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, message);
  }
  const unknown = await runCommand(fileGet, ['--mission', 'w-9', 'https://example.com/a.pdf'], { runtime: runtime(), runner: fakeRunner(), drive: {} });
  assert.deepEqual([unknown.code, /there is no running mission 'w-9'/.test(unknown.err)], [2, true]);
});

test('a link lands in the mission\'s inbox and the record is printed as JSON', async () => {
  const fetch = async () => new Response(PDF_BYTES, { status: 200, headers: { 'content-disposition': 'attachment; filename="Board pack.pdf"' } });
  const { code, out, err } = await runCommand(fileGet, ['--mission', 'w-1', 'https://example.com/dl?id=4'], { runtime: runtime(fetch), runner: fakeRunner(), drive: {} });
  assert.equal(code, 0, err);
  const record = JSON.parse(out);
  assert.equal(record.path, join(missions, 'w-1', 'missions', 'w-1', 'inbox', 'Board pack.pdf'));
  assert.deepEqual([record.name, record.type, record.size, record.source], ['Board pack.pdf', 'pdf', PDF_BYTES.length, 'https://example.com/dl?id=4']);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);

  const failed = await runCommand(fileGet, ['--mission', 'w-1', 'https://example.com/x'], { runtime: runtime(async () => new Response('', { status: 403 })), runner: fakeRunner(), drive: {} });
  assert.deepEqual([failed.code, failed.err], [1, 'file-get: HTTP 403 for https://example.com/x\n']);
});

test('a private repository: the token comes from Secret Manager and goes only to git\'s environment', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    return new Response(JSON.stringify({ payload: { data: Buffer.from('ghp-token\n').toString('base64') } }), { status: 200 });
  };
  const runner = fakeRunner({ git: (args) => (args[0] === 'rev-parse' || args[2] === 'rev-parse' ? { stdout: 'f00d\n' } : {}) });
  const { code, out } = await runCommand(fileGet, ['--mission', 'w-1', 'https://example.com/team/tools.git', '--token-secret', 'git-token'], { runtime: runtime(fetch), runner, drive: {} });
  assert.equal(code, 0);
  assert.equal(seen[0].url, 'https://secretmanager.googleapis.com/v1/projects/your-gcp-project/secrets/git-token/versions/latest:access');
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.equal(runner.calls[0].opts.env.PARACLETE_GIT_TOKEN, 'ghp-token');
  assert.ok(!out.includes('ghp-token'), 'the token never reaches the record');
  assert.deepEqual([JSON.parse(out).type, JSON.parse(out).commit], ['git-repo', 'f00d']);

  const denied = await runCommand(fileGet, ['--mission', 'w-1', 'https://example.com/team/tools.git', '--token-secret', 'git-token'], {
    runtime: runtime(async () => new Response('', { status: 403 })), runner, drive: {},
  });
  assert.deepEqual([denied.code, /access denied to secret 'git-token'/.test(denied.err)], [1, true]);
});

test('a Drive link goes to the Drive client, and a Google file is exported', async () => {
  const drive = {
    getMeta: async (id) => ({ id, name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' }),
    export: async () => Buffer.from('PK\u0003\u0004'),
  };
  const { code, out } = await runCommand(fileGet, ['--mission', 'w-1', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv/edit', '--export', 'csv'], { runtime: runtime(), runner: fakeRunner(), drive });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).name, 'Budget.csv');
});
