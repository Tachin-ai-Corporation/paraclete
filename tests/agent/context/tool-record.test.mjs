// Tests for agent/context/tool-record.mjs. The record of a tool call is ground truth for the
// verifier. A record that silently kept only the first 500 characters of each result once hid the
// later sections of a correct document, and the verifier blocked it. These tests pin the
// replacement: kept whole up to verbatim_chars; above it, the full result stored and a digest + ref
// in the log; never cut silently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolLog, completeToolLog, expandToolResults, storedResultRefs, recordPolicy, excerpt, digestInstruction,
  DEFAULT_RECORD_POLICY, TOOL_RESULTS_COLLECTION, TERMINAL_TOOLS,
} from '../../../agent/context/tool-record.mjs';
import { COLLECTIONS } from '../../../agent/storage/collections.mjs';

const policy = DEFAULT_RECORD_POLICY;

// A document read-back whose later sections sit past character 500.
const readBack = [
  'Weekly Update',
  'Agenda',
  ...Array.from({ length: 6 }, (_, i) => `Segment ${i + 1}: progress on the client programs and the product roadmap`),
  'State of the Week',
  ...Array.from({ length: 5 }, (_, i) => `Area ${i + 1}: progress, risks and what the team is waiting on this week`),
  'Decisions to Lock',
  'A new pricing model will be rolled out to all customers.',
  'Action Items',
  'Task | Owner | Due | Status',
  'Draft the new requirements | Product lead | not set | Not Started',
].join('\n');
const motorOutput = (log) => `Read the finished document back; every section has content.\n\n---\n[TOOL EXECUTION LOG]\n${log}\n[END TOOL LOG]`;

describe('the gateway keeps the record whole up to the bound', () => {
  it('a read-back under verbatim_chars reaches the log with every section, and nothing to store', () => {
    assert.ok(readBack.length > 900 && readBack.indexOf('Decisions to Lock') > 500, 'the fixture has sections past char 500');
    const { log, large } = buildToolLog([{ toolName: 'runCommand', args: { command: 'docs-cat doc-1' }, result: readBack }], policy);
    assert.deepEqual(large, [], 'under verbatim_chars: no digest, no store, no model call');
    assert.equal(log, `[TOOL] runCommand({"command":"docs-cat doc-1"}) → ${readBack}`);
  });

  it('a large result becomes a marked excerpt in the log and a full record for the brain', () => {
    const big = 'row\n'.repeat(5000); // 20,000 chars
    const { log, large } = buildToolLog([{ toolName: 'runCommand', args: { command: 'drive-ls x' }, result: big }], policy);
    assert.equal(large.length, 1);
    assert.equal(large[0].result, big, 'the brain receives the whole result');
    assert.equal(large[0].chars, 20000);
    assert.match(log, /\[large result #0: 20000 chars — excerpt\]/);
    assert.match(log, /\[… 16000 of 20000 chars omitted …\]/, 'the cut is stated, never silent');
    assert.match(log, /\[\/large result #0\]$/);
  });

  it('ordinary arguments are capped and marked; a terminal tool\'s are never marked', () => {
    const verdict = { summary: 'All sections present.', notes: 'n'.repeat(300) };
    const { log } = buildToolLog([
      { toolName: 'runCommand', args: { command: 'x'.repeat(500) }, result: 'ok' },
      { toolName: 'report_pass', args: verdict, result: 'recorded' },
    ], policy);
    assert.match(log, /^\[TOOL\] runCommand\(\{"command":"x{188}…\) → ok$/m, 'ordinary args: 200 chars, marked');
    assert.ok(TERMINAL_TOOLS.has('report_pass'));
    assert.ok(log.includes(`[TOOL] report_pass(${JSON.stringify(verdict)}) → recorded`), 'the verdict payload stays intact');
  });

  it('a result that is not a string is recorded as JSON, and a missing one as empty', () => {
    const { log } = buildToolLog([{ name: 'listFiles', args: {}, result: { files: 2 } }, { toolName: 'noop' }], policy);
    assert.equal(log, '[TOOL] listFiles({}) → {"files":2}\n[TOOL] noop({}) → ');
  });
});

describe('the brain stores the full result and puts a digest + ref in the log', () => {
  const big = Array.from({ length: 900 }, (_, i) => `item ${i}: id-${1000 + i} status ok`).join('\n');
  const built = () => buildToolLog([{ toolName: 'runCommand', args: { command: 'list' }, result: big }], policy);

  it('stores, then swaps the excerpt for the labelled digest and the ref', async () => {
    const { log, large } = built();
    const order = [];
    const { text, recorded } = await completeToolLog(motorOutput(log), large, {
      policy,
      store: async (rec) => { order.push('store'); assert.equal(rec.result, big); return `${TOOL_RESULTS_COLLECTION}/tr-1`; },
      digest: async () => { order.push('digest'); return '900 items, id-1000..id-1899, all status ok'; },
    });
    assert.match(text, /\[digest of \d+ chars — full result: tool_results\/tr-1\]\n900 items, id-1000\.\.id-1899, all status ok/);
    assert.doesNotMatch(text, /large result #0/, 'the gateway placeholder is gone');
    assert.deepEqual(recorded, [{ seq: 0, tool: 'runCommand', chars: big.length, ref: 'tool_results/tr-1', digested: true }]);
    assert.ok(order.includes('store') && order.includes('digest'));
  });

  it('a failed digest keeps the excerpt and says so; a failed store says the result was not kept', async () => {
    const { log, large } = built();
    const noDigest = await completeToolLog(motorOutput(log), large, { policy, store: async () => 'tool_results/tr-2', digest: async () => null });
    assert.match(noDigest.text, /\[excerpt of \d+ chars — digest unavailable; full result: tool_results\/tr-2\]\nitem 0:/);
    const noStore = await completeToolLog(motorOutput(log), large, { policy, store: async () => { throw new Error('503'); }, digest: async () => 'digest' });
    assert.match(noStore.text, /\[digest of \d+ chars — full result not stored\]\ndigest/);
  });

  it('stores nothing when the policy turns storing off', async () => {
    const { log, large } = built();
    let stored = false;
    const { recorded } = await completeToolLog(motorOutput(log), large, {
      policy: recordPolicy({ store_full: false }),
      store: async () => { stored = true; return 'tool_results/tr-4'; },
      digest: async () => 'digest',
    });
    assert.equal(stored, false);
    assert.equal(recorded[0].ref, null);
  });

  it('a digest longer than the hard cap is cut to it', async () => {
    const { log, large } = built();
    const { text } = await completeToolLog(motorOutput(log), large, { policy, store: async () => 'tool_results/tr-3', digest: async () => 'd'.repeat(9000) });
    assert.ok(!text.includes('d'.repeat(policy.digest_max_chars + 1)));
  });

  it('leaves text with no large results unchanged', async () => {
    assert.deepEqual(await completeToolLog('plain', []), { text: 'plain', recorded: [] });
  });

  it('the digest brief condenses and never interprets', () => {
    const brief = digestInstruction(policy);
    assert.match(brief, /Copy exactly every identifier/);
    assert.match(brief, /Never add, infer, judge/);
    assert.match(brief, /at most 3000 characters/);
  });
});

describe('the verifier and the cortex can reach the full result by ref', () => {
  it('expandToolResults restores stored results within the budget, smallest first', async () => {
    const log = [
      '[TOOL] runCommand({}) → [digest of 3000 chars — full result: tool_results/small]\nsmall digest',
      '[TOOL] runCommand({}) → [digest of 50000 chars — full result: tool_results/huge]\nhuge digest',
    ].join('\n');
    const store = { 'tool_results/small': 's'.repeat(3000), 'tool_results/huge': 'h'.repeat(50000) };
    const out = await expandToolResults(motorOutput(log), { read: async (ref) => store[ref], budget: 8000 });
    assert.match(out, /\[full result, 3000 chars — tool_results\/small\]\ns{3000}/);
    assert.match(out, /huge digest/, 'a result that does not fit keeps its digest');
    assert.match(out, /\[END TOOL LOG\]$/, 'the log stays well formed');
  });

  it('storedResultRefs lists each stored result a log points at, in order, once', () => {
    const log = [
      '[TOOL] readFile({}) → [digest of 5336 chars — full result: tool_results/tr-1-readback]',
      'Sections: Sources, Agenda',
      '[TOOL] readFile({}) → [excerpt of 9000 chars — digest unavailable; full result: tool_results/tr-2-template]',
      'excerpt',
      '[TOOL] readFile({}) → [digest of 5336 chars — full result: tool_results/tr-1-readback]',
      'again',
      '[TOOL] docs-cat({}) → a short result, kept whole',
    ].join('\n');
    assert.deepEqual(storedResultRefs(motorOutput(log)), ['tool_results/tr-1-readback', 'tool_results/tr-2-template']);
    assert.deepEqual(storedResultRefs('[digest of 10 chars — full result not stored]\nx'), [], 'an unstored result has no ref');
    assert.deepEqual(storedResultRefs(undefined), []);
  });

  it('an unreadable ref keeps its digest', async () => {
    const log = '[TOOL] x({}) → [digest of 10 chars — full result: tool_results/gone]\nkept';
    assert.match(await expandToolResults(motorOutput(log), { read: async () => null, budget: 9000 }), /kept/);
    assert.match(await expandToolResults(motorOutput(log), { read: async () => { throw new Error('404'); }, budget: 9000 }), /kept/);
  });

  it('full results live in the tool_results collection', () => {
    assert.equal(TOOL_RESULTS_COLLECTION, COLLECTIONS.toolResults);
  });
});

describe('the record policy', () => {
  it('defaults every bound, and takes each valid configured value', () => {
    assert.deepEqual(recordPolicy(undefined), { ...DEFAULT_RECORD_POLICY });
    const p = recordPolicy({ verbatim_chars: 6000, arg_chars: -1, digest_max_chars: 'big', store_full: false });
    assert.equal(p.verbatim_chars, 6000);
    assert.equal(p.arg_chars, DEFAULT_RECORD_POLICY.arg_chars, 'a non-positive value falls back');
    assert.equal(p.digest_max_chars, DEFAULT_RECORD_POLICY.digest_max_chars, 'a non-number falls back');
    assert.equal(p.store_full, false);
  });

  it('excerpt states its cut', () => {
    assert.equal(excerpt('short', 100), 'short');
    assert.match(excerpt('a'.repeat(200), 100), /\[… 100 of 200 chars omitted …\]/);
  });
});
