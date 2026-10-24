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

test('a fix that edits the tests instead of the code fails the unchanged-test check', (t) => {
  const task = MODEL_SUITE.find((x) => x.id === 'se-fix-failing-test');
  const dir = workspace(t, task);
  write(dir, 'test/range.test.mjs', "import { test } from 'node:test';\ntest('nothing', () => {});\n");
  const res = task.verify(dir);
  assert.equal(res.passed, false);
  assert.match(res.summary, /failed: test\/range\.test\.mjs is unchanged/);
});

test('selection by role and split; a role without tasks runs the generic ones as that role', () => {
  assert.deepEqual(selectModelTasks({ role: 'data-engineer' }).map((t) => t.id), ['data-revenue-summary', 'data-dedupe-customers']);
  assert.deepEqual(selectModelTasks({ role: 'data-engineer', split: 'holdout' }).map((t) => t.id), ['data-dedupe-customers']);
  const legal = selectModelTasks({ role: 'legal-advisor' });
  assert.deepEqual(legal.map((t) => [t.id, t.role]), [['gen-action-items', 'legal-advisor'], ['gen-extract-contacts', 'legal-advisor']]);
  assert.equal(typeof legal[0].verify, 'function');
  assert.equal(selectModelTasks().length, MODEL_SUITE.length);
});
