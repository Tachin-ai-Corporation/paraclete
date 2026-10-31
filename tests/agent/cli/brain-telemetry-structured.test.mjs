// Tests for structured gateway turn log lines in agent/gateway/server.mjs and
// agent/cli/brain-telemetry-read.mjs: createGatewayServer logs structured organ_turn fields on
// completed and failed turns while keeping the human-readable message, and parseJournalLine and main
// read those structured fields even when the human-readable message text is altered, while falling
// back to the regex patterns for older plain-message entries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer } from '../../../agent/gateway/server.mjs';
import { createOrganRegistry } from '../../../agent/gateway/organs.mjs';
import { createToolRegistry } from '../../../agent/gateway/tools.mjs';
import { gatewayTurns, main, parseJournal, parseJournalLine } from '../../../agent/cli/brain-telemetry-read.mjs';
import { fakeGoogle, geminiText, providerError, quiet, noSleep } from '../gateway/fakes.mjs';
import { run } from './fakes.mjs';

const TOKEN = 'test-gateway-token-0123456789';
const MODELS = {
  cortex: 'vertex-google/gemini-4-argon',
  strong: 'vertex-google/gemini-4-argon',
  fast: 'vertex-google/gemini-3.8-flash',
  fallback: 'vertex-google/gemini-3.8-flash',
};

let root;
let workspace;
let promptsDir;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'brain-telemetry-structured-'));
  workspace = join(root, 'workspace');
  promptsDir = join(root, 'prompts');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'motor.md'), 'You are the motor organ.');
});
after(() => rmSync(root, { recursive: true, force: true }));

function journalRecord(time, level, payload) {
  return JSON.stringify({
    __REALTIME_TIMESTAMP: String(Date.parse(time) * 1000),
    PRIORITY: level === 'ERROR' ? '3' : '6',
    MESSAGE: typeof payload === 'string' ? payload : JSON.stringify({ time, level, service: 'gateway', ...payload }),
  });
}

async function withGateway(options, fn) {
  const server = createGatewayServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('createGatewayServer emits structured organ_turn fields on completed and failed turns while keeping human-readable messages', async () => {
  const google = fakeGoogle([
    geminiText('completed answer text'),
    providerError('primary failed'),
    providerError('Vertex AI quota exceeded'),
  ]);
  const logged = [];
  let clock = Date.parse('2026-10-17T10:00:00.000Z');
  const now = () => {
    const current = clock;
    clock += 1500;
    return current;
  };
  await withGateway({
    token: TOKEN,
    clients: { project: 'your-gcp-project', googleLocation: 'global', anthropicLocation: null, google, anthropic: null },
    organs: createOrganRegistry({ models: MODELS, promptsDir }),
    tools: createToolRegistry({
      workspaceDir: workspace,
      binDir: '/opt/paraclete/bin',
      logger: quiet,
      memory: { home: workspace, files: ['MEMORY.md'], clis: ['core-memory-read'] },
    }),
    logger: (level, message, fields) => logged.push({ level, message, fields }),
    now,
    sleep: noSleep,
  }, async (url) => {
    const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    const okRes = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'brain/motor', messages: [{ role: 'user', content: 'run task' }] }),
    });
    assert.equal(okRes.status, 200);

    const errRes = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'brain/cerebellum', messages: [{ role: 'user', content: 'verify task' }] }),
    });
    assert.equal(errRes.status, 500);
  });

  const turnLogs = logged.filter((l) => l.fields?.event === 'organ_turn');
  assert.equal(turnLogs.length, 2);

  const [completed, failed] = turnLogs;
  assert.equal(completed.level, 'INFO');
  assert.match(completed.message, /^#1 completed \(21 chars, in=100 out=10 cached=0 cache_write=0 steps=1 provider=vertex-google\)$/);
  assert.deepEqual(completed.fields, {
    event: 'organ_turn',
    status: 'ok',
    organ: 'motor',
    duration_ms: 1500,
    output_chars: 21,
    steps: 1,
    model: 'vertex-google/gemini-4-argon',
  });

  assert.equal(failed.level, 'ERROR');
  assert.equal(failed.message, '#2 Vertex AI quota exceeded');
  assert.deepEqual(failed.fields, {
    event: 'organ_turn',
    status: 'error',
    organ: 'cerebellum',
    duration_ms: 1500,
    error: 'Vertex AI quota exceeded',
  });

  // Alter the human-readable messages on the emitted entries and verify parseJournalLine and main
  // still read the structured telemetry fields accurately.
  const NL = String.fromCharCode(10);
  const alteredLines = [
    journalRecord('2026-10-17T10:00:01.500Z', completed.level, {
      ...completed.fields,
      message: 'gateway turn finished with reworded summary text',
    }),
    journalRecord('2026-10-17T10:00:04.500Z', failed.level, {
      ...failed.fields,
      message: 'gateway turn did not complete due to upstream error',
    }),
  ];
  const alteredJournal = alteredLines.join(NL);

  const parsedOk = parseJournalLine(alteredLines[0]);
  assert.equal(parsedOk.organ, 'motor');
  assert.equal(parsedOk.status, 'ok');
  assert.equal(parsedOk.success, true);
  assert.equal(parsedOk.durationMs, 1500);
  assert.equal(parsedOk.outputChars, 21);
  assert.equal(parsedOk.steps, 1);
  assert.equal(parsedOk.model, 'vertex-google/gemini-4-argon');

  const parsedErr = parseJournalLine(alteredLines[1]);
  assert.equal(parsedErr.organ, 'cerebellum');
  assert.equal(parsedErr.status, 'error');
  assert.equal(parsedErr.success, false);
  assert.equal(parsedErr.durationMs, 1500);
  assert.equal(parsedErr.error, 'Vertex AI quota exceeded');

  const runJournal = async (_file, args) => ({
    code: 0,
    stdout: args.includes('-u') ? alteredJournal : '',
    stderr: '',
  });

  const jsonRes = await run(main, ['--json'], { run: runJournal });
  assert.equal(jsonRes.code, 0, jsonRes.err);
  const events = JSON.parse(jsonRes.out);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.organ, e.success, e.durationMs, e.outputChars, e.error]),
    [
      ['cerebellum', false, 1500, 0, 'Vertex AI quota exceeded'],
      ['motor', true, 1500, 21, null],
    ],
  );

  const tableRes = await run(main, ['--last', '2'], { run: runJournal });
  assert.equal(tableRes.code, 0, tableRes.err);
  const rows = tableRes.out.split(NL).slice(2, 4);
  assert.match(rows[0], /^2026-10-17 10:00:04 +cerebellum +1\.5s +❌ fail +0 chars {2}Vertex AI quota exceeded$/);
  assert.match(rows[1], /^2026-10-17 10:00:01 +motor +1\.5s +✅ ok +21 chars {2}$/);
});

test('parseJournalLine reads structured organ fields without event tag and falls back to regexes for plain messages', () => {
  const NL = String.fromCharCode(10);
  const withoutEventTag = journalRecord('2026-10-17T11:00:05.000Z', 'INFO', {
    message: 'totally different wording',
    organ: 'prefrontal',
    status: 'ok',
    duration_ms: 4200,
    output_chars: 950,
    steps: 2,
    model: 'vertex-google/gemini-4-argon',
  });
  const parsedStructured = parseJournalLine(withoutEventTag);
  assert.equal(parsedStructured.organ, 'prefrontal');
  assert.equal(parsedStructured.durationMs, 4200);
  assert.equal(parsedStructured.outputChars, 950);
  assert.equal(parsedStructured.steps, 2);
  assert.equal(parsedStructured.success, true);

  // Plain-message fallback still pairs start and completion/error lines via regexes.
  const plainStart = journalRecord('2026-10-17T11:01:00.000Z', 'INFO', {
    message: '#7 organ=cortex model=vertex-google/gemini-4-argon msgs=2',
  });
  const plainComplete = journalRecord('2026-10-17T11:01:03.000Z', 'INFO', {
    message: '#7 completed (320 chars, in=50 out=20 cached=0 cache_write=0 steps=1 provider=vertex-google)',
  });
  assert.equal(parseJournalLine(plainStart).turn.kind, 'start');
  assert.equal(parseJournalLine(plainComplete).turn.kind, 'complete');

  const turns = gatewayTurns(parseJournal([withoutEventTag, plainStart, plainComplete].join(NL)));
  assert.deepEqual(
    turns.map((t) => [t.organ, t.success, t.durationMs, t.outputChars]),
    [
      ['prefrontal', true, 4200, 950],
      ['cortex', true, 3000, 320],
    ],
  );
});
