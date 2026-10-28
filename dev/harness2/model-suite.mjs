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
export const MODEL_SUITE_VERSION = 2;

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
