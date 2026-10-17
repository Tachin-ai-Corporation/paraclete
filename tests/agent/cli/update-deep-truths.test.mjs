// Tests for agent/cli/update-deep-truths.mjs, against a temporary data root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { main, MAX_DEEP_TRUTHS, parseDeepTruths, renderDeepTruths } from '../../../agent/cli/update-deep-truths.mjs';
import { fakeRuntime, run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00Z');

function setup(content) {
  const runtime = fakeRuntime();
  const file = runtime.paths.data.deepTruthsFile;
  if (content !== undefined) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { file, truths: (argv) => run(main, argv, { runtime, now: () => NOW }) };
}

test('the file lives at memory/DEEP_TRUTHS.md under the data root', () => {
  const { file } = setup();
  assert.match(file.replace(/\\/g, '/'), /\/memory\/DEEP_TRUTHS\.md$/);
});

test('with no file yet, --list finds none and --add creates it', async () => {
  const { file, truths } = setup();
  assert.equal((await truths(['--list'])).out, 'No deep truths found.\n');
  const r = await truths(['--add', 'Verify by re-deriving, never by recognizing']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '[2026-10-17T12:00:00.000Z] [update-deep-truths] Added deep truth: Verify by re-deriving, never by recognizing\nOK\n');
  assert.equal(readFileSync(file, 'utf8'), '- Verify by re-deriving, never by recognizing\n');
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.equal((await truths(['--list'])).out, 'Deep Truths (1 items):\n- Verify by re-deriving, never by recognizing\n');
});

test('lines that are not bullets stay exactly as they were', async () => {
  const { file, truths } = setup('# Deep Truths\n<!-- Principles confirmed across many sessions. -->\n\n- one\n- two\n');
  await truths(['--add', 'three']);
  assert.equal(readFileSync(file, 'utf8'), '# Deep Truths\n<!-- Principles confirmed across many sessions. -->\n\n- one\n- two\n- three\n');
  await truths(['--remove', 'one']);
  assert.equal(readFileSync(file, 'utf8'), '# Deep Truths\n<!-- Principles confirmed across many sessions. -->\n\n- two\n- three\n');
});

test('an exact duplicate is skipped; a fact that only contains another is a different fact', async () => {
  const { file, truths } = setup('- Ship small\n');
  let r = await truths(['--add', 'Ship small']);
  assert.match(r.out, /Already exists: Ship small\n$/);
  r = await truths(['--add', 'Ship small changes often']);
  assert.match(r.out, /Added deep truth/);
  assert.equal(readFileSync(file, 'utf8'), '- Ship small\n- Ship small changes often\n');
});

test('--remove removes only the exact fact, and reports one it cannot find', async () => {
  // A substring match once removed every fact that merely contained the one named.
  const { file, truths } = setup('- Ship small\n- Ship small changes often\n');
  await truths(['--remove', 'Ship small']);
  assert.equal(readFileSync(file, 'utf8'), '- Ship small changes often\n');
  const r = await truths(['--remove', 'Never existed']);
  assert.deepEqual([r.code, r.out.split('\n').slice(-2)[0]], [0, 'Not found: Never existed']);
});

test(`at most ${MAX_DEEP_TRUTHS}: the eleventh pushes out the oldest`, async () => {
  const facts = Array.from({ length: MAX_DEEP_TRUTHS }, (_, i) => `- fact ${i + 1}`);
  const { file, truths } = setup(`${facts.join('\n')}\n`);
  const r = await truths(['--add', 'fact 11']);
  assert.match(r.out, /Exceeded 10 items — archived oldest: - fact 1\n/);
  const after = parseDeepTruths(readFileSync(file, 'utf8')).facts;
  assert.equal(after.length, MAX_DEEP_TRUTHS);
  assert.deepEqual([after[0], after.at(-1)], ['fact 2', 'fact 11']);
});

test('refuses an empty or multi-line fact and a missing action', async () => {
  const { truths } = setup();
  let r = await truths(['--add', '   ']);
  assert.equal(r.code, 1);
  assert.match(r.err, /\[FATAL\] Empty fact — nothing to add/);
  r = await truths(['--add', 'line one\nline two']);
  assert.match(r.err, /Facts must be single-line/);
  r = await truths([]);
  assert.match(r.err, /Missing action\. Use --add, --remove, or --list/);
  r = await truths(['--frob']);
  assert.match(r.err, /Unknown arg: --frob/);
});

test('parse and render keep every non-bullet line and put the bullets last', () => {
  const doc = parseDeepTruths('# Title\n- a\nnote\n- b\n\n');
  assert.deepEqual(doc, { kept: ['# Title', 'note'], facts: ['a', 'b'] });
  assert.equal(renderDeepTruths(doc), '# Title\nnote\n\n- a\n- b\n');
  assert.equal(renderDeepTruths({ kept: [], facts: [] }), '');
});
