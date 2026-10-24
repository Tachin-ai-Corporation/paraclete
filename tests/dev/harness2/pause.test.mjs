// Tests for dev/harness2/pause.mjs: the harness's off switch, from the environment or from
// dev/harness2/PAUSED in a checkout, with the file's first line as the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAUSE_ENV, PAUSE_FILE, pauseState } from '../../../dev/harness2/pause.mjs';

function checkout(t, content) {
  const root = mkdtempSync(join(tmpdir(), 'h2-pause-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (content !== undefined) {
    mkdirSync(join(root, 'dev', 'harness2'), { recursive: true });
    writeFileSync(join(root, PAUSE_FILE), content);
  }
  return root;
}

test('not paused without the file or the variable', (t) => {
  assert.deepEqual(pauseState({ repoRoot: checkout(t), env: {} }), { paused: false, source: null, reason: null });
  assert.equal(pauseState({ repoRoot: checkout(t), env: { [PAUSE_ENV]: '' } }).paused, false);
  assert.equal(pauseState({ repoRoot: checkout(t), env: { [PAUSE_ENV]: '0' } }).paused, false);
});

test('the file pauses, and its first line is the reason', (t) => {
  assert.deepEqual(pauseState({ repoRoot: checkout(t, 'evaluating the new judge\nmore detail\n'), env: {} }),
    { paused: true, source: 'file', reason: 'dev/harness2/PAUSED: evaluating the new judge' });
  assert.deepEqual(pauseState({ repoRoot: checkout(t, ''), env: {} }),
    { paused: true, source: 'file', reason: 'dev/harness2/PAUSED exists' });
});

test('the variable pauses whatever the checkout holds', (t) => {
  assert.deepEqual(pauseState({ repoRoot: checkout(t), env: { [PAUSE_ENV]: '1' } }),
    { paused: true, source: 'env', reason: 'PARACLETE_H2_PAUSED is set' });
});
