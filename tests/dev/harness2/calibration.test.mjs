// Tests for dev/harness2/calibration.mjs: the A/A and known-bad verdicts, and the calibration kept for
// one baseline commit, task set and trial count for a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CALIBRATION_MAX_AGE_HOURS, KNOWN_BAD_CHANGE, calibrateMeasurement, calibrationKey, judgeCalibration,
} from '../../../dev/harness2/calibration.mjs';
import { classifySurfacePath } from '../../../dev/harness2/surface.mjs';

const runs = (caps, taskId = 'task-a') => caps.map((capability, i) => ({ taskId, trial: i + 1, measured: true, capability }));

test('a measurement passes when the baseline matches itself and a known-bad change clearly loses', () => {
  const verdict = judgeCalibration({
    baselineTrajectories: runs([0.8, 0.82, 0.78]),
    repeatTrajectories: runs([0.79, 0.81, 0.8]),
    knownBadTrajectories: runs([0.1, 0.12, 0.08]),
  });
  assert.equal(verdict.ok, true, verdict.problems.join(' | '));
  assert.equal(verdict.knownBad.detected, true);
  assert.equal(verdict.knownBad.change, 'prompts/motor.md');
});

test('a drifting A/A, or a known-bad change the runs cannot see, fails it, each saying why', () => {
  const drift = judgeCalibration({
    baselineTrajectories: runs([0.5, 0.5, 0.5]),
    repeatTrajectories: runs([0.7, 0.7, 0.7]),
    knownBadTrajectories: runs([0.1, 0.1, 0.1]),
  });
  assert.equal(drift.ok, false);
  assert.match(drift.problems.join(' | '), /against itself moved 0\.2/);
  const blind = judgeCalibration({
    baselineTrajectories: runs([0.8, 0.8, 0.8]),
    repeatTrajectories: runs([0.8, 0.8, 0.8]),
    knownBadTrajectories: runs([0.78, 0.8, 0.79]),
  });
  assert.equal(blind.ok, false);
  assert.match(blind.problems.join(' | '), /cannot see a prompt change/);
  assert.match(judgeCalibration({}).problems.join(' | '), /A\/A check has no runs.*known-bad check has no runs/);
});

test('the known-bad change is on the mutable surface, as a real change is', () => {
  assert.equal(classifySurfacePath(KNOWN_BAD_CHANGE.path).allowed, true);
});

test('a calibration runs the known-bad change, and is kept for a day for the same commit, tasks and trials', async (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-cal-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const calls = [];
  const evaluate = async (filePatches) => {
    calls.push(Object.keys(filePatches));
    return { trajectories: Object.keys(filePatches).length ? runs([0.1, 0.1, 0.12]) : runs([0.8, 0.79, 0.81]) };
  };
  const base = { evaluate, baselineTrajectories: runs([0.8, 0.8, 0.8]), commit: 'c'.repeat(40), taskIds: ['task-a'], trials: 3, repoRoot };
  const now = new Date('2027-01-21T09:00:00Z');
  const first = await calibrateMeasurement({ ...base, now });
  assert.equal(first.ok, true, first.problems.join(' | '));
  assert.equal(first.cached, false);
  assert.deepEqual(calls, [[], ['prompts/motor.md']]);

  const again = await calibrateMeasurement({ ...base, now: new Date(now.getTime() + 3_600_000) });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 2, 'nothing ran again');
  await calibrateMeasurement({ ...base, now: new Date(now.getTime() + CALIBRATION_MAX_AGE_HOURS * 3_600_000) });
  assert.equal(calls.length, 4, 'a day-old calibration runs again');
  await calibrateMeasurement({ ...base, refresh: true, now });
  assert.equal(calls.length, 6, '--recalibrate runs again');
  await calibrateMeasurement({ ...base, trials: 5, now });
  assert.equal(calls.length, 8, 'another trial count is another calibration');
  assert.notEqual(calibrationKey({ commit: 'c', taskIds: ['a'], trials: 3 }), calibrationKey({ commit: 'c', taskIds: ['b'], trials: 3 }));
});
