// Tests for shared mission-inbox and credential-path helpers in skills/drive/: drive-get re-exports
// missionInbox from agent/files/mission-paths.mjs, drive-get and drive-export save mission files to
// that inbox, and drive-put uses isCredentialPath from agent/storage/file-store.mjs to refuse
// credential paths (including .ssh/, .git-credentials, .netrc and gateway-token).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { missionInbox, missionTree } from '../../../agent/files/mission-paths.mjs';
import { isCredentialPath } from '../../../agent/storage/file-store.mjs';
import * as driveGet from '../../../skills/drive/drive-get.mjs';
import * as driveExport from '../../../skills/drive/drive-export.mjs';
import * as drivePut from '../../../skills/drive/drive-put.mjs';
import { fakeDriveFetch, driveRuntime, run } from './fakes.mjs';

const PDF_ID = '1PdfAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const DOC_ID = '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const PDF = Buffer.from('%PDF-1.7 fake');
const FILES = {
  [PDF_ID]: { id: PDF_ID, name: 'report.pdf', mimeType: 'application/pdf', size: String(PDF.length) },
  [DOC_ID]: { id: DOC_ID, name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
};

test('drive-get re-exports missionInbox from agent/files/mission-paths.mjs', () => {
  assert.equal(driveGet.missionInbox, missionInbox);
});

test('drive-get and drive-export save mission files into the missionInbox from agent/files/mission-paths.mjs', async () => {
  const api = fakeDriveFetch({ files: FILES, media: { [PDF_ID]: PDF }, exports: { [DOC_ID]: '# Plan' } });
  const runtime = driveRuntime({ api });
  const inbox = missionInbox(runtime.paths.data.missions, 'w-shared');

  const got = await run(driveGet, [PDF_ID, '--mission', 'w-shared'], { runtime });
  assert.equal(got.code, 0, got.err);
  assert.deepEqual(readFileSync(join(inbox, 'report.pdf')), PDF);

  const exported = await run(driveExport, [DOC_ID, '--format', 'md', '--mission', 'w-shared'], { runtime });
  assert.equal(exported.code, 0, exported.err);
  assert.equal(readFileSync(join(inbox, 'Plan.md'), 'utf8'), '# Plan');
});

test('drive-put refuses credential paths matched by isCredentialPath before any upload', async () => {
  const api = fakeDriveFetch();
  const runtime = driveRuntime({ api, settings: { drive_output_folder: '1OutputFolderAbCdEfGhIjKlMnOpQrSt' } });
  const tree = missionTree(runtime.paths.data.missions, 'w-cred');

  for (const rel of [
    '.ssh/id_ed25519',
    '.git-credentials',
    '.netrc',
    'gateway-token',
    '.gateway-token',
    'keys/service.json',
    'svc-key.json',
    'tls.key',
    'cert.pem',
    '.env.production',
    'oauth-credentials.json',
  ]) {
    const file = join(tree, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'secret');
    assert.equal(isCredentialPath(file), true, rel);
    assert.throws(
      () => drivePut.localFile(rel, { mission: 'w-cred', paths: runtime.paths, maxBytes: 1024 * 1024 }),
      /holds credentials, which never leave the VM/,
      rel,
    );
    const r = await run(drivePut, ['--mission', 'w-cred', rel], { runtime });
    assert.equal(r.code, 1, rel);
    assert.match(r.err, /holds credentials, which never leave the VM/, rel);
  }
  assert.equal(api.calls.length, 0);
});
