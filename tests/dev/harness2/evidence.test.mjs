// Tests for the rules dev/harness2/evidence.mjs added for real-model runs: every run measured from its
// own side, a passing calibration, and no regression on the held-out tasks; and the evidence section
// that shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromotionEvidence, formatEvidenceMarkdown, judgeEvidence, parseEvidenceBlock } from '../../../dev/harness2/evidence.mjs';

const CANDIDATE = { id: 'cand-1', lens: 'DOM', touchedPaths: ['roles/generic/prompts/motor.md'], proposal: { source: 'vertex', hypothesis: 'say how to verify' } };
const CALIBRATION = { ok: true, aa: { delta: 0.0, noise: 0.01 }, knownBad: { delta: -0.6, noise: 0.02, detected: true }, problems: [] };

function runs(caps, { taskId = 'task-a', split = 'train', measured = true } = {}) {
  return caps.map((capability, i) => ({ taskId, trial: i + 1, split, measured, capability }));
}

function evidence({ base = runs([0.4, 0.42, 0.38]), cand = runs([0.9, 0.92, 0.88]), calibration = CALIBRATION } = {}) {
  return buildPromotionEvidence({
    candidate: CANDIDATE, baselineTrajectories: base, candidateTrajectories: cand, calibration, suite: { name: 'model', version: 1 },
  });
}

test('measured, calibrated and better passes', () => {
  const e = evidence();
  assert.equal(e.measured, true);
  assert.deepEqual(judgeEvidence(e), { ok: true, problems: [] });
});

test('runs that did not send their own prompts to a model are refused', () => {
  const e = evidence({ base: runs([0.4, 0.42, 0.38], { measured: false }), cand: runs([0.9, 0.92, 0.88], { measured: false }) });
  assert.equal(e.measured, false);
  const { ok, problems } = judgeEvidence(e);
  assert.equal(ok, false);
  assert.deepEqual(problems, ["some runs did not send their own side's prompts to a model; only a --real-model run measures a change"]);
});

test('no calibration, or a failed one, is refused', () => {
  assert.match(judgeEvidence(evidence({ calibration: null })).problems.join(' | '), /was not calibrated/);
  const failed = { ...CALIBRATION, ok: false, problems: ['a known-bad change moved capability only -0.01'] };
  assert.match(judgeEvidence(evidence({ calibration: failed })).problems.join(' | '), /failed its calibration: a known-bad change moved capability only -0\.01/);
  assert.equal(judgeEvidence(evidence({ calibration: null }), { requireCalibration: false }).ok, true, 'the pre-check before calibrating');
});

test('a gain on the training tasks with a held-out regression is refused', () => {
  const base = [...runs([0.4, 0.42, 0.38]), ...runs([0.8, 0.8, 0.8], { taskId: 'task-h', split: 'holdout' })];
  const cand = [...runs([0.95, 0.97, 0.96]), ...runs([0.77, 0.77, 0.77], { taskId: 'task-h', split: 'holdout' })];
  const e = evidence({ base, cand });
  assert.deepEqual([e.holdout.baseline.mean, e.holdout.candidate.mean], [0.8, 0.77]);
  const { problems } = judgeEvidence(e);
  assert.match(problems.join(' | '), /the held-out tasks got worse: capability 0\.8 -> 0\.77/);
});

test('the evidence section shows the measurement, the calibration and the held-out tasks, and reads back', () => {
  const base = [...runs([0.4, 0.42, 0.38]), ...runs([0.8, 0.8, 0.8], { taskId: 'task-h', split: 'holdout' })];
  const cand = [...runs([0.9, 0.92, 0.88]), ...runs([0.8, 0.81, 0.8], { taskId: 'task-h', split: 'holdout' })];
  const md = formatEvidenceMarkdown(evidence({ base, cand }));
  assert.match(md, /\*\*Measured\*\*: every run sent its side's own prompts to the model \(suite model v1\)/);
  assert.match(md, /\*\*Calibration\*\*: passed: the baseline against itself 0 \(noise 0\.01\), a known-bad change -0\.6/);
  assert.match(md, /\*\*Held-out tasks\*\*: 0\.8 ± 0 \(n=3\) -> 0\.8033/);
  const back = parseEvidenceBlock(md);
  assert.equal(back.calibration.ok, true);
  assert.deepEqual(judgeEvidence(back), { ok: true, problems: [] }, 'a merger reaches the same verdict from the block');
});
