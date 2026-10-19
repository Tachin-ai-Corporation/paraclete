// Tests for agent/work/scheduler.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatch, fieldMatches, cronNextFire, createScheduler } from '../../../agent/work/scheduler.mjs';
import { DEFAULT_POLICY } from '../../../agent/work/responsibility-store.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

// ── Fakes ─────────────────────────────────────────────────────────────

/** Reads a dotted field path, as a Firestore filter does. */
const fieldOf = (doc, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
const plain = (value) => value.stringValue ?? value.integerValue ?? value.booleanValue;

/**
 * An in-memory work collection with the real query's paging: EQUAL and IN filters, document-name
 * order under noOrderBy, and a limit (300 by default), so the oldest documents come first.
 */
function fakeWorkQuery(docs) {
  const calls = [];
  const query = async (collection, filters, opts = {}) => {
    calls.push({ collection, filters, opts });
    const matches = docs.filter((d) => filters.every((f) => {
      const v = fieldOf(d, f.field);
      if (f.op === 'EQUAL') return v === plain(f.value);
      if (f.op === 'IN') return f.value.arrayValue.values.map(plain).includes(v);
      throw new Error(`fake query: unsupported op ${f.op}`);
    }));
    return matches.sort((a, b) => a.id.localeCompare(b.id)).slice(0, opts.limit || 300);
  };
  return { query, calls };
}

/**
 * A scheduler over installed defaults, recording each mission it creates.
 *
 * @param {object[]} responsibilities - the generic role's responsibilities
 * @param {object} [extra] - more scheduler deps
 */
function harness(responsibilities, extra = {}) {
  const missions = []; // responsibility id of each mission created
  const missionDocs = []; // the first write of each M, as written
  const written = []; // every work write
  const logs = [];
  let n = 0;
  const s = createScheduler({
    logger: (level, msg) => logs.push(`${level} ${msg}`),
    generateId: (p) => `${p}-${++n}`,
    writeHistory: async () => {},
    recallMemory: async () => ({}),
    processEnvelope: async () => {},
    firestoreWrite: async (col, _id, doc) => {
      if (col !== COLLECTIONS.work) return;
      written.push(structuredClone(doc));
      // fireResponsibility writes each M twice (created, then with recalled memory); count the first.
      if (doc.type === 'M' && doc.memory_context === null) {
        missions.push(doc.source_meta.responsibility_id);
        missionDocs.push(structuredClone(doc));
      }
    },
    defaults: [{ source: 'generic', responsibilities }],
    ...extra,
  });
  s.loadResponsibilities();
  const firesAt = async (iso) => {
    const before = missions.length;
    await s.tick(new Date(iso));
    return missions.length - before;
  };
  return { s, logs, firesAt, missions, missionDocs, written, done: () => s.stop() };
}

const startAt = (h, iso) => { h.s.start(new Date(iso)); h.s.stop(); };

// ── fieldMatches ──────────────────────────────────────────────────────

describe('fieldMatches', () => {
  it('a wildcard matches any value, zero included', () => {
    assert.equal(fieldMatches('*', 5, 0, 59), true);
    assert.equal(fieldMatches('*', 0, 0, 59), true);
  });

  it('a step */N matches multiples of N only', () => {
    assert.equal(fieldMatches('*/5', 0, 0, 59), true);
    assert.equal(fieldMatches('*/5', 5, 0, 59), true);
    assert.equal(fieldMatches('*/5', 3, 0, 59), false);
    assert.equal(fieldMatches('*/15', 30, 0, 59), true);
    assert.equal(fieldMatches('*/15', 7, 0, 59), false);
  });

  it('an exact value matches only itself', () => {
    assert.equal(fieldMatches('5', 5, 0, 59), true);
    assert.equal(fieldMatches('5', 6, 0, 59), false);
  });

  it('a list matches its members only', () => {
    assert.equal(fieldMatches('1,5,10', 5, 0, 59), true);
    assert.equal(fieldMatches('1,5,10', 3, 0, 59), false);
  });

  it('a range is inclusive at both ends', () => {
    assert.equal(fieldMatches('1-5', 3, 0, 59), true);
    assert.equal(fieldMatches('1-5', 6, 0, 59), false);
    assert.equal(fieldMatches('1-5', 1, 0, 59), true);
    assert.equal(fieldMatches('1-5', 5, 0, 59), true);
  });
});

// ── cronMatch ─────────────────────────────────────────────────────────

describe('cronMatch', () => {
  it('matches minute and hour', () => {
    assert.equal(cronMatch('* * * * *', new Date('2026-01-15T08:30:00Z')), true);
    assert.equal(cronMatch('30 8 * * *', new Date('2026-01-15T08:30:00Z')), true);
    assert.equal(cronMatch('0 8 * * *', new Date('2026-01-15T08:30:00Z')), false);
    assert.equal(cronMatch('0 0 * * *', new Date('2026-06-11T00:00:00Z')), true);
  });

  it('February 31st never matches', () => {
    assert.equal(cronMatch('0 0 31 2 *', new Date('2026-02-15T00:00:00Z')), false);
  });

  it('every five minutes matches multiples of five only', () => {
    assert.equal(cronMatch('*/5 * * * *', new Date('2026-01-15T08:15:00Z')), true);
    assert.equal(cronMatch('*/5 * * * *', new Date('2026-01-15T08:13:00Z')), false);
  });

  it('matches the declared local time in CDT (UTC-5)', () => {
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T15:15:00Z'), 'America/Chicago'), true);
  });

  it('keeps the local time across the daylight-saving change (CST, UTC-6)', () => {
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-11-05T16:15:00Z'), 'America/Chicago'), true);
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-11-05T15:15:00Z'), 'America/Chicago'), false,
      'a schedule baked into UTC would fire here, an hour early, once daylight saving ended');
  });

  it('reads the day of week in the zone, not in UTC', () => {
    // 02:00Z on the 25th is Friday in UTC, still Thursday 21:00 in Chicago.
    assert.equal(cronMatch('0 21 * * 4', new Date('2026-09-25T02:00:00Z'), 'America/Chicago'), true);
    assert.equal(cronMatch('0 21 * * 4', new Date('2026-09-25T02:00:00Z')), false);
  });

  it('with no zone, or UTC, the expression is UTC', () => {
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T10:15:00Z')), true);
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T10:15:00Z'), 'UTC'), true);
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T15:15:00Z')), false);
  });

  it('an unknown zone throws rather than guessing', () => {
    assert.throws(() => cronMatch('* * * * *', new Date(), 'Mars/Olympus_Mons'), RangeError);
  });
});

// ── cronNextFire ──────────────────────────────────────────────────────

describe('cronNextFire', () => {
  it('returns a Date for an every-minute expression and null for February 31st', () => {
    assert.ok(cronNextFire('* * * * *') instanceof Date);
    assert.equal(cronNextFire('0 0 31 2 *'), null);
  });

  // The horizon was 48 hours, shorter than a week: right after a weekly slot the next one was "not
  // found", and the tick loop treated that as never.
  it('finds the next weekly slot from right after the previous one', () => {
    const next = cronNextFire('30 15 * * 4', 'UTC', new Date('2026-09-17T15:30:00Z'));
    assert.equal(next?.toISOString(), '2026-09-24T15:30:00.000Z');
  });

  it('scans from the given instant, starting at the next minute', () => {
    const next = cronNextFire('* * * * *', 'UTC', new Date('2026-09-24T10:00:30Z'));
    assert.equal(next?.toISOString(), '2026-09-24T10:01:00.000Z');
  });

  it('still returns null past the horizon (a monthly slot 30 days out)', () => {
    assert.equal(cronNextFire('0 9 1 * *', 'UTC', new Date('2026-09-01T09:00:00Z')), null);
  });

  it('a zoned weekly slot lands on the right UTC instant on both sides of daylight saving', () => {
    // 10:15 Central: CDT (UTC-5) until 2026-11-01, CST (UTC-6) after.
    assert.equal(
      cronNextFire('15 10 * * 4', 'America/Chicago', new Date('2026-09-24T16:00:00Z'))?.toISOString(),
      '2026-10-01T15:15:00.000Z');
    assert.equal(
      cronNextFire('15 10 * * 4', 'America/Chicago', new Date('2026-10-29T16:00:00Z'))?.toISOString(),
      '2026-11-05T16:15:00.000Z');
  });
});

// ── Installed defaults ────────────────────────────────────────────────

describe('loadResponsibilities: the installed defaults', () => {
  const make = (packages) => {
    const s = createScheduler({ defaults: packages, logger: () => {} });
    s.loadResponsibilities();
    return s;
  };

  it('loads every installed package, not just the first', () => {
    const s = make([
      { source: 'generic', responsibilities: [{ id: 'r-base' }] },
      { source: 'devops', responsibilities: [{ id: 'r-sync-health-nightly' }] },
    ]);
    assert.deepEqual(s.getResponsibilities().map((r) => r.id), ['r-base', 'r-sync-health-nightly']);
  });

  it('keeps the generic role authoritative on an id collision (first package wins)', () => {
    const s = make([
      { source: 'generic', responsibilities: [{ id: 'r-dup', name: 'from-generic' }] },
      { source: 'devops', responsibilities: [{ id: 'r-dup', name: 'from-role' }] },
    ]);
    const list = s.getResponsibilities();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'from-generic');
  });

  it('takes the packages as an argument too, and tolerates a role with none', () => {
    const s = createScheduler({ logger: () => {} });
    s.loadResponsibilities([{ source: 'generic', responsibilities: [{ id: 'r-only' }] }, { source: 'qa' }]);
    assert.deepEqual(s.getResponsibilities().map((r) => r.id), ['r-only']);
  });
});

// ── The tick loop ─────────────────────────────────────────────────────

describe('tick: long-period schedules stay armed', () => {
  it('a weekly responsibility fires on consecutive weeks without a restart', async () => {
    const h = harness([{ id: 'r-weekly', name: 'Weekly', schedule: '30 15 * * 4', enabled: true, min_spacing_minutes: 1440 }]);
    try {
      startAt(h, '2026-09-11T12:00:00Z'); // a Friday: the next slot is 6 days out
      assert.equal(h.s.getNextFires()['r-weekly']?.toISOString(), '2026-09-17T15:30:00.000Z',
        'armed at start; with the 48h horizon this was null');
      assert.equal(await h.firesAt('2026-09-17T15:30:20Z'), 1, 'week 1');
      assert.equal(h.s.getNextFires()['r-weekly']?.toISOString(), '2026-09-24T15:30:00.000Z',
        'firing re-arms a week out; this is the step that used to go null');
      assert.equal(await h.firesAt('2026-09-24T15:29:20Z'), 0, 'not before its minute');
      assert.equal(await h.firesAt('2026-09-24T15:30:20Z'), 1, 'week 2');
    } finally { h.done(); }
  });

  it('a min-spacing skip re-arms the following week', async () => {
    const h = harness([{ id: 'r-weekly', name: 'Weekly', schedule: '30 15 * * 4', enabled: true, min_spacing_minutes: 20000 }]);
    try {
      startAt(h, '2026-09-11T12:00:00Z');
      assert.equal(await h.firesAt('2026-09-17T15:30:20Z'), 1);
      assert.equal(await h.firesAt('2026-09-24T15:30:20Z'), 0, 'inside min spacing: skipped');
      assert.ok(h.logs.some((l) => l.includes('r-weekly skipped (min spacing')));
      assert.equal(h.s.getNextFires()['r-weekly']?.toISOString(), '2026-10-01T15:30:00.000Z',
        'the skip must re-arm a week out, not to null');
      assert.equal(await h.firesAt('2026-10-01T15:30:20Z'), 1);
    } finally { h.done(); }
  });

  it('a slot beyond the horizon is armed as it comes into range (monthly)', async () => {
    const h = harness([{ id: 'r-monthly', name: 'Monthly', schedule: '0 9 1 * *', enabled: true }]);
    try {
      startAt(h, '2026-09-01T09:30:00Z');
      assert.equal(h.s.getNextFires()['r-monthly'], null, 'Oct 1 is 30 days out, beyond the horizon at start');
      assert.equal(await h.firesAt('2026-09-24T09:00:00Z'), 0);
      assert.equal(h.s.getNextFires()['r-monthly']?.toISOString(), '2026-10-01T09:00:00.000Z',
        'a null next-fire is re-armed, not skipped forever');
      assert.equal(await h.firesAt('2026-10-01T09:00:20Z'), 1);
    } finally { h.done(); }
  });

  it('an event-only responsibility (no schedule) is left to fireEvent, not crashed on', () => {
    const h = harness([{ id: 'r-event', name: 'Event', event: 'on_failure', enabled: true }]);
    try {
      assert.doesNotThrow(() => startAt(h, '2026-09-24T10:00:00Z'));
      assert.equal(h.s.getNextFires()['r-event'], undefined);
    } finally { h.done(); }
  });
});

describe('tick: the declared timezone is honored', () => {
  it('a zoned weekly responsibility fires at its local time on both sides of daylight saving', async () => {
    const h = harness([{ id: 'r-exec', name: 'Exec', schedule: '15 10 * * 4', timezone: 'America/Chicago', enabled: true }]);
    try {
      startAt(h, '2026-10-23T12:00:00Z');
      assert.equal(await h.firesAt('2026-10-29T10:15:20Z'), 0, '10:15 UTC is not 10:15 Central');
      assert.equal(await h.firesAt('2026-10-29T15:15:20Z'), 1, 'CDT: 10:15 local = 15:15Z');
      assert.equal(await h.firesAt('2026-11-05T15:15:20Z'), 0, 'after daylight saving ends, 15:15Z is 09:15 local');
      assert.equal(await h.firesAt('2026-11-05T16:15:20Z'), 1, 'CST: 10:15 local = 16:15Z');
    } finally { h.done(); }
  });

  it('an unknown timezone schedules in UTC with a warning instead of breaking the loop', async () => {
    const h = harness([{ id: 'r-typo', name: 'Typo', schedule: '0 12 * * *', timezone: 'America/Chicgo', enabled: true }]);
    try {
      startAt(h, '2026-09-24T10:00:00Z');
      assert.equal(h.s.getNextFires()['r-typo']?.toISOString(), '2026-09-24T12:00:00.000Z');
      assert.ok(h.logs.some((l) => l.startsWith('WARN') && l.includes("unknown timezone 'America/Chicgo'")));
      assert.equal(await h.firesAt('2026-09-24T12:00:20Z'), 1);
    } finally { h.done(); }
  });
});

// ── What a firing writes ──────────────────────────────────────────────

describe('a firing creates the R envelope and its mission', () => {
  it('the mission is parented on the R, in the default project, from the scheduler channel', async () => {
    const h = harness([{ id: 'r-w', name: 'W', schedule: '0 8 * * *', enabled: true, instruction: 'Do the work.', success_criteria: 'The work was done and reported.' }],
      { getDefaultProjectId: () => 'general' });
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1);
      const R = h.written.find((d) => d.type === 'R');
      const [M] = h.missionDocs;
      assert.equal(R.status, 'complete');
      assert.equal(M.parent_id, R.id);
      assert.equal(M.status, 'pending');
      assert.equal(M.project_id, 'general');
      assert.equal(M.source_channel, 'scheduler');
      assert.equal(M.accept_criteria, 'The work was done and reported.');
      assert.match(M.context_summary, /SUCCESS CRITERIA: The work was done and reported\./);
      assert.equal('owner' in M, false, 'one project holds one agent: work carries no owner');
    } finally { h.done(); }
  });

  it('carries the learnings overlay after the authored learnings', async () => {
    const h = harness([{ id: 'r-l', name: 'L', schedule: '0 8 * * *', enabled: true, instruction: 'Learn.', context: { prior_learnings: 'Authored lesson.' } }], {
      firestoreRead: async (col, id) => (col === COLLECTIONS.responsibilityState && id === 'r-l' ? { prior_learnings: '2026-09-20: overlay lesson.' } : null),
    });
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      await h.firesAt('2026-09-24T08:00:20Z');
      assert.match(h.missionDocs[0].context_summary, /PRIOR LEARNINGS: Authored lesson\.\n2026-09-20: overlay lesson\./);
    } finally { h.done(); }
  });
});

describe('effect scope is stamped onto what fires', () => {
  const fire = async (resp) => {
    const h = harness([resp]);
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      await h.s.tick(new Date('2026-09-24T08:00:20Z'));
    } finally { h.done(); }
    return { R: h.written.find((d) => d.type === 'R'), M: h.written.find((d) => d.type === 'M') };
  };

  it('a memory responsibility puts effect_scope on both R and M, and the planner is told', async () => {
    const { R, M } = await fire({ id: 'r-mem', name: 'Mem', schedule: '0 8 * * *', enabled: true, effect_scope: 'memory', instruction: 'Consolidate.' });
    assert.equal(R?.source_meta?.effect_scope, 'memory');
    assert.equal(M?.source_meta?.effect_scope, 'memory');
    assert.match(M.context_summary, /EFFECT SCOPE: memory/);
  });

  it('a world responsibility carries no scope', async () => {
    const { M } = await fire({ id: 'r-w', name: 'W', schedule: '0 8 * * *', enabled: true, instruction: 'Do work.' });
    assert.ok(M, 'fired');
    assert.equal('effect_scope' in (M.source_meta || {}), false);
    assert.doesNotMatch(M.context_summary || '', /EFFECT SCOPE/);
  });
});

describe('processRef is honored', () => {
  const PLAYBOOK = { id: 'p-probe', name: 'Probe Playbook', narrative: 'Gather first, then synthesize from the full notes.', status: 'active' };
  const resp = { id: 'r-pb', name: 'PB', schedule: '0 8 * * *', enabled: true, processRef: 'p-probe', instruction: 'Do the thing.' };

  it('carries the playbook narrative into the mission as its planning prior, and stamps it for the lesson', async () => {
    const h = harness([resp], { getProcess: async (id) => (id === 'p-probe' ? PLAYBOOK : null) });
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1);
      const [m] = h.missionDocs;
      assert.match(m.context_summary, /PLAYBOOK — Probe Playbook \(p-probe\): Gather first, then synthesize from the full notes\./);
      assert.equal(m.source_meta.process_ref, 'p-probe');
      assert.deepEqual(m.recalled_processes, ['p-probe']);
    } finally { h.done(); }
  });

  it('a missing or retired playbook degrades to context.process alone, loudly', async () => {
    for (const found of [null, { ...PLAYBOOK, status: 'deprecated' }, { ...PLAYBOOK, narrative: '' }]) {
      const h = harness([resp], { getProcess: async () => found });
      try {
        startAt(h, '2026-09-24T07:00:00Z');
        assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1, 'still fires');
        const [m] = h.missionDocs;
        assert.doesNotMatch(m.context_summary || '', /PLAYBOOK —/);
        assert.equal('process_ref' in m.source_meta, false);
        assert.ok(h.logs.some((l) => l.startsWith('WARN') && l.includes("processRef 'p-probe'")));
      } finally { h.done(); }
    }
  });

  it('with no process registry wired, it fires without one', async () => {
    const h = harness([resp]);
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1);
      assert.equal('recalled_processes' in h.missionDocs[0], false);
    } finally { h.done(); }
  });
});

// ── The singleton guard ───────────────────────────────────────────────

describe('the singleton guard sees the running cycle however long the history', () => {
  // A nightly responsibility after a year: hundreds of finished missions, and every checkpoint and
  // task under them, all carry the responsibility id. The running mission is the newest.
  function history(id, finished) {
    const docs = [];
    for (let i = 0; i < finished; i += 1) {
      const n = String(i).padStart(4, '0');
      docs.push({ id: `w-${n}-m`, type: 'M', status: 'archived', source_meta: { responsibility_id: id } });
      docs.push({ id: `w-${n}-c`, type: 'C', status: 'archived', source_meta: { responsibility_id: id } });
    }
    docs.push({ id: 'w-9999-m', type: 'M', status: 'active', source_meta: { responsibility_id: id } });
    return docs;
  }
  const consolidation = { id: 'r-memory-consolidation', name: 'Consolidation', schedule: '0 8 * * *', enabled: true, singleton: true, instruction: 'Consolidate memory.' };

  it('the old query (the id alone) would have paged out the running mission', async () => {
    const { query } = fakeWorkQuery(history('r-memory-consolidation', 400));
    const page = await query(COLLECTIONS.work, [
      { field: 'source_meta.responsibility_id', op: 'EQUAL', value: { stringValue: 'r-memory-consolidation' } },
    ], { noOrderBy: true });
    assert.equal(page.length, 300);
    assert.equal(page.some((d) => d.status === 'active'), false, 'this is the defect the guard query fixes');
  });

  it('the clock does not start a second cycle', async () => {
    const fake = fakeWorkQuery(history('r-memory-consolidation', 400));
    const h = harness([consolidation], { firestoreQuery: fake.query });
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 0);
      assert.ok(h.logs.some((l) => /singleton guard, cycle in progress \(w-9999-m\)/.test(l)));
      assert.equal(h.s.getNextFires()['r-memory-consolidation']?.toISOString(), '2026-09-25T08:00:00.000Z', 'sleeps to the next slot');
      assert.equal(fake.calls[0].collection, COLLECTIONS.work);
    } finally { h.done(); }
  });

  it('an on-demand run is refused too', async () => {
    const fake = fakeWorkQuery(history('r-memory-consolidation', 400));
    const h = harness([consolidation], { firestoreQuery: fake.query });
    try {
      const r = await h.s.fireById('r-memory-consolidation', { bypassSpacing: true });
      assert.equal(r.ok, false);
      assert.equal(r.skipped, true);
      assert.match(r.error, /already in progress \(w-9999-m\)/);
    } finally { h.done(); }
  });

  it('finished history alone does not block', async () => {
    const docs = history('r-memory-consolidation', 50).filter((d) => d.status !== 'active');
    const h = harness([consolidation], { firestoreQuery: fakeWorkQuery(docs).query });
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1);
    } finally { h.done(); }
  });

  it('a failed check proceeds rather than stopping scheduled work', async () => {
    const h = harness([consolidation], { firestoreQuery: async () => { throw new Error('HTTP 503'); } });
    try {
      startAt(h, '2026-09-24T07:00:00Z');
      assert.equal(await h.firesAt('2026-09-24T08:00:20Z'), 1);
      assert.ok(h.logs.some((l) => /singleton check failed \(HTTP 503\), proceeding/.test(l)));
    } finally { h.done(); }
  });
});

describe('fireById', () => {
  const resp = { id: 'r-now', name: 'Now', schedule: '0 8 * * *', enabled: true, instruction: 'Run now.', min_spacing_minutes: 60 };

  it('fires detached and reports what it started', async () => {
    const h = harness([resp]);
    try {
      const r = await h.s.fireById('r-now', { source: 'dashboard' });
      assert.equal(r.ok, true);
      assert.equal(r.name, 'Now');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(h.missions, ['r-now']);
      assert.ok(h.logs.some((l) => l.includes('responsibility_triggered id=r-now source=dashboard')));
    } finally { h.done(); }
  });

  it('honors min spacing unless bypassed, and refuses unknown or disabled responsibilities', async () => {
    let t = Date.parse('2026-09-24T08:00:00Z');
    const h = harness([resp, { ...resp, id: 'r-off', enabled: false }], { clock: () => t });
    try {
      assert.equal((await h.s.fireById('r-now')).ok, true);
      t += 10 * 60_000;
      const again = await h.s.fireById('r-now');
      assert.equal(again.skipped, true);
      assert.match(again.error, /min spacing \(60m\)/);
      assert.equal((await h.s.fireById('r-now', { bypassSpacing: true })).ok, true);
      assert.match((await h.s.fireById('r-missing')).error, /not found/);
      assert.match((await h.s.fireById('r-off')).error, /disabled/);
      assert.equal((await h.s.fireById('r-off', { force: true })).ok, true);
    } finally { h.done(); }
  });
});

// ── The agent's own store, without a restart ──────────────────────────

describe('the scheduler runs the agent\'s store without a restart', () => {
  const exec = () => ({
    id: 'r-exec', name: 'Weekly Exec', schedule: '15 10 * * 4', timezone: 'America/Chicago', enabled: true, singleton: true,
    instruction: 'Produce this week\'s executive update from the meeting notes.',
    success_criteria: 'One doc for this week exists and its sections were read back.',
    context: { purpose: 'Run the weekly exec sync.', process: ['gather', 'synthesize', 'deliver'] },
  });
  const own = (over = {}) => ({
    id: 'r-standup', name: 'Standup digest', schedule: '0 9 * * 1-5', timezone: 'UTC', enabled: true,
    instruction: 'Post a digest of yesterday\'s work to the dashboard.',
    success_criteria: 'A digest was posted and names each finished item.',
    context: { purpose: 'Keep everyone current.', process: ['read the ledger', 'write the digest', 'post it'] },
    ...over,
  });
  const storeHarness = (defaults, loadStore) => harness(defaults, { loadStore, policy: { ...DEFAULT_POLICY, refresh_ms: 60_000 } });

  it('an override written after start moves the fire time within one refresh', async () => {
    let docs = [];
    const h = storeHarness([exec()], async () => docs);
    try {
      startAt(h, '2026-09-26T12:00:00Z');
      await h.s.refreshStore(new Date('2026-09-26T12:00:00Z'), { force: true });
      assert.equal(h.s.getNextFires()['r-exec'].toISOString(), '2026-10-01T15:15:00.000Z');
      docs = [{ id: 'r-exec', mode: 'override', status: 'active', revision: 1, updated_by: 'agent', patch: { schedule: '20 10 * * 4' } }];
      await h.s.tick(new Date('2026-09-26T12:05:00Z'));
      assert.equal(h.s.getNextFires()['r-exec'].toISOString(), '2026-10-01T15:20:00.000Z', 'no restart, no upgrade');
      assert.equal(await h.firesAt('2026-10-01T15:20:20Z'), 1);
      assert.equal(h.missionDocs[0].source_meta.responsibility_origin, 'override');
      assert.equal(h.missionDocs[0].source_meta.responsibility_revision, 1, 'the work records the revision that produced it');
    } finally { h.done(); }
  });

  it('a responsibility the agent creates is armed and fires, even with no installed defaults', async () => {
    const docs = [{ id: 'r-standup', mode: 'own', status: 'active', revision: 1, updated_by: 'agent', body: own() }];
    const h = storeHarness([], async () => docs);
    try {
      startAt(h, '2026-09-28T08:00:00Z');
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      assert.equal(h.s.getNextFires()['r-standup'].toISOString(), '2026-09-28T09:00:00.000Z');
      assert.equal(await h.firesAt('2026-09-28T09:00:20Z'), 1);
      assert.equal(h.missionDocs[0].source_meta.responsibility_origin, 'agent');
    } finally { h.done(); }
  });

  it('an unreadable store keeps the last good set', async () => {
    let failing = false;
    const docs = [{ id: 'r-standup', mode: 'own', status: 'active', revision: 1, updated_by: 'agent', body: own() }];
    const h = storeHarness([], async () => { if (failing) throw new Error('HTTP 503'); return docs; });
    try {
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      failing = true;
      await h.s.refreshStore(new Date('2026-09-28T08:05:00Z'), { force: true });
      assert.deepEqual(h.s.getResponsibilities().map((r) => r.id), ['r-standup'], 'an outage is not "no responsibilities"');
      assert.ok(h.logs.some((l) => /store unreadable .*keeping the last good set/.test(l)));
    } finally { h.done(); }
  });

  it('changing one responsibility does not re-arm the others (a due slot is never dropped)', async () => {
    let docs = [];
    const other = { ...exec(), id: 'r-daily', schedule: '0 9 * * *', timezone: 'UTC' };
    const h = storeHarness([exec(), other], async () => docs);
    try {
      startAt(h, '2026-09-28T08:59:00Z');
      await h.s.refreshStore(new Date('2026-09-28T08:59:00Z'), { force: true });
      // r-daily came due at 09:00; before the tick that would fire it, an unrelated edit lands.
      docs = [{ id: 'r-exec', mode: 'override', status: 'active', revision: 1, updated_by: 'agent', patch: { enabled: false } }];
      await h.s.refreshStore(new Date('2026-09-28T09:00:30Z'), { force: true });
      assert.equal(h.s.getNextFires()['r-daily'].toISOString(), '2026-09-28T09:00:00.000Z', 'still armed for the slot that is due');
      await h.s.tick(new Date('2026-09-28T09:00:40Z'));
      assert.deepEqual(h.missions, ['r-daily']);
    } finally { h.done(); }
  });

  it('an event responsibility fires from the effective set, including the agent\'s own', async () => {
    const docs = [{ id: 'r-on-fail', mode: 'own', status: 'active', revision: 1, updated_by: 'agent', body: own({ id: 'r-on-fail', schedule: null, event: 'on_failure' }) }];
    const h = storeHarness([], async () => docs);
    try {
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      await h.s.fireEvent('on_failure', { mission_id: 'w-1' });
      assert.deepEqual(h.missions, ['r-on-fail']);
      assert.equal(h.missionDocs[0].source_meta.fired_by_event, 'on_failure');
    } finally { h.done(); }
  });

  it('an installed responsibility that leaves out `enabled` fires, as its schema default says', async () => {
    const { enabled, ...noFlag } = own({ id: 'r-on-fail', schedule: null, event: 'on_failure' });
    assert.equal(enabled, true);
    const h = storeHarness([noFlag], async () => []);
    try {
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      await h.s.fireEvent('on_failure', { mission_id: 'w-1' });
      assert.deepEqual(h.missions, ['r-on-fail'], 'it fired from its event, as it fires when run now');
    } finally { h.done(); }
  });

  it('an on_complete responsibility cannot loop on its own missions, and events are spaced', async () => {
    const docs = [{ id: 'r-after', mode: 'own', status: 'active', revision: 1, updated_by: 'agent', body: own({ id: 'r-after', schedule: null, event: 'on_complete', min_spacing_minutes: 0 }) }];
    const h = storeHarness([], async () => docs);
    try {
      await h.s.refreshStore(new Date('2026-09-28T08:00:00Z'), { force: true });
      await h.s.fireEvent('on_complete', { mission_id: 'w-user' });
      assert.equal(h.missions.length, 1, 'a person\'s mission completing fires it');
      // Its own mission completes: the brain passes where that mission came from.
      await h.s.fireEvent('on_complete', { mission_id: 'w-2', responsibility_id: 'r-after', fired_by_event: 'on_complete' });
      assert.equal(h.missions.length, 1, 'no chain from an event-fired mission');
      await h.s.fireEvent('on_complete', { mission_id: 'w-user-2' });
      assert.equal(h.missions.length, 1, 'the floor spaces events even when min_spacing_minutes is 0');
      assert.ok(h.logs.some((l) => /skipping .* min 15m/.test(l)));
    } finally { h.done(); }
  });
});
