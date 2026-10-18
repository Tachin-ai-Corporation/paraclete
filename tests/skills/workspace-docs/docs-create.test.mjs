// Tests for skills/workspace-docs/docs-create.mjs: a new Doc from inline Markdown or a Markdown file in
// the mission tree (checked as drive-put checks one), in a folder or the agent's My Drive with who can
// open it said plainly, and the files it refuses: Office files, credentials, empty content.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as docsCreate from '../../../skills/workspace-docs/docs-create.mjs';
import { createDocsClient } from '../../../agent/providers/workspace-docs.mjs';
import { GOOGLE_TYPES } from '../../../agent/providers/drive.mjs';
import { INSTANCE, json, fakeTokens, fakeGoogle, run } from '../../agent/providers/workspace-fakes.mjs';
import { driveRuntime, WORKSPACE } from '../drive/fakes.mjs';

const FOLDER = '1FolderAbcdefghijklmnopq';
function google() {
  return fakeGoogle([['POST', '/upload/drive/v3/files', () => json({ id: '1NewDocAbcdefghijklmnop', name: 'Notes', webViewLink: 'https://docs.google.com/document/d/1NewDocAbcdefghijklmnop/edit' })]]);
}
const docsFor = (g) => createDocsClient({ instance: INSTANCE, fetch: g.fetch, getDwdToken: fakeTokens() });

function missionFile(runtime, name, content) {
  const dir = join(runtime.paths.data.missions, 'm-3');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

describe('docs-create', () => {
  test('from inline Markdown into My Drive, saying only the agent can open it', async () => {
    const g = google();
    const r = await run(docsCreate, ['--title', 'Notes', '--text', '# Notes\n\n- one'], { docs: docsFor(g), runtime: driveRuntime({ workspace: WORKSPACE }) });
    assert.equal(r.code, 0, r.err);
    const sent = g.calls[0].body.toString();
    assert.ok(sent.includes(JSON.stringify({ name: 'Notes', mimeType: GOOGLE_TYPES.document })));
    assert.ok(sent.includes('Content-Type: text/markdown\r\n\r\n# Notes\n\n- one'));
    assert.equal(r.out, [
      'Created the Google Doc "Notes"',
      'id: 1NewDocAbcdefghijklmnop',
      'link: https://docs.google.com/document/d/1NewDocAbcdefghijklmnop/edit',
      'In the My Drive of agent@example.com: only you can open it until it is shared. To hand it to a person, make it in a folder they can open (--folder), and deliver the content as a download too.',
      'Check it with docs-get before you hand it over.',
      '',
    ].join('\n'));
  });

  test('from a Markdown file in the mission tree, into a folder', async () => {
    const runtime = driveRuntime({ workspace: WORKSPACE });
    missionFile(runtime, 'report.md', '# Report\n\nBody');
    const g = google();
    const r = await run(docsCreate, ['--title', 'Report', '--from', 'report.md', '--mission', 'm-3', '--folder', `https://drive.google.com/drive/folders/${FOLDER}`, '--json'], { docs: docsFor(g), runtime });
    assert.equal(r.code, 0, r.err);
    assert.ok(g.calls[0].body.toString().includes(`"parents":["${FOLDER}"]`));
    assert.ok(g.calls[0].body.toString().includes('# Report\n\nBody'));
    assert.deepEqual(JSON.parse(r.out), { id: '1NewDocAbcdefghijklmnop', name: 'Notes', link: 'https://docs.google.com/document/d/1NewDocAbcdefghijklmnop/edit', folder_id: FOLDER, owner: 'agent@example.com' });
  });

  test('an Office file, a credential and empty content are refused, and nothing is uploaded', async () => {
    const runtime = driveRuntime({ workspace: WORKSPACE });
    missionFile(runtime, 'old.docx', 'PK');
    missionFile(runtime, 'credentials.json', '{}');
    missionFile(runtime, 'blank.md', '  \n');
    const g = google();
    const docx = await run(docsCreate, ['--title', 'x', '--from', 'old.docx', '--mission', 'm-3'], { docs: docsFor(g), runtime });
    assert.equal(docx.code, 1);
    assert.match(docx.err, /old\.docx is not Markdown or text .*drive-put --convert/);
    const secret = await run(docsCreate, ['--title', 'x', '--from', 'credentials.json', '--mission', 'm-3'], { docs: docsFor(g), runtime });
    assert.match(secret.err, /holds credentials, which never leave the VM/);
    assert.equal((await run(docsCreate, ['--title', 'x', '--from', 'blank.md', '--mission', 'm-3'], { docs: docsFor(g), runtime })).code, 2);
    assert.equal(g.calls.length, 0);
  });

  test('mistakes are refused before any call', async () => {
    for (const argv of [['--text', 'x'], ['--title', 'x'], ['--title', 'x', '--from', 'a.md'], ['--title', 'x', '--text', 'a', '--from', 'a.md', '--mission', 'm-1'], ['--title', 'x', '--text', 'a', '--folder', 'nope']]) {
      assert.equal((await run(docsCreate, argv, { docs: docsFor(google()) })).code, 2, argv.join(' '));
    }
    assert.equal((await run(docsCreate, ['--help'])).code, 0);
  });
});
