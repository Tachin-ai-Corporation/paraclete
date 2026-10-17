// Tests for agent/context/compaction.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepCheckpointNum, renderCheckpointDigest, buildPriorWorkContext, shouldCompact, splitIterationBlocks,
  redactSecrets, validateMissionDigest, missionDigestInstruction, spliceCompacted,
} from '../../../agent/context/compaction.mjs';

describe('stepCheckpointNum', () => {
  it('extracts the checkpoint prefix', () => {
    assert.equal(stepCheckpointNum('2.3'), 2);
    assert.equal(stepCheckpointNum('10.1'), 10);
  });

  it('returns null without a prefix', () => {
    assert.equal(stepCheckpointNum('nope'), null);
    assert.equal(stepCheckpointNum(undefined), null);
    assert.equal(stepCheckpointNum(3), null);
  });
});

describe('renderCheckpointDigest', () => {
  const results = [
    { step: '1.1', agent: 'motor', success: true, result: 'built the report and saved it' },
    { step: '1.2', agent: 'cerebellum', success: false, result: 'criteria unmet: missing totals' },
  ];

  it('includes the acceptance criteria word for word', () => {
    const criteria = 'Totals MUST match the ledger exactly; no rounding.';
    assert.ok(renderCheckpointDigest({ cpNum: 1, acceptCriteria: criteria, results }).includes(criteria));
  });

  it('carries per-step verdicts and excerpts', () => {
    const d = renderCheckpointDigest({ cpNum: 1, results });
    assert.ok(d.includes('Step 1.1 (motor): SUCCESS'));
    assert.ok(d.includes('Step 1.2 (cerebellum): FAILED'));
  });

  it('includes a recovery pointer when a mission id is given', () => {
    assert.ok(renderCheckpointDigest({ cpNum: 1, results, missionId: 'm-abc' }).includes('mission m-abc'));
  });

  it('caps the excerpts and the whole digest', () => {
    const big = [{ step: '1.1', agent: 'motor', success: true, result: 'x'.repeat(50_000) }];
    const d = renderCheckpointDigest({ cpNum: 1, results: big, excerptChars: 100, capChars: 4000 });
    assert.ok(d.length <= 4100); // cap plus the truncation marker
  });
});

describe('buildPriorWorkContext', () => {
  const checkpoints = [
    { instruction: 'Gather data', accept_criteria: 'All sources fetched' },
    { instruction: 'Build report', accept_criteria: 'Report complete' },
  ];
  const allResults = [
    { step: '1.1', agent: 'motor', success: true, result: 'fetched A '.repeat(200) },
    { step: '1.2', agent: 'motor', success: true, result: 'fetched B '.repeat(200) },
  ];
  const cpResults = [{ step: '2.1', agent: 'motor', success: true, result: 'drafted section one' }];

  it('returns undefined with no prior work', () => {
    assert.equal(buildPriorWorkContext({ checkpoints, allResults: [], cpResults: [], currentCpNum: 1 }), undefined);
  });

  it('digests finished checkpoints and keeps the current one word for word', () => {
    const out = buildPriorWorkContext({ checkpoints, allResults, cpResults, currentCpNum: 2, stepChars: 8000 });
    assert.ok(out.includes('[CHECKPOINT 1 DIGEST'));
    assert.ok(out.includes('All sources fetched'));
    assert.ok(out.includes('drafted section one'));
    assert.ok(!out.includes('[CHECKPOINT 2 DIGEST'));
  });

  it('reads instruction and criteria from a stamped checkpoint envelope', () => {
    const stamped = [{ cEnvelope: { instruction: 'Gather data', accept_criteria: 'Every source fetched' } }];
    const out = buildPriorWorkContext({ checkpoints: stamped, allResults, cpResults, currentCpNum: 2 });
    assert.ok(out.includes('[CHECKPOINT 1 DIGEST — Gather data]'));
    assert.ok(out.includes('Every source fetched'));
  });

  it('is far smaller than the doubled word-for-word transcript it replaces', () => {
    const bigResults = [];
    for (let cp = 1; cp <= 3; cp++) {
      for (let t = 1; t <= 3; t++) bigResults.push({ step: `${cp}.${t}`, agent: 'motor', success: true, result: 'y'.repeat(8000) });
    }
    const out = buildPriorWorkContext({
      checkpoints: [{}, {}, {}, {}], allResults: bigResults, cpResults: [], currentCpNum: 4, stepChars: 8000, digestChars: 4000,
    });
    // Word for word, twice, was 2 × 9 × 8000 = 144,000 chars; three digests cap at 3 × 4000.
    assert.ok(out.length <= 3 * 4000 + 200);
  });

  it('keeps results without a checkpoint prefix word for word (crash-resume shapes)', () => {
    const out = buildPriorWorkContext({
      checkpoints,
      allResults: [{ step: 'legacy', agent: 'motor', success: true, result: 'legacy result' }],
      cpResults: [],
      currentCpNum: 2,
      stepChars: 8000,
    });
    assert.ok(out.includes('legacy result'));
  });
});

describe('shouldCompact', () => {
  const cfg = { working_budget_tokens: 80000, trigger_pct: 0.7, min_compactable_tokens: 8000, max_compactions_per_mission: 3 };

  it('fires above the threshold', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 60000, accumulatedChars: 200000, compactionsSoFar: 0, cfg }).compact, true);
  });

  it('declines below the threshold', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 20000, accumulatedChars: 40000, compactionsSoFar: 0, cfg }).compact, false);
  });

  it('uses characters / 4 when there is no real token count', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 0, accumulatedChars: 60000 * 4, compactionsSoFar: 0, cfg }).compact, true);
  });

  it('respects the compaction cap and the disabled flag', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 90000, accumulatedChars: 400000, compactionsSoFar: 3, cfg }).reason, 'max_compactions');
    assert.equal(shouldCompact({ lastRealPromptTokens: 90000, accumulatedChars: 400000, compactionsSoFar: 0, cfg: { ...cfg, enabled: false } }).reason, 'disabled');
  });

  it('declines when the accumulated context itself is small', () => {
    assert.equal(shouldCompact({ lastRealPromptTokens: 90000, accumulatedChars: 1000, compactionsSoFar: 0, cfg }).reason, 'below_min');
  });
});

describe('splitIterationBlocks and spliceCompacted', () => {
  const acc = [
    'MISSION HEAD framing',
    '--- Iteration 1 ---\nwork one',
    '--- Iteration 2 ---\nwork two',
    '--- Iteration 3 ---\nwork three',
    '--- Iteration 4 ---\nwork four',
  ].join('\n\n');

  it('splits the head from the iteration blocks', () => {
    const { head, blocks } = splitIterationBlocks(acc);
    assert.equal(head, 'MISSION HEAD framing');
    assert.equal(blocks.length, 4);
  });

  it('keeps the criteria word for word, and the digest survives a second split (pinned)', () => {
    const digest = {
      covered_iterations: '1..2',
      decisions: [{ iteration: 1, action: 'checkpoint_plan', target: 'motor', outcome: 'done' }],
      claims: [{ text: 'report built', bin: 'verified', source: 'step 1.1' }],
      open_questions: ['totals unconfirmed'],
      artifacts: [],
      durable_learnings: ['the export link expires within the hour'],
    };
    const { head, blocks } = splitIterationBlocks(acc);
    const criteria = 'Totals MUST match the ledger exactly.';
    const out = spliceCompacted({ head, keptBlocks: blocks.slice(-2), digest, seq: 1, instruction: 'Build the report', acceptCriteria: criteria });
    assert.ok(out.includes('[CONTEXT COMPACTED — seq 1'));
    assert.ok(out.includes(criteria));
    assert.ok(out.includes('Mission instruction (verbatim): Build the report'));
    assert.ok(out.includes('work three') && out.includes('work four'));
    assert.ok(!out.includes('work one'));
    // The next split folds the digest into the head, so later compactions and the fallback prune
    // can never evict it.
    const again = splitIterationBlocks(out);
    assert.ok(again.head.includes('[CONTEXT COMPACTED — seq 1'));
    assert.equal(again.blocks.length, 2);
  });
});

describe('validateMissionDigest', () => {
  it('accepts a well-formed digest', () => {
    assert.equal(validateMissionDigest({ decisions: [], claims: [{ text: 'x', bin: 'assumed' }], open_questions: [] }).valid, true);
  });

  it('rejects a claim without its bin, and a decision-shaped object', () => {
    assert.equal(validateMissionDigest({ decisions: [], claims: [{ text: 'x' }], open_questions: [] }).valid, false);
    assert.equal(validateMissionDigest({ action: 'synthesize', summary: 'narrative' }).valid, false);
    assert.equal(validateMissionDigest({ error: 'parse_failed', raw: '' }).valid, false);
  });

  it('the digest instruction demands the bins', () => {
    assert.match(missionDigestInstruction(), /Every claim MUST carry its epistemic bin/);
  });
});

describe('redactSecrets', () => {
  it('scrubs token shapes', () => {
    const dirty = 'a ya29.AbCdEf-123 b AIzaSyA12345678901234567890123456789012 c ghp_abcdefghijklmnopqrstu d Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjEi';
    const clean = redactSecrets(dirty);
    assert.ok(!clean.includes('ya29.A'));
    assert.ok(!clean.includes('AIzaSy'));
    assert.ok(!clean.includes('ghp_'));
    assert.ok(!clean.includes('eyJhbGciOiJSUzI1NiIsImtpZCI6IjEi'));
  });
});
