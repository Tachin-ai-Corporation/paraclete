// Tests for agent/cli/brain-telemetry-write.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchEvent, main } from '../../../agent/cli/brain-telemetry-write.mjs';
import { gatewayTurns, parseJournal, writtenEvents } from '../../../agent/cli/brain-telemetry-read.mjs';
import { run } from './fakes.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const START_NS = String(BigInt(Date.parse('2026-10-17T11:59:50.000Z')) * 1_000_000n);
const END_NS = String(BigInt(Date.parse('2026-10-17T11:59:52.500Z')) * 1_000_000n);

test('a dispatch becomes one JSON line, with its duration from the nanosecond clock', () => {
  assert.deepEqual(dispatchEvent(['motor', 'run the tests', START_NS, END_NS, '2048', '0'], NOW), {
    time: '2026-10-17T12:00:00.000Z', level: 'INFO', service: 'telemetry', message: 'dispatch', event: 'dispatch',
    organ: 'motor', task: 'run the tests', started_at: '2026-10-17T11:59:50.000Z', duration_ms: 2500,
    output_bytes: 2048, exit_code: 0, success: true, error: null,
  });
});

test('a non-zero exit, an empty output or an error type is a failure', () => {
  assert.equal(dispatchEvent(['motor', 't', '0', '0', '10', '2'], NOW).success, false);
  assert.equal(dispatchEvent(['motor', 't', '0', '0', '0', '0'], NOW).success, false);
  const e = dispatchEvent(['motor', 'x'.repeat(300), '0', '0', '10', '0', 'timeout'], NOW);
  assert.deepEqual([e.success, e.error, e.level, e.task.length, e.duration_ms, e.started_at], [false, 'timeout', 'WARN', 200, 0, NOW.toISOString()]);
});

test('writes to the journal under the telemetry tag, where brain-telemetry-read finds it', async () => {
  const calls = [];
  const r = await run(main, ['cortex', 'decide', START_NS, END_NS, '100', '0'], {
    now: () => NOW,
    run: async (file, args, opts) => { calls.push({ file, args, input: opts.input }); return { code: 0, stdout: '', stderr: '' }; },
  });
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.deepEqual([calls[0].file, calls[0].args], ['systemd-cat', ['-t', 'paraclete-telemetry', '-p', 'info']]);
  const journal = JSON.stringify({ __REALTIME_TIMESTAMP: String(NOW.getTime() * 1000), MESSAGE: calls[0].input.trim() });
  const [event] = writtenEvents(parseJournal(journal));
  assert.deepEqual([event.organ, event.success, event.durationMs], ['cortex', true, 2500]);
  assert.deepEqual(gatewayTurns(parseJournal(journal)), [], 'a written event is never mistaken for a gateway turn');
});

test('never fails the caller', async () => {
  let r = await run(main, ['motor'], { now: () => NOW, run: async () => ({ code: 127, stdout: '', stderr: 'systemd-cat: not found' }) });
  assert.equal(r.code, 0);
  assert.match(r.err, /\[brain-telemetry-write\] WARN: could not write to the journal \(systemd-cat: not found\); skipping/);
  r = await run(main, ['motor'], { now: () => NOW, run: async () => { throw new Error('spawn failed'); } });
  assert.equal(r.code, 0);
  assert.match(r.err, /spawn failed; skipping/);
});
