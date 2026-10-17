// agent/work/result-packet.mjs: shape-aware summaries of one organ's output for another organ, and
// the bounded evidence pack the verifier judges. A result crosses as a packet, {kind, summary, ref},
// never as a blind character clip: the summary stays in the prompt and the full content is fetched
// by ref only on demand. Pure and deterministic: no I/O, no config. Recording tool calls is
// agent/context/tool-record.mjs's job. Called by the checkpoint executor.
//
// The defect this replaces: the cortex (the organ that decides the next step) was fed a head+tail
// clip of each result, which drops the middle, exactly where a list's rows or a tool log's data
// live. It saw "the first item" then nothing, judged the result incomplete, and dispatched the
// same work again. A shape-aware summary keeps the answer, not an arbitrary slice.

const DEFAULT_BUDGET = 1200;   // chars for the summary body; default, callers pass the contracts value
const DEFAULT_TOPK = 8;        // list items rendered before eliding the tail
const DEFAULT_MINPROSE = 240;  // tool-agent prose below this: the tool results are the answer, digest them

// Head+tail clip with a middle marker: the last-resort shape for opaque prose. Kept local so this
// module has no imports.
function clip(text, budget) {
  const t = String(text || '');
  if (t.length <= budget) return t;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return t.slice(0, head) + `\n…[${t.length - budget} chars elided — full content at ref]…\n` + t.slice(t.length - tail);
}

// Find the primary array inside a parsed JSON value: the value itself if it is an array, else the
// first array-valued property (files/items/results/…, the common list wrappers).
function primaryArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of ['files', 'items', 'results', 'entries', 'rows', 'data', 'messages', 'events']) {
      if (Array.isArray(v[k])) return v[k];
    }
    for (const val of Object.values(v)) if (Array.isArray(val)) return val;
  }
  return null;
}

/** Classify a result so it is summarized the way it is actually shaped. */
export function detectShape(text) {
  const t = String(text || '');
  if (/\[TOOL EXECUTION LOG\]/.test(t)) return 'tool-agent';
  const trimmed = t.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      if (primaryArray(JSON.parse(trimmed)) !== null) return 'json-list';
    } catch { /* not clean JSON: fall through */ }
  }
  return 'text';
}

// One compact line per list item: prefer human-meaningful identity fields, fall back to a bounded
// JSON of the whole item.
function renderItem(it) {
  if (it && typeof it === 'object') {
    const id = it.id || it.fileId || it.name || '';
    const label = it.name || it.title || it.subject || '';
    const extra = it.shared || it.modified || it.type || it.owner || '';
    const parts = [label && `"${label}"`, id && id !== label && `id=${id}`, extra && String(extra)].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    return clip(JSON.stringify(it), 160);
  }
  return clip(String(it), 160);
}

function summarizeList(text, topK, budget) {
  let arr;
  try { arr = primaryArray(JSON.parse(text.trim())); } catch { arr = null; }
  if (!arr) return clip(text, budget);
  const shown = arr.slice(0, topK).map((it, i) => `${i + 1}. ${renderItem(it)}`);
  const more = arr.length > topK ? `\n…(+${arr.length - topK} more — full list at ref)` : '';
  const body = `${arr.length} item(s):\n${shown.join('\n')}${more}`;
  // A list summary is already compact; only clip if a few wide rows blew the budget.
  return body.length > budget ? clip(body, budget) : body;
}

// The prose an agent writes outside its [TOOL EXECUTION LOG] block: the answer for most tool-agent
// results (an edit confirmation, an audit verdict). Returned trimmed.
function proseOutsideToolLog(text) {
  return String(text || '').replace(/\[TOOL EXECUTION LOG\][\s\S]*?(?:\[END TOOL LOG\]|$)/g, '').trim();
}

/**
 * Digest the [TOOL EXECUTION LOG] into its results, packed into `budget`.
 *
 * Each entry is `[TOOL] name(args) → result`, where the result is the gateway's record of the
 * call (agent/context/tool-record.mjs): word for word up to the record policy's verbatim bound,
 * else a digest plus a ref. When the tool results are the answer (a discovery mission enumerating
 * data, or a read-back the verifier must confirm) they must be kept, not elided to a marker. This
 * splits per call, drops the argument noise, and fills the budget smallest first: as many results
 * as fit are kept whole, and the rest share what remains. A short read-back is never cut to make
 * room for an even split with long listings (those carry a digest and ref anyway). A cut is
 * stated. Returns '' when there is nothing to digest.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
export function digestToolResults(text, budget) {
  const block = (String(text || '').match(/\[TOOL EXECUTION LOG\]([\s\S]*?)(?:\[END TOOL LOG\]|$)/) || [])[1] || '';
  if (!block.trim() || budget < 48) return '';
  // Split before each `[TOOL] ` marker (lookahead) so a multi-line result stays with its call.
  const entries = block.split(/(?=\[TOOL\]\s)/).map((s) => s.trim()).filter((s) => s.startsWith('[TOOL]'));
  if (entries.length === 0) return '';
  const parsed = entries.map((e) => {
    const body = e.replace(/^\[TOOL\]\s*/, '');
    const arrow = body.indexOf('→');
    const name = (arrow >= 0 ? body.slice(0, arrow) : body).split('(')[0].trim().slice(0, 48);
    const result = (arrow >= 0 ? body.slice(arrow + 1) : '').trim() || '(no output)';
    return { prefix: `• ${name}: `, result };
  });
  const fixed = parsed.reduce((n, p) => n + p.prefix.length, 0) + (parsed.length - 1);
  let remaining = Math.max(48 * parsed.length, budget - fixed);
  const alloc = parsed.map(() => 0);
  const order = parsed.map((_, i) => i).sort((a, b) => parsed[a].result.length - parsed[b].result.length || a - b);
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k];
    const reserve = 48 * (order.length - k - 1); // a floor for every result still to place
    if (parsed[i].result.length <= remaining - reserve) {
      alloc[i] = parsed[i].result.length;
      remaining -= alloc[i];
      continue;
    }
    // This result and every longer one share what is left.
    const rest = order.slice(k);
    const share = Math.max(48, Math.floor(remaining / rest.length));
    for (const j of rest) alloc[j] = share;
    break;
  }
  const lines = parsed.map((p, i) => {
    const cap = Math.max(48, alloc[i]);
    if (p.result.length <= cap) return p.prefix + p.result;
    const keep = Math.max(24, cap - 24);
    return `${p.prefix}${p.result.slice(0, keep).trimEnd()}…[+${p.result.length - keep} chars]`;
  });
  const out = lines.join('\n');
  return out.length > budget ? clip(out, budget) : out;
}

// Summarize a tool-agent result for an organ's decide or plan step. Two shapes:
//  - substantial prose: keep it and elide the log to a one-line marker (economy; the answer is
//    the prose, an edit or audit verdict). The common case.
//  - thin prose: the tool results are the answer; digest them into the budget.
// The defect this fixes: a read-only discovery mission's output is almost all tool log with
// negligible prose, so unconditional elision collapsed a 2.6KB result to a 53-char
// "[tool log elided]" marker. The cortex saw no data, could not synthesize, and re-planned to
// re-observe a result it already had (52 calls and 1.4M tokens on one mission).
function summarizeToolAgent(text, budget, minProse) {
  const t = String(text);
  const prose = proseOutsideToolLog(t);
  const toolCount = (t.match(/\[TOOL\]/g) || []).length;
  if (toolCount === 0) return prose.length > budget ? clip(prose, budget) : prose;
  if (prose.length >= minProse) {
    const body = `${prose}${prose ? '\n' : ''}[tool log elided: ${toolCount} tool call(s) — full at ref]`;
    return body.length > budget ? clip(body, budget) : body;
  }
  const header = prose ? `${prose}\n` : '';
  const label = `${toolCount} tool call(s) — result digest (full at ref):`;
  const digest = digestToolResults(t, Math.max(48, budget - header.length - label.length - 2));
  const body = digest ? `${header}${label}\n${digest}` : `${header}[tool log — ${toolCount} call(s), full at ref]`;
  return body.length > budget ? clip(body, budget) : body;
}

/**
 * Pack several task outputs into a bounded evidence string for the verifier, keeping each task's
 * tool results. Verification re-derives from the tool outputs, so a head+tail clip (which drops
 * the middle, where a command's result sits) is the wrong reducer: one mission failed "no gcloud
 * command was executed" for a command that ran but was cut out of view. Each item is
 * {step, agent, output}; each gets a fair share of the budget, shape-reduced (tool-agent: prose
 * plus result digest; otherwise clipped).
 *
 * @param {Array<{step: string, agent: string, output: string}>} items
 * @param {number} budget
 * @returns {string}
 */
export function packToolEvidence(items, budget) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (list.length === 0 || budget < 80) return '';
  const per = Math.max(160, Math.floor(budget / list.length));
  const blocks = list.map((it) => {
    const head = `- [${it.step}] ${it.agent}:`;
    const out = String(it.output || '');
    let reduced;
    if (detectShape(out) === 'tool-agent') {
      const prose = proseOutsideToolLog(out);
      const digest = digestToolResults(out, Math.max(96, per - prose.length - head.length));
      reduced = [prose, digest].filter(Boolean).join('\n') || out.slice(0, per);
    } else {
      reduced = out.length > per ? clip(out, per) : out;
    }
    return `${head} ${reduced}`;
  });
  const joined = blocks.join('\n');
  return joined.length > budget ? clip(joined, budget) : joined;
}

/** Shape-aware summary of a result. Deterministic; safe on any string. */
export function summarizeResult(text, { budget = DEFAULT_BUDGET, topK = DEFAULT_TOPK, minProse = DEFAULT_MINPROSE } = {}) {
  const t = String(text || '');
  const shape = detectShape(t);
  if (shape === 'json-list') return summarizeList(t, topK, budget);
  if (shape === 'tool-agent') return summarizeToolAgent(t, budget, minProse);
  return clip(t, budget);
}

/**
 * Build the inter-organ packet: {kind, summary, ref, bytes, shape}. `kind` is always
 * 'organ_result'; `ref` is the caller's stable handle to the full artifact (a task envelope id
 * the brain can read back, or a file path), null when there is none.
 */
export function buildResultPacket({ text, ref = null, budget = DEFAULT_BUDGET, topK = DEFAULT_TOPK, minProse = DEFAULT_MINPROSE } = {}) {
  const t = String(text || '');
  return {
    kind: 'organ_result',
    summary: summarizeResult(t, { budget, topK, minProse }),
    ref,
    bytes: t.length,
    shape: detectShape(t),
  };
}
