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
export const MODEL_SUITE_VERSION = 3;

/**
 * Tasks every real-model run of the lab scored perfect (version 1's ten, through the lab's first
 * baselines of 2026-10-27 to 2026-10-30): they measure nothing any more. They stay defined, so records
 * that name them still read, and a run that names one by id still runs it; no other run selects them.
 */
export const RETIRED_TASKS = Object.freeze([
  'se-fix-failing-test', 'se-implement-from-spec', 'qa-reproduce-then-fix', 'devops-fix-service-config', 'devops-incident-summary',
  'data-revenue-summary', 'data-dedupe-customers', 'gen-action-items', 'gen-extract-contacts', 'sec-remove-hardcoded-key',
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
