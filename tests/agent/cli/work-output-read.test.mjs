// Tests for agent/cli/work-output-read.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../agent/cli/work-output-read.mjs';
import { fakeDb, fakeRuntime, run } from './fakes.mjs';

const OUTPUT = `${'line of output\n'.repeat(5000)}the end`;

const db = () => fakeDb({
  'work/m-1': {
    type: 'M', status: 'complete', title: 'Report', created_at: '2026-10-17T10:00:00.000Z', completed_at: '2026-10-17T11:00:00.000Z',
    updated_at: '2026-10-17T11:00:00.000Z', instruction: 'Write the report', output: OUTPUT, accept_criteria: 'The report exists',
    project_id: 'general', source_channel: 'dashboard', source_meta: { thread: 'th-1', sender: 'user@example.com', address: { channel: 'dashboard' } },
    iteration: 3, children: ['c-1', 'c-2'],
  },
});

const read = (argv, store = db()) => run(main, argv, { runtime: fakeRuntime({ db: store }) });

test('prints the envelope and its whole output, never truncated', async () => {
  const r = await read(['m-1']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith([
    'Status: complete', 'Type: M', 'Title: Report', 'Created: 2026-10-17T10:00:00.000Z', 'Completed: 2026-10-17T11:00:00.000Z',
    'Updated: 2026-10-17T11:00:00.000Z', 'Accept Criteria: The report exists', 'Project: general', 'Source Channel: dashboard',
    'Source Meta: {"thread":"th-1","sender":"user@example.com"}', 'Iteration: 3', 'Children: c-1, c-2',
    'Instruction chars: 16', `Output chars: ${OUTPUT.length}`, '---', '',
  ].join('\n')), r.out.slice(0, 600));
  assert.ok(r.out.endsWith(`${OUTPUT}\n`));
});

test('--json gives the same fields as an object, children from the tree the brain writes', async () => {
  const r = await read(['m-1', '--json']);
  const env = JSON.parse(r.out);
  assert.equal(env.id, 'm-1');
  assert.equal(env.output, OUTPUT);
  assert.deepEqual(env.children, ['c-1', 'c-2'], 'read from children, which the brain writes (child_ids never was)');
  assert.ok(!('owner' in env));
});

test('a missing envelope, a missing id and an outage are errors', async () => {
  let r = await read(['m-none']);
  assert.deepEqual([r.code, r.err], [1, 'ERROR: Envelope m-none not found\n']);
  r = await read([]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^ERROR: envelope-id is required\nUsage: work-output-read <envelope-id> \[--json\]\n$/);
  r = await read(['m-1', 'm-2']);
  assert.match(r.err, /Unexpected argument: m-2/);
  const down = db();
  down.state.down = true;
  r = await read(['m-1'], down);
  assert.equal(r.code, 1);
});
