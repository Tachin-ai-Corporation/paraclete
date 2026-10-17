// Tests for agent/work/task-outcome.mjs. The pathologies prevented: a finished discovery reported
// blocked because one command in its tool log printed "command failed"; a failed deploy reported
// complete because its prose was long; a truncated or timed-out reply retried blind; a thin success
// passed to the verifier with nothing to flag it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMotorCheck, prepareRetry, withEvidenceWarnings, isDurableWrite,
} from '../../../agent/work/task-outcome.mjs';

const log = (...lines) => `\n[TOOL EXECUTION LOG]\n${lines.join('\n')}\n[END TOOL LOG]`;
const LONG_ANSWER = 'Found 14 service accounts and 3 instances. '.repeat(10);

describe('applyMotorCheck', () => {
  it('a failure in the answer itself fails the task', () => {
    const { result } = applyMotorCheck({ success: true, output: '[ERROR] command failed: exit code 2' }, { organ: 'motor', taskText: 'list things' });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Non-zero exit code');
  });

  it('a recovered sub-command error is annotated, not failed', () => {
    const out = `${LONG_ANSWER}${log('[TOOL] runCommand({"command":"count"}) → [ERROR] command failed', '[TOOL] runCommand({"command":"list"}) → ok')}`;
    const { result, recoveredFrom } = applyMotorCheck({ success: true, output: out }, { organ: 'motor', taskText: 'Inventory the service accounts' });
    assert.equal(result.success, true);
    assert.equal(recoveredFrom, 'Command failed');
    assert.match(result.output, /\[EVIDENCE WARNING: a tool call reported "Command failed"/);
  });

  it('a delivery-critical task does not soft-pass on prose length', () => {
    const out = `${LONG_ANSWER}${log('[TOOL] runCommand({"command":"deploy"}) → [ERROR] command failed: HTTP 404')}`;
    const { result } = applyMotorCheck({ success: true, output: out }, { organ: 'motor', taskText: 'Deploy the site to staging' });
    assert.equal(result.success, false, 'a failed deploy is a real failure');
  });

  it('a delivery-critical task recovers when a later attempt of the action succeeded', () => {
    const out = `Deployed.${log('[TOOL] runCommand({"command":"deploy"}) → [ERROR] command failed', '[TOOL] runCommand({"command":"deploy --retry"}) → released')}`;
    const { result } = applyMotorCheck({ success: true, output: out }, { organ: 'motor', taskText: 'Deploy the site to staging' });
    assert.equal(result.success, true);
  });

  it('other organs pass through untouched', () => {
    const input = { success: true, output: '[ERROR] command failed' };
    assert.equal(applyMotorCheck(input, { organ: 'temporal-research', taskText: 'x' }).result, input);
  });

  it('does not mutate its input', () => {
    const input = { success: true, output: '[ERROR] command failed' };
    applyMotorCheck(input, { organ: 'motor', taskText: 'x' });
    assert.equal(input.success, true);
  });
});

describe('prepareRetry', () => {
  it('a reply cut at the token limit fails, and the retry is told to write to a file', () => {
    const { result, nudges } = prepareRetry({ success: true, output: 'partial', finishReason: 'length' });
    assert.equal(result.success, false);
    assert.match(result.error, /\[OUTPUT TRUNCATED AT TOKEN LIMIT\]/);
    assert.match(nudges, /\[TRUNCATION\]/);
  });

  it('a timeout is told its outcome is unknown and to work in smaller batches', () => {
    const { nudges } = prepareRetry({ success: false, error: 'The operation timed out after 300s' });
    assert.match(nudges, /\[TIMEOUT\]/);
    assert.match(nudges, /UNKNOWN, not failed/);
  });

  it('an ordinary result is left alone', () => {
    const input = { success: true, output: 'ok', finishReason: 'STOP' };
    const { result, nudges } = prepareRetry(input);
    assert.equal(result, input);
    assert.equal(nudges, '');
  });
});

describe('withEvidenceWarnings (the evidence floor)', () => {
  it('flags a fast motor success with almost no tools and no write', () => {
    const { result, warnings } = withEvidenceWarnings({ success: true, durationMs: 900, output: `done${log('[TOOL] readFile({"path":"a"}) → x')}` }, { organ: 'motor' });
    assert.equal(warnings.length, 1);
    assert.match(result.output, /completed very quickly/);
  });

  it('a durable write is real work, however quick', () => {
    const { warnings } = withEvidenceWarnings({ success: true, durationMs: 900, output: `done${log('[TOOL] runCommand({"command":"core-memory-write --text x"}) → stored')}` }, { organ: 'motor' });
    assert.deepEqual(warnings, []);
  });

  it('flags errors in the tool log of a reported success', () => {
    const out = `done${log('[TOOL] runCommand({"command":"cat x"}) → No such file or directory', '[TOOL] writeFile({}) → ok', '[TOOL] runCommand({}) → ok')}`;
    const { warnings } = withEvidenceWarnings({ success: true, durationMs: 30000, output: out }, { organ: 'motor' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /contains errors despite SUCCESS/);
  });

  it('leaves failures and other organs alone', () => {
    assert.deepEqual(withEvidenceWarnings({ success: false, output: '' }, { organ: 'motor' }).warnings, []);
    assert.deepEqual(withEvidenceWarnings({ success: true, durationMs: 1, output: 'x' }, { organ: 'temporal-memory' }).warnings, []);
  });
});

describe('isDurableWrite', () => {
  it('counts file writes, commits, file hand-backs and memory writes, and not reads', () => {
    for (const line of [
      '[TOOL] writeFile({"path":"x"}) → ok',
      '[TOOL] runCommand({"command":"git commit -m x"}) → ok',
      '[TOOL] runCommand({"command":"file-share out.pdf"}) → ok',
      '[TOOL] runCommand({"command":"drive-put out.docx"}) → ok',
      '[TOOL] runCommand({"command":"core-memory-write --text x"}) → ok',
    ]) assert.equal(isDurableWrite(line), true, line);
    for (const line of [
      '[TOOL] readFile({"path":"x"}) → ok',
      '[TOOL] runCommand({"command":"drive-find report"}) → ok',
      '[TOOL] runCommand({"command":"core-memory-read --query x"}) → ok',
    ]) assert.equal(isDurableWrite(line), false, line);
  });
});
