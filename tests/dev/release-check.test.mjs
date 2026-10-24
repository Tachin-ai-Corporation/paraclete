// Tests for dev/release-check.mjs: main's head is checked the way dev/release.mjs checks it, then
// deployed to the dev instance (dev/deploy.mjs), its status read (dev/status.mjs --json) and its role
// smoke-tested (dev/smoke.mjs), each as a child process, and only then tagged, with the check's
// summary in the tag's message, after the release's own checks once more (a newer release or a moved
// main since the start refuses it). Each failing step stops before the tag; a head already released
// has nothing to check; --no-release tags nothing; --vm-only and --wait reach the steps that take them;
// --json prints the summary alone on stdout. git, gh and the child processes are all faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkSummary, main, statusAgainst, tagMessage } from '../../dev/release-check.mjs';
import { REPO_ROOT } from '../../dev/dev-env.mjs';
import { MAIN, REMOTE } from '../../dev/release.mjs';
import { START, devDeps, fakeExec } from './fakes.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const TAG_OBJECT = 'd'.repeat(40);
const VERSION = 'v2026.10.19.1.1';
const PREVIOUS = 'v2026.10.18.9.4';
const SUBJECT = `${VERSION}: releases are checked first`;
const MISSION = 'Wq3kE9xYz0AbCdEfGh12';
const CHECKED_AT = new Date(START).toISOString();
const script = (name) => join(REPO_ROOT, 'dev', name);

/** What dev/status.mjs --json reports for an instance on `vm`, with agent/instance and the dashboard. */
function report({ vm = HEAD, agent = vm, dashboard = vm, problems = [] } = {}) {
  return {
    vm: { name: 'paraclete', project: 'your-gcp-project', zone: 'us-central1-a' },
    release: { version: PREVIOUS, commit: vm, ref: vm, repo: 'your-org/paraclete' },
    services: Object.fromEntries(['gateway', 'brain', 'ears', 'mouth', 'control'].map((s) => [s, { unit: `paraclete-${s}.service`, active: 'active', heartbeat: null }])),
    gateway: { uptime_sec: 10 },
    agent_instance: { status: 'ready', commit: agent },
    missions: [],
    dashboard: dashboard === null ? null : { service: 'paraclete', region: 'us-central1', commit: dashboard, matches_vm: dashboard === vm },
    problems,
  };
}

/** What dev/smoke.mjs prints, ending in its verdict and the mission line. */
const smokeOut = (verdictLine = 'PASS: role generic, a short research answer: the mission completed and its result was delivered.') => [
  'Smoke test of role generic (a short research answer), as dev@example.com in thread smoke-generic-20261017120000:',
  `  the brain made it work/${MISSION}`,
  '--- Ada at 2026-10-17T12:01:00Z',
  'RFC 7540, replaced by RFC 9113.',
  verdictLine,
  `The mission: node dev/query.mjs work --doc ${MISSION}`,
  '',
].join('\n');

/**
 * A clone, GitHub and the dev/ commands as a script for the fake runner: main at HEAD with SUBJECT,
 * clean and pushed, the tags given, CI passed, no release withdrawn; deploy, status and smoke answer as
 * given. `duringSmoke(origin)` changes origin (its `main` and `tags`) while the smoke test runs, as
 * another maintainer could.
 */
function world({
  originTags = { [PREVIOUS]: OLD }, localTags = { [PREVIOUS]: OLD }, checkRuns = { total_count: 1, check_runs: [{ name: 'Tests', status: 'completed', conclusion: 'success' }] },
  deploy = { code: 0, stdout: `Done: the VM runs ${HEAD}.\n` }, status = { code: 0, stdout: JSON.stringify(report()) },
  smoke = { code: 0, stdout: smokeOut() }, push = { code: 0 }, duringSmoke = () => {},
} = {}) {
  const origin = { main: HEAD, tags: { ...originTags } };
  return fakeExec(async (program, args) => {
    if (program === process.execPath) {
      if (args[0] === script('deploy.mjs')) return deploy;
      if (args[0] === script('status.mjs')) return status;
      if (args[0] === script('smoke.mjs')) {
        duringSmoke(origin);
        return smoke;
      }
      return { code: 1, stderr: `unexpected: node ${args.join(' ')}\n` };
    }
    if (program === 'gh') return { stdout: JSON.stringify(/\/releases\?/.test(args.at(-1)) ? [] : checkRuns) };
    const line = args.join(' ');
    if (line === 'symbolic-ref --quiet --short HEAD') return { stdout: `${MAIN}\n` };
    if (line === 'status --porcelain') return { stdout: '' };
    if (line === 'rev-parse HEAD') return { stdout: `${HEAD}\n` };
    if (line === `log -1 --format=%s ${HEAD}`) return { stdout: `${SUBJECT}\n` };
    if (line === `ls-remote ${REMOTE} refs/heads/${MAIN}`) return { stdout: `${origin.main}\trefs/heads/main\n` };
    if (line === `ls-remote --tags ${REMOTE}`) {
      return { stdout: Object.entries(origin.tags).map(([name, sha]) => `${TAG_OBJECT}\trefs/tags/${name}\n${sha}\trefs/tags/${name}^{}\n`).join('') };
    }
    if (line === 'tag --list') return { stdout: Object.keys(localTags).map((name) => `${name}\n`).join('') };
    const resolve = /^rev-parse --verify --quiet refs\/tags\/(.+)\^\{commit\}$/.exec(line);
    if (resolve) return localTags[resolve[1]] ? { stdout: `${localTags[resolve[1]]}\n` } : { code: 1 };
    if (args[0] === 'log' && args.includes('--first-parent')) return { stdout: `${'0'.repeat(40)}\0${OTHER}\0${SUBJECT}\n` };
    if (args[0] === 'push') return push;
    return undefined;
  });
}

/** The dev/ commands a run started, by file name, with their arguments; each is this clone's own. */
const steps = (exec) => exec.calls.filter((c) => c.program === process.execPath).map((c) => {
  const name = c.args[0].split(/[\\/]/).at(-1);
  assert.equal(c.args[0], script(name), 'the command in this clone, by its full path');
  assert.equal(c.opts.cwd, REPO_ROOT);
  return [name, ...c.args.slice(1)];
});
/** The tag a run made and pushed, as argument lists. */
const tagged = (exec) => exec.callsTo('git').filter((c) => ['tag', 'push'].includes(c.args[0]) && c.args[1] !== '--list').map((c) => c.args);

const SUMMARY = checkSummary({
  checkedAt: CHECKED_AT, commit: HEAD, vmOnly: false, smoke: { role: 'generic', about: 'a short research answer', mission: MISSION },
});

test('the summary and the tag message name the time, the commit, the status and the smoke mission, and nothing about the instance', () => {
  assert.deepEqual(SUMMARY, [
    `- time: ${CHECKED_AT}`,
    `- commit: ${HEAD}`,
    '- deploy: the VM, then the dashboard, moved to the commit',
    '- status: ok; every service up, the VM and agent/instance and the dashboard on the commit',
    `- smoke: PASS, role generic (a short research answer), mission ${MISSION}`,
  ]);
  assert.equal(tagMessage(VERSION, SUMMARY), [`Release ${VERSION}`, '', 'Checked on a dev instance before release (dev/release-check.mjs):', ...SUMMARY].join('\n'));
  const vmOnly = checkSummary({ checkedAt: CHECKED_AT, commit: HEAD, vmOnly: true, smoke: { role: 'paraclete-h2', about: 'x', mission: null } });
  assert.match(vmOnly[2], /the VM moved to the commit \(--vm-only: the instance has no dashboard\)/);
  assert.match(vmOnly[3], /the VM and agent\/instance on the commit$/);
  assert.match(vmOnly[4], /role paraclete-h2 \(x\), answered without a mission$/);
});

test('status against the deployed commit: its own problems, and any half on another commit', () => {
  assert.deepEqual(statusAgainst(report(), HEAD, false), { vm: HEAD, agent: HEAD, dashboard: HEAD, problems: [] });
  assert.deepEqual(statusAgainst(report({ dashboard: OLD, problems: ['x'] }), HEAD, false).problems, ['x', `the dashboard runs ${OLD}, not ${HEAD}`]);
  assert.deepEqual(statusAgainst(report({ dashboard: null }), HEAD, true), { vm: HEAD, agent: HEAD, dashboard: null, problems: [] }, '--vm-only');
  assert.deepEqual(statusAgainst(report({ vm: OLD, agent: OLD }), HEAD, true).problems,
    [`the VM has ${OLD} installed, not ${HEAD}`, `agent/instance reports ${OLD}, not ${HEAD}`]);
  assert.deepEqual(statusAgainst({}, HEAD, true).problems[0], 'the report lists no problems field');
});

test('a release candidate passing every step: deploy, status, smoke, then the tag with the check in its message', async () => {
  const exec = world();
  const deps = devDeps({ exec });
  assert.equal(await main([], deps), 0, deps.stderr.text);
  assert.deepEqual(steps(exec), [['deploy.mjs', HEAD], ['status.mjs', '--json'], ['smoke.mjs']]);
  assert.deepEqual(tagged(exec), [
    ['tag', '--annotate', VERSION, '--message', tagMessage(VERSION, SUMMARY), HEAD],
    ['push', REMOTE, `refs/tags/${VERSION}`],
  ]);
  const order = exec.calls.map((c) => {
    if (c.program === process.execPath) return c.args[0].split(/[\\/]/).at(-1);
    return c.program === 'gh' ? 'gh' : c.args.slice(0, 2).join(' ');
  });
  assert.ok(order.indexOf('gh') < order.indexOf('deploy.mjs'), 'CI is checked before anything is deployed');
  assert.ok(order.indexOf('smoke.mjs') < order.indexOf('tag --annotate'), 'the tag comes after the smoke test');
  const [message] = tagged(exec)[0].slice(4, 5);
  assert.doesNotMatch(message, /your-gcp-project|us-central1|paraclete-xxxxxxxxxx|run\.app/, 'the public tag names nothing of the instance');
  for (const call of exec.calls) assert.ok(call.args.every((a) => typeof a === 'string') && call.opts.shell === undefined, 'no shell');

  const out = deps.stdout.text;
  assert.match(out, /Step 1 of 5: is main's head a release\?/);
  assert.match(out, /v2026\.10\.19\.1\.1 is newer than v2026\.10\.18\.9\.4, the newest version tag, and not taken\./);
  assert.match(out, /CI passed on aaaaaaaaaaaa: Tests\./);
  assert.match(out, /Checking v2026\.10\.19\.1\.1 on your dev instance, VM paraclete in your-gcp-project\./);
  assert.match(out, /Step 2 of 5: node dev\/deploy\.mjs a{40}\nDone: the VM runs a{40}\./, "deploy's output, streamed");
  assert.match(out, /agent\/instance: ready on a{40}/);
  assert.match(out, /services: {7}gateway active, brain active, ears active, mouth active, control active/);
  assert.match(out, /ok: every service up, on a{40}\./);
  assert.match(out, /RFC 7540, replaced by RFC 9113\./, "smoke's output, streamed");
  assert.ok(out.includes(`The check passed:\n${SUMMARY.join('\n')}`));
  assert.match(out, /Pushed v2026\.10\.19\.1\.1\. \.github\/workflows\/release\.yml now tests it/);
  assert.doesNotMatch(out, /"problems"/, "status's JSON is read, not printed");
  assert.equal(exec.callsTo('gh').filter((c) => c.args.at(-1).includes('/check-runs?')).length, 2, 'the checks, CI among them, run again right before the tag');
  assert.ok(out.indexOf('once more, since the check took a while') > out.indexOf('The check passed:'));
});

const failures = [
  ['CI failing', { checkRuns: { total_count: 1, check_runs: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] } }, [],
    /CI did not pass on aaaaaaaaaaaa: Tests \(failure\)/],
  ['a deploy that fails', { deploy: { code: 1, stderr: 'dev/deploy: the upgrade exited with code 3\n' } }, [['deploy.mjs', HEAD]],
    /dev\/deploy\.mjs exited with code 1 \(its output is above\)\. v2026\.10\.19\.1\.1 is not released\./],
  ['a status with problems', { status: { code: 1, stdout: JSON.stringify(report({ problems: ['mouth is failed'] })) } }, [['deploy.mjs', HEAD], ['status.mjs', '--json']],
    /dev\/status\.mjs found problems:\n {2}- mouth is failed\nv2026\.10\.19\.1\.1 is not released\./],
  ['a dashboard still on the old commit', { status: { code: 0, stdout: JSON.stringify(report({ dashboard: OLD })) } }, [['deploy.mjs', HEAD], ['status.mjs', '--json']],
    /- the dashboard runs b{40}, not a{40}/],
  ['a status with no report', { status: { code: 1, stdout: '', stderr: 'dev/status: No dev instance is configured\n' } }, [['deploy.mjs', HEAD], ['status.mjs', '--json']],
    /dev\/status\.mjs exited with code 1 and printed no report/],
  ['a smoke test that fails', { smoke: { code: 1, stdout: smokeOut('FAIL: role generic, a short research answer: the mission ended failed: no model.') } },
    [['deploy.mjs', HEAD], ['status.mjs', '--json'], ['smoke.mjs']],
    /the smoke test of role generic failed: the mission ended failed: no model\. v2026\.10\.19\.1\.1 is not released\./],
  ['a smoke test with no verdict', { smoke: { code: 0, stdout: 'something else\n' } }, [['deploy.mjs', HEAD], ['status.mjs', '--json'], ['smoke.mjs']],
    /dev\/smoke\.mjs exited with code 0 without a verdict/],
];
for (const [what, over, ran, message] of failures) {
  test(`${what} stops the check before the tag, exit 1`, async () => {
    const exec = world(over);
    const deps = devDeps({ exec });
    assert.equal(await main([], deps), 1);
    assert.match(deps.stderr.text, message);
    assert.deepEqual(steps(exec), ran, 'no step after the failing one runs');
    assert.deepEqual(tagged(exec), [], 'nothing is tagged');
  });
}

const ciReads = (exec) => exec.callsTo('gh').filter((c) => c.args.at(-1).includes('/check-runs?')).length;

test('right before the tag the checks run once more: a newer release cut meanwhile refuses it', async () => {
  const exec = world({ duringSmoke: (origin) => { origin.tags['v2026.10.19.2.1'] = OTHER; } });
  const deps = devDeps({ exec });
  assert.equal(await main([], deps), 1);
  assert.match(deps.stderr.text, /v2026\.10\.19\.1\.1 is not newer than v2026\.10\.19\.2\.1, the newest version tag/);
  assert.match(deps.stdout.text, /The checks dev\/release\.mjs makes, once more, since the check took a while:/);
  assert.deepEqual(tagged(exec), []);
});

test('right before the tag: main moved on origin refuses it, and a release of this commit cut meanwhile leaves nothing to tag', async () => {
  let exec = world({ duringSmoke: (origin) => { origin.main = OTHER; } });
  let deps = devDeps({ exec });
  assert.equal(await main([], deps), 1);
  assert.match(deps.stderr.text, /origin has main at cccccccccccc, and this clone at aaaaaaaaaaaa: push \(or pull\) first/);
  assert.deepEqual(tagged(exec), []);

  exec = world({ duringSmoke: (origin) => { origin.tags[VERSION] = HEAD; } });
  deps = devDeps({ exec });
  assert.equal(await main(['--json'], deps), 0, deps.stderr.text);
  assert.match(deps.stderr.text, /v2026\.10\.19\.1\.1 was tagged at this commit on origin while the check ran: there is nothing left to release\./);
  assert.equal(JSON.parse(deps.stdout.text).outcome, 'nothing_to_release');
  assert.deepEqual(tagged(exec), []);
});

test('without .local/instance.env it stops before anything is deployed', async () => {
  const exec = world();
  const deps = { ...devDeps({ exec }), readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  assert.equal(await main([], deps), 1);
  assert.match(deps.stderr.text, /No dev instance is configured/);
  assert.deepEqual(steps(exec), []);
});

test('a head whose version origin has tagged already has nothing to release, so nothing is checked', async () => {
  const exec = world({ originTags: { [PREVIOUS]: OLD, [VERSION]: HEAD } });
  const deps = devDeps({ exec });
  assert.equal(await main([], deps), 0, deps.stderr.text);
  assert.match(deps.stdout.text, /v2026\.10\.19\.1\.1 is already tagged at this commit on origin: there is nothing to release, so nothing to check\./);
  assert.deepEqual(steps(exec), []);
  assert.deepEqual(exec.callsTo('gh'), [], 'CI is not read');
  assert.deepEqual(tagged(exec), []);
});

test('--no-release runs every step and tags nothing', async () => {
  const exec = world();
  const deps = devDeps({ exec });
  assert.equal(await main(['--no-release'], deps), 0, deps.stderr.text);
  assert.equal(steps(exec).length, 3);
  assert.deepEqual(tagged(exec), []);
  assert.equal(ciReads(exec), 1, 'nothing to tag, so nothing is checked again');
  assert.match(deps.stdout.text, /Nothing was tagged \(--no-release\)\. To release v2026\.10\.19\.1\.1: run this again without --no-release/);
});

test('--vm-only reaches deploy and status, and a status without a dashboard passes; --wait reaches smoke', async () => {
  const exec = world({ status: { code: 0, stdout: JSON.stringify(report({ dashboard: null })) } });
  const deps = devDeps({ exec });
  assert.equal(await main(['--vm-only', '--wait', '60'], deps), 0, deps.stderr.text);
  assert.deepEqual(steps(exec), [['deploy.mjs', HEAD, '--vm-only'], ['status.mjs', '--json', '--vm-only'], ['smoke.mjs', '--wait', '60']]);
  const message = tagged(exec)[0][4];
  assert.match(message, /- deploy: the VM moved to the commit \(--vm-only: the instance has no dashboard\)/);
  assert.doesNotMatch(deps.stdout.text, /dashboard: {6}/);
});

test('a tag left in the clone by a push that failed is pushed as it is, after the check', async () => {
  const exec = world({ localTags: { [PREVIOUS]: OLD, [VERSION]: HEAD } });
  const deps = devDeps({ exec });
  assert.equal(await main([], deps), 0, deps.stderr.text);
  assert.equal(steps(exec).length, 3);
  assert.deepEqual(tagged(exec), [['push', REMOTE, `refs/tags/${VERSION}`]]);
  assert.match(deps.stdout.text, /This clone has the tag v2026\.10\.19\.1\.1 from a push that failed; it is pushed with the message it was made with\./);
});

test('a push that fails says how to finish', async () => {
  const exec = world({ push: { code: 1, stderr: 'fatal: unable to access remote\n' } });
  const deps = devDeps({ exec });
  assert.equal(await main([], deps), 1);
  assert.match(deps.stderr.text, /The tag is in this clone: node dev\/release\.mjs pushes it, or run this again to check it again first\./);
});

test('--json prints the summary alone on stdout, passed or failed', async () => {
  let exec = world();
  let deps = devDeps({ exec });
  assert.equal(await main(['--json'], deps), 0, deps.stderr.text);
  const passed = JSON.parse(deps.stdout.text);
  assert.deepEqual({ outcome: passed.outcome, version: passed.version, commit: passed.commit, tag: passed.tag, checked_at: passed.checked_at, error: passed.error },
    { outcome: 'released', version: VERSION, commit: HEAD, tag: VERSION, checked_at: CHECKED_AT, error: null });
  assert.deepEqual(passed.steps.smoke, { ok: true, code: 0, role: 'generic', mission: MISSION, reason: 'the mission completed and its result was delivered' });
  assert.deepEqual(passed.steps.status, { ok: true, code: 0, vm_commit: HEAD, agent_commit: HEAD, dashboard_commit: HEAD, problems: [] });
  assert.match(deps.stderr.text, /Step 4 of 5: node dev\/smoke\.mjs/, 'the progress goes to stderr');
  assert.match(deps.stderr.text, /RFC 7540/, "and the steps' own output too");

  exec = world({ smoke: { code: 1, stdout: smokeOut('FAIL: role generic, a short research answer: no result within 900 s (no mission yet).') } });
  deps = devDeps({ exec });
  assert.equal(await main(['--json', '--no-release'], deps), 1);
  const failed = JSON.parse(deps.stdout.text);
  assert.deepEqual([failed.outcome, failed.tag, failed.release, failed.steps.smoke.ok], ['failed', null, false, false]);
  assert.match(failed.error, /the smoke test of role generic failed: no result within 900 s/);
});

test('usage mistakes exit 2 and run nothing; --help explains', async () => {
  for (const argv of [['--force'], ['--wait'], ['--wait', 'soon'], ['--wait', '0'], ['v2026.10.19.1.1']]) {
    const exec = world();
    const deps = devDeps({ exec });
    assert.equal(await main(argv, deps), 2, argv.join(' '));
    assert.match(deps.stderr.text, /Usage: node dev\/release-check\.mjs/);
    assert.deepEqual(exec.calls, [], argv.join(' '));
  }
  const exec = world();
  const deps = devDeps({ exec });
  assert.equal(await main(['--help'], deps), 0);
  assert.match(deps.stdout.text, /--no-release {2}check, and tag nothing/);
  assert.deepEqual(exec.calls, []);
});
