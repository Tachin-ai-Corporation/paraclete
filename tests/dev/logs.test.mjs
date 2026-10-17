// Tests for dev/logs.mjs: the journalctl command for one service or all of them, the exact gcloud
// arguments, and each JSON log line printed as one readable line even when it arrives split across
// chunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineWriter, formatLogLine, journalCommand, main } from '../../dev/logs.mjs';
import { assertNoShell, devDeps, expectedSsh, fakeExec } from './fakes.mjs';

const UNITS = '-u paraclete-gateway.service -u paraclete-brain.service -u paraclete-ears.service -u paraclete-mouth.service -u paraclete-control.service';

test('journalctl for one service, every service, a line count and follow', () => {
  assert.equal(journalCommand({ service: 'brain', lines: 100, follow: false }), 'sudo journalctl -u paraclete-brain.service -n 100 -o cat --no-pager');
  assert.equal(journalCommand({ service: 'all', lines: 20, follow: true }), `sudo journalctl ${UNITS} -n 20 -f -o cat --no-pager`);
});

test('a service log line becomes one readable line; anything else passes through', () => {
  const line = JSON.stringify({ mission: 'w-1', chars: 120, note: 'two words', ok: true, time: '2026-10-17T12:00:00.000Z', level: 'INFO', service: 'brain', message: 'intake written' });
  assert.equal(formatLogLine(line), '2026-10-17T12:00:00.000Z INFO  brain intake written  mission=w-1 chars=120 note="two words" ok=true');
  assert.equal(formatLogLine(`${JSON.stringify({ time: 't', level: 'WARN', service: 'ears', message: 'm', nested: { a: [1] } })}\r`), 't WARN  ears m  nested={"a":[1]}');
  assert.equal(formatLogLine('Started paraclete-brain.service.'), 'Started paraclete-brain.service.');
  assert.equal(formatLogLine('{not json'), '{not json');
  assert.equal(formatLogLine('[1,2]'), '[1,2]');
});

test('lines split across chunks are put back together before they are formatted', () => {
  let out = '';
  const writer = createLineWriter((text) => { out += text; });
  writer.push('{"time":"t","level":"INFO","serv');
  writer.push('ice":"mouth","message":"delivered"}\nplain line\npart');
  writer.push('ial');
  writer.end();
  assert.equal(out, 't INFO  mouth delivered\nplain line\npartial\n');
});

test('logs runs journalctl on the VM over IAP and prints formatted lines', async () => {
  const journal = `${JSON.stringify({ time: '2026-10-17T12:00:00.000Z', level: 'INFO', service: 'brain', message: 'mission started', mission: 'w-1' })}\nStopping paraclete-brain.service...\n`;
  const exec = fakeExec((program, args) => (args[0] === 'compute' ? { stdout: journal } : undefined));
  const deps = devDeps({ exec });
  assert.equal(await main(['brain', '--lines', '50', '--follow'], deps), 0, deps.stderr.text);
  assert.deepEqual(exec.calls.map((c) => c.args), [expectedSsh('sudo journalctl -u paraclete-brain.service -n 50 -f -o cat --no-pager')]);
  assert.equal(exec.calls[0].opts.collect, false, 'a followed journal is not kept in memory');
  assertNoShell(exec.calls);
  assert.equal(deps.stdout.text, '2026-10-17T12:00:00.000Z INFO  brain mission started  mission=w-1\nStopping paraclete-brain.service...\n');

  const all = fakeExec(() => ({ stdout: '' }));
  assert.equal(await main(['all'], devDeps({ exec: all })), 0);
  assert.deepEqual(all.calls[0].args, expectedSsh(`sudo journalctl ${UNITS} -n 100 -o cat --no-pager`));
});

test('an unknown service or a bad line count is refused before anything runs; a failed ssh fails', async () => {
  for (const argv of [['shell'], ['brain', '--lines', '0'], ['brain', '--lines', 'ten'], [], ['brain', 'ears'], ['brain', '--since', 'x']]) {
    const exec = fakeExec();
    const deps = devDeps({ exec });
    assert.equal(await main(argv, deps), 2, argv.join(' '));
    assert.equal(exec.calls.length, 0, argv.join(' '));
  }
  const deps = devDeps({ exec: fakeExec(() => ({ code: 255, stderr: 'Connection closed\n' })) });
  assert.equal(await main(['ears'], deps), 1);
  assert.match(deps.stderr.text, /Connection closed\n.*exited with code 255/s);
});
