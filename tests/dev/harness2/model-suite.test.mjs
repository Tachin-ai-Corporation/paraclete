// Tests for dev/harness2/model-suite.mjs: every task starts unsolved (its checks do not all pass on the
// seeded workspace), a reference solution passes every check, and a wrong solution scores in between,
// so a task's score measures the work. Also the split and the task selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_SUITE, RETIRED_TASKS, SPLITS, isModelTask, selectModelTasks } from '../../../dev/harness2/model-suite.mjs';
import { contrastRatio, parseColor, toHex } from '../../../roles/designer/skills/accessibility-checks/contrast-check.mjs';

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
  // Version 4. The palette fixed with the designer role's own contrast-check arithmetic, each failing
  // color moved along its own hue and saturation until it passes everywhere it is used.
  'design-contrast-fix': (dir) => {
    const { color } = JSON.parse(fs.readFileSync(path.join(dir, 'design/tokens.json'), 'utf8'));
    const usage = JSON.parse(fs.readFileSync(path.join(dir, 'design/usage.json'), 'utf8'));
    const fixed = fixPalette(color, usage);
    write(dir, 'design/tokens.json', `${JSON.stringify({ color: fixed }, null, 2)}\n`);
    const ratio = (palette, u) => contrastRatio(parseColor(palette[u.foreground]), parseColor(palette[u.background])).toFixed(2);
    write(dir, 'design/contrast.md', ['| Pair | Kind | Before | After | Color |', '|---|---|---|---|---|',
      ...usage.map((u) => `| ${u.foreground} on ${u.background} | ${u.kind} | ${ratio(color, u)} | ${ratio(fixed, u)} | ${fixed[u.foreground]} |`)].join('\n'));
  },
  'fin-invoice-report': (dir) => write(dir, 'report.json', JSON.stringify(invoiceReport(dir))),
  'pm-tracker-update': (dir) => {
    write(dir, 'tracker.csv', `${TRACKER_AFTER.join('\n')}\n`);
    write(dir, 'flags.json', JSON.stringify({ overdue: ['A-8'], unowned: ['A-4', 'A-11'], stale: ['A-4', 'A-8'] }));
  },
  'ea-meeting-times': (dir) => write(dir, 'options.json', JSON.stringify(meetingTimes(dir))),
  // The dates worked out with Date arithmetic and the README's holidays, not written in.
  'legal-contract-dates': (dir) => {
    const day = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const months = (iso, n) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + n);
      return d.toISOString().slice(0, 10);
    };
    const holidays = new Set(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-12-25']);
    let claim = '2026-04-30';
    for (let n = 0; n < 10;) {
      claim = day(claim, 1);
      if (![0, 6].includes(new Date(`${claim}T00:00:00Z`).getUTCDay()) && !holidays.has(claim)) n += 1;
    }
    const renewal = months('2026-03-15', 24);
    write(dir, 'review.json', JSON.stringify({
      initial_term_ends: day(renewal, -1),
      non_renewal_notice_by: day(day(renewal, -1), -90),
      price_increase_notice_by: day(renewal, -60),
      implementation_plan_due: day('2026-03-15', 45),
      april_2026_credit_claim_by: claim,
      inconsistencies: [
        { sections: ['4.1', 'Schedule A'], issue: 'The fee is EUR 48,000 a year in 4.1 and EUR 45,000 in Schedule A.', quote: 'Customer shall pay the Subscription Fee of EUR 48,000 per year' },
        { sections: ['9.2'], issue: 'There is no Section 9.4.', quote: 'following the procedure in Section 9.4' },
        { sections: ['10.2'], issue: 'There is no Schedule B.', quote: 'sent to the addresses in Schedule B' },
        { sections: ['7.1'], issue: 'Customer Data is never defined; 1.4 defines Customer Materials.', quote: 'Supplier shall process Customer Data only' },
      ],
    }));
  },
  'web-moved-pages': (dir) => fixSite(dir),
};

/** A color as [hue, saturation, lightness], by another route than the suite's. */
function toHsl([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => v / 255);
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s * 100, l * 100];
}

/** CSS Color 4's hsl() to sRGB. */
function fromHsl(h, s, l) {
  const S = s / 100;
  const L = l / 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Every failing foreground moved to the nearest lightness, in steps of 0.01, that passes wherever it is used. */
function fixPalette(color, usage, { min = { text: 4.5, 'large-text': 3, 'non-text': 3 } } = {}) {
  const passes = (token, c) => usage.filter((u) => u.foreground === token).every((u) => contrastRatio(c, parseColor(color[u.background])) >= min[u.kind]);
  const fixed = { ...color };
  for (const token of new Set(usage.map((u) => u.foreground))) {
    if (passes(token, parseColor(color[token]))) continue;
    const [h, s, l] = toHsl(parseColor(color[token]));
    for (let step = 1; step <= 10000; step += 1) {
      const hit = [l - step / 100, l + step / 100].filter((L) => L >= 0 && L <= 100).map((L) => fromHsl(h, s, L)).find((c) => passes(token, c));
      if (hit) {
        fixed[token] = toHex(hit);
        break;
      }
    }
  }
  return fixed;
}

/** The September report from the export, read line by line; `wrong` makes one of the mistakes the task is built around. */
function invoiceReport(dir, wrong = {}) {
  const rows = fs.readFileSync(path.join(dir, 'billing/export.csv'), 'utf8').trim().split('\n').slice(1).map((line) => {
    const cut = line.indexOf(',"[');
    const [service, , , usageStart, , invoiceMonth, type, cost] = line.slice(0, cut).split(',');
    const credit = JSON.parse(line.slice(cut + 2, -1).replace(/""/g, '"')).reduce((a, c) => a + c.amount, 0);
    const month = wrong.byUsageMonth ? usageStart.slice(0, 7).replace('-', '') : invoiceMonth;
    return { service, month, type, cost: wrong.roundEachRow ? Math.round(Number(cost) * 100) / 100 : Number(cost), credit };
  });
  const totals = (month) => {
    const out = {};
    for (const r of rows.filter((x) => x.month === month && x.type === 'regular')) {
      out[r.service] = out[r.service] || { cost: 0, credits: 0 };
      out[r.service].cost += r.cost;
      out[r.service].credits += r.credit;
    }
    for (const s of Object.values(out)) s.net = s.cost + s.credits;
    return out;
  };
  const now = totals('202609');
  const before = totals('202608');
  const typed = (type) => rows.filter((r) => r.month === '202609' && r.type === type).reduce((a, r) => a + r.cost + r.credit, 0);
  const basis = (s) => (s ? (wrong.grossChange ? s.cost : s.net) : 0);
  const moved = (name) => basis(now[name]) - basis(before[name]);
  const budget = Object.fromEntries(fs.readFileSync(path.join(dir, 'billing/budget.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')).map(([k, v]) => [k, Number(v)]));
  const cents = (x) => Math.round(x * 100) / 100;
  return {
    currency: 'EUR',
    services: Object.fromEntries(Object.entries(now).map(([k, s]) => [k, { cost: cents(s.cost), credits: cents(s.credits), net: cents(s.net) }])),
    tax: cents(typed('tax')),
    adjustments: cents(typed('adjustment')),
    rounding: cents(typed('rounding_error')),
    total: cents(Object.values(now).reduce((a, s) => a + s.net, 0) + typed('tax') + typed('adjustment') + typed('rounding_error')),
    drivers: Object.keys(now).filter((k) => !before[k] || Math.abs(moved(k) / basis(before[k])) > 0.15).sort((a, b) => Math.abs(moved(b)) - Math.abs(moved(a))),
    over_budget: Object.keys(now).filter((k) => now[k].net > budget[k]).sort(),
  };
}

/** The tracker as the meeting of 4 November leaves it. */
const TRACKER_AFTER = Object.freeze([
  'ID,Action,Owner,Due,Status,Source,Opened,Updated,Note',
  'A-1,Send the kickoff deck to the steering group,Lena,2026-10-09,done,Weekly 2026-10-07,2026-10-07,2026-10-09,',
  'A-2,Prepare the launch checklist,Sam,2026-11-20,open,Weekly 2026-10-14,2026-10-14,2026-11-04,"Due moved from 2026-11-12 to fit the new launch date, as Sam agreed"',
  'A-3,Review the vendor contract,Priya,2026-11-02,done,Weekly 2026-10-21,2026-10-21,2026-11-04,Finished and signed off',
  'A-4,Update the onboarding guide,missing,2026-11-20,open,Weekly 2026-10-07,2026-10-07,2026-10-07,',
  'A-5,Run the load test on staging,Omar,2026-11-09,blocked,Weekly 2026-10-21,2026-10-21,2026-11-04,Waits for the staging environment to be rebuilt',
  'A-6,Build the analytics dashboard,Raj,2026-11-16,open,Weekly 2026-10-28,2026-10-28,2026-11-04,"Lena asked for 2026-11-09; Raj could not commit, so the due date stays"',
  'A-7,Run the customer survey,Lena,2026-11-30,dropped,Weekly 2026-10-14,2026-10-14,2026-11-04,Marketing is running its own survey',
  'A-8,Collect the security questionnaire answers,Wen,2026-10-30,open,Weekly 2026-10-14,2026-10-14,2026-10-14,',
  'A-9,Send the updated vendor list,Wen,2026-11-06,open,Weekly 2026-11-04,2026-11-04,2026-11-04,',
  'A-10,Draft the migration runbook,Priya,2026-11-13,open,Weekly 2026-11-04,2026-11-04,2026-11-04,',
  'A-11,Refresh the risk register,missing,missing,open,Weekly 2026-11-04,2026-11-04,2026-11-04,',
  'A-12,Book the venue for the launch party,Sam,2026-11-18,open,Weekly 2026-11-04,2026-11-04,2026-11-04,',
  'A-13,Check when the TLS certificate expires,Omar,2026-11-04,open,Weekly 2026-11-04,2026-11-04,2026-11-04,',
]);

/** A wall-clock reading of an instant in a zone, with Intl. */
function wallClock(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

/** The instant a local wall-clock time names in a zone. */
function instantOf(local, zone) {
  const naive = Date.parse(`${local.slice(0, 16)}:00Z`);
  const offsetAt = (t) => Date.parse(`${wallClock(t, zone).date}T${wallClock(t, zone).time}:00Z`) - t;
  return naive - offsetAt(naive - offsetAt(naive));
}

/**
 * The three earliest times by the meeting rules, from the calendars in `dir`, every time zone through
 * Intl; `wrong` makes one of the mistakes the task is built around.
 */
function meetingTimes(dir, wrong = {}) {
  const names = ['lena', 'omar', 'kenji'];
  const cals = Object.fromEntries(names.map((n) => [n, JSON.parse(fs.readFileSync(path.join(dir, 'calendars', `${n}.json`), 'utf8'))]));
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const busy = Object.fromEntries(names.map((n) => {
    const { zone, events } = cals[n];
    const at = (t) => (t.endsWith('Z') ? Date.parse(t) : instantOf(t, zone));
    const blocking = events.filter((e) => e.status !== 'cancelled' && (wrong.declinedBlocks || e.response !== 'declined') && e.show_as !== 'free');
    return [n, blocking.flatMap((e) => {
      if (e.date) return [[instantOf(`${e.date}T00:00`, zone), instantOf(`${nextDay(e.date)}T00:00`, zone)]];
      if (e.repeat === 'weekdays') {
        return days.filter((d) => d >= e.start.slice(0, 10)).map((d) => [instantOf(`${d}${e.start.slice(10)}`, zone), instantOf(`${d}${e.end.slice(10)}`, zone)]);
      }
      return [[at(e.start), at(e.end)]];
    })];
  }));
  const found = [];
  for (let t = Date.parse('2026-11-02T00:00:00Z'); t < Date.parse('2026-11-07T00:00:00Z') && found.length < 3; t += 30 * 60000) {
    const end = t + 3600000;
    const fits = names.every((n) => {
      const { zone, working_hours: hours } = cals[n];
      const [a, b] = [wallClock(t, zone), wallClock(end, zone)];
      return a.date === b.date && !['Sat', 'Sun'].includes(a.weekday) && a.time >= hours.start && b.time <= hours.end
        && busy[n].every(([s, e]) => e <= t || s >= end);
    });
    if (fits) {
      found.push({
        start_utc: new Date(t).toISOString().replace('.000Z', 'Z'),
        end_utc: new Date(end).toISOString().replace('.000Z', 'Z'),
        local: Object.fromEntries(names.map((n) => [n, `${wallClock(t, cals[n].zone).date} ${wallClock(t, cals[n].zone).time}`])),
      });
    }
  }
  return found;
}

/**
 * The site fixed by following each link through a Firebase Hosting resolver of its own: the redirects in
 * order, then cleanUrls, then files. `wrong` makes one of the mistakes the task is built around.
 */
function fixSite(dir, wrong = {}) {
  const hosting = JSON.parse(fs.readFileSync(path.join(dir, 'firebase.json'), 'utf8')).hosting;
  const files = new Set(listPublic(path.join(dir, 'public')));
  const pageOf = (file) => `/${file.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;
  const match = (source, p) => {
    const re = new RegExp(`^${source.split('/').map((seg) => (seg === '**' ? '.*' : seg.startsWith(':') ? `(?<${seg.slice(1)}>[^/]+)` : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
    const m = re.exec(p);
    return m ? m.groups || {} : null;
  };
  const step = (p) => {
    const rules = wrong.mostSpecificRule ? [...hosting.redirects].sort((a, b) => b.source.length - a.source.length) : hosting.redirects;
    for (const r of rules) {
      const m = match(r.source, p);
      if (m) return { to: r.destination.replace(/:(\w+)/g, (_, k) => m[k]) };
    }
    if (p.endsWith('.html')) return { to: p.slice(0, -'.html'.length).replace(/\/index$/, '/') };
    if (p.endsWith('/')) return files.has(`${p.slice(1)}index.html`) ? { page: p } : null;
    if (files.has(`${p.slice(1)}.html`)) return { page: p };
    if (files.has(`${p.slice(1)}/index.html`)) return { to: `${p}/` };
    return null;
  };
  const follow = (p) => {
    let at = p;
    for (let hops = 0; hops < 10; hops += 1) {
      const next = step(at);
      if (!next) return hops ? at : null;
      if (next.page) return next.page;
      if (wrong.oneHop && hops === 0) return next.to;
      at = next.to;
    }
    return null;
  };
  for (const file of [...files].filter((f) => f.endsWith('.html'))) {
    const base = `https://www.example.com${pageOf(file)}`;
    const html = fs.readFileSync(path.join(dir, 'public', file), 'utf8')
      .replace(/(<a\b[^>]*?\bhref=")([^"]*)(")/g, (all, a, href, b) => {
        const url = new URL(href, base);
        return url.origin === 'https://www.example.com' ? `${a}${follow(url.pathname) || href}${b}` : all;
      })
      .replace(/(<(?:link|img)\b[^>]*?\b(?:href|src)=")([^"]*)(")/g, (all, a, src, b) => {
        const at = new URL(src, base).pathname;
        return `${a}${files.has(at.slice(1)) ? at : `/${src.replace(/^(\.\.?\/)+/, '')}`}${b}`;
      });
    write(path.join(dir, 'public'), file, html);
  }
  const indexed = [...files].filter((f) => f.endsWith('.html') && f !== '404.html'
    && !/<meta name="robots" content="noindex">/.test(fs.readFileSync(path.join(dir, 'public', f), 'utf8')));
  write(dir, 'public/sitemap.xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...indexed.sort().map((f) => `  <url><loc>https://www.example.com${pageOf(f)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n'));
}

/** Every file under `dir`, relative, with forward slashes. */
function listPublic(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? listPublic(path.join(dir, e.name), base)
    : [path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/')]));
}

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

test("version 4's traps: each plausible wrong answer fails the checks that name it", (t) => {
  const failed = (id, edit) => {
    const task = MODEL_SUITE.find((x) => x.id === id);
    const dir = workspace(t, task);
    SOLUTIONS[id](dir);
    edit(dir);
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const tokens = (dir, edit) => {
    const file = path.join(dir, 'design/tokens.json');
    const palette = edit(JSON.parse(fs.readFileSync(file, 'utf8')).color, JSON.parse(fs.readFileSync(path.join(dir, 'design/usage.json'), 'utf8')));
    write(dir, 'design/tokens.json', JSON.stringify({ color: palette }));
    write(dir, 'design/contrast.md', Object.values(palette).join('\n'));
  };
  // The ratio rounded to two decimals: link's 4.4957 read as 4.50, and left alone.
  assert.deepEqual(failed('design-contrast-fix', (dir) => tokens(dir, (p) => ({ ...p, link: '#2077d6' }))),
    ['every pair in design/usage.json meets its level', 'link, at 4.4957:1, falls short of 4.5 and is darkened by the smallest change']);
  // text-muted fixed against white only, where it also sits on surface-alt.
  assert.deepEqual(failed('design-contrast-fix', (dir) => tokens(dir, (p, usage) => {
    const original = { ...p, 'text-muted': '#7c8591' };
    return { ...p, 'text-muted': fixPalette(original, usage.filter((u) => !(u.foreground === 'text-muted' && u.background === 'surface-alt')))['text-muted'] };
  })), ['every pair in design/usage.json meets its level', 'text-muted passes on surface-alt too, by the smallest change of lightness']);
  // Large text held to the 4.5:1 of normal text.
  assert.deepEqual(failed('design-contrast-fix', (dir) => tokens(dir, (p, usage) => ({ ...p, success: fixPalette({ ...p, success: '#1f9d63' }, usage, { min: { text: 4.5, 'large-text': 4.5, 'non-text': 3 } }).success }))),
    ['success, large text at 3.46:1, is as it was']);
  // A safe red, not the same red made darker.
  assert.deepEqual(failed('design-contrast-fix', (dir) => tokens(dir, (p) => ({ ...p, danger: '#c00000' }))),
    ['danger keeps its hue and saturation, by the smallest change of lightness']);

  const report = (wrong) => (dir) => write(dir, 'report.json', JSON.stringify(invoiceReport(dir, wrong)));
  // The usage dates instead of the invoice month.
  assert.deepEqual(failed('fin-invoice-report', report({ byUsageMonth: true })), [
    "Compute Engine nets 1407.15: two credits on a row, and 31 August's late usage",
    "Networking nets 108.50: 30 September's usage is on October's invoice",
    'the total is 2962.98',
    'over budget: Cloud Run, Compute Engine, Vertex AI',
  ]);
  // Each row rounded to the cent before it is summed: every service drifts, and Cloud Run, whose rows all
  // sit just above a cent, falls under its budget.
  const rounded = failed('fin-invoice-report', report({ roundEachRow: true }));
  for (const name of ['Cloud Run nets 25.45: rounded once, at the end', 'the total is 2962.98', 'over budget: Cloud Run, Compute Engine, Vertex AI']) {
    assert.ok(rounded.includes(name), name);
  }
  // The change judged on gross cost, so BigQuery's promotion credit is missed.
  assert.deepEqual(failed('fin-invoice-report', report({ grossChange: true })), ['the drivers are Vertex AI and Networking, the largest change first']);

  const tracker = (edit) => (dir) => write(dir, 'tracker.csv', `${edit([...TRACKER_AFTER]).join('\n')}\n`);
  // The unowned items sorted as text, A-11 before A-4.
  assert.deepEqual(failed('pm-tracker-update', (dir) => write(dir, 'flags.json', JSON.stringify({ overdue: ['A-8'], unowned: ['A-11', 'A-4'], stale: ['A-4', 'A-8'] }))),
    ["flags.json: the unowned items are A-4 and the risk register's"]);
  // A due date moved that its owner never agreed.
  assert.deepEqual(failed('pm-tracker-update', tracker((rows) => rows.map((r) => r.replace('Raj,2026-11-16', 'Raj,2026-11-09')))),
    ['A-6 is still due 2026-11-16, and open: its owner did not agree to 9 November']);
  // A remark that commits no one, taken as an item; and "the end of next week" read as its Sunday.
  assert.deepEqual(failed('pm-tracker-update', tracker((rows) => [...rows, 'A-14,Look at caching for the reports page,Omar,missing,open,Weekly 2026-11-04,2026-11-04,2026-11-04,'])),
    ['five new items, A-9 to A-13, open, from the meeting, and none for a remark that commits no one']);
  assert.deepEqual(failed('pm-tracker-update', tracker((rows) => rows.map((r) => r.replace('Priya,2026-11-13', 'Priya,2026-11-15')))),
    ['Priya drafts the runbook by the end of next week, 2026-11-13']);

  // A declined invitation taken as busy.
  assert.deepEqual(failed('ea-meeting-times', (dir) => write(dir, 'options.json', JSON.stringify(meetingTimes(dir, { declinedBlocks: true })))), [
    'options.json is a list of three times',
    'Tuesday 3 November, 16:30 UTC: Kenji declined the demo then',
    "each attendee's local start time is right",
  ]);
  // New York and Los Angeles still on daylight saving time, as they were in October.
  assert.deepEqual(failed('ea-meeting-times', (dir) => {
    for (const [name, zone] of [['lena', 'Etc/GMT+4'], ['kenji', 'Etc/GMT+7']]) {
      const file = path.join(dir, 'calendars', `${name}.json`);
      write(dir, `calendars/${name}.json`, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), zone }));
    }
    write(dir, 'options.json', JSON.stringify(meetingTimes(dir)));
  }), [
    'Tuesday 3 November, 16:30 UTC: Kenji declined the demo then',
    "Wednesday 4 November, 16:30 UTC: Kenji's focus time shows as free",
    "Friday 6 November, 16:30 UTC: Lena's sync is cancelled, and Kenji's panel starts as it ends",
    "none at 16:00 UTC: Lena's weekday 1:1 is at 11:00 in New York, 16:00 UTC once daylight saving ends on 1 November",
    "none on Monday or Thursday: Omar's partner call, given in UTC, and his day out of office",
    "each attendee's local start time is right",
  ]);

  const review = (edit) => (dir) => {
    const file = path.join(dir, 'review.json');
    write(dir, 'review.json', JSON.stringify(edit(JSON.parse(fs.readFileSync(file, 'utf8')))));
  };
  // 2028's 29 February forgotten; the holidays forgotten; a quote retyped with curly quotes.
  assert.deepEqual(failed('legal-contract-dates', review((r) => ({ ...r, non_renewal_notice_by: '2027-12-14' }))), ['notice of non-renewal by 2027-12-15: 2028 is a leap year']);
  assert.deepEqual(failed('legal-contract-dates', review((r) => ({ ...r, april_2026_credit_claim_by: '2026-05-14' }))),
    ["April's service credit claimed by 2026-05-18: ten Business Days skip 1 May and 14 May"]);
  assert.deepEqual(failed('legal-contract-dates', review((r) => ({ ...r, inconsistencies: r.inconsistencies.map((e, i) => (i === 3 ? { ...e, quote: 'Supplier shall process “Customer Data” only' } : e)) }))),
    ['every quote is copied exactly from contract.md']);

  // The most specific redirect taken for the first that matches.
  assert.deepEqual(failed('web-moved-pages', (dir) => {
    for (const f of listPublic(path.join(dir, 'public'))) if (f.endsWith('.html')) write(dir, `public/${f}`, fs.readFileSync(path.join(dir, 'public', f), 'utf8').replace(/href="\/help"/g, 'href="/developers/api"'));
  }), ['every link to one of our pages is its own root-relative address, reached with no redirect', 'API and Getting started go to /help: the first redirect that matches wins']);
  // One redirect followed where two chain.
  assert.deepEqual(failed('web-moved-pages', (dir) => {
    for (const f of listPublic(path.join(dir, 'public'))) if (f.endsWith('.html')) write(dir, `public/${f}`, fs.readFileSync(path.join(dir, 'public', f), 'utf8').replace(/href="\/company\/overview"/g, 'href="/company"'));
  }), ['every link to one of our pages is its own root-relative address, reached with no redirect', 'About goes straight to /company/overview, not through /company']);
  // A relative stylesheet left in a page that lives in a directory; and the 404 page in the sitemap.
  assert.deepEqual(failed('web-moved-pages', (dir) => write(dir, 'public/news/index.html', fs.readFileSync(path.join(dir, 'public/news/index.html'), 'utf8').replace('href="/css/site.css"', 'href="css/site.css"'))),
    ['every stylesheet and image is a file in public/']);
  assert.deepEqual(failed('web-moved-pages', (dir) => write(dir, 'public/sitemap.xml', fs.readFileSync(path.join(dir, 'public/sitemap.xml'), 'utf8').replace('</urlset>', '  <url><loc>https://www.example.com/404</loc></url>\n</urlset>'))),
    ['the sitemap leaves out the 404 page and the noindex draft, and lists nothing else']);
});

test('version 4: the reference times, dates and links are what an independent reading of the task gives', (t) => {
  const task = (id) => MODEL_SUITE.find((x) => x.id === id);
  const times = meetingTimes(workspace(t, task('ea-meeting-times')));
  assert.deepEqual(times.map((m) => [m.start_utc, m.local.lena, m.local.omar, m.local.kenji]), [
    ['2026-11-03T16:30:00Z', '2026-11-03 11:30', '2026-11-03 17:30', '2026-11-03 08:30'],
    ['2026-11-04T16:30:00Z', '2026-11-04 11:30', '2026-11-04 17:30', '2026-11-04 08:30'],
    ['2026-11-06T16:30:00Z', '2026-11-06 11:30', '2026-11-06 17:30', '2026-11-06 08:30'],
  ]);
  const site = workspace(t, task('web-moved-pages'));
  fixSite(site);
  const index = fs.readFileSync(path.join(site, 'public/index.html'), 'utf8');
  for (const href of ['/pricing', '/company/overview', '/help', '/news/2025/launch']) assert.ok(index.includes(`href="${href}"`), href);
  const palette = workspace(t, task('design-contrast-fix'));
  SOLUTIONS['design-contrast-fix'](palette);
  const fixed = JSON.parse(fs.readFileSync(path.join(palette, 'design/tokens.json'), 'utf8')).color;
  assert.deepEqual(Object.keys(fixed).filter((k) => fixed[k] !== JSON.parse(task('design-contrast-fix').files['design/tokens.json']).color[k]).sort(),
    ['border-input', 'danger', 'icon', 'link', 'text-muted', 'text-on-dark']);
});

test('selection by role and split; a role without tasks runs the generic ones as that role', () => {
  assert.deepEqual(selectModelTasks({ role: 'software-engineer' }).map((t) => t.id), ['se-csv-rfc4180', 'se-perf-latest-per-id']);
  assert.deepEqual(selectModelTasks({ role: 'software-engineer', split: 'holdout' }).map((t) => t.id), ['se-perf-latest-per-id']);
  assert.deepEqual(selectModelTasks({ role: 'legal-advisor' }).map((t) => [t.id, t.role]), [['legal-contract-dates', 'legal-advisor']]);
  const lab = selectModelTasks({ role: 'paraclete-h2' });
  assert.deepEqual(lab.map((t) => [t.id, t.role]), [['gen-constrained-brief', 'paraclete-h2']]);
  assert.equal(typeof lab[0].verify, 'function');
  assert.equal(selectModelTasks().length, MODEL_SUITE.length - RETIRED_TASKS.length, 'a retired task is never selected');
  assert.ok(RETIRED_TASKS.every((id) => MODEL_SUITE.some((t) => t.id === id)), 'and stays defined');
  assert.deepEqual(selectModelTasks({ ids: ['data-revenue-summary'] }).map((t) => t.id), ['data-revenue-summary'], 'unless a run names it');
  const live = selectModelTasks();
  assert.deepEqual([live.filter((t) => t.split === 'train').length, live.filter((t) => t.split === 'holdout').length], [8, 7]);
  assert.deepEqual([...new Set(live.map((t) => t.role))].sort(), ['data-engineer', 'designer', 'devops-engineer', 'executive-assistant', 'finance-analyst', 'generic',
    'legal-advisor', 'project-manager', 'qa-engineer', 'security-engineer', 'software-engineer', 'web-master'], 'every role a person can install has tasks of its own');
});
