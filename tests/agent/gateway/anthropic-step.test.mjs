// Tests for agent/gateway/anthropic-step.mjs: what reaches the Anthropic API. Cache breakpoints land
// where the layout says, tier hints never leave the gateway, and tool blocks pass through intact.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toContentParts } from '../../../agent/context/prompt-blocks.mjs';
import {
  cacheControl, toAnthropicMessages, applySessionBoundaryBreakpoint, anthropicSystem,
} from '../../../agent/gateway/anthropic-step.mjs';
import { runTurn } from '../../../agent/gateway/turn-loop.mjs';
import { fakeAnthropic, claudeCalls, claudeText, lookupTool, imageTool, fakePixels, quiet, noSleep } from './fakes.mjs';

const CLAUDE = 'vertex-anthropic/claude-opus-test';
const caching = { anthropic: { promptCaching: true, messageBreakpoints: true } };
const tiered = toContentParts([
  { label: 'BOOT', text: 'boot block', tier: 'boot' },
  { label: 'MISSION', text: 'mission block', tier: 'mission' },
  { label: 'WORKING STATE', text: 'iteration 3', tier: 'volatile' },
]);

/** Every key that appears anywhere in a JSON value. */
function keysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { found.add(k); keysIn(v, found); }
  }
  return found;
}

describe('the request after a tool call', () => {
  // The step after any Claude tool call: the assistant turn carries [text, tool_use] and the next user
  // turn [tool_result]. Rebuilding those as text parts sent a text block with no text, the provider
  // rejected the request, and every strong-tier tool turn fell back to another model.
  it('keeps tool_use and tool_result blocks intact while placing cache breakpoints', async () => {
    const anthropic = fakeAnthropic([
      claudeCalls([{ id: 'toolu_1', name: 'lookup', input: { key: 'alpha' } }], { text: 'Reading it.' }),
      claudeText('value-42'),
    ]);
    await runTurn({
      clients: { anthropic }, model: CLAUDE, systemBlocks: ['stable', 'memory'],
      messages: [{ role: 'user', content: tiered }], tools: { lookup: lookupTool() },
      settings: caching, logger: quiet, sleep: noSleep,
    });
    const { params } = anthropic.requests[1];
    const [first, assistant, result] = params.messages;

    assert.deepEqual(first.content.map((p) => p.cache_control), [
      { type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h' }, undefined,
    ], 'boot and mission parts cached, the volatile tail not');
    assert.deepEqual(assistant.content, [
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { key: 'alpha' } },
    ]);
    assert.deepEqual(result.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'value-42' }]);
    assert.equal(keysIn(params).has('tier'), false, 'no tier hint reaches the provider');
    assert.deepEqual(params.system, [
      { type: 'text', text: 'stable', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'memory' },
    ], 'the system breakpoint sits on the stable block only');
  });

  it('sends a tool image inside its tool_result as a base64 image block, intact under cache breakpoints', async () => {
    const anthropic = fakeAnthropic([
      claudeCalls([{ id: 'toolu_7', name: 'viewImage', input: { path: 'chart.png' } }]),
      claudeText('The bars rise left to right.'),
    ]);
    await runTurn({
      clients: { anthropic }, model: CLAUDE, systemBlocks: ['stable'],
      messages: [{ role: 'user', content: tiered }], tools: { viewImage: imageTool() },
      settings: caching, logger: quiet, sleep: noSleep,
    });
    const { params } = anthropic.requests[1];
    assert.deepEqual(params.messages[2], {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_7',
        content: [
          { type: 'text', text: 'Viewing chart.png: PNG, 2x2 px, 70 bytes. The image is attached to this result.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fakePixels('chart.png') } },
        ],
      }],
    });
    assert.equal(keysIn(params).has('tier'), false);
    assert.equal(keysIn(params.messages[2]).has('cache_control'), false, 'no breakpoint lands on the tool result');
  });

  it('strips tier hints when caching is off, and joins the system blocks', async () => {
    const anthropic = fakeAnthropic([claudeText('ok')]);
    await runTurn({
      clients: { anthropic }, model: CLAUDE, systemBlocks: ['stable', 'memory'],
      messages: [{ role: 'user', content: tiered }], logger: quiet, sleep: noSleep,
    });
    const { params } = anthropic.requests[0];
    assert.equal(keysIn(params).has('tier'), false);
    assert.equal(keysIn(params).has('cache_control'), false);
    assert.equal(params.system, 'stable\nmemory');
    assert.equal(params.tools, undefined, 'no tools declared for a toolless organ');
  });

  it('places one rolling breakpoint at the session boundary on a continue', async () => {
    const anthropic = fakeAnthropic([claudeText('ok')]);
    await runTurn({
      clients: { anthropic }, model: CLAUDE, systemBlocks: ['stable'],
      messages: [
        { role: 'user', content: tiered },
        { role: 'assistant', content: '{"action":"plan"}' },
        { role: 'user', content: [{ type: 'text', text: 'delta', tier: 'volatile' }] },
      ],
      sessionCacheBoundary: 2, settings: caching, logger: quiet, sleep: noSleep,
    });
    const [open, decision, delta] = anthropic.requests[0].params.messages;
    assert.equal(keysIn(open).has('cache_control'), false, 'the open turn gets no layout breakpoints on a continue');
    assert.deepEqual(decision.content, [{ type: 'text', text: '{"action":"plan"}', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    assert.deepEqual(delta.content, [{ type: 'text', text: 'delta' }]);
  });

  it('sends the session-affinity header only when turned on', async () => {
    const off = fakeAnthropic([claudeText('ok')]);
    await runTurn({ clients: { anthropic: off }, model: CLAUDE, messages: [{ role: 'user', content: 'q' }], affinityKey: 'gateway-cortex-1', logger: quiet });
    assert.equal(off.requests[0].options, undefined);
    const on = fakeAnthropic([claudeText('ok')]);
    await runTurn({
      clients: { anthropic: on }, model: CLAUDE, messages: [{ role: 'user', content: 'q' }], affinityKey: 'gateway-cortex-1',
      settings: { anthropic: { sessionAffinity: true } }, logger: quiet,
    });
    assert.deepEqual(on.requests[0].options, { headers: { 'X-Vertex-Ai-Session-Id': 'gateway-cortex-1' } });
  });
});

describe('pieces', () => {
  it('cacheControl leaves out the default 5m ttl', () => {
    assert.deepEqual(cacheControl('5m'), { type: 'ephemeral' });
    assert.deepEqual(cacheControl('1h'), { type: 'ephemeral', ttl: '1h' });
  });

  it('toAnthropicMessages turns tool results into user tool_result turns, objects as JSON', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
      { role: 'tool', toolCallId: 'c1', name: 'x', content: { verdict: 'PASS' } },
    ]);
    assert.deepEqual(out, [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"verdict":"PASS"}' }] },
    ]);
  });

  it('toAnthropicMessages leaves out an empty text block beside an image', () => {
    const [msg] = toAnthropicMessages([
      { role: 'tool', toolCallId: 'c1', name: 'shot', content: '', images: [{ mimeType: 'image/webp', data: 'UklG' }] },
    ]);
    assert.deepEqual(msg.content[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklG' } }]);
  });

  it('a session boundary on a string turn wraps it as one cached text block', () => {
    const msgs = [{ role: 'user', content: 'open' }, { role: 'assistant', content: 'decision' }];
    applySessionBoundaryBreakpoint(msgs, 1, { ttlMission: '5m' });
    assert.deepEqual(msgs[0].content, [{ type: 'text', text: 'open', cache_control: { type: 'ephemeral' } }]);
    assert.equal(msgs[1].content, 'decision');
  });

  it('anthropicSystem leaves the field out when there is no system text', () => {
    assert.equal(anthropicSystem([], { promptCaching: true, cacheTtlStable: '1h' }), undefined);
  });
});
