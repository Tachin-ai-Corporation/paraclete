// Tests for dev/harness2/model-suite.mjs: every task starts unsolved (its checks do not all pass on the
// seeded workspace), a reference solution passes every check, and a wrong solution scores in between,
// so a task's score measures the work. Also the split and the task selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_SUITE, RETIRED_TASKS, SPLITS, isModelTask, selectModelTasks } from '../../../dev/harness2/model-suite.mjs';

const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text, 'utf8');
};

/** What a correct agent leaves in each task's workspace. */
const SOLUTIONS = {
  'se-fix-failing-test': (dir) => write(dir, 'src/range.mjs', fs.readFileSync(path.join(dir, 'src/range.mjs'), 'utf8').replace('i < end', 'i <= end')),
  'se-implement-from-spec': (dir) => {
    write(dir, 'src/slug.mjs', "export function slugify(text) {\n  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n  return s || 'untitled';\n}\n");
    write(dir, 'test/slug.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.mjs';\ntest('slugify', () => { assert.equal(slugify('Hello, World!'), 'hello-world'); });\n");
  },
  'qa-reproduce-then-fix': (dir) => {
    write(dir, 'test/combined.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parseDuration } from '../src/duration.mjs';\ntest('combined', () => { assert.equal(parseDuration('1h30m'), 5400); });\n");
    write(dir, 'src/duration.mjs', [
      'export function parseDuration(text) {',
      '  const s = String(text).trim();',
      "  if (!/^(\\d+[hms])+$/.test(s)) throw new Error(`not a duration: ${text}`);",
      '  let total = 0;',
      "  for (const [, n, u] of s.matchAll(/(\\d+)([hms])/g)) total += Number(n) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1);",
      '  return total;',
      '}',
      '',
    ].join('\n'));
  },
  'devops-fix-service-config': (dir) => write(dir, 'deploy/service.json', JSON.stringify({
    name: 'orders-api', image: 'registry.example.com/orders:1.4.2', port: 8080, replicas: 2, health: { path: '/healthz', interval_seconds: 10 },
  }, null, 2)),
  'devops-incident-summary': (dir) => write(dir, 'incident.md', '# Incident\n\nFirst error: 2026-03-02T04:11:09Z\n\ndb: 3\napi: 5\ncache: 1\n\nRoot cause: the database disk was full (ENOSPC).\n'),
  'data-revenue-summary': (dir) => write(dir, 'summary.json', JSON.stringify({ revenue_by_region: { North: 855.96, South: 733.23, East: 1440 }, top_product_by_units: 'Lamp' })),
  'data-dedupe-customers': (dir) => write(dir, 'data/customers.clean.csv', [
    'id,email,name,signup_date', 'c2,ben@example.com,Ben Okafor,2025-01-15', 'c3, Ana@Example.com ,Ana Lima,2024-11-20',
    'c4,chloe@example.com,Chloe Martin,2025-02-01', 'c6,dev@example.com,Dev Patel,2025-05-30', '',
  ].join('\n')),
  'gen-action-items': (dir) => write(dir, 'action-items.md', [
    '| Owner | Action | Due |', '|---|---|---|', '| Rafael | Write the pricing page copy | Wednesday 12 March |',
    '| Wen | Refresh staging data | Thursday 13 March |', '| Priya | Send the budget draft | Friday 14 March |',
    '| Sam | Book the venue | Monday 17 March |', '',
  ].join('\n')),
  'gen-extract-contacts': (dir) => write(dir, 'contacts.json', JSON.stringify([
    { name: 'Maria Gomez', email: 'maria.gomez@example.com' }, { name: 'Kenji Sato', email: 'kenji@example.com' },
    { name: 'Fatima Ali', email: 'fatima.ali@example.com' }, { name: 'Olu Bello', email: 'olu.bello@example.com' },
  ])),
  'sec-remove-hardcoded-key': (dir) => {
    write(dir, 'src/client.mjs', "export function authHeader() {\n  const key = process.env.PAYMENTS_API_KEY;\n  if (!key) throw new Error('PAYMENTS_API_KEY is not set');\n  return `Bearer ${key}`;\n}\n");
    write(dir, 'SECURITY.md', '# Security\n\nThe payments key now comes from PAYMENTS_API_KEY.\n');
  },  'se-lru-cache-ttl': (dir) => {
    write(dir, 'src/cache.mjs', [
      'export function createCache({ max, ttlMs, now = Date.now } = {}) {',
      '  const entries = new Map();',
      '  const sweep = () => { for (const [k, e] of entries) if (now() >= e.expires) entries.delete(k); };',
      '  const live = (key) => {',
      '    const e = entries.get(key);',
      '    if (e && now() >= e.expires) entries.delete(key);',
      '    return e && now() < e.expires ? e : undefined;',
      '  };',
      '  return {',
      '    set(key, value) {',
      '      sweep();',
      '      entries.delete(key);',
      '      if (entries.size >= max) entries.delete(entries.keys().next().value);',
      '      entries.set(key, { value, expires: now() + ttlMs });',
      '    },',
      '    get(key) {',
      '      const e = live(key);',
      '      if (!e) return undefined;',
      '      entries.delete(key);',
      '      entries.set(key, e);',
      '      return e.value;',
      '    },',
      '    peek(key) { return live(key)?.value; },',
      '    delete(key) { const had = Boolean(live(key)); entries.delete(key); return had; },',
      '    get size() { sweep(); return entries.size; },',
      '  };',
      '}',
      '',
    ].join('\n'));
    write(dir, 'test/cache.test.mjs', [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { createCache } from '../src/cache.mjs';",
      "test('createCache drops the least recently used entry', () => {",
      '  const c = createCache({ max: 1, ttlMs: 10, now: () => 0 });',
      "  c.set('a', 1);",
      "  c.set('b', 2);",
      "  assert.equal(c.get('a'), undefined);",
      '});',
      '',
    ].join('\n'));
  },
  'qa-find-seeded-bugs': (dir) => write(dir, 'test/money.test.mjs', [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { formatMoney, splitBill } from '../src/money.mjs';",
    "test('formatMoney', () => {",
    "  assert.equal(formatMoney(123456, 'USD'), '$1,234.56');",
    "  assert.equal(formatMoney(5, 'EUR'), '€0.05');",
    "  assert.equal(formatMoney(-150, 'GBP'), '-£1.50');",
    '});',
    "test('splitBill', () => {",
    '  assert.deepEqual(splitBill(1000, 3), [334, 333, 333]);',
    '});',
    '',
  ].join('\n')),
  'data-join-clean-orders': (dir) => write(dir, 'report.json', JSON.stringify({
    revenue_by_region: { North: 4250.1, South: 350.5, East: 195 }, completed_orders: 6, top_month: '2026-02',
  })),
  'devops-crashloop-diagnosis': (dir) => {
    const stack = JSON.parse(fs.readFileSync(path.join(dir, 'deploy/stack.json'), 'utf8'));
    stack.services.web.env.API_URL = 'http://api:9090';
    stack.services.api.env.DATABASE_URL = 'postgres://app@db:5432/orders';
    stack.services.api.depends_on = ['db'];
    write(dir, 'deploy/stack.json', JSON.stringify(stack, null, 2));
  },
  'sec-review-and-fix': (dir) => {
    write(dir, 'src/files.mjs', [
      "import { readFileSync } from 'node:fs';",
      "import { isAbsolute, relative, resolve, sep } from 'node:path';",
      'export function readUserFile(root, name) {',
      '  const base = resolve(root);',
      '  const rel = relative(base, resolve(base, String(name)));',
      "  if (isAbsolute(String(name)) || rel === '' || rel.split(sep)[0] === '..' || isAbsolute(rel)) throw new Error(`outside the root: ${name}`);",
      "  return readFileSync(resolve(base, rel), 'utf8');",
      '}',
      '',
    ].join('\n'));
    write(dir, 'src/query.mjs', [
      "const TABLES = new Set(['users', 'orders']);",
      'const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;',
      'export function buildQuery(table, filters) {',
      '  if (!TABLES.has(table)) throw new Error(`unknown table: ${table}`);',
      '  const entries = Object.entries(filters || {});',
      '  for (const [column] of entries) if (!IDENTIFIER.test(column)) throw new Error(`not a column: ${column}`);',
      "  const where = entries.map(([column], i) => `${column} = $${i + 1}`).join(' AND ');",
      "  return { text: `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}`, values: entries.map(([, value]) => value) };",
      '}',
      '',
    ].join('\n'));
    write(dir, 'test/security.test.mjs', [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { readUserFile } from '../src/files.mjs';",
      "import { buildQuery } from '../src/query.mjs';",
      "test('a name outside the root throws', () => { assert.throws(() => readUserFile('/srv/root', '../etc/passwd')); });",
      "test('a value is a parameter', () => { assert.deepEqual(buildQuery('users', { email: \"x'\" }), { text: 'SELECT * FROM users WHERE email = $1', values: [\"x'\"] }); });",
      '',
    ].join('\n'));
  },
  'gen-meeting-schedule': (dir) => write(dir, 'schedule.json', JSON.stringify([
    { title: 'Roadmap review', start_utc: '2026-01-16T14:00:00Z', attendees: ['Lena', 'Omar', 'Priya', 'Wen'] },
    { title: 'Design sync', start_utc: '2026-01-20T02:00:00Z', attendees: ['Lena', 'Wen'] },
  ])),  'se-csv-rfc4180': (dir) => {
    write(dir, 'src/csv.mjs', String.raw`export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  if (s === '') return [];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let fresh = true;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
    } else if (c === '"' && fresh) {
      quoted = true;
      fresh = false;
      startLine = line;
    } else if (c === ',') {
      row.push(field);
      field = '';
      fresh = true;
    } else if (c === '\r' && s[i + 1] === '\n') {
      // the LF ends the record
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fresh = true;
      line += 1;
    } else {
      field += c;
      fresh = false;
    }
  }
  if (quoted) throw new Error('unterminated quoted field at line ' + startLine);
  if (!s.endsWith('\n')) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
`);
    write(dir, 'test/csv-rfc.test.mjs', String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('quoted fields', () => {
  assert.deepEqual(parseCsv('a,"b,c"\r\n'), [['a', 'b,c']]);
});
`);
  },
  'qa-race-in-queue': (dir) => {
    write(dir, 'src/queue.mjs', String.raw`export async function runAll(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  let running = 0;
  let done = 0;
  let failed = false;
  return new Promise((resolve, reject) => {
    if (tasks.length === 0) {
      resolve([]);
      return;
    }
    const launch = () => {
      while (!failed && running < limit && next < tasks.length) {
        const index = next;
        next += 1;
        running += 1;
        tasks[index]().then((value) => {
          results[index] = value;
          running -= 1;
          done += 1;
          if (done === tasks.length) resolve(results);
          else launch();
        }, (err) => {
          failed = true;
          reject(err);
        });
      }
    };
    launch();
  });
}
`);
    write(dir, 'test/order.test.mjs', String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../src/queue.mjs';

const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test('results come in the order of the tasks', async () => {
  assert.deepEqual(await runAll([() => sleep(20, 'a'), () => sleep(1, 'b')], 2), ['a', 'b']);
});

test('at most limit tasks run at once', async () => {
  let now = 0;
  let max = 0;
  const t = async () => { now += 1; max = Math.max(max, now); await sleep(5); now -= 1; };
  await runAll([t, t, t, t], 2);
  assert.equal(max, 2);
});
`);
  },
  'devops-plan-order': (dir) => write(dir, 'plan.json', JSON.stringify({
    actions: [['update', 'db'], ['update', 'api'], ['create', 'frontend'], ['update', 'logs'], ['create', 'metrics'], ['create', 'subnet-c'],
      ['create', 'worker'], ['delete', 'old-queue-consumer'], ['delete', 'old-queue'], ['delete', 'old-worker']].map(([op, id]) => ({ op, id })),
    blocked: ['legacy-db', 'subnet-b'],
  }, null, 2)),
  'gen-constrained-brief': (dir) => write(dir, 'brief.md', [
    '# Card payments failed on 17 March',
    '',
    'On Tuesday 17 March 2026, card payments failed for part of the day. The incident began at 18:40 UTC and',
    'ended at 20:12 UTC. A configuration change shortened how long our payment service waits for the payment',
    'provider, so slower payments were cancelled and shown as declined. We rolled the change back, and the',
    "provider's queue then drained.",
    '',
    'What customers saw: 2,314 card payments failed and were shown as declined. Checkout was unavailable for',
    '17 minutes while the payments service restarted. The error rate of our API peaked at 4.2%. 312 customers',
    'received a duplicate order confirmation email after the rollback.',
    '',
    'What we are doing next:',
    '',
    '- Roll back automatically when the payment error rate passes 2% for five minutes.',
    '- Load-test the provider timeout path before each release.',
    '- Add a dashboard panel for payment-provider latency.',
    '',
  ].join('\n')),
  'se-perf-latest-per-id': (dir) => write(dir, 'src/events.mjs', String.raw`export function latestPerId(events) {
  const best = new Map();
  for (const e of events) {
    const b = best.get(e.id);
    if (!b || e.ts > b.ts || (e.ts === b.ts && e.version >= b.version)) best.set(e.id, e);
  }
  return [...best.values()];
}
`),
  'data-tz-months': (dir) => write(dir, 'monthly.json', JSON.stringify({ '2026-01': 190, '2026-02': 1355.5, '2026-03': -81.67, '2026-04': 54.49 })),
  'sec-token-verify': (dir) => {
    write(dir, 'src/token.mjs', String.raw`import { createHmac, timingSafeEqual } from 'node:crypto';

const LEEWAY = 30;

const json = (part) => {
  const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('not a JSON object');
  return value;
};

export function verifyToken(token, keys, now = Math.floor(Date.now() / 1000)) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('a token has three parts');
  const [h, p, s] = parts;
  const header = json(h);
  const payload = json(p);
  if (header.alg !== 'HS256') throw new Error('alg must be HS256');
  if (!Object.prototype.hasOwnProperty.call(keys, header.kid)) throw new Error('no such key');
  const expected = createHmac('sha256', keys[header.kid]).update(h + '.' + p).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('bad signature');
  if (payload.exp !== undefined && now >= payload.exp + LEEWAY) throw new Error('expired');
  if (payload.nbf !== undefined && now < payload.nbf - LEEWAY) throw new Error('not yet valid');
  return payload;
}
`);
    write(dir, 'test/token.test.mjs', String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyToken } from '../src/token.mjs';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('alg none is refused', () => {
  assert.throws(() => verifyToken(enc({ alg: 'none', kid: 'k1' }) + '.' + enc({}) + '.', { k1: 's' }));
});
`);
  },
  // A reading of the log of its own (not the task's): every line, its offset, the hour, health checks left out.
  'devops-log-forensics': (dir) => {
    const text = fs.readFileSync(path.join(dir, 'logs', 'access.log'), 'utf8');
    const from = Date.parse('2026-10-30T14:00:00Z');
    const to = Date.parse('2026-10-30T14:59:59Z');
    const errors = {};
    const bytes = {};
    const times = {};
    for (const l of text.trim().split('\n')) {
      const m = /^(\S+) - - \[(\d+)\/Oct\/2026:(\d\d):(\d\d):(\d\d) \+0(\d)00\] "GET (\S+) [^"]*" (\d+) (\d+) (\S+) upstream=(\S+)$/.exec(l);
      const at = Date.parse(`2026-10-${m[2]}T${m[3]}:${m[4]}:${m[5]}+0${m[6]}:00`);
      if (at < from || at > to) continue;
      const [ip, urlPath, status, size, secs, up] = [m[1], m[7], Number(m[8]), Number(m[9]), Number(m[10]), m[11]];
      errors[up] = (errors[up] || 0) + (status >= 500 ? 1 : 0);
      if (urlPath !== '/healthz') bytes[ip] = (bytes[ip] || 0) + size;
      times[urlPath] = times[urlPath] || [];
      times[urlPath].push(secs);
    }
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    write(dir, 'answers.json', JSON.stringify({
      errors_by_upstream: errors,
      top_clients: Object.entries(bytes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ip]) => ip),
      slowest_path: Object.entries(times).filter(([, xs]) => xs.length >= 20).sort((a, b) => mean(b[1]) - mean(a[1]))[0][0],
    }));
  },
};

function workspace(t, task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `h2-suite-${task.id}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  task.seed(dir);
  return dir;
}

test('every task has a solution here, a role, a split and checks', () => {
  assert.deepEqual(Object.keys(SOLUTIONS).sort(), MODEL_SUITE.map((t) => t.id).sort());
  for (const task of MODEL_SUITE) {
    assert.ok(SPLITS.includes(task.split), task.id);
    assert.ok(task.role && task.prompt.length > 40, task.id);
    assert.ok(isModelTask(task), task.id);
  }
  assert.ok(MODEL_SUITE.filter((t) => t.split === 'holdout').length >= 3, 'held-out tasks');
});

for (const task of MODEL_SUITE) {
  test(`${task.id}: unsolved fails a check, the reference solution passes them all`, (t) => {
    const before = task.verify(workspace(t, task));
    assert.equal(before.passed, false, `${task.id} starts solved: ${before.summary}`);
    assert.ok(before.score < 1);
    const dir = workspace(t, task);
    SOLUTIONS[task.id](dir);
    const after = task.verify(dir);
    assert.deepEqual([after.passed, after.score], [true, 1], `${task.id}: ${after.summary}`);
  });
}

test('a partial answer scores between none and all', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'devops-incident-summary');
  const dir = workspace(t, task);
  write(dir, 'incident.md', 'First error: 2026-03-02T04:11:09Z\ndb: 3\napi: 4\n');
  const res = task.verify(dir);
  assert.ok(res.score > 0 && res.score < 1, res.summary);
  assert.match(res.summary, /failed: api: 5/);
});

test("the harder tasks' traps: each answer that falls into one fails the check that names it", (t) => {
  const failed = (id, edit) => {
    const task = MODEL_SUITE.find((x) => x.id === id);
    const dir = workspace(t, task);
    SOLUTIONS[id](dir);
    edit(dir);
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  assert.deepEqual(failed('data-join-clean-orders', (dir) => write(dir, 'report.json', JSON.stringify({
    revenue_by_region: { North: 4250.1, South: 701, East: 195 }, completed_orders: 7, top_month: '2026-03',
  }))), ['South is 350.50', '6 completed orders', 'the top month is 2026-02'], 'a duplicate counted twice, and dates read month first');
  assert.deepEqual(failed('devops-crashloop-diagnosis', (dir) => {
    const stack = JSON.parse(fs.readFileSync(path.join(dir, 'deploy/stack.json'), 'utf8'));
    stack.services.api.port = 9000;
    stack.services.web.env.API_URL = 'http://api:9000';
    write(dir, 'deploy/stack.json', JSON.stringify(stack));
  }), ['every port is unchanged', 'web reaches api on 9090'], 'moving the port instead of the URL');
  assert.deepEqual(failed('sec-review-and-fix', (dir) => write(dir, 'src/files.mjs', [
    "import { readFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    'export function readUserFile(root, name) {',
    '  const full = resolve(root, name);',
    "  if (!full.startsWith(resolve(root))) throw new Error('outside');",
    "  return readFileSync(full, 'utf8');",
    '}',
    '',
  ].join('\n'))), ["a sibling directory whose name starts with root's throws"], 'a prefix test of the path');
  assert.deepEqual(failed('se-lru-cache-ttl', (dir) => {
    const src = fs.readFileSync(path.join(dir, 'src/cache.mjs'), 'utf8');
    write(dir, 'src/cache.mjs', src.replace('      sweep();\n', ''));
  }), ['an expired entry never takes a place'], 'an expired entry left to be evicted as the least recently used');
  assert.deepEqual(failed('gen-meeting-schedule', (dir) => write(dir, 'schedule.json', JSON.stringify([
    { title: 'Roadmap review', start_utc: '2026-01-15T14:00:00Z', attendees: ['Lena', 'Omar', 'Priya'] },
    { title: 'Design sync', start_utc: '2026-01-20T02:00:00Z', attendees: ['Lena', 'Wen'] },
  ]))), ['the roadmap review starts 2026-01-16T14:00:00Z', 'the roadmap review has Lena, Omar, Priya and Wen'], 'the move and the added attendee missed');
});

test('every seeded flaw of the money task is one the reference tests catch, and each changes the code', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'qa-find-seeded-bugs');
  const dir = workspace(t, task);
  const results = task.verify(dir).checks;
  assert.deepEqual(results.map((c) => [c.name, c.ok]).slice(0, 2), [['src/money.mjs is unchanged', true], ['the tests under test/ pass', false]]);
  assert.equal(results.filter((c) => c.name.startsWith('the tests catch ')).length, 5);
});

test("version 3's traps: each plausible wrong answer fails the checks that name it", (t) => {
  const failed = (id, edit) => {
    const task = MODEL_SUITE.find((x) => x.id === id);
    const dir = workspace(t, task);
    SOLUTIONS[id](dir);
    edit(dir);
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  // The plan in plain alphabetical order, ignoring what each action must follow.
  assert.deepEqual(failed('devops-plan-order', (dir) => write(dir, 'plan.json', JSON.stringify({
    actions: ['api', 'db', 'frontend', 'logs', 'metrics', 'subnet-c', 'worker'].map((id) => ({ op: ['api', 'db', 'logs'].includes(id) ? 'update' : 'create', id }))
      .concat(['old-queue', 'old-queue-consumer', 'old-worker'].map((id) => ({ op: 'delete', id }))),
    blocked: ['legacy-db', 'subnet-b'],
  }))), ['each action comes after what it must follow', 'the order is the one plan the rules allow']);
  // subnet-b deleted although the protected legacy-db still needs it.
  assert.deepEqual(failed('devops-plan-order', (dir) => {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
    plan.actions.push({ op: 'delete', id: 'subnet-b' });
    plan.blocked = ['legacy-db'];
    write(dir, 'plan.json', JSON.stringify(plan));
  }), ['the deletes are old-queue, old-queue-consumer and old-worker', 'legacy-db and subnet-b are blocked', 'the order is the one plan the rules allow']);
  // Months in UTC rather than New York time.
  assert.deepEqual(failed('data-tz-months', (dir) => write(dir, 'monthly.json', JSON.stringify({ '2026-01': 110, '2026-02': 1375.5, '2026-03': -36.67, '2026-04': 69.49 }))),
    ['2026-01 is 190.00', '2026-02 is 1355.50', '2026-03 is -81.67', '2026-04 is 54.49']);
  // New York as UTC-5 all year: the April charge just after midnight in daylight time lands in March.
  assert.deepEqual(failed('data-tz-months', (dir) => write(dir, 'monthly.json', JSON.stringify({ '2026-01': 190, '2026-02': 1355.5, '2026-03': 18.32, '2026-04': -45.5 }))),
    ['2026-03 is -81.67', '2026-04 is 54.49']);
  // Pacific Standard Time in March (it is daylight time from 8 March), and a name.
  assert.deepEqual(failed('gen-constrained-brief', (dir) => {
    const text = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8').replace('18:40 UTC', '19:40 UTC').replace('20:12 UTC', '21:12 UTC').replace('We rolled', 'Marco Ruiz rolled');
    write(dir, 'brief.md', text);
  }), ['it began at 18:40 UTC', 'it ended at 20:12 UTC', 'no employee is named']);
  // The action items in the order the report lists them, not by priority.
  assert.deepEqual(failed('gen-constrained-brief', (dir) => {
    const text = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8')
      .replace('- Roll back automatically', '- TMP').replace('- Add a dashboard panel', '- Roll back automatically').replace('- TMP', '- Add a dashboard panel');
    write(dir, 'brief.md', text);
  }), ['the bullets are the three highest-priority action items, highest first']);
  // The +0100 lines read as UTC.
  assert.ok(failed('devops-log-forensics', (dir) => {
    const log = fs.readFileSync(path.join(dir, 'logs', 'access.log'), 'utf8').replace(/\+0100\]/g, '+0000]');
    write(dir, 'logs/access.log', log);
    SOLUTIONS['devops-log-forensics'](dir);
  }).some((name) => /top clients|5xx/.test(name)), 'reading the edge server as UTC gets the hour wrong');
  // A verifier that refuses within the leeway, as the original does after exp.
  assert.deepEqual(failed('sec-token-verify', (dir) => {
    const src = fs.readFileSync(path.join(dir, 'src', 'token.mjs'), 'utf8').replace('now >= payload.exp + LEEWAY', 'now > payload.exp');
    write(dir, 'src/token.mjs', src);
  }), ['a token within 30 seconds after exp is accepted']);
});

test('a fix that edits the tests instead of the code fails the unchanged-test check', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'se-fix-failing-test');
  const dir = workspace(t, task);
  write(dir, 'test/range.test.mjs', "import { test } from 'node:test';\ntest('nothing', () => {});\n");
  const res = task.verify(dir);
  assert.equal(res.passed, false);
  assert.match(res.summary, /failed: test\/range\.test\.mjs is unchanged/);
});

test('selection by role and split; a role without tasks runs the generic ones as that role', () => {
  assert.deepEqual(selectModelTasks({ role: 'data-engineer' }).map((t) => t.id), ['data-join-clean-orders', 'data-tz-months']);
  assert.deepEqual(selectModelTasks({ role: 'data-engineer', split: 'holdout' }).map((t) => t.id), ['data-tz-months']);
  const legal = selectModelTasks({ role: 'legal-advisor' });
  assert.deepEqual(legal.map((t) => [t.id, t.role]), [['gen-meeting-schedule', 'legal-advisor'], ['gen-constrained-brief', 'legal-advisor']]);
  assert.equal(typeof legal[0].verify, 'function');
  assert.equal(selectModelTasks().length, MODEL_SUITE.length - RETIRED_TASKS.length, 'a retired task is never selected');
  assert.ok(RETIRED_TASKS.every((id) => MODEL_SUITE.some((t) => t.id === id)), 'and stays defined');
  assert.deepEqual(selectModelTasks({ ids: ['data-revenue-summary'] }).map((t) => t.id), ['data-revenue-summary'], 'unless a run names it');
  const live = selectModelTasks();
  assert.deepEqual([live.filter((t) => t.split === 'train').length, live.filter((t) => t.split === 'holdout').length], [7, 7]);
});
