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
export const MODEL_SUITE_VERSION = 1;

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
