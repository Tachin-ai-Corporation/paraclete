// Tests for roles/designer/skills/accessibility-checks/contrast-check.mjs: the WCAG 2 contrast ratio
// matches known reference values; a ratio just under a threshold fails it and never prints rounded up
// past it; colors parse in each accepted form and anything else is refused; --require turns a failing
// pair into exit 1; pairs can come from a JSON file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contrastCheck from '../../../../../roles/designer/skills/accessibility-checks/contrast-check.mjs';

const { parseColor, contrastRatio, checkPair } = contrastCheck;

function sink() {
  let text = '';
  return { write(chunk) { text += String(chunk); return true; }, text: () => text };
}

async function run(argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await contrastCheck.main(argv, { stdout, stderr, ...deps });
  return { code, out: stdout.text(), err: stderr.text() };
}

test('--help prints the usage', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: contrast-check /);
});

test('the ratio matches the reference values', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]), 1);
  assert.equal(contrastRatio([255, 255, 255], [0, 0, 0]), 21, 'the order of the colors does not matter');
  // #767676 is the lightest grey that passes AA on white; #777777 just misses it.
  assert.equal(checkPair(parseColor('#767676'), parseColor('#ffffff')).ratio, 4.54);
  assert.equal(checkPair(parseColor('#777777'), parseColor('#ffffff')).ratio, 4.47);
});

test('a ratio just under a threshold fails it and is never shown rounded up past it', () => {
  const result = checkPair(parseColor('#777777'), parseColor('#ffffff'));
  assert.equal(result.passes.aa, false);
  assert.equal(result.passes['aa-large'], true);
  assert.ok(result.ratio < 4.5);
  const near = checkPair(parseColor('#757575'), parseColor('#fdfdfd'));
  assert.equal(near.passes.aa, near.ratio >= 4.5, 'what prints agrees with the verdict');
});

test('colors parse as #rgb, #rrggbb, rgb(), srgb() and two names; anything else is refused', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('1F2937'), [31, 41, 55]);
  assert.deepEqual(parseColor('rgb(31, 41, 55)'), [31, 41, 55]);
  assert.deepEqual(parseColor('srgb(31,41,55)'), [31, 41, 55]);
  assert.deepEqual(parseColor('Black'), [0, 0, 0]);
  for (const bad of ['', 'red', '#12345', 'rgb(256, 0, 0)', 'rgb(0.2, 0.4, 0.6)', 'hsl(0, 0%, 0%)']) {
    assert.equal(parseColor(bad), null, bad);
  }
});

test('pairs on the command line print one line each', async () => {
  const r = await run(['#767676', '#ffffff', 'white', '1f2937']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    '#767676 on #ffffff: 4.54:1 | text AA pass (4.5) | large text AA pass (3) | text AAA FAIL (7) | non-text pass (3)',
    // 14.679...: truncated, as every ratio is, not rounded.
    '#ffffff on #1f2937: 14.67:1 | text AA pass (4.5) | large text AA pass (3) | text AAA pass (7) | non-text pass (3)',
    '',
  ].join('\n'));
});

test('--require exits 1 when a pair falls below the level, and --json prints every verdict', async () => {
  const r = await run(['#777777', '#ffffff', '--require', 'aa', '--json']);
  assert.equal(r.code, 1);
  const [result] = JSON.parse(r.out);
  assert.deepEqual(result, {
    foreground: '#777777', background: '#ffffff', ratio: 4.47,
    passes: { 'aa': false, 'aa-large': true, 'aaa': false, 'aaa-large': false, 'non-text': true },
  });
  assert.match(r.err, /1 of 1 pair below aa \(4\.5:1\)/);
  assert.equal((await run(['#767676', '#ffffff', '--require', 'aa'])).code, 0);
});

test('--pairs reads a JSON list with labels', async () => {
  const file = JSON.stringify([
    { label: 'body text', foreground: '#1f2937', background: '#ffffff' },
    { label: 'caption', fg: '#9ca3af', bg: '#ffffff' },
  ]);
  const r = await run(['--pairs', 'palette.json', '--require', 'aa'], { readText: (path) => (path === 'palette.json' ? file : '') });
  assert.equal(r.code, 1);
  assert.match(r.out, /^body text: #1f2937 on #ffffff: /m);
  assert.match(r.out, /^caption: #9ca3af on #ffffff: 2\.\d\d:1 \| text AA FAIL/m);
});

test('usage mistakes and unreadable colors exit 2', async () => {
  for (const argv of [[], ['#000'], ['#000', '#fff', '--require', 'gold'], ['#000', '#fff', '--pairs', 'p.json'], ['red', '#fff']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
  }
  const r = await run(['--pairs', 'p.json'], { readText: () => '{"not": "a list"}' });
  assert.equal(r.code, 2);
  assert.match(r.err, /non-empty JSON list/);
});
