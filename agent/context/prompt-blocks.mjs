// agent/context/prompt-blocks.mjs: assembles a prompt from blocks ordered most stable first, so model
// providers can cache the stable prefix. Pure functions: no I/O, no clock, no network. It does not
// call a model; the gateway turns the blocks into a provider request. Used by the brain, which builds
// the blocks, and the gateway, which places cache breakpoints.
//
// A block is { label, text, tier }, where tier is one of:
//   'boot'     stable for the gateway process's lifetime (skill index, guidance)
//   'mission'  stable for one mission (envelope statics, project, memory)
//   'volatile' changes on every call (iteration, working state, prior results)
//
// The brain orders blocks boot, mission, volatile. The gateway sends them to Claude as content parts
// with cache_control on part boundaries (longer cache lifetimes strictly earlier, as the API
// requires), and to Gemini as one string, whose implicit caching rewards the same byte order for
// free. Rendering is byte-deterministic: same blocks in, same bytes out. That property is the cache
// key, and it means a cached prefix can never serve stale content, because the prefix is the content.
//
// Providers cache only prefixes above a minimum size: measured at about 4,096 tokens for Claude Opus
// and about 2,048 for Gemini. A smaller block is silently uncached; estimateTokens() feeds the
// telemetry that explains those misses.

const TIERS = ['boot', 'mission', 'volatile'];

/**
 * Characters / 4. For cache-floor and threshold telemetry only, never for billing.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function renderBlock(b) {
  const label = (b.label || '').trim();
  return label ? `[${label}]\n${b.text}` : b.text;
}

/**
 * Renders blocks as one string: the Gemini shape. Empty blocks are dropped.
 *
 * @param {Array<{label?: string, text: string, tier?: string}>} blocks
 * @returns {string}
 */
export function renderBlocks(blocks) {
  return blocks
    .filter((b) => b && typeof b.text === 'string' && b.text.length > 0)
    .map(renderBlock)
    .join('\n\n');
}

/**
 * Merges blocks into at most one content part per tier, ordered boot, mission, volatile; a block with
 * no tier counts as volatile and empty tiers are dropped. The parts are renderBlocks()'s bytes split
 * at tier boundaries: joining them with '\n\n' gives exactly renderBlocks(blocks).
 *
 * @param {Array<{label?: string, text: string, tier?: string}>} blocks
 * @returns {Array<{type: 'text', text: string, tier: string}>}
 */
export function toContentParts(blocks) {
  const present = blocks.filter((b) => b && typeof b.text === 'string' && b.text.length > 0);
  const parts = [];
  for (const tier of TIERS) {
    const tierBlocks = present.filter((b) => (b.tier || 'volatile') === tier);
    if (tierBlocks.length === 0) continue;
    parts.push({ type: 'text', text: tierBlocks.map(renderBlock).join('\n\n'), tier });
  }
  return parts;
}

/**
 * Where to put Anthropic cache_control breakpoints on a message's content parts. An off-by-one here
 * makes the provider reject the request, and every cortex call silently lands on the fallback model,
 * so the rules are fixed and tested:
 *   - never a breakpoint on the last part (the volatile tail), and never on a volatile part;
 *   - at most (maxBreakpoints - systemBreakpointsUsed) breakpoints;
 *   - cache lifetime by tier: boot gets ttlStable, mission gets ttlMission. Longer lifetimes must come
 *     earlier, which the boot-then-mission order already satisfies.
 *
 * @param {Array<{tier: string}>} parts output of toContentParts()
 * @param {object} [cfg]
 * @param {number} [cfg.maxBreakpoints=4] the provider's limit
 * @param {number} [cfg.systemBreakpointsUsed=1]
 * @param {string} [cfg.ttlStable='1h']
 * @param {string} [cfg.ttlMission='1h']
 * @returns {Array<{index: number, ttl: string}>} breakpoints by part index
 */
export function computeBreakpointLayout(parts, {
  maxBreakpoints = 4,
  systemBreakpointsUsed = 1,
  ttlStable = '1h',
  ttlMission = '1h',
} = {}) {
  const budget = Math.max(0, maxBreakpoints - systemBreakpointsUsed);
  const ttlFor = (tier) => (tier === 'boot' ? ttlStable : ttlMission);
  const out = [];
  for (let i = 0; i < parts.length - 1 && out.length < budget; i++) {
    const tier = parts[i].tier || 'volatile';
    if (tier === 'volatile') break;
    out.push({ index: i, ttl: ttlFor(tier) });
  }
  return out;
}

/**
 * The API shape of one Anthropic content block. A text part is rebuilt bare, which strips the brain's
 * `tier` hint so nothing outside the API reaches the provider. Every other block (tool_use,
 * tool_result) passes through unchanged: rebuilding one as a text part drops its payload, and the
 * provider then rejects the whole request on the step after any tool call.
 *
 * @param {{type?: string, text?: string}} part
 * @returns {object}
 */
export function apiContentBlock(part) {
  if (part && part.type && part.type !== 'text') return part;
  return { type: 'text', text: part?.text };
}

/**
 * Whether every block of an array-content message is a text part. Tells the brain's tiered payload
 * apart from a tool_result turn.
 *
 * @param {*} content
 * @returns {boolean}
 */
export function isTextOnly(content) {
  return Array.isArray(content) && content.every((p) => !p?.type || p.type === 'text');
}
