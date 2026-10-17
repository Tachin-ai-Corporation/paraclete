// Tests for dashboard/lib/client/format.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo, formatBytes, formatDate } from '../../../../dashboard/lib/client/format.js';

const NOW = Date.parse('2027-01-15T12:00:00.000Z');

test('times read relative to now, and missing ones read as nothing', () => {
  assert.equal(timeAgo('2027-01-15T11:59:40Z', NOW), 'just now');
  assert.equal(timeAgo('2027-01-15T11:55:00.000Z', NOW), '5 min ago');
  assert.equal(timeAgo('2027-01-15T09:00:00Z', NOW), '3 h ago');
  assert.equal(timeAgo('2027-01-13T12:00:00Z', NOW), '2 d ago');
  assert.equal(timeAgo('2026-11-01T12:00:00Z', NOW), formatDate('2026-11-01T12:00:00Z'));
  assert.equal(timeAgo(undefined, NOW), '');
  assert.equal(formatDate('not a date'), '');
});

test('sizes read in the largest whole unit', () => {
  assert.equal(formatBytes(820), '820 B');
  assert.equal(formatBytes(12_800), '12.5 KB');
  assert.equal(formatBytes(3_250_000), '3.1 MB');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes('x'), '');
});
