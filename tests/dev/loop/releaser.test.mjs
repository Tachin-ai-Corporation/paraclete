// Tests for dev/loop/releaser.mjs: the lab's health (its release the head, soaked, every service active
// and beating); the lab read from an instance's files and units; the loop merges a release carries; the
// tag's message; and releaseIfDue: off, a candidate dev/release.mjs refuses, released already, no loop
// merge, too soon after the last release, a lab not yet healthy, a dry run, and a release pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_DEFAULTS } from '../../../dev/loop/config.mjs';
import { loopSquashBody } from '../../../dev/loop/merger.mjs';
import { LAB_PATHS, labHealth, loopMergesIn, readLab, releaseIfDue, releaseMessage, runReleaseCheck } from '../../../dev/loop/releaser.mjs';
import { SERVICES } from '../../../agent/services/control/systemd.mjs';

const NOW = new Date('2026-10-27T12:00:00Z');
const HEAD = 'a'.repeat(40);
const beating = Object.fromEntries(SERVICES.map((s) => [s, { beat_at: '2026-10-27T11:59:40Z' }]));
const active = Object.fromEntries(SERVICES.map((s) => [s, 'active']));
const LAB = { release: { commit: HEAD, installed_at: '2026-10-27T08:00:00Z' }, units: active, health: beating };

test('the lab is healthy when it runs the head, soaked, with every service active and beating', () => {
  assert.deepEqual(labHealth({ head: HEAD, ...LAB, now: NOW, soakHours: 2 }), { ok: true, problems: [], hours: 4 });
  const problems = (o) => labHealth({ head: HEAD, ...LAB, ...o, now: NOW, soakHours: 2 }).problems.join(' | ');
  assert.match(problems({ release: null }), /runs no paraclete release: it is not a lab instance/);
  assert.match(problems({ release: { ...LAB.release, commit: 'b'.repeat(40) } }), /the lab runs bbbbbbbbbbbb, not main's head aaaaaaaaaaaa/);
  assert.match(problems({ release: { ...LAB.release, installed_at: '2026-10-27T11:00:00Z' } }), /run it 1\.0 h, under the 2 h soak/);
  assert.match(problems({ release: { commit: HEAD } }), /does not say when it installed/);
  assert.match(problems({ units: { ...active, brain: 'failed' } }), /brain is failed/);
  assert.match(problems({ health: { ...beating, mouth: { beat_at: '2026-10-27T11:50:00Z' } } }), /mouth's heartbeat is 600 s old/);
  assert.match(problems({ health: { ...beating, ears: { status: 'ok' } } }), /ears's heartbeat has no time/);
  const real = { ...beating, gateway: null, control: null };
  assert.deepEqual(labHealth({ head: HEAD, ...LAB, health: real, now: NOW, soakHours: 2 }).problems, [],
    'gateway and control write no heartbeat (as on a real lab VM): their units judge them, as dev/status.mjs does');
});

test("the lab is read from this machine's release file, unit states and heartbeat files", () => {
  const files = {
    [`${LAB_PATHS.installRoot}/release.json`]: JSON.stringify(LAB.release),
    ...Object.fromEntries(SERVICES.map((s) => [`${LAB_PATHS.dataRoot}/services/${s}/health.json`, JSON.stringify(beating[s])])),
  };
  const read = readLab({ readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; }, unitState: (u) => (u.includes('brain') ? 'activating' : 'active') });
  assert.deepEqual(read.release, LAB.release);
  assert.equal(read.units.brain, 'activating');
  assert.equal(read.units.gateway, 'active');
  assert.deepEqual(read.health.control, beating.control);
  const none = readLab({ readFile: () => { throw new Error('ENOENT'); }, unitState: () => 'inactive' });
  assert.equal(none.release, null, 'not an instance');
});

const merge = (pr, issue) => `v1: x\n\n${loopSquashBody({ number: pr, sha: 'c'.repeat(40), issue })}`;

test('the loop merges a release carries, and the tag message that says so', () => {
  assert.deepEqual(loopMergesIn([merge(49, 33), 'v2: a person', merge(54, 52), '']), [{ pr: 49, issue: 33 }, { pr: 54, issue: 52 }]);
  assert.equal(releaseMessage({ version: 'v2026.10.27.1.1', head: HEAD, hours: 4, merges: [{ pr: 49, issue: 33 }], previous: 'v2026.10.23.3.1', now: NOW }), [
    'v2026.10.27.1.1: released by the self-improvement loop (dev/loop/releaser.mjs)',
    '',
    `At 2026-10-27T12:00:00.000Z: CI passed on ${HEAD}, and the lab ran it 4.0 h with every agent service active and every heartbeat fresh.`,
    'Loop merges since v2026.10.23.3.1: #49 (for #33).',
  ].join('\n'));
});

const ON = { ...LOOP_DEFAULTS, release: { ...LOOP_DEFAULTS.release, enabled: true } };
const CANDIDATE = { head: HEAD, version: 'v2026.10.27.1.1', released: false, tagged: false, previous: 'v2026.10.23.3.1', previousCommit: 'p'.repeat(40) };

/** A fake checkout: the loop merges since the last release, and when that release was tagged. */
function ctx({ messages = [merge(49, 33)], taggedAt = '2026-10-26T08:00:00Z' } = {}) {
  const calls = [];
  return {
    calls,
    async git(args) {
      calls.push(args);
      if (args[0] === 'log' && args.includes('--format=%B%x00')) return { code: 0, stdout: messages.map((m) => `${m}\0`).join('') };
      if (args[0] === 'log' && args.includes('--format=%cI')) return { code: 0, stdout: `${taggedAt}\n` };
      return { code: 0, stdout: '' };
    },
  };
}

test('a release is cut when CI passed, loop merges landed, the last release is old enough and the lab ran it healthy', async () => {
  const pushed = [];
  const c = ctx();
  const res = await releaseIfDue({ settings: ON, ctx: c, check: async () => CANDIDATE, push: async (...a) => { pushed.push(a); }, lab: () => LAB, now: NOW });
  assert.deepEqual(res, { action: 'released', reason: null, version: 'v2026.10.27.1.1' });
  assert.deepEqual(c.calls[0], ['log', '--format=%B%x00', `${'p'.repeat(40)}..${HEAD}`], 'the merges since the previous release');
  const [, candidate, { message, again }] = pushed[0];
  assert.equal(candidate, CANDIDATE);
  assert.match(message, /Loop merges since v2026\.10\.23\.3\.1: #49 \(for #33\)\.$/);
  assert.equal(again, 'the next cycle pushes it');
});

test("no release when off, refused by dev/release.mjs, released already, without a loop merge, too soon, before the lab's soak, or in a dry run", async () => {
  const run = ({ ctx: checkout, ...o } = {}) => releaseIfDue({
    settings: ON, ctx: ctx(checkout), check: async () => CANDIDATE, push: async () => { throw new Error('pushed'); }, lab: () => LAB, now: NOW, ...o,
  });
  assert.match((await run({ settings: LOOP_DEFAULTS })).reason, /releasing is off/);
  assert.match((await run({ check: async () => { throw new Error('CI is still running on aaaaaaaaaaaa: Tests (in_progress). Run this again when it has passed.'); } })).reason, /^CI is still running/);
  assert.match((await run({ check: async () => ({ ...CANDIDATE, released: true }) })).reason, /v2026\.10\.27\.1\.1 is released already/);
  assert.match((await run({ ctx: { messages: ['v2: a person'] } })).reason, /no loop merge since v2026\.10\.23\.3\.1/);
  assert.match((await run({ ctx: { taggedAt: '2026-10-27T02:00:00Z' } })).reason, /v2026\.10\.23\.3\.1 is 10\.0 h old, under the 20 h between releases/);
  assert.match((await run({ lab: () => ({ ...LAB, release: { ...LAB.release, installed_at: '2026-10-27T11:30:00Z' } }) })).reason, /has not run it healthy long enough: the lab has run it 0\.5 h/);
  const dry = await run({ dryRun: true });
  assert.deepEqual(dry, { action: 'not-due', reason: 'a dry run: v2026.10.27.1.1 would be released', version: 'v2026.10.27.1.1' });
  const first = await run({ check: async () => ({ ...CANDIDATE, previous: null, previousCommit: null }), push: async () => {} });
  assert.equal(first.action, 'released', 'the first release needs no previous one');
});

const SMOKE = { ...LOOP_DEFAULTS, release: { ...LOOP_DEFAULTS.release, enabled: true, smoke: true } };

test("with smoke on, the release is dev/release-check.mjs's on the canary, and only its own tag counts", async () => {
  const run = (summary, o = {}) => releaseIfDue({
    settings: SMOKE, ctx: ctx(), check: async () => CANDIDATE, push: async () => { throw new Error('the releaser tagged it itself'); },
    lab: () => LAB, now: NOW, canary: () => ({ code: summary?.outcome === 'failed' ? 1 : 0, summary, tail: 'stderr tail' }), ...o,
  });
  assert.deepEqual(await run({ outcome: 'released', tag: 'v2026.10.27.1.1', steps: {} }), { action: 'released', reason: null, version: 'v2026.10.27.1.1' });
  assert.match((await run({ outcome: 'nothing_to_release', steps: {} })).reason, /was released meanwhile/);
  const smoke = await run({ outcome: 'failed', steps: { release: { ok: true }, deploy: { ok: true }, status: { ok: true }, smoke: { ok: false } }, error: 'the smoke test of role software-engineer failed: no answer.\nmore' });
  assert.deepEqual(smoke, { action: 'not-due', reason: 'the canary check failed at smoke: the smoke test of role software-engineer failed: no answer.' });
  assert.match((await run(null)).reason, /the canary check failed: stderr tail/, 'no summary: the tail of what it printed');
  assert.match((await run(null, { dryRun: true })).reason, /would be checked on the canary and then released/);
});

test('the canary check runs dev/release-check.mjs --vm-only --json in the checkout and reads its summary back', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '{"outcome": "released", "tag": "v1"}\n', stderr: 'Step 5 of 5\nPushed v1.\n' };
  };
  const res = runReleaseCheck({ cwd: '/repo', minutes: 2, spawn });
  assert.deepEqual(res, { code: 0, summary: { outcome: 'released', tag: 'v1' }, tail: 'Step 5 of 5 Pushed v1.' });
  assert.deepEqual(calls[0].args, ['dev/release-check.mjs', '--vm-only', '--json']);
  assert.deepEqual([calls[0].cmd, calls[0].opts.cwd, calls[0].opts.timeout, 'NODE_TEST_CONTEXT' in calls[0].opts.env], [process.execPath, '/repo', 120_000, false]);
  assert.equal(runReleaseCheck({ spawn: () => ({ status: null, stdout: '', stderr: 'killed' }) }).summary, null);
});
