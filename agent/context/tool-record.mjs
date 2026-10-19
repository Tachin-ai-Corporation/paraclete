// agent/context/tool-record.mjs: the record of an organ's tool calls. Every organ turn ends with a
// [TOOL EXECUTION LOG], one line per tool call, written by the gateway from what the tools actually
// returned. It is the one part of an organ's output a model cannot fabricate: the cerebellum (the
// organ that verifies each checkpoint) judges from it, the cortex's result summaries digest it, and
// the evidence checks scan it. Pure, apart from the store, digest and read functions the caller
// injects. The gateway uses buildToolLog; the brain uses completeToolLog and expandToolResults.
//
// Cutting results silently is what this file exists to prevent. A record that kept only the first
// few hundred characters of each result hid the later sections of a document from the verifier,
// which then could not confirm work that was fine. So:
//
//   up to verbatim_chars    the result, word for word (most calls)
//   larger                  the gateway marks an excerpt; the brain stores the full result
//                           (tool_results/<id>), asks the utility model for a digest, and puts
//                           "digest + ref" in the log
//   digest unavailable      the excerpt stays, its cut announced, with the ref
//
// A digest is labelled as one. It is a finding aid; the proof is the stored full result, which the
// verifier's re-check and the cortex's request_context fetch by ref (expandToolResults).

import { COLLECTIONS } from '../storage/collections.mjs';

/** The collection full tool results are stored in; refs look like `tool_results/<id>`. */
export const TOOL_RESULTS_COLLECTION = COLLECTIONS.toolResults;

/** What a model's own text carries in place of a tool-log marker it wrote: it opens and closes nothing. */
const QUOTED_START = '[TOOL EXECUTION LOG (quoted)]';
const QUOTED_END = '[END TOOL LOG (quoted)]';

/**
 * A model's text with every tool-log marker it wrote made inert, so its prose can never open or close
 * a log block: only the gateway writes the real markers, after the model's text. A model quoting an
 * earlier turn's log, or imitating one, would otherwise hand the readers (the verdict, the task's
 * outcome, the evidence checks) a block they take for the gateway's.
 *
 * @param {string} text
 * @returns {string}
 */
export function quoteToolLogMarkers(text) {
  return String(text ?? '').replaceAll('[TOOL EXECUTION LOG]', QUOTED_START).replaceAll('[END TOOL LOG]', QUOTED_END);
}

/**
 * The last tool-log block in an output, or ''. The gateway appends the real one after the model's
 * text, so the last block is the gateway's even if a model's text slipped a marker past
 * quoteToolLogMarkers.
 *
 * @param {string} text
 * @returns {string} the block's body, without its markers
 */
export function lastToolLog(text) {
  const s = String(text ?? '');
  const start = s.lastIndexOf('[TOOL EXECUTION LOG]');
  if (start < 0) return '';
  const bodyStart = start + '[TOOL EXECUTION LOG]'.length;
  const end = s.indexOf('[END TOOL LOG]', bodyStart);
  return end < 0 ? '' : s.slice(bodyStart, end);
}

// Terminal tools carry their payload through the log (the verdict parser in work/ reads their JSON
// arguments), so their arguments get the generous cap and are never marked as cut.
export const TERMINAL_TOOLS = new Set(['report_pass', 'report_fail']);

/** The record policy. Defaults; callers pass the contracts value through recordPolicy(). */
export const DEFAULT_RECORD_POLICY = Object.freeze({
  verbatim_chars: 4000,
  digest_target_chars: 3000,
  digest_max_chars: 4000,
  digest_timeout_ms: 15000,
  store_full: true,
  store_ttl_days: 30,
  arg_chars: 200,
  terminal_arg_chars: 4000,
});

/**
 * The record policy from a configured one: each positive number is taken, anything missing or
 * invalid falls back to its default. `store_full` is on unless set to false.
 *
 * @param {object} [record] the configured policy (the contracts' tool record settings)
 * @returns {object} a complete policy
 */
export function recordPolicy(record) {
  const p = record || {};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return {
    verbatim_chars: num(p.verbatim_chars, DEFAULT_RECORD_POLICY.verbatim_chars),
    digest_target_chars: num(p.digest_target_chars, DEFAULT_RECORD_POLICY.digest_target_chars),
    digest_max_chars: num(p.digest_max_chars, DEFAULT_RECORD_POLICY.digest_max_chars),
    digest_timeout_ms: num(p.digest_timeout_ms, DEFAULT_RECORD_POLICY.digest_timeout_ms),
    store_full: p.store_full !== false,
    store_ttl_days: num(p.store_ttl_days, DEFAULT_RECORD_POLICY.store_ttl_days),
    arg_chars: num(p.arg_chars, DEFAULT_RECORD_POLICY.arg_chars),
    terminal_arg_chars: num(p.terminal_arg_chars, DEFAULT_RECORD_POLICY.terminal_arg_chars),
  };
}

function resultString(result) {
  if (result === undefined || result === null) return '';
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function argsString(name, args, policy) {
  const s = JSON.stringify(args ?? {}) ?? '{}';
  const terminal = TERMINAL_TOOLS.has(name);
  const cap = terminal ? policy.terminal_arg_chars : policy.arg_chars;
  if (s.length <= cap) return s;
  return terminal ? s.slice(0, cap) : `${s.slice(0, cap)}…`;
}

/**
 * The head (60%) and tail (40%) of `text` within `budget`, with the cut stated in the middle.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
export function excerpt(text, budget) {
  const t = String(text ?? '');
  if (t.length <= budget) return t;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${t.slice(0, head)}\n[… ${t.length - budget} of ${t.length} chars omitted …]\n${t.slice(t.length - tail)}`;
}

const largeHeader = (seq, chars) => `[large result #${seq}: ${chars} chars — excerpt]`;
const largeFooter = (seq) => `[/large result #${seq}]`;

/**
 * The gateway's half: the [TOOL EXECUTION LOG] body for one organ turn, and the large results the
 * brain must store and digest (handed to it as `tool_records`).
 *
 * @param {Array<{toolName: string, args: object, result: any}>} toolCalls
 * @param {object} [policy]
 * @returns {{log: string, large: Array<{seq: number, tool: string, args: string, result: string, chars: number}>}}
 */
export function buildToolLog(toolCalls, policy = DEFAULT_RECORD_POLICY) {
  const large = [];
  const lines = (toolCalls || []).map((tc, seq) => {
    const name = tc.toolName || tc.name || 'tool';
    const args = argsString(name, tc.args, policy);
    const result = resultString(tc.result);
    const head = `[TOOL] ${name}(${args}) → `;
    if (result.length <= policy.verbatim_chars) return head + result;
    large.push({ seq, tool: name, args, result, chars: result.length });
    return `${head}${largeHeader(seq, result.length)}\n${excerpt(result, policy.verbatim_chars)}\n${largeFooter(seq)}`;
  });
  return { log: lines.join('\n'), large };
}

/**
 * The utility model's brief for a digest: condense, never interpret.
 *
 * @param {object} [policy]
 * @returns {string}
 */
export function digestInstruction(policy = DEFAULT_RECORD_POLICY) {
  return [
    'Condense the tool output below for the work\'s audit record. Another model will judge the work from your',
    'digest without seeing the original, so:',
    '- Keep the structure: headings and section names in order, table columns, how many items each list has.',
    '- Copy exactly every identifier, file or document id, URL, number, date, name, status and error message.',
    '- Drop only repetition, boilerplate and filler. Never add, infer, judge or summarize intent.',
    '- Where you leave items out, say what you left out (e.g. "+38 more rows with the same columns").',
    `Plain text, at most ${policy.digest_target_chars} characters.`,
  ].join('\n');
}

/**
 * The brain's half: for each large result, store the full text, get a digest, and put "digest + ref"
 * where the gateway left the excerpt. Objects before refs: a ref appears in the log only after its
 * result is stored. A failed digest keeps the excerpt and says so; a failed store says the full
 * result was not kept.
 *
 * @param {string} text  the organ's output, containing the gateway's log
 * @param {Array}  large the gateway's tool_records
 * @param {object} [io]
 * @param {(rec: object) => Promise<string>} [io.store]       stores the full result, resolves its ref
 * @param {(rec: object) => Promise<string|null>} [io.digest] the utility model's digest, or null
 * @param {object} [io.policy]
 * @returns {Promise<{text: string, recorded: Array<{seq: number, tool: string, chars: number, ref: string|null, digested: boolean}>}>}
 */
export async function completeToolLog(text, large, { store, digest, policy = DEFAULT_RECORD_POLICY } = {}) {
  if (!text || !Array.isArray(large) || large.length === 0) return { text, recorded: [] };
  const done = await Promise.all(large.map(async (rec) => {
    let ref = null;
    let summary = null;
    if (store && policy.store_full) {
      try { ref = (await store(rec)) || null; } catch { ref = null; }
    }
    if (digest) {
      try { summary = (await digest(rec)) || null; } catch { summary = null; }
    }
    if (summary) summary = String(summary).trim().slice(0, policy.digest_max_chars);
    return { rec, ref, summary: summary || null };
  }));

  let out = text;
  const recorded = [];
  for (const { rec, ref, summary } of done) {
    const header = largeHeader(rec.seq, rec.chars);
    const start = out.indexOf(header);
    if (start < 0) continue;
    const footer = `\n${largeFooter(rec.seq)}`;
    const end = out.indexOf(footer, start);
    if (end < 0) continue;
    const excerptText = out.slice(start + header.length + 1, end);
    const where = ref ? `full result: ${ref}` : 'full result not stored';
    const replacement = summary
      ? `[digest of ${rec.chars} chars — ${where}]\n${summary}`
      : `[excerpt of ${rec.chars} chars — digest unavailable; ${where}]\n${excerptText}`;
    out = out.slice(0, start) + replacement + out.slice(end + footer.length);
    recorded.push({ seq: rec.seq, tool: rec.tool, chars: rec.chars, ref, digested: Boolean(summary) });
  }
  return { text: out, recorded };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A digest or excerpt header that names a stored full result.
const REF_HEADER = new RegExp(
  `\\[(?:digest|excerpt) of (\\d+) chars — [^\\n\\]]*?full result: (${escapeRegExp(TOOL_RESULTS_COLLECTION)}\\/[A-Za-z0-9_-]+)\\]\\n`,
  'g',
);

/**
 * The stored full results a log's digests and excerpts point at, in order and each once, so whoever
 * reads a digest can ask for the whole result instead of running the work again.
 *
 * @param {string} text
 * @returns {string[]} refs of the form `tool_results/<id>`
 */
export function storedResultRefs(text) {
  const refs = [];
  for (const m of String(text ?? '').matchAll(REF_HEADER)) {
    if (!refs.includes(m[2])) refs.push(m[2]);
  }
  return refs;
}

/**
 * Puts stored full results back in place of their digests, as far as `budget` allows, for the
 * verifier's re-check on complete evidence. A block's body runs to the next [TOOL] line or the end of
 * the log. Results are restored smallest first, so the budget restores as many as it can; one that
 * doesn't fit, or can't be read, keeps its digest.
 *
 * @param {string} text
 * @param {object} io
 * @param {(ref: string) => Promise<string|null>} io.read the stored full result for a ref
 * @param {number} io.budget the most characters the expanded text may grow to
 * @returns {Promise<string>}
 */
export async function expandToolResults(text, { read, budget }) {
  const src = String(text ?? '');
  if (!read) return src;
  const blocks = [];
  for (const m of src.matchAll(REF_HEADER)) {
    const bodyStart = m.index + m[0].length;
    const ends = [src.indexOf('\n[TOOL] ', bodyStart), src.indexOf('\n[END TOOL LOG]', bodyStart)].filter((i) => i >= 0);
    blocks.push({ at: m.index, bodyStart, bodyEnd: ends.length ? Math.min(...ends) : src.length, chars: Number(m[1]), ref: m[2] });
  }
  if (blocks.length === 0) return src;

  let total = src.length;
  const chosen = [];
  for (const b of [...blocks].sort((x, y) => x.chars - y.chars)) {
    const grow = b.chars - (b.bodyEnd - b.bodyStart);
    if (total + grow > budget) continue;
    total += grow;
    chosen.push(b);
  }
  if (chosen.length === 0) return src;
  await Promise.all(chosen.map(async (b) => {
    try { b.full = await read(b.ref); } catch { b.full = null; }
  }));

  let out = '';
  let cursor = 0;
  for (const b of chosen.filter((c) => typeof c.full === 'string' && c.full).sort((x, y) => x.at - y.at)) {
    out += src.slice(cursor, b.at) + `[full result, ${b.full.length} chars — ${b.ref}]\n${b.full}`;
    cursor = b.bodyEnd;
  }
  return out + src.slice(cursor);
}
