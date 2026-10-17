// Tests for agent/work/archival.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createArchivalSweeper, DEFAULT_ARCHIVAL_CONFIG } from '../../../agent/work/archival.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();
const ahead = (hours) => new Date(NOW + hours * HOUR).toISOString();

/** A work collection in memory; the sweep's writes land back in it. */
function harness(envelopes, config) {
  const docs = new Map(envelopes.map((e) => [e.id, { ...e }]));
  const writes = [];
  const queries = [];
  const logs = [];
  const sweeper = createArchivalSweeper({
    firestoreQuery: async (collection, filters) => {
      queries.push({ collection, filters });
      const status = filters.find((f) => f.field === 'status').value.stringValue;
      return [...docs.values()].filter((d) => d.status === status).map((d) => ({ ...d }));
    },
    firestoreRead: async (collection, id) => (collection === COLLECTIONS.work && docs.has(id) ? { ...docs.get(id) } : null),
    firestoreWrite: async (collection, id, data) => {
      writes.push({ collection, id, data });
      docs.set(id, { ...data });
    },
    config,
    logger: (level, msg) => logs.push(`${level} ${msg}`),
    clock: () => NOW,
  });
  const statusOf = (id) => docs.get(id).status;
  const doc = (id) => docs.get(id);
  return { sweeper, writes, queries, logs, statusOf, doc };
}

describe('timed waits', () => {
  it('a timed wait is never cancelled before its resume time, however long it has waited', async () => {
    // The defect: a wait the agent set for 24 hours (the maximum) was cancelled after 8, because
    // the sweep judged every waiting envelope by its idle time alone.
    const h = harness([
      { id: 'w-day-wait', type: 'M', status: 'waiting', updated_at: ago(20), wait_resume_at: ahead(4) },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.statusOf('w-day-wait'), 'waiting');
    assert.deepEqual(h.writes, []);
  });

  it('a timed wait past its resume time is left for the brain, with a warning once it is overdue', async () => {
    const h = harness([
      { id: 'w-just-due', type: 'M', status: 'waiting', updated_at: ago(30), wait_resume_at: ago(1) },
      { id: 'w-overdue', type: 'M', status: 'waiting', updated_at: ago(40), wait_resume_at: ago(10) },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.statusOf('w-just-due'), 'waiting');
    assert.equal(h.statusOf('w-overdue'), 'waiting');
    assert.ok(h.logs.some((l) => /WARN Timed wait w-overdue is 10h past its resume time/.test(l)));
    assert.ok(!h.logs.some((l) => /w-just-due/.test(l)));
  });

  it('a wait with no resume time is cancelled once stale, and not before', async () => {
    const h = harness([
      { id: 'w-stale', type: 'M', status: 'waiting', updated_at: ago(9) },
      { id: 'w-fresh', type: 'M', status: 'waiting', updated_at: ago(7) },
      { id: 'w-unreadable', type: 'M', status: 'waiting', updated_at: ago(9), wait_resume_at: 'soon' },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.statusOf('w-stale'), 'cancelled');
    assert.equal(h.doc('w-stale').cancelled_reason, 'Stale waiting >8h');
    assert.equal(h.doc('w-stale').cancelled_at, new Date(NOW).toISOString());
    assert.equal(h.statusOf('w-fresh'), 'waiting');
    assert.equal(h.statusOf('w-unreadable'), 'cancelled', 'an unreadable resume time is no resume time');
  });

  it('the stale-wait timeout is a config value', async () => {
    const h = harness([{ id: 'w-a', type: 'M', status: 'waiting', updated_at: ago(3) }], { waitingTimeoutHours: 2 });
    await h.sweeper.sweep();
    assert.equal(h.doc('w-a').cancelled_reason, 'Stale waiting >2h');
  });
});

describe('archiving finished work', () => {
  it('archives failed and cancelled envelopes once stale', async () => {
    const h = harness([
      { id: 'w-f-old', status: 'failed', created_at: ago(25) },
      { id: 'w-f-new', status: 'failed', created_at: ago(2) },
      { id: 'w-c-old', status: 'cancelled', cancelled_at: ago(25) },
      { id: 'w-c-new', status: 'cancelled', cancelled_at: ago(2) },
    ]);
    const archived = await h.sweeper.sweep();
    assert.equal(archived, 2);
    assert.equal(h.doc('w-f-old').archived_reason, 'stale_failed');
    assert.equal(h.doc('w-f-old').delivery_status, 'delivered');
    assert.equal(h.doc('w-c-old').archived_reason, 'cancelled');
    assert.equal(h.statusOf('w-f-new'), 'failed');
    assert.equal(h.statusOf('w-c-new'), 'cancelled');
  });

  it('archives complete children at once, but never work still waiting for delivery', async () => {
    const h = harness([
      { id: 'w-child', parent_id: 'w-m', status: 'complete', completed_at: ago(0.1) },
      { id: 'w-undelivered', parent_id: 'w-r', status: 'complete', completed_at: ago(48), delivery_status: 'pending' },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.doc('w-child').archived_reason, 'child_complete');
    assert.equal(h.statusOf('w-undelivered'), 'complete');
  });

  it('archives a top-level mission once stale and its lessons are recorded, or after the force age', async () => {
    const h = harness([
      { id: 'w-recorded', status: 'complete', completed_at: ago(25), memory_written: true },
      { id: 'w-unrecorded', status: 'complete', completed_at: ago(25) },
      { id: 'w-ancient', status: 'complete', completed_at: ago(DEFAULT_ARCHIVAL_CONFIG.archiveAgeDays * 24 + 1) },
      { id: 'w-recent', status: 'complete', completed_at: ago(2), memory_written: true },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.doc('w-recorded').archived_reason, 'delivered');
    assert.equal(h.statusOf('w-unrecorded'), 'complete', 'waits for its lessons');
    assert.equal(h.doc('w-ancient').archived_reason, 'delivered_no_memory');
    assert.ok(h.logs.some((l) => /WARN Force-archiving envelope without memory_written: w-ancient/.test(l)));
    assert.equal(h.statusOf('w-recent'), 'complete');
  });

  it('archives unanswered questions and timed-out envelopes', async () => {
    const h = harness([
      { id: 'w-q-old', status: 'needs_input', updated_at: ago(73) },
      { id: 'w-q-new', status: 'needs_input', updated_at: ago(10) },
      { id: 'w-to', status: 'timed_out', updated_at: ago(0.1) },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.doc('w-q-old').archived_reason, 'unanswered');
    assert.equal(h.statusOf('w-q-new'), 'needs_input');
    assert.equal(h.doc('w-to').archived_reason, 'timed_out');
  });

  it('never archives or cancels blocked or queued work that still has a live parent or none', async () => {
    const h = harness([
      { id: 'w-blocked', type: 'M', status: 'blocked', updated_at: ago(500) },
      { id: 'w-queued', type: 'M', status: 'queued', updated_at: ago(500) },
      { id: 'w-m', type: 'M', status: 'active', updated_at: ago(1) },
      { id: 'w-blocked-child', type: 'C', parent_id: 'w-m', status: 'blocked', updated_at: ago(500) },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.statusOf('w-blocked'), 'blocked', 'a blocked mission waits for a person');
    assert.equal(h.statusOf('w-queued'), 'queued');
    assert.equal(h.statusOf('w-blocked-child'), 'blocked');
  });
});

describe('cancelling work that can no longer progress', () => {
  it('cancels an active envelope idle past the timeout', async () => {
    const h = harness([
      { id: 'w-stuck', type: 'M', status: 'active', updated_at: ago(13) },
      { id: 'w-busy', type: 'M', status: 'active', updated_at: ago(1) },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.doc('w-stuck').cancelled_reason, 'Stale active >12h');
    assert.equal(h.statusOf('w-busy'), 'active');
  });

  it('cancels children whose parent is cancelled, archived, failed or gone', async () => {
    const h = harness([
      { id: 'w-dead', type: 'M', status: 'failed', created_at: ago(1) },
      { id: 'w-live', type: 'M', status: 'active', updated_at: ago(1) },
      { id: 'w-c1', type: 'C', parent_id: 'w-dead', status: 'pending' },
      { id: 'w-c2', type: 'C', parent_id: 'w-missing', status: 'queued' },
      { id: 'w-c3', type: 'C', parent_id: 'w-dead', status: 'waiting', updated_at: ago(1), wait_resume_at: ahead(2) },
      { id: 'w-c4', type: 'C', parent_id: 'w-live', status: 'active', updated_at: ago(1) },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.doc('w-c1').cancelled_reason, 'Parent w-dead is failed');
    assert.equal(h.doc('w-c2').cancelled_reason, 'Parent w-missing not found');
    assert.equal(h.statusOf('w-c3'), 'cancelled', 'a timed wait under a dead parent waits for nothing');
    assert.equal(h.statusOf('w-c4'), 'active');
  });

  it('an envelope cancelled earlier in the sweep is not cancelled again as an orphan', async () => {
    const h = harness([
      { id: 'w-stuck-child', type: 'C', parent_id: 'w-missing', status: 'active', updated_at: ago(13) },
    ]);
    await h.sweeper.sweep();
    assert.equal(h.writes.filter((w) => w.id === 'w-stuck-child').length, 1);
    assert.equal(h.doc('w-stuck-child').cancelled_reason, 'Stale active >12h');
  });
});

describe('the sweep itself', () => {
  it('queries only the work collection, by status', async () => {
    const h = harness([]);
    await h.sweeper.sweep();
    assert.ok(h.queries.length > 0);
    assert.ok(h.queries.every((q) => q.collection === COLLECTIONS.work));
    assert.ok(h.writes.every((w) => w.collection === COLLECTIONS.work));
  });

  it('a store failure ends the sweep with a warning instead of throwing', async () => {
    const logs = [];
    const sweeper = createArchivalSweeper({
      firestoreQuery: async () => { throw new Error('HTTP 503'); },
      firestoreRead: async () => null,
      firestoreWrite: async () => {},
      logger: (level, msg) => logs.push(`${level} ${msg}`),
      clock: () => NOW,
    });
    assert.equal(await sweeper.sweep(), 0);
    assert.ok(logs.some((l) => /WARN Archival sweep error: HTTP 503/.test(l)));
  });

  it('startSchedule starts one interval and stopSchedule stops it', () => {
    const h = harness([]);
    h.sweeper.startSchedule(HOUR);
    h.sweeper.startSchedule(HOUR);
    assert.equal(h.logs.filter((l) => /scheduled every 1h/.test(l)).length, 1);
    h.sweeper.stopSchedule();
  });
});
