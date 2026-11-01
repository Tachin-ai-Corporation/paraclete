// Tests for agent/organs/temporal-memory/work-recall.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCues, scoreRelevance, searchWork, recentWorkDigest, getWorkOutput,
} from '../../../../agent/organs/temporal-memory/work-recall.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

function makeEnvelope(overrides = {}) {
  return {
    id: 'env-001',
    type: 'M',
    status: 'complete',
    title: 'Deploy the analytics service',
    instruction: 'Run the deploy script for analytics',
    output: 'Deployment succeeded on us-central1',
    created_at: daysAgo(0),
    completed_at: daysAgo(0),
    ...overrides,
  };
}

/** Answers every status query with `docs`, recording the calls. */
function mockFirestoreQuery(docs) {
  const calls = [];
  const query = async (collection, filters, opts) => { calls.push({ collection, filters, opts }); return docs; };
  query.calls = calls;
  return query;
}

/**
 * The work collection with the real query's paging: the status filter, the requested order on
 * created_at, and one page of 300.
 */
function pagedWorkQuery(docs) {
  return async (_collection, filters, opts = {}) => {
    const status = filters.find((f) => f.field === 'status').value.stringValue;
    const dir = opts.orderDirection === 'DESCENDING' ? -1 : 1;
    return docs
      .filter((d) => d.status === status)
      .sort((a, b) => (a.created_at < b.created_at ? -dir : a.created_at > b.created_at ? dir : 0))
      .slice(0, opts.limit || 300);
  };
}

// ── extractCues ───────────────────────────────────────────────────────

describe('extractCues', () => {
  it('removes stopwords', () => {
    const cues = extractCues('the quick brown fox and the lazy dog');
    assert.ok(!cues.includes('the'));
    assert.ok(!cues.includes('and'));
  });

  it('removes tokens shorter than 3 characters', () => {
    const cues = extractCues('go to my big car');
    assert.ok(!cues.includes('go'));
    assert.ok(!cues.includes('to'));
    assert.ok(!cues.includes('my'));
  });

  it('includes pairs of adjacent tokens', () => {
    const cues = extractCues('deploy analytics service');
    assert.ok(cues.includes('deploy'));
    assert.ok(cues.includes('analytics'));
    assert.ok(cues.includes('deploy analytics'));
  });

  it('caps at 8 cues', () => {
    const cues = extractCues('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike');
    assert.ok(cues.length <= 8, `expected <= 8 cues, got ${cues.length}`);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(extractCues(''), []);
    assert.deepEqual(extractCues(null), []);
    assert.deepEqual(extractCues(undefined), []);
  });
});

// ── scoreRelevance ────────────────────────────────────────────────────

describe('scoreRelevance', () => {
  it('scores higher with more term overlap', () => {
    const cues = ['deploy', 'analytics', 'service'];
    const high = scoreRelevance(makeEnvelope({ title: 'Deploy the analytics service' }), cues, NOW);
    const low = scoreRelevance(makeEnvelope({ title: 'Unrelated task about nothing', instruction: '', output: '' }), cues, NOW);
    assert.ok(high > low, `high (${high}) should exceed low (${low})`);
  });

  it('recency modulates the score', () => {
    const cues = ['deploy', 'analytics'];
    const recent = scoreRelevance(makeEnvelope({ created_at: daysAgo(0) }), cues, NOW);
    const old = scoreRelevance(makeEnvelope({ created_at: daysAgo(90) }), cues, NOW);
    assert.ok(recent > old, `recent (${recent}) should exceed old (${old})`);
  });

  it('returns 0 for no cues', () => {
    assert.equal(scoreRelevance(makeEnvelope(), [], NOW), 0);
  });

  it('weights outcomes: complete > blocked > other', () => {
    const cues = ['deploy', 'analytics'];
    const complete = scoreRelevance(makeEnvelope({ status: 'complete' }), cues, NOW);
    const blocked = scoreRelevance(makeEnvelope({ status: 'blocked' }), cues, NOW);
    const other = scoreRelevance(makeEnvelope({ status: 'pending' }), cues, NOW);
    assert.ok(complete > blocked);
    assert.ok(blocked > other);
  });

  it('weights types: M > R > C > other', () => {
    const cues = ['deploy', 'analytics'];
    const [m, r, c, x] = ['M', 'R', 'C', 'X'].map((type) => scoreRelevance(makeEnvelope({ type }), cues, NOW));
    assert.ok(m > r);
    assert.ok(r > c);
    assert.ok(c > x);
  });
});

// ── searchWork ────────────────────────────────────────────────────────

describe('searchWork', () => {
  const docs = [
    makeEnvelope({ id: 'e1', title: 'Deploy analytics service', output: 'Deployed successfully' }),
    makeEnvelope({ id: 'e2', title: 'Update billing dashboard', instruction: 'Update it', output: 'Dashboard updated' }),
    makeEnvelope({ id: 'e3', title: 'Fix login bug', instruction: 'Fix it', output: 'Bug fixed in auth module' }),
    makeEnvelope({ id: 'e4', title: 'Deploy old service', created_at: daysAgo(60) }),
  ];

  it('returns hits ranked by score', async () => {
    const hits = await searchWork({ firestoreQuery: mockFirestoreQuery(docs), cues: ['deploy', 'analytics', 'service'], sinceDays: 30, now: NOW });
    assert.ok(hits.length > 0);
    assert.ok(hits[0].score >= hits[hits.length - 1].score);
  });

  it('drops envelopes outside the window', async () => {
    const hits = await searchWork({ firestoreQuery: mockFirestoreQuery(docs), cues: ['deploy', 'service'], sinceDays: 30, now: NOW });
    assert.ok(!hits.map((h) => h.id).includes('e4'));
  });

  it('drops results below the relevance floor', async () => {
    const hits = await searchWork({ firestoreQuery: mockFirestoreQuery(docs), cues: ['xylophone', 'platypus', 'quasar'], sinceDays: 30, now: NOW });
    assert.equal(hits.length, 0);
  });

  it('keeps only the requested types', async () => {
    const mixed = [makeEnvelope({ id: 'm1' }), makeEnvelope({ id: 't1', type: 'T' })];
    const hits = await searchWork({ firestoreQuery: mockFirestoreQuery(mixed), cues: ['deploy', 'analytics'], types: ['M'], statuses: ['complete'], now: NOW });
    assert.deepEqual(hits.map((h) => h.id), ['m1']);
  });

  it('returns the expected fields, with blurbs of at most 200 characters', async () => {
    const long = [makeEnvelope({ id: 'e9', instruction: `Deploy analytics ${'x'.repeat(500)}`, output: 'y'.repeat(500) })];
    const [h] = await searchWork({ firestoreQuery: mockFirestoreQuery(long), cues: ['deploy', 'analytics'], statuses: ['complete'], now: NOW });
    for (const key of ['id', 'type', 'title', 'instruction_blurb', 'output_blurb', 'status', 'created_at', 'completed_at', 'score', 'matched_cues']) {
      assert.ok(key in h, key);
    }
    assert.equal(h.instruction_blurb.length, 200);
    assert.equal(h.output_blurb.length, 200);
    assert.deepEqual(h.matched_cues, ['deploy', 'analytics']);
  });

  it('recalls all of the agent\'s work: it queries the work collection by status alone', async () => {
    const query = mockFirestoreQuery([makeEnvelope({ id: 'stamped', owner: 'someone@example.com' })]);
    const hits = await searchWork({ firestoreQuery: query, cues: ['deploy', 'analytics'], statuses: ['complete'], now: NOW });
    assert.deepEqual(hits.map((h) => h.id), ['stamped']);
    assert.equal(query.calls[0].collection, COLLECTIONS.work);
    assert.deepEqual(query.calls[0].filters.map((f) => f.field), ['status']);
  });

  it('finds recent work however much older work shares its status', async () => {
    // A status holds envelopes for as long as the agent runs, and one page holds 300. Read oldest
    // first, a busy agent's page held only work from before the window, and recall found nothing.
    const history = [];
    for (let i = 0; i < 400; i++) {
      history.push(makeEnvelope({ id: `old-${i}`, title: 'Deploy analytics service', created_at: daysAgo(400 - i * 0.5) }));
    }
    history.push(makeEnvelope({ id: 'fresh', title: 'Deploy analytics service', created_at: daysAgo(1) }));
    const hits = await searchWork({ firestoreQuery: pagedWorkQuery(history), cues: ['deploy', 'analytics'], statuses: ['complete'], now: NOW });
    assert.ok(hits.map((h) => h.id).includes('fresh'));
  });
});

// ── recentWorkDigest ──────────────────────────────────────────────────

describe('recentWorkDigest', () => {
  it('groups work by day, newest first, citing each id', async () => {
    const docs = [
      makeEnvelope({ id: 'd1', title: 'Task A', completed_at: daysAgo(0) }),
      makeEnvelope({ id: 'd2', title: 'Task B', completed_at: daysAgo(0) }),
      makeEnvelope({ id: 'd3', title: 'Task C', completed_at: daysAgo(1) }),
    ];
    const digest = await recentWorkDigest({ firestoreQuery: mockFirestoreQuery(docs), sinceDays: 7, now: NOW });
    assert.match(digest, /^## Recent Work \(Last 7 Days\) — includes outcomes/);
    assert.ok(digest.indexOf('### 2026-10-17') < digest.indexOf('### 2026-10-16'));
    assert.ok(digest.includes('Task A'));
    assert.ok(digest.includes('Task C'));
    assert.ok(digest.includes('(id:d1)'));
  });

  it('marks every outcome and carries a why-blurb', async () => {
    const docs = [
      makeEnvelope({ id: 'ok1', title: 'Shipped it' }),
      makeEnvelope({ id: 'bad1', title: 'Broke it', status: 'failed', output: '', error: 'PDF text extraction unavailable' }),
      makeEnvelope({ id: 'wait1', title: 'Stuck on it', status: 'blocked', output: 'Waiting on a person' }),
    ];
    const digest = await recentWorkDigest({ firestoreQuery: mockFirestoreQuery(docs), sinceDays: 7, now: NOW });
    assert.ok(digest.includes('[done]'));
    assert.ok(digest.includes('[FAILED]'));
    assert.ok(digest.includes('[blocked]'));
    assert.ok(digest.includes('PDF text extraction unavailable'), 'a failure carries its error');
    assert.ok(digest.includes('Waiting on a person'), 'a block carries its output');
  });

  it('keeps missions and responsibilities only, by default', async () => {
    const docs = [makeEnvelope({ id: 'm1', title: 'Mission' }), makeEnvelope({ id: 't1', type: 'T', title: 'Task detail' })];
    const digest = await recentWorkDigest({ firestoreQuery: mockFirestoreQuery(docs), now: NOW });
    assert.ok(digest.includes('Mission'));
    assert.ok(!digest.includes('Task detail'));
  });

  it('handles no work, and work outside the window', async () => {
    const none = await recentWorkDigest({ firestoreQuery: mockFirestoreQuery([]), sinceDays: 7, now: NOW });
    assert.match(none, /## Recent Work \(Last 7 Days\)/);
    assert.ok(none.includes('No recent work found'));
    const stale = await recentWorkDigest({
      firestoreQuery: mockFirestoreQuery([makeEnvelope({ id: 'stale', title: 'Ancient history', completed_at: daysAgo(30) })]),
      sinceDays: 7,
      now: NOW,
    });
    assert.ok(!stale.includes('Ancient history'));
    assert.ok(stale.includes('No recent work found'));
  });

  it('asks for the newest work first', async () => {
    const query = mockFirestoreQuery([]);
    await recentWorkDigest({ firestoreQuery: query, now: NOW });
    assert.ok(query.calls.every((c) => c.opts.orderBy === 'created_at' && c.opts.orderDirection === 'DESCENDING'));
  });
});

// ── getWorkOutput ─────────────────────────────────────────────────────

describe('getWorkOutput', () => {
  it('reads one envelope\'s full output from the work collection', async () => {
    const reads = [];
    const firestoreRead = async (collection, id) => { reads.push([collection, id]); return makeEnvelope({ id, accept_criteria: 'It deployed.', project_id: 'site' }); };
    const out = await getWorkOutput('w-1', { firestoreRead });
    assert.deepEqual(reads, [[COLLECTIONS.work, 'w-1']]);
    assert.equal(out.output, 'Deployment succeeded on us-central1');
    assert.equal(out.output_chars, 'Deployment succeeded on us-central1'.length);
    assert.equal(out.accept_criteria, 'It deployed.');
    assert.equal(out.project_id, 'site');
  });

  it('is null without an id, a reader or a document', async () => {
    assert.equal(await getWorkOutput('', { firestoreRead: async () => ({}) }), null);
    assert.equal(await getWorkOutput('w-1', {}), null);
    assert.equal(await getWorkOutput('w-1', { firestoreRead: async () => null }), null);
  });
});
