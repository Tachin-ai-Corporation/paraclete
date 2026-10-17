// Tests for agent/context/prompt-blocks.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBlocks, toContentParts, computeBreakpointLayout, estimateTokens, apiContentBlock, isTextOnly,
} from '../../../agent/context/prompt-blocks.mjs';

const blocks = [
  { label: 'BOOT-STABLE CONTEXT', text: '{"skill_index":[]}', tier: 'boot' },
  { label: 'MISSION CONTEXT', text: '{"envelope":"m-1"}', tier: 'mission' },
  { label: 'WORKING STATE', text: '{"iteration":3}', tier: 'volatile' },
];

describe('renderBlocks and toContentParts', () => {
  it('parts joined with \\n\\n equal the rendered string (the cache-key invariant)', () => {
    assert.equal(toContentParts(blocks).map((p) => p.text).join('\n\n'), renderBlocks(blocks));
  });

  it('labels a block, and renders an unlabeled one bare', () => {
    assert.equal(renderBlocks([{ label: 'A', text: 'a' }, { text: 'b' }]), '[A]\na\n\nb');
  });

  it('drops empty blocks and tiers', () => {
    const parts = toContentParts([
      { label: 'A', text: '', tier: 'boot' },
      { label: 'B', text: 'body', tier: 'volatile' },
    ]);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].tier, 'volatile');
  });

  it('merges same-tier blocks into one part, ordered boot, mission, volatile', () => {
    const parts = toContentParts([
      { label: 'W', text: 'w', tier: 'volatile' },
      { label: 'B1', text: 'b1', tier: 'boot' },
      { label: 'B2', text: 'b2', tier: 'boot' },
      { label: 'M', text: 'm', tier: 'mission' },
    ]);
    assert.deepEqual(parts.map((p) => p.tier), ['boot', 'mission', 'volatile']);
    assert.ok(parts[0].text.includes('b1') && parts[0].text.includes('b2'));
  });

  it('is byte-deterministic: same input, same output', () => {
    assert.equal(renderBlocks(blocks), renderBlocks(blocks.map((b) => ({ ...b }))));
  });
});

describe('computeBreakpointLayout', () => {
  it('places breakpoints on boot and mission parts, never the last part', () => {
    const bps = computeBreakpointLayout(toContentParts(blocks), { systemBreakpointsUsed: 1 });
    assert.deepEqual(bps.map((b) => b.index), [0, 1]);
  });

  it('assigns the cache lifetime by tier', () => {
    const bps = computeBreakpointLayout(toContentParts(blocks), { ttlStable: '1h', ttlMission: '5m' });
    assert.equal(bps[0].ttl, '1h');
    assert.equal(bps[1].ttl, '5m');
  });

  it('respects the 4-breakpoint provider cap minus what the system prompt uses', () => {
    const bps = computeBreakpointLayout(toContentParts(blocks), { maxBreakpoints: 4, systemBreakpointsUsed: 3 });
    assert.equal(bps.length, 1);
  });

  it('never emits a breakpoint with no budget', () => {
    assert.deepEqual(computeBreakpointLayout(toContentParts(blocks), { maxBreakpoints: 1, systemBreakpointsUsed: 1 }), []);
  });

  it('never caches a volatile part, even with budget left', () => {
    const parts = toContentParts([
      { label: 'B', text: 'b', tier: 'boot' },
      { label: 'V1', text: 'v1', tier: 'volatile' },
      { label: 'V2', text: 'v2', tier: 'volatile' },
    ]);
    assert.deepEqual(computeBreakpointLayout(parts, { systemBreakpointsUsed: 0 }).map((b) => b.index), [0]);
  });

  it('gives a single-part message no breakpoints', () => {
    assert.deepEqual(computeBreakpointLayout(toContentParts([{ label: 'V', text: 'v', tier: 'volatile' }])), []);
  });
});

describe('estimateTokens', () => {
  it('is characters / 4', () => {
    assert.equal(estimateTokens('x'.repeat(4096 * 4)), 4096);
    assert.equal(estimateTokens(''), 0);
  });
});

// On the step after a Claude tool call, the assistant turn carries [text, tool_use] and the next user
// turn [tool_result]. Rebuilding those as text parts sent a text block with no text, and the provider
// rejected every strong-tier tool turn, which then fell back to the fallback model.
describe('apiContentBlock: what reaches the Anthropic API', () => {
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'readFile', input: { path: '/x' } };
  const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'body' };

  it('passes tool_use and tool_result blocks through unchanged', () => {
    assert.equal(apiContentBlock(toolUse), toolUse);
    assert.equal(apiContentBlock(toolResult), toolResult);
  });

  it('strips the tier hint from a text part and keeps its text', () => {
    assert.deepEqual(apiContentBlock({ type: 'text', text: 'hi', tier: 'boot' }), { type: 'text', text: 'hi' });
    assert.deepEqual(apiContentBlock({ text: 'hi', tier: 'mission' }), { type: 'text', text: 'hi' });
  });

  it('an assistant tool turn keeps every block its own payload', () => {
    const out = [{ type: 'text', text: 'Reading both files.' }, toolUse].map(apiContentBlock);
    assert.deepEqual(out, [{ type: 'text', text: 'Reading both files.' }, toolUse]);
    for (const b of out) if (b.type === 'text') assert.equal(typeof b.text, 'string');
  });

  it('isTextOnly tells the brain payload from a tool_result turn', () => {
    assert.equal(isTextOnly([{ type: 'text', text: 'a', tier: 'boot' }, { type: 'text', text: 'b' }]), true);
    assert.equal(isTextOnly([toolResult]), false);
    assert.equal(isTextOnly([{ type: 'text', text: 'a' }, toolUse]), false);
    assert.equal(isTextOnly('a string turn'), false);
  });
});
