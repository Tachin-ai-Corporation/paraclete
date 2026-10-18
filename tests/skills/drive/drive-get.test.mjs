// Tests for skills/drive/drive-get.mjs: a stored Drive file comes down into the mission's inbox (or a
// path), under its own name made safe, with its size and sha256; Google files are refused with the
// export route; the download cap comes from the contracts; bad arguments are refused before Drive is
// asked. Drive is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as driveGet from '../../../skills/drive/drive-get.mjs';
import { fakeDriveFetch, driveRuntime, run, SA_EMAIL } from './fakes.mjs';

const PDF_ID = '1PdfAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const DOC_ID = '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const PDF = Buffer.from('%PDF-1.7 fake');
const FILES = {
  [PDF_ID]: { id: PDF_ID, name: 'Q3 report.pdf', mimeType: 'application/pdf', size: String(PDF.length), webViewLink: `https://drive.google.com/file/d/${PDF_ID}/view`, capabilities: { canDownload: true } },
  [DOC_ID]: { id: DOC_ID, name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
};

const inbox = (runtime, mission) => join(runtime.instance.data_root, 'missions', mission, 'missions', mission, 'inbox');

test('--help prints the usage', async () => {
  const r = await run(driveGet, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: drive-get /);
});

test("a file lands in the mission's inbox with its size and sha256, from a Drive link", async () => {
  const api = fakeDriveFetch({ files: FILES, media: { [PDF_ID]: PDF } });
  const runtime = driveRuntime({ api });
  const r = await run(driveGet, [`https://drive.google.com/file/d/${PDF_ID}/view?usp=sharing`, '--mission', 'w-123'], { runtime });
  assert.equal(r.code, 0, r.err);
  const path = join(inbox(runtime, 'w-123'), 'Q3 report.pdf');
  assert.deepEqual(readFileSync(path), PDF);
  const sha = createHash('sha256').update(PDF).digest('hex');
  assert.equal(r.out, [
    `Saved ${path}`,
    `Q3 report.pdf | application/pdf | ${PDF.length} bytes | sha256 ${sha}`,
    `From Drive: ${PDF_ID} https://drive.google.com/file/d/${PDF_ID}/view`,
    `Read it with: file-read ${path}`,
    '',
  ].join('\n'));
  assert.equal(api.calls[0].headers.Authorization, 'Bearer vm-token');
  assert.equal(api.calls[1].params.get('alt'), 'media');

  const again = await run(driveGet, [PDF_ID, '--mission', 'w-123', '--json'], { runtime });
  const report = JSON.parse(again.out);
  assert.equal(report.replaced, true);
  assert.deepEqual(report.drive, { id: PDF_ID, link: `https://drive.google.com/file/d/${PDF_ID}/view` });
  assert.equal(report.sha256, sha);
});

test('a Drive name cannot place the file outside the inbox', async () => {
  const files = { [PDF_ID]: { ...FILES[PDF_ID], name: '../../../escape.pdf' } };
  const runtime = driveRuntime({ api: fakeDriveFetch({ files, media: { [PDF_ID]: PDF } }) });
  const r = await run(driveGet, [PDF_ID, '--mission', 'w-1'], { runtime });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(inbox(runtime, 'w-1'), 'escape.pdf')));
});

test('--out saves to a path, or into a directory under the file name', async () => {
  const runtime = driveRuntime({ api: fakeDriveFetch({ files: FILES, media: { [PDF_ID]: PDF } }) });
  const cwd = runtime.instance.data_root;
  assert.equal((await run(driveGet, [PDF_ID, '--out', 'work/in.pdf'], { runtime, cwd })).code, 0);
  assert.deepEqual(readFileSync(join(cwd, 'work', 'in.pdf')), PDF);
  assert.equal((await run(driveGet, [PDF_ID, '--out', 'dir/'], { runtime, cwd })).code, 0);
  assert.ok(existsSync(join(cwd, 'dir', 'Q3 report.pdf')));
});

test('a Google Doc is refused with the drive-export command, and nothing is saved', async () => {
  const runtime = driveRuntime({ api: fakeDriveFetch({ files: FILES }) });
  const r = await run(driveGet, [DOC_ID, '--mission', 'w-1'], { runtime });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`^drive-get: "Plan" \\(${DOC_ID}\\) is a Google Doc: .*drive-export ${DOC_ID} --format docx\\|pdf\\|md\\|txt`));
  assert.equal(existsSync(inbox(runtime, 'w-1')), false);
});

test("a file over the contracts' download cap is refused before the transfer", async () => {
  const api = fakeDriveFetch({ files: FILES, media: { [PDF_ID]: PDF } });
  const runtime = driveRuntime({ api, files: { fetch_max_mb: 1 / 1048576 } });
  const r = await run(driveGet, [PDF_ID, '--mission', 'w-1'], { runtime });
  assert.equal(r.code, 1);
  assert.match(r.err, /more than the 0 MB a download may be/);
  assert.equal(api.calls.length, 1);
});

test('a file that is not shared says so, with the address to share with', async () => {
  const runtime = driveRuntime({ api: fakeDriveFetch() });
  const r = await run(driveGet, [PDF_ID, '--mission', 'w-1'], { runtime });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`not shared with ${SA_EMAIL.replace(/\./g, '\\.')}\\. Ask its owner to share it`));
});

test('bad arguments are usage errors, and Drive is never asked', async () => {
  const api = fakeDriveFetch({ files: FILES });
  const runtime = driveRuntime({ api });
  for (const argv of [
    [], [PDF_ID], ['not a link', '--mission', 'w-1'], [PDF_ID, '--mission', 'w-1', '--out', 'x'],
    [PDF_ID, '--mission', '../w'], [PDF_ID, PDF_ID, '--mission', 'w-1'], [PDF_ID, '--mission', 'w-1', '--bogus'],
  ]) {
    const r = await run(driveGet, argv, { runtime });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, /Usage: drive-get/);
  }
  assert.equal(api.calls.length, 0);
});

test('missionInbox refuses an id that is not one path segment', () => {
  assert.equal(driveGet.missionInbox('/data/missions', 'w-1'), join('/data/missions', 'w-1', 'missions', 'w-1', 'inbox'));
  assert.throws(() => driveGet.missionInbox('/data/missions', '../x'), /not a mission id/);
});
