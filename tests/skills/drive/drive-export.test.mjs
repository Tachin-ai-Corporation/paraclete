// Tests for skills/drive/drive-export.mjs: a Google Doc, Sheet or Slides file is exported in a format
// its type has, into the mission's inbox as <name>.<format>; a format the type lacks, and a file that is
// not a Google file, are refused with the way forward; bad arguments are refused before Drive is
// asked. Drive is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as driveExport from '../../../skills/drive/drive-export.mjs';
import { fakeDriveFetch, driveRuntime, run } from './fakes.mjs';

const DOC_ID = '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const SHEET_ID = '1SheetAbCdEfGhIjKlMnOpQrStUvWxYz01';
const PDF_ID = '1PdfAbCdEfGhIjKlMnOpQrStUvWxYz0123';
const FILES = {
  [DOC_ID]: { id: DOC_ID, name: 'Plan', mimeType: 'application/vnd.google-apps.document', webViewLink: `https://docs.google.com/document/d/${DOC_ID}/edit` },
  [SHEET_ID]: { id: SHEET_ID, name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
  [PDF_ID]: { id: PDF_ID, name: 'scan.pdf', mimeType: 'application/pdf' },
};

const inbox = (runtime, mission) => join(runtime.instance.data_root, 'missions', mission, 'missions', mission, 'inbox');

test('--help prints the usage with every format', async () => {
  const r = await run(driveExport, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: drive-export <drive link or id> --format docx\|pdf\|md\|txt\|xlsx\|csv\|pptx /);
});

test('a Doc exports to Markdown in the inbox, named after the Doc', async () => {
  const api = fakeDriveFetch({ files: FILES, exports: { [DOC_ID]: '# Plan\n' } });
  const runtime = driveRuntime({ api });
  const r = await run(driveExport, [`https://docs.google.com/document/d/${DOC_ID}/edit`, '--format', 'md', '--mission', 'w-9'], { runtime });
  assert.equal(r.code, 0, r.err);
  const path = join(inbox(runtime, 'w-9'), 'Plan.md');
  assert.equal(readFileSync(path, 'utf8'), '# Plan\n');
  assert.match(r.out, new RegExp(`^Saved ${path.replace(/\\/g, '\\\\').replace(/\./g, '\\.')}\\nPlan\\.md \\| text/markdown \\| 7 bytes`));
  const exported = api.calls.find((c) => c.path.endsWith('/export'));
  assert.equal(exported.params.get('mimeType'), 'text/markdown');
});

test('a Sheet as CSV notes that only the first sheet comes', async () => {
  const runtime = driveRuntime({ api: fakeDriveFetch({ files: FILES, exports: { [SHEET_ID]: 'a,b\n1,2\n' } }) });
  const r = await run(driveExport, [SHEET_ID, '--format', 'csv', '--mission', 'w-9'], { runtime });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Note: a CSV export holds only the first sheet\. Export xlsx to get every sheet\./);
});

test("a format the file's type lacks is refused with the formats it has", async () => {
  const api = fakeDriveFetch({ files: FILES });
  const r = await run(driveExport, [SHEET_ID, '--format', 'docx', '--mission', 'w-9'], { runtime: driveRuntime({ api }) });
  assert.equal(r.code, 1);
  assert.equal(r.err, `drive-export: "Budget" (${SHEET_ID}) is a Google Sheet, which exports to xlsx, csv, pdf, not docx\n`);
  assert.equal(api.calls.some((c) => c.path.endsWith('/export')), false);
});

test('a file whose owner turned off downloads is refused before the export', async () => {
  const files = { [DOC_ID]: { ...FILES[DOC_ID], capabilities: { canDownload: false } } };
  const api = fakeDriveFetch({ files, exports: { [DOC_ID]: 'x' } });
  const r = await run(driveExport, [DOC_ID, '--format', 'pdf', '--mission', 'w-9'], { runtime: driveRuntime({ api }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /has turned off downloading.*cannot export it/);
  assert.equal(api.calls.some((c) => c.path.endsWith('/export')), false);
});

test('a stored file is refused with the drive-get route', async () => {
  const r = await run(driveExport, [PDF_ID, '--format', 'pdf', '--mission', 'w-9'], { runtime: driveRuntime({ api: fakeDriveFetch({ files: FILES }) }) });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`is a application/pdf file, not a Google Doc, Sheet or Slides: download it as it is with drive-get ${PDF_ID}`));
});

test('bad arguments are usage errors, and Drive is never asked', async () => {
  const api = fakeDriveFetch({ files: FILES });
  for (const argv of [[DOC_ID, '--mission', 'w-1'], [DOC_ID, '--format', 'odt', '--mission', 'w-1'], [DOC_ID, '--format', 'md'], ['--format', 'md', '--mission', 'w-1']]) {
    const r = await run(driveExport, argv, { runtime: driveRuntime({ api }) });
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.equal(api.calls.length, 0);
});

test('exportName adds the extension once', () => {
  assert.equal(driveExport.exportName('Plan', 'docx'), 'Plan.docx');
  assert.equal(driveExport.exportName('notes.MD', 'md'), 'notes.MD');
  assert.equal(driveExport.exportName('', 'pdf'), 'export.pdf');
});
