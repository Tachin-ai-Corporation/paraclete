#!/usr/bin/env node
// roles/finance-analyst/skills/billing-analysis/billing-query.mjs: the billing-query command. Runs one
// read-only GoogleSQL query in BigQuery as the VM's service account, for reading the Cloud Billing
// export: a dry run first, then the query with a cap on the bytes BigQuery may bill, so no query costs
// more than the cap. Prints the rows as CSV or JSON, and a summary (rows, bytes processed, the job) on
// stderr, or on stdout when the rows go to a file. Anything but one SELECT (or WITH ... SELECT) is
// refused before BigQuery is asked; what the agent may read at all is BigQuery's IAM to decide (Data
// Viewer on the export's dataset, Job User where the query runs). It never writes to BigQuery.
// Documented in roles/finance-analyst/skills/billing-analysis/SKILL.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { getAccessToken as metadataToken } from '../../../../agent/auth/metadata-token.mjs';
import { loadInstance } from '../../../../config/instance.mjs';

const API = 'https://bigquery.googleapis.com/bigquery/v2';
const GB = 1e9;
export const DEFAULT_MAX_GB = 10;
export const MAX_GB = 200;
export const DEFAULT_LIMIT = 10_000;
export const MAX_LIMIT = 100_000;
/** Rows asked for per page of results. */
const PAGE_ROWS = 10_000;
/** How long one call waits for the job to finish before returning, in milliseconds. */
const WAIT_MS = 20_000;
/** How long the command waits for a job in all before giving up on it. */
export const DEADLINE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** A Google Cloud project id, optionally domain-scoped (example.com:my-project). */
const PROJECT_PATTERN = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export const USAGE = [
  'Usage: billing-query (--sql <query> | --file <path>) [--dry-run] [--max-gb <n>] [--format csv|json] [--out <path>] [--limit <rows>] [--project <id>]',
  'Runs one read-only GoogleSQL query (SELECT, or WITH ... SELECT). A dry run comes first, and the query',
  `runs only when it would process at most --max-gb gigabytes (default ${DEFAULT_MAX_GB}, at most ${MAX_GB}).`,
].join('\n');

/** A failure the command reports and exits 1 on. */
class QueryError extends Error {}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { sql, file, dryRun, maxGb, format, out, limit, project }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      options: {
        sql: { type: 'string' }, file: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'max-gb': { type: 'string' },
        format: { type: 'string' }, out: { type: 'string' }, limit: { type: 'string' }, project: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: `${err.message} (a query that starts with a dash or a comment goes in a file: --file <path>)` };
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  if ((v.sql === undefined) === (v.file === undefined)) return { error: 'give the query with exactly one of --sql <query> or --file <path>' };
  const args = { sql: v.sql, file: v.file, dryRun: v['dry-run'] === true, format: v.format || 'csv', out: v.out, project: v.project };
  if (!['csv', 'json'].includes(args.format)) return { error: `--format must be csv or json, not '${v.format}'` };
  args.maxGb = DEFAULT_MAX_GB;
  if (v['max-gb'] !== undefined) {
    const n = Number(v['max-gb']);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_GB) return { error: `--max-gb must be a number above 0 and at most ${MAX_GB}` };
    args.maxGb = n;
  }
  args.limit = DEFAULT_LIMIT;
  if (v.limit !== undefined) {
    const n = Number(v.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { error: `--limit must be a whole number from 1 to ${MAX_LIMIT}` };
    args.limit = n;
  }
  if (args.project !== undefined && !PROJECT_PATTERN.test(args.project)) return { error: `'${args.project}' is not a Google Cloud project id` };
  return args;
}

/**
 * The query with its comments, string literals and quoted identifiers blanked out, so that a keyword
 * or a semicolon inside them is not read as SQL.
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripSqlNoise(sql) {
  const s = String(sql ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const two = s.slice(i, i + 2);
    if (two === '--' || c === '#') {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      out += ' ';
    } else if (two === '/*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const close = s.slice(i, i + 3) === c.repeat(3) ? c.repeat(3) : c;
      let j = i + close.length;
      while (j < s.length && s.slice(j, j + close.length) !== close) j += s[j] === '\\' ? 2 : 1;
      i = Math.min(s.length, j + close.length);
      out += c === '`' ? ' x ' : " '' ";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Why a query may not run here, or null when it is one read-only statement.
 *
 * @param {string} sql
 * @returns {string|null}
 */
export function readOnlyProblem(sql) {
  const body = stripSqlNoise(sql).trim().replace(/;\s*$/, '');
  if (!body) return 'the query is empty';
  if (body.includes(';')) return 'give one statement: a script of several statements is refused';
  if (!/^\(*\s*(select|with)\b/i.test(body)) {
    return `only a read-only query runs here (SELECT, or WITH ... SELECT), not one starting '${body.split(/\s+/)[0]}'`;
  }
  return null;
}

/** Bytes in decimal units, as BigQuery's console shows them. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${n} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * One cell of a result, from BigQuery's wire form ({ v } nesting, every scalar a string) to a plain
 * value: records become objects, repeated fields arrays, timestamps ISO 8601 UTC, booleans booleans.
 * Numbers stay the exact strings BigQuery sent, so a NUMERIC loses nothing.
 */
export function decodeValue(value, field) {
  if (value === null || value === undefined) return null;
  if (field.mode === 'REPEATED') {
    return (Array.isArray(value) ? value : []).map((item) => decodeValue(item?.v, { ...field, mode: 'NULLABLE' }));
  }
  if (field.type === 'RECORD' || field.type === 'STRUCT') return decodeRow(value, field.fields || []);
  if (field.type === 'TIMESTAMP') {
    const micros = Number(value);
    return Number.isFinite(micros) ? new Date(micros / 1000).toISOString() : value;
  }
  if (field.type === 'BOOLEAN' || field.type === 'BOOL') return value === 'true';
  return value;
}

/** One result row ({ f: [{ v }] }) as an object keyed by column name. */
export function decodeRow(row, fields) {
  const cells = row?.f || [];
  return Object.fromEntries(fields.map((field, i) => [field.name, decodeValue(cells[i]?.v, field)]));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows as CSV with a header row; a record or repeated value is written as JSON in its cell. */
export function toCsv(fields, rows) {
  const lines = [fields.map((f) => csvCell(f.name)).join(',')];
  for (const row of rows) lines.push(fields.map((f) => csvCell(row[f.name])).join(','));
  return `${lines.join('\n')}\n`;
}

/**
 * What to tell the agent when BigQuery refuses, with what would fix it.
 *
 * @param {number} status
 * @param {object|null} data the error response body
 * @param {string} project where the query runs
 */
export function explainError(status, data, project) {
  const error = data?.error || {};
  const reasons = (error.errors || []).map((e) => e?.reason).filter(Boolean);
  const said = String(error.message || `HTTP ${status}`);
  const has = (reason) => reasons.includes(reason);
  if (has('accessNotConfigured') || /SERVICE_DISABLED|has not been used in project|API .*is disabled/i.test(`${said} ${JSON.stringify(error.details || '')}`)) {
    return `the BigQuery API is turned off in project ${project}; a project owner turns it on (gcloud services enable bigquery.googleapis.com --project=${project}). BigQuery said: ${said}`;
  }
  if (has('bytesBilledLimitExceeded')) {
    return `the query would bill more than the cap; narrow it or raise --max-gb. BigQuery said: ${said}`;
  }
  if (status === 403 && /bigquery\.jobs\.create/.test(said)) {
    return `the agent's service account may not run queries in project ${project}: it needs BigQuery Job User there, which this role grants on the instance's own project at install. BigQuery said: ${said}`;
  }
  if (status === 403 || has('accessDenied')) {
    return `access denied: the agent's service account cannot read what the query names. Whoever administers the billing export grants it BigQuery Data Viewer on the export's dataset. BigQuery said: ${said}`;
  }
  if (status === 404 || has('notFound')) {
    return `not found: check the project, dataset and table names (list a dataset's tables with SELECT table_name FROM \`<project>.<dataset>.INFORMATION_SCHEMA.TABLES\`). BigQuery said: ${said}`;
  }
  if (status === 429 || has('rateLimitExceeded') || has('quotaExceeded')) {
    return `BigQuery is limiting requests; wait a minute, then run it once more. BigQuery said: ${said}`;
  }
  if (status === 400 || has('invalidQuery')) return `BigQuery refused the query: ${said}`;
  return `BigQuery returned HTTP ${status}: ${said}`;
}

async function call(ctx, method, url, body) {
  const token = await ctx.getAccessToken();
  let response;
  try {
    response = await ctx.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new QueryError(`the request to BigQuery failed: ${err.message}`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new QueryError(explainError(response.status, data, ctx.project));
  return data || {};
}

function resultsUrl(project, job, { maxResults, pageToken } = {}) {
  const params = new URLSearchParams({ timeoutMs: String(WAIT_MS), 'formatOptions.useInt64Timestamp': 'true' });
  if (job.location) params.set('location', job.location);
  if (maxResults) params.set('maxResults', String(maxResults));
  if (pageToken) params.set('pageToken', pageToken);
  return `${API}/projects/${encodeURIComponent(job.projectId || project)}/queries/${encodeURIComponent(job.jobId)}?${params}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.getAccessToken]
 * @param {string}   [deps.project]   where queries run when --project is absent; default: the instance's project
 * @param {Function} [deps.readText]  (path) => string, for --file
 * @param {Function} [deps.writeText] (path, text) => void, for --out
 * @param {Function} [deps.now]       clock in milliseconds
 * @returns {Promise<number>} 0, 1 when BigQuery refused or the cap stopped the query, 2 for a usage error
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 1) => { stderr.write(`billing-query: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  let sql = args.sql;
  if (args.file !== undefined) {
    try {
      sql = (deps.readText || ((path) => readFileSync(path, 'utf8')))(args.file);
    } catch (err) {
      return fail(`cannot read ${args.file}: ${err.message}`, 2);
    }
  }
  const problem = readOnlyProblem(sql);
  if (problem) return fail(problem, 2);

  let project = args.project || deps.project;
  if (!project) {
    try {
      project = loadInstance().project;
    } catch (err) {
      return fail(`cannot find the project to run the query in (${err.message}); pass --project <id>`);
    }
  }
  const ctx = { fetch: deps.fetch || globalThis.fetch, getAccessToken: deps.getAccessToken || metadataToken, project };
  const now = deps.now || Date.now;
  const capBytes = Math.floor(args.maxGb * GB);
  const queriesUrl = `${API}/projects/${encodeURIComponent(project)}/queries`;

  try {
    const dry = await call(ctx, 'POST', queriesUrl, { query: sql, useLegacySql: false, dryRun: true });
    const estimate = Number(dry.totalBytesProcessed || 0);
    const withinCap = estimate <= capBytes;
    if (args.dryRun) {
      stdout.write(args.format === 'json'
        ? `${JSON.stringify({ dry_run: true, project, bytes_processed: estimate, cap_bytes: capBytes, within_cap: withinCap })}\n`
        : `Dry run: the query would process ${formatBytes(estimate)} (${estimate} bytes) in project ${project}. The cap is ${formatBytes(capBytes)}, so it ${withinCap ? 'would run' : 'would be refused: narrow it, or raise --max-gb'}.\n`);
      return 0;
    }
    if (!withinCap) {
      return fail(`the query would process ${formatBytes(estimate)}, over the ${formatBytes(capBytes)} cap, so it did not run. Narrow it (a shorter date range, fewer columns, a filter on _PARTITIONTIME), or raise --max-gb (at most ${MAX_GB}) when the cost is justified.`);
    }

    const pageRows = Math.min(PAGE_ROWS, args.limit);
    let page = await call(ctx, 'POST', queriesUrl, {
      query: sql, useLegacySql: false, maximumBytesBilled: String(capBytes), timeoutMs: WAIT_MS, maxResults: pageRows,
      formatOptions: { useInt64Timestamp: true },
    });
    const job = page.jobReference || {};
    const started = now();
    while (!page.jobComplete) {
      if (!job.jobId) throw new QueryError('BigQuery did not finish the query and named no job to wait on');
      if (now() - started > DEADLINE_MS) {
        throw new QueryError(`the query is still running after ${DEADLINE_MS / 60_000} minutes (job ${job.jobId}); narrow it and run it again`);
      }
      page = await call(ctx, 'GET', resultsUrl(project, job, { maxResults: pageRows }), null);
    }

    const fields = page.schema?.fields || [];
    const total = Number(page.totalRows ?? 0);
    const processed = Number(page.totalBytesProcessed ?? estimate);
    const rows = [];
    const take = (p) => {
      for (const row of p.rows || []) {
        if (rows.length >= args.limit) break;
        rows.push(decodeRow(row, fields));
      }
    };
    take(page);
    let pageToken = page.pageToken;
    while (pageToken && rows.length < args.limit) {
      page = await call(ctx, 'GET', resultsUrl(project, job, { maxResults: Math.min(PAGE_ROWS, args.limit - rows.length), pageToken }), null);
      take(page);
      pageToken = page.pageToken;
    }

    const text = args.format === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : toCsv(fields, rows);
    const more = Math.max(total, rows.length) > rows.length;
    const summary = [
      `${rows.length} row${rows.length === 1 ? '' : 's'}${more ? ` of ${total}` : ''}`,
      `${formatBytes(processed)} processed`,
      `job ${job.projectId || project}:${job.location || '?'}.${job.jobId || '?'}`,
    ].join(' | ');
    const notes = more ? [`more rows match than --limit ${args.limit}: aggregate in the query, or raise --limit`] : [];
    if (args.out) {
      (deps.writeText || ((path, body) => writeFileSync(path, body)))(args.out, text);
      stdout.write([`billing-query: wrote ${summary} to ${args.out}`, ...notes.map((n) => `billing-query: ${n}`)].join('\n') + '\n');
    } else {
      stdout.write(text);
      stderr.write([`billing-query: ${summary}`, ...notes.map((n) => `billing-query: ${n}`)].join('\n') + '\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof QueryError) return fail(err.message);
    return fail(`unexpected failure: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
