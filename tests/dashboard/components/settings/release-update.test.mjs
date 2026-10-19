// Tests for dashboard/components/settings/release-update.js: how the version card reads. Release notes
// become plain lines; an upgrade's three steps; the card's badge and summary in each situation; what an
// admin is offered to install; and when the page waits for the new dashboard and reloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_LINES_SHOWN, cardStatus, installChoices, isNewDashboard, noteLines, runsText, shouldAwaitReload, showsFailure, upgradeSteps,
} from '../../../../dashboard/components/settings/release-update.js';

const V1 = 'v2027.01.10.1.1';
const V2 = 'v2027.01.15.2.1';
const V3 = 'v2027.01.20.1.1';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = Date.parse('2027-01-21T09:00:00.000Z');

const rel = (version) => ({ version, name: version, notes: '', url: null, published_at: null });
const releasesOf = (over = {}) => ({
  repo: 'your-org/paraclete',
  installed: {
    version: V1, source: 'agent', matched: true, repair: null,
    agent: { status: 'ready', release: V1, commit: A, version: V1 }, dashboard: { release: V1, commit: A, version: V1 },
  },
  checked_at: '2027-01-21T08:00:00.000Z',
  error: null,
  latest: rel(V3),
  newer: [rel(V3), rel(V2)],
  current: rel(V1),
  repair: null,
  ...over,
});
const upgradeOf = (state, over = {}) => ({
  id: 'u1', version: V2, commit: B, requested_by: 'admin@example.com', requested_at: '2027-01-21T08:50:00.000Z', state,
  running: ['vm', 'build', 'deploy'].includes(state), error: null, updated_at: '2027-01-21T08:58:00.000Z', vm: null, build: null, notice: null, ...over,
});

test('release notes become plain lines: headings, items and text, Markdown marks and HTML-free', () => {
  const { lines, more } = noteLines('## What changed\n\n- **Faster** uploads ([#12](https://example.com/12))\n* `config` checks\n1. First\n---\nPlain <b>text</b> stays text\n```js\n');
  assert.deepEqual(lines, [
    { kind: 'heading', text: 'What changed' },
    { kind: 'item', text: 'Faster uploads (#12)' },
    { kind: 'item', text: 'config checks' },
    { kind: 'item', text: 'First' },
    { kind: 'text', text: 'Plain <b>text</b> stays text' },
  ]);
  assert.equal(more, 0);
  const long = noteLines(Array.from({ length: 20 }, (_, i) => `- line ${i}`).join('\n'), NOTE_LINES_SHOWN);
  assert.equal(long.lines.length, NOTE_LINES_SHOWN);
  assert.equal(long.more, 20 - NOTE_LINES_SHOWN);
  assert.deepEqual(noteLines(null), { lines: [], more: 0 });
});

test('what a half runs: its release, its commit beside it, or the commit alone', () => {
  assert.equal(runsText({ release: V1, commit: A }), `${V1} (commit aaaaaaa)`);
  assert.equal(runsText({ release: A, commit: A }), A, 'a VM installed by commit names it once');
  assert.equal(runsText({ release: A, commit: A, version: V1 }), `${V1} (commit aaaaaaa)`, 'unless it reports its version');
  assert.equal(runsText({ release: null, commit: A }), 'commit aaaaaaa');
  assert.equal(runsText({ release: null, commit: null }), 'not recorded');
  assert.equal(runsText(null), '');
});

test("an upgrade's steps: the VM, the build, the rollout, each done, active or waiting", () => {
  const states = (upgrade) => upgradeSteps(upgrade).map((s) => s.state);
  assert.deepEqual(states(upgradeOf('vm')), ['active', 'waiting', 'waiting']);
  assert.deepEqual(states(upgradeOf('build')), ['done', 'active', 'waiting']);
  assert.deepEqual(states(upgradeOf('deploy')), ['done', 'done', 'active']);
  assert.deepEqual(states(upgradeOf('done')), ['done', 'done', 'done']);
  const vm = upgradeSteps(upgradeOf('vm', { vm: { status: 'pending' } }));
  assert.match(vm[0].label, /The agent moves to v2027\.01\.15\.2\.1/);
  assert.match(vm[0].detail, /control service to pick it up/);
  assert.equal(vm[1].detail, '', 'only the active step says what it is doing');
  assert.match(upgradeSteps(upgradeOf('build', { build: { status: 'WORKING' } }))[1].detail, /Cloud Build is building/);
});

test('the badge and summary: up to date, an update, half installed, failed, updating, not a release', () => {
  assert.deepEqual(cardStatus(releasesOf(), null), { level: 'info', label: 'update available', summary: `${V3} is available; this instance runs ${V1}.` });
  assert.equal(cardStatus(releasesOf({ newer: [], latest: rel(V1) }), null).label, 'up to date');
  assert.equal(cardStatus(releasesOf({ newer: [], latest: null, error: 'GitHub could not be reached' }), null).label, 'unknown');
  assert.equal(cardStatus(releasesOf(), upgradeOf('build')).label, 'updating');
  assert.equal(cardStatus(releasesOf(), upgradeOf('failed', { error: 'no' })).label, 'update failed');
  assert.equal(cardStatus(releasesOf({ newer: [rel(V3)] }), upgradeOf('failed')).label, 'update available', 'an old failure for a version no longer offered is not news');
  const half = releasesOf({
    repair: V2, newer: [rel(V3)],
    installed: { ...releasesOf().installed, version: V2, repair: V2, matched: false, agent: { status: 'ready', release: V2, commit: B, version: V2 } },
  });
  const status = cardStatus(half, upgradeOf('failed'));
  assert.equal(status.label, 'half installed');
  assert.match(status.summary, /The agent runs v2027\.01\.15\.2\.1, but this dashboard runs v2027\.01\.10\.1\.1 \(commit aaaaaaa\)\. Install v2027\.01\.15\.2\.1 again to finish\./);
  const branch = cardStatus(releasesOf({ installed: { version: null, agent: { release: 'main', commit: A } }, newer: [] }), null);
  assert.equal(branch.label, 'not a release');
  assert.match(branch.summary, /runs main \(commit aaaaaaa\), which is not a published release.*install\/install\.sh --ref <version>/);
  assert.equal(cardStatus(null, null).label, 'checking');
});

test('while the page waits for the new dashboard, the card says it is updated and offers nothing', () => {
  const half = releasesOf({ repair: V2, newer: [rel(V3)] });
  assert.deepEqual(cardStatus(half, upgradeOf('done'), { awaiting: true }),
    { level: 'ok', label: 'updated', summary: `${V2} is installed; the new dashboard is starting.` }, 'the old dashboard, still answering, is not a half-done upgrade');
  assert.deepEqual(installChoices(half, upgradeOf('done'), { awaiting: true }), []);
});

test('a failed upgrade shows while its release can still be installed, and not once overtaken', () => {
  assert.equal(showsFailure(releasesOf(), upgradeOf('failed')), true, 'V2 is still newer');
  assert.equal(showsFailure(releasesOf({ repair: V2, newer: [] }), upgradeOf('failed')), true, 'the half-done one');
  assert.equal(showsFailure(releasesOf({ newer: [rel(V3)] }), upgradeOf('failed')), false);
  assert.equal(showsFailure(releasesOf(), upgradeOf('done')), false);
  assert.equal(showsFailure(null, upgradeOf('failed')), false);
});

test('what an admin may install: the half-done release first, then the newer ones; nothing while one runs', () => {
  assert.deepEqual(installChoices(releasesOf(), null), [V3, V2]);
  assert.deepEqual(installChoices(releasesOf({ repair: V2, newer: [rel(V3)] }), null), [V2, V3]);
  assert.deepEqual(installChoices(releasesOf(), upgradeOf('deploy')), []);
  assert.deepEqual(installChoices(releasesOf(), upgradeOf('failed')), [V3, V2], 'a failed upgrade may be tried again');
  assert.deepEqual(installChoices(null, null), []);
});

test('the page waits for the new dashboard once an upgrade it watched is done, or one finished moments ago', () => {
  const done = upgradeOf('done');
  assert.equal(shouldAwaitReload(done, A, { sawRunning: true, now: NOW }), true);
  assert.equal(shouldAwaitReload(done, B, { sawRunning: true, now: NOW }), false, 'this page already runs the new commit');
  assert.equal(shouldAwaitReload(done, A, { sawRunning: false, now: NOW }), true, 'finished two minutes ago');
  assert.equal(shouldAwaitReload(done, A, { sawRunning: false, now: NOW + 3_600_000 }), false, 'an old upgrade, and the page runs something else since');
  assert.equal(shouldAwaitReload(upgradeOf('deploy'), A, { sawRunning: true, now: NOW }), false);
  assert.equal(shouldAwaitReload(null, A, { sawRunning: true, now: NOW }), false);

  assert.equal(isNewDashboard({ dashboard: { commit: B } }, done), true);
  assert.equal(isNewDashboard({ dashboard: { commit: A } }, done), false, 'the old revision may answer for a moment');
  assert.equal(isNewDashboard(null, done), false);
});
