// Tests for dashboard/components/settings/service-health.js: how the status command's answer reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareBuilds, formatDuration, serviceHealth, shortCommit, unhealthyServices,
} from '../../../../dashboard/components/settings/service-health.js';

const running = (heartbeat = null) => ({ service: 'brain', unit: 'paraclete-brain.service', load: 'loaded', active: 'active', sub: 'running', heartbeat });

test('a service is healthy when systemd runs it and its heartbeat, if it writes one, is fresh', () => {
  assert.deepEqual(serviceHealth(running()), { level: 'ok', label: 'running', healthy: true, detail: '' });
  assert.equal(serviceHealth(running({ beat_at: '2027-01-15T08:00:00Z', age_sec: 4, stale: false })).healthy, true);
  const stale = serviceHealth(running({ beat_at: '2027-01-15T08:00:00Z', age_sec: 600, stale: true }));
  assert.equal(stale.healthy, false);
  assert.equal(stale.level, 'warn');
  assert.match(stale.detail, /10 min old/);
  assert.match(serviceHealth(running({ stale: true, age_sec: null })).detail, /missing its time/);
});

test('anything but active and running is unhealthy, and says what systemd shows', () => {
  assert.equal(serviceHealth({ ...running(), active: 'failed', sub: 'failed', result: 'exit-code' }).level, 'danger');
  assert.match(serviceHealth({ ...running(), active: 'failed', sub: 'failed', result: 'exit-code' }).detail, /exit-code/);
  assert.equal(serviceHealth({ ...running(), active: 'activating', sub: 'start' }).level, 'info');
  assert.equal(serviceHealth({ ...running(), active: 'inactive', sub: 'dead' }).label, 'inactive');
  assert.deepEqual(serviceHealth({ service: 'ears', error: 'systemctl failed', heartbeat: null }), { level: 'danger', label: 'unknown', healthy: false, detail: 'systemctl failed' });
  assert.equal(serviceHealth(undefined).healthy, false);
});

test('the unhealthy services come back in the order the services are listed', () => {
  const status = {
    services: {
      gateway: running(),
      brain: { ...running(), active: 'failed', sub: 'failed', result: 'signal' },
      ears: running(),
      mouth: running({ stale: true, age_sec: 90 }),
    },
  };
  assert.deepEqual(unhealthyServices(status).map((s) => s.service), ['brain', 'mouth', 'control']);
});

test('durations, commits and builds read short', () => {
  assert.equal(formatDuration(42), '42 s');
  assert.equal(formatDuration(600), '10 min');
  assert.equal(formatDuration(3 * 3600), '3 h');
  assert.equal(formatDuration(3 * 3600 + 20 * 60), '3 h 20 min');
  assert.equal(formatDuration(4 * 86_400 + 2 * 3600), '4 d 2 h');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(-1), '');
  assert.equal(shortCommit('0123456789abcdef0123456789abcdef01234567'), '0123456');
  assert.equal(shortCommit(null), '');
  assert.equal(compareBuilds({ commit: 'ABC123' }, { commit: 'abc123' }), 'same');
  assert.equal(compareBuilds({ commit: 'abc123' }, { commit: 'def456' }), 'different');
  assert.equal(compareBuilds(null, { commit: 'abc123' }), 'unknown');
  assert.equal(compareBuilds({ commit: 'abc123' }, { commit: '' }), 'unknown');
});
