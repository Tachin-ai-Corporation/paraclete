// Tests for dev/loop/config.mjs, dev/loop/timer.mjs and the loop pattern in dev/harness2/lab-follow-main.sh: which paths a proposal may change, which change
// the agent's behaviour, the local settings over the defaults, and the timer units a person installs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOOP_DEFAULTS, isBehaviourPath, isCodePath, loadLoopSettings, pathRefusal, testRefusal } from '../../../dev/loop/config.mjs';
import { LANE_UNIT, LOOP_UNIT, laneUnits, loopUnits, main as timerMain } from '../../../dev/loop/timer.mjs';

test('the referee and secrets are refused; existing tests may only be added to', () => {
  for (const rel of [
    'dev/loop/cycle.mjs', 'dev/harness2/evidence.mjs', 'dev/harness2/model-suite.mjs', 'dev/harness2/merge.mjs', 'dev/release.mjs',
    'dev/harness2/live-runner.mjs', 'dev/harness2/substrate.mjs', 'dev/harness2/cli.mjs', 'dev/harness2/curriculum.mjs',
    'dev/harness2/lab-follow-main.sh', 'dev/release-check.mjs', 'dev/smoke.mjs', 'dev/status.mjs', 'dev/deploy.mjs', 'dev/dev-env.mjs',
    '.github/workflows/ci.yml', 'install/install.sh', 'migrations/001.mjs', 'roles/generic/role.json', 'config/contracts.mjs',
    'docs/canon/PRODUCT.md', 'DEVELOPING.md', 'package.json', 'agent/package-lock.json', '.local/notes.md', '.env',
  ]) {
    assert.ok(pathRefusal(rel, 'M'), rel);
  }
  assert.match(pathRefusal('tests/agent/x.test.mjs', 'M'), /existing test/);
  assert.match(pathRefusal('tests/agent/x.test.mjs', 'D'), /existing test/);
  assert.equal(pathRefusal('tests/agent/new.test.mjs', 'A'), null);
  for (const rel of ['agent/work/approvals.mjs', 'prompts/motor.md', 'dashboard/app/page.js', 'docs/guides/SKILLS.md', 'dev/say.mjs', 'roles/generic/prompts/cortex.md']) {
    assert.equal(pathRefusal(rel, 'M'), null, rel);
  }
});

test("what changes the agent's behaviour is measured", () => {
  for (const rel of ['prompts/cortex.md', 'config/contracts.json', 'agent/services/brain/main.mjs', 'skills/drive/SKILL.md', 'roles/generic/prompts/motor.md', 'roles/qa-engineer/responsibilities.json']) {
    assert.equal(isBehaviourPath(rel), true, rel);
  }
  for (const rel of ['dashboard/app/page.js', 'docs/INSTALL.md', 'dev/status.mjs', 'tests/agent/x.test.mjs', 'roles/generic/role.json']) {
    assert.equal(isBehaviourPath(rel), false, rel);
  }
  for (const rel of ['agent/services/control/drive-check.mjs', 'agent/services/ears/main.mjs', 'agent/services/mouth/main.mjs']) {
    assert.equal(isBehaviourPath(rel), false, `${rel}: no measured run loads it`);
  }
  for (const rel of ['agent/services/gateway/main.mjs', 'agent/work/approvals.mjs', 'agent/cli/process-ops.mjs', 'agent/services/service-runtime.mjs']) {
    assert.equal(isBehaviourPath(rel), true, rel);
  }
});

test('a change to code must add a test; docs, styles and removals need none', () => {
  for (const rel of ['agent/work/x.mjs', 'dashboard/components/work/work-plan.js', 'dashboard/components/work/WorkPlan.jsx', 'skills/web-search/web-search.mjs', 'dev/x.sh']) {
    assert.equal(isCodePath(rel), true, rel);
  }
  for (const rel of ['docs/plan/OPEN_ITEMS.md', 'dashboard/components/work/WorkPlan.module.css', 'prompts/motor.md', 'config/contracts.json', 'tests/agent/x.test.mjs', 'tests/fakes/x.mjs']) {
    assert.equal(isCodePath(rel), false, rel);
  }
  const code = { status: 'M', path: 'dashboard/lib/server/work.mjs' };
  assert.match(testRefusal([code, { status: 'A', path: 'dashboard/components/work/work-plan.js' }]),
    /^it changes code \(dashboard\/lib\/server\/work\.mjs, dashboard\/components\/work\/work-plan\.js\) and adds no test/);
  assert.equal(testRefusal([code, { status: 'A', path: 'tests/dashboard/components/work/work-plan.test.mjs' }]), null);
  assert.match(testRefusal([code, { status: 'A', path: 'tests/fakes/helper.mjs' }]), /adds no test/, 'a helper is not a test');
  assert.equal(testRefusal([{ status: 'D', path: 'agent/work/old.mjs' }]), null, 'removing code needs no test');
  assert.equal(testRefusal([{ status: 'M', path: 'docs/guide.md' }, { status: 'M', path: 'prompts/motor.md' }]), null);
});

test('local settings name the proposer and may tune the budget; the defaults stand otherwise', () => {
  const local = { proposer: { command: 'your-coding-agent', args: ['--print'], wallMinutes: 30 }, maxCyclesPerDay: 2 };
  const s = loadLoopSettings({ repoRoot: '/r', readFile: () => JSON.stringify(local) });
  assert.equal(s.proposer.command, 'your-coding-agent');
  assert.equal(s.proposer.wallMinutes, 30);
  assert.equal(s.proposer.maxTurns, LOOP_DEFAULTS.proposer.maxTurns);
  assert.equal(s.maxCyclesPerDay, 2);
  assert.deepEqual(loadLoopSettings({ repoRoot: '/r', readFile: () => { throw new Error('none'); } }).proposer, LOOP_DEFAULTS.proposer);
});

test('the timer units: one cycle as the checkout owner, every few hours, installed by hand', () => {
  const u = loopUnits({ intervalHours: 6, repo: 'your-org/paraclete' });
  assert.match(u.service, /^User=paraclete$/m);
  assert.match(u.service, /^WorkingDirectory=\/var\/lib\/paraclete\/harness2-repo$/m);
  assert.match(u.service, /^ExecStart=\/usr\/bin\/node dev\/loop\/cycle\.mjs --repo your-org\/paraclete$/m);
  assert.match(u.timer, /^OnUnitActiveSec=6h$/m);
  assert.match(u.service, /^TimeoutStartSec=20h$/m, 'a measured change takes hours on each side');
  assert.ok(u.install.some((l) => l.includes(`enable --now ${LOOP_UNIT}.timer`)));
  assert.ok(u.uninstall.some((l) => l.includes(`disable --now ${LOOP_UNIT}.timer`)));
  assert.throws(() => loopUnits({ intervalHours: 0 }), /whole number from 1 to 24/);
  assert.throws(() => loopUnits({ checkout: '/tmp/x; rm -rf /' }), /characters a unit file cannot hold/);
  let out = '';
  assert.equal(timerMain(['--interval-hours', '12'], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} } }), 0);
  assert.match(out, /OnUnitActiveSec=12h/);
  assert.match(out, /# To install, on the driver:/);
});

test("a lane's units: a template instance per lane, run in the lane's own clone fast-forwarded to main first", () => {
  const l = laneUnits({ lane: 'organ:cerebellum', repo: 'your-org/paraclete' });
  assert.equal(l.slug, 'organ-cerebellum');
  assert.match(l.service, /^WorkingDirectory=\/var\/lib\/paraclete\/lanes\/%i$/m);
  assert.match(l.service, /^ExecStartPre=\/usr\/bin\/git -C \/var\/lib\/paraclete\/lanes\/%i pull --ff-only --quiet origin main$/m);
  assert.match(l.service, /^ExecStart=\/usr\/bin\/node \/var\/lib\/paraclete\/lanes\/%i\/dev\/loop\/cycle\.mjs --lane %i --repo your-org\/paraclete$/m);
  assert.match(l.service, /^TimeoutStartSec=20h$/m);
  assert.match(l.timer, /^OnUnitActiveSec=6h$/m);
  assert.ok(l.setup.some((c) => c === 'sudo -u paraclete git clone --quiet /var/lib/paraclete/harness2-repo /var/lib/paraclete/lanes/organ-cerebellum'));
  assert.ok(l.setup.some((c) => c.includes('remote set-url origin "$(git -C /var/lib/paraclete/harness2-repo remote get-url origin)"')), 'the remote is copied, never printed');
  assert.ok(l.setup.some((c) => c.includes('ln -s /var/lib/paraclete/harness2-repo/agent/node_modules')));
  assert.ok(l.install.some((c) => c.includes(`${LANE_UNIT}@.service`)) && l.install.some((c) => c.includes(`enable --now ${LANE_UNIT}@organ-cerebellum.timer`)));
  assert.throws(() => laneUnits({}), /--lane names the module/);
  assert.throws(() => laneUnits({ lane: 'organ:cerebellum', lanesRoot: '/tmp/x y' }), /characters a unit file cannot hold/);
  let out = '';
  assert.equal(timerMain(['--lane', 'organ:temporal-memory'], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} } }), 0);
  assert.match(out, /# To set the lane organ-temporal-memory up, on the driver:/);
  assert.match(out, /enable --now paraclete-loop-lane@organ-temporal-memory\.timer/);
});

test("the follow-main timer waits for the global loop's cycle in the harness checkout, never for a lane's", () => {
  const script = readFileSync(new URL('../../../dev/harness2/lab-follow-main.sh', import.meta.url), 'utf8');
  const pattern = new RegExp(/^HARNESS_PATTERN='(.+)'$/m.exec(script)[1]);
  assert.equal(pattern.test('/usr/bin/node dev/loop/cycle.mjs --repo your-org/paraclete'), true, 'the global cycle');
  assert.equal(pattern.test('/usr/bin/node /var/lib/paraclete/lanes/organ-cerebellum/dev/loop/cycle.mjs --lane organ-cerebellum'), false, "a lane's cycle runs in its own clone");
  assert.equal(pattern.test('node dev/harness2/cli.mjs eval --real-model'), true);
  assert.equal(pattern.test('/opt/paraclete/bin/harness-cycle --action health'), true);
});
