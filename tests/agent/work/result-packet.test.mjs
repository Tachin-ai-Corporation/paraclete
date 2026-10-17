// Tests for agent/work/result-packet.mjs. The defect under guard: a tool-agent result whose answer
// is the tool output (a read-only discovery) was summarized by eliding the whole tool log to a
// 53-character marker, so the cortex saw no data and re-planned to observe it again. When the prose
// outside the log is thin, the tool results are digested into the summary; when the prose is
// substantial (an edit or audit verdict), the log is still elided. The verifier gets an evidence
// pack that keeps every tool result, not a head+tail clip.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectShape, summarizeResult, buildResultPacket, digestToolResults, packToolEvidence,
} from '../../../agent/work/result-packet.mjs';

// A read-only discovery motor result: negligible prose; the data lives in the tool outputs.
const DISCOVERY = `I ran the requested discovery commands.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"gcloud iam service-accounts list"}) → EMAIL
svc-brain@your-gcp-project.iam.gserviceaccount.com
svc-mouth@your-gcp-project.iam.gserviceaccount.com
svc-ears@your-gcp-project.iam.gserviceaccount.com
[TOOL] system-shell({"cmd":"gcloud compute firewall-rules list --format='value(name)' | wc -l"}) → 7
[END TOOL LOG]`;

// An audit motor result: the answer is the prose verdict; the log is supporting noise.
const AUDIT = `Firebase hosting health audit complete. Findings: hosting is serving the live channel and returns HTTP 200 at the apex. The firebase.json rewrite to the Cloud Run backend resolves and the backend is reachable. TLS certificate is valid for 74 more days. No misconfiguration found; the site is healthy end to end and no action is required at this time.

---
[TOOL EXECUTION LOG]
[TOOL] system-shell({"cmd":"curl -sI https://site"}) → HTTP/2 200
[END TOOL LOG]`;

// A briefing read back from a finished document: its later sections sit well past character 500,
// where a record that cut every tool result at 500 characters lost them.
const BRIEFING = [
  'Weekly Executive Update - 2026-01-05',
  'Agenda-at-a-Glance',
  ...Array.from({ length: 6 }, (_, i) => `Segment ${i + 1}: weekly project updates for the client programs and the platform roadmap`),
  'State of the Week',
  ...Array.from({ length: 5 }, (_, i) => `Area ${i + 1}: discussion of progress, risks and what the team is waiting on this week`),
  'Decisions to Lock',
  'A new pricing model will be rolled out to all payers.',
  'Action Items',
  'Task | Owner | Due | Status',
  'Draft new requirements | Example Owner | not set | Not Started',
].join('\n');
const motorOutput = (log) => `Read the finished document back; every section has content.\n\n---\n[TOOL EXECUTION LOG]\n${log}\n[END TOOL LOG]`;

describe('detectShape', () => {
  it('classifies a tool-agent result by its [TOOL EXECUTION LOG] marker', () => {
    assert.equal(detectShape(DISCOVERY), 'tool-agent');
    assert.equal(detectShape(AUDIT), 'tool-agent');
  });
  it('classifies json-list and plain text', () => {
    assert.equal(detectShape('[{"id":"a"},{"id":"b"}]'), 'json-list');
    assert.equal(detectShape('{"files":[{"id":"a"}]}'), 'json-list');
    assert.equal(detectShape('just some prose'), 'text');
    assert.equal(detectShape('{not json'), 'text');
  });
});

describe('digestToolResults: keeps the tool results, not a marker', () => {
  it('surfaces each tool result within the budget', () => {
    const d = digestToolResults(DISCOVERY, 2000);
    assert.match(d, /svc-brain@your-gcp-project/, 'first command output survives');
    assert.match(d, /svc-ears@your-gcp-project/, 'later rows survive (not middle-dropped)');
    assert.match(d, /: 7\b/, 'the count result survives');
    assert.ok(d.length <= 2000, 'respects the budget');
  });

  it('returns empty when there is no tool log or the budget is tiny', () => {
    assert.equal(digestToolResults('no log here', 2000), '');
    assert.equal(digestToolResults(DISCOVERY, 10), '');
  });

  it('fills smallest first: a short read-back beside long listings is not cut to an even share', () => {
    const log = [
      `[TOOL] runCommand({}) → ${'L'.repeat(3000)}`,
      `[TOOL] runCommand({}) → ${BRIEFING}`,
      `[TOOL] runCommand({}) → ${'M'.repeat(3000)}`,
      `[TOOL] runCommand({}) → ${'N'.repeat(3000)}`,
    ].join('\n');
    const out = digestToolResults(motorOutput(log), 3000);
    assert.ok(out.includes('Decisions to Lock') && out.includes('Example Owner'), 'the short result keeps every character');
    assert.match(out, /…\[\+\d+ chars\]/, 'the long ones are cut, and the cut is stated');
  });
});

describe('summarizeResult(tool-agent): discovery keeps data, audit stays elided', () => {
  it('discovery: digests the data instead of collapsing to a bare elision marker', () => {
    const s = summarizeResult(DISCOVERY, { budget: 4000, minProse: 240 });
    assert.ok(s.length > 120, `the summary must carry data, got ${s.length} chars`);
    assert.match(s, /svc-brain@your-gcp-project/, 'the discovered data is in the summary');
    assert.doesNotMatch(s, /tool log elided:/, 'the answer is not elided to a marker');
  });

  it('audit: keeps the prose verdict and elides the log', () => {
    const s = summarizeResult(AUDIT, { budget: 4000, minProse: 240 });
    assert.match(s, /healthy end to end/, 'the prose verdict is the answer');
    assert.match(s, /tool log elided:/, 'substantial prose: the log is elided');
  });

  it('minProse governs the branch: a high threshold forces the digest path', () => {
    const forced = summarizeResult(AUDIT, { budget: 4000, minProse: 100000 });
    assert.doesNotMatch(forced, /tool log elided:/);
    assert.match(forced, /HTTP\/2 200/, 'the tool result is digested in');
  });

  it('respects the budget on a large discovery log', () => {
    const big = 'preamble\n\n---\n[TOOL EXECUTION LOG]\n'
      + Array.from({ length: 20 }, (_, i) => `[TOOL] shell({"cmd":"c${i}"}) → ${'X'.repeat(400)}row${i}`).join('\n')
      + '\n[END TOOL LOG]';
    const s = summarizeResult(big, { budget: 1200, minProse: 240 });
    // The clip keeps head and tail inside the budget and adds one "…[N chars elided]…" marker.
    assert.ok(s.length <= 1200 + 120, `must stay near the budget, got ${s.length}`);
    assert.ok(s.length < big.length, 'must shrink the 8KB+ original');
  });
});

describe('summarizeResult(json-list and text)', () => {
  it('renders the first items of a list by identity and counts the rest', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}`, name: `File ${i}`, type: 'doc' }));
    const s = summarizeResult(JSON.stringify({ files }), { topK: 3 });
    assert.match(s, /^10 item\(s\):/);
    assert.match(s, /1\. "File 0" · id=id-0 · doc/);
    assert.match(s, /\+7 more — full list at ref/);
  });

  it('clips plain text head and tail, stating the cut', () => {
    const s = summarizeResult(`${'a'.repeat(1000)}MIDDLE${'z'.repeat(1000)}`, { budget: 200 });
    assert.match(s, /^a+/);
    assert.match(s, /z+$/);
    assert.match(s, /chars elided — full content at ref/);
    assert.doesNotMatch(s, /MIDDLE/);
  });
});

describe('buildResultPacket', () => {
  it('a discovery packet carries data, not a 53-char marker', () => {
    const pkt = buildResultPacket({ text: DISCOVERY, ref: 'w-task-1', budget: 4000, minProse: 240 });
    assert.equal(pkt.kind, 'organ_result');
    assert.equal(pkt.shape, 'tool-agent');
    assert.equal(pkt.ref, 'w-task-1');
    assert.equal(pkt.bytes, DISCOVERY.length);
    assert.ok(pkt.summary.length > 120, `the packet summary must carry data, got ${pkt.summary.length}`);
    assert.match(pkt.summary, /svc-brain@your-gcp-project/);
  });

  it('defaults to no ref and an empty summary for no text', () => {
    assert.deepEqual(buildResultPacket(), { kind: 'organ_result', summary: '', ref: null, bytes: 0, shape: 'text' });
  });
});

describe("packToolEvidence: the verifier sees every task's tool results", () => {
  it('keeps each task label and its tool-result data within budget', () => {
    const items = [
      { step: '1.1', agent: 'motor', output: DISCOVERY },
      { step: '1.2', agent: 'motor', output: 'plain text conclusion for task two' },
    ];
    const ev = packToolEvidence(items, 4000);
    assert.match(ev, /\[1\.1\] motor:/, 'labels the first task');
    assert.match(ev, /svc-brain@your-gcp-project/, 'keeps the tool result');
    assert.match(ev, /\[1\.2\] motor:/, 'labels the second task');
    assert.match(ev, /conclusion for task two/, 'keeps a non-tool-agent task output too');
    assert.ok(ev.length <= 4000, 'respects the total budget');
  });

  it('a read-back the tool record kept whole reaches the verifier with every section', () => {
    const record = `[TOOL] runCommand({"command":"docs-cat 1ILSt"}) → ${BRIEFING}`;
    const evidence = packToolEvidence([{ step: 'T1', agent: 'motor', output: motorOutput(record) }], 6802);
    for (const h of ['Agenda-at-a-Glance', 'State of the Week', 'Decisions to Lock', 'Action Items', 'Example Owner']) {
      assert.ok(evidence.includes(h), `the verifier's evidence holds "${h}"`);
    }
    // Counterfactual: a record that cut every result at 500 characters loses the later sections.
    const cut = `[TOOL] runCommand({"command":"docs-cat 1ILSt"}) → ${BRIEFING.substring(0, 500)}`;
    const cutEvidence = packToolEvidence([{ step: 'T1', agent: 'motor', output: motorOutput(cut) }], 6802);
    assert.equal(cutEvidence.includes('Decisions to Lock'), false);
  });

  it('returns empty for no items or a tiny budget', () => {
    assert.equal(packToolEvidence([], 4000), '');
    assert.equal(packToolEvidence(null, 4000), '');
    assert.equal(packToolEvidence([{ step: '1.1', agent: 'motor', output: DISCOVERY }], 10), '');
  });
});
