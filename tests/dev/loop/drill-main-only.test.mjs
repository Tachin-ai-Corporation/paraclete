// tests/dev/loop/drill-main-only.test.mjs: a drill of the loop's revert path (dev/loop/sentinel.mjs),
// meant to be reverted once the sentinel opens a revert pull request. It holds one test that fails
// when process.env.GITHUB_REF is refs/heads/main and passes otherwise; it does not test any product
// or dev code. Called by tests/run.mjs (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('drill of the loop revert path: fails only when GITHUB_REF is refs/heads/main', () => {
  assert.notEqual(process.env.GITHUB_REF, 'refs/heads/main');
});
