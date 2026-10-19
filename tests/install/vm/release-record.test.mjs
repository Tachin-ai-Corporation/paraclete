// Tests for the version install/vm/release-record.mjs writes into release.json: it is a version as
// agent/release/versions.mjs defines one, so the VM, the dashboard and dev/release.mjs agree on what
// counts. The ref is the version only when it is exactly one; otherwise it is the version the commit's
// message starts with, or null. The rest of release.json (its fields, the GitHub lookup, the command
// line) is tested in tests/install/bootstrap.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, releaseVersion } from '../../../install/vm/release-record.mjs';
import { versionFromText } from '../../../agent/release/versions.mjs';

const COMMIT = 'a'.repeat(40);

function sink() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, text: () => text };
}

test('a ref that is exactly a version is the version, and needs no commit message', () => {
  assert.equal(releaseVersion({ ref: 'v2026.10.18.9.4' }), 'v2026.10.18.9.4');
  assert.equal(releaseVersion({ ref: 'v2026.10.18.10.12', commitMessage: 'v2026.10.18.1.1: other' }), 'v2026.10.18.10.12', 'the tag wins');
});

test('a ref that only looks like a version is not one, and the commit message decides', () => {
  const message = 'v2026.10.18.9.4: the commit';
  for (const ref of ['v2026.13.01.1.1', 'v2026.10.18.9.4-rc', 'v2026.10.18.9.4.1', ' v2026.10.18.9.4', 'release-v2026.10.18.9.4', 'main', COMMIT]) {
    assert.equal(releaseVersion({ ref, commitMessage: message }), 'v2026.10.18.9.4', ref);
    assert.equal(releaseVersion({ ref, commitMessage: 'no version here' }), null, ref);
  }
});

test("the commit message's version is versions.mjs's, so a malformed one is no version", () => {
  const messages = [
    'v2026.10.18.9.4: phase 8 is checked live',
    'v2026.10.18.9.4',
    'v2026.10.18.9.4.7: one part too many',
    'v2026.00.18.9.4: no month 0',
    "Merge branch 'feature'",
    'fix v2026.10.18.9.4 later in the line',
    '',
  ];
  for (const commitMessage of messages) {
    assert.equal(releaseVersion({ ref: 'main', commitMessage }), versionFromText(commitMessage), commitMessage);
  }
  assert.equal(releaseVersion({ ref: 'main', commitMessage: 'v2026.10.18.9.4.7: one part too many' }), null);
  assert.equal(releaseVersion({ ref: 'main', commitMessage: null }), null);
  assert.equal(releaseVersion({ ref: undefined, commitMessage: undefined }), null);
});

test('the command line records the version, and null when neither the ref nor the message has one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'paraclete-release-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'release.json');
  const base = ['--repo=your-org/paraclete', `--commit=${COMMIT}`, '--metadata-repo=your-org/paraclete', `--metadata-ref=${COMMIT}`];
  const now = () => '2026-10-18T12:00:00.000Z';

  let lookups = 0;
  const unversioned = async () => { lookups += 1; return Response.json({ commit: { message: "Merge branch 'feature'" } }); };
  const errors = sink();
  assert.equal(await main([`--out=${out}`, '--ref=v2026.13.01.1.1', ...base], { fetch: unversioned, now, stdout: sink(), stderr: errors }), 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).version, null);
  assert.equal(lookups, 1, 'a ref that is not a version sends the lookup to the commit message');
  assert.match(errors.text(), /no version found for a{40}; recording null/);

  assert.equal(await main([`--out=${out}`, '--ref=v2026.10.18.9.4', ...base], { fetch: unversioned, now, stdout: sink(), stderr: sink() }), 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).version, 'v2026.10.18.9.4');
  assert.equal(lookups, 1, 'a release tag needs no lookup');
});
