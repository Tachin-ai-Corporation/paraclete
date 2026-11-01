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
export const MODEL_SUITE_VERSION = 4;

/**
 * Tasks every real-model run of the lab scored perfect: they measure nothing any more. Version 1's ten,
 * through the lab's first baselines of 2026-10-27 to 2026-10-30; and five of version 2's six, through
 * every baseline from 2026-10-28 to 2026-10-31 (the sixth, qa-find-seeded-bugs, still fails some runs).
 * They stay defined, so records that name them still read, and a run that names one by id still runs
 * it; no other run selects them.
 */
export const RETIRED_TASKS = Object.freeze([
  'se-fix-failing-test', 'se-implement-from-spec', 'qa-reproduce-then-fix', 'devops-fix-service-config', 'devops-incident-summary',
  'data-revenue-summary', 'data-dedupe-customers', 'gen-action-items', 'gen-extract-contacts', 'sec-remove-hardcoded-key',
  'se-lru-cache-ttl', 'data-join-clean-orders', 'devops-crashloop-diagnosis', 'sec-review-and-fix', 'gen-meeting-schedule',
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
