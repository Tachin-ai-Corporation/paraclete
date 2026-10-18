// Tests for roles/finance-analyst/skills/billing-analysis/billing-query.mjs: only one read-only
// statement reaches BigQuery; every query is dry-run first and refused over the byte cap; the real
// query carries the cap as maximumBytesBilled; a slow job is waited on and every page read; rows come
// out as CSV or JSON with records, timestamps and nulls decoded; BigQuery's refusals become messages
// that say what to grant or fix. BigQuery is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as billingQuery from '../../../../../roles/finance-analyst/skills/billing-analysis/billing-query.mjs';

const { readOnlyProblem, decodeRow, toCsv, formatBytes, DEADLINE_MS } = billingQuery;
const PROJECT = 'your-gcp-project';
const QUERY_URL = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`;

function sink() {
  let text = '';
  return { write(chunk) { text += String(chunk); return true; }, text: () => text };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake fetch answering each call with `respond({ method, url, body })`, recording the calls. */
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { method: init.method || 'GET', url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers };
    calls.push(call);
    return respond(call);
  };
  fn.calls = calls;
  return fn;
}

const SCHEMA = {
  fields: [
    { name: 'service', type: 'STRING', mode: 'NULLABLE' },
    { name: 'cost', type: 'FLOAT', mode: 'NULLABLE' },
    { name: 'day', type: 'TIMESTAMP', mode: 'NULLABLE' },
    { name: 'labels', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'key', type: 'STRING' }, { name: 'value', type: 'STRING' }] },
  ],
};
const ROW_A = { f: [{ v: 'Compute Engine' }, { v: '12.5' }, { v: '1791072000000000' }, { v: [{ v: { f: [{ v: 'team' }, { v: 'web' }] } }] }] };
const ROW_B = { f: [{ v: 'Cloud Storage, multi-region' }, { v: null }, { v: null }, { v: [] }] };

/**
 * BigQuery: a dry run answers `bytes`; the query answers "still running" `pending` times, then the
 * first of `pages`; a request with pageToken page-N answers page N.
 */
function bigquery({ bytes = 1_000_000, pages = [{ rows: [ROW_A, ROW_B] }], pending = 0 } = {}) {
  let waits = pending;
  const job = { projectId: PROJECT, jobId: 'job_1', location: 'US' };
  const total = pages.reduce((n, p) => n + p.rows.length, 0);
  const pageAt = (i) => json({
    jobReference: job, jobComplete: true, schema: SCHEMA, totalRows: String(total), totalBytesProcessed: String(bytes),
    rows: pages[i].rows, ...(i + 1 < pages.length ? { pageToken: `page-${i + 1}` } : {}),
  });
  return fakeFetch(({ method, body, url }) => {
    if (method === 'POST' && body?.dryRun) return json({ totalBytesProcessed: String(bytes), jobComplete: true });
    const token = method === 'GET' ? new URL(url).searchParams.get('pageToken') : null;
    if (token) return pageAt(Number(token.slice('page-'.length)));
    if (waits > 0) {
      waits -= 1;
      return json({ jobReference: job, jobComplete: false });
    }
    return pageAt(0);
  });
}

async function run(argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await billingQuery.main(argv, { stdout, stderr, project: PROJECT, getAccessToken: async () => 'tok', ...deps });
  return { code, out: stdout.text(), err: stderr.text() };
}

test('--help prints the usage', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: billing-query /);
});

test('usage mistakes exit 2 before BigQuery is asked', async () => {
  const fetch = fakeFetch(() => json({}));
  for (const argv of [[], ['--sql', 'SELECT 1', '--file', 'q.sql'], ['--sql', 'SELECT 1', '--format', 'xml'],
    ['--sql', 'SELECT 1', '--max-gb', '0'], ['--sql', 'SELECT 1', '--max-gb', '500'], ['--sql', 'SELECT 1', '--limit', '0'],
    ['--sql', 'SELECT 1', '--project', 'Bad Project']]) {
    const r = await run(argv, { fetch });
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.equal(fetch.calls.length, 0);
});

test('only one read-only statement is accepted', () => {
  for (const sql of ['SELECT 1', 'select * from `p.d.t`;', 'WITH a AS (SELECT 1 AS x) SELECT x FROM a', '(SELECT 1) UNION ALL (SELECT 2)',
    "SELECT ';' AS s, 'DROP TABLE x' AS t", '-- costs by service\nSELECT 1', '/* a; b */ SELECT 1 # done']) {
    assert.equal(readOnlyProblem(sql), null, sql);
  }
  for (const sql of ['', '  -- only a comment', 'DELETE FROM `p.d.t` WHERE true', 'SELECT 1; DROP TABLE `p.d.t`',
    'CREATE TEMP FUNCTION f() AS (1); SELECT f()', "INSERT INTO t VALUES ('SELECT')", 'EXPORT DATA OPTIONS() AS SELECT 1',
    'UPDATE t SET a = 1 WHERE true', 'MERGE t USING s ON true WHEN MATCHED THEN DELETE']) {
    assert.ok(readOnlyProblem(sql), sql);
  }
});

test('a write is refused without a call to BigQuery', async () => {
  const fetch = fakeFetch(() => json({}));
  const r = await run(['--sql', 'DELETE FROM `p.d.t` WHERE true'], { fetch });
  assert.equal(r.code, 2);
  assert.match(r.err, /only a read-only query runs here/);
  assert.equal(fetch.calls.length, 0);
});

test('--dry-run reports the estimate against the cap and runs nothing', async () => {
  const fetch = bigquery({ bytes: 52_300_000 });
  const r = await run(['--sql', 'SELECT 1', '--dry-run'], { fetch });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would process 52\.3 MB \(52300000 bytes\) in project your-gcp-project\. The cap is 10\.0 GB, so it would run/);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, QUERY_URL);
  assert.deepEqual(fetch.calls[0].body, { query: 'SELECT 1', useLegacySql: false, dryRun: true });
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer tok');

  const j = await run(['--sql', 'SELECT 1', '--dry-run', '--format', 'json', '--max-gb', '0.01'], { fetch: bigquery({ bytes: 52_300_000 }) });
  assert.deepEqual(JSON.parse(j.out), { dry_run: true, project: PROJECT, bytes_processed: 52_300_000, cap_bytes: 10_000_000, within_cap: false });
});

test('a query over the cap is refused after the dry run', async () => {
  const fetch = bigquery({ bytes: 25e9 });
  const r = await run(['--sql', 'SELECT * FROM `p.d.t`'], { fetch });
  assert.equal(r.code, 1);
  assert.match(r.err, /would process 25\.0 GB, over the 10\.0 GB cap, so it did not run/);
  assert.equal(fetch.calls.length, 1);
});

test('the query runs with the cap as maximumBytesBilled and prints CSV, with a summary on stderr', async () => {
  const fetch = bigquery();
  const r = await run(['--sql', 'SELECT service, cost FROM `p.d.t`', '--max-gb', '2'], { fetch });
  assert.equal(r.code, 0, r.err);
  const body = fetch.calls[1].body;
  assert.equal(body.maximumBytesBilled, '2000000000');
  assert.equal(body.useLegacySql, false);
  assert.deepEqual(body.formatOptions, { useInt64Timestamp: true });
  assert.equal(r.out, [
    'service,cost,day,labels',
    'Compute Engine,12.5,2026-10-04T00:00:00.000Z,"[{""key"":""team"",""value"":""web""}]"',
    '"Cloud Storage, multi-region",,,[]',
    '',
  ].join('\n'));
  assert.match(r.err, /^billing-query: 2 rows \| 1\.0 MB processed \| job your-gcp-project:US\.job_1\n$/);
});

test('--format json prints objects, and --out writes the rows to a file with the summary on stdout', async () => {
  const written = {};
  const r = await run(['--sql', 'SELECT 1', '--format', 'json', '--out', 'costs.json'], {
    fetch: bigquery(), writeText: (path, text) => { written[path] = text; },
  });
  assert.equal(r.code, 0, r.err);
  const rows = JSON.parse(written['costs.json']);
  assert.deepEqual(rows[0], { service: 'Compute Engine', cost: '12.5', day: '2026-10-04T00:00:00.000Z', labels: [{ key: 'team', value: 'web' }] });
  assert.deepEqual(rows[1], { service: 'Cloud Storage, multi-region', cost: null, day: null, labels: [] });
  assert.match(r.out, /^billing-query: wrote 2 rows \| 1\.0 MB processed \| job your-gcp-project:US\.job_1 to costs\.json\n$/);
  assert.equal(r.err, '');
});

test('--file reads the query from a file', async () => {
  const fetch = bigquery();
  const r = await run(['--file', 'q.sql', '--dry-run'], { fetch, readText: (path) => (path === 'q.sql' ? '-- by service\nSELECT 1\n' : '') });
  assert.equal(r.code, 0, r.err);
  assert.equal(fetch.calls[0].body.query, '-- by service\nSELECT 1\n');
});

test('a job that is still running is waited on at its location, and every page is read up to --limit', async () => {
  const fetch = bigquery({ pending: 1, pages: [{ rows: [ROW_A] }, { rows: [ROW_B] }, { rows: [ROW_A] }] });
  const r = await run(['--sql', 'SELECT 1', '--limit', '2'], { fetch });
  assert.equal(r.code, 0, r.err);
  const gets = fetch.calls.filter((c) => c.method === 'GET').map((c) => new URL(c.url));
  assert.equal(gets[0].pathname, `/bigquery/v2/projects/${PROJECT}/queries/job_1`);
  assert.equal(gets[0].searchParams.get('location'), 'US');
  assert.equal(gets[1].searchParams.get('pageToken'), 'page-1');
  assert.equal(r.out.trim().split('\n').length, 3, 'a header and two rows');
  assert.match(r.err, /2 rows of 3/);
  assert.match(r.err, /more rows match than --limit 2/);
});

test('a job that never finishes is given up on with its id', async () => {
  let clock = 0;
  const fetch = fakeFetch(({ body }) => {
    clock += DEADLINE_MS / 2;
    return body?.dryRun ? json({ totalBytesProcessed: '10' }) : json({ jobReference: { projectId: PROJECT, jobId: 'job_slow', location: 'EU' }, jobComplete: false });
  });
  const r = await run(['--sql', 'SELECT 1'], { fetch, now: () => clock });
  assert.equal(r.code, 1);
  assert.match(r.err, /still running after 10 minutes \(job job_slow\)/);
});

test("BigQuery's refusals say what to grant or fix", async () => {
  const refuse = (status, reason, message) => fakeFetch(() => json({ error: { code: status, message, errors: [{ reason, message }] } }, status));
  const cases = [
    [403, 'accessDenied', 'Access Denied: Table p:d.t: User does not have permission to query table p:d.t.', /BigQuery Data Viewer on the export's dataset/],
    [403, 'accessDenied', `Access Denied: Project ${PROJECT}: User does not have bigquery.jobs.create permission in project ${PROJECT}.`, /needs BigQuery Job User there/],
    [403, 'accessNotConfigured', 'BigQuery API has not been used in project 123 before or it is disabled.', /BigQuery API is turned off in project your-gcp-project/],
    [404, 'notFound', 'Not found: Dataset p:billing was not found in location US', /INFORMATION_SCHEMA\.TABLES/],
    [400, 'bytesBilledLimitExceeded', 'Query exceeded limit for bytes billed: 10000000000.', /narrow it or raise --max-gb/],
    [400, 'invalidQuery', 'Unrecognized name: costs at [1:8]', /BigQuery refused the query: Unrecognized name/],
    [429, 'rateLimitExceeded', 'Exceeded rate limits', /wait a minute/],
  ];
  for (const [status, reason, message, expected] of cases) {
    const r = await run(['--sql', 'SELECT 1', '--dry-run'], { fetch: refuse(status, reason, message) });
    assert.equal(r.code, 1, message);
    assert.match(r.err, expected, message);
  }
});

test('decoding and formatting helpers', () => {
  assert.deepEqual(decodeRow({ f: [{ v: 'true' }, { v: ['a', 'b'].map((v) => ({ v })) }] },
    [{ name: 'ok', type: 'BOOLEAN' }, { name: 'tags', type: 'STRING', mode: 'REPEATED' }]), { ok: true, tags: ['a', 'b'] });
  assert.equal(toCsv([{ name: 'note' }], [{ note: 'say "hi"' }, { note: ' padded' }]), 'note\n"say ""hi"""\n" padded"\n');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1_500_000_000), '1.5 GB');
});
