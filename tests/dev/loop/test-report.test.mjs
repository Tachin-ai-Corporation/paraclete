// Tests for dev/loop/test-report.mjs: the failing tests read from node's test-runner output, with their
// file, line, name and the start of their message; nothing when the run printed no failures; and the
// Markdown lines a refusal comment carries, capped. A file that could not load is reported with its
// error and the source it failed on, with the checkout's paths made relative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { failingTests, failureLines, REPORT_LIMITS, withoutRoots } from '../../../dev/loop/test-report.mjs';

/** A cycle's checkout, as node names it in a load error's location. */
const ROOT = path.join(os.tmpdir(), 'paraclete-loop-abc123');

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
  '      at TestContext.<anonymous> (file:///repo/tests/install/bootstrap.test.mjs:786:12)',
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

/** A run where one test file could not load: its error comes before its result line, not in the block. */
const LOAD_FAILURE = [
  '✔ an earlier file passed (3ms)',
  `${pathToFileURL(ROOT).href}/tests/bad.test.mjs:2`,
  "import { b } from '../lib/thing.js';",
  '         ^',
  "SyntaxError: Named export 'b' not found. The requested module '../lib/thing.js' is a CommonJS module.",
  'CommonJS modules can always be imported via the default export, for example using:',
  '    at #asyncInstantiate (node:internal/modules/esm/module_job:327:21)',
  '',
  'Node.js v24.19.0',
  '✖ tests\\bad.test.mjs (50.88ms)',
  'TypeError: printed by another file, after this one',
  '✔ ok (0.4309ms)',
  'ℹ fail 1',
  '',
  '✖ failing tests:',
  '',
  'test at tests\\bad.test.mjs:1:1',
  '✖ tests\\bad.test.mjs (50.88ms)',
  "  'test failed'",
].join('\n');

test("a file that failed as a whole is reported with the error it printed, not just 'test failed'", () => {
  assert.deepEqual(failingTests(withoutRoots(LOAD_FAILURE, [ROOT])), [{
    file: 'tests/bad.test.mjs',
    line: 1,
    name: 'tests\\bad.test.mjs',
    message: "SyntaxError: Named export 'b' not found. The requested module '../lib/thing.js' is a CommonJS module. (at tests/bad.test.mjs:2: import { b } from '../lib/thing.js';)",
  }]);
  const noError = LOAD_FAILURE.replace(/^SyntaxError: .*$/m, 'no error line here');
  assert.equal(failingTests(noError)[0].message, "'test failed'", 'nothing better found: the block says it');
  const unplaced = LOAD_FAILURE.replace(/^file:.*$/m, '');
  assert.equal(failingTests(unplaced)[0].message, "SyntaxError: Named export 'b' not found. The requested module '../lib/thing.js' is a CommonJS module.", 'no location: the error alone');
  const other = LOAD_FAILURE.replace('✔ an earlier file passed (3ms)\n', "ReferenceError: another test's\n✖ an earlier test (3ms)\n");
  assert.match(failingTests(other)[0].message, /^SyntaxError/, "the search stops at the previous result line, so another test's error is not taken");
});

test("a checkout's own paths are made relative, as file URLs and as paths", () => {
  const url = pathToFileURL(ROOT).href;
  const text = [`${url}/tests/a.test.mjs:3`, `${ROOT}${path.sep}agent${path.sep}x.mjs`, `${ROOT}/agent/y.mjs`, '/elsewhere/z.mjs'].join('\n');
  assert.equal(withoutRoots(text, [ROOT, ROOT, null]), ['tests/a.test.mjs:3', `agent${path.sep}x.mjs`, 'agent/y.mjs', '/elsewhere/z.mjs'].join('\n'));
  assert.equal(withoutRoots(text, []), text);
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
