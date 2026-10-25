// Tests for dev/loop/test-report.mjs: the failing tests read from node's test-runner output, with their
// file, line, name and the start of their message; nothing when the run printed no failures; and the
// Markdown lines a refusal comment carries, capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingTests, failureLines, REPORT_LIMITS } from '../../../dev/loop/test-report.mjs';

/** The end of a failing `npm test`, as node's spec reporter prints it. */
const OUTPUT = [
  '✔ something passed (2ms)',
  'ℹ tests 3456',
  'ℹ pass 3451',
  'ℹ fail 2',
  '',
  '✖ failing tests:',
  '',
  'test at tests/dashboard/lib/server/library.test.mjs:34:1',
  '✖ stored playbooks are listed active first, then by name (314.175321ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
  '  + actual - expected',
  '  ',
  '    {',
  '      created_at: ...',
  '',
  'test at tests\\install\\bootstrap.test.mjs:780:3',
  '✖ a failing migration fails the switch (14.344615ms)',
  '  AssertionError [ERR_ASSERTION]: checked first, then stopped',
].join('\r\n');

test('the failing tests: where, which, and how each failed', () => {
  assert.deepEqual(failingTests(OUTPUT), [
    {
      file: 'tests/dashboard/lib/server/library.test.mjs',
      line: 34,
      name: 'stored playbooks are listed active first, then by name',
      message: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: / + actual - expected / {',
    },
    {
      file: 'tests/install/bootstrap.test.mjs',
      line: 780,
      name: 'a failing migration fails the switch',
      message: 'AssertionError [ERR_ASSERTION]: checked first, then stopped',
    },
  ]);
});

test('a run that printed no failures has none; a failure without a location keeps its name', () => {
  assert.deepEqual(failingTests('ℹ tests 3\nℹ pass 3\nℹ fail 0\n'), []);
  assert.deepEqual(failingTests(undefined), []);
  assert.deepEqual(failingTests('✖ failing tests:\n\n✖ tests/dev/loop (46ms)\n  \'test failed\'\n'),
    [{ file: null, line: null, name: 'tests/dev/loop', message: "'test failed'" }]);
  const long = failingTests(`✖ failing tests:\ntest at a.test.mjs:1:1\n✖ ${'n'.repeat(500)}\n  ${'m'.repeat(900)}\n`)[0];
  assert.equal(long.name.length, REPORT_LIMITS.name);
  assert.equal(long.message.length, REPORT_LIMITS.message);
});

test('the Markdown lines: each failure on one line, and the rest counted', () => {
  const failures = failingTests(OUTPUT);
  assert.deepEqual(failureLines(failures), [
    '- `tests/dashboard/lib/server/library.test.mjs:34` stored playbooks are listed active first, then by name: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: / + actual - expected / {',
    '- `tests/install/bootstrap.test.mjs:780` a failing migration fails the switch: AssertionError [ERR_ASSERTION]: checked first, then stopped',
  ]);
  assert.deepEqual(failureLines(failures, 1).slice(1), ['- and 1 more']);
  assert.deepEqual(failureLines([]), []);
});
