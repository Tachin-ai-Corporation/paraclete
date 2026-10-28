// Tests for dev/harness2/model-suite.mjs: every task starts unsolved (its checks do not all pass on the
// seeded workspace), a reference solution passes every check, and a wrong solution scores in between,
// so a task's score measures the work. Also the split and the task selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_SUITE, SPLITS, isModelTask, selectModelTasks } from '../../../dev/harness2/model-suite.mjs';

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
  ])),
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

test('a fix that edits the tests instead of the code fails the unchanged-test check', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'se-fix-failing-test');
  const dir = workspace(t, task);
  write(dir, 'test/range.test.mjs', "import { test } from 'node:test';\ntest('nothing', () => {});\n");
  const res = task.verify(dir);
  assert.equal(res.passed, false);
  assert.match(res.summary, /failed: test\/range\.test\.mjs is unchanged/);
});

test('selection by role and split; a role without tasks runs the generic ones as that role', () => {
  assert.deepEqual(selectModelTasks({ role: 'data-engineer' }).map((t) => t.id), ['data-revenue-summary', 'data-dedupe-customers', 'data-join-clean-orders']);
  assert.deepEqual(selectModelTasks({ role: 'data-engineer', split: 'holdout' }).map((t) => t.id), ['data-dedupe-customers']);
  const legal = selectModelTasks({ role: 'legal-advisor' });
  assert.deepEqual(legal.map((t) => [t.id, t.role]), [['gen-action-items', 'legal-advisor'], ['gen-extract-contacts', 'legal-advisor'], ['gen-meeting-schedule', 'legal-advisor']]);
  assert.equal(typeof legal[0].verify, 'function');
  assert.equal(selectModelTasks().length, MODEL_SUITE.length);
});
