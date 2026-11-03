// dev/harness2/model-suite.mjs: the benchmark a real-model run (`--real-model`) measures a harness change
// on. Each task is a request a person could send the agent, a small workspace it starts from, and
// deterministic checks of the workspace afterwards: tests that must pass, files that must not change,
// values a correct answer must hold. A run's capability on a task is the fraction of its checks that
// pass, so the score moves with the work, not with how the agent describes it. No check calls a model
// or the network.
//
// Tasks are split. A `train` task's results reach the proposer (lenses.mjs, through recursion.mjs) and
// steer selection; a `holdout` task's never do, and only the promotion evidence reads them, so a change
// tuned to the training tasks shows up as a held-out regression (evidence.mjs). Add tasks here, each
// with checks; a task without checks measures nothing. This file is off the mutable surface
// (surface.mjs), so no promotion can change the benchmark it is judged by.
//
// It runs nothing itself: live-runner.mjs `runInProcessBrainRollout` seeds a task into the rollout's
// workspace and calls its `verify` after the mission. Called by live-runner.mjs and cli.mjs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The suite's version, recorded in promotion evidence: a change to the tasks makes runs incomparable. */
export const MODEL_SUITE_VERSION = 5;

/**
 * Tasks every real-model run of the lab scored perfect: they measure nothing any more. Version 1's ten,
 * through the lab's first baselines of 2026-10-27 to 2026-10-30; five of version 2's six, through
 * every baseline from 2026-10-28 to 2026-10-31 (the sixth, qa-find-seeded-bugs, still fails some runs);
 * and seven of version 4's eight training tasks, through the version 4 baseline of 2026-11-02 and the
 * measurements since (the eighth, qa-race-in-queue, still fails some runs), each replaced by a harder
 * task for the same role. They stay defined, so records that name them still read, and a run that
 * names one by id still runs it; no other run selects them.
 */
export const RETIRED_TASKS = Object.freeze([
  'se-fix-failing-test', 'se-implement-from-spec', 'qa-reproduce-then-fix', 'devops-fix-service-config', 'devops-incident-summary',
  'data-revenue-summary', 'data-dedupe-customers', 'gen-action-items', 'gen-extract-contacts', 'sec-remove-hardcoded-key',
  'se-lru-cache-ttl', 'data-join-clean-orders', 'devops-crashloop-diagnosis', 'sec-review-and-fix', 'gen-meeting-schedule',
  'se-csv-rfc4180', 'devops-plan-order', 'gen-constrained-brief', 'design-contrast-fix', 'fin-invoice-report', 'pm-tracker-update',
  'ea-meeting-times',
]);

/** The splits: `train` reaches the proposer, `holdout` only the evidence. */
export const SPLITS = Object.freeze(['train', 'holdout']);

const NODE_TIMEOUT_MS = 120_000;

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
}

function read(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
}

function sameText(a, b) {
  return a !== null && b !== null && a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/** Every file under `dir` (relative, forward slashes), node_modules and .git left out. */
function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return [];
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(abs, base) : [path.relative(base, abs).replace(/\\/g, '/')];
  });
}

/**
 * The environment a check's node runs in. A test runner's own marker is left out: a `node --test`
 * started under one reports to it instead of exiting with its result.
 */
function checkEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** `node --test` in `dir`. */
function nodeTest(dir) {
  const res = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: NODE_TIMEOUT_MS, env: checkEnv() });
  return { ok: res.status === 0, output: `${res.stdout || ''}${res.stderr || ''}`.slice(-2000) };
}

/** Runs `code` as an ES module in `dir`, with `env` added. */
function nodeEval(dir, code, env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: dir, encoding: 'utf8', timeout: NODE_TIMEOUT_MS, env: checkEnv(env),
  });
  return { ok: res.status === 0, stdout: (res.stdout || '').trim(), output: `${res.stdout || ''}${res.stderr || ''}`.slice(-2000) };
}

/** A copy of the workspace to run hidden checks in, so they never touch what the agent made. */
function scratchCopy(dir) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'paraclete-h2-check-'));
  fs.cpSync(dir, copy, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
  return copy;
}

function withScratch(dir, fn) {
  const copy = scratchCopy(dir);
  try {
    return fn(copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

function json(dir, rel) {
  const text = read(dir, rel);
  if (text === null) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

/** Splits one CSV line, honouring double quotes. */
function csvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvRows(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '').map(csvLine);
}

const PACKAGE_JSON = '{\n  "name": "workspace-task",\n  "private": true,\n  "type": "module"\n}\n';

function defineTask({ id, role, split, prompt, files, checks }) {
  return Object.freeze({
    id,
    role,
    split,
    prompt,
    goal: prompt,
    suite: 'model',
    files: Object.freeze({ ...files }),
    seed(dir) {
      writeFiles(dir, files);
    },
    /**
     * The workspace's checks after the mission.
     * @returns {{ passed: boolean, score: number, checks: Array<{name: string, ok: boolean, detail?: string}>, summary: string }}
     */
    verify(dir) {
      let results;
      try {
        results = checks(dir, { original: (rel) => files[rel] ?? null });
      } catch (err) {
        results = [{ name: 'checks ran', ok: false, detail: err.message }];
      }
      const passedCount = results.filter((c) => c.ok).length;
      const score = results.length ? Number((passedCount / results.length).toFixed(4)) : 0;
      return {
        passed: results.length > 0 && passedCount === results.length,
        score,
        checks: results,
        summary: `${passedCount}/${results.length} checks passed${results.filter((c) => !c.ok).map((c) => `; failed: ${c.name}`).join('')}`,
      };
    },
  });
}

const check = (name, ok, detail) => ({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });

const RANGE_SRC = `/** The sum of every integer from start to end, both included. */
export function sumInclusiveRange(start, end) {
  let total = 0;
  for (let i = start; i < end; i += 1) total += i;
  return total;
}
`;
const RANGE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumInclusiveRange } from '../src/range.mjs';

test('sums both ends', () => {
  assert.equal(sumInclusiveRange(1, 4), 10);
  assert.equal(sumInclusiveRange(3, 3), 3);
  assert.equal(sumInclusiveRange(-2, 2), 0);
});
`;

const SLUG_README = `# slug

\`slugify(text)\` in src/slug.mjs turns a title into a URL slug:

- it is lower case;
- every run of characters other than a-z and 0-9 becomes one hyphen;
- it has no hyphen at the start or the end;
- an empty result is the string "untitled".
`;

const DURATION_SRC = `/** Seconds in a duration such as "90s", "15m", "2h", or a combination such as "1h30m" or "2m5s". */
export function parseDuration(text) {
  const m = /^(\\d+)([hms])$/.exec(String(text).trim());
  if (!m) throw new Error(\`not a duration: \${text}\`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}
`;
const DURATION_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.mjs';

test('single units', () => {
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('15m'), 900);
  assert.equal(parseDuration('2h'), 7200);
});
`;

const CHECK_MJS = `// Checks deploy/service.json against the platform's rules. Prints each problem; exits 1 when there is any.
import { readFileSync } from 'node:fs';

const problems = [];
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL('./deploy/service.json', import.meta.url), 'utf8'));
} catch (e) {
  console.log(\`deploy/service.json is not valid JSON: \${e.message}\`);
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]{2,30}$/.test(cfg.name ?? '')) problems.push('name must be 3-31 lower-case letters, digits or hyphens, starting with a letter');
if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) problems.push('port must be an integer from 1024 to 65535');
if (!Number.isInteger(cfg.replicas) || cfg.replicas < 2) problems.push('replicas must be at least 2');
if (typeof cfg.health?.path !== 'string' || !cfg.health.path.startsWith('/')) problems.push('health.path must start with /');
if (!Number.isInteger(cfg.health?.interval_seconds) || cfg.health.interval_seconds < 5) problems.push('health.interval_seconds must be at least 5');
for (const p of problems) console.log(p);
process.exit(problems.length ? 1 : 0);
`;
const SERVICE_JSON = `{
  "name": "Orders_API",
  "image": "registry.example.com/orders:1.4.2",
  "port": "8080",
  "replicas": 1,
  "health": { "path": "healthz", "interval_seconds": 2 }
}
`;

const APP_LOG = [
  '2026-03-02T04:02:11Z INFO  [api] request served path=/orders status=200',
  '2026-03-02T04:05:40Z WARN  [db] disk usage at 91% on /var/lib/db',
  '2026-03-02T04:09:58Z WARN  [db] disk usage at 99% on /var/lib/db',
  '2026-03-02T04:11:09Z ERROR [db] write failed: ENOSPC: no space left on device',
  '2026-03-02T04:11:10Z ERROR [api] POST /orders failed: database write error',
  '2026-03-02T04:11:12Z ERROR [api] POST /orders failed: database write error',
  '2026-03-02T04:11:15Z ERROR [db] checkpoint failed: ENOSPC: no space left on device',
  '2026-03-02T04:11:20Z ERROR [cache] eviction storm: 4000 keys evicted in 1s',
  '2026-03-02T04:11:31Z ERROR [api] POST /orders failed: database write error',
  '2026-03-02T04:12:02Z ERROR [api] health check failed: db not writable',
  '2026-03-02T04:12:40Z ERROR [db] write failed: ENOSPC: no space left on device',
  '2026-03-02T04:13:05Z ERROR [api] POST /orders failed: database write error',
  '2026-03-02T04:20:00Z INFO  [db] disk usage at 62% on /var/lib/db after log rotation',
  '2026-03-02T04:20:05Z INFO  [api] request served path=/orders status=200',
  '',
].join('\n');

const SALES_CSV = [
  'order_id,region,product,units,unit_price',
  '1001,North,Lamp,3,24.50',
  '1002,South,"Desk, Oak",1,310.00',
  '1003,North,Chair,4,89.99',
  '1004,East,Lamp,10,24.50',
  '1005,South,Chair,2,89.99',
  '1006,East,"Desk, Oak",2,310.00',
  '1007,North,Lamp,6,22.00',
  '1008,South,Bookcase,1,145.25',
  '1009,East,Chair,5,85.00',
  '1010,North,Bookcase,2,145.25',
  '1011,South,Lamp,4,24.50',
  '1012,East,Bookcase,1,150.00',
  '',
].join('\n');

const CUSTOMERS_CSV = [
  'id,email,name,signup_date',
  'c1,ana@example.com,Ana Lima,2025-04-02',
  'c2,ben@example.com,Ben Okafor,2025-01-15',
  'c3, Ana@Example.com ,Ana Lima,2024-11-20',
  'c4,chloe@example.com,Chloe Martin,2025-02-01',
  'c5,BEN@example.com,Benjamin Okafor,2025-03-09',
  'c6,dev@example.com,Dev Patel,2025-05-30',
  'c7,chloe@example.com ,Chloe Martin,2025-06-11',
  '',
].join('\n');

const MEETING_TXT = `Weekly planning, 10 March

Attendees: Priya, Rafael, Wen, Sam

We went through the launch checklist. The pricing page is still blank, so Rafael will write the
pricing page copy by Wednesday 12 March. Wen raised that the staging database is a week old; she'll
refresh staging data before Thursday 13 March.

Budget: no decision yet. Priya will send the budget draft to everyone by Friday 14 March so we can
decide next week. Sam mentioned the support rota, which is fine as it is.

Last item: someone needs to book the venue for the launch party. Sam agreed to book the venue by
Monday 17 March.
`;

const THREAD_TXT = `From: Maria Gomez <maria.gomez@example.com>
To: Kenji Sato <kenji@example.com>
Cc: ops-team@example.com

Kenji, can you loop in Fatima from finance? Her address is fatima.ali@example.com.
Lucas will join too, but I don't have his email yet.

> On Monday, Kenji Sato <kenji@example.com> wrote:
> Thanks Maria. Adding Olu (olu.bello@example.com) who owns the vendor contract.
`;

const CLIENT_SRC = `const API_KEY = 'demo-live-key-7f3a9c2e1b';

/** The Authorization header the payments client sends. */
export function authHeader() {
  return \`Bearer \${API_KEY}\`;
}
`;
const CLIENT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authHeader } from '../src/client.mjs';

test('the header is a bearer token', () => {
  process.env.PAYMENTS_API_KEY = process.env.PAYMENTS_API_KEY || 'test-key';
  assert.match(authHeader(), /^Bearer \\S+$/);
});
`;
const SECRET = 'demo-live-key-7f3a9c2e1b';

/** The benchmark: every task, in a fixed order. */
const CACHE_README = `# cache

\`createCache({ max, ttlMs, now })\` returns a cache of at most \`max\` entries, each of which expires
\`ttlMs\` milliseconds after it was last set. \`now\` returns the current time in milliseconds (default
\`Date.now\`); tests pass their own clock.

- \`set(key, value)\` stores the value, or replaces it: either way the entry's time to live starts again
  and it becomes the most recently used. When a key not in the cache would make it hold more than
  \`max\` entries, the least recently used entry is dropped.
- \`get(key)\` returns the value, or \`undefined\` when the key is missing or expired. A hit makes the
  entry the most recently used; it does not extend its time to live.
- \`peek(key)\` returns what \`get\` would, without making the entry the most recently used.
- \`delete(key)\` removes the entry and returns whether there was one.
- \`size\` is the number of entries that have not expired.

An expired entry never takes a place: before a new key is stored, every expired entry is dropped.
`;

const CACHE_SRC = `/** A small cache that drops its least recently used entry, and whose entries expire: see README.md. */
export function createCache({ max, ttlMs, now = Date.now } = {}) {
  throw new Error('not implemented');
}
`;

/** The cache's hidden checks, one boolean each, against a clock they move. */
const CACHE_PROBE = [
  "import { createCache } from './src/cache.mjs';",
  'let t = 0;',
  'const now = () => t;',
  'const out = {};',
  'const run = (name, fn) => { try { out[name] = Boolean(fn()); } catch { out[name] = false; } };',
  "run('basic', () => { t = 0; const c = createCache({ max: 2, ttlMs: 100, now }); c.set('a', 1); return c.get('a') === 1 && c.get('zz') === undefined; });",
  "run('lru', () => { t = 0; const c = createCache({ max: 2, ttlMs: 1000, now }); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); return c.get('b') === undefined && c.get('a') === 1 && c.get('c') === 3; });",
  "run('peek', () => { t = 0; const c = createCache({ max: 2, ttlMs: 1000, now }); c.set('a', 1); c.set('b', 2); c.peek('a'); c.set('c', 3); return c.peek('a') === undefined && c.peek('b') === 2; });",
  "run('ttl', () => { t = 0; const c = createCache({ max: 5, ttlMs: 100, now }); c.set('a', 1); t = 60; c.get('a'); t = 101; return c.get('a') === undefined && c.size === 0; });",
  "run('reset', () => { t = 0; const c = createCache({ max: 5, ttlMs: 100, now }); c.set('a', 1); t = 80; c.set('a', 2); t = 150; return c.get('a') === 2; });",
  "run('expired', () => { t = 0; const c = createCache({ max: 2, ttlMs: 100, now }); c.set('a', 1); t = 50; c.set('b', 2); t = 60; c.get('a'); t = 120; c.set('c', 3); return c.get('b') === 2 && c.get('c') === 3 && c.size === 2; });",
  "run('delete', () => { t = 0; const c = createCache({ max: 2, ttlMs: 1000, now }); c.set('a', 1); return c.delete('a') === true && c.delete('a') === false && c.size === 0; });",
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

const MONEY_README = `# money

Amounts are integer cents.

- \`formatMoney(cents, currency)\` writes an amount for people: the currency's symbol (\`USD\` $, \`EUR\` €,
  \`GBP\` £), the whole units with a comma every three digits, and always two decimals:
  \`formatMoney(123456, 'USD')\` is \`$1,234.56\` and \`formatMoney(5, 'EUR')\` is \`€0.05\`. A negative
  amount puts the minus sign first: \`formatMoney(-150, 'GBP')\` is \`-£1.50\`. An unknown currency, or
  cents that are not an integer, throw.
- \`splitBill(totalCents, people)\` divides a total among people as evenly as cents allow: the shares
  differ by at most one cent, add up to the total, and the larger shares come first:
  \`splitBill(1000, 3)\` is \`[334, 333, 333]\`. A total that is negative or not an integer, or fewer
  than one person, throws.
`;

const MONEY_SRC = `/** Money in integer cents: see README.md. */
const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

function grouped(units) {
  const digits = String(units);
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

export function formatMoney(cents, currency) {
  const symbol = SYMBOLS[currency];
  if (!symbol || !Number.isInteger(cents)) throw new Error(\`cannot format \${cents} \${currency}\`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return \`\${sign}\${symbol}\${grouped(Math.floor(abs / 100))}.\${String(abs % 100).padStart(2, '0')}\`;
}

export function splitBill(totalCents, people) {
  if (!Number.isInteger(totalCents) || totalCents < 0 || !Number.isInteger(people) || people < 1) {
    throw new Error(\`cannot split \${totalCents} among \${people}\`);
  }
  const base = Math.floor(totalCents / people);
  const extra = totalCents % people;
  return Array.from({ length: people }, (_, i) => base + (i < extra ? 1 : 0));
}
`;

/** Changes that break what money's README.md documents: tests that guard it fail on each one. */
const MONEY_MUTANTS = Object.freeze([
  ['cents under ten without their leading zero', (src) => src.replace("String(abs % 100).padStart(2, '0')", 'String(abs % 100)')],
  ['the minus sign after the symbol', (src) => src.replace('${sign}${symbol}', '${symbol}${sign}')],
  ['no comma between thousands', (src) => src.replace('return out;', 'return digits;')],
  ['the leftover cents dropped', (src) => src.replace('base + (i < extra ? 1 : 0)', 'base')],
  ['the larger shares last', (src) => src.replace('i < extra ? 1 : 0', 'i >= people - extra ? 1 : 0')],
]);

const ORDERS_CSV = [
  'order_id,customer_id,amount,status,date',
  '1001,C01,"$1,200.00",Completed,2026-01-05',
  '1002,c02,350.5,completed ,2026-01-17',
  '1003,C03,$99.99,refunded,2026-01-20',
  '1004, C01 ,"$2,000.00",COMPLETED,03/02/2026',
  '1002,c02,350.5,completed ,2026-01-17',
  '1005,C04,75,completed,14/02/2026',
  '1006,C02,$410.25,pending,2026-02-20',
  '1007,C03,"$1,050.10",Completed,2026-03-01',
  '1008,c04,120.00, completed,05/03/2026',
  '',
].join('\n');

const ORDER_CUSTOMERS_CSV = [
  'customer_id,name,region',
  'C01,Acme Ltd,North',
  'C02,Birch & Co,South',
  'c03,Cobalt Inc,North',
  'C04,Delta GmbH,East',
  '',
].join('\n');

const STACK_JSON = `{
  "services": {
    "web": {
      "image": "registry.example.com/web:2.3.0",
      "port": 8080,
      "env": { "API_URL": "http://api:9000" },
      "depends_on": ["api"]
    },
    "api": {
      "image": "registry.example.com/api:5.1.4",
      "port": 9090,
      "env": { "DATABASE_URL": "postgres://app@db:5433/orders", "LOG_LEVEL": "info" },
      "depends_on": []
    },
    "db": {
      "image": "registry.example.com/postgres:16.4",
      "port": 5432,
      "env": {},
      "depends_on": []
    }
  }
}
`;

const STACK_CHECK_MJS = `// Checks deploy/stack.json: a service another reaches through a URL in its env must exist, listen on
// that port, and be one the other depends on. Prints how many problems there are; exits 1 on any.
import { readFileSync } from 'node:fs';

const { services } = JSON.parse(readFileSync(new URL('./deploy/stack.json', import.meta.url), 'utf8'));
let problems = 0;
for (const service of Object.values(services)) {
  for (const value of Object.values(service.env || {})) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      continue;
    }
    const target = services[url.hostname];
    if (!target || Number(url.port) !== target.port || !(service.depends_on || []).includes(url.hostname)) problems += 1;
  }
}
if (problems) {
  console.error(\`\${problems} problem(s) in deploy/stack.json\`);
  process.exit(1);
}
console.log('deploy/stack.json is consistent');
`;

const API_LOG = [
  '2026-01-14T02:10:01Z INFO api starting, version 5.1.4',
  '2026-01-14T02:10:01Z INFO connecting to the database at db:5433',
  '2026-01-14T02:10:04Z ERROR connect ECONNREFUSED 10.4.0.7:5433',
  '2026-01-14T02:10:04Z ERROR could not reach the database; exiting',
  '2026-01-14T02:10:09Z INFO api starting, version 5.1.4',
  '2026-01-14T02:10:09Z INFO connecting to the database at db:5433',
  '2026-01-14T02:10:12Z ERROR connect ECONNREFUSED 10.4.0.7:5433',
  '2026-01-14T02:10:12Z ERROR could not reach the database; exiting',
  '2026-01-14T02:10:13Z WARN restarted 2 times; the database container was still starting at the first attempt',
  '',
].join('\n');

const WEB_LOG = [
  '2026-01-14T02:10:30Z INFO web listening on 8080',
  '2026-01-14T02:11:02Z ERROR GET /orders -> 502: upstream http://api:9000 refused the connection',
  '2026-01-14T02:11:05Z ERROR GET /health -> 502: upstream http://api:9000 refused the connection',
  '',
].join('\n');

const SECREVIEW_README = `# files and queries

- \`readUserFile(root, name)\` returns the text of the file \`name\` under the directory \`root\`. \`name\`
  may name a file in a subdirectory (\`notes/today.txt\`), never one outside \`root\`, however it is
  written: such a name throws.
- \`buildQuery(table, filters)\` returns \`{ text, values }\` for a node-postgres query. \`table\` is
  \`users\` or \`orders\`; anything else throws. Each filter's column must be a plain identifier (letters,
  digits and underscores, not starting with a digit); anything else throws. Each value is a numbered
  parameter in \`values\`, never written into \`text\`:
  \`buildQuery('orders', { status: 'open', customer_id: 7 })\` is
  \`{ text: 'SELECT * FROM orders WHERE status = $1 AND customer_id = $2', values: ['open', 7] }\`. With
  no filters, \`text\` has no WHERE.
`;

const FILES_SRC = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The text of a file under \`root\`, by name: see README.md. */
export function readUserFile(root, name) {
  return readFileSync(join(root, name), 'utf8');
}
`;

const QUERY_SRC = `/** A query for \`table\` that matches every filter: see README.md. */
export function buildQuery(table, filters) {
  const where = Object.entries(filters).map(([column, value]) => \`\${column} = '\${value}'\`).join(' AND ');
  return { text: \`SELECT * FROM \${table}\${where ? \` WHERE \${where}\` : ''}\`, values: [] };
}
`;

/** The review task's hidden checks, one boolean each, run in a copy that holds root/, root-evil/ and outside.txt. */
const SEC_PROBE = [
  "import path from 'node:path';",
  "import { readUserFile } from './src/files.mjs';",
  "import { buildQuery } from './src/query.mjs';",
  "const root = path.resolve('root');",
  'const out = {};',
  'const run = (name, fn) => { try { out[name] = Boolean(fn()); } catch { out[name] = false; } };',
  'const throws = (fn) => { try { fn(); return false; } catch { return true; } };',
  "run('read', () => readUserFile(root, 'notes/today.txt') === 'hello');",
  "run('dotdot', () => throws(() => readUserFile(root, '../outside.txt')));",
  "run('absolute', () => throws(() => readUserFile(root, path.resolve('outside.txt'))));",
  "run('sibling', () => throws(() => readUserFile(root, '../root-evil/f.txt')));",
  "run('param', () => { const q = buildQuery('users', { email: \"x' OR '1'='1\" }); return q.text === 'SELECT * FROM users WHERE email = $1' && JSON.stringify(q.values) === JSON.stringify([\"x' OR '1'='1\"]); });",
  "run('numbered', () => { const q = buildQuery('orders', { status: 'open', customer_id: 7 }); return q.text === 'SELECT * FROM orders WHERE status = $1 AND customer_id = $2' && JSON.stringify(q.values) === JSON.stringify(['open', 7]); });",
  "run('table', () => throws(() => buildQuery('users; DROP TABLE users', {})));",
  "run('column', () => throws(() => buildQuery('users', { \"email = '' OR 1=1 --\": 'x' })));",
  "run('nofilter', () => { const q = buildQuery('users', {}); return q.text === 'SELECT * FROM users' && Array.isArray(q.values) && q.values.length === 0; });",
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

const INBOX = Object.freeze({
  'inbox/01-roadmap.txt': `From: Lena (Berlin)
Date: Mon, 12 Jan 2026
Subject: Roadmap review

Let's hold the roadmap review on Thursday 15 January at 15:00 Berlin time, with Lena, Omar and Priya.
`,
  'inbox/02-vendor.txt': `From: Omar (New York)
Date: Mon, 12 Jan 2026
Subject: Vendor call

Vendor call on Friday 16 January at 9:30 New York time. Attendees: Omar and Wen.
`,
  'inbox/03-roadmap-moved.txt': `From: Priya (London)
Date: Tue, 13 Jan 2026
Subject: Re: Roadmap review

Thursday doesn't work for me. Lena agreed to move the roadmap review to Friday 16 January, same time, Berlin time. Please add Wen too.
`,
  'inbox/04-design.txt': `From: Wen (Singapore)
Date: Wed, 14 Jan 2026
Subject: Design sync

Design sync on Tuesday 20 January at 10:00 Singapore time, with Wen and Lena.
`,
  'inbox/05-vendor-off.txt': `From: Omar (New York)
Date: Wed, 14 Jan 2026
Subject: Re: Vendor call

The vendor cancelled, so the vendor call is off.
`,
});

/** Whether an amount (a number, or a string of one) is `want` to the cent. */
const near = (got, want) => got !== null && got !== undefined && got !== '' && Math.abs(Number(got) - want) < 0.005;

// ---- Version 3: harder tasks, each built around a mistake a capable agent still makes ----

const CSV_README = `# csv

\`parseCsv(text)\` returns the records of a CSV document as arrays of strings, as RFC 4180 has them:

- Fields are separated by commas, records by CRLF or LF. A final line break ends the last record; it
  does not start an empty one.
- A field may be enclosed in double quotes. Inside one, a comma or a line break is part of the field,
  and two double quotes stand for one. A line break inside a quoted field is kept as it is (a CRLF
  stays a CRLF).
- Spaces are part of a field: nothing is trimmed.
- An empty line is a record of one empty field.
- A document that starts with a byte order mark (U+FEFF) is read without it.
- A double quote inside a field that does not start with one is an ordinary character.
- A quoted field that is never closed throws an Error whose message names the line the field started
  on: \`unterminated quoted field at line 3\`.

An empty document has no records: \`parseCsv('')\` is \`[]\`.
`;

const CSV_SRC = `/** The records of a CSV document: see README.md. */
export function parseCsv(text) {
  return text.split('\\n').filter((line) => line !== '').map((line) => line.split(',').map((field) => field.replace(/^"|"$/g, '')));
}
`;

const CSV_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('simple records', () => {
  assert.deepEqual(parseCsv('a,b\\nc,d\\n'), [['a', 'b'], ['c', 'd']]);
});
`;

/** The CSV task's hidden cases: what each checks, the document, and its records. */
const CSV_CASES = Object.freeze([
  ['records end at LF or CRLF, and a final line break starts no record', 'a,b\r\nc,d\n', [['a', 'b'], ['c', 'd']]],
  ['a quoted field keeps its comma', 'a,"b,c",d', [['a', 'b,c', 'd']]],
  ['two double quotes in a quoted field are one', '"he said ""hi""",x', [['he said "hi"', 'x']]],
  ['a quoted field keeps its line breaks as they are', '"line1\r\nline2",z\r\nq,r\r\n', [['line1\r\nline2', 'z'], ['q', 'r']]],
  ['spaces are kept', ' a , b ', [[' a ', ' b ']]],
  ['an empty line is a record of one empty field', 'a\n\nb', [['a'], [''], ['b']]],
  ['a byte order mark is not read', '﻿id,name\n1,x', [['id', 'name'], ['1', 'x']]],
  ['a double quote inside an unquoted field is a character', 'ab"c,d', [['ab"c', 'd']]],
  ['an empty document has no records', '', []],
  ['a trailing comma ends a record with an empty field', 'a,\n,b', [['a', ''], ['', 'b']]],
  ['an empty quoted field is empty', '"",x', [['', 'x']]],
]);

const QUEUE_README = `# queue

\`runAll(tasks, limit)\` runs \`tasks\`, an array of functions that each return a promise, with at most
\`limit\` of them running at once. It resolves to their results in the order of \`tasks\`, not the order
they finish in. When one rejects, \`runAll\` rejects with that error, and no task after it starts.
\`runAll([], limit)\` resolves to \`[]\`.
`;

const QUEUE_SRC = `/** Runs async tasks with a concurrency limit: see README.md. */
export async function runAll(tasks, limit) {
  const results = [];
  let next = 0;
  let running = 0;
  return new Promise((resolve, reject) => {
    let failed = false;
    const launch = () => {
      if (failed) return;
      if (next >= tasks.length && running === 0) {
        resolve(results);
        return;
      }
      while (running <= limit && next < tasks.length) {
        const task = tasks[next];
        next += 1;
        running += 1;
        task().then((value) => {
          results.push(value);
          running -= 1;
          launch();
        }, (err) => {
          failed = true;
          reject(err);
        });
      }
    };
    launch();
  });
}
`;

const QUEUE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../src/queue.mjs';

test('runs every task', async () => {
  assert.deepEqual(await runAll([() => Promise.resolve(1), () => Promise.resolve(2)], 2), [1, 2]);
});
`;

/** The queue's hidden checks, one boolean each. */
const QUEUE_PROBE = [
  "import { runAll } from './src/queue.mjs';",
  'const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));',
  'const out = {};',
  'const run = async (name, fn) => { try { out[name] = Boolean(await fn()); } catch { out[name] = false; } };',
  "await run('order', async () => JSON.stringify(await runAll([() => sleep(30, 'a'), () => sleep(5, 'b'), () => sleep(15, 'c')], 3)) === '[\"a\",\"b\",\"c\"]');",
  "await run('limit', async () => { let now = 0; let max = 0; const t = () => async () => { now += 1; max = Math.max(max, now); await sleep(10); now -= 1; return 1; }; await runAll(Array.from({ length: 6 }, t), 2); return max === 2; });",
  "await run('reject', async () => { const started = []; const tasks = [0, 1, 2, 3].map((i) => async () => { started.push(i); await sleep(5); if (i === 1) throw new Error('boom'); return i; }); try { await runAll(tasks, 1); return false; } catch (e) { await sleep(30); return e.message === 'boom' && JSON.stringify(started) === '[0,1]'; } });",
  "await run('empty', async () => JSON.stringify(await runAll([], 2)) === '[]');",
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

const PLAN_CURRENT = Object.freeze({
  net: { type: 'network', config: { cidr: '10.0.0.0/16' } },
  'subnet-a': { type: 'subnet', config: { cidr: '10.0.1.0/24' }, depends_on: ['net'] },
  'subnet-b': { type: 'subnet', config: { cidr: '10.0.2.0/24' }, depends_on: ['net'] },
  db: { type: 'database', config: { size: 'small', version: 15 }, depends_on: ['subnet-a'], protect: true },
  'legacy-db': { type: 'database', config: { size: 'small', version: 11 }, depends_on: ['subnet-b'], protect: true },
  cache: { type: 'cache', config: { nodes: 1 }, depends_on: ['subnet-a'] },
  api: { type: 'service', config: { image: 'api:1', replicas: 2, env: { LOG: 'info', REGION: 'eu' } }, depends_on: ['db', 'cache'] },
  'old-worker': { type: 'service', config: { image: 'worker:1' }, depends_on: ['subnet-b'] },
  'old-queue': { type: 'queue', config: { retention_hours: 24 } },
  'old-queue-consumer': { type: 'service', config: { image: 'consumer:3' }, depends_on: ['old-queue'] },
  logs: { type: 'bucket', config: { retention_days: 30 } },
});

const PLAN_DESIRED = Object.freeze({
  net: { type: 'network', config: { cidr: '10.0.0.0/16' } },
  'subnet-a': { type: 'subnet', config: { cidr: '10.0.1.0/24' }, depends_on: ['net'] },
  'subnet-c': { type: 'subnet', config: { cidr: '10.0.3.0/24' }, depends_on: ['net'] },
  db: { type: 'database', config: { version: 15, size: 'large' }, depends_on: ['subnet-a'] },
  cache: { type: 'cache', config: { nodes: 1 }, depends_on: ['subnet-a'] },
  api: { type: 'service', config: { env: { REGION: 'eu', LOG: 'info' }, replicas: 2, image: 'api:2' }, depends_on: ['db', 'cache'] },
  worker: { type: 'service', config: { image: 'worker:2' }, depends_on: ['subnet-c', 'cache'] },
  logs: { type: 'bucket', config: { retention_days: 90 } },
  metrics: { type: 'bucket', config: { retention_days: 7 } },
  frontend: { type: 'service', config: { image: 'web:5' }, depends_on: ['api'] },
  reports: { type: 'service', config: { image: 'reports:1' }, depends_on: ['legacy-db'] },
  'reports-ui': { type: 'service', config: { image: 'reports-ui:1' }, depends_on: ['reports'] },
});

/** The one plan the rules allow (worked out by hand, and checked against a separate computation). */
const PLAN_EXPECTED = Object.freeze({
  actions: ['update db', 'update api', 'create frontend', 'update logs', 'create metrics', 'create subnet-c', 'create worker',
    'delete old-queue-consumer', 'delete old-queue', 'delete old-worker'],
  blocked: ['legacy-db', 'subnet-b'],
});

const PLAN_README = `# plan

Write \`plan.json\`: the changes that turn \`infra/current.json\` into \`infra/desired.json\`, as

    { "actions": [{ "op": "create", "id": "..." }, ...], "blocked": ["..."] }

- A resource in desired and not in current is created; one in current and not in desired is deleted;
  one in both whose \`type\` or \`config\` differs (deeply; the order of keys does not count) is updated.
  One that does not differ has no action.
- \`depends_on\` names the resources a resource needs. The creates and updates come first, each after
  the create or update of every resource it needs (in desired); then the deletes, each after the
  delete of every resource that needs it (in current).
- A resource marked \`"protect": true\` in current is never deleted: its id goes in \`blocked\`. What it
  needs in current (directly or through others) is not deleted either, so that it keeps working: those
  that desired leaves out go in \`blocked\` too. Nothing in desired that needs a protected resource
  that desired leaves out (directly or through others) is created or updated.
- Where these rules allow more than one order, the action whose id sorts first (plain string order)
  comes first, so there is one plan. \`blocked\` is sorted the same way.
`;

const REPORT_MD = `# Incident report: card payments failing, Tuesday 17 March 2026

Prepared by Ines Moreau for the payments team. All times are Pacific Time (PT).

## Summary

At 11:40 PT a configuration change to the payment provider client shortened its connection timeout
from 8 seconds to 800 milliseconds. Requests to the provider that took longer than that were cancelled
and reported as declined. Marco Ruiz, the incident commander, rolled the change back at 12:58 PT, and
the provider's queue had drained by 13:12 PT, when the incident was closed.

## Customer impact

- 2,314 card payments failed and were shown to customers as declined.
- Checkout was unavailable for 17 minutes, from 12:05 to 12:22 PT, while the payments service restarted
  in a loop.
- The API's error rate peaked at 4.2%.
- 312 customers received a duplicate order confirmation email after the rollback, when queued
  confirmations were sent again.

## Timeline

- 11:38 PT: Tomasz Kowalczyk merged the timeout change; it reached production two minutes later.
- 11:40 PT: The error rate on the payments service began to rise. The incident starts here.
- 11:52 PT: An alert paged Dana Whitfield, the on-call engineer. She was paged 3 times in all.
- 12:05 PT: The payments service began restarting in a loop; checkout went down.
- 12:22 PT: Checkout came back after the restarts stopped.
- 12:58 PT: Marco Ruiz rolled back the timeout change on all 41 payment hosts.
- 13:12 PT: The provider's queue had drained and the error rate was back to normal. The incident ends.

## Root cause

The new timeout was meant for the test environment. The configuration system applied it to production
because both environments read the same flag, payments-v2, and nothing checked the value against the
provider's documented latency.

## Action items

| Priority | Action |
|---|---|
| P2 | Add a dashboard panel for payment-provider latency. |
| P3 | Rename the payments-v2 flag after what it does. |
| P0 | Roll back automatically when the payment error rate passes 2% for five minutes. |
| P3 | Write a runbook entry for turning the flag off by hand. |
| P1 | Load-test the provider timeout path before each release. |
| P3 | Review how payment alerts are routed overnight. |
`;

/** What the brief must hold, and what it must not. */
const BRIEF = Object.freeze({
  employees: ['Ines', 'Moreau', 'Marco', 'Ruiz', 'Tomasz', 'Kowalczyk', 'Dana', 'Whitfield'],
  topActions: [
    'Roll back automatically when the payment error rate passes 2% for five minutes.',
    'Load-test the provider timeout path before each release.',
    'Add a dashboard panel for payment-provider latency.',
  ],
});

const EVENTS_README = `# events

\`latestPerId(events)\` keeps one event for each \`id\`: the one with the greatest \`ts\`; between equal
\`ts\`, the one with the greater \`version\`; between equal both, the one that comes later in
\`events\`. The events it keeps come in the order their ids first appear in \`events\`, which it does not
change.
`;

const EVENTS_SRC = `/** One event per id: see README.md. */
export function latestPerId(events) {
  const out = [];
  const seen = [];
  for (let i = 0; i < events.length; i += 1) {
    const id = events[i].id;
    if (seen.includes(id)) continue;
    seen.push(id);
    let best = i;
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[j].id !== id) continue;
      const a = events[j];
      const b = events[best];
      if (a.ts > b.ts || (a.ts === b.ts && a.version >= b.version)) best = j;
    }
    out.push(events[best]);
  }
  return out;
}
`;

const EVENTS_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestPerId } from '../src/events.mjs';

test('one event per id, the latest', () => {
  const events = [
    { id: 'a', ts: 1, version: 1 }, { id: 'b', ts: 5, version: 1 }, { id: 'a', ts: 3, version: 1 },
  ];
  assert.deepEqual(latestPerId(events), [{ id: 'a', ts: 3, version: 1 }, { id: 'b', ts: 5, version: 1 }]);
});
`;

/** The events task's hidden correctness checks, against a reference, on random and tied inputs. */
const EVENTS_PROBE = [
  "import { latestPerId } from './src/events.mjs';",
  'const rng = (s) => () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };',
  'const reference = (events) => { const best = new Map(); const order = []; for (const e of events) { const b = best.get(e.id); if (!b) { order.push(e.id); best.set(e.id, e); } else if (e.ts > b.ts || (e.ts === b.ts && e.version >= b.version)) best.set(e.id, e); } return order.map((id) => best.get(id)); };',
  'const out = { random: true, ties: true, order: true, unchanged: true };',
  'for (let k = 0; k < 30; k += 1) { const r = rng(1000 + k); const ev = Array.from({ length: 300 }, (_, i) => ({ id: `e${Math.floor(r() * 40)}`, ts: Math.floor(r() * 6), version: Math.floor(r() * 3), n: i })); const copy = JSON.stringify(ev); let got; try { got = latestPerId(ev); } catch { got = null; } if (JSON.stringify(got) !== JSON.stringify(reference(ev))) out.random = false; if (JSON.stringify(ev) !== copy) out.unchanged = false; }',
  "{ const ev = [{ id: 'x', ts: 2, version: 1, n: 0 }, { id: 'x', ts: 2, version: 1, n: 1 }, { id: 'x', ts: 2, version: 0, n: 2 }, { id: 'x', ts: 1, version: 9, n: 3 }]; let got; try { got = latestPerId(ev); } catch { got = null; } out.ties = JSON.stringify(got) === JSON.stringify([ev[1]]); }",
  "{ const ev = [{ id: 'b', ts: 1, version: 0 }, { id: 'a', ts: 9, version: 0 }, { id: 'b', ts: 4, version: 0 }, { id: 'c', ts: 0, version: 0 }]; let got; try { got = latestPerId(ev); } catch { got = null; } out.order = JSON.stringify(got?.map((e) => e.id)) === JSON.stringify(['b', 'a', 'c']); }",
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

/** Times latestPerId on 120,000 events of 15,000 ids; prints the milliseconds it took. */
const EVENTS_PERF = [
  "import { latestPerId } from './src/events.mjs';",
  'let s = 77; const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };',
  'const ev = Array.from({ length: 120000 }, () => ({ id: `e${Math.floor(r() * 15000)}`, ts: Math.floor(r() * 1e6), version: Math.floor(r() * 5) }));',
  'const t0 = performance.now(); latestPerId(ev); process.stdout.write(String(Math.round(performance.now() - t0)));',
].join('\n');

const PAYMENTS_CSV = [
  'id,created_at,amount,kind,refund_of',
  'p1,2026-01-15T17:00:00Z,$120.00,charge,',
  'p2,2026-02-01T04:59:00Z,$80.00,charge,',
  'p3,2026-02-01T05:00:00Z,$45.50,charge,',
  'p4,2026-02-14T12:00:00Z,"$1,250.00",charge,',
  'p5,2026-03-01T04:30:00Z,$60.00,charge,',
  'p6,2026-03-02T15:00:00Z,$200.00,refund,p4',
  'p7,2026-03-08T06:59:00Z,$33.33,charge,',
  'p8,2026-03-31T23:30:00Z,$70.00,charge,',
  'p9,2026-04-01T03:30:00Z,$15.00,charge,',
  'p10,2026-04-01T04:30:00Z,$99.99,charge,',
  'p11,2026-04-10T10:00:00Z,$45.50,refund,p3',
  'p12,2026-01-31T12:00:00Z,$10.00,refund,p1',
  '',
].join('\n');

/** New York months (America/New_York, daylight saving included): worked out by hand and with Intl. */
const PAYMENTS_MONTHS = Object.freeze({ '2026-01': 190.00, '2026-02': 1355.50, '2026-03': -81.67, '2026-04': 54.49 });

const TOKEN_README = `# token

\`verifyToken(token, keys, now)\` checks a signed token and returns its payload, or throws.

A token is three base64url parts joined by dots: a JSON header, a JSON payload, and the signature.

- The header's \`alg\` must be \`HS256\`; any other value, \`none\` included, throws.
- The header's \`kid\` names the key in \`keys\` (an object of key ids to secrets) that signed the
  token; a \`kid\` that names no key throws.
- The signature is the HMAC-SHA256 of \`<header part>.<payload part>\` with that key, base64url. It is
  compared in constant time (\`crypto.timingSafeEqual\`); a signature that differs throws.
- \`now\` is in seconds, by default the current time. Clocks differ, so 30 seconds of leeway apply: a
  token whose payload has \`exp\` is expired from \`exp + 30\` on, and one whose payload has \`nbf\` is
  valid from \`nbf - 30\` on. Outside that, it throws.
- A token that is not three parts, or whose header or payload is not base64url JSON, throws.
`;

const TOKEN_SRC = `import { createHmac } from 'node:crypto';

const json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** The payload of a signed token, or a thrown Error: see README.md. */
export function verifyToken(token, keys, now = Math.floor(Date.now() / 1000)) {
  const [h, p, s] = String(token).split('.');
  const header = json(h);
  const payload = json(p);
  if (header.alg !== 'none') {
    const key = keys[header.kid] ?? Object.values(keys)[0];
    const expected = createHmac('sha256', key).update(h + '.' + p).digest('base64url');
    if (s !== expected) throw new Error('bad signature');
  }
  if (payload.exp !== undefined && now > payload.exp) throw new Error('expired');
  return payload;
}
`;

/** The token task's hidden checks: tokens it must accept and tokens it must refuse. */
const TOKEN_PROBE = [
  "import { createHmac } from 'node:crypto';",
  "import { verifyToken } from './src/token.mjs';",
  "const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');",
  "const sign = (header, payload, key) => { const h = enc(header); const p = enc(payload); return h + '.' + p + '.' + createHmac('sha256', key).update(h + '.' + p).digest('base64url'); };",
  "const keys = { k1: 'secret-one', k2: 'secret-two' };",
  'const now = 1800000000;',
  'const accepts = (t, at = now) => { try { verifyToken(t, keys, at); return true; } catch { return false; } };',
  "const hs = (payload, kid = 'k1', key = 'secret-one', alg = 'HS256') => sign({ alg, kid }, payload, key);",
  'const out = {};',
  "out.valid = (() => { try { return verifyToken(hs({ sub: 'u1', exp: now + 100 }), keys, now).sub === 'u1'; } catch { return false; } })();",
  "out.none = !accepts(enc({ alg: 'none', kid: 'k1' }) + '.' + enc({ sub: 'u1' }) + '.');",
  "out.otherAlg = !accepts(hs({ sub: 'u1' }, 'k1', 'secret-one', 'HS512'));",
  "out.unknownKid = !accepts(hs({ sub: 'u1' }, 'k9'));",
  "out.wrongKey = !accepts(hs({ sub: 'u1' }, 'k2', 'secret-one'));",
  'out.expired = !accepts(hs({ exp: now - 30 }));',
  'out.expLeeway = accepts(hs({ exp: now - 10 }));',
  'out.early = !accepts(hs({ nbf: now + 31 }));',
  'out.nbfLeeway = accepts(hs({ nbf: now + 10 }));',
  "out.malformed = !accepts('abc') && !accepts(hs({ sub: 'u1' }) + '.x');",
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

/** A deterministic random number generator (mulberry32), so a generated workspace is the same every time. */
function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The afternoon's access log for the forensics task: about 3,600 lines from 13:40 to 15:20 UTC.
 * Regular traffic, health checks every 10 seconds from two monitors (large answers), three heavy
 * clients inside 14:00-15:00, one heavy client just outside it, a burst of 5xx from api-2, a rare and
 * very slow export path, 5xx exactly at the hour's edges, and an edge server whose lines carry
 * +0100 local times. Deterministic.
 */
function accessLog() {
  const rand = seededRandom(20261030);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (sec, offsetHours = 0) => {
    const d = new Date((sec + offsetHours * 3600) * 1000);
    return `${pad(d.getUTCDate())}/Oct/2026:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${offsetHours ? '+0100' : '+0000'}`;
  };
  const line = ({ ip, sec, path, status, bytes, secs, upstream, offset = 0 }) =>
    `${ip} - - [${stamp(sec, offset)}] "GET ${path} HTTP/1.1" ${status} ${Math.round(bytes)} ${secs.toFixed(3)} upstream=${upstream}`;
  const start = Date.UTC(2026, 9, 30, 13, 40, 0) / 1000;
  const end = Date.UTC(2026, 9, 30, 15, 20, 0) / 1000;
  const hour = [Date.UTC(2026, 9, 30, 14, 0, 0) / 1000, Date.UTC(2026, 9, 30, 15, 0, 0) / 1000];
  const clients = Array.from({ length: 40 }, (_, i) => `172.16.${Math.floor(i / 10)}.${10 + i}`);
  const paths = [
    { path: '/api/orders', ups: ['api-1', 'api-2', 'api-3'], secs: [0.02, 0.2] },
    { path: '/api/users', ups: ['api-1', 'api-2', 'api-3'], secs: [0.01, 0.1] },
    { path: '/api/cart', ups: ['api-1', 'api-2', 'api-3'], secs: [0.05, 0.3] },
    { path: '/api/search', ups: ['search-1'], secs: [0.3, 0.7] },
  ];
  const entries = [];
  for (let sec = start; sec < end; sec += 1 + Math.floor(rand() * 3)) {
    const p = pick(paths);
    const upstream = pick(p.ups);
    const burst = upstream === 'api-2' && sec >= hour[0] + 600 && sec < hour[0] + 2400;
    const status = rand() < (burst ? 0.15 : 0.01) ? pick([500, 502, 503]) : 200;
    entries.push({ ip: pick(clients), sec, path: p.path, status, bytes: between(200, 5000), secs: between(...p.secs), upstream });
  }
  for (let sec = start; sec < end; sec += 10) {
    for (const ip of ['10.0.0.1', '10.0.0.2']) entries.push({ ip, sec, path: '/healthz', status: 200, bytes: 60000, secs: 0.001, upstream: 'api-1' });
  }
  const heavy = (ip, from, to, count, bytes, offset = 0) => {
    for (let k = 0; k < count; k += 1) {
      entries.push({ ip, sec: Math.floor(between(from, to)), path: '/api/orders', status: 200, bytes, secs: between(0.05, 0.2), upstream: 'api-1', offset });
    }
  };
  heavy('203.0.113.7', hour[0] + 60, hour[1] - 60, 40, 10000);
  heavy('198.51.100.23', hour[0] + 60, hour[1] - 60, 30, 10000);
  heavy('192.0.2.44', hour[0] + 60, hour[1] - 60, 12, 10000);
  heavy('192.0.2.44', hour[0] + 60, hour[1] - 60, 24, 10000, 1);
  heavy('203.0.113.99', start, hour[0] - 30, 50, 10000);
  for (let k = 0; k < 8; k += 1) {
    entries.push({ ip: '172.16.0.9', sec: Math.floor(between(hour[0] + 300, hour[1] - 300)), path: '/api/export', status: 200, bytes: 90000, secs: between(4, 6), upstream: 'api-3' });
  }
  for (const sec of [hour[0] - 1, hour[0], hour[1] - 1, hour[1]]) {
    entries.push({ ip: '172.16.1.20', sec, path: '/api/users', status: 503, bytes: 120, secs: 0.002, upstream: 'api-1' });
  }
  for (let k = 0; k < 150; k += 1) {
    const p = pick(paths);
    entries.push({ ip: pick(clients), sec: Math.floor(between(start, end)), path: p.path, status: rand() < 0.2 ? 502 : 200, bytes: between(200, 5000), secs: between(...p.secs), upstream: pick(p.ups), offset: 1 });
  }
  // Each server writes its own lines in order of time; the two logs were concatenated, then sorted
  // by the text of the time, as a careless merge does.
  return `${entries.map((e) => ({ e, text: line(e) })).sort((a, b) => { const x = a.text.slice(a.text.indexOf('[')); const y = b.text.slice(b.text.indexOf('[')); return x < y ? -1 : x > y ? 1 : 0; }).map((x) => x.text).join('\n')}\n`;
}

/** The forensics task's answers, from the log itself: what a correct reading of it finds. */
function logAnswers(text) {
  const months = { Oct: 9 };
  const re = /^(\S+) - - \[(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-])(\d\d)(\d\d)\] "GET (\S+) [^"]*" (\d+) (\d+) ([\d.]+) upstream=(\S+)$/;
  const from = Date.UTC(2026, 9, 30, 14, 0, 0);
  const to = Date.UTC(2026, 9, 30, 14, 59, 59);
  const errors = {};
  const bytes = new Map();
  const times = new Map();
  for (const raw of text.split('\n')) {
    const m = re.exec(raw);
    if (!m) continue;
    const [, ip, day, mon, year, hh, mm, ss, sign, oh, om, path, status, size, secs, upstream] = m;
    const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60000;
    const at = Date.UTC(Number(year), months[mon], Number(day), Number(hh), Number(mm), Number(ss)) - offset;
    if (at < from || at > to) continue;
    errors[upstream] = (errors[upstream] || 0) + (Number(status) >= 500 ? 1 : 0);
    if (path !== '/healthz') bytes.set(ip, (bytes.get(ip) || 0) + Number(size));
    const t = times.get(path) || { n: 0, total: 0 };
    times.set(path, { n: t.n + 1, total: t.total + Number(secs) });
  }
  const top = [...bytes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([ip]) => ip);
  const slowest = [...times].filter(([, t]) => t.n >= 20).sort((a, b) => b[1].total / b[1].n - a[1].total / a[1].n)[0][0];
  return { errors_by_upstream: errors, top_clients: top, slowest_path: slowest };
}

const ACCESS_LOG = accessLog();
const LOG_ANSWERS = Object.freeze(logAnswers(ACCESS_LOG));

// ---- Version 4: the roles version 3 left unmeasured, each task built around a mistake its own skill warns of ----

const PALETTE = Object.freeze({
  surface: '#ffffff', 'surface-alt': '#f1f3f5', 'surface-dark': '#1e293b',
  text: '#111827', 'text-muted': '#7c8591', 'text-on-dark': '#64748b', link: '#2077d6',
  success: '#1f9d63', danger: '#e5484d', 'border-input': '#c4cbd4', icon: '#959ca6', 'heading-accent': '#818cf8',
});

/** Where each color of the palette is used: on which background, and as what. */
const PALETTE_USAGE = Object.freeze([
  { foreground: 'text', background: 'surface', kind: 'text', where: 'body copy' },
  { foreground: 'text-muted', background: 'surface', kind: 'text', where: 'captions' },
  { foreground: 'text-muted', background: 'surface-alt', kind: 'text', where: 'table footnotes' },
  { foreground: 'text-on-dark', background: 'surface-dark', kind: 'text', where: 'footer links' },
  { foreground: 'link', background: 'surface', kind: 'text', where: 'links in body copy' },
  { foreground: 'success', background: 'surface', kind: 'large-text', where: 'status headlines, 24px' },
  { foreground: 'danger', background: 'surface', kind: 'text', where: 'form errors' },
  { foreground: 'border-input', background: 'surface', kind: 'non-text', where: 'text field borders' },
  { foreground: 'icon', background: 'surface-alt', kind: 'non-text', where: 'toolbar icons' },
  { foreground: 'heading-accent', background: 'surface-dark', kind: 'large-text', where: 'section headings on dark, 28px' },
]);

const CONTRAST_MIN = Object.freeze({ text: 4.5, 'large-text': 3, 'non-text': 3 });

const PALETTE_README = `# palette

\`design/tokens.json\` holds the palette: \`{ "color": { "<token>": "#rrggbb", ... } }\`.
\`design/usage.json\` lists where each color appears: a \`foreground\` token on a \`background\` token, as
\`text\`, \`large-text\` or \`non-text\` (icons, borders).

The palette must meet WCAG 2.2 AA everywhere it is used: a contrast ratio of at least 4.5:1 for \`text\`,
and 3:1 for \`large-text\` and \`non-text\`. The ratio is the exact one WCAG defines, never rounded: 4.497
is below 4.5.

- Change only the foreground colors that fall short somewhere they are used. The backgrounds, and the
  colors that pass wherever they appear, stay as they are.
- Change a color only in its HSL lightness: its hue and saturation stay as they are, as closely as
  \`#rrggbb\` can hold them.
- Of the lightness values that pass everywhere the color is used, take the one nearest its present one.

\`design/contrast.md\`: a table with one row per entry of \`design/usage.json\`: the pair, its kind, its ratio
before and after, and the color the foreground now has.
`;

/** An sRGB channel made linear, for WCAG 2's relative luminance. */
const linearChannel = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);

/** The WCAG contrast ratio of two colors, unrounded. */
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A #rgb or #rrggbb color as [r, g, b], or null. */
function rgbOf(text) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const hexOf = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** A color as [hue in degrees, saturation in percent, lightness in percent]. */
function hslOf([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [(h * 60 + 360) % 360, (d / (1 - Math.abs(2 * l - 1))) * 100, l * 100];
}

function rgbFromHsl(h, s, l) {
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * (s / 100);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

/** Whether `color` as `token` meets every pair it is the foreground of, the backgrounds as in `palette`. */
const passesWhereUsed = (token, color, palette) => PALETTE_USAGE.filter((p) => p.foreground === token)
  .every((p) => rgbOf(palette[p.background]) && contrastRatio(color, rgbOf(palette[p.background])) >= CONTRAST_MIN[p.kind]);

/** The HSL lightness nearest a token's own, in steps of 0.05, at which it passes wherever it is used. */
function nearestPassingLightness(token) {
  const [h, s, l] = hslOf(rgbOf(PALETTE[token]));
  for (let step = 0; step <= 2000; step += 1) {
    for (const L of [l - step * 0.05, l + step * 0.05]) {
      if (L >= 0 && L <= 100 && passesWhereUsed(token, rgbFromHsl(h, s, L), PALETTE)) return L;
    }
  }
  return null;
}

/** Where a color sits against the line of an original's hue and saturation: the nearest lightness on it, and how far a channel is off it there. */
function onHueLine(color, original) {
  const [h, s] = hslOf(original);
  let best = { lightness: 0, off: Infinity };
  for (let step = 0; step <= 2000; step += 1) {
    const off = Math.max(...rgbFromHsl(h, s, step * 0.05).map((v, i) => Math.abs(v - color[i])));
    if (off < best.off) best = { lightness: step * 0.05, off };
  }
  return best;
}

/** The colors that fall short somewhere, each with the lightness the palette's rules ask for. */
const PALETTE_FIXES = Object.freeze(Object.fromEntries(Object.keys(PALETTE)
  .filter((t) => !passesWhereUsed(t, rgbOf(PALETTE[t]), PALETTE))
  .map((t) => [t, nearestPassingLightness(t)])));

/**
 * The billing task's Cloud Billing export: one row per service, project and day, from 1 August to
 * 4 October 2026, in EUR. Compute Engine's development rows carry two credits; August's last day of
 * Compute Engine is billed on September's invoice, and September's last day of networking on
 * October's; BigQuery's September usage grows, but a one-off promotion credit takes it below August;
 * Cloud Run's rows sit a fraction of a cent off the cent, so rounding each row first loses money;
 * Vertex AI starts in September; and the invoice's tax, an adjustment and its rounding are rows of
 * their own. Deterministic.
 */
function billingExport() {
  const rand = seededRandom(20261101);
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const money = (n) => Number(n.toFixed(6));
  const rows = [];
  const add = (r) => rows.push({ project: 'shop-prod', cost_type: 'regular', credits: [], ...r });
  const DAY = 86400000;
  const first = Date.UTC(2026, 7, 1);
  const iso = (d) => d.toISOString().replace('.000Z', 'Z');
  for (let d = 0; d < 65; d += 1) {
    const start = new Date(first + d * DAY);
    const usage = { usage_start_time: iso(start), usage_end_time: iso(new Date(first + (d + 1) * DAY)) };
    const ym = `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    const sept = ym === '202609';
    const compute = (project, lo, hi) => {
      const cost = money(between(lo, hi));
      const credits = [{ name: 'Sustained use discount', amount: money(-cost * 0.08), type: 'SUSTAINED_USAGE_DISCOUNT' }];
      if (project === 'shop-dev') credits.push({ name: 'Free tier', amount: -0.75, type: 'FREE_TIER' });
      return { service: 'Compute Engine', sku: 'N2 Instance Core running in Frankfurt', project, cost, credits };
    };
    const lateAugust = ym === '202608' && start.getUTCDate() === 31;
    add({ ...usage, ...compute('shop-prod', 38, 42), invoice_month: lateAugust ? '202609' : ym });
    add({ ...usage, ...compute('shop-dev', 9, 11), invoice_month: lateAugust ? '202609' : ym });
    add({ ...usage, service: 'Cloud Storage', sku: 'Standard Storage Frankfurt', cost: money(between(6, 7)), invoice_month: ym });
    add({ ...usage, service: 'BigQuery', sku: 'Analysis', cost: money(sept ? between(16.5, 17.5) : between(11.5, 12.5)), invoice_month: ym });
    for (const project of ['shop-prod', 'shop-dev']) {
      add({ ...usage, service: 'Cloud Run', sku: 'CPU Allocation Time', project, cost: money(0.4137 + Math.floor(rand() * 3) / 100), invoice_month: ym });
    }
    if (start.getTime() >= Date.UTC(2026, 8, 10)) add({ ...usage, service: 'Vertex AI', sku: 'Online prediction', cost: money(between(20, 25)), invoice_month: ym });
    const lateSeptember = sept && start.getUTCDate() === 30;
    add({ ...usage, service: 'Networking', sku: 'Network Internet Egress Europe', cost: money(sept ? between(3.5, 4) : between(4.6, 5)), invoice_month: lateSeptember ? '202610' : ym });
  }
  const at = (day) => ({ usage_start_time: `2026-${day}T00:00:00Z`, usage_end_time: iso(new Date(Date.parse(`2026-${day}T00:00:00Z`) + DAY)) });
  add({ ...at('09-15'), service: 'BigQuery', sku: 'Analysis', cost: 0, invoice_month: '202609', credits: [{ name: 'Startup program', amount: -150, type: 'PROMOTION' }] });
  add({ ...at('09-30'), service: 'Cloud Storage', sku: 'Standard Storage Frankfurt', cost: -12.4, invoice_month: '202609', cost_type: 'adjustment' });
  add({ ...at('08-31'), service: 'Invoice', sku: 'Tax', project: '', cost: 371.42, invoice_month: '202608', cost_type: 'tax' });
  add({ ...at('09-30'), service: 'Invoice', sku: 'Tax', project: '', cost: 398.17, invoice_month: '202609', cost_type: 'tax' });
  add({ ...at('09-30'), service: 'Invoice', sku: 'Rounding', project: '', cost: 0.003, invoice_month: '202609', cost_type: 'rounding_error' });
  const quoted = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const header = 'service,sku,project,usage_start_time,usage_end_time,invoice_month,cost_type,cost,currency,credits';
  return `${header}\n${rows.map((r) => [r.service, r.sku, r.project, r.usage_start_time, r.usage_end_time, r.invoice_month, r.cost_type, r.cost, 'EUR', quoted(JSON.stringify(r.credits))].join(',')).join('\n')}\n`;
}

const BILLING_BUDGET = 'service,budget\nCompute Engine,1400\nCloud Storage,200\nBigQuery,400\nCloud Run,25.30\nVertex AI,450\nNetworking,120\n';

const BILLING_README = `# September invoice

\`billing/export.csv\` is our Cloud Billing export: one row per service, SKU, project and day. Amounts are in
the export's \`currency\`. \`credits\` is a JSON list of the row's credits, each with a negative \`amount\`.
\`billing/budget.csv\` is each service's budget for September 2026.

Write \`report.json\` for the September 2026 invoice, the rows whose \`invoice_month\` is \`202609\`:

    {
      "currency": "...",
      "services": { "<service>": { "cost": 0, "credits": 0, "net": 0 }, ... },
      "tax": 0, "adjustments": 0, "rounding": 0, "total": 0,
      "drivers": ["<service>", ...],
      "over_budget": ["<service>", ...]
    }

- \`services\`: for each service, its \`regular\` rows (\`cost_type\`): the sum of their \`cost\`, the sum of
  their credits, and \`net\`, the two together.
- \`tax\`, \`adjustments\` and \`rounding\`: the rows whose \`cost_type\` is \`tax\`, \`adjustment\` and
  \`rounding_error\`, each with its credits.
- \`total\`: everything on the invoice: every service's \`net\`, the tax, the adjustments and the rounding.
- \`drivers\`: the services whose \`net\` moved by more than 15% from the August 2026 invoice (\`202608\`),
  and those August's invoice does not have; the largest change in amount first.
- \`over_budget\`: the services whose \`net\` is over their budget, in alphabetical order.
- Amounts are rounded to the cent only as they are written.
`;

/** The billing task's answers, from the export and the budget themselves. */
function billingAnswers(text, budgetText) {
  const [header, ...rows] = csvRows(text);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const lines = rows.map((r) => ({
    service: r[col.service], month: r[col.invoice_month], type: r[col.cost_type], cost: Number(r[col.cost]),
    credits: sum(JSON.parse(r[col.credits]).map((c) => c.amount)),
  }));
  const regular = (month) => {
    const out = {};
    for (const l of lines.filter((x) => x.month === month && x.type === 'regular')) {
      const s = out[l.service] || (out[l.service] = { cost: 0, credits: 0, net: 0 });
      s.cost += l.cost;
      s.credits += l.credits;
      s.net += l.cost + l.credits;
    }
    return out;
  };
  const services = regular('202609');
  const previous = regular('202608');
  const ofType = (type) => sum(lines.filter((x) => x.month === '202609' && x.type === type).map((x) => x.cost + x.credits));
  const [tax, adjustments, rounding] = ['tax', 'adjustment', 'rounding_error'].map(ofType);
  const moves = Object.entries(services).map(([name, s]) => ({ name, change: s.net - (previous[name]?.net || 0), before: previous[name]?.net || 0 }));
  const budget = Object.fromEntries(csvRows(budgetText).slice(1).map(([name, b]) => [name, Number(b)]));
  return {
    services, tax, adjustments, rounding,
    total: sum(Object.values(services).map((s) => s.net)) + tax + adjustments + rounding,
    drivers: moves.filter((m) => !m.before || Math.abs(m.change / m.before) > 0.15).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).map((m) => m.name),
    overBudget: Object.keys(services).filter((name) => services[name].net > budget[name]).sort(),
  };
}

const BILLING_EXPORT = billingExport();
const BILLING_ANSWERS = Object.freeze(billingAnswers(BILLING_EXPORT, BILLING_BUDGET));

/** What each service's net catches, for its check's name. */
const BILLING_TRAPS = Object.freeze({
  'Compute Engine': "two credits on a row, and 31 August's late usage",
  'Cloud Storage': 'the adjustment is not a regular cost',
  BigQuery: 'its promotion credit',
  'Cloud Run': 'rounded once, at the end',
  'Vertex AI': 'new in September',
  Networking: "30 September's usage is on October's invoice",
});

const TRACKER_HEADER = Object.freeze(['ID', 'Action', 'Owner', 'Due', 'Status', 'Source', 'Opened', 'Updated', 'Note']);

const TRACKER_CSV = `${TRACKER_HEADER.join(',')}
A-1,Send the kickoff deck to the steering group,Lena,2026-10-09,done,Weekly 2026-10-07,2026-10-07,2026-10-09,
A-2,Prepare the launch checklist,Sam,2026-11-12,open,Weekly 2026-10-14,2026-10-14,2026-10-28,
A-3,Review the vendor contract,Priya,2026-11-02,open,Weekly 2026-10-21,2026-10-21,2026-10-28,
A-4,Update the onboarding guide,missing,2026-11-20,open,Weekly 2026-10-07,2026-10-07,2026-10-07,
A-5,Run the load test on staging,Omar,2026-11-09,open,Weekly 2026-10-21,2026-10-21,2026-10-28,
A-6,Build the analytics dashboard,Raj,2026-11-16,open,Weekly 2026-10-28,2026-10-28,2026-10-28,
A-7,Run the customer survey,Lena,2026-11-30,open,Weekly 2026-10-14,2026-10-14,2026-10-21,
A-8,Collect the security questionnaire answers,Wen,2026-10-30,open,Weekly 2026-10-14,2026-10-14,2026-10-14,
`;

const TRACKER_NOTES = `# Weekly project meeting, Wednesday 4 November 2026

Attendees: Lena (chair), Sam, Priya, Omar, Raj, Wen

## Updates

- Priya: the vendor contract review is finished and signed off (A-3).
- Omar can't start the staging load test (A-5) until the staging environment is rebuilt; he is waiting on the infrastructure ticket.
- Lena asked whether the launch checklist (A-2) could move to Friday 20 November, to fit the new launch date. Sam agreed.
- Lena would like Raj's analytics dashboard (A-6) a week earlier, by 9 November. Raj said he would try, but couldn't commit to it.
- Marketing is running its own customer survey, so we're dropping ours (A-7).

## Discussion

- Wen will send the updated vendor list by Friday.
- Priya will draft the migration runbook by the end of next week.
- We should refresh the risk register soon.
- Sam will book the venue for the launch party by the 18th.
- Omar mentioned he might look at caching for the reports page at some point.
- Lena: could someone check when the TLS certificate expires? Omar: I'll check it today.
`;

const TRACKER_README = `# action tracker

\`tracker.csv\` is the project's action tracker: \`${TRACKER_HEADER.join(',')}\`. Dates are YYYY-MM-DD. Status
is \`open\`, \`done\`, \`blocked\` or \`dropped\`. An unknown owner or due date is \`missing\`, never a guess.

After a meeting, the tracker is updated from its notes:

- **Never delete a row,** and never rewrite an item's ID, Action, Owner, Source or Opened. A change to an
  item sets its Status, its Note (why it changed) and its Updated (the meeting's date). Its Due changes
  only when its owner agreed the new date; a date someone asked for without that goes in the Note.
- **Each new action item** is a new row: the next ID (\`A-<n>\`, in the order the notes give them), the
  action, its owner, its due date, \`open\`, the meeting as its Source (\`Weekly <date>\`), and the meeting's
  date as Opened and Updated.
- An action item is a commitment a named person made, or a request someone accepted. "We", "the team"
  or "someone" is no owner: \`missing\`. A remark that commits no one ("might", "at some point") is not an
  item.
- A due date in words is read against the meeting's date: a weekday is the next one after the meeting,
  "today" is the meeting's date, "the 18th" is the next 18th, and "the end of next week" is the Friday
  of the week after the meeting's (weeks start on Monday). "Soon" or "later" is \`missing\`.

\`flags.json\`, as of the meeting's date, from the tracker as updated:

    { "overdue": [...], "unowned": [...], "stale": [...] }

- \`overdue\`: open items whose Due is before the meeting's date.
- \`unowned\`: open or blocked items whose Owner is \`missing\`.
- \`stale\`: open items whose Updated is more than 14 days before the meeting's date.

Each list holds IDs in the order of their number (A-2 before A-10).
`;

const CONTRACT_MD = `# Software Subscription Agreement

This Software Subscription Agreement (the "Agreement") is made between Northwind Analytics Ltd ("Supplier") and Harbor Logistics GmbH ("Customer").

## 1. Definitions

1.1 "Effective Date" means 15 March 2026.

1.2 "Services" means the hosted analytics platform described in Schedule A.

1.3 "Subscription Fee" means the annual fee set out in Schedule A.

1.4 "Customer Materials" means data, files and other content that Customer uploads to the Services.

1.5 "Business Day" means a day other than a Saturday, a Sunday or a public holiday in Germany.

## 2. Services

2.1 Supplier shall provide the Services to Customer from the Effective Date.

2.2 Supplier shall deliver an implementation plan to Customer within forty-five (45) days after the Effective Date.

## 3. Term and renewal

3.1 This Agreement starts on the Effective Date and continues for twenty-four (24) months (the "Initial Term").

3.2 After the Initial Term, this Agreement renews automatically for successive periods of twelve (12) months (each a "Renewal Term"), unless either party gives written notice of non-renewal at least ninety (90) days before the end of the then-current term.

## 4. Fees and payment

4.1 Customer shall pay the Subscription Fee of EUR 48,000 per year, invoiced annually in advance.

4.2 Customer shall pay each invoice within thirty (30) days of the invoice date.

4.3 Supplier may increase the Subscription Fee for a Renewal Term by written notice given at least sixty (60) days before that Renewal Term starts.

## 5. Service levels

5.1 Supplier shall make the Services available 99.5% of the time in each calendar month.

5.2 Customer may claim a service credit for a month by notice given within ten (10) Business Days after the end of that month.

## 6. Confidentiality

6.1 Each party shall keep the other party's confidential information confidential during the term of this Agreement and for three (3) years after it ends.

## 7. Data protection

7.1 Supplier shall process Customer Data only on Customer's documented instructions.

7.2 Supplier shall notify Customer of any personal data breach affecting Customer Materials within seventy-two (72) hours after becoming aware of it.

## 8. Liability

8.1 Each party's total liability under this Agreement is limited to the fees paid in the twelve (12) months before the claim.

## 9. Termination

9.1 Either party may terminate this Agreement by written notice if the other party commits a material breach.

9.2 A party may terminate under Section 9.1 only if the breach is not cured within thirty (30) days after notice of it, following the procedure in Section 9.4.

9.3 Sections 6, 8 and 10 survive termination.

## 10. General

10.1 This Agreement is governed by the laws of England and Wales.

10.2 Notices under this Agreement must be in writing and sent to the addresses in Schedule B.

## Schedule A: Services and fees

Services: the Northwind hosted analytics platform, Business edition, for up to 50 users.

Subscription Fee: EUR 45,000 per year.
`;

const CONTRACT_README = `# contract review

Write \`review.json\` from \`contract.md\`:

    {
      "initial_term_ends": "YYYY-MM-DD",
      "non_renewal_notice_by": "YYYY-MM-DD",
      "price_increase_notice_by": "YYYY-MM-DD",
      "implementation_plan_due": "YYYY-MM-DD",
      "april_2026_credit_claim_by": "YYYY-MM-DD",
      "inconsistencies": [{ "sections": ["..."], "issue": "...", "quote": "..." }]
    }

- \`initial_term_ends\`: the last day of the Initial Term. A period of N months from a date ends on the day
  before the same date N months later.
- \`non_renewal_notice_by\`: the last day a notice of non-renewal can be given for the agreement to end with
  its Initial Term.
- \`price_increase_notice_by\`: the last day Supplier can give notice of a price increase for the first
  Renewal Term.
- \`implementation_plan_due\`: the last day for the implementation plan of Section 2.2.
- \`april_2026_credit_claim_by\`: the last day Customer can claim a service credit for April 2026.
- "At least N days before" a date is at the latest that date minus N days; "within N days after" a date
  ends N days after it. Germany's nationwide public holidays in 2026 that fall on a weekday are 1 January,
  3 April, 6 April, 1 May, 14 May, 25 May and 25 December.
- \`inconsistencies\`: every place the document contradicts itself or points at nothing: two provisions
  that state different amounts for the same thing, a reference to a section or schedule the document does
  not contain, and a term used as a defined one (capitalized) that the document never defines. \`sections\`
  says where each is (\`"4.1"\`, \`"Schedule A"\`); \`quote\` is the text at issue, copied exactly from
  \`contract.md\`.

\`contract.md\` is the document under review: leave it as it is. This review is an aid for our lawyer, not
legal advice.
`;

/** Each attendee's calendar for the meeting-times task. */
const MEETING_CALENDARS = Object.freeze({
  'calendars/lena.json': {
    zone: 'America/New_York',
    working_hours: { start: '08:30', end: '17:30' },
    events: [
      { title: '1:1 with Sam', start: '2026-10-05T11:00', end: '2026-10-05T11:30', repeat: 'weekdays' },
      { title: 'Dentist', start: '2026-11-04T13:30', end: '2026-11-04T14:30' },
      { title: 'Budget sync', start: '2026-11-06T11:30', end: '2026-11-06T12:00', status: 'cancelled' },
    ],
  },
  'calendars/omar.json': {
    zone: 'Europe/Berlin',
    working_hours: { start: '09:00', end: '18:30' },
    events: [
      { title: 'Partner call', start: '2026-11-02T16:45:00Z', end: '2026-11-02T17:15:00Z' },
      { title: 'Team lunch', start: '2026-11-03T12:00', end: '2026-11-03T13:00' },
      { title: 'Out of office', date: '2026-11-05' },
    ],
  },
  'calendars/kenji.json': {
    zone: 'America/Los_Angeles',
    working_hours: { start: '08:00', end: '17:00' },
    events: [
      { title: 'Vendor demo', start: '2026-11-03T08:30', end: '2026-11-03T09:30', response: 'declined' },
      { title: 'Focus time', start: '2026-11-04T08:00', end: '2026-11-04T10:00', show_as: 'free' },
      { title: 'Hiring panel', start: '2026-11-06T09:30', end: '2026-11-06T10:30' },
    ],
  },
});

const MEETING_README = `# meeting times

\`calendars/<name>.json\` is each attendee's calendar: their \`zone\` (an IANA time zone), their
\`working_hours\` (\`start\` and \`end\`, local time, Monday to Friday) and their \`events\`.

- An event's \`start\` and \`end\` are local times in the calendar's zone, unless they end in \`Z\` (UTC). An
  all-day event has a \`date\` instead, and takes that whole day in the calendar's zone. \`"repeat":
  "weekdays"\` repeats an event at the same local time every Monday to Friday from its first day.
- An event blocks its time unless it is cancelled (\`"status": "cancelled"\`), its attendee declined it
  (\`"response": "declined"\`), or it shows as free (\`"show_as": "free"\`). An event that ends as a time
  starts, or starts as it ends, does not overlap it.
- A time works when it starts on the hour or the half hour, lies within every attendee's working hours
  that day in their own zone, and overlaps no event that blocks for any of them.

Write \`options.json\`: the three earliest times that work, earliest first:

    [{ "start_utc": "2026-...Z", "end_utc": "2026-...Z", "local": { "lena": "YYYY-MM-DD HH:MM", "omar": "...", "kenji": "..." } }, ...]

\`local\` is each attendee's start time in their own zone.
`;

/** The three times the meeting rules allow (worked out by hand, and checked in the tests with Intl). */
const MEETING_TIMES = Object.freeze(['2026-11-03', '2026-11-04', '2026-11-06'].map((day) => Object.freeze({
  start: `${day}T16:30:00Z`,
  local: Object.freeze({ lena: `${day} 11:30`, omar: `${day} 17:30`, kenji: `${day} 08:30` }),
})));

const SITE_NAV = '<nav><a href="/">Home</a> <a href="/pricing-2025">Pricing</a> <a href="/news/">News</a> <a href="/about">About</a> <a href="/docs/api">API</a></nav>';

function sitePage(title, body, { head = '', css = 'css/site.css', logo = 'img/logo.svg', nav = SITE_NAV } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="${css}">${head}
</head>
<body>
<header><img src="${logo}" alt="Northwind"> ${nav}</header>
<main>
${body}
</main>
</body>
</html>
`;
}

const SITE_FILES = Object.freeze({
  'firebase.json': `${JSON.stringify({
    hosting: {
      public: 'public',
      cleanUrls: true,
      redirects: [
        { source: '/about', destination: '/company', type: 301 },
        { source: '/company', destination: '/company/overview', type: 301 },
        { source: '/docs/**', destination: '/help', type: 301 },
        { source: '/docs/api', destination: '/developers/api', type: 301 },
        { source: '/blog/:year/:slug', destination: '/news/:year/:slug', type: 301 },
        { source: '/pricing-2025', destination: '/pricing', type: 301 },
      ],
    },
  }, null, 2)}\n`,
  'public/index.html': sitePage('Northwind', '<h1>Analytics for logistics teams</h1>\n<p>Every shipment and every lane, in one place. <a href="/blog/2025/launch">Read about our launch</a>.</p>'),
  'public/pricing.html': sitePage('Pricing', '<h1>Pricing</h1>\n<p>Plans start at 49 euros a month. The <a href="https://www.example.com/blog/2025/launch">launch post</a> says what each plan includes.</p>'),
  'public/news/index.html': sitePage('News', '<h1>News</h1>\n<ul>\n<li><a href="2025/launch.html">Launch</a>: Northwind is live.</li>\n</ul>'),
  'public/news/2025/launch.html': sitePage('Northwind is live', '<h1>Northwind is live</h1>\n<p>Today we open Northwind to every logistics team. <a href="../../about.html">About us</a> | <a href="../index.html">All news</a></p>', { css: '../../css/site.css', logo: '../../img/logo.svg' }),
  'public/company/overview.html': sitePage('About Northwind', '<h1>About Northwind</h1>\n<p>We build analytics for logistics teams. New here? Start with <a href="/docs/start">Getting started</a>.</p>', { css: '/css/site.css', logo: '/img/logo.svg' }),
  'public/help.html': sitePage('Help', '<h1>Help</h1>\n<p>Guides and answers for every part of Northwind.</p>'),
  'public/404.html': sitePage('Page not found', '<h1>Page not found</h1>\n<p><a href="/">Go to the home page</a></p>', { css: '/css/site.css', logo: '/img/logo.svg', nav: '' }),
  'public/drafts/pricing-v2.html': sitePage('Pricing (draft)', '<h1>Pricing</h1>\n<p>Draft: plans from 39 euros a month.</p>', { head: '\n<meta name="robots" content="noindex">', css: '/css/site.css', logo: '/img/logo.svg' }),
  'public/css/site.css': 'body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 48rem; }\n',
  'public/img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><text x="0" y="24">Northwind</text></svg>\n',
});

const SITE_README = `# site

\`public/\` is the site's source, served by Firebase Hosting as \`firebase.json\` says. With \`cleanUrls\`,
\`/news/2025/launch\` serves \`public/news/2025/launch.html\`, a page's address with \`.html\` redirects to the
one without it, and a directory's \`index.html\` is served at the directory's address with its trailing
slash (\`/news/\`). Hosting applies the first redirect in \`redirects\` whose \`source\` matches (\`:name\` is one
path segment, \`**\` any number of them) before it serves any file.

Several pages moved, and the redirects keep their old addresses working. Fix the site:

- Every link (\`<a href>\`) to one of our pages, written relative, root-relative or on
  \`https://www.example.com\`, points straight at that page's own address: root-relative, its path without
  \`.html\` (for a directory's index, the directory's path with its trailing slash), reached with no redirect.
- Every stylesheet and image a page loads (\`<link href>\`, \`<img src>\`) is a file in \`public/\`.
- \`public/sitemap.xml\` lists, each as a \`<url><loc>\`, the full address (\`https://www.example.com\` and the
  page's own address) of every page a search engine should index: not the 404 page, and not a page marked
  \`<meta name="robots" content="noindex">\`.

Leave \`firebase.json\`, and the text of every page, as they are.
`;

/** A page's own address on the site, from its file under public/: `/`, `/news/`, `/news/2025/launch`. */
const sitePath = (rel) => `/${rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;
const SITE_PAGES = Object.freeze(Object.keys(SITE_FILES).filter((f) => f.startsWith('public/') && f.endsWith('.html')).map((f) => f.slice('public/'.length)));
const SITE_INDEXED = Object.freeze(['/', '/pricing', '/news/', '/news/2025/launch', '/company/overview', '/help']);

/** A page's text as a reader sees it: tags dropped, spaces collapsed. */
const pageText = (html) => String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** A page's links, with their text, and the stylesheets and images it loads. */
function pageRefs(html) {
  const links = [...String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[2].trim(), text: pageText(m[3]) }));
  const assets = [...String(html).matchAll(/<(?:link|img|script)\b[^>]*?\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)].map((m) => m[2].trim());
  return { links, assets };
}

/** A link's path on the site, or null when it leads elsewhere. */
function sitePathOf(href, page) {
  if (/^(mailto:|tel:|#)/i.test(href)) return null;
  const url = new URL(href, `https://www.example.com${sitePath(page)}`);
  return url.origin === 'https://www.example.com' ? url.pathname : null;
}

/** Whether every create or update in `actions` comes after those of what it needs, and every delete after the deletes of what needs it. */
function planOrderHolds(actions) {
  const at = new Map(actions.map((a, i) => [a, i]));
  const changed = actions.filter((a) => !a.startsWith('delete '));
  const lastChange = Math.max(-1, ...changed.map((a) => at.get(a)));
  for (const a of actions) {
    const [op, id] = a.split(' ');
    if (op === 'delete') {
      if (at.get(a) < lastChange) return false;
      for (const [other, r] of Object.entries(PLAN_CURRENT)) {
        if ((r.depends_on || []).includes(id) && at.has(`delete ${other}`) && at.get(`delete ${other}`) > at.get(a)) return false;
      }
    } else {
      for (const need of PLAN_DESIRED[id]?.depends_on || []) {
        const before = ['create', 'update'].map((o) => at.get(`${o} ${need}`)).find((x) => x !== undefined);
        if (before !== undefined && before > at.get(a)) return false;
      }
    }
  }
  return true;
}

/** A brief's words that hold a letter or a digit, so bullet marks and dashes are not counted. */
const wordsOf = (text) => String(text).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
/** Text compared as words only: lower case, punctuation and a leading priority dropped. */
const plainWords = (text) => String(text).toLowerCase().replace(/^\s*[-*]\s*/, '').replace(/^\[?p[0-3]\]?[:\s-]*/, '').replace(/[^a-z0-9%]+/g, ' ').trim();

/**
 * The customer portal plan, in the order of its workstreams: ID, workstream, task, duration in working
 * days, predecessors, owner. Built so that a holiday falls inside a task (T13), a task starts right after
 * a holiday weekend (T9), a start-to-start lag (T6) and a finish-to-finish link (T11) set a start, a lag
 * crosses Christmas (T20), and the change request turns the screens and the security review critical
 * in place of the API, with M2 left a day of float.
 */
const PM_PLAN = Object.freeze([
  ['T1', 'Discovery', 'Kickoff workshop', 2, '', 'Lena'],
  ['T2', 'Discovery', 'Interview stakeholders', 5, 'T1', 'Priya'],
  ['T3', 'Discovery', 'Write the requirements', 4, 'T2', 'Priya'],
  ['M1', 'Discovery', 'Requirements signed off', 0, 'T3', 'Lena'],
  ['T4', 'API', 'Design the data model', 4, 'M1', 'Omar'],
  ['T5', 'API', 'Build the API', 15, 'T4', 'Omar'],
  ['T6', 'API', 'Write the API guide', 5, 'T5SS+4', 'Omar'],
  ['T7', 'API', 'Load test the API', 3, 'T5', 'Raj'],
  ['T8', 'Screens', 'Design the screens', 7, 'M1', 'Wen'],
  ['T9', 'Screens', 'Usability test the designs', 3, 'T8', 'Wen'],
  ['T10', 'Screens', 'Build the screens', 8, 'T9', 'Sam'],
  ['T11', 'Screens', 'Write the help content', 4, 'T9;T10FF', 'Ana'],
  ['T12', 'Data', 'Map the legacy data', 5, 'M1', 'Kenji'],
  ['T13', 'Data', 'Write the migration scripts', 6, 'T12', 'Kenji'],
  ['T14', 'Data', 'Trial migration', 2, 'T13;T4', 'Kenji'],
  ['T15', 'Data', 'Final data migration', 2, 'T14;T19', 'Kenji'],
  ['T16', 'Integration and testing', 'Order the test devices', 25, '', 'Raj'],
  ['T17', 'Integration and testing', 'Integrate the screens and the API', 5, 'T5;T10', 'Omar'],
  ['M2', 'Integration and testing', 'Feature complete', 0, 'T17;T11;T7', 'Lena'],
  ['T18', 'Integration and testing', 'System testing', 8, 'M2;T16', 'Raj'],
  ['T19', 'Integration and testing', 'Fix defects', 6, 'T18SS+3', 'Sam'],
  ['T20', 'Integration and testing', 'Security review', 8, 'T17+2', 'Raj'],
  ['T21', 'Launch', 'Prepare the training material', 6, 'M2', 'Ana'],
  ['T22', 'Launch', 'Train the support team', 3, 'T21;T18', 'Ana'],
  ['M3', 'Launch', 'Ready for launch', 0, 'T15;T19;T20;T22', 'Lena'],
  ['T23', 'Launch', 'Go live', 1, 'M3', 'Lena'],
  ['T24', 'Launch', 'Hypercare', 5, 'T23', 'Omar'],
  ['M4', 'Launch', 'Project closed', 0, 'T24', 'Lena'],
]);

const PM_PLAN_CSV = `ID,Workstream,Task,Duration,Predecessors,Owner\n${PM_PLAN.map((r) => r.join(',')).join('\n')}\n`;

const PM_HOLIDAYS = Object.freeze(['2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25', '2027-01-01']);

const PM_CALENDAR = `# Working calendar

Working days are Monday to Friday. No one works on these holidays:

- Thursday 26 November 2026
- Friday 27 November 2026
- Thursday 24 December 2026
- Friday 25 December 2026
- Friday 1 January 2027

Notes:

- Boxing Day, 26 December 2026, falls on a Saturday. There is no day off in lieu: Monday 28 December 2026 is
  a working day.
- The office closes at noon on Thursday 31 December 2026. For planning it counts as a full working day.
`;

const PM_CHANGE = `# Change request CR-4: account pages and security sign-off

Raised by Sam. Agreed by the steering group on Friday 30 October 2026, after plan.csv was drawn up;
plan.csv has not been updated.

## Agreed

1. **Build the screens (T10) takes 12 working days instead of 8.** The design system we meant to reuse does
   not cover the account pages, so they are built from scratch.
2. **The final data migration (T15) waits for the security review (T20).** Customer data may be moved only
   once the review has signed off: T15 also depends on T20, finish to start, with no lag.

## Not agreed

- Moving the kickoff to Wednesday 4 November: the plan keeps its start date.
- Shortening the security review (T20) to 5 working days: the reviewers need all 8.
`;

const PM_README = `# customer portal plan

\`plan.csv\` is the plan for the customer portal: one row per task, as \`ID,Workstream,Task,Duration,Predecessors,Owner\`.
\`Duration\` is in working days. \`Predecessors\` lists what a task waits for, separated by \`;\`. The milestones,
\`M1\` to \`M4\`, are tasks of duration 0. \`calendar.md\` says which days are working days.

## Scheduling

- The project starts on Monday 2 November 2026. A task with no predecessors starts that day.
- A task of duration d finishes on the d-th working day counting its Start as the first: a 1-day task
  finishes the day it starts, and a 3-day task that starts on a Thursday finishes on the Monday after (when
  no holiday falls between).
- Every other task starts on the earliest working day that every one of its predecessors allows:
  - \`T3\` (finish to start): the next working day after T3 finishes, or later.
  - \`T3+2\` (finish to start with a lag of 2): 2 working days after that next working day, or later. If T3
    finishes on a Friday, \`T3\` allows a start on the Monday after and \`T3+2\` on the Wednesday (when no
    holiday falls between).
  - \`T3SS+2\` (start to start with a lag of 2): 2 working days after the day T3 starts, or later.
  - \`T3FF\` (finish to finish): the task finishes on the day T3 finishes, or later; it starts on the
    earliest day that allows, given its duration.
- A milestone takes no working day. It falls on the day its last predecessor finishes (that day, not the
  next working day), and that date is both its Start and its Finish. A task that waits for a milestone
  starts on the next working day after the milestone's date, or later, as after any task. Milestones here
  wait only finish to start, with no lag.
- The project finish is the latest Finish of any task.

## Float and the critical path

- Late dates come from the critical path method's backward pass. A task's late Finish is the latest
  working day on which it can finish, no later than the project finish, such that each of its successors
  can still start (for \`FF\`, finish) on its own late date under the rule that links them. Its late Start
  follows from its late Finish and its duration, as its Start does from its Finish. A milestone's late
  Start and late Finish are its late date.
- A task's total float is the number of working days from its Finish to its late Finish (0 when they are
  the same day).
- The critical path is every task, milestones included, whose total float is 0, in the order of their
  Start (those with the same Start in the order of plan.csv).

## The change request

\`notes/change-request.md\` says what was agreed after plan.csv was drawn up. The schedule after the change is
plan.csv with every agreed change applied, scheduled again by the same rules from the same start date.

## What to write

- \`schedule.csv\`: the schedule before the change: the header \`ID,Start,Finish\`, then one row for each task
  in the order of plan.csv, with its Start and Finish as YYYY-MM-DD.
- \`impact.json\`:

      {
        "finish_before": "YYYY-MM-DD",
        "finish_after": "YYYY-MM-DD",
        "critical_before": ["<ID>", ...],
        "critical_after": ["<ID>", ...],
        "slipped_milestones": { "<ID>": <working days>, ... }
      }

  \`finish_before\` and \`finish_after\` are the project finish before and after the change, and
  \`critical_before\` and \`critical_after\` the critical path before and after it. \`slipped_milestones\`
  holds each milestone whose date is later after the change, with the number of working days it moved:
  the working days after its date before, up to and including its date after (from a Friday to the
  Tuesday after is 2, when no holiday falls between). A milestone that did not move is left out.
`;

/** The plan's answers (worked out by hand, and checked in the tests by a scheduler of their own). */
const PM_EXPECTED = Object.freeze({
  dates: Object.freeze({
    T13: ['2026-11-24', '2026-12-03'], T9: ['2026-11-30', '2026-12-02'], T6: ['2026-12-01', '2026-12-07'],
    T11: ['2026-12-09', '2026-12-14'], M1: ['2026-11-16', '2026-11-16'], M2: ['2026-12-22', '2026-12-22'], T20: ['2026-12-29', '2027-01-08'],
  }),
  finishBefore: '2027-01-19',
  finishAfter: '2027-01-25',
  criticalBefore: Object.freeze(['T1', 'T2', 'T3', 'M1', 'T4', 'T5', 'T17', 'M2', 'T18', 'T19', 'T22', 'T15', 'M3', 'T23', 'T24', 'M4']),
  criticalAfter: Object.freeze(['T1', 'T2', 'T3', 'M1', 'T8', 'T9', 'T10', 'T17', 'T20', 'T15', 'M3', 'T23', 'T24', 'M4']),
  slips: Object.freeze({ M2: 3, M3: 4, M4: 4 }),
});

/** Whether `iso` is a YYYY-MM-DD date that is a working day of the plan's calendar. */
function pmWorkingDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const day = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === iso && ![0, 6].includes(day.getUTCDay()) && !PM_HOLIDAYS.includes(iso);
}

// ---- Version 5, design-token-build: layered design tokens built into CSS variables ----

/** A design token: its `$value`, and whatever else it carries. */
const designToken = (value, more = {}) => ({ $value: value, ...more });
/** A group of design tokens from `{ name: value }`, with the group's own fields (its `$type`) as given. */
const designGroup = (values, more = {}) => ({ ...more, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, designToken(v)])) });
const translucent = (value, alpha) => designToken(value, { $extensions: { alpha } });
const designShadow = (offsetX, offsetY, blur, spread, color) => ({ offsetX, offsetY, blur, spread, color });

/**
 * The design-token task's files, W3C design tokens in four layers. Built around the ways a build goes
 * wrong: base.json aliases a token only the themes define, so aliases resolve only after the layers
 * merge; the brand overrides primitives that light and dark name through aliases; dark.json closes a
 * cycle that light never sees, and a base token leans on it; a theme token names a token only the brand
 * defines; dark.json replaces a translucent token with an opaque one; and the ocean block's light values
 * must be undone for an element that is also dark.
 */
const DESIGN_TOKEN_FILES = Object.freeze({
  'tokens/base.json': {
    color: {
      $type: 'color',
      white: designToken('#FFF'),
      black: designToken('#000'),
      gray: designGroup({ 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a' }),
      brand: designGroup({ 100: '#dbeafe', 300: '#93c5fd', 500: '#3b82f6', 600: '#2563EB', 700: '#1d4ed8', 900: '#1e3a8a' }),
      red: designGroup({ 500: '#ef4444', 600: '#dc2626' }),
      green: designGroup({ 500: '#22c55e', 600: '#16a34a' }),
      amber: designGroup({ 500: '#f59e0b', 600: '#d97706' }),
      text: { link: designToken('{color.action.primary}') },
      focus: { ring: designToken('{color.brand.500}') },
      border: { strong: designToken('{color.gray.400}') },
      overlay: { hover: translucent('{color.brand.600}', 0.08) },
      selection: { bg: translucent('{color.overlay.hover}', 0.24), border: translucent('{color.selection.bg}', 1) },
      legacy: { highlight: designToken('{color.yellow.200}', { $description: "The old editor's highlight" }) },
    },
    fontFamily: {
      $type: 'fontFamily',
      body: designToken(['Inter', 'Segoe UI', 'system-ui', 'sans-serif']),
      heading: designToken(['Source Serif 4', 'Georgia', 'serif']),
      mono: designToken('JetBrains Mono'),
    },
    fontSize: designGroup({ sm: '14px', base: '16px', lg: '18px', '2xl': '24px' }, { $type: 'dimension' }),
    fontWeight: designGroup({ regular: 400, semibold: 600, bold: 700 }, { $type: 'fontWeight' }),
    lineHeight: designGroup({ tight: 1.25, normal: 1.5 }, { $type: 'number' }),
    letterSpacing: designGroup({ tight: '-0.01em', wide: '0.025em' }, { $type: 'dimension' }),
    space: designGroup({ 0: '0px', px: '1px', 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px', 10: '40px' }, { $type: 'dimension' }),
    radius: { ...designGroup({ none: '0px', sm: '4px', md: '6px', lg: '12px', full: '9999px' }, { $type: 'dimension' }), control: designToken('{radius.md}') },
    borderWidth: designGroup({ hairline: '0.5px', thin: '1px', thick: '2px' }, { $type: 'dimension' }),
    shadow: {
      $type: 'shadow',
      sm: designToken(designShadow('0px', '{borderWidth.thin}', '2px', '0px', '{color.shadow}')),
      md: designToken(designShadow('0px', '4px', '8px', '-2px', '{color.shadow}')),
      lg: designToken([designShadow('0px', '12px', '24px', '-4px', '{color.shadow}'), designShadow('0px', '4px', '8px', '-2px', '{color.shadow}')]),
    },
    motion: {
      duration: designGroup({ fast: '120ms', slow: '320ms' }, { $type: 'duration' }),
      easing: designGroup({ standard: [0.2, 0, 0, 1], decelerate: [0, 0, 0.2, 1] }, { $type: 'cubicBezier' }),
    },
    opacity: designGroup({ disabled: 0.4 }, { $type: 'number' }),
    component: {
      button: {
        primary: { bg: designToken('{color.action.primary}'), bgHover: designToken('{color.action.primaryHover}'), text: designToken('{color.action.primaryText}') },
        radius: designToken('{radius.control}'),
      },
      link: { color: designToken('{color.text.link}') },
      input: { border: designToken('{color.border.default}') },
      card: { padding: designToken('{space.6}'), shadow: designToken('{shadow.md}') },
      dialog: { backdrop: designToken('{color.overlay.scrim}') },
    },
  },
  'tokens/light.json': {
    color: {
      $type: 'color',
      bg: designGroup({ canvas: '{color.white}', surface: '{color.gray.50}', subtle: '{color.gray.100}', selected: '{color.brand.100}' }),
      text: designGroup({ default: '{color.gray.900}', muted: '{color.gray.600}', inverse: '{color.white}', accent: '{color.brand.highlight}' }),
      border: designGroup({ default: '{color.gray.200}' }),
      action: designGroup({ primary: '{color.brand.600}', primaryHover: '{color.brand.700}', primaryText: '{color.white}' }),
      status: designGroup({ danger: '{color.red.600}', success: '{color.green.600}', warning: '{color.amber.600}' }),
      overlay: { scrim: translucent('{color.gray.900}', 0.5) },
      shadow: translucent('{color.gray.900}', 0.12),
    },
  },
  'tokens/dark.json': {
    color: {
      $type: 'color',
      bg: designGroup({ canvas: '{color.gray.900}', surface: '{color.gray.800}', subtle: '{color.gray.800}', elevated: '{color.gray.700}', selected: '{color.brand.700}' }),
      text: designGroup({ default: '{color.gray.50}', muted: '{color.gray.400}', inverse: '{color.gray.900}', accent: '{color.brand.highlight}' }),
      border: designGroup({ default: '{color.border.strong}', strong: '{color.border.default}' }),
      action: designGroup({ primary: '{color.brand.500}', primaryHover: '{color.brand.300}', primaryText: '#ffffff' }),
      status: designGroup({ danger: '#DC2626', success: '{color.green.500}', warning: '{color.amber.500}' }),
      overlay: { scrim: translucent('{color.black}', 0.64), hover: designToken('{color.gray.700}') },
      shadow: translucent('{color.black}', 0.48),
    },
  },
  'tokens/brand-ocean.json': {
    color: {
      $type: 'color',
      brand: designGroup({ 100: '#CFFAFE', 600: '#0e7490', 700: '#155e75', highlight: '#fb923c' }),
      focus: { ring: designToken('{color.action.primary}') },
    },
    fontFamily: { $type: 'fontFamily', heading: designToken(['Fraunces', 'Iowan Old Style', 'serif']) },
    radius: designGroup({ md: '10px' }, { $type: 'dimension' }),
    shadow: { $type: 'shadow', focus: designToken(designShadow('0px', '0px', '0px', '3px', '{color.brand.400}')) },
  },
});

const DESIGN_TOKEN_TEXT = Object.freeze(Object.fromEntries(Object.entries(DESIGN_TOKEN_FILES).map(([f, tree]) => [f, `${JSON.stringify(tree, null, 2)}\n`])));

const DESIGN_TOKEN_README = `# design tokens

\`tokens/\` holds our design tokens, in the W3C design tokens format. Build \`build/tokens.css\` and
\`build/errors.json\` from them by these rules. Leave \`tokens/\` as it is: \`build/errors.json\` is how we
hear of a mistake in it.

## Tokens

- An object with a \`$value\` is a token; any other object is a group. A name that starts with \`$\` is a
  field, never a group or a token. A token's path is the names of the groups it is in, outermost first,
  and its own name, joined by dots: \`color.gray.100\`.
- A token's type is its own \`$type\`, else that of the innermost group holding it, in the same file, that
  has a \`$type\`, else, for an alias, the type of the token its alias names.
- A \`$value\` that is exactly \`{<path>}\` is an alias of the token at that path, and so is a field of a
  shadow that is exactly \`{<path>}\`. An alias takes the value of the token it names, itself resolved.
- A color token's alpha is its \`$extensions.alpha\`. An alias without one takes the alpha of the token it
  names, and so does a shadow's \`color\` field that is an alias; a color with no alpha along its aliases
  has alpha 1.

## Sets

The files are layers: \`base.json\` at the bottom, then a theme (\`light.json\` or \`dark.json\`), then
\`brand-ocean.json\` on top. A token in a higher layer replaces the token at the same path in a lower layer
entirely: nothing of the lower token (its \`$value\`, \`$type\` or \`$extensions\`) is kept. Groups are not
replaced: a higher layer's group adds its tokens to the lower layer's. There are four sets:

- light: base, light;
- dark: base, dark;
- ocean: base, light, brand-ocean;
- ocean dark: base, dark, brand-ocean.

A set's aliases are resolved after its layers are merged: an alias names the token at its path in that
set.

## Broken tokens

A token is broken when, in any of the four sets:

- an alias it holds names a path that is not a token in that set;
- following aliases from it leads back to it: it is on a cycle; or
- an alias it holds names a broken token.

A broken token is left out of every block below, even in a set where it would resolve.
\`build/errors.json\` lists every broken token once, sorted by path in code-point order:
\`[{ "token": "<path>", "reason": "cycle" or "missing" }, ...]\`. The reason is \`cycle\` when the token is
on a cycle in any of the sets, and \`missing\` otherwise.

## Variables

Every token that is not broken is a CSS custom property, named \`--\` and its path with the parts joined
by \`-\`, each capital letter in a part written as \`-\` and the letter in lower case (\`fontSize\` is
\`font-size\`). Its value is written out in full, never as \`var()\` or an alias, by the token's type:

- \`color\`: given as \`#rgb\` or \`#rrggbb\`, written \`#rrggbb\` in lower case. At an alpha below 1 it is
  written \`rgba(<r>, <g>, <b>, <alpha>)\` instead, the channels from 0 to 255 in decimal:
  \`rgba(255, 0, 0, 0.3)\`.
- \`dimension\`: a length in \`px\` is written in \`rem\`, at 16px to the rem; a length in any other unit as
  given. A length whose number is 0, in any unit, is written \`0\`.
- \`shadow\`: an object with \`offsetX\`, \`offsetY\`, \`blur\` and \`spread\` (dimensions) and \`color\`,
  written \`<offsetX> <offsetY> <blur> <spread> <color>\`, each part written as its type says. A list of
  shadows is written as each of them, joined by \`, \`.
- \`fontFamily\`: a list of names, or one name, joined by \`, \`; a name with a space in it is in double
  quotes: \`"Segoe UI", sans-serif\`.
- \`cubicBezier\`: \`[x1, y1, x2, y2]\`, written \`cubic-bezier(x1, y1, x2, y2)\`.
- \`number\` and \`fontWeight\`: the number. \`duration\`: as given.

Every number written (a length in rem, an alpha, a number) has at most 4 decimals, rounded to the
nearest, a half away from zero. Trailing zeros after the point are dropped, and the point too when
nothing is left after it; a number between -1 and 1 keeps its 0 before the point (\`0.5\`, not \`.5\`).

## build/tokens.css

Four blocks, in this order, and nothing else. Each has one variable per line, \`  --name: value;\`,
sorted by name in code-point order (\`--size-10\` before \`--size-9\`).

1. \`:root\`: every variable of the light set.
2. \`[data-theme="dark"]\`: each variable of the dark set whose value differs from its value in \`:root\`, or
   that \`:root\` does not have.
3. \`[data-brand="ocean"]\`: each variable of the ocean set whose value differs from its value in \`:root\`,
   or that \`:root\` does not have.
4. \`[data-brand="ocean"][data-theme="dark"]\`: each variable of the ocean dark set whose value differs
   from the one an element with both attributes gets from the three blocks above: the value in
   \`[data-brand="ocean"]\` when that block has the variable, else the value in \`[data-theme="dark"]\`
   when that block has it, else the value in \`:root\`.

Values are compared as they are written.
`;

/** The path a value names when it is an alias, `{color.gray.100}`, else null. */
const tokenAlias = (v) => (typeof v === 'string' && /^\{[^{}]+\}$/.test(v) ? v.slice(1, -1) : null);

/** The paths a token's value names: the value itself, or each field of its shadows. */
const tokenAliases = (value) => (Array.isArray(value) ? value : [value])
  .flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : [v])).map(tokenAlias).filter(Boolean);

/** Each token of a token file as `[path, { value, type, alpha }]`, its type its own or its nearest group's. */
function tokenEntries(node, at = [], type = undefined) {
  const groupType = node.$type ?? type;
  return Object.entries(node).filter(([name, v]) => !name.startsWith('$') && v && typeof v === 'object' && !Array.isArray(v))
    .flatMap(([name, v]) => ('$value' in v
      ? [[[...at, name].join('.'), { value: v.$value, type: v.$type ?? groupType, alpha: v.$extensions?.alpha }]]
      : tokenEntries(v, [...at, name], groupType)));
}

/** The broken tokens of the sets, each with its reason: `cycle` when it is on a cycle in any set, else `missing`. */
function brokenTokens(sets) {
  const reasons = new Map();
  for (const set of sets) {
    for (const start of set.keys()) {
      const seen = new Set();
      const next = tokenAliases(set.get(start).value);
      while (next.length && !reasons.has(start)) {
        const p = next.pop();
        if (p === start) reasons.set(start, 'cycle');
        else if (set.has(p) && !seen.has(p)) {
          seen.add(p);
          next.push(...tokenAliases(set.get(p).value));
        }
      }
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const set of sets) {
      for (const [p, t] of set) {
        if (!reasons.has(p) && tokenAliases(t.value).some((q) => !set.has(q) || reasons.has(q))) {
          reasons.set(p, 'missing');
          grew = true;
        }
      }
    }
  }
  return reasons;
}

/** A token with its aliases followed: the value they end at, its type, and its alpha (its own first). */
function tokenResolved(set, p) {
  const t = set.get(p);
  const to = tokenAlias(t.value);
  if (!to) return t;
  const r = tokenResolved(set, to);
  return { value: r.value, type: t.type ?? r.type, alpha: t.alpha ?? r.alpha };
}

/** A number as the token README writes it: at most 4 decimals, a half away from zero, no trailing zeros. */
const tokenNumber = (x) => String((Math.sign(x) * Math.round(Math.abs(x) * 10000)) / 10000);

/** A resolved token's CSS value, by its type. */
function tokenCss(set, { value, type, alpha }) {
  const part = (v, as) => (tokenAlias(v) ? tokenCss(set, tokenResolved(set, tokenAlias(v))) : tokenCss(set, { value: v, type: as }));
  if (type === 'color') {
    const rgb = rgbOf(value);
    return alpha !== undefined && alpha < 1 ? `rgba(${rgb.join(', ')}, ${tokenNumber(alpha)})` : hexOf(rgb);
  }
  if (type === 'dimension') {
    const [, n, unit] = /^(-?[\d.]+)(\D*)$/.exec(value);
    return Number(n) === 0 ? '0' : unit === 'px' ? `${tokenNumber(Number(n) / 16)}rem` : value;
  }
  if (type === 'shadow') {
    return [value].flat().map((s) => [...['offsetX', 'offsetY', 'blur', 'spread'].map((k) => part(s[k], 'dimension')), part(s.color, 'color')].join(' ')).join(', ');
  }
  if (type === 'fontFamily') return [value].flat().map((name) => (/\s/.test(name) ? `"${name}"` : name)).join(', ');
  if (type === 'cubicBezier') return `cubic-bezier(${value.map(tokenNumber).join(', ')})`;
  if (type === 'number' || type === 'fontWeight') return tokenNumber(value);
  return String(value);
}

/** A token's CSS custom property: `--` and its path, hyphens between the parts and before each capital. */
const tokenVariable = (p) => `--${p.split('.').map((part) => part.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)).join('-')}`;

/** Code-point order, the token README's order for names and paths. */
const tokenOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The build the token README defines, from the token files' text: the four blocks, in order, and the errors. */
function buildTokens(texts) {
  const layer = (name) => tokenEntries(JSON.parse(texts[`tokens/${name}.json`]));
  const merged = (...names) => new Map(names.flatMap(layer));
  const sets = [merged('base', 'light'), merged('base', 'dark'), merged('base', 'light', 'brand-ocean'), merged('base', 'dark', 'brand-ocean')];
  const broken = brokenTokens(sets);
  const [light, dark, ocean, oceanDark] = sets.map((set) => new Map([...set.keys()].filter((p) => !broken.has(p))
    .map((p) => [tokenVariable(p), tokenCss(set, tokenResolved(set, p))])));
  const listed = (all, before) => new Map([...all].filter(([n, v]) => before(n) !== v).sort(([a], [b]) => tokenOrder(a, b)));
  const root = listed(light, () => undefined);
  const darkBlock = listed(dark, (n) => root.get(n));
  const oceanBlock = listed(ocean, (n) => root.get(n));
  const both = listed(oceanDark, (n) => oceanBlock.get(n) ?? darkBlock.get(n) ?? root.get(n));
  return Object.freeze({
    blocks: [[':root', root], ['[data-theme="dark"]', darkBlock], ['[data-brand="ocean"]', oceanBlock], ['[data-brand="ocean"][data-theme="dark"]', both]],
    errors: [...broken].sort(([a], [b]) => tokenOrder(a, b)).map(([token, reason]) => ({ token, reason })),
  });
}

const DESIGN_TOKEN_BUILD = buildTokens(DESIGN_TOKEN_TEXT);

/** A selector as the token checks compare it: no spaces or quotes, its attribute selectors in order. */
function tokenSelector(text) {
  const s = String(text).replace(/\s+/g, '').replace(/["']/g, '');
  const attrs = s.match(/\[[^\]]*\]/g) || [];
  return attrs.length && attrs.join('') === s ? [...attrs].sort().join('') : s;
}

/** A CSS file without its comments. */
const withoutCssComments = (css) => String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
/** A block: a selector (text since the last `;` or `}`, so an at-rule before it is left outside) and its body. */
const TOKEN_CSS_BLOCK = /([^{};]*)\{([^{}]*)\}/g;

/** The blocks of a CSS file, each its selector and its custom properties in order; comments dropped. */
const tokenBlocks = (css) => [...withoutCssComments(css).matchAll(TOKEN_CSS_BLOCK)].map((m) => ({
  selector: tokenSelector(m[1]),
  vars: m[2].split(';').map((d) => /^\s*(--[^:\s]+)\s*:\s*([\s\S]*?)\s*$/.exec(d)).filter(Boolean).map((d) => ({ name: d[1], value: d[2] })),
}));

/** A CSS value as the token checks compare it: spaces collapsed, `, ` between items, double quotes, hex in lower case. */
const tokenValue = (v) => String(v).trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\(\s*/g, '(').replace(/\s*\)/g, ')')
  .replace(/'/g, '"').replace(/#[0-9a-f]+/gi, (h) => h.toLowerCase());

/** A variable's name as the value checks look it up, letters and digits in lower case: a misspelt name fails only the name check. */
const tokenKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- Version 5: many interacting rules applied exactly, with boundaries and precedence a quick reading gets wrong ----

/** A handbook policy file: its sections, each a list of clauses keyed by ID. */
const handbookPolicy = (title, sections) => `# ${title}

In force from 1 January 2026. The amendments in handbook/amendments/ change it.

${sections.map(([heading, clauses]) => `## ${heading}\n\n${Object.entries(clauses).map(([id, text]) => `**${id}** ${text}`).join('\n\n')}`).join('\n\n')}
`;

/** A handbook amendment file: when it was issued, when it takes effect, where it applies, and what it changes. */
const handbookAmendment = (id, title, { issued, effective, appliesTo = 'all countries', changes, why }) => `# Amendment ${id}: ${title}

Issued: ${issued}
Effective: ${effective}
Applies to: ${appliesTo}

## Changes

${changes.map((c) => `- ${c}`).join('\n')}

## Why

${why}
`;

const HANDBOOK_POLICIES = Object.freeze({
  'handbook/travel.md': handbookPolicy('Travel policy', [
    ['1. Before you travel', {
      'TRV-1.1': "A business trip needs your manager's approval before anything is booked.",
      'TRV-1.2': "Book travel through the travel desk. A booking made elsewhere is reimbursed only when it cost less than the travel desk's offer for the same journey.",
      'TRV-1.3': "A trip to a country on the security watch list also needs the security team's approval.",
    }],
    ['2. Getting there', {
      'TRV-2.1': 'Flights are booked in economy class. Business class is allowed for a flight whose scheduled flight time is more than 8 hours.',
      'TRV-2.2': 'Trains are booked in second class. First class is allowed for a journey of more than 3 hours.',
      'TRV-2.3': 'A rental car is allowed when it costs less than taxis and public transport for the same trip. Book the smallest car that fits the people and the luggage.',
      'TRV-2.4': 'Driving your own car on business is reimbursed as EXP-5.1 says.',
    }],
    ['3. Staying there', {
      'TRV-3.1': 'Book a hotel within the nightly limit in EXP-3.1.',
      'TRV-3.2': 'If you stay with friends or family, no accommodation is paid, but you may claim a gift for your hosts of up to EUR 30 per stay.',
    }],
    ['4. Daily allowance', {
      'TRV-4.1': 'For each day of a business trip you receive the daily allowance set in EXP-2.1. The day a trip starts and the day it ends are travel days, and each earns half the daily allowance. A trip that starts and ends on the same day earns one half.',
    }],
    ['5. After the trip', {
      'TRV-5.1': 'Claim your travel costs and your daily allowance as EXP-4.2 says.',
    }],
  ]),
  'handbook/expenses.md': handbookPolicy('Expenses policy', [
    ['1. Claims', {
      'EXP-1.1': 'Expenses are claimed in euros, in the expenses tool. A cost paid in another currency is converted at the rate of the day it was paid.',
      'EXP-1.2': 'Every item over EUR 25 needs a receipt. An item without one is not reimbursed.',
      'EXP-1.3': 'Alcohol, fines and personal entertainment are never reimbursed.',
    }],
    ['2. Meals', {
      'EXP-2.1': 'The daily allowance for a business trip is EUR 48 a day. It covers meals and small costs, and needs no receipts.',
      'EXP-2.2': 'A meal with a client is reimbursed at cost, up to EUR 60 a person, with the names of everyone at the table.',
    }],
    ['3. Hotels', {
      'EXP-3.1': 'The company pays for a hotel room up to EUR 150 per night, breakfast included.',
      'EXP-3.2': 'Minibar, films and other hotel extras are yours to pay. Laundry is reimbursed on a trip of five nights or more.',
    }],
    ['4. Deadlines', {
      'EXP-4.1': 'Your manager approves or returns each claim within 10 working days after you submit it.',
      'EXP-4.2': 'Submit the claim for a business trip within 30 days after the day the trip ends. A claim submitted later is not paid.',
      'EXP-4.3': 'Any other expense is claimed by the end of the month after the month it was paid in.',
    }],
    ['5. Mileage', {
      'EXP-5.1': 'Driving your own car on business is reimbursed at EUR 0.30 per km. The journey between your home and your usual office does not count.',
      'EXP-5.2': 'Parking and tolls on a business journey are reimbursed at cost.',
    }],
    ['6. Local transport', {
      'EXP-6.1': 'A taxi is reimbursed up to EUR 35 per journey, when no public transport is reasonably available.',
      'EXP-6.2': 'Public transport tickets for business journeys are reimbursed at cost.',
    }],
  ]),
  'handbook/leave.md': handbookPolicy('Leave policy', [
    ['1. Annual leave', {
      'LEV-1.1': 'Staff have 25 working days of paid annual leave per calendar year, on top of public holidays.',
      'LEV-1.2': 'Staff who join or leave during a year have leave in proportion to the whole months they work that year, rounded up to a whole day.',
      'LEV-1.3': 'Leave of more than three working days in a row is booked in the HR tool at least two weeks ahead.',
    }],
    ['2. Carrying leave over', {
      'LEV-2.1': 'Up to 5 unused days of annual leave may be carried into the next year. They must be taken by 31 March of that year, or they are lost.',
    }],
    ['3. Illness', {
      'LEV-3.1': 'If you are ill, tell your manager before your working day starts.',
      'LEV-3.2': "A doctor's note is needed from the fourth working day of illness in a row.",
    }],
    ['4. Family', {
      'LEV-4.1': 'Parental leave follows the law of the country you are employed in. The company tops it up to full pay for the first 4 weeks.',
      'LEV-4.2': 'On the death of a close relative you have up to 5 working days of paid compassionate leave.',
    }],
    ['5. Unpaid leave', {
      'LEV-5.1': 'Up to 20 working days of unpaid leave a year may be agreed with your manager.',
    }],
  ]),
  'handbook/remote-work.md': handbookPolicy('Remote work policy', [
    ['1. Working from home', {
      'REM-1.1': 'You may work from home up to 2 days a week, on days agreed with your manager.',
      'REM-1.2': 'Working from home is not available in your first month with the company.',
      'REM-1.3': 'Your workplace at home must pass the safety checklist in the HR tool.',
    }],
    ['2. Working from another country', {
      'REM-2.1': "You may work from a country other than the one you are employed in for up to 20 working days per calendar year, with your manager's approval.",
      'REM-2.2': 'HR must approve working from another country at least 10 working days before you go, so that tax and social security can be checked.',
    }],
    ['3. Costs', {
      'REM-3.1': 'The company does not pay for home internet, energy or other running costs of working from home.',
      'REM-3.2': 'Equipment for working from home is covered by the equipment policy.',
    }],
  ]),
  'handbook/equipment.md': handbookPolicy('Equipment policy', [
    ['1. Computers', {
      'EQP-1.1': 'Each member of staff has a company laptop, replaced every 4 years, or sooner when it fails.',
      'EQP-1.2': 'Report a lost or stolen laptop or phone to IT within 24 hours.',
    }],
    ['2. Working from home', {
      'EQP-2.1': 'The company pays for one monitor for working from home, up to EUR 200.',
      'EQP-2.2': 'A keyboard, a mouse and a headset are provided on request.',
    }],
    ['3. Phones', {
      'EQP-3.1': 'Staff on an on-call rota have a company phone.',
      'EQP-3.2': 'Using your own phone for work is not reimbursed.',
    }],
    ['4. Bicycles', {
      'EQP-4.1': "You may lease a bicycle for your commute through the company's bike scheme, for a bicycle costing up to EUR 2,000. The lease is paid from your salary before tax where the law of your country allows it.",
    }],
  ]),
  'handbook/on-call.md': handbookPolicy('On-call policy', [
    ['1. Pay', {
      'ONC-1.1': 'Each week on call earns an on-call allowance of EUR 250.',
      'ONC-1.2': 'A call-out, being called to work while on call, is paid at EUR 45 an hour, counting at least one hour for each call-out.',
    }],
    ['2. After a call-out', {
      'ONC-2.1': 'After a call-out that ends after 23:00, your next working day starts no earlier than 11 hours after it ended.',
      'ONC-2.2': 'After a call-out that ends between 23:00 and 06:00, the company pays for a taxi home, whether or not public transport runs, up to twice the taxi limit in EXP-6.1.',
    }],
    ['3. The rota', {
      'ONC-3.1': 'Nobody is on call for more than one week in four.',
      'ONC-3.2': 'A week on call runs from Monday 09:00 to the next Monday 09:00.',
    }],
  ]),
  'handbook/training.md': handbookPolicy('Training policy', [
    ['1. Budget', {
      'TRN-1.1': 'Each member of staff has a training budget of EUR 1,200 per calendar year, for courses, certifications and conferences.',
      'TRN-1.2': 'Unused budget does not carry over into the next year.',
    }],
    ['2. Time and travel', {
      'TRN-2.1': 'Time on a course or at a conference counts as working time.',
      'TRN-2.2': 'Travel to a course or a conference follows the travel policy, and its costs do not come out of the training budget.',
    }],
    ['3. Repayment', {
      'TRN-3.1': 'If you leave within 12 months after a course that cost more than EUR 800, you repay half its cost.',
    }],
  ]),
});

/**
 * The amendments. Their numbers follow the order they were issued in, not their effective dates: A-2026-05
 * takes effect before A-2026-03, and A-2026-09 and A-2026-10 on the same day.
 */
const HANDBOOK_AMENDMENTS = Object.freeze({
  'handbook/amendments/A-2026-01.md': handbookAmendment('A-2026-01', 'taxi limit', {
    issued: '2026-01-12', effective: '2026-02-01',
    changes: ['Replaces **EXP-6.1** with: "A taxi is reimbursed up to EUR 40 per journey, when no public transport is reasonably available."'],
    why: 'Taxi fares rose in most of our cities at the start of the year.',
  }),
  'handbook/amendments/A-2026-02.md': handbookAmendment('A-2026-02', 'staff employed in France', {
    issued: '2026-02-03', effective: '2026-03-01', appliesTo: 'France only',
    changes: [
      'Replaces **ONC-1.1** with: "Each week on call earns an on-call allowance of EUR 270."',
      'Replaces **LEV-1.1** with: "Staff have 30 working days of paid annual leave per calendar year, on top of public holidays."',
    ],
    why: 'These bring the handbook in line with the company agreement for staff employed in France.',
  }),
  'handbook/amendments/A-2026-03.md': handbookAmendment('A-2026-03', 'on-call allowance from September', {
    issued: '2026-02-20', effective: '2026-09-01',
    changes: ['Replaces **ONC-1.1** with: "Each week on call earns an on-call allowance of EUR 300."'],
    why: "Agreed in this year's pay review.",
  }),
  'handbook/amendments/A-2026-04.md': handbookAmendment('A-2026-04', 'home-working trial', {
    issued: '2026-02-24', effective: '2026-03-01',
    changes: [
      'Replaces **REM-1.1** with: "You may work from home up to 3 days a week, on days agreed with your manager."',
      'Replaces **EQP-2.1** with: "The company pays for one monitor for working from home, up to EUR 250."',
    ],
    why: 'A six-month trial of more working from home.',
  }),
  'handbook/amendments/A-2026-05.md': handbookAmendment('A-2026-05', 'on-call allowance from June', {
    issued: '2026-04-28', effective: '2026-06-01',
    changes: ['Replaces **ONC-1.1** with: "Each week on call earns an on-call allowance of EUR 280."'],
    why: 'Part of the raise in A-2026-03 is brought forward, because fewer people volunteered for the rota this spring.',
  }),
  'handbook/amendments/A-2026-06.md': handbookAmendment('A-2026-06', 'hotels and the daily allowance', {
    issued: '2026-05-18', effective: '2026-07-01',
    changes: [
      'Replaces **EXP-3.1** with: "The company pays for a hotel room up to EUR 170 per night, breakfast included."',
      'Replaces **EXP-2.1** with: "The daily allowance for a business trip is EUR 52 a day. It covers meals and small costs, and needs no receipts."',
      'Adds **TRV-4.2**: "A day of a trip that is not a travel day, and on which breakfast, lunch and dinner are all provided free (by the company, a client or an event), earns no daily allowance."',
    ],
    why: 'Hotel prices and meal costs have risen. Until now, a day with every meal provided earned the full allowance.',
  }),
  'handbook/amendments/A-2026-07.md': handbookAmendment('A-2026-07', 'flights and mileage', {
    issued: '2026-06-22', effective: '2026-08-01',
    changes: [
      'Replaces **TRV-2.1** with: "Flights are booked in economy class. Business class is allowed for a flight whose scheduled flight time is more than 6 hours."',
      'Replaces **EXP-5.1** with: "Driving your own car on business is reimbursed at EUR 0.35 per km. The journey between your home and your usual office does not count."',
    ],
    why: 'Long flights are tiring, and fuel prices have risen.',
  }),
  'handbook/amendments/A-2026-08.md': handbookAmendment('A-2026-08', 'end of the home-working trial', {
    issued: '2026-07-30', effective: '2026-09-01',
    changes: ['Revokes **A-2026-04**, the home-working trial.'],
    why: "The trial has run its six months. Its review reports in the autumn; until then the handbook's own rules apply.",
  }),
  'handbook/amendments/A-2026-09.md': handbookAmendment('A-2026-09', 'working abroad and the claim deadline', {
    issued: '2026-08-17', effective: '2026-10-01',
    changes: [
      'Replaces **REM-2.1** with: "You may work from a country other than the one you are employed in for up to 30 working days per calendar year, with your manager\'s approval."',
      'Replaces **EXP-4.2** with: "Submit the claim for a business trip within 45 days after the day the trip ends. A claim submitted later is not paid."',
    ],
    why: 'Staff asked for more time abroad, and for more time to submit their claims.',
  }),
  'handbook/amendments/A-2026-10.md': handbookAmendment('A-2026-10', 'working abroad from Spain', {
    issued: '2026-08-17', effective: '2026-10-01', appliesTo: 'Spain only',
    changes: ['Replaces **REM-2.1** with: "You may work from a country other than Spain for up to 15 working days per calendar year, with your manager\'s approval."'],
    why: 'Tax rules for staff employed in Spain.',
  }),
});

const HANDBOOK_QUESTIONS = Object.freeze([
  { id: 'Q1', asked_by: 'Aoife', country: 'Ireland', date: '2026-06-30', answer_type: 'number', unit: 'EUR',
    question: 'I need a hotel in Galway for one night, 30 June 2026, for a customer visit. What is the most the company pays for the room?' },
  { id: 'Q2', asked_by: 'Julien', country: 'France', date: '2026-07-13', answer_type: 'number', unit: 'EUR',
    question: "I'm on call for the week that starts on Monday 13 July 2026. What on-call allowance does that week earn?" },
  { id: 'Q3', asked_by: 'Sanne', country: 'Netherlands', date: '2026-09-07', answer_type: 'number', unit: 'days a week',
    question: 'From Monday 7 September 2026, how many days a week may I work from home?' },
  { id: 'Q4', asked_by: 'Lukas', country: 'Germany', date: '2026-08-01', answer_type: 'boolean',
    question: "Today, Saturday 1 August 2026, I'm booking a flight to Toronto for a customer workshop. Its scheduled flight time is 7 hours 40 minutes. May I book business class?" },
  { id: 'Q5', asked_by: 'Ciaran', country: 'Ireland', date: '2026-09-15', answer_type: 'number', unit: 'EUR',
    question: 'I travel to a conference in Milan from Tuesday 15 September to Friday 18 September 2026. The conference provides breakfast, lunch and dinner on Thursday 17 September; on the other days I pay for my own meals. How much daily allowance does the trip earn in all?' },
  { id: 'Q6', asked_by: 'Lucia', country: 'Spain', date: '2026-10-12', answer_type: 'number', unit: 'working days',
    question: 'How many working days a year may I work from a country other than Spain?' },
  { id: 'Q7', asked_by: 'Jonas', country: 'Germany', date: '2026-10-05', answer_type: 'number', unit: 'EUR per km',
    question: "On 5 October 2026 I rode my own bicycle to a client's office and back, 24 km in all. What rate per km can I claim for it?" },
  { id: 'Q8', asked_by: 'Mia', country: 'Germany', date: '2026-09-14', answer_type: 'number', unit: 'EUR',
    question: "I'm on call for the week that starts on Monday 14 September 2026. What on-call allowance does that week earn?" },
  { id: 'Q9', asked_by: 'Pablo', country: 'Spain', date: '2026-08-31', answer_type: 'number', unit: 'EUR',
    question: "I'm buying a monitor for working from home today, 31 August 2026. Up to how much does the company pay for it?" },
  { id: 'Q10', asked_by: 'Niamh', country: 'Ireland', date: '2026-05-20', answer_type: 'number', unit: 'EUR',
    question: 'I was called out during my on-call week. The call-out ended at 01:30 on Wednesday 20 May 2026, and I took a taxi home. Up to how much does the company pay for the taxi?' },
  { id: 'Q11', asked_by: 'Daan', country: 'Netherlands', date: '2026-09-25', answer_type: 'date',
    question: 'My business trip to Lyon ended on Friday 25 September 2026. What is the last day I can submit the expense claim for it?' },
  { id: 'Q12', asked_by: 'Camille', country: 'France', date: '2026-11-16', answer_type: 'number', unit: 'working days',
    question: 'How many working days of paid annual leave do I have each calendar year?' },
].map((q) => Object.freeze(q)));

const HANDBOOK_README = `# handbook questions

Staff send us questions about the staff handbook. Answer each question in \`questions.json\` from the
handbook, and write \`answers.json\`.

## The handbook

- \`handbook/*.md\` are the policies, in force from 1 January 2026. Each clause starts with its ID in bold,
  such as **EXP-1.1**.
- \`handbook/amendments/\` holds the amendments, A-2026-01 to A-2026-10. Each gives the date it is
  \`Effective\` from, the countries it \`Applies to\` (all countries, or one country only), and its changes:
  it replaces a clause's text, adds a clause, or revokes an earlier amendment.
- Each question gives the \`country\` its asker is employed in and the \`date\` of the situation.

## Which text applies

A question is answered by the handbook as it stands on the question's \`date\`, for its \`country\`. That text
decides the whole answer, even when what the question asks about (a deadline, a later day of a trip) falls
after that date. For each clause:

1. An amendment is in force from its Effective date, that day included, in the countries it applies to.
   An amendment for one country never applies in another.
2. An amendment that another revokes stops being in force on the Effective date of the one that revokes it;
   up to the day before, it is in force as usual. From that date on, every clause it changed reads as if it
   had never been made.
3. When several amendments in force change the same clause, the one with the latest Effective date decides
   its text, whether it applies to all countries or to one. Only between amendments with the same Effective
   date does the one for the asker's country beat the one for all countries. When an amendment was issued,
   and its number, do not count.
4. A clause that no amendment in force changes reads as the handbook has it. A clause an amendment adds
   exists from that amendment's Effective date.

A clause that refers to another ("the limit in EXP-6.1") means that clause as it applies on the same date, in
the same country. "Within N days after" a day ends N days after it, whatever day of the week that is:
within 30 days after 10 March is by 9 April.

## answers.json

A JSON list with one object for each question, in the order of \`questions.json\`:

    [{ "id": "Q1", "answer": ..., "clauses": ["<clause ID>", "<amendment ID>", ...] }, ...]

- \`answer\`, by the question's \`answer_type\`: for \`number\`, a JSON number in the question's \`unit\`
  (\`1200\`, not \`"1200"\` or \`"EUR 1,200"\`); for \`boolean\`, \`true\` for yes and \`false\` for no; for
  \`date\`, a string \`YYYY-MM-DD\`.
- \`clauses\`: the IDs, as the handbook writes them, of the clauses the answer rests on (the clause that answers
  it, any clause that one refers to, and every clause a calculation uses), and of the amendments that decided
  their text on the question's date: the amendment whose text you applied, and, where a clause reads as it did
  before because an amendment was revoked, the amendment that revoked it. Cite no other amendment: not one
  that another amendment beat, not one not yet in force, not one for another country, not one revoked by then.
- A question that no clause answers gets \`"answer": "not covered"\` and \`"clauses": []\`, whatever its
  \`answer_type\`. A clause about something similar does not answer it: never answer by analogy, and never
  read the handbook's silence as a no.
`;

/** Every ID a citation can name: each clause (those amendments add among them) and each amendment. */
const HANDBOOK_IDS = Object.freeze(new Set([
  ...[...Object.values(HANDBOOK_POLICIES), ...Object.values(HANDBOOK_AMENDMENTS)].flatMap((text) => [...text.matchAll(/\*\*([A-Z]{3}-\d+\.\d+)\*\*/g)].map((m) => m[1])),
  ...Object.keys(HANDBOOK_AMENDMENTS).map((f) => path.basename(f, '.md')),
]));

/**
 * Each question's answer, the handbook clauses its citations must include, and the amendments they must
 * name, no more and no fewer. Its check is named for the rule the question turns on.
 */
const HANDBOOK_ANSWERS = Object.freeze({
  Q1: { answer: 150, cite: ['EXP-3.1'], by: [], name: 'Q1: EUR 150 by EXP-3.1 alone: 30 June is the day before A-2026-06 takes effect' },
  Q2: { answer: 280, cite: ['ONC-1.1'], by: ['A-2026-05'], name: "Q2: EUR 280 by A-2026-05: in France the later general amendment beats France's earlier A-2026-02" },
  Q3: { answer: 2, cite: ['REM-1.1'], by: ['A-2026-08'], name: 'Q3: 2 days a week by REM-1.1 and A-2026-08: the revoked trial no longer applies' },
  Q4: { answer: true, cite: ['TRV-2.1'], by: ['A-2026-07'], name: 'Q4: business class, yes, by A-2026-07: it takes effect on 1 August, the day of the booking' },
  Q5: { answer: 104, cite: ['TRV-4.1', 'TRV-4.2', 'EXP-2.1'], by: ['A-2026-06'], name: 'Q5: EUR 104 by TRV-4.1, TRV-4.2 and EXP-2.1 as A-2026-06 sets them: travel days earn half, the day of free meals nothing' },
  Q6: { answer: 15, cite: ['REM-2.1'], by: ['A-2026-10'], name: "Q6: 15 days by A-2026-10: on the same Effective date, Spain's own amendment beats the general A-2026-09" },
  Q7: { answer: 'not covered', cite: [], by: [], name: 'Q7: not covered, citing nothing: EXP-5.1 pays for a car, not a bicycle' },
  Q8: { answer: 300, cite: ['ONC-1.1'], by: ['A-2026-03'], name: 'Q8: EUR 300 by A-2026-03: the latest Effective date wins, not the amendment issued last' },
  Q9: { answer: 250, cite: ['EQP-2.1'], by: ['A-2026-04'], name: 'Q9: EUR 250 by A-2026-04: on 31 August its revocation is not yet in force' },
  Q10: { answer: 80, cite: ['ONC-2.2', 'EXP-6.1'], by: ['A-2026-01'], name: 'Q10: EUR 80 by ONC-2.2 and EXP-6.1 as A-2026-01 sets it: twice the taxi limit' },
  Q11: { answer: '2026-10-25', cite: ['EXP-4.2'], by: [], name: "Q11: 2026-10-25, a Sunday, by EXP-4.2 alone: 30 days, as on 25 September; A-2026-09's 45 days start later" },
  Q12: { answer: 30, cite: ['LEV-1.1'], by: ['A-2026-02'], name: 'Q12: 30 days by A-2026-02: in France nothing later changes LEV-1.1' },
});

// ---- Version 5, devops-alert-incidents: an alert stream turned into incidents by many exact rules ----

/** The alert task's services, each with its alerts: a fingerprint is `<service>.<alert>`. */
const ALERT_FINGERPRINTS = Object.freeze({
  checkout: ['http-5xx', 'latency-p99'],
  payments: ['provider-timeouts', 'queue-depth'],
  search: ['index-lag', 'latency-p99'],
  db: ['replication-lag', 'disk-usage', 'connections'],
  auth: ['login-failures', 'token-errors'],
  queue: ['consumer-lag', 'dead-letters'],
});

/**
 * The maintenance windows, in local time. Europe's clocks go back on Sunday 25 October 2026, at 03:00
 * summer time (01:00 UTC), so 02:00 to 03:00 in Berlin happens twice that night; New York's go back
 * only on 1 November.
 */
const ALERT_WINDOWS = Object.freeze([
  { id: 'mw-1', reason: 'search index rebuild', zone: 'Europe/Berlin', start: '2026-10-23T22:00', end: '2026-10-23T23:30', services: ['search'] },
  { id: 'mw-2', reason: 'queue broker upgrade', zone: 'Europe/Berlin', start: '2026-10-25T00:30', end: '2026-10-25T04:00', services: ['queue'] },
  { id: 'mw-3', reason: 'database failover drill', zone: 'Europe/Berlin', start: '2026-10-25T01:00', end: '2026-10-25T02:40', services: ['db'] },
  { id: 'mw-4', reason: 'identity provider certificate rotation', zone: 'America/New_York', start: '2026-10-26T06:00', end: '2026-10-26T07:00', services: ['auth'] },
  { id: 'mw-5', reason: 'database vacuum', zone: 'Europe/Berlin', start: '2026-10-26T03:00', end: '2026-10-26T04:30', services: ['db'] },
  { id: 'mw-6', reason: 'payment provider migration', zone: 'UTC', start: '2026-10-26T08:00', end: '2026-10-26T09:30', services: ['checkout', 'payments'] },
]);

/** A run of an alert's events, every `step` seconds from `from` to `to` (both ISO, UTC), all firing. */
function alertRun(from, to, step, severity) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += step * 1000) out.push([new Date(t).toISOString().replace('.000Z', 'Z'), 'firing', severity]);
  return out;
}

/**
 * The scenes of the alert task, written out by hand: each puts one rule at its boundary. A scene is a
 * fingerprint and its events, `[ts, status, severity, seconds late]`; a late event comes later in the
 * file than its ts. The random incidents of the generator keep an hour away from each scene.
 */
const ALERT_SCENES = Object.freeze([
  // A resolve with no incident before it: the alert was firing before the data begins.
  ['db.connections', [['2026-10-23T00:01:30Z', 'resolved', 'warning']]],
  // A firing exactly 10 minutes after the previous one joins; one 10 minutes 1 second after starts a new incident.
  ['payments.provider-timeouts', [
    ['2026-10-23T09:00:00Z', 'firing', 'warning'], ['2026-10-23T09:04:00Z', 'firing', 'warning'], ['2026-10-23T09:14:00Z', 'firing', 'warning'],
    ['2026-10-23T09:24:01Z', 'firing', 'warning'], ['2026-10-23T09:27:00Z', 'firing', 'warning'], ['2026-10-23T09:31:00Z', 'resolved', 'warning'],
  ]],
  // Inside mw-1, 22:00 to 23:30 summer time in Berlin: 20:00 to 21:30 UTC.
  ['search.latency-p99', [...alertRun('2026-10-23T20:50:00Z', '2026-10-23T21:05:00Z', 300, 'warning'), ['2026-10-23T21:08:00Z', 'resolved', 'warning']]],
  // A resolve, then a second one: the first ends the incident, and the firing 10:30 after it is a new one.
  ['auth.login-failures', [
    ['2026-10-24T05:00:00Z', 'firing', 'warning'], ['2026-10-24T05:04:00Z', 'firing', 'warning'], ['2026-10-24T05:06:00Z', 'resolved', 'warning'],
    ['2026-10-24T05:07:10Z', 'resolved', 'warning'], ['2026-10-24T05:16:30Z', 'firing', 'warning'], ['2026-10-24T05:20:00Z', 'firing', 'warning'],
    ['2026-10-24T05:23:00Z', 'resolved', 'warning'],
  ]],
  // Three flaps, the first and the third exactly 10 minutes after their resolve (the first 12 minutes after
  // the previous firing); then a firing 10:01 after the resolve starts a new incident.
  ['checkout.latency-p99', [
    ['2026-10-24T13:00:00Z', 'firing', 'warning'], ['2026-10-24T13:03:00Z', 'firing', 'warning'], ['2026-10-24T13:05:00Z', 'resolved', 'warning'],
    ['2026-10-24T13:15:00Z', 'firing', 'warning'], ['2026-10-24T13:18:00Z', 'firing', 'critical'], ['2026-10-24T13:20:00Z', 'resolved', 'critical'],
    ['2026-10-24T13:26:00Z', 'firing', 'critical'], ['2026-10-24T13:29:00Z', 'resolved', 'critical'], ['2026-10-24T13:39:00Z', 'firing', 'critical'],
    ['2026-10-24T13:42:00Z', 'firing', 'warning'], ['2026-10-24T13:45:00Z', 'resolved', 'warning'], ['2026-10-24T13:55:01Z', 'firing', 'warning'],
    ['2026-10-24T13:58:00Z', 'firing', 'warning'], ['2026-10-24T14:01:00Z', 'resolved', 'warning'],
  ]],
  // mw-3, 01:00 summer time to the first 02:40 of the night: 23:00 to 00:40 UTC.
  ['db.replication-lag', [
    ...alertRun('2026-10-24T22:40:00Z', '2026-10-24T22:56:00Z', 240, 'warning'), ['2026-10-24T22:58:00Z', 'resolved', 'warning'],
    ...alertRun('2026-10-24T23:00:00Z', '2026-10-25T00:36:00Z', 240, 'critical'),
    ...alertRun('2026-10-25T00:45:00Z', '2026-10-25T01:37:00Z', 240, 'critical'), ['2026-10-25T01:41:00Z', 'resolved', 'critical'],
  ]],
  // mw-2, 00:30 summer time to 04:00 winter time: 22:30 to 03:00 UTC.
  ['queue.consumer-lag', [
    ...alertRun('2026-10-24T22:00:00Z', '2026-10-24T22:15:00Z', 300, 'warning'), ['2026-10-24T22:20:00Z', 'resolved', 'warning'],
    ...alertRun('2026-10-24T22:40:00Z', '2026-10-24T23:20:00Z', 300, 'warning'), ['2026-10-24T23:25:00Z', 'resolved', 'warning'],
    ...alertRun('2026-10-25T02:10:00Z', '2026-10-25T02:45:00Z', 300, 'critical'), ['2026-10-25T02:50:00Z', 'resolved', 'critical'],
    ...alertRun('2026-10-25T03:00:00Z', '2026-10-25T03:10:00Z', 300, 'warning'), ['2026-10-25T03:14:00Z', 'resolved', 'warning'],
  ]],
  // The longest incident: four and a half hours, with two flaps (not flapping), critical from 07:00.
  ['db.disk-usage', [
    ...alertRun('2026-10-25T05:00:00Z', '2026-10-25T09:25:00Z', 300, 'warning').map(([ts, s, sev]) => [ts, s, ts >= '2026-10-25T07:00:00Z' ? 'critical' : sev])
      .flatMap((e) => (e[0] === '2026-10-25T06:00:00Z' ? [e, ['2026-10-25T06:02:00Z', 'resolved', 'warning']]
        : e[0] === '2026-10-25T08:00:00Z' ? [e, ['2026-10-25T08:02:00Z', 'resolved', 'critical']] : [e])),
    ['2026-10-25T09:30:00Z', 'resolved', 'critical'],
  ]],
  // Late arrivals: the 16:06 firing comes after the 16:08 resolve in the file, the 17:00 one after 17:04.
  ['payments.queue-depth', [
    ['2026-10-25T16:00:00Z', 'firing', 'warning'], ['2026-10-25T16:03:00Z', 'firing', 'warning'], ['2026-10-25T16:06:00Z', 'firing', 'warning', 160],
    ['2026-10-25T16:08:00Z', 'resolved', 'warning', 5], ['2026-10-25T17:00:00Z', 'firing', 'warning', 270], ['2026-10-25T17:02:00Z', 'firing', 'warning'],
    ['2026-10-25T17:04:00Z', 'firing', 'warning'], ['2026-10-25T17:07:00Z', 'firing', 'critical'], ['2026-10-25T17:10:00Z', 'resolved', 'critical'],
  ]],
  // mw-5, 03:00 to 04:30 winter time in Berlin: 02:00 to 03:30 UTC.
  ['db.connections', [
    ...alertRun('2026-10-26T01:20:00Z', '2026-10-26T01:30:00Z', 300, 'warning'), ['2026-10-26T01:33:00Z', 'resolved', 'warning'],
    ...alertRun('2026-10-26T02:40:00Z', '2026-10-26T03:20:00Z', 300, 'critical'), ['2026-10-26T03:24:00Z', 'resolved', 'critical'],
  ]],
  // mw-6, in UTC: what it holds neither extends nor escalates the incident before it; 09:30:00 is outside it.
  ['checkout.http-5xx', [
    ...alertRun('2026-10-26T07:50:00Z', '2026-10-26T07:58:00Z', 240, 'warning'),
    ...alertRun('2026-10-26T08:00:00Z', '2026-10-26T09:28:00Z', 240, 'critical'),
    ...alertRun('2026-10-26T09:30:00Z', '2026-10-26T09:34:00Z', 240, 'warning'), ['2026-10-26T09:38:00Z', 'resolved', 'warning'],
  ]],
  // mw-4, 06:00 to 07:00 daylight time in New York: 10:00 to 11:00 UTC.
  ['auth.login-failures', [
    ...alertRun('2026-10-26T10:15:00Z', '2026-10-26T10:45:00Z', 300, 'warning'), ['2026-10-26T10:50:00Z', 'resolved', 'warning'],
    ...alertRun('2026-10-26T11:20:00Z', '2026-10-26T11:30:00Z', 300, 'warning'), ['2026-10-26T11:35:00Z', 'resolved', 'warning'],
  ]],
  // Open at the end: three firings, then silence with no resolve.
  ['auth.token-errors', alertRun('2026-10-26T14:02:00Z', '2026-10-26T14:10:00Z', 240, 'warning')],
  // Open at the end, and longer than any incident that ended: firing every 5 minutes from 16:00 on.
  ['search.index-lag', alertRun('2026-10-26T16:00:00Z', '2026-10-26T23:55:00Z', 300, 'warning').map(([ts, s, sev]) => [ts, s, ts >= '2026-10-26T20:00:00Z' ? 'critical' : sev])],
  // Open at the end, after a flap.
  ['checkout.latency-p99', [
    ['2026-10-26T23:30:00Z', 'firing', 'warning'], ['2026-10-26T23:34:00Z', 'firing', 'warning'], ['2026-10-26T23:37:00Z', 'resolved', 'warning'],
    ...alertRun('2026-10-26T23:41:00Z', '2026-10-26T23:57:00Z', 240, 'warning'),
  ]],
  // Resolved 90 seconds before the last event of the data: it ended, it is not open.
  ['queue.dead-letters', [...alertRun('2026-10-26T23:40:00Z', '2026-10-26T23:52:00Z', 240, 'warning'), ['2026-10-26T23:55:30Z', 'resolved', 'warning']]],
]);

/**
 * The alert task's stream: the scenes, and random incidents of every fingerprint from Friday 23 to
 * Monday 26 October 2026 around them. A random incident fires every one to six minutes, escalates to
 * critical in some, flaps up to four times in some, goes quiet without a resolve in a few (never its
 * fingerprint's last), and some resolves come twice. One event in 25 arrives up to four minutes late,
 * and the file is in order of arrival. About 3,000 lines. Deterministic.
 */
function alertStream() {
  const rand = seededRandom(20261025);
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const sec = (iso) => Date.parse(iso) / 1000;
  const events = [];
  const push = (s, fingerprint, status, severity, late) => events.push({ s, late, fingerprint, service: fingerprint.split('.')[0], severity, status });
  const reserved = {};
  for (const [fingerprint, rows] of ALERT_SCENES) {
    for (const [ts, status, severity, late = 0] of rows) push(sec(ts), fingerprint, status, severity, late);
    // A scene that ends firing is open at the end: nothing of its fingerprint may follow it.
    (reserved[fingerprint] ||= []).push([sec(rows[0][0]) - 3600, rows.at(-1)[1] === 'firing' ? Infinity : sec(rows.at(-1)[0]) + 3600]);
  }
  const first = sec('2026-10-23T00:00:00Z');
  const last = sec('2026-10-26T20:00:00Z');
  for (const [service, alerts] of Object.entries(ALERT_FINGERPRINTS)) {
    for (const alert of alerts) {
      const fingerprint = `${service}.${alert}`;
      const plans = [];
      let t = first + between(600, 4 * 3600);
      while (t < last) {
        const length = between(180, 80 * 60);
        const clash = (reserved[fingerprint] || []).find(([a, b]) => t < b && t + length + 300 > a);
        if (clash) {
          t = clash[1] + between(0, 3600);
          continue;
        }
        if (t + length + 300 > last) break;
        plans.push([t, length]);
        t += length + between(60 * 60, 10 * 3600);
      }
      plans.forEach(([start, length], i) => {
        const late = () => (rand() < 0.04 ? between(10, 240) : 0);
        let severity = rand() < 0.1 ? 'critical' : 'warning';
        const escalate = rand() < 0.3 ? start + Math.floor(length * (0.2 + rand() * 0.5)) : Infinity;
        const firings = [];
        for (let s = start; s <= start + length; s += between(60, 360)) firings.push(s);
        const roll = rand();
        const flaps = Math.min(firings.length - 1, roll < 0.74 ? 0 : roll < 0.86 ? 1 : roll < 0.94 ? 2 : between(3, 4));
        const flapAfter = new Set();
        while (flapAfter.size < flaps) flapAfter.add(Math.floor(rand() * (firings.length - 1)));
        firings.forEach((s, k) => {
          if (s >= escalate) severity = 'critical';
          push(s, fingerprint, 'firing', severity, late());
          if (flapAfter.has(k)) push(between(s + 10, firings[k + 1] - 10), fingerprint, 'resolved', severity, late());
        });
        if (i < plans.length - 1 && rand() < 0.12) return;
        const resolved = firings.at(-1) + between(20, 150);
        push(resolved, fingerprint, 'resolved', severity, late());
        if (rand() < 0.08) push(resolved + between(15, 90), fingerprint, 'resolved', severity, 0);
      });
    }
  }
  const arrival = (e) => e.s + e.late;
  events.sort((a, b) => arrival(a) - arrival(b) || a.s - b.s || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
  const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
  return `${events.map((e) => JSON.stringify({ ts: iso(e.s), fingerprint: e.fingerprint, service: e.service, severity: e.severity, status: e.status })).join('\n')}\n`;
}

/** The UTC offset, in milliseconds, that `zone` has at the instant `ms`, from Intl's time zone data. */
function zoneOffset(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local `YYYY-MM-DDTHH:MM` names in `zone`; a local time that happens twice is its first occurrence. */
function zonedInstant(local, zone) {
  const naive = Date.parse(`${local}:00Z`);
  const offsets = new Set([zoneOffset(naive - 86400000, zone), zoneOffset(naive + 86400000, zone)]);
  return Math.min(...[...offsets].map((o) => naive - o).filter((t) => zoneOffset(t, zone) === naive - t));
}

/** The alert task's answers, from the stream and the windows themselves: what a correct reading of README.md gives. */
function alertIncidents(text, windows) {
  const events = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).map((e) => ({ ...e, at: Date.parse(e.ts) }));
  events.sort((a, b) => a.at - b.at);
  const spans = windows.map((w) => ({ services: w.services, from: zonedInstant(w.start, w.zone), to: zonedInstant(w.end, w.zone) }));
  const held = (e) => spans.some((w) => w.services.includes(e.service) && e.at >= w.from && e.at < w.to);
  const kept = events.filter((e) => !held(e));
  const byFingerprint = new Map();
  for (const e of kept) byFingerprint.set(e.fingerprint, [...(byFingerprint.get(e.fingerprint) || []), e]);
  const LIMIT = 600000;
  const incidents = [];
  for (const [fingerprint, list] of byFingerprint) {
    let cur = null;
    let n = 0;
    const close = (end) => incidents.push({ ...cur, end });
    for (const e of list) {
      if (e.status === 'firing') {
        if (cur?.state === 'firing' && e.at - cur.lastFiring <= LIMIT) {
          // joins
        } else if (cur?.state === 'resolving' && e.at - cur.resolvedAt <= LIMIT) {
          cur.flaps += 1;
          cur.state = 'firing';
        } else {
          if (cur) close(cur.state === 'resolving' ? cur.resolvedAt : cur.lastFiring);
          n += 1;
          cur = { id: `${fingerprint}#${n}`, fingerprint, service: e.service, start: e.at, flaps: 0, severity: 'warning', state: 'firing' };
        }
        cur.lastFiring = e.at;
        if (e.severity === 'critical') cur.severity = 'critical';
      } else if (cur?.state === 'firing') {
        cur.state = 'resolving';
        cur.resolvedAt = e.at;
      }
    }
    if (cur) close(cur.state === 'resolving' ? cur.resolvedAt : null);
  }
  incidents.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const count = (key) => incidents.reduce((acc, i) => ({ ...acc, [i[key]]: (acc[i[key]] || 0) + 1 }), {});
  const ended = incidents.filter((i) => i.end !== null);
  const longest = ended.reduce((best, i) => (!best || i.end - i.start > best.end - best.start ? i : best), null);
  return {
    total: incidents.length,
    by_service: count('service'),
    by_severity: { critical: 0, warning: 0, ...count('severity') },
    open: incidents.filter((i) => i.end === null).map((i) => i.id),
    flapping: incidents.filter((i) => i.flaps >= 3).map((i) => i.id),
    suppressed: events.length - kept.length,
    longest: { id: longest.id, fingerprint: longest.fingerprint, start: longest.start, end: longest.end, minutes: (longest.end - longest.start) / 60000 },
    incidents: incidents.map(({ id, fingerprint, service, severity, start, end, flaps }) => ({ id, fingerprint, service, severity, start, end, flaps })),
  };
}

const ALERTS_JSONL = alertStream();
const ALERT_ANSWERS = Object.freeze(alertIncidents(ALERTS_JSONL, ALERT_WINDOWS));

const ALERT_README = `# alert incidents

\`alerts.jsonl\` is our alert stream from Friday 23 to Monday 26 October 2026, one JSON event per line:

    {"ts":"2026-10-24T13:00:00Z","fingerprint":"checkout.latency-p99","service":"checkout","severity":"warning","status":"firing"}

- \`ts\` is when the alert was evaluated, in UTC. The file is in the order the events arrived, which is not
  always the order of their \`ts\`. No two events of one fingerprint have the same \`ts\`.
- \`fingerprint\` names one alert of one service, and \`service\` is that service.
- \`severity\` is \`warning\` or \`critical\`, and \`critical\` is the higher. \`status\` is \`firing\` or \`resolved\`.

\`maintenance.json\` holds our maintenance windows: \`{ "windows": [{ "id", "reason", "zone", "start", "end",
"services" }, ...] }\`. \`start\` and \`end\` are local times, \`YYYY-MM-DDTHH:MM\`, in \`zone\`, an IANA time zone.

## The rules

1. **Order.** Take the events in order of \`ts\`, never in the order of the file.
2. **Maintenance.** An event is suppressed when its \`service\` is one of a window's \`services\` and its
   \`ts\` is at or after the window's start and before its end. A window's local times become UTC with the
   offset their zone has at that date and time, by the IANA time zone database. A local time that happens
   twice, in the hour the clocks go back, is its first occurrence: the earlier instant. A suppressed event
   is counted, and is otherwise ignored: it starts, joins, resolves and flaps nothing.
3. **Incidents.** Each fingerprint's events that are not suppressed, in order of \`ts\`, make its
   incidents. A fingerprint has at most one current incident, which is either firing or resolving.
   - A \`firing\` event, when the fingerprint has no current incident, starts one, firing.
   - A \`firing\` event, when the current incident is firing, joins it if it comes at most 10 minutes
     (600 seconds) after the incident's previous firing event. If it comes later, the current incident
     ended at that previous firing event, and this event starts a new incident, firing.
   - A \`resolved\` event, when the current incident is firing, makes it resolving.
   - A \`firing\` event, when the current incident is resolving, is a flap if it comes at most 10 minutes
     after the resolved event that made it resolving: the incident counts one more flap and is firing
     again. If it comes later, the incident ended at that resolved event, and this event starts a new
     incident, firing.
   - Any other \`resolved\` event (the fingerprint has no current incident, or it is already resolving)
     changes nothing.
   - After the last event, a resolving incident ended at its resolved event, and a firing incident is
     open.
4. An incident starts at its first firing event. Its severity is the highest of its firing events'. An
   incident with 3 or more flaps is flapping.

## incidents.json

    {
      "total": 0,
      "by_service": { "<service>": 0 },
      "by_severity": { "critical": 0, "warning": 0 },
      "open": ["<id>"],
      "flapping": ["<id>"],
      "suppressed": 0,
      "longest": { "id": "<id>", "fingerprint": "...", "start": "...", "end": "...", "minutes": 0 },
      "incidents": [{ "id": "<id>", "fingerprint": "...", "service": "...", "severity": "...", "start": "...", "end": "...", "flaps": 0 }]
    }

- An incident's \`id\` is its fingerprint, \`#\`, and its number among its fingerprint's incidents in order of
  start, counting from 1: \`checkout.latency-p99#1\`, \`checkout.latency-p99#2\`.
- \`start\` and \`end\` are UTC times written as \`ts\` is. An open incident's \`end\` is \`null\`.
- \`total\` counts the incidents. \`by_service\` counts them for each service that has any, and \`by_severity\`
  by severity, with both keys.
- \`open\` and \`flapping\` are the ids of the open incidents and of the flapping ones.
- \`suppressed\` is the number of suppressed events, firing and resolved.
- \`longest\` is the incident that ended with the most time from its start to its end (an open incident is
  not counted), and \`minutes\` that time in minutes, rounded to two decimals. Of incidents as long, it is
  the one that started first.
- \`incidents\` is every incident. Each list of incidents (\`open\`, \`flapping\` and \`incidents\`) is in order
  of start, and incidents that start at the same time in order of id, compared as text.
`;

// ---- Version 5: many interacting rules over data too large to check by eye, each wrong path failing a check that names it ----

/** The trip task's airports: city, country and IANA time zone. */
const TRIP_AIRPORTS = Object.freeze({
  SFO: Object.freeze({ city: 'San Francisco', country: 'US', zone: 'America/Los_Angeles' }),
  LAX: Object.freeze({ city: 'Los Angeles', country: 'US', zone: 'America/Los_Angeles' }),
  HND: Object.freeze({ city: 'Tokyo', country: 'JP', zone: 'Asia/Tokyo' }),
  NRT: Object.freeze({ city: 'Tokyo', country: 'JP', zone: 'Asia/Tokyo' }),
  TPE: Object.freeze({ city: 'Taipei', country: 'TW', zone: 'Asia/Taipei' }),
  SIN: Object.freeze({ city: 'Singapore', country: 'SG', zone: 'Asia/Singapore' }),
});

/** The fictional airlines, by the first two letters of a flight. */
const TRIP_AIRLINES = Object.freeze({ HB: 'Harbor Air', KT: 'Kitsune Airways', MR: 'Merlion Air', FS: 'Formosa Sky' });

/**
 * The trip task's timetable: flight, from, to, local departure date and time, local arrival time (a day
 * count after it when the arrival is on another date), fare in USD. US daylight saving ends on Sunday
 * 7 November 2027. Among the flights: a cheaper outbound whose journey is 24 h 15 min, under 24 hours
 * only if San Francisco is read as UTC-8 before the change; a cheaper return of 24 h 25 min, under only
 * if it is read as UTC-7 after it; an outbound that lands after the Tokyo meeting has begun, and a
 * return that lands after the deadline, both only by their +1; a return that lands home the day before
 * it leaves Tokyo; red-eyes from Tokyo; a 75-minute international connection; an HND arrival two hours
 * before an NRT departure; a return with two connections; flights that land too close to a meeting or
 * leave too soon after one; and fares that tie.
 */
const TRIP_TIMETABLE = Object.freeze([
  ['HB1102', 'SFO', 'LAX', '2027-11-05', '13:00', '14:25', 99], ['HB0001', 'SFO', 'NRT', '2027-11-05', '13:40', '16:55+1', 812],
  ['KT0011', 'SFO', 'HND', '2027-11-05', '15:10', '18:15+1', 958], ['HB1104', 'SFO', 'LAX', '2027-11-05', '15:30', '16:55', 149],
  ['HB0003', 'SFO', 'NRT', '2027-11-05', '16:30', '19:45+1', 1184], ['HB1110', 'SFO', 'LAX', '2027-11-05', '18:05', '19:30', 89],
  ['HB0011', 'LAX', 'NRT', '2027-11-05', '22:30', '02:20+2', 748], ['KT0001', 'SFO', 'HND', '2027-11-05', '22:45', '01:50+2', 1046],
  ['HB1101', 'SFO', 'LAX', '2027-11-06', '06:30', '07:55', 139], ['HB0015', 'LAX', 'HND', '2027-11-06', '06:40', '10:20+1', 468],
  ['HB1103', 'SFO', 'LAX', '2027-11-06', '08:50', '10:15', 119], ['HB0021', 'LAX', 'HND', '2027-11-06', '11:15', '14:55+1', 493],
  ['HB0005', 'SFO', 'NRT', '2027-11-06', '11:30', '14:45+1', 688], ['HB1105', 'SFO', 'LAX', '2027-11-06', '12:10', '13:35', 149],
  ['KT0003', 'SFO', 'HND', '2027-11-06', '13:15', '16:20+1', 734], ['HB0023', 'LAX', 'NRT', '2027-11-06', '13:30', '17:20+1', 586],
  ['KT0013', 'SFO', 'HND', '2027-11-06', '17:20', '20:25+1', 812], ['HB1107', 'SFO', 'LAX', '2027-11-06', '18:00', '19:25', 129],
  ['HB0025', 'LAX', 'NRT', '2027-11-06', '23:55', '03:45+2', 655], ['HB1109', 'SFO', 'LAX', '2027-11-07', '07:15', '08:40', 109],
  ['HB0027', 'LAX', 'HND', '2027-11-07', '10:20', '15:00+1', 541], ['HB0009', 'SFO', 'NRT', '2027-11-07', '11:00', '15:15+1', 776],
  ['HB1111', 'SFO', 'LAX', '2027-11-07', '12:00', '13:25', 119], ['HB0029', 'LAX', 'NRT', '2027-11-07', '13:45', '18:35+1', 612],
  ['KT0007', 'SFO', 'HND', '2027-11-07', '16:55', '21:00+1', 902], ['KT0005', 'SFO', 'HND', '2027-11-07', '18:30', '22:35+1', 529],
  ['HB1108', 'SFO', 'LAX', '2027-11-08', '06:15', '07:40', 99], ['HB0007', 'SFO', 'NRT', '2027-11-08', '10:40', '14:55+1', 498],
  ['KT0009', 'SFO', 'HND', '2027-11-08', '12:20', '16:25+1', 571], ['MR0631', 'NRT', 'SIN', '2027-11-09', '18:45', '01:10+1', 189],
  ['KT0257', 'HND', 'SIN', '2027-11-09', '19:20', '01:40+1', 205], ['MR0639', 'NRT', 'SIN', '2027-11-09', '20:30', '02:55+1', 331],
  ['FS0101', 'NRT', 'TPE', '2027-11-09', '21:15', '00:10+1', 97], ['KT0259', 'HND', 'SIN', '2027-11-09', '22:30', '04:50+1', 318],
  ['KT0261', 'HND', 'SIN', '2027-11-10', '00:05', '06:25', 177], ['KT0251', 'HND', 'SIN', '2027-11-10', '01:30', '07:50', 168],
  ['KT0253', 'HND', 'SIN', '2027-11-10', '06:00', '12:20', 246], ['FS0105', 'TPE', 'SIN', '2027-11-10', '07:30', '12:05', 149],
  ['FS0103', 'HND', 'TPE', '2027-11-10', '08:00', '10:55', 131], ['FS0111', 'NRT', 'TPE', '2027-11-10', '09:30', '12:25', 118],
  ['KT0255', 'HND', 'SIN', '2027-11-10', '10:15', '16:35', 287], ['MR0633', 'NRT', 'SIN', '2027-11-10', '11:00', '17:25', 263],
  ['FS0107', 'TPE', 'SIN', '2027-11-10', '12:40', '17:15', 158], ['KT0263', 'HND', 'SIN', '2027-11-10', '13:40', '20:00', 274],
  ['MR0637', 'NRT', 'SIN', '2027-11-10', '14:05', '20:30', 252], ['FS0109', 'TPE', 'SIN', '2027-11-10', '16:50', '21:25', 139],
  ['MR0635', 'NRT', 'SIN', '2027-11-10', '17:10', '23:30', 214], ['MR0641', 'NRT', 'SIN', '2027-11-11', '07:00', '13:20', 199],
  ['MR0001', 'SIN', 'SFO', '2027-11-11', '18:40', '18:30', 702], ['FS0201', 'SIN', 'TPE', '2027-11-11', '22:30', '03:05+1', 88],
  ['MR0003', 'SIN', 'SFO', '2027-11-11', '22:40', '22:30', 884], ['KT0315', 'SIN', 'HND', '2027-11-11', '23:10', '06:50+1', 262],
  ['FS0203', 'TPE', 'HND', '2027-11-12', '06:20', '10:30', 95], ['KT0311', 'SIN', 'HND', '2027-11-12', '07:35', '15:15', 229],
  ['MR0011', 'SIN', 'NRT', '2027-11-12', '08:10', '16:00', 236], ['MR0005', 'SIN', 'SFO', '2027-11-12', '09:15', '09:05', 766],
  ['KT0313', 'SIN', 'HND', '2027-11-12', '13:20', '21:00', 241], ['KT0301', 'HND', 'SFO', '2027-11-12', '13:30', '06:05', 398],
  ['HB0102', 'NRT', 'SFO', '2027-11-12', '17:15', '09:55', 371], ['KT0303', 'HND', 'SFO', '2027-11-12', '22:50', '15:25', 452],
  ['MR0021', 'SIN', 'LAX', '2027-11-12', '23:30', '23:10', 512], ['FS0015', 'TPE', 'SFO', '2027-11-12', '23:50', '18:55', 566],
  ['HB1201', 'LAX', 'SFO', '2027-11-13', '06:30', '07:55', 79], ['MR0015', 'SIN', 'NRT', '2027-11-13', '08:00', '15:50', 247],
  ['FS0205', 'SIN', 'TPE', '2027-11-13', '09:30', '14:05', 176], ['MR0007', 'SIN', 'SFO', '2027-11-13', '10:05', '09:55', 828],
  ['HB1203', 'LAX', 'SFO', '2027-11-13', '12:40', '14:05', 99], ['FS0013', 'TPE', 'SFO', '2027-11-13', '16:00', '11:05', 589],
  ['HB1207', 'LAX', 'SFO', '2027-11-13', '17:30', '18:55', 89], ['HB0112', 'NRT', 'SFO', '2027-11-13', '18:20', '11:00', 402],
  ['MR0009', 'SIN', 'SFO', '2027-11-13', '19:20', '19:10', 731], ['MR0023', 'SIN', 'LAX', '2027-11-13', '19:30', '19:10', 498],
  ['MR0031', 'SIN', 'NRT', '2027-11-13', '21:00', '04:50+1', 254], ['KT0321', 'SIN', 'HND', '2027-11-13', '21:30', '05:10+1', 268],
  ['HB1205', 'LAX', 'SFO', '2027-11-13', '23:20', '00:45+1', 69], ['HB0110', 'NRT', 'SFO', '2027-11-14', '06:30', '23:10-1', 389],
  ['KT0305', 'HND', 'SFO', '2027-11-14', '07:00', '23:35-1', 375], ['MR0013', 'SIN', 'SFO', '2027-11-14', '09:00', '08:50', 612],
]);

const TRIP_FLIGHTS_CSV = `flight,airline,from,to,date,departs,arrives,price_usd
${TRIP_TIMETABLE.map(([flight, ...rest]) => [flight, TRIP_AIRLINES[flight.slice(0, 2)], ...rest].join(',')).join('\n')}
`;

const TRIP_AIRPORTS_CSV = `code,city,country,time_zone
${Object.entries(TRIP_AIRPORTS).map(([code, a]) => [code, a.city, a.country, a.zone].join(',')).join('\n')}
`;

const TRIP_README = `# Dana's trip to Tokyo and Singapore

Dana lives in San Francisco. Her trip is the cheapest one, from the flights in \`flights.csv\`, that keeps
every commitment below and follows the travel policy. Write it to \`itinerary.json\`.

## Commitments

Each time is local to its city.

1. San Francisco: her last commitment before the trip ends on Friday 5 November 2027 at 12:00.
2. Tokyo: a meeting on Tuesday 9 November 2027, from 09:00 to 17:00.
3. Singapore: a meeting on Thursday 11 November 2027, from 09:00 to 17:00.
4. San Francisco: home by Saturday 13 November 2027 at 23:59.

## Flights

\`flights.csv\` has one row per flight: \`flight\` (its number, which no other row has), \`airline\`, \`from\` and
\`to\` (airport codes), \`date\` (the local date it departs), \`departs\` (the local time at \`from\`), \`arrives\`
(the local time at \`to\`) and \`price_usd\` (its fare). A flight's local arrival date is \`date\`, unless
\`arrives\` ends in \`+1\` or \`+2\`: then it is that many days after \`date\`; or in \`-1\`: then it is the day
before \`date\`. \`airports.csv\` gives each airport's city, country and IANA time zone: an airport's local
times are in its zone. Tokyo has two airports, HND and NRT; a journey to or from Tokyo may use either.

## Travel policy

- The trip is three journeys, in the order of the commitments: San Francisco to Tokyo, Tokyo to Singapore,
  and Singapore to San Francisco. A journey is one flight, or two flights with one connection between
  them; never more.
- A journey's first flight departs at least 3 hours after the commitment before it ends. The journeys to
  Tokyo and to Singapore land at least 12 hours before the meeting there starts.
- No flight departs from 00:00 to 05:59, local time at the airport it leaves.
- A connection runs from one flight's arrival to the next flight's departure. At the airport where the
  first flight landed, it is at least 60 minutes after a domestic flight (one whose two airports are in
  the same country) and at least 90 minutes after an international flight. A connection changes airports
  only between HND and NRT, and then it is at least 4 hours.
- A journey takes at most 24 hours, from its first flight's departure to its last flight's arrival.

## Choosing

The cheapest trip is the one whose fares add up to the least. Of trips that cost the same, take the one with
fewer connections; of those, the one that lands in San Francisco earlier.

## itinerary.json

    {
      "flights": ["<flight>", ...],
      "total_usd": 0,
      "legs": [{ "flight": "<flight>", "depart_utc": "YYYY-MM-DDTHH:MM:SSZ", "arrive_utc": "YYYY-MM-DDTHH:MM:SSZ" }, ...]
    }

\`flights\` lists the trip's flights in the order flown, and \`total_usd\` the sum of their fares. \`legs\` has one
entry per flight, in the same order, with its departure and its arrival in UTC, as ISO 8601 ending in \`Z\`.
`;

const zoneFormats = new Map();

/** A zone's offset from UTC, in minutes, at an instant: Intl's own reading of the IANA zone. */
function zoneOffsetMinutes(ms, zone) {
  if (!zoneFormats.has(zone)) zoneFormats.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }));
  const name = zoneFormats.get(zone).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || '';
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** The instant a local date and time (`YYYY-MM-DD`, `HH:MM`) names in a zone. */
function tripInstant(date, time, zone) {
  const naive = Date.parse(`${date}T${time}:00Z`);
  return naive - zoneOffsetMinutes(naive - zoneOffsetMinutes(naive, zone) * 60000, zone) * 60000;
}

const TOKYO_AIRPORTS = Object.freeze(['HND', 'NRT']);
const HOUR_MS = 3600000;

/** Each flight of the timetable by its number, with its departure and arrival as instants. */
const TRIP_FLIGHTS = new Map(TRIP_TIMETABLE.map(([flight, from, to, date, departs, arrives, price]) => {
  const [time, days = '0'] = arrives.split(/(?=[+-])/);
  const arrivalDate = new Date(Date.parse(`${date}T00:00:00Z`) + Number(days) * 86400000).toISOString().slice(0, 10);
  return [flight, Object.freeze({
    flight, from, to, departs, price,
    dep: tripInstant(date, departs, TRIP_AIRPORTS[from].zone),
    arr: tripInstant(arrivalDate, time, TRIP_AIRPORTS[to].zone),
    domestic: TRIP_AIRPORTS[from].country === TRIP_AIRPORTS[to].country,
  })];
}));

/** Each journey: where it starts and ends, the earliest its first flight may leave, the latest its last may land. */
const TRIP_JOURNEYS = Object.freeze([
  { from: ['SFO'], to: TOKYO_AIRPORTS, after: tripInstant('2027-11-05', '15:00', 'America/Los_Angeles'), by: tripInstant('2027-11-08', '21:00', 'Asia/Tokyo') },
  { from: TOKYO_AIRPORTS, to: ['SIN'], after: tripInstant('2027-11-09', '20:00', 'Asia/Tokyo'), by: tripInstant('2027-11-10', '21:00', 'Asia/Singapore') },
  { from: ['SIN'], to: ['SFO'], after: tripInstant('2027-11-11', '20:00', 'Asia/Singapore'), by: tripInstant('2027-11-13', '23:59', 'America/Los_Angeles') },
]);

/** The one trip README.md allows (worked out by hand, and found again in the tests by a search of the timetable). */
const TRIP_ANSWER = Object.freeze({ journeys: Object.freeze([['HB1103', 'HB0021'], ['KT0253'], ['MR0031', 'HB0110']]), total: 1501 });

const flightNumber = (x) => String(x ?? '').toUpperCase().replace(/\s+/g, '');

/**
 * An itinerary's flights cut into the trip's three journeys: each starts where the one before it ended
 * (in Tokyo, at either airport) and ends at its first flight into the next city. `complete` when every
 * flight is in the timetable and the three journeys hold them all.
 */
function tripJourneys(numbers) {
  const flights = numbers.map((n) => TRIP_FLIGHTS.get(n));
  const journeys = [];
  let at = 0;
  for (const leg of TRIP_JOURNEYS) {
    if (!flights[at] || !leg.from.includes(flights[at].from)) break;
    const end = flights.findIndex((f, i) => i >= at && (!f || leg.to.includes(f.to)));
    if (end < 0 || !flights[end]) break;
    journeys.push(flights.slice(at, end + 1));
    at = end + 1;
  }
  return { journeys, complete: numbers.length > 0 && journeys.length === 3 && at === flights.length };
}

/** Each pair of flights in a journey, the second leaving after the first. */
const tripConnections = (journeys) => journeys.flatMap((j) => j.slice(1).map((f, i) => [j[i], f]));

// ---- Version 5: many interacting rules, applied exactly, over data too large to check by eye ----

const FISCAL_DAY_MS = 86400000;
/** A YYYY-MM-DD date as a count of days since 1970-01-01, and back. */
const fiscalDay = (iso) => Date.parse(`${iso}T00:00:00Z`) / FISCAL_DAY_MS;
const fiscalIso = (day) => new Date(day * FISCAL_DAY_MS).toISOString().slice(0, 10);

/** The last day of fiscal year `year`: the Saturday closest to 31 January of the next calendar year. */
function fiscalYearEnd(year) {
  const jan31 = fiscalDay(`${year + 1}-01-31`);
  const sinceSaturday = (new Date(jan31 * FISCAL_DAY_MS).getUTCDay() + 1) % 7;
  return sinceSaturday <= 3 ? jan31 - sinceSaturday : jan31 + 7 - sinceSaturday;
}

const fiscalWeeks = (year) => (fiscalYearEnd(year) - fiscalYearEnd(year - 1)) / 7;

/** The last week of each of P1 to P11 in a 4-4-5 year; P12 takes the rest, a 53rd week too. */
const FISCAL_PERIOD_ENDS = Object.freeze([4, 8, 13, 17, 21, 26, 30, 34, 39, 43, 47]);

/** The key of the fiscal period a day falls in: `FY2023-P12`. */
function fiscalPeriodOf(day) {
  const calendarYear = Number(fiscalIso(day).slice(0, 4));
  const year = day > fiscalYearEnd(calendarYear - 1) ? calendarYear : calendarYear - 1;
  const week = Math.floor((day - fiscalYearEnd(year - 1) - 1) / 7) + 1;
  return `FY${year}-P${FISCAL_PERIOD_ENDS.findIndex((last) => week <= last) + 1 || 12}`;
}

/** The weekdays each market published no rate, 2 January 2023 to 28 February 2025: TARGET's holidays for the euro, England's bank holidays for the pound. */
const FISCAL_CLOSED = Object.freeze({
  EUR: Object.freeze(['2023-04-07', '2023-04-10', '2023-05-01', '2023-12-25', '2023-12-26', '2024-01-01', '2024-03-29', '2024-04-01', '2024-05-01',
    '2024-12-25', '2024-12-26', '2025-01-01']),
  GBP: Object.freeze(['2023-01-02', '2023-04-07', '2023-04-10', '2023-05-01', '2023-05-08', '2023-05-29', '2023-08-28', '2023-12-25', '2023-12-26',
    '2024-01-01', '2024-03-29', '2024-04-01', '2024-05-06', '2024-05-27', '2024-08-26', '2024-12-25', '2024-12-26', '2025-01-01']),
});

/**
 * The fiscal-periods task's files: the treasury's rates (rates.csv, US dollars per euro and per pound on
 * each weekday a market published one) and about 1,600 sales and refunds (transactions.csv) from
 * 15 January 2023 to 15 February 2025 in USD, EUR and GBP, sold every day of the week. Built around the
 * task's rules: sales on both sides of each fiscal year's first Sunday and through FY2023's 53rd week;
 * large euro and pound sales over Easter 2024, when neither market had a rate, before the rates rose;
 * pound sales on an English bank holiday and euro sales on 1 May 2024, when only the other market had a
 * rate; in FY2024-P9, euro and pound refunds weeks after their sales, across a fall in the rates; refunds
 * in FY2024-P12 and FY2025-P1 of the previous period's sales; and in FY2024-P10, euro sales each just
 * under half a cent off the cent once converted, so rounding each line first loses money. Elsewhere a
 * refund is in USD or on its sale's day, and in its sale's period, and no one sells in a currency whose
 * own market is closed while the other is open, so each of those rules shows in its own periods only.
 * Deterministic.
 */
function fiscalData() {
  const rand = seededRandom(20261102);
  const closed = { EUR: new Set(FISCAL_CLOSED.EUR), GBP: new Set(FISCAL_CLOSED.GBP) };
  const jumps = { '2024-04-02': { EUR: 160, GBP: 190 }, '2024-10-14': { EUR: -180, GBP: -210 } };
  const level = { EUR: 10850, GBP: 12150 }; // US dollars per unit, in ten-thousandths
  const rates = new Map();
  for (let day = fiscalDay('2023-01-02'); day <= fiscalDay('2025-02-28'); day += 1) {
    if ([0, 6].includes(new Date(day * FISCAL_DAY_MS).getUTCDay())) continue;
    const iso = fiscalIso(day);
    for (const c of ['EUR', 'GBP']) level[c] += Math.round((rand() - 0.5) * 70) + (jumps[iso]?.[c] || 0);
    const row = { EUR: closed.EUR.has(iso) ? null : level.EUR, GBP: closed.GBP.has(iso) ? null : level.GBP };
    if (row.EUR !== null || row.GBP !== null) rates.set(day, row);
  }
  const rateOn = (currency, day) => {
    for (let d = day; ; d -= 1) if (Number.isInteger(rates.get(d)?.[currency])) return rates.get(d)[currency];
  };
  const first = fiscalDay('2023-01-15');
  const last = fiscalDay('2025-02-15');
  const rows = [];
  const dayOf = (at) => (typeof at === 'number' ? at : fiscalDay(at));
  const sale = (at, currency, cents) => {
    const row = { day: dayOf(at), currency, cents, type: 'sale' };
    rows.push(row);
    return row;
  };
  const refund = (of, at, cents = of.cents) => rows.push({ day: dayOf(at), currency: of.currency, cents, type: 'refund', of });
  const currencies = ['USD', 'USD', 'USD', 'USD', 'USD', 'EUR', 'EUR', 'EUR', 'GBP', 'GBP'];
  for (let day = first; day <= last; day += 1) {
    const count = 1 + Math.floor(rand() * 2.8);
    for (let k = 0; k < count; k += 1) {
      let currency = currencies[Math.floor(rand() * currencies.length)];
      if (rates.get(day)?.[currency] === null) currency = 'USD';
      const row = sale(day, currency, 1500 + Math.floor(rand() * 93500));
      if (rand() < 0.06) {
        const later = currency === 'USD' ? day + Math.floor(rand() * 21) : day;
        const on = later <= last && fiscalPeriodOf(later) === fiscalPeriodOf(day) ? later : day;
        refund(row, on, rand() < 0.5 ? row.cents : Math.round(row.cents * (0.2 + rand() * 0.6)));
      }
    }
  }
  // Each side of the first Sunday of FY2023, FY2024 and FY2025, and every day of FY2023's 53rd week.
  sale('2023-01-28', 'USD', 318000);
  sale('2023-01-29', 'EUR', 264000);
  sale('2023-01-31', 'GBP', 187500);
  for (let day = fiscalDay('2024-01-28'); day <= fiscalDay('2024-02-03'); day += 1) sale(day, ['USD', 'EUR', 'GBP'][day % 3], 150000 + Math.floor(rand() * 250000));
  sale('2024-02-04', 'GBP', 233000);
  sale('2025-02-01', 'EUR', 176000);
  sale('2025-02-02', 'USD', 289000);
  // Easter 2024: neither market had a rate from Friday 29 March to Monday 1 April.
  sale('2024-03-29', 'EUR', 412000);
  sale('2024-03-30', 'GBP', 356000);
  sale('2024-03-30', 'EUR', 198000);
  // A market's own holiday, while the other had a rate.
  sale('2023-08-28', 'GBP', 245000);
  sale('2023-08-28', 'GBP', 87650);
  sale('2024-05-01', 'EUR', 318800);
  sale('2024-05-01', 'EUR', 64320);
  // FY2024-P9: refunds weeks after their sales, across the fall of 14 October 2024.
  refund(sale('2024-10-02', 'GBP', 184000), '2024-10-28', 92000);
  refund(sale('2024-10-05', 'EUR', 260000), '2024-10-22');
  refund(sale('2024-10-08', 'GBP', 98000), '2024-10-19');
  refund(sale('2024-10-13', 'EUR', 145500), '2024-10-31');
  // Refunds in the period after their sale's, the last in the next fiscal year.
  refund(sale('2024-12-14', 'USD', 189900), '2025-01-06');
  refund(sale('2024-12-20', 'USD', 74950), '2025-01-11');
  refund(sale('2024-12-23', 'USD', 129900), '2025-01-17', 64950);
  refund(sale('2025-01-25', 'USD', 249900), '2025-02-04');
  refund(sale('2025-01-31', 'USD', 54900), '2025-02-10');
  // FY2024-P10: euro sales whose dollars sit 0.40 to 0.49 of a cent above a whole cent.
  for (const iso of ['2024-11-04', '2024-11-06', '2024-11-07', '2024-11-11', '2024-11-13', '2024-11-15', '2024-11-18', '2024-11-19', '2024-11-21', '2024-11-25', '2024-11-27', '2024-11-29']) {
    const rate = rateOn('EUR', fiscalDay(iso));
    let cents = 20000 + Math.floor(rand() * 60000);
    while ((cents * rate) % 10000 < 4000 || (cents * rate) % 10000 > 4900) cents += 1;
    sale(iso, 'EUR', cents);
  }
  rows.sort((a, b) => a.day - b.day);
  rows.forEach((row, i) => { row.id = `T${10001 + i}`; });
  const rate = (r) => (r === null ? '' : (r / 10000).toFixed(4));
  return {
    rates: `date,EUR,GBP\n${[...rates].map(([day, r]) => `${fiscalIso(day)},${rate(r.EUR)},${rate(r.GBP)}`).join('\n')}\n`,
    transactions: `id,date,currency,amount,type,refund_of\n${rows.map((r) => [r.id, fiscalIso(r.day), r.currency, (r.cents / 100).toFixed(2), r.type, r.of ? r.of.id : ''].join(',')).join('\n')}\n`,
  };
}

const FISCAL_README = `# Fiscal periods

We report in US dollars, by fiscal period. \`transactions.csv\` holds every sale and refund of our
storefronts, and \`rates.csv\` the treasury's daily exchange rates.

## The fiscal calendar

- A fiscal year runs from a Sunday to a Saturday. It ends on the Saturday closest to 31 January, which
  may fall in January or in February, and the next year starts on the Sunday after it.
- A year is named by the calendar year in which it starts: FY2019 ran from Sunday 3 February 2019 to
  Saturday 1 February 2020.
- A year has twelve periods, P1 to P12, of whole weeks counted from its first day. Each quarter has
  periods of 4, 4 and 5 weeks, so P3, P6, P9 and P12 have 5 weeks and the others 4: 52 weeks in all. A
  year of 53 weeks puts the extra week at the end of P12, which then has 6.

## US dollars

- \`transactions.csv\`: \`id,date,currency,amount,type,refund_of\`. \`date\` is YYYY-MM-DD. \`currency\` is
  \`USD\`, \`EUR\` or \`GBP\`, and \`amount\` is positive, in that currency. \`type\` is \`sale\` or \`refund\`.
  A refund names the sale it refunds in \`refund_of\`; that sale is in this file, in the same currency.
- \`rates.csv\`: \`date,EUR,GBP\`, the US dollars one euro and one pound were worth on that date. A row
  is a date on which at least one of the two had a rate. A cell is empty when its currency had no rate
  that day, a holiday of its own market. Weekends, and days on which neither had a rate, have no row.
- A line is converted at its currency's rate on its date. When its currency has no rate on that date
  (no row, or an empty cell), it takes that currency's rate on the latest earlier date that has one.
  A USD line is in dollars already.
- A refund is booked in the period of its own date, but converted at the rate of its sale's date, by
  the same rule. A refund may fall in a later period, or a later year, than its sale.
- A sale adds its dollars to its period's total; a refund takes them away.
- Convert each line without rounding, and add up a period's lines. Round each period's total to the
  cent once, half away from zero. Never round a line on its own.

## periods.json

    {
      "periods": { "FY2023-P1": 123456.78, ... },
      "weeks": { "FY2023": 53, ... }
    }

- \`periods\`: every fiscal period with at least one transaction, keyed \`FY<year>-P<period>\` with no
  leading zero (\`FY2023-P1\`, \`FY2023-P12\`), each with its total in US dollars, as a number.
- \`weeks\`: every fiscal year with at least one transaction, with the number of weeks in that year.
- The keys may be in any order.
`;

/** The fiscal-periods task's answers, from its files: each period's exact total, in millionths of a dollar, rounded to the cent once. */
function fiscalAnswers(transactionsText, ratesText) {
  const rates = new Map(csvRows(ratesText).slice(1).map(([date, ...cells]) => [fiscalDay(date),
    Object.fromEntries(['EUR', 'GBP'].map((c, i) => [c, cells[i] ? Math.round(Number(cells[i]) * 10000) : null]))]));
  const firstRate = Math.min(...rates.keys());
  const rateOn = (currency, day) => {
    if (currency === 'USD') return 10000;
    for (let d = day; d >= firstRate; d -= 1) if (Number.isInteger(rates.get(d)?.[currency])) return rates.get(d)[currency];
    throw new Error(`no ${currency} rate on or before ${fiscalIso(day)}`);
  };
  const lines = csvRows(transactionsText).slice(1).map(([id, date, currency, amount, type, refundOf]) => ({
    id, day: fiscalDay(date), currency, cents: Math.round(Number(amount) * 100), type, refundOf,
  }));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const exact = {};
  for (const l of lines) {
    const rateDay = l.type === 'refund' ? byId.get(l.refundOf).day : l.day;
    const key = fiscalPeriodOf(l.day);
    exact[key] = (exact[key] || 0) + (l.type === 'refund' ? -1 : 1) * l.cents * rateOn(l.currency, rateDay);
  }
  const toCents = (m) => {
    const rem = Math.abs(m) % 10000;
    return Math.sign(m) * ((Math.abs(m) - rem) / 10000 + (rem >= 5000 ? 1 : 0));
  };
  const years = [...new Set(Object.keys(exact).map((k) => Number(k.slice(2, 6))))].sort((a, b) => a - b);
  return {
    periods: Object.fromEntries(Object.entries(exact).map(([k, m]) => [k, toCents(m) / 100])),
    weeks: Object.fromEntries(years.map((y) => [`FY${y}`, fiscalWeeks(y)])),
    total: Object.values(exact).reduce((a, b) => a + b, 0) / 1e6,
  };
}

const FISCAL_DATA = Object.freeze(fiscalData());
const FISCAL_ANSWERS = Object.freeze(fiscalAnswers(FISCAL_DATA.transactions, FISCAL_DATA.rates));

/** The periods each of the fiscal task's checks names; one more check holds every period none names. */
const FISCAL_NAMED = Object.freeze({
  yearStart: ['FY2022-P12', 'FY2023-P1'],
  week53: ['FY2023-P12', 'FY2024-P1'],
  holiday: ['FY2024-P2'],
  ownMarket: ['FY2023-P8', 'FY2024-P3'],
  refundRate: ['FY2024-P9'],
  refundPeriod: ['FY2024-P11', 'FY2024-P12', 'FY2025-P1'],
  roundOnce: ['FY2024-P10'],
});

// ---- Version 5, se-cli-flag-rename: an option renamed across a small CLI, its old spellings kept ----

const SYNC_README = `# sync

\`sync [options] <source> <dest>\`, run as \`node bin/sync.mjs\`, copies every file under \`<source>\` into
\`<dest>\`, at the same path below it, replacing a file that is already there. It exits 0 when it is done,
and 1 when a file could not be copied, with \`error: <path>: <reason>\` on stderr for each.

Two flags do something else and copy nothing, so they need no \`<source>\` or \`<dest>\`: \`--help\` prints
the usage and, for each option, its command-line spellings and what it does; \`--print-options\` prints the
resolved options as one JSON object, such as \`{"dry":false,"verbose":true,"skipExisting":false}\`. Both
print on stdout and exit 0.

A usage error (an unknown option, a bad value, no \`<source>\` or \`<dest>\`) prints \`error: <message>\` on
stderr, prints nothing on stdout, and exits 2. Nothing is ever printed on stderr but the errors and the
warnings this file names.

## Options

Every option is a switch, off unless something turns it on, with a name in kebab-case. An option
\`<name>\` is spelled four ways:

| Where | Spelling | For \`skip-existing\` |
|---|---|---|
| Command line | \`--<name>\` turns it on, \`--no-<name>\` turns it off | \`--skip-existing\`, \`--no-skip-existing\` |
| Environment | \`SYNC_\`, then the name in upper case with each \`-\` as \`_\` | \`SYNC_SKIP_EXISTING\` |
| Config file | the name in camelCase | \`skipExisting\` |
| Resolved options | the name in camelCase, as in the config file | \`skipExisting\` |

| Option | What it does |
|---|---|
| \`dry\` | Copies nothing, and prints \`would copy <path>\` on stdout for each file it would copy |
| \`verbose\` | Prints \`copied <path>\` on stdout for each file it copies |
| \`skip-existing\` | Leaves a file that is already in \`<dest>\` as it is |

The resolved options hold every option once.

## Where a value comes from

Each option takes its value from the first of these that sets it: the command line, the environment,
the config file. When none does, it is off.

- **The command line.** Options take no value. An argument that starts with \`--\` and is neither a
  spelling of an option nor \`--help\` or \`--print-options\` (\`--dry=yes\`, say) is the usage error
  \`unknown option <argument>\`. When the command line gives an option more than once, the last counts.
- **The environment.** A variable that is unset or empty sets nothing. A variable is on with \`1\`,
  \`true\` or \`yes\`, and off with \`0\`, \`false\` or \`no\`, in any case (\`TRUE\` and \`No\` as well).
  Any other value is the usage error \`<variable> must be true or false\`, as in
  \`SYNC_VERBOSE must be true or false\`. Other variables are ignored.
- **The config file**, \`sync.config.json\` in the working directory, when there is one. It must hold a
  JSON object, or it is the usage error \`sync.config.json is not a JSON object\`. A key that is no
  option's spelling is the usage error \`unknown key <key> in sync.config.json\`, and a value other than
  \`true\` or \`false\` is \`<key> in sync.config.json must be true or false\`.

## Renaming an option

A renamed option answers to its old name until the next major release. Say \`max-depth\` were renamed
\`depth-limit\`:

- **Every old spelling still works**, as the same spelling of the new name would: \`--max-depth\`,
  \`--no-max-depth\`, \`SYNC_MAX_DEPTH\` and the config key \`maxDepth\`. The resolved options hold the
  option under its new key only (\`depthLimit\`).
- **Within one source, the new name wins.** On the command line, a flag of the new name beats every flag
  of the old one, wherever each stands: the last flag of the new name counts, or with none the last of
  the old. In the environment the new variable beats the old one, and in the config file the new key
  beats the old one. Between sources the order above holds, whichever name each uses:
  \`--max-depth\` beats \`SYNC_DEPTH_LIMIT=0\`.
- **Every value given is read**, under either name, even one that another overrides: a bad one is a
  usage error.
- **Each old spelling given prints a warning** on stderr, \`warning: <old> is deprecated; use <new>\`,
  \`<new>\` being the same spelling of the new name:
  \`warning: --no-max-depth is deprecated; use --no-depth-limit\`,
  \`warning: SYNC_MAX_DEPTH is deprecated; use SYNC_DEPTH_LIMIT\`,
  \`warning: maxDepth is deprecated; use depthLimit\`. A spelling warns once, however often it is given,
  and even when another value overrides it. The command line's warnings come first, in the order their
  spellings first appear in it, then the environment's, then the config file's.
- **\`--help\` shows the new spellings only.** No old spelling appears in it.
- **\`docs/options.md\` documents the option under its new spellings**, all four.
- **\`CHANGELOG.md\` records the rename** under \`## Unreleased\`, in its \`### Deprecated\` section (add
  one if there is none): an entry that names, each in backticks, every old spelling and the new spelling
  that replaces it.
`;

const SYNC_OPTIONS_SRC = `// Resolves the command's options from its command line, its environment and its config file, as
// README.md's "Options" says. It reads no file and prints nothing: run.mjs hands it the config file's
// contents (config.mjs reads them) and prints what it must.

/** A mistake in how the command was called: run.mjs prints it and exits 2. */
export class UsageError extends Error {}

/** Every option, by name. Each is a switch, off by default. */
export const OPTIONS = Object.freeze(['dry', 'verbose', 'skip-existing']);

/** An option's key in the config file and in the resolved options: \`skip-existing\` is \`skipExisting\`. */
const keyOf = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** An option's environment variable: \`skip-existing\` is \`SYNC_SKIP_EXISTING\`. */
const variableOf = (name) => \`SYNC_\${name.toUpperCase().replace(/-/g, '_')}\`;

/** The command line: the options it sets, the command's own flags and its operands. An option's last flag counts. */
function fromArgs(args) {
  const values = {};
  const flags = { help: false, printOptions: false };
  const operands = [];
  for (const arg of args) {
    if (arg === '--help') flags.help = true;
    else if (arg === '--print-options') flags.printOptions = true;
    else if (arg.startsWith('--')) {
      const off = arg.startsWith('--no-');
      const name = arg.slice(off ? '--no-'.length : '--'.length);
      if (!OPTIONS.includes(name)) throw new UsageError(\`unknown option \${arg}\`);
      values[keyOf(name)] = !off;
    } else operands.push(arg);
  }
  return { values, flags, operands };
}

/** The options the environment sets. A variable that is unset or empty sets nothing. */
function fromEnv(env) {
  const values = {};
  for (const name of OPTIONS) {
    const text = env[variableOf(name)];
    if (text) values[keyOf(name)] = Boolean(text);
  }
  return values;
}

/** The options the config file sets, from its contents. */
function fromConfig(config) {
  const values = {};
  for (const [key, value] of Object.entries(config)) {
    if (!OPTIONS.some((name) => keyOf(name) === key)) throw new UsageError(\`unknown key \${key} in sync.config.json\`);
    if (typeof value !== 'boolean') throw new UsageError(\`\${key} in sync.config.json must be true or false\`);
    values[key] = value;
  }
  return values;
}

/**
 * The resolved options (each under its key), the command's own flags and its operands. Each option comes
 * from the command line, else the environment, else the config file, else it is off.
 */
export function resolveOptions(args, env, config) {
  const cli = fromArgs(args);
  const environment = fromEnv(env);
  const file = fromConfig(config);
  const options = {};
  for (const name of OPTIONS) {
    const key = keyOf(name);
    options[key] = cli.values[key] ?? environment[key] ?? file[key] ?? false;
  }
  return { options, flags: cli.flags, operands: cli.operands };
}
`;

const SYNC_CONFIG_SRC = `// Reads sync.config.json from the working directory. It only reads and parses the file: which keys it may
// hold, and what they mean, is options.mjs's. Called by run.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './options.mjs';

/** The config file's contents, or {} when the working directory has none. */
export function readConfig(cwd) {
  let text;
  try {
    text = fs.readFileSync(path.join(cwd, 'sync.config.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError('sync.config.json is not a JSON object');
  return value;
}
`;

const SYNC_HELP_SRC = `// The text --help prints: the usage, and each option's command-line spellings with what it does and the
// variable that sets it. Keep it in step with README.md's "Options". Called by run.mjs.
export const HELP = \`Usage: sync [options] <source> <dest>

Copies every file under <source> into <dest>, at the same path.

Options:
  --dry, --no-dry                       Copy nothing; print each file that would be copied (SYNC_DRY)
  --verbose, --no-verbose               Print each file as it is copied (SYNC_VERBOSE)
  --skip-existing, --no-skip-existing   Leave a file already in <dest> as it is (SYNC_SKIP_EXISTING)
  --print-options                       Print the resolved options as JSON, and copy nothing
  --help                                Print this help

Every option is off unless something turns it on. The environment and sync.config.json can set them
too: see docs/options.md.
\`;
`;

const SYNC_RUN_SRC = `// Runs the sync command: resolves its options, then prints the help, prints the options, or copies the
// files. Called by bin/sync.mjs, and by the tests with their own env, cwd and output streams.
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { HELP } from './help.mjs';
import { UsageError, resolveOptions } from './options.mjs';

/** Every file under \`dir\`, relative to it with forward slashes, sorted. */
function filesUnder(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]))
    .sort();
}

/** Runs the command with \`args\`; returns its exit code. */
export function main(args, { env, cwd, stdout, stderr }) {
  let resolved;
  try {
    resolved = resolveOptions(args, env, readConfig(cwd));
    const { flags, operands } = resolved;
    if (!flags.help && !flags.printOptions && operands.length !== 2) throw new UsageError('expected <source> and <dest>');
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(\`error: \${err.message}\\n\`);
    return 2;
  }
  const { options, flags, operands } = resolved;
  if (flags.help) {
    stdout.write(HELP);
    return 0;
  }
  if (flags.printOptions) {
    stdout.write(\`\${JSON.stringify(options)}\\n\`);
    return 0;
  }
  const [source, dest] = operands.map((p) => path.resolve(cwd, p));
  let failed = false;
  for (const rel of filesUnder(source)) {
    const to = path.join(dest, rel);
    if (options.skipExisting && fs.existsSync(to)) continue;
    if (options.dry) {
      stdout.write(\`would copy \${rel}\\n\`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(source, rel), to);
      if (options.verbose) stdout.write(\`copied \${rel}\\n\`);
    } catch (err) {
      stderr.write(\`error: \${rel}: \${err.message}\\n\`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
`;

const SYNC_BIN_SRC = `#!/usr/bin/env node
// The sync command: see README.md. It hands its arguments, environment, working directory and output
// streams to main in src/run.mjs.
import { main } from '../src/run.mjs';

process.exitCode = main(process.argv.slice(2), { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
`;

const SYNC_DOCS = `# Options

Every option is a switch, off unless something turns it on. Each can be set in three places: on the
command line, in the environment, and in \`sync.config.json\` in the working directory. The command line
beats the environment, and the environment beats the config file.

| Option | Command line | Environment | sync.config.json | What it does |
|---|---|---|---|---|
| dry | \`--dry\`, \`--no-dry\` | \`SYNC_DRY\` | \`dry\` | Copies nothing, and prints \`would copy <path>\` for each file it would copy. |
| verbose | \`--verbose\`, \`--no-verbose\` | \`SYNC_VERBOSE\` | \`verbose\` | Prints \`copied <path>\` for each file it copies. |
| skip-existing | \`--skip-existing\`, \`--no-skip-existing\` | \`SYNC_SKIP_EXISTING\` | \`skipExisting\` | Leaves a file that is already in the destination as it is. |

An environment variable turns its option on with \`1\`, \`true\` or \`yes\`, and off with \`0\`, \`false\` or
\`no\`, in any case.

An example \`sync.config.json\`:

    { "verbose": true, "skipExisting": true }
`;

const SYNC_CHANGELOG = `# Changelog

Changes to sync, newest first. Each release has the sections of Keep a Changelog it needs: Added,
Changed, Deprecated, Removed, Fixed.

## Unreleased

### Added

- \`--print-options\` prints the resolved options as JSON, and copies nothing.

## 1.3.0 - 2026-09-14

### Added

- \`--skip-existing\` leaves a file that is already in the destination as it is.

### Fixed

- A file in a subdirectory of the source is copied into the same subdirectory of the destination.

## 1.2.0 - 2026-07-02

### Added

- Every option can be set in \`sync.config.json\`.
`;

const SYNC_OPTIONS_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOptions } from '../src/options.mjs';

test('an option nothing sets is off', () => {
  assert.equal(resolveOptions([], {}, {}).options.verbose, false);
});

test('the command line beats the environment, which beats the config file', () => {
  assert.equal(resolveOptions(['--no-verbose'], { SYNC_VERBOSE: '1' }, { verbose: true }).options.verbose, false);
  assert.equal(resolveOptions([], { SYNC_VERBOSE: 'true' }, { verbose: false }).options.verbose, true);
  assert.equal(resolveOptions([], {}, { skipExisting: true }).options.skipExisting, true);
});

test('an unknown option is a usage error', () => {
  assert.throws(() => resolveOptions(['--fast'], {}, {}), /unknown option --fast/);
});
`;

const SYNC_RUN_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/run.mjs';

const sink = () => {
  const out = { text: '', write(s) { out.text += s; } };
  return out;
};

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'from', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'from', 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'from', 'sub', 'b.txt'), 'b');
  return dir;
}

test('copies every file, at the same path', (t) => {
  const dir = tree(t);
  assert.equal(main(['from', 'to'], { env: {}, cwd: dir, stdout: sink(), stderr: sink() }), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'to', 'sub', 'b.txt'), 'utf8'), 'b');
});

test('--verbose prints each file it copies', (t) => {
  const dir = tree(t);
  const stdout = sink();
  assert.equal(main(['--verbose', 'from', 'to'], { env: {}, cwd: dir, stdout, stderr: sink() }), 0);
  assert.equal(stdout.text, 'copied a.txt\\ncopied sub/b.txt\\n');
});

test('--print-options prints the resolved options as JSON', (t) => {
  const dir = tree(t);
  const stdout = sink();
  assert.equal(main(['--print-options', '--verbose'], { env: {}, cwd: dir, stdout, stderr: sink() }), 0);
  assert.equal(JSON.parse(stdout.text).verbose, true);
});
`;

/** The rename task's workspace: the sync CLI as it is before the rename. */
const SYNC_FILES = Object.freeze({
  'package.json': `${JSON.stringify({ name: 'sync', version: '1.3.0', private: true, type: 'module', bin: { sync: 'bin/sync.mjs' }, scripts: { test: 'node --test' } }, null, 2)}\n`,
  'README.md': SYNC_README,
  'bin/sync.mjs': SYNC_BIN_SRC,
  'src/options.mjs': SYNC_OPTIONS_SRC,
  'src/config.mjs': SYNC_CONFIG_SRC,
  'src/help.mjs': SYNC_HELP_SRC,
  'src/run.mjs': SYNC_RUN_SRC,
  'docs/options.md': SYNC_DOCS,
  'CHANGELOG.md': SYNC_CHANGELOG,
  'test/options.test.mjs': SYNC_OPTIONS_TEST,
  'test/run.test.mjs': SYNC_RUN_TEST,
});

/** Each old spelling of the renamed option, with the new spelling that replaces it. */
const SYNC_RENAMED = Object.freeze([['--dry', '--dry-run'], ['--no-dry', '--no-dry-run'], ['SYNC_DRY', 'SYNC_DRY_RUN'], ['dry', 'dryRun']]);

/** The warning README.md gives an old spelling. */
const syncWarning = ([old, now]) => `warning: ${old} is deprecated; use ${now}`;

/**
 * The rename task's runs of the command, each in a directory of its own: its arguments (`--print-options`
 * when none are given), its environment (every other SYNC_ variable removed), its config file, a source
 * tree when `tree` is set, and what README.md says follows: the resolved `dryRun` (`want`), the exact
 * stderr (`warnings`), the error line of an exit 2 (`error`), or the files copied into `to/` (`files`).
 */
const SYNC_CASES = Object.freeze({
  on: { args: ['--dry-run', '--print-options'], want: true },
  off: { want: false },
  cliOverConfig: { args: ['--no-dry-run', '--print-options'], config: { dryRun: true }, want: false },
  envOverConfig: { env: { SYNC_DRY_RUN: '1' }, config: { dryRun: false }, want: true },
  cliOverEnv: { args: ['--no-dry-run', '--print-options'], env: { SYNC_DRY_RUN: 'yes' }, want: false },
  env0: { env: { SYNC_DRY_RUN: '0' }, config: { dryRun: true }, want: false },
  envFalse: { env: { SYNC_DRY_RUN: 'false' }, config: { dryRun: true }, want: false },
  envNo: { env: { SYNC_DRY_RUN: 'No' }, config: { dryRun: true }, want: false },
  envTrue: { env: { SYNC_DRY_RUN: 'TRUE' }, config: { dryRun: false }, want: true },
  envYes: { env: { SYNC_DRY_RUN: 'yes' }, config: { dryRun: false }, want: true },
  badNew: { env: { SYNC_DRY_RUN: 'maybe' }, error: 'error: SYNC_DRY_RUN must be true or false' },
  badOld: { env: { SYNC_DRY: '2' }, error: 'error: SYNC_DRY must be true or false' },
  badOverridden: { args: ['--dry-run', '--print-options'], env: { SYNC_DRY: 'off' }, error: 'error: SYNC_DRY must be true or false' },
  oldOn: { args: ['--dry', '--print-options'], want: true, warnings: [syncWarning(SYNC_RENAMED[0])] },
  oldOff: { args: ['--no-dry', '--print-options'], config: { dryRun: true }, want: false, warnings: [syncWarning(SYNC_RENAMED[1])] },
  oldEnv: { env: { SYNC_DRY: 'yes' }, want: true, warnings: [syncWarning(SYNC_RENAMED[2])] },
  oldKey: { config: { dry: true }, want: true, warnings: [syncWarning(SYNC_RENAMED[3])] },
  cliNewOverOld: { args: ['--no-dry-run', '--dry', '--print-options'], want: false },
  envNewOverOld: { env: { SYNC_DRY_RUN: '1', SYNC_DRY: 'false' }, want: true },
  keyNewOverOld: { config: { dryRun: false, dry: true }, want: false },
  oldCliOverNewEnv: { args: ['--dry', '--print-options'], env: { SYNC_DRY_RUN: '0' }, want: true },
  oldEnvOverNewKey: { env: { SYNC_DRY: '1' }, config: { dryRun: false }, want: true },
  allOld: { args: ['--dry', '--no-dry', '--print-options', '--dry', '--no-dry-run'], env: { SYNC_DRY: '1' }, config: { dry: true }, warnings: SYNC_RENAMED.map(syncWarning) },
  dryCopy: { args: ['--dry-run', 'from', 'to'], tree: true, files: [] },
  copy: { args: ['from', 'to'], tree: true, files: ['a.txt', 'sub/b.txt'] },
  help: { args: ['--help'] },
});

/** Runs every case of SYNC_CASES (put in for `__CASES__`) at once, and prints what each did as JSON. */
const SYNC_PROBE = String.raw`import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cases = __CASES__;
const root = process.cwd();
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SYNC_/i.test(k)));
const list = (dir, at = dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name), at) : [path.relative(at, path.join(dir, e.name)).split(path.sep).join('/')])).sort()
  : []);
const run = ([name, c]) => new Promise((resolve) => {
  const cwd = path.join(root, '.probe', name);
  fs.mkdirSync(cwd, { recursive: true });
  if (c.config) fs.writeFileSync(path.join(cwd, 'sync.config.json'), JSON.stringify(c.config));
  if (c.tree) {
    fs.mkdirSync(path.join(cwd, 'from', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'from', 'a.txt'), 'a');
    fs.writeFileSync(path.join(cwd, 'from', 'sub', 'b.txt'), 'b');
  }
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [path.join(root, 'bin', 'sync.mjs'), ...(c.args || ['--print-options'])], { cwd, env: { ...base, ...(c.env || {}) } });
  const timer = setTimeout(() => child.kill(), 20000);
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => { stderr += String(e); });
  child.on('close', (status) => {
    clearTimeout(timer);
    resolve([name, { status, stdout, stderr, files: list(path.join(cwd, 'to')) }]);
  });
});
process.stdout.write(JSON.stringify(Object.fromEntries(await Promise.all(Object.entries(cases).map(run)))));
`;

/** The `### Deprecated` section of CHANGELOG.md's `## Unreleased`, or null when there is none. */
function unreleasedDeprecated(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const from = lines.findIndex((l) => /^##\s+\[?unreleased\]?\s*$/i.test(l.trim()));
  if (from < 0) return null;
  const to = lines.findIndex((l, i) => i > from && /^##\s/.test(l));
  const unreleased = lines.slice(from + 1, to < 0 ? undefined : to);
  const at = unreleased.findIndex((l) => /^###\s+deprecated\s*$/i.test(l.trim()));
  if (at < 0) return null;
  const end = unreleased.findIndex((l, i) => i > at && /^#{2,3}\s/.test(l));
  return unreleased.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

export const MODEL_SUITE = Object.freeze([
  defineTask({
    id: 'se-fix-failing-test',
    role: 'software-engineer',
    split: 'train',
    prompt: 'In your workspace there is a small Node.js project whose tests fail when you run `node --test`. Find the bug in src/, fix it without changing anything under test/, and confirm the tests pass.',
    files: { 'package.json': PACKAGE_JSON, 'src/range.mjs': RANGE_SRC, 'test/range.test.mjs': RANGE_TEST },
    checks: (dir, { original }) => {
      const hidden = withScratch(dir, (copy) => nodeEval(copy, [
        "import { sumInclusiveRange as s } from './src/range.mjs';",
        "if (s(5, 7) !== 18 || s(0, 0) !== 0 || s(-3, -1) !== -6) process.exit(1);",
      ].join('\n')));
      return [
        check('node --test passes', nodeTest(dir).ok),
        check('test/range.test.mjs is unchanged', sameText(read(dir, 'test/range.test.mjs'), original('test/range.test.mjs'))),
        check('the fix is right for other ranges', hidden.ok, hidden.ok ? '' : hidden.output),
      ];
    },
  }),
  defineTask({
    id: 'se-implement-from-spec',
    role: 'software-engineer',
    split: 'holdout',
    prompt: 'Implement `slugify` in src/slug.mjs exactly as README.md describes, and add tests for it under test/ that pass with `node --test`.',
    files: {
      'package.json': PACKAGE_JSON,
      'README.md': SLUG_README,
      'src/slug.mjs': "/** A URL slug for a title: see README.md. */\nexport function slugify(text) {\n  throw new Error('not implemented');\n}\n",
    },
    checks: (dir) => {
      const cases = [
        ['Hello, World!', 'hello-world'],
        ['  --Already--Slugged--  ', 'already-slugged'],
        ['Version 2.0 Release', 'version-2-0-release'],
        ['MiXeD   case', 'mixed-case'],
        ['!!!', 'untitled'],
        ['', 'untitled'],
      ];
      const results = withScratch(dir, (copy) => cases.map(([input, want]) => {
        const r = nodeEval(copy, `import { slugify } from './src/slug.mjs'; process.stdout.write(JSON.stringify(slugify(${JSON.stringify(input)})));`);
        return check(`slugify(${JSON.stringify(input)}) is ${JSON.stringify(want)}`, r.ok && r.stdout === JSON.stringify(want), r.ok ? `got ${r.stdout}` : r.output);
      }));
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      return [
        ...results,
        check('a test for slugify is under test/', tests.some((f) => /slugify/.test(read(path.join(dir, 'test'), f) || ''))),
        check('node --test passes', tests.length > 0 && nodeTest(dir).ok),
      ];
    },
  }),
  defineTask({
    id: 'qa-reproduce-then-fix',
    role: 'qa-engineer',
    split: 'train',
    prompt: '`parseDuration` in src/duration.mjs is documented to accept combined durations such as "1h30m", but it throws on them. First add a test under test/ that reproduces the bug, then fix the function so every test passes with `node --test`.',
    files: { 'package.json': PACKAGE_JSON, 'src/duration.mjs': DURATION_SRC, 'test/duration.test.mjs': DURATION_TEST },
    checks: (dir, { original }) => {
      const testFiles = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      const reproduces = testFiles.some((f) => /\d+h\d+m|\d+m\d+s|\d+h\d+s/.test(read(path.join(dir, 'test'), f) || ''));
      // The new test must fail against the original code: put the bug back in a copy and run them.
      const catchesBug = withScratch(dir, (copy) => {
        fs.writeFileSync(path.join(copy, 'src/duration.mjs'), original('src/duration.mjs'), 'utf8');
        return !nodeTest(copy).ok;
      });
      const hidden = withScratch(dir, (copy) => nodeEval(copy, [
        "import { parseDuration as p } from './src/duration.mjs';",
        "const ok = p('1h30m') === 5400 && p('2m5s') === 125 && p('1h0m10s') === 3610 && p('45s') === 45;",
        "let threw = false; try { p('abc'); } catch { threw = true; }",
        'if (!ok || !threw) process.exit(1);',
      ].join('\n')));
      return [
        check('node --test passes', nodeTest(dir).ok),
        check('a test with a combined duration is under test/', reproduces),
        check('the tests fail on the original bug', reproduces && catchesBug),
        check('combined durations parse, and nonsense still throws', hidden.ok, hidden.ok ? '' : hidden.output),
      ];
    },
  }),
  defineTask({
    id: 'devops-fix-service-config',
    role: 'devops-engineer',
    split: 'train',
    prompt: "`node check.mjs` reports problems with deploy/service.json. Fix the configuration so the check passes. Don't change check.mjs, and keep the service's image and port as they are.",
    files: { 'check.mjs': CHECK_MJS, 'deploy/service.json': SERVICE_JSON, 'package.json': PACKAGE_JSON },
    checks: (dir, { original }) => {
      const res = spawnSync(process.execPath, ['check.mjs'], { cwd: dir, encoding: 'utf8', timeout: NODE_TIMEOUT_MS, env: checkEnv() });
      const cfg = json(dir, 'deploy/service.json').value || {};
      return [
        check('node check.mjs passes', res.status === 0, (res.stdout || '').trim()),
        check('check.mjs is unchanged', sameText(read(dir, 'check.mjs'), original('check.mjs'))),
        check('the image is unchanged', cfg.image === 'registry.example.com/orders:1.4.2'),
        check('the port is still 8080', cfg.port === 8080),
      ];
    },
  }),
  defineTask({
    id: 'devops-incident-summary',
    role: 'devops-engineer',
    split: 'holdout',
    prompt: "logs/app.log is from last night's outage. Write incident.md with: the time of the first ERROR line, how many ERROR lines each component logged (one line per component, written as `component: count`), and the most likely root cause in one sentence.",
    files: { 'logs/app.log': APP_LOG },
    checks: (dir) => {
      const text = read(dir, 'incident.md') || '';
      const count = (component, n) => check(`${component}: ${n}`, new RegExp(`\\b${component}\\b\\W{0,4}${n}\\b`, 'i').test(text));
      return [
        check('incident.md exists', text.trim() !== ''),
        check('the first error time is 2026-03-02T04:11:09Z', /2026-03-02T04:11:09Z|04:11:09/.test(text)),
        count('db', 3),
        count('api', 5),
        count('cache', 1),
        check('the root cause is the full disk', /no space|disk (is |was )?full|ENOSPC|out of (disk )?space/i.test(text)),
      ];
    },
  }),
  defineTask({
    id: 'data-revenue-summary',
    role: 'data-engineer',
    split: 'train',
    prompt: 'Using data/sales.csv, write summary.json with two keys: `revenue_by_region`, an object mapping each region to its total revenue (units times unit_price, rounded to 2 decimals), and `top_product_by_units`, the product with the most units sold in total.',
    files: { 'data/sales.csv': SALES_CSV },
    checks: (dir) => {
      const { ok, value } = json(dir, 'summary.json');
      const rev = value?.revenue_by_region || {};
      const near = (got, want) => typeof got === 'number' && Math.abs(got - want) < 0.005;
      return [
        check('summary.json is JSON', ok),
        check('North is 855.96', near(rev.North, 855.96)),
        check('South is 733.23', near(rev.South, 733.23)),
        check('East is 1440.00', near(rev.East, 1440)),
        check('the top product by units is Lamp', value?.top_product_by_units === 'Lamp'),
      ];
    },
  }),
  defineTask({
    id: 'data-dedupe-customers',
    role: 'data-engineer',
    split: 'holdout',
    prompt: 'data/customers.csv has duplicate customers: rows whose emails match once case and surrounding spaces are ignored. Write data/customers.clean.csv with the same header and one row per customer, keeping the row with the earliest signup_date, with the kept rows in their original order.',
    files: { 'data/customers.csv': CUSTOMERS_CSV },
    checks: (dir) => {
      const rows = csvRows(read(dir, 'data/customers.clean.csv'));
      const ids = rows.slice(1).map((r) => String(r[0]).trim());
      const want = ['c2', 'c3', 'c4', 'c6'];
      return [
        check('the header is unchanged', rows[0]?.join(',') === 'id,email,name,signup_date'),
        check('there are 4 customers', ids.length === 4),
        check('the earliest row of each customer is kept', [...ids].sort().join(',') === [...want].sort().join(',')),
        check('the kept rows are in their original order', ids.join(',') === want.join(',')),
      ];
    },
  }),
  defineTask({
    id: 'gen-action-items',
    role: 'generic',
    split: 'train',
    prompt: 'From notes/meeting.txt, write action-items.md: a markdown table with the columns Owner, Action and Due, with one row per action item in the notes.',
    files: { 'notes/meeting.txt': MEETING_TXT },
    checks: (dir) => {
      // A table row is a line with at least two cells, leading and trailing pipes optional (GFM).
      const lines = (read(dir, 'action-items.md') || '').split(/\r?\n/).filter((l) => (l.match(/\|/g) || []).length >= 2 || /^\s*\|/.test(l));
      const header = lines[0] || '';
      const rows = lines.slice(1).filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim()));
      const has = (owner, day) => rows.some((r) => owner.test(r) && new RegExp(`\\b${day}(st|nd|rd|th)?\\b`).test(r));
      return [
        check('the table has Owner, Action and Due columns', /owner/i.test(header) && /action/i.test(header) && /due/i.test(header)),
        check('there are 4 action items', rows.length === 4),
        check('Rafael, due 12 March', has(/Rafael/, 12)),
        check('Wen, due 13 March', has(/\bWen\b/, 13)),
        check('Priya, due 14 March', has(/Priya/, 14)),
        check('Sam, due 17 March', has(/\bSam\b/, 17)),
      ];
    },
  }),
  defineTask({
    id: 'gen-extract-contacts',
    role: 'generic',
    split: 'holdout',
    prompt: 'Read docs/thread.txt and write contacts.json: an array of objects with "name" and "email", one for every person in the thread whose email address appears in it, each person once.',
    files: { 'docs/thread.txt': THREAD_TXT },
    checks: (dir) => {
      const { ok, value } = json(dir, 'contacts.json');
      const list = Array.isArray(value) ? value : [];
      const emails = list.map((c) => String(c?.email || '').trim().toLowerCase());
      const want = { 'maria.gomez@example.com': /maria/i, 'kenji@example.com': /kenji/i, 'fatima.ali@example.com': /fatima/i, 'olu.bello@example.com': /olu/i };
      const named = (email) => list.some((c) => String(c?.email || '').trim().toLowerCase() === email && want[email].test(String(c?.name || '')));
      return [
        check('contacts.json is an array', ok && Array.isArray(value)),
        check('the four people, each once', [...emails].sort().join(',') === Object.keys(want).sort().join(',')),
        ...Object.keys(want).map((email) => check(`${email} has its person's name`, named(email))),
      ];
    },
  }),
  defineTask({
    id: 'sec-remove-hardcoded-key',
    role: 'security-engineer',
    split: 'train',
    prompt: 'src/client.mjs has an API key written into the code. Change it to read the key from the environment variable PAYMENTS_API_KEY, make authHeader() throw a clear error when the variable is not set, and record the change in SECURITY.md. Keep `node --test` passing.',
    files: { 'package.json': PACKAGE_JSON, 'src/client.mjs': CLIENT_SRC, 'test/client.test.mjs': CLIENT_TEST },
    checks: (dir) => {
      const leaks = listFiles(dir).filter((f) => (read(dir, f) || '').includes(SECRET));
      const withKey = withScratch(dir, (copy) => nodeEval(copy,
        "import { authHeader } from './src/client.mjs'; if (authHeader() !== 'Bearer k-1') process.exit(1);", { PAYMENTS_API_KEY: 'k-1' }));
      const withoutKey = withScratch(dir, (copy) => nodeEval(copy,
        "delete process.env.PAYMENTS_API_KEY; let threw = false; try { const { authHeader } = await import('./src/client.mjs'); authHeader(); } catch { threw = true; } if (!threw) process.exit(1);",
        { PAYMENTS_API_KEY: '' }));
      return [
        check('the key appears in no file', leaks.length === 0, leaks.join(', ')),
        check('the header uses PAYMENTS_API_KEY', withKey.ok, withKey.ok ? '' : withKey.output),
        check('a missing key throws', withoutKey.ok, withoutKey.ok ? '' : withoutKey.output),
        check('SECURITY.md records the change', /PAYMENTS_API_KEY/.test(read(dir, 'SECURITY.md') || '')),
        check('node --test passes', nodeTest(dir).ok),
      ];
    },
  }),
  defineTask({
    id: 'se-lru-cache-ttl',
    role: 'software-engineer',
    split: 'train',
    prompt: 'Implement `createCache` in src/cache.mjs exactly as README.md describes, and add tests for it under test/ that pass with `node --test`.',
    files: { 'package.json': PACKAGE_JSON, 'README.md': CACHE_README, 'src/cache.mjs': CACHE_SRC },
    checks: (dir) => {
      const probe = withScratch(dir, (copy) => nodeEval(copy, CACHE_PROBE));
      let got = {};
      try {
        got = JSON.parse(probe.stdout || '{}');
      } catch {
        got = {};
      }
      const detail = probe.ok ? '' : probe.output;
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      return [
        check('set and get', got.basic, detail),
        check('the least recently used entry is dropped first', got.lru, detail),
        check('peek leaves the order as it is', got.peek, detail),
        check('an entry expires ttlMs after it was set, and get does not extend it', got.ttl, detail),
        check('set again restarts the time to live', got.reset, detail),
        check('an expired entry never takes a place', got.expired, detail),
        check('delete says whether there was an entry', got.delete, detail),
        check('a test for createCache is under test/', tests.some((f) => /createCache/.test(read(path.join(dir, 'test'), f) || ''))),
        check('node --test passes', tests.length > 0 && nodeTest(dir).ok),
      ];
    },
  }),
  defineTask({
    id: 'qa-find-seeded-bugs',
    role: 'qa-engineer',
    split: 'holdout',
    prompt: 'src/money.mjs has no tests. Write tests under test/ that pass with `node --test` and fail on any change that breaks what README.md documents. Do not change src/.',
    files: { 'package.json': PACKAGE_JSON, 'README.md': MONEY_README, 'src/money.mjs': MONEY_SRC },
    checks: (dir, { original }) => {
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      const passes = tests.length > 0 && nodeTest(dir).ok;
      // Each documented behaviour broken in a copy: the agent's tests must fail on it.
      const caught = (mutate) => withScratch(dir, (copy) => {
        fs.writeFileSync(path.join(copy, 'src/money.mjs'), mutate(original('src/money.mjs')), 'utf8');
        return !nodeTest(copy).ok;
      });
      return [
        check('src/money.mjs is unchanged', sameText(read(dir, 'src/money.mjs'), original('src/money.mjs'))),
        check('the tests under test/ pass', passes),
        ...MONEY_MUTANTS.map(([name, mutate]) => check(`the tests catch ${name}`, passes && caught(mutate))),
      ];
    },
  }),
  defineTask({
    id: 'data-join-clean-orders',
    role: 'data-engineer',
    split: 'train',
    prompt: "Write report.json from data/orders.csv and data/customers.csv with `revenue_by_region` (each region's revenue from completed orders, in dollars, rounded to cents), `completed_orders` (how many completed orders there are) and `top_month` (the YYYY-MM with the most completed revenue). The files were exported by hand: clean what you must (amounts, ids, statuses; dates are ISO or day/month/year), and count each order once.",
    files: { 'data/orders.csv': ORDERS_CSV, 'data/customers.csv': ORDER_CUSTOMERS_CSV },
    checks: (dir) => {
      const { ok, value } = json(dir, 'report.json');
      const regions = value?.revenue_by_region || {};
      const got = (v) => `got ${JSON.stringify(v)}`;
      return [
        check('report.json is JSON', ok && value !== null && typeof value === 'object'),
        check('North is 4250.10', near(regions.North, 4250.1), got(regions.North)),
        check('South is 350.50', near(regions.South, 350.5), got(regions.South)),
        check('East is 195.00', near(regions.East, 195), got(regions.East)),
        check('6 completed orders', Number(value?.completed_orders) === 6, got(value?.completed_orders)),
        check('the top month is 2026-02', value?.top_month === '2026-02', got(value?.top_month)),
      ];
    },
  }),
  defineTask({
    id: 'devops-crashloop-diagnosis',
    role: 'devops-engineer',
    split: 'holdout',
    prompt: 'The api service crash-loops and web answers 502; the logs are in logs/. Find every cause and fix deploy/stack.json so `node check.mjs` passes. Do not change check.mjs, any image, or the port a service listens on.',
    files: { 'check.mjs': STACK_CHECK_MJS, 'deploy/stack.json': STACK_JSON, 'logs/api.log': API_LOG, 'logs/web.log': WEB_LOG, 'package.json': PACKAGE_JSON },
    checks: (dir, { original }) => {
      const res = spawnSync(process.execPath, ['check.mjs'], { cwd: dir, encoding: 'utf8', timeout: NODE_TIMEOUT_MS, env: checkEnv() });
      const services = json(dir, 'deploy/stack.json').value?.services || {};
      const was = JSON.parse(original('deploy/stack.json')).services;
      const env = (name, key) => String(services[name]?.env?.[key] || '');
      return [
        check('node check.mjs passes', res.status === 0, `${res.stdout || ''}${res.stderr || ''}`.trim()),
        check('check.mjs is unchanged', sameText(read(dir, 'check.mjs'), original('check.mjs'))),
        check('every image is unchanged', Object.keys(was).every((n) => services[n]?.image === was[n].image)),
        check('every port is unchanged', Object.keys(was).every((n) => services[n]?.port === was[n].port)),
        check('api reaches db on 5432', /@db:5432\//.test(env('api', 'DATABASE_URL')), env('api', 'DATABASE_URL')),
        check('web reaches api on 9090', /^http:\/\/api:9090\/?$/.test(env('web', 'API_URL')), env('web', 'API_URL')),
        check('api depends on db', (services.api?.depends_on || []).includes('db')),
      ];
    },
  }),
  defineTask({
    id: 'sec-review-and-fix',
    role: 'security-engineer',
    split: 'train',
    prompt: 'Review src/ against what README.md says each function must do, and fix every security flaw you find without changing the documented behaviour. Add tests under test/ for each fix; they must pass with `node --test`.',
    files: { 'package.json': PACKAGE_JSON, 'README.md': SECREVIEW_README, 'src/files.mjs': FILES_SRC, 'src/query.mjs': QUERY_SRC },
    checks: (dir) => {
      const probe = withScratch(dir, (copy) => {
        writeFiles(copy, { 'root/notes/today.txt': 'hello', 'root-evil/f.txt': 'evil', 'outside.txt': 'secret' });
        return nodeEval(copy, SEC_PROBE);
      });
      let got = {};
      try {
        got = JSON.parse(probe.stdout || '{}');
      } catch {
        got = {};
      }
      const detail = probe.ok ? '' : probe.output;
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      return [
        check('a file under root is read', got.read, detail),
        check('a name with ../ that leaves root throws', got.dotdot, detail),
        check('an absolute path throws', got.absolute, detail),
        check("a sibling directory whose name starts with root's throws", got.sibling, detail),
        check('a value is a parameter, never in the text', got.param, detail),
        check('parameters are numbered in order', got.numbered, detail),
        check('an unknown table throws', got.table, detail),
        check('a column that is not an identifier throws', got.column, detail),
        check('no filters, no WHERE', got.nofilter, detail),
        check('tests under test/ pass', tests.length > 0 && nodeTest(dir).ok),
      ];
    },
  }),
  defineTask({
    id: 'gen-meeting-schedule',
    role: 'generic',
    split: 'holdout',
    prompt: 'inbox/ holds this week\'s emails about meetings. Write schedule.json: the meetings that are still on, in order of start, each as {"title", "start_utc" (ISO 8601 in UTC, ending in Z), "attendees" (first names, sorted)}.',
    files: { ...INBOX },
    checks: (dir) => {
      const { ok, value } = json(dir, 'schedule.json');
      const list = Array.isArray(value) ? value : [];
      const find = (re) => list.find((m) => re.test(String(m?.title || '')));
      const at = (m) => (/Z$/.test(String(m?.start_utc || '')) ? Date.parse(m.start_utc) : NaN);
      const people = (m) => JSON.stringify(Array.isArray(m?.attendees) ? m.attendees.map(String) : null);
      const roadmap = find(/roadmap/i);
      const design = find(/design/i);
      return [
        check('schedule.json is an array', ok && Array.isArray(value)),
        check('two meetings: the vendor call was cancelled', list.length === 2 && !find(/vendor/i)),
        check('the roadmap review starts 2026-01-16T14:00:00Z', at(roadmap) === Date.parse('2026-01-16T14:00:00Z'), `got ${JSON.stringify(roadmap?.start_utc)}`),
        check('the roadmap review has Lena, Omar, Priya and Wen', people(roadmap) === JSON.stringify(['Lena', 'Omar', 'Priya', 'Wen'])),
        check('the design sync starts 2026-01-20T02:00:00Z', at(design) === Date.parse('2026-01-20T02:00:00Z'), `got ${JSON.stringify(design?.start_utc)}`),
        check('the design sync has Lena and Wen', people(design) === JSON.stringify(['Lena', 'Wen'])),
        check('in order of start', list.length === 2 && at(list[0]) < at(list[1])),
      ];
    },
  }),
  defineTask({
    id: 'se-csv-rfc4180',
    role: 'software-engineer',
    split: 'train',
    prompt: "src/csv.mjs's `parseCsv` breaks on real exports. Make it follow README.md exactly, and add tests under test/ for what you fix; `node --test` must pass.",
    files: { 'package.json': PACKAGE_JSON, 'README.md': CSV_README, 'src/csv.mjs': CSV_SRC, 'test/csv.test.mjs': CSV_TEST },
    checks: (dir) => {
      const code = [
        "import { parseCsv } from './src/csv.mjs';",
        `const inputs = ${JSON.stringify([...CSV_CASES.map((c) => c[1]), 'x\ny,"open\nmore'])};`,
        'process.stdout.write(JSON.stringify(inputs.map((t) => { try { return { ok: true, value: parseCsv(t) }; } catch (e) { return { ok: false, error: String(e && e.message) }; } })));',
      ].join('\n');
      const probe = withScratch(dir, (copy) => nodeEval(copy, code));
      let got = [];
      try {
        got = JSON.parse(probe.stdout || '[]');
      } catch {
        got = [];
      }
      const detail = probe.ok ? '' : probe.output;
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      return [
        ...CSV_CASES.map(([name, , want], i) => check(name, got[i]?.ok && JSON.stringify(got[i].value) === JSON.stringify(want), detail || `got ${JSON.stringify(got[i])}`)),
        check('an unterminated quoted field throws, naming the line it started on', got[CSV_CASES.length] && !got[CSV_CASES.length].ok
          && /unterminated quoted field at line 2\b/.test(got[CSV_CASES.length].error), detail || `got ${JSON.stringify(got[CSV_CASES.length])}`),
        check('node --test passes', tests.length > 0 && nodeTest(dir).ok),
      ];
    },
  }),
  defineTask({
    id: 'qa-race-in-queue',
    role: 'qa-engineer',
    split: 'train',
    prompt: 'Users report that `runAll` in src/queue.mjs sometimes returns results in the wrong order, and runs more tasks at once than it is asked to. First add tests under test/ that fail on the current code because of these bugs, then fix src/queue.mjs so that every test passes with `node --test`. Keep test/queue.test.mjs as it is.',
    files: { 'package.json': PACKAGE_JSON, 'README.md': QUEUE_README, 'src/queue.mjs': QUEUE_SRC, 'test/queue.test.mjs': QUEUE_TEST },
    checks: (dir, { original }) => {
      const probe = withScratch(dir, (copy) => nodeEval(copy, QUEUE_PROBE));
      let got = {};
      try {
        got = JSON.parse(probe.stdout || '{}');
      } catch {
        got = {};
      }
      const detail = probe.ok ? '' : probe.output;
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      const passes = tests.length > 0 && nodeTest(dir).ok;
      // The new tests must fail on the code as it was: put it back in a copy and run them.
      const catches = passes && withScratch(dir, (copy) => {
        fs.writeFileSync(path.join(copy, 'src/queue.mjs'), original('src/queue.mjs'), 'utf8');
        return !nodeTest(copy).ok;
      });
      return [
        check('node --test passes', passes),
        check('test/queue.test.mjs is unchanged', sameText(read(dir, 'test/queue.test.mjs'), original('test/queue.test.mjs'))),
        check('the tests fail on the original code', catches),
        check('results come in the order of the tasks', got.order, detail),
        check('no more than limit tasks run at once', got.limit, detail),
        check('a rejection rejects runAll, and no later task starts', got.reject, detail),
        check('no tasks resolve to []', got.empty, detail),
      ];
    },
  }),
  defineTask({
    id: 'devops-plan-order',
    role: 'devops-engineer',
    split: 'train',
    prompt: 'Write plan.json, the plan that turns infra/current.json into infra/desired.json, exactly as README.md defines it.',
    files: {
      'README.md': PLAN_README,
      'infra/current.json': `${JSON.stringify(PLAN_CURRENT, null, 2)}\n`,
      'infra/desired.json': `${JSON.stringify(PLAN_DESIRED, null, 2)}\n`,
    },
    checks: (dir) => {
      const { ok, value } = json(dir, 'plan.json');
      const actions = Array.isArray(value?.actions) ? value.actions.map((a) => `${a?.op} ${a?.id}`) : [];
      const ofOp = (list, op) => list.filter((x) => x.startsWith(`${op} `)).sort().join(', ');
      const want = PLAN_EXPECTED.actions;
      const got = (x) => `got ${x || 'none'}`;
      return [
        check('plan.json is JSON with actions and blocked', ok && Array.isArray(value?.actions) && Array.isArray(value?.blocked)),
        check('the creates are frontend, metrics, subnet-c and worker', ofOp(actions, 'create') === ofOp(want, 'create'), got(ofOp(actions, 'create'))),
        check('the updates are api, db and logs', ofOp(actions, 'update') === ofOp(want, 'update'), got(ofOp(actions, 'update'))),
        check('the deletes are old-queue, old-queue-consumer and old-worker', ofOp(actions, 'delete') === ofOp(want, 'delete'), got(ofOp(actions, 'delete'))),
        check('legacy-db and subnet-b are blocked', JSON.stringify(value?.blocked) === JSON.stringify(PLAN_EXPECTED.blocked), got(JSON.stringify(value?.blocked))),
        check('nothing that needs legacy-db is created', actions.length > 0 && !actions.some((a) => /^(create|update) reports(-ui)?$/.test(a))),
        check('each action comes after what it must follow', actions.length > 0 && planOrderHolds(actions)),
        check('the order is the one plan the rules allow', JSON.stringify(actions) === JSON.stringify(want), got(actions.join(', '))),
      ];
    },
  }),
  defineTask({
    id: 'gen-constrained-brief',
    role: 'generic',
    split: 'train',
    prompt: 'Write brief.md, a summary of report.md for our customers. It must be 120 to 160 words long; give the times the incident began and ended in UTC (as HH:MM UTC); state every customer impact, with its number; and end with exactly three bullet points: the three highest-priority action items, the highest first, each worded as in the report. It must not name any of our employees.',
    files: { 'report.md': REPORT_MD },
    checks: (dir) => {
      const text = read(dir, 'brief.md') || '';
      const words = wordsOf(text).length;
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const bullets = lines.filter((l) => /^[-*]\s+/.test(l));
      const lastThree = lines.slice(-3);
      const named = BRIEF.employees.filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(text));
      return [
        check('brief.md is 120 to 160 words long', text && words >= 120 && words <= 160, `${words} words`),
        check('it began at 18:40 UTC', /\b18:40\s*UTC\b/.test(text)),
        check('it ended at 20:12 UTC', /\b20:12\s*UTC\b/.test(text)),
        check('2,314 failed payments', /\b2,?314\b/.test(text)),
        check('checkout down for 17 minutes', /\b17\s*(minutes|min)\b/i.test(text)),
        check('an error rate of 4.2%', /\b4\.2\s?%/.test(text)),
        check('312 duplicate confirmation emails', /\b312\b/.test(text)),
        check('no employee is named', text && named.length === 0, named.join(', ')),
        check('it ends with exactly three bullet points', bullets.length === 3 && lastThree.every((l) => /^[-*]\s+/.test(l))),
        check('the bullets are the three highest-priority action items, highest first', bullets.length === 3
          && bullets.every((b, i) => plainWords(b) === plainWords(BRIEF.topActions[i])), bullets.join(' | ')),
      ];
    },
  }),
  defineTask({
    id: 'se-perf-latest-per-id',
    role: 'software-engineer',
    split: 'holdout',
    prompt: '`latestPerId` in src/events.mjs is correct, but far too slow for the batches of over 100,000 events it now gets. Make it fast (well under a second for 120,000 events) without changing anything it returns, as README.md describes it. Keep test/events.test.mjs as it is, passing with `node --test`.',
    files: { 'package.json': PACKAGE_JSON, 'README.md': EVENTS_README, 'src/events.mjs': EVENTS_SRC, 'test/events.test.mjs': EVENTS_TEST },
    checks: (dir, { original }) => {
      const probe = withScratch(dir, (copy) => nodeEval(copy, EVENTS_PROBE));
      let got = {};
      try {
        got = JSON.parse(probe.stdout || '{}');
      } catch {
        got = {};
      }
      const detail = probe.ok ? '' : probe.output;
      const timed = withScratch(dir, (copy) => spawnSync(process.execPath, ['--input-type=module', '-e', EVENTS_PERF], {
        cwd: copy, encoding: 'utf8', timeout: 6000, env: checkEnv(),
      }));
      const ms = timed.status === 0 ? Number(String(timed.stdout).trim()) : null;
      return [
        check('the same events as before, on random batches', got.random, detail),
        check('ties go to the greater version, then the later event', got.ties, detail),
        check('the kept events come in the order their ids first appear', got.order, detail),
        check('the events given are not changed', got.unchanged, detail),
        check('120,000 events take under a second', ms !== null && ms < 1000, ms === null ? 'it did not finish within 6 seconds' : `${ms} ms`),
        check('test/events.test.mjs is unchanged', sameText(read(dir, 'test/events.test.mjs'), original('test/events.test.mjs'))),
        check('node --test passes', nodeTest(dir).ok),
      ];
    },
  }),
  defineTask({
    id: 'data-tz-months',
    role: 'data-engineer',
    split: 'holdout',
    prompt: 'Write monthly.json: the net revenue of each calendar month in New York time (America/New_York), from data/payments.csv. Charges add and refunds subtract, each in the month, New York time, in which it happened. Amounts in dollars, rounded to the cent, keyed by YYYY-MM: {"2026-01": 12.34, ...}. Include only months that have payments.',
    files: { 'data/payments.csv': PAYMENTS_CSV },
    checks: (dir) => {
      const { ok, value } = json(dir, 'monthly.json');
      const months = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const extra = Object.keys(months).filter((m) => !(m in PAYMENTS_MONTHS));
      return [
        check('monthly.json is a JSON object', ok && value && typeof value === 'object' && !Array.isArray(value)),
        ...Object.entries(PAYMENTS_MONTHS).map(([m, want]) => check(`${m} is ${want.toFixed(2)}`, near(months[m], want), `got ${JSON.stringify(months[m])}`)),
        check('no other month', ok && extra.length === 0, extra.join(', ')),
      ];
    },
  }),
  defineTask({
    id: 'sec-token-verify',
    role: 'security-engineer',
    split: 'holdout',
    prompt: 'Review `verifyToken` in src/token.mjs against README.md and fix every way it accepts a token it should refuse, or refuses one it should accept. Add tests under test/ for each fix; they must pass with `node --test`.',
    files: { 'package.json': PACKAGE_JSON, 'README.md': TOKEN_README, 'src/token.mjs': TOKEN_SRC },
    checks: (dir) => {
      const probe = withScratch(dir, (copy) => nodeEval(copy, TOKEN_PROBE));
      let got = {};
      try {
        got = JSON.parse(probe.stdout || '{}');
      } catch {
        got = {};
      }
      const detail = probe.ok ? '' : probe.output;
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      return [
        check('a valid token gives its payload', got.valid, detail),
        check('alg none is refused', got.none, detail),
        check('an alg other than HS256 is refused', got.otherAlg, detail),
        check('a kid that names no key is refused', got.unknownKid, detail),
        check('a signature made with another key is refused', got.wrongKey, detail),
        check('a token is expired from exp + 30', got.expired, detail),
        check('a token within 30 seconds after exp is accepted', got.expLeeway, detail),
        check('a token is refused before nbf - 30', got.early, detail),
        check('a token within 30 seconds before nbf is accepted', got.nbfLeeway, detail),
        check('a malformed token is refused', got.malformed, detail),
        check('the signature is compared with crypto.timingSafeEqual', /\btimingSafeEqual\b/.test(read(dir, 'src/token.mjs') || '')),
        check('tests under test/ pass', tests.length > 0 && nodeTest(dir).ok),
      ];
    },
  }),
  defineTask({
    id: 'devops-log-forensics',
    role: 'devops-engineer',
    split: 'holdout',
    prompt: 'logs/access.log is this afternoon\'s access log from our two servers. For the hour from 14:00:00 to 14:59:59 UTC, write answers.json: {"errors_by_upstream": each upstream that served a request in that hour, with its count of 5xx responses (0 when none), "top_clients": the three client IPs that received the most bytes in that hour, most first, not counting /healthz requests, "slowest_path": the path with the highest average response time in that hour, among paths with at least 20 requests}.',
    files: { 'logs/access.log': ACCESS_LOG },
    checks: (dir) => {
      const { ok, value } = json(dir, 'answers.json');
      const errors = value?.errors_by_upstream || {};
      const want = LOG_ANSWERS;
      return [
        check('answers.json is JSON', ok && value && typeof value === 'object'),
        ...Object.entries(want.errors_by_upstream).map(([up, n]) => check(`${up} had ${n} 5xx responses`, Number(errors[up]) === n, `got ${JSON.stringify(errors[up])}`)),
        check('no other upstream', ok && Object.keys(errors).every((up) => up in want.errors_by_upstream)),
        check(`the top clients are ${want.top_clients.join(', ')}`, JSON.stringify(value?.top_clients) === JSON.stringify(want.top_clients), `got ${JSON.stringify(value?.top_clients)}`),
        check(`the slowest path is ${want.slowest_path}`, value?.slowest_path === want.slowest_path, `got ${JSON.stringify(value?.slowest_path)}`),
      ];
    },
  }),
  defineTask({
    id: 'design-contrast-fix',
    role: 'designer',
    split: 'train',
    prompt: "Make our palette accessible: every color pair in design/usage.json must meet WCAG 2.2 AA for its kind. Fix design/tokens.json exactly as README.md says, and write design/contrast.md with each pair's ratio before and after.",
    files: {
      'README.md': PALETTE_README,
      'design/tokens.json': `${JSON.stringify({ color: PALETTE }, null, 2)}\n`,
      'design/usage.json': `${JSON.stringify(PALETTE_USAGE, null, 2)}\n`,
    },
    checks: (dir, { original }) => {
      const { ok, value } = json(dir, 'design/tokens.json');
      const given = value?.color && typeof value.color === 'object' ? value.color : {};
      const now = Object.fromEntries(Object.keys(PALETTE).map((t) => [t, rgbOf(given[t])]));
      const complete = ok && Object.values(now).every(Boolean);
      const nowHex = Object.fromEntries(Object.entries(now).map(([t, c]) => [t, c ? hexOf(c) : null]));
      const same = (...tokens) => tokens.every((t) => nowHex[t] === PALETTE[t]);
      const short = complete ? PALETTE_USAGE.filter((p) => contrastRatio(now[p.foreground], now[p.background]) < CONTRAST_MIN[p.kind]) : PALETTE_USAGE;
      const changed = Object.keys(PALETTE).filter((t) => nowHex[t] && nowHex[t] !== PALETTE[t]);
      const audit = (read(dir, 'design/contrast.md') || '').toLowerCase();
      const fixed = (token, name) => {
        if (!complete) return check(name, false, 'design/tokens.json does not hold every color');
        const line = onHueLine(now[token], rgbOf(PALETTE[token]));
        const want = PALETTE_FIXES[token];
        return check(name, passesWhereUsed(token, now[token], nowHex) && line.off <= 2 && Math.abs(line.lightness - want) <= 2,
          `got ${nowHex[token]}: lightness ${line.lightness.toFixed(1)}, ${line.off} off its hue and saturation; the nearest lightness that passes is ${want.toFixed(1)}`);
      };
      return [
        check('design/tokens.json is JSON with every color', complete),
        check('every pair in design/usage.json meets its level', complete && short.length === 0, short.map((p) => `${p.foreground} on ${p.background}`).join(', ')),
        check('the backgrounds are as they were', same('surface', 'surface-alt', 'surface-dark')),
        check('success, large text at 3.46:1, is as it was', same('success')),
        check('text and heading-accent, which pass, are as they were', same('text', 'heading-accent')),
        fixed('text-muted', 'text-muted passes on surface-alt too, by the smallest change of lightness'),
        fixed('text-on-dark', 'text-on-dark, on a dark background, is lightened by the smallest change'),
        fixed('link', 'link, at 4.4957:1, falls short of 4.5 and is darkened by the smallest change'),
        fixed('danger', 'danger keeps its hue and saturation, by the smallest change of lightness'),
        fixed('border-input', 'border-input meets 3:1 as non-text, by the smallest change of lightness'),
        fixed('icon', 'icon meets 3:1 on surface-alt, by the smallest change of lightness'),
        check('design/usage.json is unchanged', sameText(read(dir, 'design/usage.json'), original('design/usage.json'))),
        check('design/contrast.md gives each changed color', changed.length > 0 && changed.every((t) => audit.includes(nowHex[t])), changed.filter((t) => !audit.includes(nowHex[t])).join(', ')),
      ];
    },
  }),
  defineTask({
    id: 'fin-invoice-report',
    role: 'finance-analyst',
    split: 'train',
    prompt: 'Write report.json for our September 2026 Google Cloud invoice from the billing export in billing/, exactly as README.md defines it.',
    files: { 'README.md': BILLING_README, 'billing/export.csv': BILLING_EXPORT, 'billing/budget.csv': BILLING_BUDGET },
    checks: (dir) => {
      const { ok, value } = json(dir, 'report.json');
      const services = value?.services && typeof value.services === 'object' ? value.services : {};
      const want = BILLING_ANSWERS;
      const got = (v) => `got ${JSON.stringify(v)}`;
      return [
        check('report.json is JSON', ok && value !== null && typeof value === 'object'),
        check('the currency is EUR', value?.currency === 'EUR', got(value?.currency)),
        check('the services are the six with regular costs', JSON.stringify(Object.keys(services).sort()) === JSON.stringify(Object.keys(want.services).sort()), got(Object.keys(services))),
        ...Object.entries(want.services).map(([name, s]) => check(`${name} nets ${s.net.toFixed(2)}: ${BILLING_TRAPS[name]}`, near(services[name]?.net, s.net), got(services[name]?.net))),
        check(`tax ${want.tax.toFixed(2)} and adjustments ${want.adjustments.toFixed(2)}, each on its own line`, near(value?.tax, want.tax) && near(value?.adjustments, want.adjustments), got([value?.tax, value?.adjustments])),
        check(`the total is ${want.total.toFixed(2)}`, near(value?.total, want.total), got(value?.total)),
        check(`the drivers are ${want.drivers.join(' and ')}, the largest change first`, JSON.stringify(value?.drivers) === JSON.stringify(want.drivers), got(value?.drivers)),
        check(`over budget: ${want.overBudget.join(', ')}`, JSON.stringify(value?.over_budget) === JSON.stringify(want.overBudget), got(value?.over_budget)),
      ];
    },
  }),
  defineTask({
    id: 'pm-tracker-update',
    role: 'project-manager',
    split: 'train',
    prompt: "Update tracker.csv, our action tracker, from the notes of the weekly meeting of 4 November 2026 in notes/2026-11-04-weekly.md, following the tracker's rules in README.md, and write flags.json as README.md describes.",
    files: { 'README.md': TRACKER_README, 'tracker.csv': TRACKER_CSV, 'notes/2026-11-04-weekly.md': TRACKER_NOTES },
    checks: (dir) => {
      const rowsOf = (text) => csvRows(text).slice(1).map((r) => Object.fromEntries(TRACKER_HEADER.map((h, i) => [h, String(r[i] ?? '').trim()])));
      const text = read(dir, 'tracker.csv');
      const header = (csvRows(text)[0] || []).map((h) => h.trim()).join(',');
      const items = rowsOf(text);
      const before = rowsOf(TRACKER_CSV);
      const byId = new Map(items.map((i) => [i.ID, i]));
      const item = (id) => byId.get(id) || {};
      const lower = (s) => String(s ?? '').toLowerCase();
      const meeting = '2026-11-04';
      const asWas = (id) => byId.has(id) && TRACKER_HEADER.every((h) => item(id)[h] === before.find((b) => b.ID === id)[h]);
      const fresh = items.filter((i) => !before.some((b) => b.ID === i.ID));
      const find = (re) => fresh.find((i) => re.test(i.Action)) || {};
      const owes = (re, owner, due) => lower(find(re).Owner) === owner && find(re).Due === due;
      const risk = find(/risk register/i);
      const { value: flags } = json(dir, 'flags.json');
      const flagged = (key) => JSON.stringify(Array.isArray(flags?.[key]) ? flags[key].map((x) => String(x).trim()) : null);
      const byNumber = (ids) => [...ids].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
      const got = (v) => `got ${JSON.stringify(v)}`;
      return [
        check('tracker.csv keeps its header and every row, with ID, Action, Owner, Source and Opened as they were', header === TRACKER_HEADER.join(',')
          && before.every((b) => byId.has(b.ID) && ['Action', 'Owner', 'Source', 'Opened'].every((h) => item(b.ID)[h] === b[h]))),
        check('A-3 is done', lower(item('A-3').Status) === 'done', got(item('A-3').Status)),
        check('A-5 is blocked, with a note', lower(item('A-5').Status) === 'blocked' && Boolean(item('A-5').Note), got(item('A-5').Status)),
        check('A-7 is dropped, with a note', lower(item('A-7').Status) === 'dropped' && Boolean(item('A-7').Note), got(item('A-7').Status)),
        check('A-2 is due 2026-11-20: its owner agreed', item('A-2').Due === '2026-11-20', got(item('A-2').Due)),
        check('A-6 is still due 2026-11-16, and open: its owner did not agree to 9 November', item('A-6').Due === '2026-11-16' && lower(item('A-6').Status) === 'open', got([item('A-6').Due, item('A-6').Status])),
        check('A-2, A-3, A-5 and A-7 were updated on 2026-11-04, and A-1, A-4 and A-8 are as they were',
          ['A-2', 'A-3', 'A-5', 'A-7'].every((id) => item(id).Updated === meeting) && ['A-1', 'A-4', 'A-8'].every(asWas)),
        check('five new items, A-9 to A-13, open, from the meeting, and none for a remark that commits no one', fresh.length === 5
          && JSON.stringify(byNumber(fresh.map((i) => i.ID))) === JSON.stringify(['A-9', 'A-10', 'A-11', 'A-12', 'A-13'])
          && fresh.every((i) => lower(i.Status) === 'open' && i.Opened === meeting && i.Updated === meeting && i.Source.includes(meeting)), got(fresh.map((i) => `${i.ID} ${i.Action}`))),
        check('Wen sends the vendor list by Friday, 2026-11-06', owes(/vendor list/i, 'wen', '2026-11-06'), got(find(/vendor list/i).Due)),
        check('Priya drafts the runbook by the end of next week, 2026-11-13', owes(/runbook/i, 'priya', '2026-11-13'), got(find(/runbook/i).Due)),
        check('the risk register has no owner and no due date', lower(risk.Owner) === 'missing' && lower(risk.Due) === 'missing', got([risk.Owner, risk.Due])),
        check('Sam books the venue by the 18th, 2026-11-18', owes(/venue/i, 'sam', '2026-11-18'), got(find(/venue/i).Due)),
        check('Omar checks the certificate today, 2026-11-04', owes(/certificate|tls/i, 'omar', meeting), got(find(/certificate|tls/i).Due)),
        check('flags.json: A-8 is the one overdue item', flagged('overdue') === JSON.stringify(['A-8']), flagged('overdue')),
        check("flags.json: the unowned items are A-4 and the risk register's", Boolean(risk.ID) && flagged('unowned') === JSON.stringify(byNumber(['A-4', risk.ID])), flagged('unowned')),
        check('flags.json: the stale items are A-4 and A-8', flagged('stale') === JSON.stringify(['A-4', 'A-8']), flagged('stale')),
      ];
    },
  }),
  defineTask({
    id: 'ea-meeting-times',
    role: 'executive-assistant',
    split: 'train',
    prompt: 'Lena wants a 60-minute Q4 pricing review with Omar and Kenji, any time from Monday 2 to Friday 6 November 2026. From their calendars in calendars/, find the three earliest times that work for all three, and write options.json as README.md describes.',
    files: { 'README.md': MEETING_README, ...Object.fromEntries(Object.entries(MEETING_CALENDARS).map(([f, c]) => [f, `${JSON.stringify(c, null, 2)}\n`])) },
    checks: (dir) => {
      const { ok, value } = json(dir, 'options.json');
      const list = Array.isArray(value) ? value : [];
      const at = (iso) => (/Z$/.test(String(iso || '')) ? Date.parse(iso) : NaN);
      const starts = list.map((o) => at(o?.start_utc));
      const has = (n) => starts.includes(Date.parse(MEETING_TIMES[n].start));
      const known = starts.length > 0 && starts.every(Number.isFinite);
      const local = (o, who) => String(o?.local?.[who] ?? '').replace('T', ' ').slice(0, 16);
      return [
        check('options.json is a list of three times', ok && list.length === 3, `got ${list.length}`),
        check('Tuesday 3 November, 16:30 UTC: Kenji declined the demo then', has(0)),
        check("Wednesday 4 November, 16:30 UTC: Kenji's focus time shows as free", has(1)),
        check("Friday 6 November, 16:30 UTC: Lena's sync is cancelled, and Kenji's panel starts as it ends", has(2)),
        check("none at 16:00 UTC: Lena's weekday 1:1 is at 11:00 in New York, 16:00 UTC once daylight saving ends on 1 November",
          known && !starts.some((t) => new Date(t).toISOString().slice(11, 16) === '16:00')),
        check("none on Monday or Thursday: Omar's partner call, given in UTC, and his day out of office", known && !starts.some((t) => [1, 4].includes(new Date(t).getUTCDay()))),
        check('earliest first, each an hour long', known && starts.every((t, i) => (i === 0 || t > starts[i - 1]) && at(list[i]?.end_utc) - t === 3600000)),
        check("each attendee's local start time is right", list.length === 3 && MEETING_TIMES.every((m, i) => starts[i] === Date.parse(m.start)
          && ['lena', 'omar', 'kenji'].every((who) => local(list[i], who) === m.local[who])), JSON.stringify(list.map((o) => o?.local ?? null))),
      ];
    },
  }),
  defineTask({
    id: 'legal-contract-dates',
    role: 'legal-advisor',
    split: 'holdout',
    prompt: "Review contract.md for our lawyer: work out its key dates, find where it contradicts itself or points at nothing, and write review.json as README.md describes. Don't change the contract.",
    files: { 'README.md': CONTRACT_README, 'contract.md': CONTRACT_MD },
    checks: (dir, { original }) => {
      const { ok, value } = json(dir, 'review.json');
      const date = (key, want, name) => check(name, String(value?.[key] ?? '').trim() === want, `got ${JSON.stringify(value?.[key] ?? null)}`);
      const list = Array.isArray(value?.inconsistencies) ? value.inconsistencies : [];
      const found = (...patterns) => list.some((e) => patterns.every((re) => re.test(JSON.stringify(e))));
      const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
      const text = flat(CONTRACT_MD);
      const misquoted = list.map((e) => String(e?.quote ?? '')).filter((q) => !flat(q) || !text.includes(flat(q)));
      return [
        check('review.json is JSON', ok && value !== null && typeof value === 'object'),
        date('initial_term_ends', '2028-03-14', 'the Initial Term ends on 2028-03-14'),
        date('non_renewal_notice_by', '2027-12-15', 'notice of non-renewal by 2027-12-15: 2028 is a leap year'),
        date('price_increase_notice_by', '2028-01-15', 'notice of a price increase by 2028-01-15'),
        date('implementation_plan_due', '2026-04-29', 'the implementation plan by 2026-04-29'),
        date('april_2026_credit_claim_by', '2026-05-18', "April's service credit claimed by 2026-05-18: ten Business Days skip 1 May and 14 May"),
        check('the fee: EUR 48,000 in 4.1, EUR 45,000 in Schedule A', found(/4\.1/, /schedule\s*a\b/i)),
        check('Section 9.2 refers to a Section 9.4 the agreement does not have', found(/9\.4/)),
        check('Section 10.2 refers to a Schedule B the agreement does not have', found(/schedule\s*b\b/i)),
        check('"Customer Data" (7.1) is never defined', found(/customer data/i)),
        check('every quote is copied exactly from contract.md', list.length > 0 && misquoted.length === 0, misquoted.slice(0, 3).join(' | ')),
        check('contract.md is unchanged', sameText(read(dir, 'contract.md'), original('contract.md'))),
      ];
    },
  }),
  defineTask({
    id: 'web-moved-pages',
    role: 'web-master',
    split: 'holdout',
    prompt: 'Several pages of our site moved, and firebase.json now redirects their old addresses. Fix the links in public/ so that none needs a redirect or misses, as README.md describes, and write public/sitemap.xml.',
    files: { 'README.md': SITE_README, ...SITE_FILES },
    checks: (dir, { original }) => {
      const canonical = new Set(SITE_PAGES.map(sitePath));
      const refs = SITE_PAGES.map((rel) => {
        const html = read(dir, `public/${rel}`);
        return { rel, ...(html === null ? { links: [], assets: [] } : pageRefs(html)) };
      });
      const ours = refs.flatMap((p) => p.links.map((l) => ({ ...l, page: p.rel, at: sitePathOf(l.href, p.rel) }))).filter((l) => l.at !== null);
      const crooked = ours.filter((l) => !(l.href.startsWith('/') && !l.href.startsWith('//') && canonical.has(l.href)));
      const linksTo = (re, want) => {
        const named = ours.filter((l) => re.test(l.text));
        return named.length > 0 && named.every((l) => l.href === want);
      };
      const isFile = (at) => {
        try {
          return fs.statSync(path.join(dir, 'public', decodeURIComponent(at))).isFile();
        } catch {
          return false;
        }
      };
      const broken = refs.flatMap((p) => p.assets.map((a) => ({ page: p.rel, a, at: sitePathOf(a, p.rel) }))).filter((x) => x.at === null || !isFile(x.at));
      const changedText = SITE_PAGES.filter((rel) => pageText(read(dir, `public/${rel}`) ?? '') !== pageText(original(`public/${rel}`)));
      const locs = [...(read(dir, 'public/sitemap.xml') || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      const indexed = SITE_INDEXED.map((p) => `https://www.example.com${p}`);
      return [
        check('firebase.json is unchanged', sameText(read(dir, 'firebase.json'), original('firebase.json'))),
        check('every page is still there, its text as it was', changedText.length === 0, changedText.join(', ')),
        check('every link to one of our pages is its own root-relative address, reached with no redirect', ours.length > 0 && crooked.length === 0,
          crooked.slice(0, 5).map((l) => `${l.page}: ${l.href}`).join(', ')),
        check('About goes straight to /company/overview, not through /company', linksTo(/^about/i, '/company/overview')),
        check('API and Getting started go to /help: the first redirect that matches wins', linksTo(/^(api|getting started)$/i, '/help')),
        check('the launch post is /news/2025/launch, from every page that links to it', linksTo(/launch/i, '/news/2025/launch')),
        check('every stylesheet and image is a file in public/', broken.length === 0, broken.slice(0, 5).map((x) => `${x.page}: ${x.a}`).join(', ')),
        check('the sitemap lists every page a search engine should index', indexed.every((u) => locs.includes(u)), `got ${locs.join(', ')}`),
        check('the sitemap leaves out the 404 page and the noindex draft, and lists nothing else', locs.length > 0 && locs.every((u) => indexed.includes(u)), `got ${locs.join(', ')}`),
      ];
    },
  }),
  defineTask({
    id: 'pm-critical-path',
    role: 'project-manager',
    split: 'train',
    prompt: 'Schedule our customer portal plan, plan.csv, from its start date as README.md defines, then apply the agreed changes in notes/change-request.md and work out their impact. Write schedule.csv and impact.json as README.md describes.',
    files: { 'README.md': PM_README, 'plan.csv': PM_PLAN_CSV, 'calendar.md': PM_CALENDAR, 'notes/change-request.md': PM_CHANGE },
    checks: (dir) => {
      const rows = csvRows(read(dir, 'schedule.csv'));
      const header = (rows[0] || []).map((h) => h.trim()).join(',');
      const dates = new Map(rows.slice(1).map((r) => [String(r[0] ?? '').trim(), [String(r[1] ?? '').trim(), String(r[2] ?? '').trim()]]));
      const ids = PM_PLAN.map((r) => r[0]);
      const at = (id) => dates.get(id) || [];
      const want = PM_EXPECTED;
      const runs = (id) => JSON.stringify(at(id)) === JSON.stringify(want.dates[id]);
      const starts = (id) => at(id)[0] === want.dates[id][0];
      const offDays = [...dates].flatMap(([id, pair]) => pair.filter((d) => !pmWorkingDay(d)).map((d) => `${id} ${d}`));
      const { value } = json(dir, 'impact.json');
      const impact = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const date = (key) => String(impact[key] ?? '').trim();
      const listed = (key) => (Array.isArray(impact[key]) ? impact[key].map((x) => String(x).trim()) : null);
      const slips = impact.slipped_milestones && typeof impact.slipped_milestones === 'object' && !Array.isArray(impact.slipped_milestones) ? impact.slipped_milestones : {};
      const got = (v) => `got ${JSON.stringify(v ?? null)}`;
      return [
        check(`schedule.csv has the header ID,Start,Finish and one row for each of the ${ids.length} tasks`,
          header === 'ID,Start,Finish' && rows.length - 1 === ids.length && ids.every((id) => dates.has(id)), `got ${header || 'no header'} and ${Math.max(0, rows.length - 1)} rows`),
        check('no Start or Finish is a weekend or a holiday of calendar.md', rows.length > 1 && offDays.length === 0, offDays.slice(0, 5).join(', ')),
        check('T13 runs 2026-11-24 to 2026-12-03: the holidays of 26 and 27 November fall inside it', runs('T13'), got(at('T13'))),
        check('T9 starts 2026-11-30: T8 finishes on 2026-11-25, before the holidays and the weekend', starts('T9'), got(at('T9'))),
        check('T6 starts 2026-12-01: 4 working days after T5 starts (T5SS+4)', starts('T6'), got(at('T6'))),
        check('T11 runs 2026-12-09 to 2026-12-14: it finishes with T10 (T10FF), so it starts later than T9 allows', runs('T11'), got(at('T11'))),
        check('M1 and M2 fall on the day their last predecessor finishes, 2026-11-16 and 2026-12-22, as both Start and Finish', runs('M1') && runs('M2'), got([at('M1'), at('M2')])),
        check('T20 starts 2026-12-29: T17+2 waits 2 working days after the next one, across 24 and 25 December', starts('T20'), got(at('T20'))),
        check(`the project finishes on ${want.finishBefore} before the change`, date('finish_before') === want.finishBefore, got(impact.finish_before)),
        check('critical_before is every task with no float, through the API, in order of Start', JSON.stringify(listed('critical_before')) === JSON.stringify(want.criticalBefore), got(impact.critical_before)),
        check(`the project finishes on ${want.finishAfter} after the change`, date('finish_after') === want.finishAfter, got(impact.finish_after)),
        check('critical_after runs through the screens and the security review, not the API, and not M2, which has a day of float',
          JSON.stringify(listed('critical_after')) === JSON.stringify(want.criticalAfter), got(impact.critical_after)),
        check('M2 slips 3 working days, from 2026-12-22 to 2026-12-29, across the Christmas holidays', Number(slips.M2) === want.slips.M2, got(slips.M2)),
        check('M3 and M4 slip 4 working days: the wait for the security review adds one; and no other milestone is listed, as M1 does not move',
          Number(slips.M3) === want.slips.M3 && Number(slips.M4) === want.slips.M4 && JSON.stringify(Object.keys(slips).sort()) === JSON.stringify(Object.keys(want.slips)), got(slips)),
      ];
    },
  }),
  defineTask({
    id: 'design-token-build',
    role: 'designer',
    split: 'train',
    prompt: 'Build our design tokens into CSS: write build/tokens.css and build/errors.json from the token files in tokens/, exactly as README.md defines the build.',
    files: { 'README.md': DESIGN_TOKEN_README, ...DESIGN_TOKEN_TEXT },
    checks: (dir) => {
      const css = read(dir, 'build/tokens.css') ?? '';
      const found = tokenBlocks(css);
      const want = DESIGN_TOKEN_BUILD.blocks.map(([, vars]) => vars);
      const got = DESIGN_TOKEN_BUILD.blocks.map(([selector]) => new Map((found.find((b) => b.selector === tokenSelector(selector))?.vars ?? [])
        .map((v) => [tokenKey(v.name), { name: v.name, value: tokenValue(v.value) }])));
      const valueIn = (i, name) => got[i].get(tokenKey(name))?.value;
      /** Whether block `i` gives each of `names` its value, and the ones it gets wrong. */
      const holds = (i, names) => {
        const off = names.filter((n) => valueIn(i, n) !== want[i].get(n));
        return [off.length === 0, off.map((n) => `${n}: ${valueIn(i, n) ?? 'absent'}`).join('; ')];
      };
      /** Whether block `i` has exactly the variables it should, each with its value. */
      const exactly = (i) => {
        const keys = new Map([...want[i].keys()].map((n) => [tokenKey(n), n]));
        const missing = [...keys].filter(([k]) => !got[i].has(k)).map(([, n]) => n);
        const extra = [...got[i]].filter(([k]) => !keys.has(k)).map(([, v]) => v.name);
        const wrong = [...keys].filter(([k, n]) => got[i].has(k) && got[i].get(k).value !== want[i].get(n)).map(([k, n]) => `${n}: ${got[i].get(k).value}`);
        const say = (label, list) => (list.length ? [`${label} ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''}`] : []);
        return [got[i].size > 0 && !missing.length && !extra.length && !wrong.length, [...say('missing', missing), ...say('extra', extra), ...say('wrong', wrong)].join('; ')];
      };
      const names = found.flatMap((b) => b.vars.map((v) => v.name));
      const rootNames = new Set((found.find((b) => b.selector === ':root')?.vars ?? []).map((v) => v.name));
      const kebab = ['--line-height-tight', '--color-action-primary-hover', '--component-button-primary-bg-hover', '--border-width-hairline', '--font-size-2xl'];
      const badNames = names.filter((n) => !/^--[a-z0-9]+(-[a-z0-9]+)*$/.test(n));
      const unsorted = found.filter((b) => b.vars.some((v, i) => i > 0 && tokenOrder(b.vars[i - 1].name, v.name) > 0));
      const hexes = found.flatMap((b) => b.vars.flatMap((v) => v.value.match(/#[0-9a-z]+/gi) || []));
      const badHex = hexes.filter((h) => !/^#[0-9a-f]{6}$/.test(h));
      const { ok, value } = json(dir, 'build/errors.json');
      const errors = Array.isArray(value) ? value.map((e) => `${e?.token} ${e?.reason}`) : [];
      const brokenKeys = new Set(DESIGN_TOKEN_BUILD.errors.map((e) => tokenKey(tokenVariable(e.token))));
      const leaked = found.flatMap((b) => b.vars.filter((v) => brokenKeys.has(tokenKey(v.name))).map((v) => `${b.selector} ${v.name}`));
      const unresolved = /\{[A-Za-z][\w.]*\}|var\(/.test(withoutCssComments(css));
      const outside = withoutCssComments(css).replace(TOKEN_CSS_BLOCK, '').trim();
      return [
        check('build/tokens.css has the four blocks, in order, and nothing else',
          JSON.stringify(found.map((b) => b.selector)) === JSON.stringify(DESIGN_TOKEN_BUILD.blocks.map(([s]) => tokenSelector(s))) && outside === '',
          `got ${found.map((b) => b.selector).join(' | ') || 'none'}${outside ? `; outside the blocks: ${outside.slice(0, 80)}` : ''}`),
        check('each name is -- and the path joined by hyphens, camelCase parts in kebab-case: lineHeight.tight is --line-height-tight',
          kebab.every((n) => rootNames.has(n)) && badNames.length === 0, [...kebab.filter((n) => !rootNames.has(n)).map((n) => `no ${n}`), ...badNames.slice(0, 4)].join(', ')),
        check('every block is sorted by name in code-point order: --color-gray-100 before --color-gray-50', got[0].size > 0 && unsorted.length === 0, unsorted.map((b) => b.selector).join(', ')),
        check('every color is #rrggbb in lower case, or rgba(): #FFF is #ffffff', hexes.length > 0 && badHex.length === 0 && valueIn(0, '--color-white') === '#ffffff',
          `got ${[...new Set(badHex)].slice(0, 4).join(', ')}${valueIn(0, '--color-white') === '#ffffff' ? '' : `; --color-white: ${valueIn(0, '--color-white') ?? 'absent'}`}`),
        check(":root resolves aliases after the layers merge: --component-link-color, through base's color.text.link and light's color.action.primary, is #2563eb",
          ...holds(0, ['--component-link-color', '--color-text-link', '--component-button-primary-bg-hover'])),
        check('a length in px is in rem at 16px, a half away from zero: 12px is 0.75rem, 0.5px 0.0313rem, 9999px 624.9375rem, 0px is 0, an em as given',
          ...holds(0, ['--space-3', '--border-width-hairline', '--radius-full', '--space-0', '--letter-spacing-tight', '--font-size-base', '--component-card-padding'])),
        check("a shadow is offsetX offsetY blur spread color, its lengths in rem and its color's alpha through the alias, a list joined by commas",
          ...holds(0, ['--shadow-sm', '--shadow-md', '--shadow-lg', '--component-card-shadow'])),
        check('a fontFamily is its names joined by commas, a name with a space in double quotes', ...holds(0, ['--font-family-body', '--font-family-heading', '--font-family-mono'])),
        check("rgba() below alpha 1: an alias keeps the alpha of the token it names unless it has its own, and alpha 1 is #rrggbb",
          ...holds(0, ['--color-overlay-scrim', '--component-dialog-backdrop', '--color-selection-bg', '--color-selection-border'])),
        check(':root has every token of the light set that is not broken, each value as README.md writes it', ...exactly(0)),
        check('[data-theme="dark"] lists exactly the variables whose value differs from :root\'s: not --color-status-danger, #dc2626 in both', ...exactly(1)),
        check("in [data-brand=\"ocean\"] the brand's primitives reach every alias of them: --component-link-color is #0e7490, --component-button-radius 0.625rem",
          ...holds(2, ['--color-action-primary', '--color-text-link', '--component-link-color', '--component-button-primary-bg', '--color-bg-selected', '--color-overlay-hover', '--component-button-radius'])),
        check('[data-brand="ocean"] lists exactly the variables whose value differs from :root\'s', ...exactly(2)),
        check('[data-brand="ocean"][data-theme="dark"] lists exactly what differs from the value the blocks above give: the ocean block\'s, else the dark block\'s, else :root\'s',
          ...exactly(3)),
        check('build/errors.json lists each broken token once, sorted by path, with its reason: cycle only for a token on the cycle',
          ok && JSON.stringify(errors) === JSON.stringify(DESIGN_TOKEN_BUILD.errors.map((e) => `${e.token} ${e.reason}`)), `got ${errors.join(', ')}`),
        check('no block has a broken token, even where it resolves (--color-border-default in :root), and no value is an alias or var()',
          got[0].size > 0 && leaked.length === 0 && !unresolved, [...leaked.slice(0, 4), ...(unresolved ? ['an alias or var() in tokens.css'] : [])].join(', ')),
      ];
    },
  }),
  defineTask({
    id: 'gen-handbook-answers',
    role: 'generic',
    split: 'train',
    prompt: 'Staff have sent the questions in questions.json about our handbook. Answer each one from handbook/ and its dated amendments, exactly as README.md says, and write answers.json.',
    files: {
      'README.md': HANDBOOK_README,
      ...HANDBOOK_POLICIES,
      ...HANDBOOK_AMENDMENTS,
      'questions.json': `${JSON.stringify(HANDBOOK_QUESTIONS, null, 2)}\n`,
    },
    checks: (dir) => {
      const { ok, value } = json(dir, 'answers.json');
      const list = Array.isArray(value) ? value : [];
      const idOf = (a) => String(a?.id ?? '').trim();
      const byId = new Map(list.map((a) => [idOf(a), a]));
      const cited = (a) => (Array.isArray(a?.clauses) ? a.clauses.map((c) => String(c).trim().toUpperCase()) : null);
      const wantIds = HANDBOOK_QUESTIONS.map((q) => q.id);
      const unknown = list.flatMap((a) => cited(a) || []).filter((c) => !HANDBOOK_IDS.has(c));
      const sameAnswer = (got, want) => (typeof want === 'number' ? typeof got === 'number' && Math.abs(got - want) < 0.005
        : typeof want === 'boolean' ? got === want
          : typeof got === 'string' && got.trim().toLowerCase() === want.toLowerCase());
      const answered = (id) => {
        const want = HANDBOOK_ANSWERS[id];
        const a = byId.get(id);
        const given = cited(a);
        const amendments = given ? [...new Set(given.filter((c) => /^A-\d{4}-\d{2}$/.test(c)))].sort() : null;
        const clausesOk = given !== null && (want.answer === 'not covered' ? given.length === 0
          : want.cite.every((c) => given.includes(c)) && JSON.stringify(amendments) === JSON.stringify([...want.by].sort()));
        return check(want.name, sameAnswer(a?.answer, want.answer) && clausesOk, `got ${JSON.stringify(a?.answer ?? null)}, citing ${JSON.stringify(given)}`);
      };
      return [
        check('answers.json lists Q1 to Q12 once each, as { id, answer, clauses }, citing only IDs the handbook has', ok && Array.isArray(value)
          && list.length === wantIds.length && wantIds.every((id) => byId.has(id)) && list.every((a) => a && typeof a === 'object' && 'answer' in a && cited(a)) && unknown.length === 0,
        `got ${JSON.stringify(list.map(idOf))}${unknown.length ? `; unknown IDs ${unknown.join(', ')}` : ''}`),
        ...wantIds.map(answered),
      ];
    },
  }),
  defineTask({
    id: 'devops-alert-incidents',
    role: 'devops-engineer',
    split: 'train',
    prompt: 'Turn our alert stream in alerts.jsonl into incidents, with the maintenance windows in maintenance.json, exactly as README.md defines them, and write incidents.json.',
    files: { 'README.md': ALERT_README, 'alerts.jsonl': ALERTS_JSONL, 'maintenance.json': `${JSON.stringify({ windows: ALERT_WINDOWS }, null, 2)}\n` },
    checks: (dir) => {
      const { ok, value } = json(dir, 'incidents.json');
      const want = ALERT_ANSWERS;
      const list = Array.isArray(value?.incidents) ? value.incidents.filter((i) => i && typeof i === 'object') : [];
      const at = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
      const ms = (iso) => Date.parse(iso);
      const find = (fingerprint, start) => list.find((i) => i.fingerprint === fingerprint && at(i.start) === ms(start)) || null;
      const ends = (i, end) => Boolean(i) && (end === null ? i.end === null : at(i.end) === ms(end));
      const startsIn = (service, from, to) => list.filter((i) => ALERT_FINGERPRINTS[service].some((a) => i.fingerprint === `${service}.${a}`) && at(i.start) >= ms(from) && at(i.start) < ms(to));
      const brief = (i) => (i ? `${i.id}: ${i.start} to ${i.end}, ${i.severity}, ${i.flaps} flaps` : 'none');
      const got = (v) => `got ${JSON.stringify(v)}`;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const sorted = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))) : o);
      const shaped = ok && value !== null && typeof value === 'object' && Number.isFinite(value.total) && Number.isFinite(value.suppressed)
        && ['by_service', 'by_severity', 'longest'].every((k) => value[k] && typeof value[k] === 'object' && !Array.isArray(value[k]))
        && ['id', 'fingerprint', 'start', 'end', 'minutes'].every((k) => k in value.longest)
        && ['open', 'flapping', 'incidents'].every((k) => Array.isArray(value[k]))
        && list.length === value.incidents.length && list.every((i) => ['id', 'fingerprint', 'service', 'severity', 'start', 'end', 'flaps'].every((k) => k in i));
      const theirs = new Map(list.map((i) => [i.id, i]));
      const ours = new Map(want.incidents.map((i) => [i.id, i]));
      // `open` and `flapping` are read through the answer's own incidents, so an incident numbered
      // differently (a split elsewhere in its fingerprint) still counts as the one it is.
      const named = (ids) => (Array.isArray(ids) ? ids.map((id) => (theirs.has(id) ? `${theirs.get(id).fingerprint} ${at(theirs.get(id).start)}` : `no incident ${id}`)) : null);
      const wanted = (ids) => ids.map((id) => `${ours.get(id).fingerprint} ${ours.get(id).start}`);
      const wrong = want.incidents.filter((w) => {
        const i = theirs.get(w.id);
        return !i || i.fingerprint !== w.fingerprint || i.service !== w.service || i.severity !== w.severity || at(i.start) !== w.start
          || (w.end === null ? i.end !== null : at(i.end) !== w.end) || Number(i.flaps) !== w.flaps;
      });
      const extra = list.filter((i) => !ours.has(i.id));
      const longest = value?.longest || {};
      const scene = {
        gap: [find('payments.provider-timeouts', '2026-10-23T09:00:00Z'), find('payments.provider-timeouts', '2026-10-23T09:24:01Z')],
        flap: [find('checkout.latency-p99', '2026-10-24T13:00:00Z'), find('checkout.latency-p99', '2026-10-24T13:55:01Z')],
        twice: [find('auth.login-failures', '2026-10-24T05:00:00Z'), find('auth.login-failures', '2026-10-24T05:16:30Z')],
        held: [find('checkout.http-5xx', '2026-10-26T07:50:00Z'), find('checkout.http-5xx', '2026-10-26T09:30:00Z')],
        repeated: [find('db.replication-lag', '2026-10-24T22:40:00Z'), find('db.replication-lag', '2026-10-25T00:45:00Z')],
        across: [find('queue.consumer-lag', '2026-10-24T22:00:00Z'), find('queue.consumer-lag', '2026-10-25T03:00:00Z')],
        york: find('auth.login-failures', '2026-10-26T11:20:00Z'),
        late: [find('payments.queue-depth', '2026-10-25T16:00:00Z'), find('payments.queue-depth', '2026-10-25T17:00:00Z')],
      };
      return [
        check('incidents.json is JSON with every field README.md names', shaped),
        check(`the total is ${want.total}, and by_service counts each service's incidents`, Number(value?.total) === want.total && same(sorted(value?.by_service), sorted(want.by_service)),
          got([value?.total, value?.by_service])),
        check(`${want.by_severity.critical} critical and ${want.by_severity.warning} warning: an incident takes its highest firing's severity`,
          same(sorted(value?.by_severity), sorted(want.by_severity)), got(value?.by_severity)),
        check(`open: the ${want.open.length} incidents still firing after the last event, one of them silent since 14:10`, same(named(value?.open), wanted(want.open)), got(value?.open)),
        check(`flapping: the ${want.flapping.length} incidents with 3 or more flaps`, same(named(value?.flapping), wanted(want.flapping)), got(value?.flapping)),
        check(`${want.suppressed} events suppressed by the maintenance windows`, Number(value?.suppressed) === want.suppressed, got(value?.suppressed)),
        check(`the longest is ${want.longest.fingerprint}'s from ${new Date(want.longest.start).toISOString().slice(11, 16)} on ${new Date(want.longest.start).toISOString().slice(0, 10)}, ${want.longest.minutes.toFixed(2)} minutes: an open incident is not counted`,
          longest.fingerprint === want.longest.fingerprint && at(longest.start) === want.longest.start && at(longest.end) === want.longest.end
          && Math.abs(Number(longest.minutes) - want.longest.minutes) < 0.006, got(longest)),
        check('every incident has the id, start, end, severity and flaps the rules give', shaped && wrong.length === 0 && extra.length === 0,
          `${wrong.length} wrong or missing, ${extra.length} extra: ${[...wrong.slice(0, 3).map((w) => (theirs.has(w.id) ? brief(theirs.get(w.id)) : `${w.id} missing`)), ...extra.slice(0, 2).map(brief)].join('; ')}`),
        check('a firing exactly 10 minutes after the previous one joins its incident, and one 10 minutes 1 second after starts a new one',
          ends(scene.gap[0], '2026-10-23T09:14:00Z') && ends(scene.gap[1], '2026-10-23T09:31:00Z'), scene.gap.map(brief).join(' | ')),
        check('a firing at most 10 minutes after a resolve is a flap, counted from the resolve, not from the previous firing',
          ends(scene.flap[0], '2026-10-24T13:45:00Z') && Number(scene.flap[0].flaps) === 3 && ends(scene.flap[1], '2026-10-24T14:01:00Z'), scene.flap.map(brief).join(' | ')),
        check('a second resolved event in a row changes nothing: the first one ends the incident',
          ends(scene.twice[0], '2026-10-24T05:06:00Z') && Number(scene.twice[0].flaps) === 0 && ends(scene.twice[1], '2026-10-24T05:23:00Z'), scene.twice.map(brief).join(' | ')),
        check('a suppressed event neither joins nor escalates an incident, and a window holds its start but not its end',
          ends(scene.held[0], '2026-10-26T07:58:00Z') && scene.held[0].severity === 'warning' && ends(scene.held[1], '2026-10-26T09:38:00Z')
          && startsIn('checkout', '2026-10-26T08:00:00Z', '2026-10-26T09:30:00Z').length === 0, scene.held.map(brief).join(' | ')),
        check("db's window from 01:00 to 02:40 in Berlin ends at the first 02:40 of the night the clocks go back: 23:00 to 00:40 UTC",
          ends(scene.repeated[0], '2026-10-24T22:58:00Z') && ends(scene.repeated[1], '2026-10-25T01:41:00Z')
          && startsIn('db', '2026-10-24T23:00:00Z', '2026-10-25T00:40:00Z').length === 0, scene.repeated.map(brief).join(' | ')),
        check("queue's window across the change runs from 00:30 summer time to 04:00 winter time: 22:30 to 03:00 UTC",
          ends(scene.across[0], '2026-10-24T22:20:00Z') && ends(scene.across[1], '2026-10-25T03:14:00Z')
          && startsIn('queue', '2026-10-24T22:30:00Z', '2026-10-25T03:00:00Z').length === 0, [...scene.across.map(brief), ...startsIn('queue', '2026-10-24T22:30:00Z', '2026-10-25T03:00:00Z').map(brief)].join(' | ')),
        check("auth's window is in New York daylight time, 10:00 to 11:00 UTC: US clocks go back only on 1 November",
          ends(scene.york, '2026-10-26T11:35:00Z') && startsIn('auth', '2026-10-26T10:00:00Z', '2026-10-26T11:00:00Z').length === 0,
          [brief(scene.york), ...startsIn('auth', '2026-10-26T10:00:00Z', '2026-10-26T11:00:00Z').map(brief)].join(' | ')),
        check('events are taken in order of ts, not in the order of the file',
          ends(scene.late[0], '2026-10-25T16:08:00Z') && Number(scene.late[0].flaps) === 0 && ends(scene.late[1], '2026-10-25T17:10:00Z'), scene.late.map(brief).join(' | ')),
      ];
    },
  }),
  defineTask({
    id: 'ea-trip-itinerary',
    role: 'executive-assistant',
    split: 'train',
    prompt: 'Dana has meetings in Tokyo and Singapore in November 2027. Choose her flights from flights.csv: the cheapest trip that keeps her commitments and follows our travel policy, both in README.md. Write itinerary.json as README.md describes.',
    files: { 'README.md': TRIP_README, 'flights.csv': TRIP_FLIGHTS_CSV, 'airports.csv': TRIP_AIRPORTS_CSV },
    checks: (dir) => {
      const { ok, value } = json(dir, 'itinerary.json');
      const numbers = Array.isArray(value?.flights) ? value.flights.map(flightNumber) : [];
      const legs = Array.isArray(value?.legs) ? value.legs : [];
      const { journeys, complete } = tripJourneys(numbers);
      const flights = journeys.flat();
      const connections = tripConnections(journeys);
      const gap = ([a, b]) => b.dep - a.arr;
      const inTokyo = (code) => TOKYO_AIRPORTS.includes(code);
      const names = (list) => list.map((f) => f.flight).join(' ');
      const got = (v) => `got ${JSON.stringify(v)}`;
      // A rule of README.md, held by the trip the itinerary names: what breaks it, or why there is no trip to hold it.
      const rule = (name, broken, show) => check(name, complete && broken.length === 0,
        complete ? broken.map(show).join('; ') : `not three journeys of flights.csv in order: ${got(numbers)}`);
      const journey = (i, name) => {
        const chosen = (journeys[i] || []).map((f) => f.flight);
        return check(name, JSON.stringify(chosen) === JSON.stringify(TRIP_ANSWER.journeys[i]), got(chosen));
      };
      const utc = (key, at, name) => {
        const wrong = legs.filter((l) => {
          const f = TRIP_FLIGHTS.get(flightNumber(l?.flight));
          return !f || !/Z$/.test(String(l?.[key] ?? '')) || Date.parse(l[key]) !== f[at];
        });
        return check(name, legs.length > 0 && wrong.length === 0, wrong.slice(0, 3).map((l) => `${l?.flight}: ${l?.[key]}`).join(', '));
      };
      return [
        check('itinerary.json holds flights, total_usd and a leg for each flight', ok && numbers.length > 0 && value.flights.every((n) => typeof n === 'string')
          && value.total_usd !== null && value.total_usd !== '' && Number.isFinite(Number(value.total_usd)) && legs.length === numbers.length
          && legs.every((l, i) => l && flightNumber(l.flight) === numbers[i] && typeof l.depart_utc === 'string' && typeof l.arrive_utc === 'string')),
        journey(0, 'San Francisco to Tokyo is HB1103 then HB0021: 60 minutes at LAX are enough after a domestic flight'),
        journey(1, 'Tokyo to Singapore is KT0253 alone: 06:00 is no red-eye, and at the same fare no connection beats one'),
        journey(2, "Singapore to San Francisco is MR0031 then HB0110: home at 23:10 on Saturday by its -1, before the same fare's 23:35"),
        check(`the total is $${TRIP_ANSWER.total}`, Number(value?.total_usd) === TRIP_ANSWER.total, got(value?.total_usd)),
        utc('depart_utc', 'dep', 'every depart_utc is right: California keeps PDT (UTC-7) until 7 November 2027, then PST (UTC-8)'),
        utc('arrive_utc', 'arr', 'every arrive_utc is right, on the day its +1, +2 or -1 gives'),
        rule("the trip is three journeys in the commitments' order, each one flight or two that connect",
          journeys.filter((j) => j.length > 2 || tripConnections([j]).some(([a, b]) => a.to !== b.from && !(inTokyo(a.to) && inTokyo(b.from)))), names),
        rule('every journey leaves at least 3 hours after the commitment before it ends', journeys.filter((j, i) => j[0].dep < TRIP_JOURNEYS[i].after), names),
        rule('the journeys to Tokyo and to Singapore land at least 12 hours before their meetings',
          journeys.slice(0, 2).filter((j, i) => j[j.length - 1].arr > TRIP_JOURNEYS[i].by), names),
        rule('no flight departs from 00:00 to 05:59 local time', flights.filter((f) => f.departs < '06:00'), (f) => `${f.flight} at ${f.departs}`),
        rule('every connection at one airport has 60 minutes after a domestic flight, 90 after an international one',
          connections.filter(([a, b]) => a.to === b.from && gap([a, b]) < (a.domestic ? 60 : 90) * 60000), (c) => `${names(c)}: ${gap(c) / 60000} min`),
        rule('a connection between HND and NRT has at least 4 hours',
          connections.filter(([a, b]) => a.to !== b.from && inTokyo(a.to) && inTokyo(b.from) && gap([a, b]) < 4 * HOUR_MS), (c) => `${names(c)}: ${gap(c) / 60000} min`),
        rule('every journey takes at most 24 hours, from its first departure to its last arrival',
          journeys.filter((j) => j[j.length - 1].arr - j[0].dep > 24 * HOUR_MS), (j) => `${names(j)}: ${(j[j.length - 1].arr - j[0].dep) / 60000} min`),
        rule('home in San Francisco by 23:59 on Saturday 13 November', journeys.slice(2).filter((j) => j[j.length - 1].arr > TRIP_JOURNEYS[2].by), names),
      ];
    },
  }),
  defineTask({
    id: 'fin-fiscal-periods',
    role: 'finance-analyst',
    split: 'train',
    prompt: "Restate our sales in US dollars by fiscal period. From transactions.csv and rates.csv, work out each period's total exactly as README.md defines our fiscal calendar, the conversion and the rounding, and write periods.json as it describes.",
    files: { 'README.md': FISCAL_README, 'transactions.csv': FISCAL_DATA.transactions, 'rates.csv': FISCAL_DATA.rates },
    checks: (dir) => {
      const { ok, value } = json(dir, 'periods.json');
      const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
      const periods = isObject(value?.periods) ? value.periods : {};
      const weeks = isObject(value?.weeks) ? value.weeks : {};
      const want = FISCAL_ANSWERS;
      const totals = (name, keys) => {
        const off = keys.filter((k) => !near(periods[k], want.periods[k]));
        return check(name, off.length === 0, off.slice(0, 4).map((k) => `${k}: got ${JSON.stringify(periods[k] ?? null)}, not ${want.periods[k].toFixed(2)}`).join('; '));
      };
      const one = (key) => want.periods[key].toFixed(2);
      const sameKeys = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
      const keys = Object.keys(want.periods).sort();
      const named = Object.values(FISCAL_NAMED).flat();
      const values = Object.values(periods).map(Number);
      const sum = values.reduce((a, b) => a + b, 0);
      const long = Object.keys(want.weeks).filter((y) => want.weeks[y] === 53);
      const short = Object.keys(want.weeks).filter((y) => want.weeks[y] === 52);
      return [
        check('periods.json is JSON with a "periods" and a "weeks" object', ok && isObject(value) && isObject(value.periods) && isObject(value.weeks)),
        check(`periods: the ${keys.length} that have transactions, FY2022-P12 to FY2025-P1, keyed FY<year>-P<n>`, sameKeys(periods, want.periods),
          `missing ${keys.filter((k) => !(k in periods)).join(', ') || 'none'}; extra ${Object.keys(periods).filter((k) => !(k in want.periods)).join(', ') || 'none'}`),
        check(`weeks: ${long.join(', ')} has 53, ${short.join(', ')} have 52`, sameKeys(weeks, want.weeks) && Object.entries(want.weeks).every(([y, n]) => Number(weeks[y]) === n),
          `got ${JSON.stringify(weeks)}`),
        totals('FY2023 starts on Sunday 29 January 2023, not 1 February: FY2022-P12 and FY2023-P1', FISCAL_NAMED.yearStart),
        totals('FY2023-P12 has six weeks, to Saturday 3 February 2024, and FY2024-P1 starts the day after', FISCAL_NAMED.week53),
        totals(`a weekend or holiday line takes the latest earlier rate: FY2024-P2, through Easter 2024, is ${one('FY2024-P2')}`, FISCAL_NAMED.holiday),
        totals("a currency with no rate on a day takes its own latest earlier one: GBP on 28 August 2023 in FY2023-P8, EUR on 1 May 2024 in FY2024-P3", FISCAL_NAMED.ownMarket),
        totals(`a refund is converted at its sale's rate: FY2024-P9 is ${one('FY2024-P9')}`, FISCAL_NAMED.refundRate),
        totals("a refund is booked in its own period, not its sale's: FY2024-P11, FY2024-P12 and FY2025-P1", FISCAL_NAMED.refundPeriod),
        totals(`FY2024-P10 is ${one('FY2024-P10')}: its lines added unrounded, the total rounded once`, FISCAL_NAMED.roundOnce),
        totals("every other period's total is right", keys.filter((k) => !named.includes(k))),
        check(`every line is converted: the periods add up to ${want.total.toFixed(2)}, within half a cent each`,
          values.length > 0 && values.every(Number.isFinite) && Math.abs(sum - want.total) <= 0.005 * values.length + 1e-6, `got ${sum.toFixed(2)}`),
      ];
    },
  }),
  defineTask({
    id: 'se-cli-flag-rename',
    role: 'software-engineer',
    split: 'train',
    prompt: 'Rename the `dry` option of our sync CLI to `dry-run`, so `--dry` becomes `--dry-run`, everywhere, as README.md\'s "Renaming an option" says: the old spellings keep working, with their deprecation warnings. When you are done, `node bin/sync.mjs` must behave exactly as README.md specifies and `node --test` must pass. Add tests under test/ for the rename.',
    files: SYNC_FILES,
    checks: (dir) => {
      const probe = withScratch(dir, (copy) => nodeEval(copy, SYNC_PROBE.replace('__CASES__', () => JSON.stringify(SYNC_CASES))));
      let runs = {};
      try {
        runs = JSON.parse(probe.stdout || '{}');
      } catch {
        runs = {};
      }
      const broke = probe.ok ? '' : probe.output;
      const ran = (n) => runs[n] || { status: null, stdout: '', stderr: '', files: [] };
      const printed = (n) => {
        try {
          const value = ran(n).status === 0 ? JSON.parse(ran(n).stdout) : null;
          return value && typeof value === 'object' ? value : null;
        } catch {
          return null;
        }
      };
      // stderr's lines, without the runtime warnings node itself may print (`(node:123) ...`).
      const stderr = (n) => String(ran(n).stderr).split('\n').map((l) => l.trimEnd()).filter((l) => l && !/^\(node:\d+\) |^\(Use `node --trace-/.test(l));
      const seen = (n) => `${n}: exit ${ran(n).status}, dryRun ${JSON.stringify(printed(n)?.dryRun ?? null)}, stderr ${JSON.stringify(stderr(n))}`;
      // Whether every named run did as README.md says, and when not, what the ones that did not did.
      const all = (names, ok) => {
        const off = names.filter((n) => !ok(n));
        return [off.length === 0, broke || off.map(seen).join('; ')];
      };
      const is = (n) => printed(n)?.dryRun === SYNC_CASES[n].want;
      const warnsExactly = (n) => ran(n).status === 0 && JSON.stringify(stderr(n)) === JSON.stringify(SYNC_CASES[n].warnings);
      const refuses = (n) => ran(n).status === 2 && String(ran(n).stdout).trim() === '' && stderr(n).includes(SYNC_CASES[n].error);
      const copies = (n) => ran(n).status === 0 && JSON.stringify(ran(n).files) === JSON.stringify(SYNC_CASES[n].files);
      const help = String(ran('help').stdout);
      const oldInHelp = help.match(/--no-dry(?!-run)|--dry(?!-run)|SYNC_DRY(?!_RUN)/g) || [];
      const docs = read(dir, 'docs/options.md') || '';
      const undocumented = SYNC_RENAMED.map(([, now]) => now).filter((s) => !docs.includes(s));
      const deprecated = unreleasedDeprecated(read(dir, 'CHANGELOG.md'));
      const unnamed = SYNC_RENAMED.flat().filter((s) => !String(deprecated ?? '').includes(`\`${s}\``) && !String(deprecated ?? '').includes(`\`"${s}"\``));
      const tests = listFiles(path.join(dir, 'test')).filter((f) => /\.test\.m?js$/.test(f));
      const passes = tests.length > 0 && nodeTest(dir).ok;
      // The tests must fail on the code as it was: put the seeded src/ and bin/ back in a copy and run them.
      const catches = passes && withScratch(dir, (copy) => {
        for (const d of ['src', 'bin']) fs.rmSync(path.join(copy, d), { recursive: true, force: true });
        writeFiles(copy, Object.fromEntries(Object.entries(SYNC_FILES).filter(([f]) => /^(src|bin)\//.test(f))));
        return !nodeTest(copy).ok;
      });
      return [
        check('--dry-run turns it on, without a warning, and the resolved options call it dryRun, not dry',
          ...all(['on', 'off'], (n) => is(n) && !('dry' in printed(n)) && stderr(n).length === 0)),
        check('the command line beats the environment, which beats the config file', ...all(['cliOverConfig', 'envOverConfig', 'cliOverEnv'], is)),
        check('SYNC_DRY_RUN is on for 1, true and yes and off for 0, false and no, in any case', ...all(['env0', 'envFalse', 'envNo', 'envTrue', 'envYes'], is)),
        check('a variable that is not true or false exits 2, naming it, even one another value overrides', ...all(['badNew', 'badOld', 'badOverridden'], refuses)),
        check('--dry and --no-dry still work on the command line, each with exactly one warning', ...all(['oldOn', 'oldOff'], (n) => is(n) && warnsExactly(n))),
        check('SYNC_DRY and the config key dry still work, each with exactly one warning', ...all(['oldEnv', 'oldKey'], (n) => is(n) && warnsExactly(n))),
        check('within one source the new name beats the old; between sources the command line, environment, config file order holds',
          ...all(['cliNewOverOld', 'envNewOverOld', 'keyNewOverOld', 'oldCliOverNewEnv', 'oldEnvOverNewKey'], is)),
        check("each old spelling warns once, even overridden: the command line's in order, then the environment's, then the config file's", ...all(['allOld'], warnsExactly)),
        check('--dry-run copies nothing, and without it every file is copied', broke === '' && copies('dryCopy') && copies('copy'),
          broke || `--dry-run copied ${JSON.stringify(ran('dryCopy').files)} (exit ${ran('dryCopy').status}); without it ${JSON.stringify(ran('copy').files)} (exit ${ran('copy').status})`),
        check('--help shows --dry-run and --no-dry-run, and no old spelling', ran('help').status === 0 && help.includes('--dry-run') && help.includes('--no-dry-run') && oldInHelp.length === 0,
          broke || `exit ${ran('help').status}; old spellings in it: ${JSON.stringify(oldInHelp)}`),
        check('docs/options.md documents --dry-run, --no-dry-run, SYNC_DRY_RUN and dryRun', docs !== '' && undocumented.length === 0, `missing ${undocumented.join(', ')}`),
        check("CHANGELOG.md's Unreleased section has a Deprecated entry naming each old spelling and its replacement, in backticks", deprecated !== null && unnamed.length === 0,
          deprecated === null ? 'no ### Deprecated under ## Unreleased' : `missing ${unnamed.join(', ')}`),
        check('node --test passes', passes),
        check('the tests fail on the original code', catches),
      ];
    },
  }),
]);

/**
 * The tasks a run measures. With a role, that role's tasks; a role without any runs the generic tasks
 * as that role (its prompts still shape the work). With a split, only that split's.
 *
 * @param {object} [o]
 * @param {string} [o.role]
 * @param {'train'|'holdout'} [o.split]
 * @param {string[]} [o.ids]
 * @returns {object[]}
 */
export function selectModelTasks({ role, split, ids } = {}) {
  let tasks = [...MODEL_SUITE];
  if (Array.isArray(ids) && ids.length) tasks = tasks.filter((t) => ids.includes(t.id));
  else tasks = tasks.filter((t) => !RETIRED_TASKS.includes(t.id));
  if (role) {
    const own = tasks.filter((t) => t.role === role);
    tasks = own.length ? own : tasks.filter((t) => t.role === 'generic').map((t) => ({ ...t, role }));
  }
  if (split) tasks = tasks.filter((t) => t.split === split);
  return tasks;
}

/** Whether a task is one of this suite's (it has deterministic checks), as opposed to a scripted fixture. */
export function isModelTask(task) {
  return task?.suite === 'model' && typeof task.verify === 'function' && typeof task.seed === 'function';
}
