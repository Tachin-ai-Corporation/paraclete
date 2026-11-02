// Tests for dev/harness2/model-suite.mjs: every task starts unsolved (its checks do not all pass on the
// seeded workspace), a reference solution passes every check, and a wrong solution scores in between,
// so a task's score measures the work. Also the split and the task selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  // Version 5. The plan scheduled a calendar day at a time, forwards and then backwards, by pmImpact.
  'pm-critical-path': (dir) => writePlanAnswer(dir, pmImpact(dir)),
  'design-token-build': (dir) => buildDesignTokens(dir),
  // Version 5. Each answer read from the handbook and its amendments by the README's rules, not written in.
  'gen-handbook-answers': (dir) => write(dir, 'answers.json', JSON.stringify(handbookAnswers(dir), null, 2)),
  // Version 5. The incidents by a reading of README.md of its own, every window found with Intl.
  'devops-alert-incidents': (dir) => write(dir, 'incidents.json', JSON.stringify(alertReport(dir), null, 2)),
  // Version 5. The trip found by a search of the timetable under README.md's rules.
  'ea-trip-itinerary': (dir) => write(dir, 'itinerary.json', JSON.stringify(tripItinerary(dir))),
  // Version 5. The periods by a reading of README.md of its own: the calendar found by looking for the
  // Saturday, each rate looked up day by day, the dollars added in floating point.
  'fin-fiscal-periods': (dir) => write(dir, 'periods.json', JSON.stringify(fiscalPeriods(dir))),
  'se-cli-flag-rename': (dir) => renameDryRun(dir),
};

/** Replaces `from` with `to` in a workspace file, failing when `from` is not there. */
function replaceIn(dir, rel, from, to) {
  const text = fs.readFileSync(path.join(dir, rel), 'utf8');
  assert.ok(text.includes(from), `${rel} has no ${JSON.stringify(from)}`);
  write(dir, rel, text.replace(from, () => to));
}

/**
 * The rename of `dry` to `dry-run` in the sync CLI, written from its README: every name an option answers
 * to in one table, every source read in full into the values it gives, the new name chosen within a
 * source before precedence runs across them, and the warnings gathered command line first.
 */
const RENAMED_OPTIONS_SRC = String.raw`// Resolves the command's options from its command line, its environment and its config file, as
// README.md's "Options" and "Renaming an option" say. It reads no file and prints nothing: run.mjs hands
// it the config file's contents and prints the warnings it returns.

/** A mistake in how the command was called: run.mjs prints it and exits 2. */
export class UsageError extends Error {}

/** Every option, by its current name. Each is a switch, off by default. */
export const OPTIONS = Object.freeze(['dry-run', 'verbose', 'skip-existing']);

/** Old names that still work until the next major release, each with the name that replaced it. */
export const RENAMED = Object.freeze({ dry: 'dry-run' });

const keyOf = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const variableOf = (name) => 'SYNC_' + name.toUpperCase().replace(/-/g, '_');

/** Every name an option answers to, as [name, the option's current name]. */
const NAMES = Object.freeze([...OPTIONS.map((name) => [name, name]), ...Object.entries(RENAMED)]);

/** A variable's text as a switch. */
function readBoolean(variable, text) {
  const word = text.toLowerCase();
  if (['1', 'true', 'yes'].includes(word)) return true;
  if (['0', 'false', 'no'].includes(word)) return false;
  throw new UsageError(variable + ' must be true or false');
}

/** The command line: each value it gives, in order, the command's own flags and its operands. */
function fromArgs(args) {
  const values = [];
  const flags = { help: false, printOptions: false };
  const operands = [];
  for (const arg of args) {
    if (arg === '--help') flags.help = true;
    else if (arg === '--print-options') flags.printOptions = true;
    else if (arg.startsWith('--')) {
      const off = arg.startsWith('--no-');
      const name = arg.slice(off ? '--no-'.length : '--'.length);
      const known = NAMES.find(([n]) => n === name);
      if (!known) throw new UsageError('unknown option ' + arg);
      const option = known[1];
      values.push({ option, old: name !== option, value: !off, spelling: arg, replacement: (off ? '--no-' : '--') + option });
    } else operands.push(arg);
  }
  return { values, flags, operands };
}

/** Each value the environment gives. An unset or empty variable gives none. */
function fromEnv(env) {
  const values = [];
  for (const [name, option] of NAMES) {
    const variable = variableOf(name);
    const text = env[variable];
    if (text === undefined || text === '') continue;
    values.push({ option, old: name !== option, value: readBoolean(variable, text), spelling: variable, replacement: variableOf(option) });
  }
  return values;
}

/** Each value the config file gives, from its contents. */
function fromConfig(config) {
  const values = [];
  for (const [key, value] of Object.entries(config)) {
    const known = NAMES.find(([n]) => keyOf(n) === key);
    if (!known) throw new UsageError('unknown key ' + key + ' in sync.config.json');
    if (typeof value !== 'boolean') throw new UsageError(key + ' in sync.config.json must be true or false');
    values.push({ option: known[1], old: known[0] !== known[1], value, spelling: key, replacement: keyOf(known[1]) });
  }
  return values;
}

/** What one source says of an option: the last value under its current name, or with none the last under an old one. */
function valueIn(values, option) {
  const mine = values.filter((v) => v.option === option);
  const current = mine.filter((v) => !v.old);
  return (current.length ? current : mine).at(-1)?.value;
}

/**
 * The resolved options (each under its current key), the command's own flags, its operands, and the
 * warning lines for the old spellings given.
 */
export function resolveOptions(args, env, config) {
  const cli = fromArgs(args);
  const environment = fromEnv(env);
  const file = fromConfig(config);
  const options = {};
  for (const option of OPTIONS) {
    options[keyOf(option)] = false;
    for (const values of [cli.values, environment, file]) {
      const value = valueIn(values, option);
      if (value !== undefined) {
        options[keyOf(option)] = value;
        break;
      }
    }
  }
  const warnings = [...new Set([...cli.values, ...environment, ...file].filter((v) => v.old).map((v) => 'warning: ' + v.spelling + ' is deprecated; use ' + v.replacement))];
  return { options, flags: cli.flags, operands: cli.operands, warnings };
}
`;

const RENAME_TEST = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP } from '../src/help.mjs';
import { resolveOptions } from '../src/options.mjs';

test('--dry-run turns the option on, under dryRun', () => {
  assert.equal(resolveOptions(['--dry-run'], {}, {}).options.dryRun, true);
});

test('--no-dry-run beats a config file that turns it on', () => {
  assert.equal(resolveOptions(['--no-dry-run'], {}, { dryRun: true }).options.dryRun, false);
});

test('SYNC_DRY_RUN and the config key dryRun set it', () => {
  assert.equal(resolveOptions([], { SYNC_DRY_RUN: 'true' }, {}).options.dryRun, true);
  assert.equal(resolveOptions([], {}, { dryRun: true }).options.dryRun, true);
});

test('the old --dry still turns it on, and warns', () => {
  const { options, warnings } = resolveOptions(['--dry'], {}, {});
  assert.equal(options.dryRun, true);
  assert.ok(warnings.includes('warning: --dry is deprecated; use --dry-run'));
});

test('the help shows --dry-run', () => {
  assert.match(HELP, /--dry-run, --no-dry-run/);
});
`;

/** The Deprecated and Fixed entries the rename adds to CHANGELOG.md's Unreleased section. */
const RENAME_DEPRECATED = '### Deprecated\n\n- The `dry` option is now `dry-run`: `--dry` is `--dry-run`, `--no-dry` is `--no-dry-run`, `SYNC_DRY` is `SYNC_DRY_RUN`, and the config key `dry` is `dryRun`. The old spellings still work, with a warning, until 2.0.0.\n\n';

/** What a correct agent leaves: the options rewritten, run.mjs, the help, the docs and the changelog edited, and tests added. */
function renameDryRun(dir) {
  write(dir, 'src/options.mjs', RENAMED_OPTIONS_SRC);
  replaceIn(dir, 'src/run.mjs', 'const { options, flags, operands } = resolved;', 'const { options, flags, operands, warnings } = resolved;\n  for (const line of warnings) stderr.write(`${line}\\n`);');
  replaceIn(dir, 'src/run.mjs', 'if (options.dry) {', 'if (options.dryRun) {');
  replaceIn(dir, 'src/help.mjs', '  --dry, --no-dry                       Copy nothing; print each file that would be copied (SYNC_DRY)',
    '  --dry-run, --no-dry-run               Copy nothing; print each file that would be copied (SYNC_DRY_RUN)');
  replaceIn(dir, 'docs/options.md', '| dry | `--dry`, `--no-dry` | `SYNC_DRY` | `dry` |', '| dry-run | `--dry-run`, `--no-dry-run` | `SYNC_DRY_RUN` | `dryRun` |');
  replaceIn(dir, 'CHANGELOG.md', '## 1.3.0 - 2026-09-14\n', `${RENAME_DEPRECATED}### Fixed\n\n- A SYNC_ variable set to \`0\`, \`false\` or \`no\` turns its option off, and one set to anything but those and \`1\`, \`true\` or \`yes\` is an error.\n\n## 1.3.0 - 2026-09-14\n`);
  write(dir, 'test/rename.test.mjs', RENAME_TEST);
}

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
 * Every trip README.md allows, from the timetable and airports in `dir`, best first: each local time read
 * through Intl in its airport's zone, each journey searched flight by flight. `wrong` makes one of the
 * mistakes the task is built around: `zones` reads airports in other zones; the other flags each drop or
 * bend one rule.
 */
function tripSearch(dir, wrong = {}) {
  const rows = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8').trim().split('\n').map((l) => l.trim().split(','));
  const records = (rel) => {
    const [head, ...body] = rows(rel);
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  };
  const airports = Object.fromEntries(records('airports.csv').map((a) => [a.code, a]));
  const zoneOf = (code) => wrong.zones?.[code] || airports[code].time_zone;
  const plusDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const flights = records('flights.csv').map((f) => {
    const [, time, days] = /^(\d\d:\d\d)([+-]\d)?$/.exec(f.arrives);
    const shift = Number(days || 0);
    const arrivalDate = wrong.ignoreDayOffset || (wrong.plusOnly && shift < 0) ? f.date : plusDays(f.date, shift);
    return {
      ...f, price: Number(f.price_usd), domestic: airports[f.from].country === airports[f.to].country,
      dep: instantOf(`${f.date}T${f.departs}`, zoneOf(f.from)), arr: instantOf(`${arrivalDate}T${time}`, zoneOf(f.to)),
    };
  });
  const hour = 3600000;
  const tokyo = ['HND', 'NRT'];
  const gapAfter = wrong.noLeaveGap ? 0 : 3 * hour;
  const buffer = wrong.noBuffer ? 0 : 12 * hour;
  const journeys = [
    { from: ['SFO'], to: tokyo, after: instantOf('2027-11-05T12:00', zoneOf('SFO')) + gapAfter, by: instantOf('2027-11-09T09:00', zoneOf('HND')) - buffer },
    { from: tokyo, to: ['SIN'], after: instantOf('2027-11-09T17:00', zoneOf('HND')) + gapAfter, by: instantOf('2027-11-11T09:00', zoneOf('SIN')) - buffer },
    { from: ['SIN'], to: ['SFO'], after: instantOf('2027-11-11T17:00', zoneOf('SIN')) + gapAfter, by: wrong.noDeadline ? Infinity : instantOf('2027-11-13T23:59', zoneOf('SFO')) },
  ];
  const redEye = (f) => !wrong.redEye && (wrong.sixInclusive ? f.departs <= '06:00' : f.departs < '06:00');
  const connects = (a, b) => {
    const gap = b.dep - a.arr;
    if (a.to === b.from || (wrong.tokyoOneAirport && tokyo.includes(a.to) && tokyo.includes(b.from))) {
      return gap >= (wrong.connection60 ? 60 : wrong.connection90 ? 90 : a.domestic ? 60 : 90) * 60000;
    }
    return tokyo.includes(a.to) && tokyo.includes(b.from) && gap >= 4 * hour;
  };
  const options = journeys.map((j) => {
    const found = [];
    const extend = (route) => {
      const last = route[route.length - 1];
      if (j.to.includes(last.to)) found.push(route);
      else if (route.length < (wrong.twoConnections ? 3 : 2)) for (const f of flights) if (connects(last, f)) extend([...route, f]);
    };
    for (const f of flights) if (j.from.includes(f.from)) extend([f]);
    return found.filter((r) => r[0].dep >= j.after && r[r.length - 1].arr <= j.by && !r.some(redEye) && r[r.length - 1].arr - r[0].dep <= 24 * hour);
  });
  const trips = options[0].flatMap((a) => options[1].flatMap((b) => options[2].map((c) => {
    const all = [...a, ...b, ...c];
    return { flights: all, price: all.reduce((s, f) => s + f.price, 0), connections: all.length - 3, home: c[c.length - 1].arr };
  })));
  const order = wrong.tieBreakReversed ? -1 : 1;
  return trips.sort((x, y) => x.price - y.price || order * (x.connections - y.connections) || order * (x.home - y.home));
}

/** The best trip of `tripSearch`, written as README.md's itinerary.json. */
function tripItinerary(dir, wrong = {}) {
  const [best] = tripSearch(dir, wrong);
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  return {
    flights: best.flights.map((f) => f.flight),
    total_usd: best.price,
    legs: best.flights.map((f) => ({ flight: f.flight, depart_utc: iso(f.dep), arrive_utc: iso(f.arr) })),
  };
}

/** The trip task's checks, by what each holds. */
const TRIP_CHECKS = Object.freeze({
  outbound: 'San Francisco to Tokyo is HB1103 then HB0021: 60 minutes at LAX are enough after a domestic flight',
  middle: 'Tokyo to Singapore is KT0253 alone: 06:00 is no red-eye, and at the same fare no connection beats one',
  back: "Singapore to San Francisco is MR0031 then HB0110: home at 23:10 on Saturday by its -1, before the same fare's 23:35",
  total: 'the total is $1501',
  departs: 'every depart_utc is right: California keeps PDT (UTC-7) until 7 November 2027, then PST (UTC-8)',
  arrives: 'every arrive_utc is right, on the day its +1, +2 or -1 gives',
  journeys: "the trip is three journeys in the commitments' order, each one flight or two that connect",
  leaves: 'every journey leaves at least 3 hours after the commitment before it ends',
  lands: 'the journeys to Tokyo and to Singapore land at least 12 hours before their meetings',
  redEye: 'no flight departs from 00:00 to 05:59 local time',
  connection: 'every connection at one airport has 60 minutes after a domestic flight, 90 after an international one',
  airports: 'a connection between HND and NRT has at least 4 hours',
  hours: 'every journey takes at most 24 hours, from its first departure to its last arrival',
  home: 'home in San Francisco by 23:59 on Saturday 13 November',
});

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

/**
 * The design tokens built by a reading of README.md of its own: the layers merged path by path, every
 * set's reachability closed before a cycle is named, brokenness spread until nothing changes, and each
 * block compared with what the blocks before it give. `wrong` makes one of the mistakes the task is
 * built around.
 */
function buildDesignTokens(dir, wrong = {}) {
  const flatten = (node, at, type, out) => {
    const groupType = node.$type ?? type;
    for (const [key, v] of Object.entries(node)) {
      if (key.startsWith('$') || v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      const here = at ? `${at}.${key}` : key;
      if (Object.hasOwn(v, '$value')) out[here] = { value: v.$value, type: v.$type ?? groupType, alpha: v.$extensions?.alpha };
      else flatten(v, here, groupType, out);
    }
    return out;
  };
  const layer = (name) => flatten(JSON.parse(fs.readFileSync(path.join(dir, 'tokens', `${name}.json`), 'utf8')), '', undefined, {});
  const layers = { base: layer('base'), light: layer('light'), dark: layer('dark'), ocean: layer('brand-ocean') };
  const merge = (...names) => {
    const out = {};
    for (const name of names) {
      for (const [p, t] of Object.entries(layers[name])) {
        out[p] = wrong.deepMerge && out[p] ? { ...out[p], ...Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)) } : t;
      }
    }
    return out;
  };
  const sets = { light: merge('base', 'light'), dark: merge('base', 'dark'), ocean: merge('base', 'light', 'ocean'), oceanDark: merge('base', 'dark', 'ocean') };
  const isAlias = (v) => typeof v === 'string' && v.length > 2 && v[0] === '{' && v.at(-1) === '}';
  const refs = (value) => [value].flat().flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : [v])).filter(isAlias).map((v) => v.slice(1, -1));

  /** Each token broken in `among`, with its reason. */
  const brokenIn = (among) => {
    const out = {};
    for (const set of among) {
      const reach = Object.fromEntries(Object.keys(set).map((p) => [p, new Set(refs(set[p].value).filter((q) => q in set))]));
      for (let grew = true; grew;) {
        grew = false;
        for (const r of Object.values(reach)) {
          for (const q of [...r]) for (const s of reach[q]) if (!r.has(s)) { r.add(s); grew = true; }
        }
      }
      for (const p of Object.keys(set)) if (reach[p].has(p)) out[p] = 'cycle';
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const set of among) {
        for (const p of Object.keys(set)) {
          if (out[p]) continue;
          const named = refs(set[p].value);
          if (named.some((q) => !(q in set) || out[q])) {
            out[p] = wrong.leadIntoCycleIsCycle && named.some((q) => out[q] === 'cycle') ? 'cycle' : 'missing';
            grew = true;
          }
        }
      }
    }
    return out;
  };
  const broken = brokenIn(Object.values(sets));
  const omitted = (setName, p) => (wrong.omitPerSet ? Boolean(brokenIn([sets[setName]])[p]) : Boolean(broken[p]));

  const follow = (set, p) => {
    const t = set[p];
    if (!isAlias(t.value)) return t;
    const r = follow(set, t.value.slice(1, -1));
    return { value: r.value, type: t.type ?? r.type, alpha: wrong.aliasDropsAlpha ? t.alpha : t.alpha ?? r.alpha };
  };
  const decimal = (x) => {
    if (!wrong.halfEven) return String(Number(x.toFixed(4)));
    const scaled = x * 10000;
    const floor = Math.floor(scaled);
    return String((scaled - floor === 0.5 ? floor + (floor % 2) : Math.round(scaled)) / 10000);
  };
  const cssOf = (set, { value, type, alpha }) => {
    const field = (v, as) => (isAlias(v) ? cssOf(set, wrong.aliasDropsAlpha ? { ...follow(set, v.slice(1, -1)), alpha: undefined } : follow(set, v.slice(1, -1))) : cssOf(set, { value: v, type: as }));
    switch (type) {
      case 'color': {
        const digits = value.slice(1).toLowerCase();
        const hex = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits;
        const rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
        return alpha !== undefined && (alpha < 1 || wrong.rgbaAtOne) ? `rgba(${rgb.join(', ')}, ${decimal(alpha)})` : `#${wrong.hexAsGiven ? digits : hex}`;
      }
      case 'dimension': {
        if (wrong.keepPx) return value;
        const n = Number.parseFloat(value);
        if (n === 0) return '0';
        return value.endsWith('px') ? `${decimal(n / 16)}rem` : value;
      }
      case 'shadow':
        return [value].flat().map((s) => `${field(s.offsetX, 'dimension')} ${field(s.offsetY, 'dimension')} ${field(s.blur, 'dimension')} ${field(s.spread, 'dimension')} ${field(s.color, 'color')}`).join(', ');
      case 'fontFamily':
        return [value].flat().map((name) => (name.includes(' ') ? `"${name}"` : name)).join(', ');
      case 'cubicBezier':
        return `cubic-bezier(${value.map(decimal).join(', ')})`;
      case 'number':
      case 'fontWeight':
        return decimal(value);
      default:
        return value;
    }
  };
  const nameOf = (p) => `--${p.split('.').map((part) => (wrong.camelNames ? part : part.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))).join('-')}`;
  /** A set's variables; with `resolveBeforeBrand`, a token the brand does not define keeps its value from the theme alone. */
  const variables = (setName) => {
    const theme = setName === 'oceanDark' ? 'dark' : 'light';
    const out = {};
    for (const p of Object.keys(sets[setName])) {
      if (omitted(setName, p)) continue;
      const from = wrong.resolveBeforeBrand && setName.startsWith('ocean') && !(p in layers.ocean) ? sets[theme] : sets[setName];
      out[nameOf(p)] = cssOf(from, follow(from, p));
    }
    return out;
  };
  const unlike = (all, before) => Object.fromEntries(Object.entries(all).filter(([n, v]) => before(n) !== v));
  const root = variables('light');
  const darkAll = variables('dark');
  const dark = wrong.darkListsAll ? darkAll : unlike(darkAll, (n) => root[n]);
  const ocean = unlike(variables('ocean'), (n) => root[n]);
  const both = unlike(variables('oceanDark'), wrong.bothAgainstDark ? (n) => darkAll[n] : (n) => ocean[n] ?? dark[n] ?? root[n]);
  const order = wrong.naturalSort ? (a, b) => a.localeCompare(b, 'en', { numeric: true }) : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const blocks = [[':root', root], ['[data-theme="dark"]', dark], ['[data-brand="ocean"]', ocean], ['[data-brand="ocean"][data-theme="dark"]', both]];
  write(dir, 'build/tokens.css', blocks.map(([selector, vars]) => `${selector} {\n${Object.keys(vars).sort(order).map((n) => `  ${n}: ${vars[n]};\n`).join('')}}\n`).join('\n'));
  write(dir, 'build/errors.json', `${JSON.stringify(Object.keys(broken).sort().map((token) => ({ token, reason: broken[token] })), null, 2)}\n`);
}

const DAY_MS = 86400000;

/**
 * The fiscal calendar of the fiscal-periods task's README.md, read afresh: `periodOf(ms)` gives the year
 * and period a UTC midnight falls in (null when a mistake leaves it out), `weeksOf(year)` the weeks of a
 * year. `wrong` makes one of the mistakes the task is built around.
 */
function fiscalCalendar(wrong = {}) {
  // The Saturday closest to 31 January is the one Saturday from 28 January to 3 February.
  const closest = (y) => {
    let ms = Date.UTC(y, 0, 28);
    while (new Date(ms).getUTCDay() !== 6) ms += DAY_MS;
    return ms;
  };
  const lastOfJanuary = (y) => {
    let ms = Date.UTC(y, 0, 31);
    while (new Date(ms).getUTCDay() !== 6) ms -= DAY_MS;
    return ms;
  };
  const end = (fy) => (wrong.februaryFirst ? Date.UTC(fy + 1, 0, 31) : wrong.lastSaturday ? lastOfJanuary(fy + 1) : closest(fy + 1));
  const start = (fy) => (wrong.februaryFirst ? Date.UTC(fy, 1, 1) : end(fy - 1) + DAY_MS);
  const weeksOf = (fy) => Math.floor((end(fy) - start(fy) + DAY_MS) / (7 * DAY_MS));
  const periodOf = (ms) => {
    let fy = new Date(ms).getUTCFullYear();
    if (ms < start(fy)) fy -= 1;
    const week = Math.floor((ms - start(fy)) / (7 * DAY_MS)) + 1;
    const lengths = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5];
    if (wrong.extraWeek === 'P1' && weeksOf(fy) === 53) lengths[0] = 5;
    let period = 1;
    let through = lengths[0];
    while (period < 12 && week > through) {
      through += lengths[period];
      period += 1;
    }
    if (week > through && wrong.extraWeek === 'P13') period = 13;
    if (week > through && wrong.extraWeek === 'dropped') return null;
    return { fy: wrong.endYearNames ? fy + 1 : fy, period };
  };
  return { periodOf, weeksOf };
}

/** The fiscal-periods task's periods.json from its files; `wrong` makes one of the mistakes the task is built around. */
function fiscalPeriods(dir, wrong = {}) {
  const table = (file) => fs.readFileSync(path.join(dir, file), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  const rates = new Map(table('rates.csv').map(([date, EUR, GBP]) => [Date.parse(date), { EUR, GBP }]));
  const rate = (currency, ms) => {
    if (currency === 'USD') return 1;
    if (wrong.emptyAsZero && rates.has(ms)) return Number(rates.get(ms)[currency]);
    if (wrong.noRateDropped && !rates.get(ms)?.[currency]) return null;
    for (let at = ms, n = 0; n < 60; at += wrong.nextRate ? DAY_MS : -DAY_MS, n += 1) {
      if (rates.get(at)?.[currency]) return Number(rates.get(at)[currency]);
    }
    throw new Error(`no ${currency} rate near ${new Date(ms).toISOString()}`);
  };
  const { periodOf, weeksOf } = fiscalCalendar(wrong);
  const lines = table('transactions.csv').map(([id, date, currency, amount, type, refundOf]) => ({ id, ms: Date.parse(date), currency, amount: Number(amount), type, refundOf }));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const totals = {};
  for (const l of lines) {
    const sale = l.type === 'refund' ? byId.get(l.refundOf) : l;
    const r = rate(l.currency, wrong.refundOwnRate ? l.ms : sale.ms);
    const at = periodOf(wrong.refundSalePeriod ? sale.ms : l.ms);
    if (r === null || at === null) continue;
    const usd = wrong.roundEachLine ? Math.round(l.amount * r * 100) / 100 : l.amount * r;
    const key = `FY${at.fy}-P${at.period}`;
    totals[key] = (totals[key] || 0) + (l.type === 'refund' ? -usd : usd);
  }
  const fys = [...new Set(Object.keys(totals).map((k) => Number(k.slice(2, 6))))];
  return {
    periods: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, (Math.sign(v) * Math.round(Math.abs(v) * 100)) / 100])),
    weeks: Object.fromEntries(fys.map((fy) => [`FY${fy}`, wrong.extraWeek === 'dropped' ? 52 : weeksOf(wrong.endYearNames ? fy - 1 : fy)])),
  };
}

/** Every file under `dir`, relative, with forward slashes. */
function listPublic(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? listPublic(path.join(dir, e.name), base)
    : [path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/')]));
}

/**
 * The customer portal plan in `dir` scheduled by a reading of README.md of its own, a calendar day at a
 * time: the holidays from calendar.md, a forward pass for the dates, a backward pass for the late dates,
 * then the critical paths and the slips, before and after the change request's two agreed changes.
 * `wrong` makes one of the mistakes the task is built around.
 */
function pmImpact(dir, wrong = {}) {
  const text = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const months = Object.fromEntries(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    .map((m, i) => [m, String(i + 1).padStart(2, '0')]));
  const holidays = new Set([...text('calendar.md').matchAll(/^- (?:Mon|Tues|Wednes|Thurs|Fri)day (\d+) (\w+) (\d{4})$/gm)]
    .map(([, d, m, y]) => `${y}-${months[m]}-${d.padStart(2, '0')}`));
  if (wrong.dayInLieu) holidays.add('2026-12-28');
  const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const working = (iso) => Boolean(wrong.calendarDays)
    || (![0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay()) && (Boolean(wrong.ignoreHolidays) || !holidays.has(iso)));
  // The working day n working days after `iso` (before it, for a negative n).
  const step = (iso, n) => {
    let day = iso;
    for (let k = 0; k < Math.abs(n);) {
      day = shift(day, Math.sign(n));
      if (working(day)) k += 1;
    }
    return day;
  };
  // The working days after `a`, up to and including `b`.
  const between = (a, b) => {
    let n = 0;
    for (let day = shift(a, 1); day <= b; day = shift(day, 1)) if (working(day)) n += 1;
    return n;
  };
  const [, ...lines] = text('plan.csv').trim().split('\n').map((l) => l.trim().split(','));
  const plan = lines.map(([id, , , duration, preds]) => ({
    id,
    d: Number(duration),
    preds: (preds ? preds.split(';') : []).map((p) => {
      const [, from, type, lag] = /^([TM]\d+)(SS|FF)?(?:\+(\d+))?$/.exec(p);
      return { from, type: type || 'FS', lag: Number(lag || 0) };
    }).filter((p) => !(wrong.ignoreFF && p.type === 'FF')),
  }));
  // notes/change-request.md agrees two changes: T10 takes 12 days, and T15 also waits for T20.
  const changed = plan.map((t) => (t.id === 'T10' ? { ...t, d: 12 }
    : t.id === 'T15' && !wrong.missedDependency ? { ...t, preds: [...t.preds, { from: 'T20', type: 'FS', lag: 0 }] } : t));

  const schedule = (tasks) => {
    const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const at = {};
    const place = (t) => {
      if (at[t.id]) return at[t.id];
      if (t.d === 0) {
        const last = t.preds.map((p) => place(by[p.from]).finish).sort().at(-1);
        const day = wrong.milestoneNextDay ? step(last, 1) : last;
        at[t.id] = { start: day, finish: day };
        return at[t.id];
      }
      let start = '2026-11-02';
      for (const p of t.preds) {
        const q = place(by[p.from]);
        const allows = p.type === 'SS' ? step(q.start, p.lag)
          : p.type === 'FF' ? step(step(q.finish, p.lag), -(t.d - 1))
            : step(wrong.fsSameDay ? q.finish : step(q.finish, 1), p.lag);
        if (allows > start) start = allows;
      }
      at[t.id] = { start, finish: step(start, t.d - 1) };
      return at[t.id];
    };
    tasks.forEach(place);
    const finish = Object.values(at).map((x) => x.finish).sort().at(-1);
    const late = {};
    const lateOf = (t) => {
      if (late[t.id]) return late[t.id];
      let lf = finish;
      for (const s of tasks) {
        for (const p of s.preds.filter((x) => x.from === t.id)) {
          const ls = lateOf(s);
          // The latest this task may finish for `s` to keep its late dates under the link's rule.
          const bound = p.type === 'SS' ? step(step(ls.start, -p.lag), Math.max(0, t.d - 1))
            : p.type === 'FF' ? step(ls.finish, -p.lag)
              : s.d === 0 ? (wrong.milestoneNextDay ? step(ls.start, -1) : ls.start)
                : step(ls.start, -(p.lag + (wrong.fsSameDay ? 0 : 1)));
          if (bound < lf) lf = bound;
        }
      }
      late[t.id] = { finish: lf, start: t.d === 0 ? lf : step(lf, -(t.d - 1)) };
      return late[t.id];
    };
    tasks.forEach(lateOf);
    const float = Object.fromEntries(tasks.map((t) => [t.id, between(at[t.id].finish, late[t.id].finish)]));
    const order = (ids) => (wrong.planOrder ? ids : [...ids].sort((a, b) => (at[a].start < at[b].start ? -1 : at[a].start > at[b].start ? 1 : 0)));
    return { at, finish, float, critical: order(tasks.filter((t) => float[t.id] === 0).map((t) => t.id)) };
  };

  const before = schedule(plan);
  const after = schedule(changed);
  const moved = (id) => (wrong.calendarSlip
    ? (Date.parse(after.at[id].finish) - Date.parse(before.at[id].finish)) / 86400000
    : between(before.at[id].finish, after.at[id].finish));
  return {
    before,
    after,
    schedule: plan.map((t) => [t.id, before.at[t.id].start, before.at[t.id].finish]),
    impact: {
      finish_before: before.finish,
      finish_after: after.finish,
      critical_before: before.critical,
      critical_after: after.critical,
      slipped_milestones: Object.fromEntries(plan.filter((t) => t.d === 0 && after.at[t.id].finish > before.at[t.id].finish).map((t) => [t.id, moved(t.id)])),
    },
  };
}

function writePlanAnswer(dir, { schedule, impact }) {
  write(dir, 'schedule.csv', `ID,Start,Finish\n${schedule.map((r) => r.join(',')).join('\n')}\n`);
  write(dir, 'impact.json', `${JSON.stringify(impact, null, 2)}\n`);
}

/** The day `n` days after an ISO date. */
const daysAfter = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The handbook in `dir`: each clause's own text, and each amendment's date, country, changes and revocations. */
function handbookOf(dir) {
  const clauses = {};
  for (const f of fs.readdirSync(path.join(dir, 'handbook')).filter((x) => x.endsWith('.md'))) {
    for (const m of fs.readFileSync(path.join(dir, 'handbook', f), 'utf8').matchAll(/^\*\*([A-Z]{3}-\d+\.\d+)\*\* (.+)$/gm)) clauses[m[1]] = m[2];
  }
  const amendments = fs.readdirSync(path.join(dir, 'handbook', 'amendments')).map((f) => {
    const text = fs.readFileSync(path.join(dir, 'handbook', 'amendments', f), 'utf8');
    const scope = /^Applies to: (.+)$/m.exec(text)[1];
    return {
      id: /^# Amendment (A-\d{4}-\d{2})/m.exec(text)[1],
      effective: /^Effective: (\d{4}-\d{2}-\d{2})$/m.exec(text)[1],
      country: scope === 'all countries' ? null : scope.replace(/ only$/, ''),
      changes: Object.fromEntries([...text.matchAll(/^- (?:Replaces|Adds) \*\*([A-Z]{3}-\d+\.\d+)\*\*(?: with)?: "(.+)"$/gm)].map((m) => [m[1], m[2]])),
      revokes: [...text.matchAll(/^- Revokes \*\*(A-\d{4}-\d{2})\*\*/gm)].map((m) => m[1]),
    };
  });
  return { clauses, amendments };
}

/**
 * A clause's text for `country` on `date` by the README's rules, with the amendments that decided it: the one
 * whose text applies, or the one that revoked the amendment that would. `wrong` makes one of the mistakes the
 * task is built around.
 */
function clauseOn({ clauses, amendments }, id, country, date, wrong = {}) {
  const inForce = (a) => (a.country === null || a.country === country)
    && (wrong.dayEarly ? a.effective <= daysAfter(date, 1) : wrong.dayLate ? a.effective < date : a.effective <= date);
  const revoker = (a) => amendments.find((r) => r.revokes.includes(a.id) && inForce(r));
  const rank = (a, b) => (wrong.byNumber ? b.id.localeCompare(a.id)
    : wrong.countryFirst ? (Number(Boolean(b.country)) - Number(Boolean(a.country))) || b.effective.localeCompare(a.effective)
      : b.effective.localeCompare(a.effective) || (Number(Boolean(b.country)) - Number(Boolean(a.country))));
  const touching = amendments.filter((a) => id in a.changes && inForce(a) && !(wrong.generalOnly && a.country)).sort(rank);
  const winner = touching.find((a) => wrong.revokedStays || !revoker(a));
  const by = winner ? [winner.id] : [];
  if (touching[0] && touching[0] !== winner) by.push(revoker(touching[0]).id);
  return { text: winner ? winner.changes[id] : clauses[id] ?? null, by };
}

const eurosIn = (text) => Number(/EUR (\d+(?:\.\d+)?)/.exec(text)[1]);
const countIn = (re, text) => Number(re.exec(text)[1]);

/** What each handbook question rests on, and how its answer follows from those clauses' text on its date. */
const HANDBOOK_READING = Object.freeze({
  Q1: { clauses: ['EXP-3.1'], answer: (text) => eurosIn(text('EXP-3.1')) },
  Q2: { clauses: ['ONC-1.1'], answer: (text) => eurosIn(text('ONC-1.1')) },
  Q3: { clauses: ['REM-1.1'], answer: (text) => countIn(/up to (\d+) days a week/, text('REM-1.1')) },
  Q4: { clauses: ['TRV-2.1'], answer: (text) => 7 + 40 / 60 > countIn(/more than (\d+) hours/, text('TRV-2.1')) },
  Q5: {
    clauses: ['TRV-4.1', 'TRV-4.2', 'EXP-2.1'],
    answer: (text, q, wrong) => {
      const days = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
      const rate = eurosIn(text('EXP-2.1'));
      const halves = /travel days, and each earns half/.test(text('TRV-4.1')) && !wrong.noHalfDay;
      const fed = text('TRV-4.2') !== null;
      return days.reduce((sum, day, i) => sum + (halves && (i === 0 || i === days.length - 1) ? rate / 2 : fed && day === '2026-09-17' ? 0 : rate), 0);
    },
  },
  Q6: { clauses: ['REM-2.1'], answer: (text) => countIn(/up to (\d+) working days/, text('REM-2.1')) },
  Q7: { clauses: [], answer: () => 'not covered' },
  Q8: { clauses: ['ONC-1.1'], answer: (text) => eurosIn(text('ONC-1.1')) },
  Q9: { clauses: ['EQP-2.1'], answer: (text) => eurosIn(text('EQP-2.1')) },
  Q10: { clauses: ['ONC-2.2', 'EXP-6.1'], answer: (text) => (/up to twice the taxi limit in EXP-6\.1/.test(text('ONC-2.2')) ? 2 : 1) * eurosIn(text('EXP-6.1')) },
  Q11: { clauses: ['EXP-4.2'], answer: (text, q) => daysAfter(q.date, countIn(/within (\d+) days after/, text('EXP-4.2'))) },
  Q12: { clauses: ['LEV-1.1'], answer: (text) => countIn(/(\d+) working days of paid annual leave/, text('LEV-1.1')) },
});

/** The near miss taken for an answer: the car's rate per km given for a bicycle. */
const HANDBOOK_ANALOGY = Object.freeze({ clauses: ['EXP-5.1'], answer: (text) => countIn(/EUR (\d+\.\d+) per km/, text('EXP-5.1')) });

/** Every handbook question answered from the files in `dir`; `wrong` makes one of the mistakes the task is built around. */
function handbookAnswers(dir, wrong = {}) {
  const book = handbookOf(dir);
  return JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8')).map((q) => {
    const reading = wrong.byAnalogy && q.id === 'Q7' ? HANDBOOK_ANALOGY : HANDBOOK_READING[q.id];
    const used = Object.fromEntries(reading.clauses.map((id) => [id, clauseOn(book, id, q.country, q.date, wrong)]));
    return {
      id: q.id,
      answer: reading.answer((id) => used[id].text, q, wrong),
      clauses: [...reading.clauses, ...new Set(Object.values(used).flatMap((u) => u.by))],
    };
  });
}

/** Every UTC instant, on the quarter hour within 16 hours of it, whose wall clock in `zone` reads `local` (YYYY-MM-DDTHH:MM). */
function instantsShowing(local, zone) {
  const naive = Date.parse(`${local}:00Z`);
  const hits = [];
  for (let k = -64; k <= 64; k += 1) {
    const w = wallClock(naive + k * 900000, zone);
    if (`${w.date}T${w.time}` === local) hits.push(naive + k * 900000);
  }
  return hits;
}

/** A zone's clock as one fixed offset all year, as a reading that forgets its daylight saving does. */
const FIXED_OFFSETS = Object.freeze({ berlinSummer: ['Europe/Berlin', 2], berlinWinter: ['Europe/Berlin', 1], newYorkStandard: ['America/New_York', -5] });

/**
 * The alert task's incidents, from the files in `dir`, by a reading of README.md of its own: each window's
 * local times found among the instants whose wall clock shows them, then the events walked in one pass
 * with a state per fingerprint. `wrong` makes one of the mistakes the task is built around.
 */
function alertReport(dir, wrong = {}) {
  const lines = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const { windows } = JSON.parse(fs.readFileSync(path.join(dir, 'maintenance.json'), 'utf8'));
  const utcOf = (local, zone) => {
    const fixed = Object.entries(FIXED_OFFSETS).find(([flag, [z]]) => wrong[flag] && z === zone);
    if (fixed) return Date.parse(`${local}:00Z`) - fixed[1][1] * 3600000;
    const hits = instantsShowing(local, zone);
    return wrong.secondOccurrence ? hits.at(-1) : hits[0];
  };
  const spans = windows.map((w) => ({ services: new Set(w.services), from: utcOf(w.start, w.zone), to: utcOf(w.end, w.zone) }));
  const held = (e, t) => spans.some((s) => s.services.has(e.service) && t >= s.from && (wrong.endInclusive ? t <= s.to : t < s.to));
  const stream = wrong.unsorted ? lines : [...lines].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  let suppressed = 0;
  const live = new Map();
  const all = [];
  for (const e of stream) {
    const t = Date.parse(e.ts);
    if (held(e, t)) {
      suppressed += 1;
      if (!wrong.suppressedExtend) continue;
    }
    const st = live.get(e.fingerprint);
    if (e.status === 'resolved') {
      if (st && (st.resolvedAt === null || wrong.resolveResets)) st.resolvedAt = t;
      continue;
    }
    const near = (from) => (wrong.gapExclusive ? t - from < 600000 : t - from <= 600000);
    if (st && st.resolvedAt === null && near(st.lastFiring)) {
      st.lastFiring = t;
    } else if (st && st.resolvedAt !== null && !wrong.flapEnds && near(st.resolvedAt) && !(wrong.gapBeforeFlap && !near(st.lastFiring))) {
      st.incident.flaps += 1;
      st.resolvedAt = null;
      st.lastFiring = t;
    } else {
      if (st) st.incident.end = st.resolvedAt ?? st.lastFiring;
      const incident = { fingerprint: e.fingerprint, service: e.service, start: t, end: null, flaps: 0, severities: [] };
      all.push(incident);
      live.set(e.fingerprint, { incident, lastFiring: t, resolvedAt: null });
    }
    live.get(e.fingerprint).incident.severities.push(e.severity);
  }
  for (const st of live.values()) if (st.resolvedAt !== null) st.incident.end = st.resolvedAt;
  const numbers = {};
  for (const i of [...all].sort((a, b) => a.start - b.start)) {
    numbers[i.fingerprint] = (numbers[i.fingerprint] || 0) + 1;
    i.id = `${i.fingerprint}#${numbers[i.fingerprint]}`;
    i.severity = wrong.firstSeverity ? i.severities[0] : i.severities.includes('critical') ? 'critical' : 'warning';
  }
  all.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
  const lastTs = Math.max(...lines.map((e) => Date.parse(e.ts)));
  const until = (i) => i.end ?? (wrong.openInLongest ? lastTs : null);
  const longest = all.filter((i) => until(i) !== null).reduce((b, i) => (!b || until(i) - i.start > until(b) - b.start ? i : b), null);
  const tally = (key) => all.reduce((o, i) => ({ ...o, [i[key]]: (o[i[key]] || 0) + 1 }), {});
  return {
    total: all.length,
    by_service: tally('service'),
    by_severity: { critical: all.filter((i) => i.severity === 'critical').length, warning: all.filter((i) => i.severity === 'warning').length },
    open: all.filter((i) => i.end === null).map((i) => i.id),
    flapping: all.filter((i) => i.flaps >= 3).map((i) => i.id),
    suppressed,
    longest: { id: longest.id, fingerprint: longest.fingerprint, start: iso(longest.start), end: iso(until(longest)), minutes: Math.round((until(longest) - longest.start) / 600) / 100 },
    incidents: all.map((i) => ({ id: i.id, fingerprint: i.fingerprint, service: i.service, severity: i.severity, start: iso(i.start), end: i.end === null ? null : iso(i.end), flaps: i.flaps })),
  };
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

test('version 5, design-token-build: each plausible wrong answer fails the checks that name it', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'design-token-build');
  const [blocks, kebab, sorted, hex, , px, shadow, , alpha, root, dark, oceanReach, ocean, both, errors, broken] = task.verify(workspace(t, task)).checks.map((c) => c.name);
  const failed = (edit) => {
    const dir = workspace(t, task);
    SOLUTIONS[task.id](dir);
    edit(dir);
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const built = (wrong) => (dir) => buildDesignTokens(dir, wrong);
  // Aliases resolved before the brand is merged: its new primitives never reach the tokens that name them.
  assert.deepEqual(failed(built({ resolveBeforeBrand: true })), [oceanReach, ocean, both]);
  // The dark block listing every variable, not only those that differ from :root.
  assert.deepEqual(failed(built({ darkListsAll: true })), [dark]);
  // The ocean dark block compared with the dark set alone: it keeps what the ocean block already gives,
  // and never undoes the ocean block's light values.
  assert.deepEqual(failed(built({ bothAgainstDark: true })), [both]);
  // Lengths left in px.
  assert.deepEqual(failed(built({ keepPx: true })), [px, shadow, root, dark, oceanReach, ocean]);
  // A half rounded to even, as Python's round() does: 0.03125rem becomes 0.0312rem.
  assert.deepEqual(failed(built({ halfEven: true })), [px, root]);
  // An alias written as the hex it names, its alpha lost: the dialog's backdrop and every shadow go opaque.
  assert.deepEqual(failed(built({ aliasDropsAlpha: true })), [shadow, alpha, root, dark]);
  // rgba() for every token with an alpha, 1 included.
  assert.deepEqual(failed(built({ rgbaAtOne: true })), [alpha, root, dark, ocean, both]);
  // #FFF kept short: dark's "#ffffff" then reads as a change.
  assert.deepEqual(failed(built({ hexAsGiven: true })), [hex, root, dark]);
  // Upper-case hex written as given.
  assert.deepEqual(failed((dir) => write(dir, 'build/tokens.css', fs.readFileSync(path.join(dir, 'build/tokens.css'), 'utf8').replace(/#2563eb/g, '#2563EB'))), [hex]);
  // The layers deep-merged, so dark's opaque overlay.hover keeps base's alpha.
  assert.deepEqual(failed(built({ deepMerge: true })), [dark, both]);
  // A broken token left out only of the sets where it breaks: the dark cycle's tokens stay in :root.
  assert.deepEqual(failed(built({ omitPerSet: true })), [root, ocean, broken]);
  // A token that leads into the cycle, without being on it, called a cycle.
  assert.deepEqual(failed(built({ leadIntoCycleIsCycle: true })), [errors]);
  // camelCase kept in the names; and the names sorted as numbers, --space-2 before --space-10.
  assert.deepEqual(failed(built({ camelNames: true })), [kebab]);
  assert.deepEqual(failed(built({ naturalSort: true })), [sorted]);
  // A media query for the dark theme instead of the attribute; an at-rule before the blocks.
  const css = (edit) => (dir) => write(dir, 'build/tokens.css', edit(fs.readFileSync(path.join(dir, 'build/tokens.css'), 'utf8')));
  assert.deepEqual(failed(css((text) => text.replace('[data-theme="dark"] {', '@media (prefers-color-scheme: dark) { :root {').replace(/(\n\[data-brand="ocean"\] \{)/, '}\n$1'))),
    [blocks, dark]);
  assert.deepEqual(failed(css((text) => `@charset "UTF-8";\n${text}`)), [blocks]);
  // What README.md leaves open fails nothing: comments, even ones that name an alias, single quotes, and spacing.
  assert.deepEqual(failed(css((text) => `/* Built from tokens/: {color.brand.600} is the brand. */\n${text}`
    .replace(/\[data-theme="dark"\]/g, "[data-theme='dark']").replace(/, /g, ',').replace(/;\n/g, ' ;\n'))), []);
});

test('version 5: the design tokens built are what a reading by hand of the token files gives', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'design-token-build');
  const dir = workspace(t, task);
  buildDesignTokens(dir);
  const css = fs.readFileSync(path.join(dir, 'build/tokens.css'), 'utf8');
  const blocks = Object.fromEntries([...css.matchAll(/^(\S[^{\n]*) \{\n([^}]*)\}/gm)]
    .map((m) => [m[1], Object.fromEntries([...m[2].matchAll(/^ {2}(--[a-z0-9-]+): (.*);$/gm)].map((d) => [d[1], d[2]]))]));
  const [root, dark, ocean, both] = [':root', '[data-theme="dark"]', '[data-brand="ocean"]', '[data-brand="ocean"][data-theme="dark"]'].map((s) => blocks[s]);
  // component.link.color names color.text.link (base), which names color.action.primary (light only), which
  // names color.brand.600, "#2563EB".
  assert.equal(root['--component-link-color'], '#2563eb');
  // 0.5px / 16 = 0.03125, a half, away from zero; 9999px / 16 = 624.9375; 24px / 16 = 1.5 through space.6.
  assert.deepEqual([root['--border-width-hairline'], root['--radius-full'], root['--component-card-padding'], root['--space-0']], ['0.0313rem', '624.9375rem', '1.5rem', '0']);
  // shadow.md: 0px, 4px, 8px and -2px, and light's color.shadow: gray.900, #0f172a = (15, 23, 42), at 0.12.
  // shadow.sm's offsetY names borderWidth.thin, 1px.
  assert.equal(root['--shadow-md'], '0 0.25rem 0.5rem -0.125rem rgba(15, 23, 42, 0.12)');
  assert.equal(root['--shadow-sm'], '0 0.0625rem 0.125rem 0 rgba(15, 23, 42, 0.12)');
  // dialog.backdrop has no alpha and takes overlay.scrim's 0.5; selection.bg names overlay.hover (brand.600,
  // #2563eb = (37, 99, 235), at 0.08) with its own 0.24; selection.border's own alpha is 1, so hex.
  assert.deepEqual([root['--component-dialog-backdrop'], root['--color-selection-bg'], root['--color-selection-border']],
    ['rgba(15, 23, 42, 0.5)', 'rgba(37, 99, 235, 0.24)', '#2563eb']);
  assert.deepEqual([root['--font-family-heading'], root['--font-family-mono']], ['"Source Serif 4", Georgia, serif', '"JetBrains Mono"']);
  // In dark, status.danger is "#DC2626", light's red.600 is #dc2626; action.primaryText is "#ffffff", light's
  // white is "#FFF". Neither differs as written. Dark's overlay.hover, gray.700 with no alpha, replaces base's
  // translucent one whole; bg.elevated is dark's own.
  assert.equal(dark['--color-status-danger'], undefined);
  assert.equal(dark['--color-action-primary-text'], undefined);
  assert.deepEqual([dark['--color-overlay-hover'], dark['--color-bg-elevated']], ['#334155', '#334155']);
  // The brand's radius.md, 10px, reaches component.button.radius through radius.control.
  assert.deepEqual([ocean['--component-button-radius'], ocean['--component-link-color']], ['0.625rem', '#0e7490']);
  // An element both ocean and dark: the ocean block gives action.primary #0e7490, but the ocean dark set has
  // dark's brand.500, #3b82f6; dark's bg.selected names brand.700, which the brand makes #155e75. brand.600 and
  // the heading font are what the ocean block gives already.
  assert.deepEqual([both['--color-action-primary'], both['--color-bg-selected'], both['--color-focus-ring']], ['#3b82f6', '#155e75', '#3b82f6']);
  assert.deepEqual([both['--color-brand-600'], both['--font-family-heading']], [undefined, undefined]);
  // Broken: dark's border.default and border.strong name each other; input.border names border.default;
  // legacy.highlight names a color.yellow no file has; text.accent names brand.highlight, which only the ocean
  // sets have; shadow.focus's color names brand.400, which no set has.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'build/errors.json'), 'utf8')), [
    { token: 'color.border.default', reason: 'cycle' },
    { token: 'color.border.strong', reason: 'cycle' },
    { token: 'color.legacy.highlight', reason: 'missing' },
    { token: 'color.text.accent', reason: 'missing' },
    { token: 'component.input.border', reason: 'missing' },
    { token: 'shadow.focus', reason: 'missing' },
  ]);
  assert.equal(root['--color-border-default'], undefined, 'it resolves in light, and is still left out');
  // The value checks look a variable up by its letters and digits only: every name stays apart that way.
  const names = [...new Set([root, dark, ocean, both].flatMap((b) => Object.keys(b)))];
  assert.equal(new Set(names.map((n) => n.replace(/[^a-z0-9]/g, ''))).size, names.length);
});

test("version 5, gen-handbook-answers: the reference answers are what the dated amendments give by the README's rules", (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'gen-handbook-answers');
  const dir = workspace(t, task);
  const amendment = (id) => /^A-\d{4}-\d{2}$/.test(id);
  assert.deepEqual(handbookAnswers(dir).map((a) => [a.id, a.answer, a.clauses.filter(amendment)]), [
    ['Q1', 150, []],
    ['Q2', 280, ['A-2026-05']],
    ['Q3', 2, ['A-2026-08']],
    ['Q4', true, ['A-2026-07']],
    ['Q5', 104, ['A-2026-06']],
    ['Q6', 15, ['A-2026-10']],
    ['Q7', 'not covered', []],
    ['Q8', 300, ['A-2026-03']],
    ['Q9', 250, ['A-2026-04']],
    ['Q10', 80, ['A-2026-01']],
    ['Q11', '2026-10-25', []],
    ['Q12', 30, ['A-2026-02']],
  ]);
  // Each date-sensitive question sits on its boundary: a day the other way, the clause reads otherwise.
  const book = handbookOf(dir);
  const on = (id, country, date) => clauseOn(book, id, country, date).text;
  assert.match(on('EXP-3.1', 'Ireland', '2026-07-01'), /EUR 170/, 'Q1: A-2026-06 from 1 July');
  assert.match(on('TRV-2.1', 'Germany', '2026-07-31'), /more than 8 hours/, 'Q4: A-2026-07 not before 1 August');
  assert.match(on('REM-1.1', 'Netherlands', '2026-08-31'), /up to 3 days/, 'Q3: the trial runs to 31 August');
  assert.match(on('EQP-2.1', 'Spain', '2026-09-01'), /EUR 200/, 'Q9: revoked from 1 September');
  assert.match(on('ONC-1.1', 'Germany', '2026-08-31'), /EUR 280/, 'Q8: A-2026-05 until A-2026-03 starts');
  assert.match(on('ONC-1.1', 'France', '2026-05-31'), /EUR 270/, "Q2: France's own text until a later general one");
  assert.match(on('REM-2.1', 'Spain', '2026-09-30'), /up to 20 working days/, 'Q6: neither of 1 October yet');
  assert.match(on('REM-2.1', 'Netherlands', '2026-10-12'), /up to 30 working days/, "Q6: Spain's text is Spain's alone");
  assert.match(on('EXP-4.2', 'Netherlands', '2026-10-01'), /within 45 days/, 'Q11: A-2026-09 from 1 October');
  assert.equal(on('TRV-4.2', 'Ireland', '2026-06-30'), null, 'Q5: TRV-4.2 exists only from A-2026-06');
  // Q7's near miss: no clause, as written or amended, gives a rate per km for a bicycle.
  const texts = [...Object.values(book.clauses), ...book.amendments.flatMap((a) => Object.values(a.changes))];
  assert.deepEqual(texts.filter((x) => /bicycle|bike/i.test(x) && /per km/.test(x)), []);
  assert.equal(new Date('2026-10-25T00:00:00Z').getUTCDay(), 0, 'Q11 falls on a Sunday, and stays there');
});

test('version 5, gen-handbook-answers: each plausible wrong answer fails the checks that name it', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'gen-handbook-answers');
  const failed = (edit) => {
    const dir = workspace(t, task);
    SOLUTIONS[task.id](dir);
    edit(dir);
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const wrongly = (wrong) => (dir) => write(dir, 'answers.json', JSON.stringify(handbookAnswers(dir, wrong)));
  const answer = (id, value, clauses) => (dir) => {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'));
    write(dir, 'answers.json', JSON.stringify(list.map((a) => (a.id === id ? { id, answer: value, clauses } : a))));
  };
  // An amendment applied from the day before it takes effect; and one only from the day after.
  assert.deepEqual(failed(wrongly({ dayEarly: true })), [
    'Q1: EUR 150 by EXP-3.1 alone: 30 June is the day before A-2026-06 takes effect',
    'Q9: EUR 250 by A-2026-04: on 31 August its revocation is not yet in force',
  ]);
  assert.deepEqual(failed(wrongly({ dayLate: true })), ['Q4: business class, yes, by A-2026-07: it takes effect on 1 August, the day of the booking']);
  // A revoked amendment still applied; or the right value, citing the revoked amendment beside its revoker.
  const revoked = 'Q3: 2 days a week by REM-1.1 and A-2026-08: the revoked trial no longer applies';
  assert.deepEqual(failed(wrongly({ revokedStays: true })), [revoked]);
  assert.deepEqual(failed(answer('Q3', 2, ['REM-1.1', 'A-2026-04', 'A-2026-08'])), [revoked]);
  // The general rule applied in a country with an exception of its own.
  assert.deepEqual(failed(wrongly({ generalOnly: true })), [
    "Q6: 15 days by A-2026-10: on the same Effective date, Spain's own amendment beats the general A-2026-09",
    'Q12: 30 days by A-2026-02: in France nothing later changes LEV-1.1',
  ]);
  // A country's amendment taken to beat a general one whatever their dates.
  assert.deepEqual(failed(wrongly({ countryFirst: true })), ["Q2: EUR 280 by A-2026-05: in France the later general amendment beats France's earlier A-2026-02"]);
  // The earlier of two amendments in force, because it was issued last; or the right value, citing the one it beat too.
  const latest = 'Q8: EUR 300 by A-2026-03: the latest Effective date wins, not the amendment issued last';
  assert.deepEqual(failed(wrongly({ byNumber: true })), [latest]);
  assert.deepEqual(failed(answer('Q8', 300, ['ONC-1.1', 'A-2026-03', 'A-2026-05'])), [latest]);
  // The near miss answered from the clause about a car.
  assert.deepEqual(failed(wrongly({ byAnalogy: true })), ['Q7: not covered, citing nothing: EXP-5.1 pays for a car, not a bicycle']);
  // The daily allowance without the half-day rule.
  assert.deepEqual(failed(wrongly({ noHalfDay: true })), ['Q5: EUR 104 by TRV-4.1, TRV-4.2 and EXP-2.1 as A-2026-06 sets them: travel days earn half, the day of free meals nothing']);
  // The deadline by the text in force when it falls, or moved off its Sunday.
  const deadline = "Q11: 2026-10-25, a Sunday, by EXP-4.2 alone: 30 days, as on 25 September; A-2026-09's 45 days start later";
  assert.deepEqual(failed(answer('Q11', '2026-11-09', ['EXP-4.2', 'A-2026-09'])), [deadline]);
  assert.deepEqual(failed(answer('Q11', '2026-10-26', ['EXP-4.2'])), [deadline]);
  // The taxi limit without the on-call clause that doubles it.
  assert.deepEqual(failed(answer('Q10', 40, ['EXP-6.1', 'A-2026-01'])), ['Q10: EUR 80 by ONC-2.2 and EXP-6.1 as A-2026-01 sets it: twice the taxi limit']);
  // An amount written as text; a clause the handbook does not have.
  assert.deepEqual(failed(answer('Q1', 'EUR 150', ['EXP-3.1'])), ['Q1: EUR 150 by EXP-3.1 alone: 30 June is the day before A-2026-06 takes effect']);
  assert.deepEqual(failed(answer('Q12', 30, ['LEV-1.1', 'LEV-1.4', 'A-2026-02'])), ['answers.json lists Q1 to Q12 once each, as { id, answer, clauses }, citing only IDs the handbook has']);
  // A clause the answer also passes through may be cited: TRV-3.1 sends the hotel limit to EXP-3.1.
  assert.deepEqual(failed(answer('Q1', 150, ['TRV-3.1', 'EXP-3.1'])), []);
});

test('version 5, devops-alert-incidents: each plausible wrong answer fails the checks that name it', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'devops-alert-incidents');
  const failed = (wrong) => {
    const dir = workspace(t, task);
    write(dir, 'incidents.json', JSON.stringify(alertReport(dir, wrong)));
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const total = "the total is 218, and by_service counts each service's incidents";
  const severity = "80 critical and 138 warning: an incident takes its highest firing's severity";
  const open = 'open: the 3 incidents still firing after the last event, one of them silent since 14:10';
  const flapping = 'flapping: the 8 incidents with 3 or more flaps';
  const suppressed = '108 events suppressed by the maintenance windows';
  const longest = "the longest is db.disk-usage's from 05:00 on 2026-10-25, 270.00 minutes: an open incident is not counted";
  const every = 'every incident has the id, start, end, severity and flaps the rules give';
  const gap = 'a firing exactly 10 minutes after the previous one joins its incident, and one 10 minutes 1 second after starts a new one';
  const flap = 'a firing at most 10 minutes after a resolve is a flap, counted from the resolve, not from the previous firing';
  const twice = 'a second resolved event in a row changes nothing: the first one ends the incident';
  const held = 'a suppressed event neither joins nor escalates an incident, and a window holds its start but not its end';
  const repeated = "db's window from 01:00 to 02:40 in Berlin ends at the first 02:40 of the night the clocks go back: 23:00 to 00:40 UTC";
  const across = "queue's window across the change runs from 00:30 summer time to 04:00 winter time: 22:30 to 03:00 UTC";
  const york = "auth's window is in New York daylight time, 10:00 to 11:00 UTC: US clocks go back only on 1 November";
  const order = 'events are taken in order of ts, not in the order of the file';

  // Berlin on summer time all night: queue's window ends at 02:00 UTC, an hour early.
  assert.deepEqual(failed({ berlinSummer: true }), [total, severity, every, across]);
  // Berlin on winter time all night: db's and queue's windows start an hour late.
  assert.deepEqual(failed({ berlinWinter: true }), [total, severity, suppressed, every, repeated, across]);
  // The repeated 02:40 read as its second occurrence, as converting with the offset at the naive time does.
  assert.deepEqual(failed({ secondOccurrence: true }), [total, severity, suppressed, every, repeated]);
  // New York taken off daylight time with Europe.
  assert.deepEqual(failed({ newYorkStandard: true }), [flapping, suppressed, every, york]);
  // A gap of exactly 10 minutes taken as too long, both between firings and after a resolve.
  assert.deepEqual(failed({ gapExclusive: true }), [total, severity, flapping, every, gap, flap]);
  // Every resolve taken as the end, so a flap starts a new incident.
  assert.deepEqual(failed({ flapEnds: true }), [total, severity, open, flapping, longest, every, flap]);
  // The gap from the previous firing applied first, even to an incident that is resolving.
  assert.deepEqual(failed({ gapBeforeFlap: true }), [total, severity, flapping, every, flap]);
  // A second resolve in a row taken as the new resolve, so a firing 10:30 after the first is a flap.
  assert.deepEqual(failed({ resolveResets: true }), [total, severity, every, twice]);
  // The file walked as it arrived, so a late firing after its resolve looks like a flap.
  assert.deepEqual(failed({ unsorted: true }), [open, every, order]);
  // Suppressed events counted, but still fed to the incidents.
  assert.deepEqual(failed({ suppressedExtend: true }), [total, severity, every, held, repeated, across, york]);
  // A window that holds its end too.
  assert.deepEqual(failed({ endInclusive: true }), [suppressed, every, held, across]);
  // The severity of an incident's first firing, not its highest.
  assert.deepEqual(failed({ firstSeverity: true }), [severity, every]);
  // An open incident counted for the longest, to the last event of the data.
  assert.deepEqual(failed({ openInLongest: true }), [longest]);
});

test('version 5, devops-alert-incidents: the boundary cases are what an independent reading of the files gives', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'devops-alert-incidents');
  const dir = workspace(t, task);
  const lines = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 2500 && lines.length <= 4000, `${lines.length} events`);
  assert.equal(new Set(lines.map((e) => `${e.fingerprint} ${e.ts}`)).size, lines.length, 'no two events of one fingerprint share a ts');
  assert.ok(lines.every((e) => e.service === e.fingerprint.split('.')[0] && ['warning', 'critical'].includes(e.severity) && ['firing', 'resolved'].includes(e.status)));

  // The file is in order of arrival: the scene's late events, and many others, come after later ones.
  const pos = (fingerprint, ts) => lines.findIndex((e) => e.fingerprint === fingerprint && e.ts === ts);
  assert.ok(pos('payments.queue-depth', '2026-10-25T16:06:00Z') > pos('payments.queue-depth', '2026-10-25T16:08:00Z'));
  assert.ok(pos('payments.queue-depth', '2026-10-25T17:00:00Z') > pos('payments.queue-depth', '2026-10-25T17:04:00Z'));
  assert.ok(lines.filter((e, i) => i > 0 && e.ts < lines[i - 1].ts).length > 20, 'late events besides the scene');

  // Firings 10:00 apart, then 10:01.
  const firings = lines.filter((e) => e.fingerprint === 'payments.provider-timeouts' && e.status === 'firing').map((e) => Date.parse(e.ts)).sort((a, b) => a - b);
  const gapBefore = (iso) => Date.parse(iso) - firings[firings.indexOf(Date.parse(iso)) - 1];
  assert.deepEqual([gapBefore('2026-10-23T09:14:00Z'), gapBefore('2026-10-23T09:24:01Z')], [600000, 601000]);

  // Every window's local times as UTC, by the instants whose wall clock shows them: db's 02:40 happens twice.
  const { windows } = JSON.parse(fs.readFileSync(path.join(dir, 'maintenance.json'), 'utf8'));
  const minute = (ms) => new Date(ms).toISOString().slice(0, 16);
  assert.deepEqual(Object.fromEntries(windows.map((w) => [w.id, [instantsShowing(w.start, w.zone).map(minute), instantsShowing(w.end, w.zone).map(minute)]])), {
    'mw-1': [['2026-10-23T20:00'], ['2026-10-23T21:30']],
    'mw-2': [['2026-10-24T22:30'], ['2026-10-25T03:00']],
    'mw-3': [['2026-10-24T23:00'], ['2026-10-25T00:40', '2026-10-25T01:40']],
    'mw-4': [['2026-10-26T10:00'], ['2026-10-26T11:00']],
    'mw-5': [['2026-10-26T02:00'], ['2026-10-26T03:30']],
    'mw-6': [['2026-10-26T08:00'], ['2026-10-26T09:30']],
  });
  // Events at a window's very start and very end.
  for (const [fingerprint, ts] of [['checkout.http-5xx', '2026-10-26T08:00:00Z'], ['db.replication-lag', '2026-10-24T23:00:00Z'], ['checkout.http-5xx', '2026-10-26T09:30:00Z'], ['queue.consumer-lag', '2026-10-25T03:00:00Z']]) {
    assert.ok(pos(fingerprint, ts) >= 0, `${fingerprint} at ${ts}`);
  }

  // Each scene's incidents, worked out by hand from the rules: [end, severity, flaps], or undefined for none.
  const report = alertReport(dir);
  const of = (fingerprint, start) => {
    const i = report.incidents.find((x) => x.fingerprint === fingerprint && x.start === start);
    return i && [i.end, i.severity, i.flaps];
  };
  const scenes = [
    ['payments.provider-timeouts', '2026-10-23T09:00:00Z', ['2026-10-23T09:14:00Z', 'warning', 0]],
    ['payments.provider-timeouts', '2026-10-23T09:14:00Z', undefined],
    ['payments.provider-timeouts', '2026-10-23T09:24:01Z', ['2026-10-23T09:31:00Z', 'warning', 0]],
    ['search.latency-p99', '2026-10-23T20:50:00Z', undefined],
    ['auth.login-failures', '2026-10-24T05:00:00Z', ['2026-10-24T05:06:00Z', 'warning', 0]],
    ['auth.login-failures', '2026-10-24T05:16:30Z', ['2026-10-24T05:23:00Z', 'warning', 0]],
    ['checkout.latency-p99', '2026-10-24T13:00:00Z', ['2026-10-24T13:45:00Z', 'critical', 3]],
    ['checkout.latency-p99', '2026-10-24T13:55:01Z', ['2026-10-24T14:01:00Z', 'warning', 0]],
    ['db.replication-lag', '2026-10-24T22:40:00Z', ['2026-10-24T22:58:00Z', 'warning', 0]],
    ['db.replication-lag', '2026-10-25T00:45:00Z', ['2026-10-25T01:41:00Z', 'critical', 0]],
    ['queue.consumer-lag', '2026-10-24T22:00:00Z', ['2026-10-24T22:20:00Z', 'warning', 0]],
    ['queue.consumer-lag', '2026-10-24T22:40:00Z', undefined],
    ['queue.consumer-lag', '2026-10-25T02:10:00Z', undefined],
    ['queue.consumer-lag', '2026-10-25T03:00:00Z', ['2026-10-25T03:14:00Z', 'warning', 0]],
    ['db.disk-usage', '2026-10-25T05:00:00Z', ['2026-10-25T09:30:00Z', 'critical', 2]],
    ['payments.queue-depth', '2026-10-25T16:00:00Z', ['2026-10-25T16:08:00Z', 'warning', 0]],
    ['payments.queue-depth', '2026-10-25T17:00:00Z', ['2026-10-25T17:10:00Z', 'critical', 0]],
    ['db.connections', '2026-10-26T01:20:00Z', ['2026-10-26T01:33:00Z', 'warning', 0]],
    ['db.connections', '2026-10-26T02:40:00Z', undefined],
    ['checkout.http-5xx', '2026-10-26T07:50:00Z', ['2026-10-26T07:58:00Z', 'warning', 0]],
    ['checkout.http-5xx', '2026-10-26T09:30:00Z', ['2026-10-26T09:38:00Z', 'warning', 0]],
    ['auth.login-failures', '2026-10-26T10:15:00Z', undefined],
    ['auth.login-failures', '2026-10-26T11:20:00Z', ['2026-10-26T11:35:00Z', 'warning', 0]],
    ['auth.token-errors', '2026-10-26T14:02:00Z', [null, 'warning', 0]],
    ['search.index-lag', '2026-10-26T16:00:00Z', [null, 'critical', 0]],
    ['checkout.latency-p99', '2026-10-26T23:30:00Z', [null, 'warning', 1]],
    ['queue.dead-letters', '2026-10-26T23:40:00Z', ['2026-10-26T23:55:30Z', 'warning', 0]],
  ];
  for (const [fingerprint, start, want] of scenes) assert.deepEqual(of(fingerprint, start), want, `${fingerprint} from ${start}`);
  // The open ones are the scenes' three; the resolve with no incident before it starts nothing; and the
  // longest is the four and a half hours of db.disk-usage, not the open search.index-lag's eight.
  assert.deepEqual(report.open.map((id) => id.split('#')[0]), ['auth.token-errors', 'search.index-lag', 'checkout.latency-p99']);
  assert.ok(report.incidents.find((i) => i.fingerprint === 'db.connections').start > '2026-10-23T00:01:30Z');
  assert.deepEqual([report.longest.fingerprint, report.longest.start, report.longest.end, report.longest.minutes], ['db.disk-usage', '2026-10-25T05:00:00Z', '2026-10-25T09:30:00Z', 270]);
});

test('version 5, ea-trip-itinerary: each plausible wrong answer fails the checks that name it', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'ea-trip-itinerary');
  assert.deepEqual(task.verify(workspace(t, task)).checks.map((c) => c.name), ['itinerary.json holds flights, total_usd and a leg for each flight', ...Object.values(TRIP_CHECKS)]);
  const failed = (wrong) => {
    const dir = workspace(t, task);
    write(dir, 'itinerary.json', JSON.stringify(tripItinerary(dir, wrong)));
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const c = TRIP_CHECKS;
  // California read as UTC-8 the whole trip: Friday's 24 h 15 min outbound through LAX looks like 23 h 15 min.
  assert.deepEqual(failed({ zones: { SFO: 'Etc/GMT+8', LAX: 'Etc/GMT+8' } }), [c.outbound, c.total, c.departs, c.arrives, c.hours]);
  // California read as UTC-7 the whole trip: the 24 h 25 min return through LAX looks like 23 h 25 min.
  assert.deepEqual(failed({ zones: { SFO: 'Etc/GMT+7', LAX: 'Etc/GMT+7' } }), [c.back, c.total, c.departs, c.arrives, c.hours]);
  // Every arrival read on its departure date: Monday's flight seems to land before the Tokyo meeting, a +1
  // shuttle seems to land home on Saturday, and the -1 return seems to land a day late.
  assert.deepEqual(failed({ ignoreDayOffset: true }), [c.outbound, c.back, c.total, c.arrives, c.lands, c.home]);
  // +1 and +2 read, -1 not: the two returns that land home the day before they leave Tokyo seem a day late.
  assert.deepEqual(failed({ plusOnly: true }), [c.back, c.total]);
  // A 75-minute connection after an international flight, taken for enough.
  assert.deepEqual(failed({ connection60: true }), [c.back, c.total, c.connection]);
  // HND and NRT taken for one airport: an HND arrival two hours before an NRT departure.
  assert.deepEqual(failed({ tokyoOneAirport: true }), [c.back, c.total, c.airports]);
  // The 01:30 red-eye from HND, the cheapest flight to Singapore.
  assert.deepEqual(failed({ redEye: true }), [c.middle, c.total, c.redEye]);
  // Landing before the meetings start, without the 12 hours.
  assert.deepEqual(failed({ noBuffer: true }), [c.outbound, c.middle, c.total, c.lands]);
  // Leaving Tokyo less than 3 hours after the meeting ends.
  assert.deepEqual(failed({ noLeaveGap: true }), [c.middle, c.total, c.leaves]);
  // Two connections on the way home.
  assert.deepEqual(failed({ twoConnections: true }), [c.back, c.total, c.journeys]);
  // The deadline missed by 46 minutes.
  assert.deepEqual(failed({ noDeadline: true }), [c.back, c.total, c.home]);
  // 90 minutes asked after the domestic hop to LAX too: a dearer outbound.
  assert.deepEqual(failed({ connection90: true }), [c.outbound, c.total]);
  // 06:00 counted as a red-eye, and ties broken the other way: the same totals, other flights.
  assert.deepEqual(failed({ sixInclusive: true }), [c.middle]);
  assert.deepEqual(failed({ tieBreakReversed: true }), [c.middle, c.back]);
  // A trip given out of order, or with a flight flights.csv does not have, holds no rule.
  const dir = workspace(t, task);
  const right = tripItinerary(dir);
  write(dir, 'itinerary.json', JSON.stringify({ ...right, flights: [...right.flights.slice(0, 4), 'HB0999'] }));
  const broken = task.verify(dir).checks.filter((x) => !x.ok).map((x) => x.name);
  assert.ok([c.journeys, c.leaves, c.lands, c.redEye, c.connection, c.airports, c.hours, c.home, c.back].every((name) => broken.includes(name)), broken.join(' | '));
});

test('version 5: the reference trip and its UTC times are what an independent reading of the task gives', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'ea-trip-itinerary');
  const dir = workspace(t, task);
  // Daylight saving in California ends at 02:00 on Sunday 7 November 2027, as README.md's dates assume.
  assert.equal(wallClock(Date.parse('2027-11-07T08:59:00Z'), 'America/Los_Angeles').time, '01:59');
  assert.equal(wallClock(Date.parse('2027-11-07T09:00:00Z'), 'America/Los_Angeles').time, '01:00');
  // One trip is best: the next costs more, or has more connections, or lands home later.
  const [best, next] = tripSearch(dir);
  assert.ok(best.price < next.price || best.connections < next.connections || best.home < next.home);
  // Each time written with its zone's offset on the day: PDT (-07:00) until 7 November, PST (-08:00)
  // after it, Japan +09:00 and Singapore +08:00 all year.
  const utc = (local) => new Date(local).toISOString().replace('.000Z', 'Z');
  assert.deepEqual(tripItinerary(dir), {
    flights: ['HB1103', 'HB0021', 'KT0253', 'MR0031', 'HB0110'],
    total_usd: 119 + 493 + 246 + 254 + 389,
    legs: [
      { flight: 'HB1103', depart_utc: utc('2027-11-06T08:50-07:00'), arrive_utc: utc('2027-11-06T10:15-07:00') },
      { flight: 'HB0021', depart_utc: utc('2027-11-06T11:15-07:00'), arrive_utc: utc('2027-11-07T14:55+09:00') },
      { flight: 'KT0253', depart_utc: utc('2027-11-10T06:00+09:00'), arrive_utc: utc('2027-11-10T12:20+08:00') },
      { flight: 'MR0031', depart_utc: utc('2027-11-13T21:00+08:00'), arrive_utc: utc('2027-11-14T04:50+09:00') },
      { flight: 'HB0110', depart_utc: utc('2027-11-14T06:30+09:00'), arrive_utc: utc('2027-11-13T23:10-08:00') },
    ],
  });
  assert.deepEqual(tripItinerary(dir).legs.map((l) => [l.depart_utc, l.arrive_utc]), [
    ['2027-11-06T15:50:00Z', '2027-11-06T17:15:00Z'], ['2027-11-06T18:15:00Z', '2027-11-07T05:55:00Z'], ['2027-11-09T21:00:00Z', '2027-11-10T04:20:00Z'],
    ['2027-11-13T13:00:00Z', '2027-11-13T19:50:00Z'], ['2027-11-13T21:30:00Z', '2027-11-14T07:10:00Z'],
  ]);
});

test('version 5, fin-fiscal-periods: each plausible wrong answer fails the checks that name it', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'fin-fiscal-periods');
  const names = task.verify(workspace(t, task)).checks.map((c) => c.name);
  assert.equal(names.length, 12);
  const [, keys, weeks, yearStart, week53, holiday, ownMarket, refundRate, refundPeriod, roundOnce, others, total] = names;
  const failed = (wrong) => {
    const dir = workspace(t, task);
    write(dir, 'periods.json', JSON.stringify(fiscalPeriods(dir, wrong)));
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const includes = (got, want, why) => want.forEach((name) => assert.ok(got.includes(name), `${why}: ${name}`));

  // The year from 1 February, as calendar months have it: every period's edges move, though each line is converted right.
  const february = failed({ februaryFirst: true });
  includes(february, [weeks, yearStart, week53, others], 'the year from 1 February');
  assert.ok(!february.includes(total), 'the conversion itself is right');
  // A year named by the calendar year in which it ends.
  includes(failed({ endYearNames: true }), [keys, weeks, yearStart], 'named by its last day');
  // The 53rd week as a P13 of its own, in P1, left out, or the year ended on January's last Saturday instead.
  assert.deepEqual(failed({ extraWeek: 'P13' }), [keys, week53]);
  assert.deepEqual(failed({ extraWeek: 'P1' }), [yearStart, week53, ownMarket, others]);
  assert.deepEqual(failed({ extraWeek: 'dropped' }), [weeks, week53, total]);
  includes(failed({ lastSaturday: true }), [weeks, week53, others], "January's last Saturday");
  // A line without a rate on its own date left out, or given the next date's rate.
  includes(failed({ noRateDropped: true }), [holiday, ownMarket, others, total], 'weekend and holiday lines dropped');
  includes(failed({ nextRate: true }), [holiday, ownMarket, others, total], "the next day's rate");
  // An empty cell read as a rate of 0, as Number('') is.
  assert.deepEqual(failed({ emptyAsZero: true }), [ownMarket, total]);
  // A refund at the rate of its own date; a refund booked in its sale's period.
  assert.deepEqual(failed({ refundOwnRate: true }), [refundRate, total]);
  assert.deepEqual(failed({ refundSalePeriod: true }), [refundPeriod]);
  // Each line rounded to the cent before the period's lines are added.
  includes(failed({ roundEachLine: true }), [roundOnce, others], 'each line rounded');
});

test('version 5, fin-fiscal-periods: the reference answer is what a fresh reading of the rules gives', (t) => {
  // Each year's last day by brute force: of every Saturday in January and February, the one nearest 31 January.
  const nearestSaturday = (y) => {
    let best = null;
    for (let ms = Date.UTC(y, 0, 1); ms < Date.UTC(y, 2, 1); ms += DAY_MS) {
      if (new Date(ms).getUTCDay() === 6 && (best === null || Math.abs(ms - Date.UTC(y, 0, 31)) < Math.abs(best - Date.UTC(y, 0, 31)))) best = ms;
    }
    return new Date(best).toISOString().slice(0, 10);
  };
  assert.deepEqual([2019, 2020, 2022, 2023, 2024, 2025, 2026].map(nearestSaturday),
    ['2019-02-02', '2020-02-01', '2022-01-29', '2023-01-28', '2024-02-03', '2025-02-01', '2026-01-31']);
  // So README.md's example holds, FY2023 runs from 29 January 2023 to 3 February 2024, and the solution's calendar agrees.
  const { periodOf, weeksOf } = fiscalCalendar();
  const key = (iso) => {
    const p = periodOf(Date.parse(iso));
    return `FY${p.fy}-P${p.period}`;
  };
  assert.deepEqual(['2019-02-03', '2020-02-01', '2020-02-02', '2023-01-28', '2023-01-29', '2023-12-23', '2023-12-24', '2024-02-03', '2024-02-04', '2025-02-01', '2025-02-02'].map(key),
    ['FY2019-P1', 'FY2019-P12', 'FY2020-P1', 'FY2022-P12', 'FY2023-P1', 'FY2023-P11', 'FY2023-P12', 'FY2023-P12', 'FY2024-P1', 'FY2024-P12', 'FY2025-P1']);
  assert.deepEqual([2019, 2022, 2023, 2024, 2025].map(weeksOf), [52, 52, 53, 52, 52]);

  const task = MODEL_SUITE.find((x) => x.id === 'fin-fiscal-periods');
  const rowsOf = (file) => task.files[file].trim().split('\n').slice(1).map((l) => l.split(','));
  const lines = rowsOf('transactions.csv').map(([id, date, currency, amount, type, refundOf]) => ({ id, date, currency, cents: Math.round(Number(amount) * 100), type, refundOf }));
  const rates = new Map(rowsOf('rates.csv').map(([date, EUR, GBP]) => [date, { EUR, GBP }]));
  const byId = new Map(lines.map((l) => [l.id, l]));
  assert.ok(lines.length > 1400 && lines.length < 1800, `${lines.length} lines`);

  // The data holds what the checks name: lines on each side of every year's first day and through the 53rd week,
  // euro and pound lines over Easter 2024 when neither market had a rate, and lines on a currency's own holiday only there.
  const day = (iso, n) => new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
  const on = (iso, currency) => lines.some((l) => l.date === iso && (!currency || l.currency === currency));
  for (const iso of ['2023-01-28', '2023-01-29', ...Array.from({ length: 8 }, (_, i) => day('2024-01-28', i)), '2025-02-01', '2025-02-02']) assert.ok(on(iso), iso);
  assert.ok(on('2024-03-29', 'EUR') && on('2024-03-30', 'GBP') && [0, 1, 2, 3].every((n) => !rates.has(day('2024-03-29', n))), 'Easter 2024');
  assert.deepEqual([rates.get('2023-08-28').GBP, rates.get('2024-05-01').EUR], ['', '']);
  const ownHoliday = lines.filter((l) => l.currency !== 'USD' && rates.get(l.date)?.[l.currency] === '');
  assert.deepEqual([...new Set(ownHoliday.map((l) => `${l.currency} ${l.date} ${key(l.date)}`))].sort(), ['EUR 2024-05-01 FY2024-P3', 'GBP 2023-08-28 FY2023-P8']);

  // Every refund's sale is in the file, earlier or the same day, in its currency. Only in FY2024-P9 is a euro or pound
  // refund on another day than its sale; only in FY2024-P12 and FY2025-P1 is a refund in a later period than its sale's.
  const refunds = lines.filter((l) => l.type === 'refund').map((l) => ({ ...l, sale: byId.get(l.refundOf) }));
  assert.ok(refunds.length > 50 && refunds.every((r) => r.sale?.type === 'sale' && r.sale.currency === r.currency && r.sale.date <= r.date && r.cents <= r.sale.cents));
  assert.deepEqual([...new Set(refunds.filter((r) => r.currency !== 'USD' && r.date !== r.sale.date).map((r) => key(r.date)))], ['FY2024-P9']);
  assert.deepEqual([...new Set(refunds.filter((r) => key(r.date) !== key(r.sale.date)).map((r) => `${key(r.sale.date)} to ${key(r.date)}`))].sort(),
    ['FY2024-P11 to FY2024-P12', 'FY2024-P12 to FY2025-P1']);

  // Each period's exact total, in millionths of a dollar: none sits within two millionths of a half cent, so how a half
  // is rounded never decides a total, and rounding each line first moves FY2024-P10 by three cents or more.
  const rate4 = (currency, iso) => {
    if (currency === 'USD') return 10000;
    for (let d = iso; ; d = day(d, -1)) if (rates.get(d)?.[currency]) return Math.round(Number(rates.get(d)[currency]) * 10000);
  };
  const exact = {};
  const perLine = {};
  for (const l of lines) {
    const sign = l.type === 'refund' ? -1 : 1;
    const micro = l.cents * rate4(l.currency, l.type === 'refund' ? byId.get(l.refundOf).date : l.date);
    exact[key(l.date)] = (exact[key(l.date)] || 0) + sign * micro;
    perLine[key(l.date)] = (perLine[key(l.date)] || 0) + sign * Math.round(micro / 10000);
  }
  const cents = (m) => Math.round(m / 10000);
  for (const [k, m] of Object.entries(exact)) assert.ok(m > 0 && Math.abs((m % 10000) - 5000) > 2, `${k}: ${m}`);
  assert.ok(Math.abs(perLine['FY2024-P10'] - cents(exact['FY2024-P10'])) >= 3, 'rounding each line first drifts FY2024-P10');

  // And the reference solution, in floating point, gives exactly these totals, and these years' weeks.
  const dir = workspace(t, task);
  SOLUTIONS['fin-fiscal-periods'](dir);
  const answer = JSON.parse(fs.readFileSync(path.join(dir, 'periods.json'), 'utf8'));
  assert.deepEqual(Object.keys(answer.periods).sort(), Object.keys(exact).sort());
  for (const [k, m] of Object.entries(exact)) assert.equal(answer.periods[k], cents(m) / 100, k);
  assert.deepEqual(answer.weeks, { FY2022: 52, FY2023: 53, FY2024: 52, FY2025: 52 });
});

/** The rename task's checks, by what each tests. */
const RENAME_CHECKS = Object.freeze({
  on: '--dry-run turns it on, without a warning, and the resolved options call it dryRun, not dry',
  order: 'the command line beats the environment, which beats the config file',
  values: 'SYNC_DRY_RUN is on for 1, true and yes and off for 0, false and no, in any case',
  bad: 'a variable that is not true or false exits 2, naming it, even one another value overrides',
  oldFlags: '--dry and --no-dry still work on the command line, each with exactly one warning',
  oldEnvAndKey: 'SYNC_DRY and the config key dry still work, each with exactly one warning',
  newWins: 'within one source the new name beats the old; between sources the command line, environment, config file order holds',
  warnings: "each old spelling warns once, even overridden: the command line's in order, then the environment's, then the config file's",
  copies: '--dry-run copies nothing, and without it every file is copied',
  help: '--help shows --dry-run and --no-dry-run, and no old spelling',
  docs: 'docs/options.md documents --dry-run, --no-dry-run, SYNC_DRY_RUN and dryRun',
  changelog: "CHANGELOG.md's Unreleased section has a Deprecated entry naming each old spelling and its replacement, in backticks",
});

test('version 5, se-cli-flag-rename: the seeded CLI passes its own tests, reads SYNC_VERBOSE=0 as on, and passes no rename check', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'se-cli-flag-rename');
  const dir = workspace(t, task);
  assert.deepEqual(task.verify(dir).checks.filter((c) => c.ok).map((c) => c.name), ['node --test passes']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SYNC_/i.test(k)));
  const res = spawnSync(process.execPath, ['bin/sync.mjs', '--print-options'], { cwd: dir, encoding: 'utf8', env: { ...env, SYNC_VERBOSE: '0' } });
  assert.equal(JSON.parse(res.stdout).verbose, true, 'the latent bug the rename exposes: any non-empty value is on');
});

test('version 5, se-cli-flag-rename: each plausible wrong answer fails the checks that name it', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'se-cli-flag-rename');
  const failed = (edits) => {
    const dir = workspace(t, task);
    SOLUTIONS['se-cli-flag-rename'](dir);
    for (const [rel, from, to] of edits) replaceIn(dir, rel, from, to);
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const C = RENAME_CHECKS;
  const sources = 'for (const values of [cli.values, environment, file]) {';
  // The environment taken before the command line, for the renamed option.
  assert.deepEqual(failed([['src/options.mjs', sources, "for (const values of option === 'dry-run' ? [environment, cli.values, file] : [cli.values, environment, file]) {"]]),
    [C.order, C.newWins]);
  // Each warning printed twice: once when its spelling is read, once when the options are resolved.
  assert.deepEqual(failed([['src/run.mjs', 'for (const line of warnings)', 'for (const line of [...warnings, ...warnings])']]), [C.oldFlags, C.oldEnvAndKey, C.warnings]);
  // The old name preferred to the new within a source.
  assert.deepEqual(failed([['src/options.mjs', 'const current = mine.filter((v) => !v.old);', 'const current = mine.filter((v) => v.old);']]), [C.newWins]);
  // The seeded reader kept: any non-empty value is on, so 0 is on and a bad value no error.
  assert.deepEqual(failed([['src/options.mjs', '  const word = text.toLowerCase();', '  return Boolean(text);\n  const word = text.toLowerCase();']]), [C.values, C.bad]);
  // The help still lists the old flags, as deprecated ones.
  assert.deepEqual(failed([['src/help.mjs', '  --verbose, --no-verbose', '  --dry, --no-dry                       Deprecated: use --dry-run, --no-dry-run\n  --verbose, --no-verbose']]), [C.help]);
  // run.mjs still reads the old key, so a dry run copies everything.
  assert.deepEqual(failed([['src/run.mjs', 'if (options.dryRun) {', 'if (options.dry) {']]), [C.copies]);
  // The warnings in the order the code reads the sources, the config file first.
  assert.deepEqual(failed([['src/options.mjs', '[...cli.values, ...environment, ...file].filter((v) => v.old)', '[...file, ...environment, ...cli.values].filter((v) => v.old)']]), [C.warnings]);
  // Only the value that counts is read, so an overridden bad one is no error.
  assert.deepEqual(failed([['src/options.mjs', 'value: readBoolean(variable, text),', 'get value() { return readBoolean(variable, text); },']]), [C.bad]);
  // The new name preferred to the old across sources, not only within one.
  assert.deepEqual(failed([['src/options.mjs', sources, 'for (const values of [cli.values, environment, file].map((s) => s.filter((v) => !v.old)).concat([cli.values, environment, file])) {']]),
    [C.oldFlags, C.newWins]);
  // The old key kept in the resolved options beside the new one.
  assert.deepEqual(failed([['src/options.mjs', '  return { options, flags: cli.flags', '  options.dry = options.dryRun;\n  return { options, flags: cli.flags']]), [C.on]);
  // The negation left as it was in the docs.
  assert.deepEqual(failed([['docs/options.md', '`--no-dry-run`', '`--no-dry`']]), [C.docs]);
  // The deprecation recorded under the last release instead of Unreleased.
  assert.deepEqual(failed([['CHANGELOG.md', RENAME_DEPRECATED, ''], ['CHANGELOG.md', '## 1.3.0 - 2026-09-14\n\n', `## 1.3.0 - 2026-09-14\n\n${RENAME_DEPRECATED}`]]), [C.changelog]);
});

test('selection by role and split; a role without tasks runs the generic ones as that role', () => {
  assert.deepEqual(selectModelTasks({ role: 'software-engineer' }).map((t) => t.id), ['se-perf-latest-per-id', 'se-cli-flag-rename']);
  assert.deepEqual(selectModelTasks({ role: 'software-engineer', split: 'holdout' }).map((t) => t.id), ['se-perf-latest-per-id']);
  assert.deepEqual(selectModelTasks({ role: 'legal-advisor' }).map((t) => [t.id, t.role]), [['legal-contract-dates', 'legal-advisor']]);
  const lab = selectModelTasks({ role: 'paraclete-h2' });
  assert.deepEqual(lab.map((t) => [t.id, t.role]), [['gen-handbook-answers', 'paraclete-h2']]);
  assert.equal(typeof lab[0].verify, 'function');
  assert.equal(selectModelTasks().length, MODEL_SUITE.length - RETIRED_TASKS.length, 'a retired task is never selected');
  assert.ok(RETIRED_TASKS.every((id) => MODEL_SUITE.some((t) => t.id === id)), 'and stays defined');
  assert.deepEqual(selectModelTasks({ ids: ['data-revenue-summary'] }).map((t) => t.id), ['data-revenue-summary'], 'unless a run names it');
  const live = selectModelTasks();
  assert.deepEqual([live.filter((t) => t.split === 'train').length, live.filter((t) => t.split === 'holdout').length], [8, 7]);
  assert.deepEqual([...new Set(live.map((t) => t.role))].sort(), ['data-engineer', 'designer', 'devops-engineer', 'executive-assistant', 'finance-analyst', 'generic',
    'legal-advisor', 'project-manager', 'qa-engineer', 'security-engineer', 'software-engineer', 'web-master'], 'every role a person can install has tasks of its own');
});

test('version 5, pm-critical-path: each plausible wrong answer fails the checks that name it', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'pm-critical-path');
  const names = task.verify(workspace(t, task)).checks.map((c) => c.name);
  const named = (...starts) => starts.map((s) => {
    const name = names.find((n) => n.startsWith(s));
    assert.ok(name, `no check starts with ${s}`);
    return name;
  });
  const failed = (wrong, edit = (answer) => answer) => {
    const dir = workspace(t, task);
    writePlanAnswer(dir, edit(pmImpact(dir, wrong)));
    return task.verify(dir).checks.filter((c) => !c.ok).map((c) => c.name);
  };
  const dated = ['T13 ', 'T9 ', 'T6 ', 'T11 ', 'M1 and M2', 'T20 '];
  const finishes = ['the project finishes on 2027-01-19', 'the project finishes on 2027-01-25'];

  // Every day counted as a working day: weekends and holidays worked, so the dates run early.
  assert.deepEqual(failed({ calendarDays: true }), named('no Start', ...dated, ...finishes));
  // Weekends kept but the holidays forgotten.
  assert.deepEqual(failed({ ignoreHolidays: true }), named('no Start', ...dated, ...finishes));
  // A finish-to-start successor started on its predecessor's finish day, not the next working day.
  assert.deepEqual(failed({ fsSameDay: true }), named(...dated, finishes[0], 'critical_before', finishes[1], 'M2 slips', 'M3 and M4'));
  // A milestone dated the next working day after its predecessor, as if it were a task that follows it.
  assert.deepEqual(failed({ milestoneNextDay: true }), named(...dated, ...finishes, 'critical_after', 'M3 and M4'));
  // A milestone's Start taken as the day after its predecessor finishes, and its Finish as that day (Start + 0 - 1).
  const nextDay = { M1: '2026-11-17', M2: '2026-12-23', M3: '2027-01-12', M4: '2027-01-20' };
  assert.deepEqual(failed({}, (a) => ({ ...a, schedule: a.schedule.map(([id, s, f]) => [id, nextDay[id] || s, f]) })), named('M1 and M2'));
  // The finish-to-finish link left out: T11 starts as soon as T9 allows.
  assert.deepEqual(failed({ ignoreFF: true }), named('T11 '));
  // Monday 28 December taken as a day in lieu for Boxing Day, which calendar.md says it is not.
  assert.deepEqual(failed({ dayInLieu: true }), named('T20 ', ...finishes));
  // The critical paths in the order of plan.csv, not of Start.
  assert.deepEqual(failed({ planOrder: true }), named('critical_before', 'critical_after'));
  // The path after the change assumed to run through M2, or left as it was.
  assert.deepEqual(failed({}, (a) => ({ ...a, impact: { ...a.impact, critical_after: [...a.impact.critical_after.slice(0, 8), 'M2', ...a.impact.critical_after.slice(8)] } })), named('critical_after'));
  assert.deepEqual(failed({}, (a) => ({ ...a, impact: { ...a.impact, critical_after: a.impact.critical_before } })), named('critical_after'));
  // The change's new dependency missed: T15 does not wait for the security review.
  assert.deepEqual(failed({ missedDependency: true }), named(finishes[1], 'critical_after', 'M3 and M4'));
  // Slips measured in calendar days; the 4 days T10 grew taken as every slip; M1 listed with 0.
  assert.deepEqual(failed({ calendarSlip: true }), named('M2 slips', 'M3 and M4'));
  assert.deepEqual(failed({}, (a) => ({ ...a, impact: { ...a.impact, slipped_milestones: { M2: 4, M3: 4, M4: 4 } } })), named('M2 slips'));
  assert.deepEqual(failed({}, (a) => ({ ...a, impact: { ...a.impact, slipped_milestones: { M1: 0, ...a.impact.slipped_milestones } } })), named('M3 and M4'));
});

test("version 5: the plan's dates, floats and slips are what an independent reading of the task gives", (t) => {
  const { before, after, impact } = pmImpact(workspace(t, MODEL_SUITE.find((x) => x.id === 'pm-critical-path')));
  const dates = (s, ids) => ids.map((id) => [id, s.at[id].start, s.at[id].finish]);
  // Worked by hand. The working days are the weekdays but 26-27 November, 24-25 December and 1 January;
  // 28 and 31 December are worked.
  // T1 2-3 Nov; T2 4, 5, 6, 9, 10 Nov; T3 11, 12, 13, 16 Nov; M1 on 16 Nov, the day T3 finishes.
  // T12 17-23 Nov; T13 24, 25, 30 Nov, 1, 2, 3 Dec: 26-27 Nov are holidays and 28-29 the weekend.
  // T8 17, 18, 19, 20, 23, 24, 25 Nov, so T9 starts on Monday 30 Nov and runs to 2 Dec.
  // T5 starts 23 Nov; T6 (T5SS+4) 4 working days later: 24, 25, 30 Nov, 1 Dec.
  // T10 3, 4, 7, 8, 9, 10, 11, 14 Dec. T11 may start on 3 Dec, after T9, but must finish on 14 Dec or later: 9, 10, 11, 14 Dec.
  // T5's 15 days end on 15 Dec; T17 16, 17, 18, 21, 22 Dec; M2 on 22 Dec (T11 and T7 finish earlier).
  // T20 (T17+2): the next working day after 22 Dec is 23 Dec, and 2 working days after that is 29 Dec.
  assert.deepEqual(dates(before, ['T1', 'T2', 'T3', 'M1', 'T13', 'T9', 'T6', 'T11', 'T17', 'M2', 'T20']), [
    ['T1', '2026-11-02', '2026-11-03'], ['T2', '2026-11-04', '2026-11-10'], ['T3', '2026-11-11', '2026-11-16'], ['M1', '2026-11-16', '2026-11-16'],
    ['T13', '2026-11-24', '2026-12-03'], ['T9', '2026-11-30', '2026-12-02'], ['T6', '2026-12-01', '2026-12-07'], ['T11', '2026-12-09', '2026-12-14'],
    ['T17', '2026-12-16', '2026-12-22'], ['M2', '2026-12-22', '2026-12-22'], ['T20', '2026-12-29', '2027-01-08'],
  ]);
  // T18 23, 28, 29, 30, 31 Dec, 4, 5, 6 Jan; T19 (T18SS+3) from 30 Dec to 7 Jan; T15 8-11 Jan; T22 7-11 Jan.
  // M3 on 11 Jan, T23 12 Jan, T24 13-19 Jan, M4 on 19 Jan, the project finish. T20 ends on 8 Jan, a working
  // day before M3 needs it, and T10 on 14 Dec, a day before T17 needs it: each has a day of float.
  assert.deepEqual(dates(before, ['T18', 'T19', 'T15', 'T22', 'M3', 'M4']), [
    ['T18', '2026-12-23', '2027-01-06'], ['T19', '2026-12-30', '2027-01-07'], ['T15', '2027-01-08', '2027-01-11'],
    ['T22', '2027-01-07', '2027-01-11'], ['M3', '2027-01-11', '2027-01-11'], ['M4', '2027-01-19', '2027-01-19'],
  ]);
  assert.deepEqual([before.float.T20, before.float.T10, before.float.T18], [1, 1, 0]);
  // After the change: T10's 12 days end on 18 Dec; T17 21, 22, 23, 28, 29 Dec; M2 on 29 Dec, 3 working days
  // later (23, 28, 29 Dec). T20 starts 2 working days after 30 Dec (31 Dec, 4 Jan) and its 8 days end on
  // 13 Jan; T15 waits for it, 14-15 Jan; M3 on 15 Jan, 4 working days after 11 Jan. T24 19-25 Jan: M4 on
  // 25 Jan, 4 working days after 19 Jan.
  assert.deepEqual(dates(after, ['T10', 'T17', 'M2', 'T20', 'T15', 'M3', 'M4']), [
    ['T10', '2026-12-03', '2026-12-18'], ['T17', '2026-12-21', '2026-12-29'], ['M2', '2026-12-29', '2026-12-29'], ['T20', '2027-01-04', '2027-01-13'],
    ['T15', '2027-01-14', '2027-01-15'], ['M3', '2027-01-15', '2027-01-15'], ['M4', '2027-01-25', '2027-01-25'],
  ]);
  // M2's successors are T18 and T21. T18 ends on 11 Jan; T22 after it may end on 15 Jan, so start on 13 Jan,
  // and T19 may end on 13 Jan (T15 must start on 14 Jan), so start on 6 Jan, which lets T18 start on 31 Dec
  // (T18SS+3): T18 may finish on 12 Jan, a day late, so M2 may be on 30 Dec. T17 feeds T20 directly
  // (T17+2), whose latest start is 4 Jan: T17 has no float, M2 a day.
  assert.deepEqual([after.float.M2, after.float.T18, after.float.T17, after.float.T5], [1, 1, 0, 3]);
  assert.deepEqual(impact.slipped_milestones, { M2: 3, M3: 4, M4: 4 });
});
