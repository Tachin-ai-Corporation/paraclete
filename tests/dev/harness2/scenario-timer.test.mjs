// Tests for dev/harness2/scenario-timer.mjs: the units that run the canary's scenario batteries every
// hour on the lab's driver, from a clone of their own, and the commands a person sets them up with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCENARIO_CLONE, SCENARIO_UNIT, main, scenarioUnits } from '../../../dev/harness2/scenario-timer.mjs';

const quiet = { write() {} };

test('every battery, hourly, as the checkout owner, from a clone that follows main', () => {
  const u = scenarioUnits();
  assert.match(u.service, /^User=paraclete$/m);
  assert.match(u.service, new RegExp(`^WorkingDirectory=${SCENARIO_CLONE}$`, 'm'));
  assert.match(u.service, new RegExp(`^ExecStartPre=/usr/bin/git -C ${SCENARIO_CLONE} pull --ff-only --quiet origin main$`, 'm'));
  assert.match(u.service, new RegExp(`^ExecStart=/usr/bin/node ${SCENARIO_CLONE}/dev/harness2/cli\\.mjs scenarios --battery all$`, 'm'));
  assert.match(u.timer, /^OnCalendar=hourly$/m);
  assert.match(u.timer, /^Persistent=true$/m);
  assert.ok(u.install.some((l) => l.includes(`enable --now ${SCENARIO_UNIT}.timer`)));
  assert.ok(u.uninstall.some((l) => l.includes(`disable --now ${SCENARIO_UNIT}.timer`)));
});

test("a call killed at the unit's limit never holds the batteries' lock for long", () => {
  const scenarios = readFileSync(new URL('../../../dev/harness2/scenarios.mjs', import.meta.url), 'utf8');
  const staleHours = Number(/^const STALE_LOCK_MS = (\d+) \* 60 \* MINUTE;$/m.exec(scenarios)[1]);
  const limitHours = Number(/^TimeoutStartSec=(\d+)h$/m.exec(scenarioUnits().service)[1]);
  assert.ok(limitHours <= staleHours, `the unit stops a call by ${limitHours} h, and its lock goes stale at ${staleHours} h`);
});

test('the setup clones the harness checkout and links what the calls read from it', () => {
  const u = scenarioUnits({ branch: 'canary-scenarios' });
  const clone = SCENARIO_CLONE;
  const checkout = '/var/lib/paraclete/harness2-repo';
  assert.ok(u.setup.every((l) => l.startsWith('sudo -u paraclete ')), 'as the owner');
  assert.ok(u.setup.includes(`sudo -u paraclete git clone --quiet ${checkout} ${clone}`));
  assert.ok(u.setup.includes(`sudo -u paraclete git -C ${clone} checkout --quiet -B canary-scenarios FETCH_HEAD`));
  assert.match(u.service, /pull --ff-only --quiet origin canary-scenarios$/m);
  for (const file of ['.local/instance.env', 'agent/node_modules']) {
    assert.ok(u.setup.includes(`sudo -u paraclete ln -s ${checkout}/${file} ${clone}/${file}`), file);
  }
  assert.ok(u.setup.some((l) => l.includes(`ln -s ${checkout}/.local/denylist.txt ${clone}/.local/denylist.txt`)), 'the denylist, when there is one');
  assert.ok(!u.setup.some((l) => /https?:\/\//.test(l)), 'the remote URL is copied on the driver, never written here');
});

test('while a call runs, follow-main leaves the harness checkout where it is, as the header says', () => {
  const script = readFileSync(new URL('../../../dev/harness2/lab-follow-main.sh', import.meta.url), 'utf8');
  const pattern = new RegExp(/^HARNESS_PATTERN='(.+)'$/m.exec(script)[1]);
  assert.equal(pattern.test(/^ExecStart=(.+)$/m.exec(scenarioUnits().service)[1]), true);
});

test('it refuses what a unit file cannot hold, and prints the units', () => {
  assert.throws(() => scenarioUnits({ clone: '/tmp/x y' }), /--clone has characters a unit file cannot hold/);
  assert.throws(() => scenarioUnits({ branch: 'main; rm -rf /' }), /--branch has characters/);
  let out = '';
  assert.equal(main(['--branch', 'canary-scenarios'], { stdout: { write: (s) => { out += s; } }, stderr: quiet }), 0);
  assert.match(out, /^# paraclete-canary-scenarios\.service$/m);
  assert.match(out, /^# To set the clone up, on the driver:$/m);
  assert.match(out, /pull --ff-only --quiet origin canary-scenarios/);
  let err = '';
  assert.equal(main(['--hourly'], { stdout: quiet, stderr: { write: (s) => { err += s; } } }), 2);
  assert.match(err, /unknown argument: --hourly/);
});
