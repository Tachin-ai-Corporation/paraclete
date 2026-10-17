// Tests for agent/work/work-ids.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID_PATTERN, DIGEST_PATTERN } from '../../../agent/work/work-ids.mjs';

test('ids are lowercase kebab-case and path-safe', () => {
  for (const ok of ['a', 'web-master', 'p-deploy-verify', 'agent1', 'a'.repeat(64)]) {
    assert.ok(ID_PATTERN.test(ok), ok);
  }
  for (const bad of ['', '-lead', 'trail-', 'Has Caps', 'has_underscore', 'has/slash', 'a'.repeat(65)]) {
    assert.ok(!ID_PATTERN.test(bad), `${bad} must be rejected`);
  }
});

test('a digest names its algorithm and carries a full sha256', () => {
  assert.ok(DIGEST_PATTERN.test(`sha256:${'0a'.repeat(32)}`));
  for (const bad of ['0a'.repeat(32), `sha256:${'0a'.repeat(31)}`, `sha256:${'0A'.repeat(32)}`, `md5:${'0a'.repeat(32)}`]) {
    assert.ok(!DIGEST_PATTERN.test(bad), `${bad} must be rejected`);
  }
});
