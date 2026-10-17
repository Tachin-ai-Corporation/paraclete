// Tests for agent/cli/brain-telemetry-read.mjs, against journal output shaped like
// `journalctl -o json` over the services' one-object-per-line logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayTurns, main, parseJournal, writtenEvents } from '../../../agent/cli/brain-telemetry-read.mjs';
import { run } from './fakes.mjs';

/** One journald record wrapping a service log line. */
const line = (time, level, message) => JSON.stringify({
  __REALTIME_TIMESTAMP: String(Date.parse(time) * 1000),
  PRIORITY: level === 'ERROR' ? '3' : '6',
  MESSAGE: JSON.stringify({ time, level, service: 'gateway', message }),
});

const GATEWAY = [
  line('2026-10-17T10:00:00.000Z', 'INFO', '#1 organ=motor model=vertex-google/gemini-4-argon msgs=3'),
  line('2026-10-17T10:00:01.000Z', 'INFO', 'running tool runCommand {"command":"ls"}'),
  line('2026-10-17T10:00:12.500Z', 'INFO', '#1 completed (5120 chars, in=900 out=300 cached=0 cache_write=0 steps=4 provider=vertex-google)'),
  line('2026-10-17T10:01:00.000Z', 'INFO', '#2 organ=cortex model=vertex-google/gemini-4-argon msgs=2 session=m-1:continue'),
  line('2026-10-17T10:01:00.100Z', 'INFO', '#2 TELEMETRY session_miss id=m-1 reason=absent'),
  line('2026-10-17T10:02:00.000Z', 'INFO', '#3 organ=cerebellum model=vertex-google/gemini-4-argon msgs=4'),
  line('2026-10-17T10:02:30.000Z', 'ERROR', '#3 Vertex AI returned 500'),
  line('2026-10-17T10:03:00.000Z', 'INFO', '#4 organ=prefrontal model=vertex-google/gemini-4-argon msgs=2'),
  line('2026-10-17T10:03:20.000Z', 'INFO', '#4 completed (800 chars, in=10 out=5 cached=0 cache_write=0 steps=1 provider=vertex-google fallback_from=vertex-anthropic/claude-opus-4-6)'),
  line('2026-10-17T10:04:00.000Z', 'INFO', '#5 organ=motor model=vertex-google/gemini-4-argon msgs=3'),
].join('\n');

const WRITTEN = JSON.stringify({
  __REALTIME_TIMESTAMP: String(Date.parse('2026-10-17T09:00:00.000Z') * 1000),
  MESSAGE: JSON.stringify({
    time: '2026-10-17T09:00:05.000Z', level: 'WARN', service: 'telemetry', message: 'dispatch', event: 'dispatch',
    organ: 'temporal-research', task: 'search the web', started_at: '2026-10-17T09:00:00.000Z', duration_ms: 5000,
    output_bytes: 0, exit_code: 0, success: false, error: 'empty_output',
  }),
});

function journal({ gateway = GATEWAY, written = WRITTEN, code = 0, stderr = '' } = {}) {
  const calls = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, ...args]);
      return { code, stdout: args.includes('-u') ? gateway : written, stderr };
    },
  };
}

test('pairs each turn\'s start and end by request number', () => {
  const turns = gatewayTurns(parseJournal(GATEWAY));
  const byOrgan = Object.fromEntries(turns.map((t) => [t.organ, t]));
  assert.equal(turns.length, 5);
  assert.deepEqual([byOrgan.prefrontal.success, byOrgan.prefrontal.durationMs, byOrgan.prefrontal.fallbackFrom],
    [true, 20_000, 'vertex-anthropic/claude-opus-4-6']);
  assert.deepEqual([byOrgan.cerebellum.success, byOrgan.cerebellum.error], [false, 'Vertex AI returned 500']);
  assert.match(byOrgan.cortex.note, /session miss \(absent\)/);
  const motor = turns.filter((t) => t.organ === 'motor');
  assert.deepEqual(motor.map((t) => [t.success, t.durationMs, t.outputChars, t.steps ?? null]), [[true, 12_500, 5120, 4], [null, null, 0, null]]);
});

test('a request number reused after a restart closes the earlier turn as unfinished', () => {
  const turns = gatewayTurns(parseJournal([
    line('2026-10-17T10:00:00.000Z', 'INFO', '#1 organ=motor model=m msgs=1'),
    line('2026-10-17T10:05:00.000Z', 'INFO', '#1 organ=cortex model=m msgs=1'),
    line('2026-10-17T10:05:02.000Z', 'INFO', '#1 completed (10 chars, in=1 out=1 cached=0 cache_write=0 steps=1 provider=vertex-google)'),
  ].join('\n')));
  assert.deepEqual(turns.map((t) => [t.organ, t.success]), [['motor', false], ['cortex', true]]);
  assert.match(turns[0].error, /no end was logged/);
});

test('plain-text log lines and written dispatch events are read too', () => {
  const plain = parseJournal(JSON.stringify({ __REALTIME_TIMESTAMP: '1792252800000000', MESSAGE: '[gateway] INFO: #9 organ=motor model=m msgs=1' }));
  assert.deepEqual([plain[0].level, plain[0].message, plain[0].at], ['INFO', '#9 organ=motor model=m msgs=1', '2026-10-17T16:00:00.000Z']);
  const [event] = writtenEvents(parseJournal(WRITTEN));
  assert.deepEqual([event.organ, event.success, event.error, event.durationMs], ['temporal-research', false, 'empty_output', 5000]);
});

test('prints the newest turns first, from the gateway unit and the telemetry tag', async () => {
  const j = journal();
  const r = await run(main, ['--last', '3'], { run: j.run });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(j.calls.map((c) => c.slice(0, 3)), [['journalctl', '-u', 'paraclete-gateway.service'], ['journalctl', '-t', 'paraclete-telemetry']]);
  const rows = r.out.split('\n').slice(2, 5);
  assert.match(rows[0], /^2026-10-17 10:04:00 +motor +— +… running +0 chars {2}still running$/);
  assert.match(rows[1], /^2026-10-17 10:03:00 +prefrontal +20\.0s +✅ ok +800 chars {2}fell back from vertex-anthropic\/claude-opus-4-6$/);
  assert.match(rows[2], /^2026-10-17 10:02:00 +cerebellum +30\.0s +❌ fail +0 chars {2}Vertex AI returned 500$/);
  assert.match(r.out, /3 event\(s\) shown\.\n$/);
});

test('--organ and --failures filter; --json prints the events', async () => {
  let r = await run(main, ['--failures', '--json'], { run: journal().run });
  assert.deepEqual(JSON.parse(r.out).map((e) => e.organ), ['cerebellum', 'temporal-research']);
  r = await run(main, ['--organ', 'motor', '--json'], { run: journal().run });
  assert.deepEqual(JSON.parse(r.out).map((e) => e.startedAt), ['2026-10-17T10:04:00.000Z', '2026-10-17T10:00:00.000Z']);
  r = await run(main, ['--agent', 'motor'], { run: journal().run });
  assert.match(r.err, /Unknown option: --agent/);
});

test('no events, a journal it may not read, and no journalctl at all', async () => {
  let r = await run(main, [], { run: journal({ gateway: '', written: '', stderr: 'Hint: You are currently not seeing messages from other users and the system.' }).run });
  assert.equal(r.out, 'No dispatch events found.\n');
  assert.match(r.err, /not seeing messages from other users/);
  r = await run(main, [], { run: journal({ code: 127 }).run });
  assert.equal(r.code, 1);
  assert.match(r.err, /journalctl is not available/);
  r = await run(main, [], { run: journal({ gateway: '', written: '', code: 1, stderr: '-- No entries --' }).run });
  assert.equal(r.code, 0);
});
