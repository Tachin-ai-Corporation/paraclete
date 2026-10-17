// agent/context/compaction.mjs: keeps a mission's context bounded as the work grows. Pure functions:
// no I/O, no clock, no network. It does not call the model or store anything; the brain asks the
// utility model for the mission digest and saves the session log. Used by the brain's mission loop
// and by the checkpoint executor.
//
// Two levels:
//
//   Checkpoint level: a finished checkpoint forwards a fixed-shape digest (verdicts, short excerpts,
//   a pointer to the full outputs) instead of its full transcript. The checkpoint in flight stays
//   word for word. Full step outputs stay recoverable from the mission's work tree and step data:
//   the digest carries references, not payloads.
//
//   Mission level: when the cortex's (the organ that decides each step) accumulated context crosses
//   its working budget, the oldest iterations fold into a model-written digest. Every decision about
//   when and what to fold is made here, in code; only the digest's prose comes from the model, and
//   its shape is checked hard before it is spliced in.
//
// Budgets are in characters. Acceptance criteria and the mission instruction are copied word for
// word and never rewritten.

import { toStr } from '../providers/to-str.mjs';
import { smartTruncate } from '../providers/vertex-text.mjs';

const DEFAULTS = {
  digest_excerpt_chars: 300, // default; callers pass the contracts value
  checkpoint_digest_chars: 4000, // default; callers pass the contracts value
};

/**
 * The checkpoint number in a step id: "2.3" -> 2. Null when the id has no checkpoint prefix.
 *
 * @param {*} step
 * @returns {number|null}
 */
export function stepCheckpointNum(step) {
  const m = String(step ?? '').match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

/**
 * Renders the digest of one finished checkpoint.
 *
 * @param {object} p
 * @param {number} p.cpNum               1-based checkpoint number
 * @param {string} [p.instruction]       the checkpoint's instruction, shortened into the header
 * @param {string} [p.acceptCriteria]    included word for word
 * @param {Array}  p.results             step results: { step, agent, success, result }
 * @param {string} [p.missionId]         the mission envelope id, for the recovery pointer
 * @param {number} [p.excerptChars=300]  excerpt budget per step
 * @param {number} [p.capChars=4000]     budget for the whole digest
 * @returns {string}
 */
export function renderCheckpointDigest({
  cpNum,
  instruction = '',
  acceptCriteria = '',
  results = [],
  missionId = '',
  excerptChars = DEFAULTS.digest_excerpt_chars,
  capChars = DEFAULTS.checkpoint_digest_chars,
}) {
  const lines = [];
  const title = toStr(instruction).trim().replace(/\s+/g, ' ').substring(0, 120);
  lines.push(`[CHECKPOINT ${cpNum} DIGEST${title ? ` — ${title}` : ''}]`);
  if (acceptCriteria) lines.push(`Accept criteria (verbatim): ${toStr(acceptCriteria)}`);
  for (const r of results) {
    const excerpt = toStr(r.result || '').trim().replace(/\s+/g, ' ').substring(0, excerptChars);
    lines.push(`Step ${r.step} (${r.agent || 'unknown'}): ${r.success ? 'SUCCESS' : 'FAILED'} — ${excerpt}`);
  }
  if (missionId) lines.push(`[Full step outputs: mission ${missionId} work tree / step data]`);
  const rendered = lines.join('\n');
  return rendered.length <= capChars ? rendered : smartTruncate(rendered, capChars);
}

/**
 * The prior-work context for a task dispatch: a digest of every finished checkpoint, then the
 * results of the checkpoint in flight word for word.
 *
 * Safe across a crash and resume: step ids carry their checkpoint number ("2.3"), so grouping needs
 * no extra stored state.
 *
 * @param {object} p
 * @param {Array}  p.checkpoints       checkpoint entries, as planned or as stamped with their envelope
 * @param {Array}  p.allResults        results from finished checkpoints
 * @param {Array}  p.cpResults         results from the checkpoint in flight
 * @param {number} p.currentCpNum      1-based number of the checkpoint in flight
 * @param {string} [p.missionId]       for recovery pointers
 * @param {number} [p.stepChars=8000]  word-for-word budget per step
 * @param {number} [p.digestChars]     budget per digest
 * @param {number} [p.excerptChars]    excerpt budget per step inside a digest
 * @returns {string|undefined} the block, or undefined when there is no prior work
 */
export function buildPriorWorkContext({
  checkpoints = [],
  allResults = [],
  cpResults = [],
  currentCpNum,
  missionId = '',
  stepChars = 8000,
  digestChars = DEFAULTS.checkpoint_digest_chars,
  excerptChars = DEFAULTS.digest_excerpt_chars,
}) {
  if (allResults.length === 0 && cpResults.length === 0) return undefined;

  const byCp = new Map();
  for (const r of allResults) {
    const cp = stepCheckpointNum(r.step);
    // Results of the checkpoint in flight, and results with no prefix, stay word for word.
    if (cp === null || cp === currentCpNum) continue;
    if (!byCp.has(cp)) byCp.set(cp, []);
    byCp.get(cp).push(r);
  }
  const unprefixed = allResults.filter((r) => {
    const cp = stepCheckpointNum(r.step);
    return cp === null || cp === currentCpNum;
  });

  const sections = [];
  for (const cp of [...byCp.keys()].sort((a, b) => a - b)) {
    const entry = checkpoints[cp - 1] || {};
    const env = entry.cEnvelope || entry;
    sections.push(renderCheckpointDigest({
      cpNum: cp,
      instruction: env.instruction || entry.instruction || '',
      acceptCriteria: env.accept_criteria || entry.accept_criteria || '',
      results: byCp.get(cp),
      missionId,
      excerptChars,
      capChars: digestChars,
    }));
  }

  const verbatim = [...unprefixed, ...cpResults].map((r) =>
    `Step ${r.step} (${r.agent || 'unknown'}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(toStr(r.result || ''), stepChars)}`,
  );
  if (verbatim.length > 0) sections.push(verbatim.join('\n\n'));

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

// ---- Mission level ----

const ITERATION_SPLIT = /\n\n(?=--- Iteration )/;

/**
 * Whether to compact the mission context now. Fires only when the measured prompt (real token count
 * when known, characters / 4 otherwise) crosses the trigger share of the working budget, and there is
 * enough accumulated context to be worth folding.
 *
 * @param {object} p
 * @param {number} [p.lastRealPromptTokens] the last call's real prompt tokens
 * @param {number} [p.accumulatedChars]
 * @param {number} [p.compactionsSoFar]
 * @param {object} [p.cfg] enabled, working_budget_tokens, trigger_pct, min_compactable_tokens, max_compactions_per_mission
 * @returns {{compact: boolean, reason: string}}
 */
export function shouldCompact({
  lastRealPromptTokens = 0,
  accumulatedChars = 0,
  compactionsSoFar = 0,
  cfg = {},
}) {
  if (cfg.enabled === false) return { compact: false, reason: 'disabled' };
  const budget = cfg.working_budget_tokens || 80000; // default; callers pass the contracts value
  const triggerPct = cfg.trigger_pct || 0.7; // default; callers pass the contracts value
  const minTokens = cfg.min_compactable_tokens || 8000; // default; callers pass the contracts value
  const maxCompactions = cfg.max_compactions_per_mission || 3; // default; callers pass the contracts value
  if (compactionsSoFar >= maxCompactions) return { compact: false, reason: 'max_compactions' };
  const effective = Math.max(lastRealPromptTokens, Math.ceil(accumulatedChars / 4));
  if (Math.ceil(accumulatedChars / 4) < minTokens) return { compact: false, reason: 'below_min' };
  if (effective < budget * triggerPct) return { compact: false, reason: 'below_threshold' };
  return { compact: true, reason: `effective=${effective} >= ${Math.floor(budget * triggerPct)}` };
}

/**
 * Splits accumulated context into its head and its iteration blocks. The head holds the mission
 * framing and any earlier [CONTEXT COMPACTED] digest, so a digest stays pinned through every later
 * fold and through the fallback prune: both split on the same iteration marker.
 *
 * @param {string} accumulated
 * @returns {{head: string, blocks: string[]}}
 */
export function splitIterationBlocks(accumulated) {
  const parts = (accumulated || '').split(ITERATION_SPLIT);
  if (parts.length === 0) return { head: '', blocks: [] };
  return { head: parts[0], blocks: parts.slice(1) };
}

/**
 * Scrubs secrets from anything stored durably; transcripts are a leak surface. Best effort by nature:
 * the patterns err broad, and storing the session log is off by default.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  return (text || '')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, '[REDACTED-GCP-TOKEN]')
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED-API-KEY]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED-GITHUB-TOKEN]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{20,}/g, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]');
}

/**
 * Checks the model's mission digest. Every claim must carry its epistemic bin (verified, inferred or
 * assumed). Rejecting here keeps anything else (a parse failure, a decision-shaped object) out of the
 * mission's context.
 *
 * @param {object} d
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateMissionDigest(d) {
  if (!d || typeof d !== 'object') return { valid: false, reason: 'not an object' };
  if (!Array.isArray(d.decisions)) return { valid: false, reason: 'decisions missing' };
  if (!Array.isArray(d.claims)) return { valid: false, reason: 'claims missing' };
  for (const c of d.claims) {
    if (!c || typeof c.text !== 'string' || !['verified', 'inferred', 'assumed'].includes(c.bin)) {
      return { valid: false, reason: 'claims entries require text and bin in {verified,inferred,assumed}' };
    }
  }
  if (!Array.isArray(d.open_questions)) return { valid: false, reason: 'open_questions missing' };
  return { valid: true };
}

/**
 * The instruction for the utility model that writes the mission digest. The model sees only the log;
 * it holds no state between calls.
 *
 * @returns {string}
 */
export function missionDigestInstruction() {
  return [
    'Summarize this mission work log into STRICT JSON with exactly these keys:',
    '{"covered_iterations":"i..j","decisions":[{"iteration":1,"action":"...","target":"...","outcome":"..."}],',
    '"claims":[{"text":"...","bin":"verified|inferred|assumed","source":"..."}],',
    '"open_questions":["..."],"artifacts":[{"ref":"...","desc":"..."}],"durable_learnings":["..."]}',
    'Every claim MUST carry its epistemic bin: verified (the check can be shown), inferred (follows by stated reasoning), assumed (not checked).',
    'Never upgrade a bin. Preserve exact identifiers, file paths, and envelope ids. Respond with ONLY the JSON object.',
  ].join('\n');
}

/**
 * Renders the compacted context: head, digest block, then the iterations kept. The mission
 * instruction and acceptance criteria are copied by code, word for word; the model never rewrites
 * them. The digest block doesn't start with '--- Iteration ', so every later split folds it into the
 * head: pinned by construction.
 *
 * @param {object} p
 * @param {string} p.head
 * @param {string[]} [p.keptBlocks]
 * @param {object} p.digest           a digest that passed validateMissionDigest
 * @param {number} p.seq              which compaction this is, from 1
 * @param {string} [p.instruction]
 * @param {string} [p.acceptCriteria]
 * @param {string} [p.coveredLabel]   e.g. '1..4'
 * @param {string} [p.sessionLogPath] where the pre-compaction log was stored
 * @param {number} [p.capChars=6000]  budget for the digest block
 * @returns {string}
 */
export function spliceCompacted({
  head,
  keptBlocks = [],
  digest,
  seq,
  instruction = '',
  acceptCriteria = '',
  coveredLabel = '',
  sessionLogPath = '',
  capChars = 6000,
}) {
  const lines = [
    `[CONTEXT COMPACTED — seq ${seq}${coveredLabel ? ` — iterations ${coveredLabel}` : ''}]`,
    instruction ? `Mission instruction (verbatim): ${toStr(instruction)}` : '',
    acceptCriteria ? `Accept criteria (verbatim): ${toStr(acceptCriteria)}` : '',
    `Decisions: ${JSON.stringify(digest.decisions || [])}`,
    `Claims (each carries its epistemic bin — treat 'assumed' as unverified): ${JSON.stringify(digest.claims || [])}`,
    `Open questions: ${JSON.stringify(digest.open_questions || [])}`,
    (digest.artifacts && digest.artifacts.length) ? `Artifacts: ${JSON.stringify(digest.artifacts)}` : '',
    (digest.durable_learnings && digest.durable_learnings.length) ? `Durable learnings: ${JSON.stringify(digest.durable_learnings)}` : '',
    sessionLogPath ? `Full pre-compaction log: ${sessionLogPath}` : '',
  ].filter(Boolean);
  let block = lines.join('\n');
  if (block.length > capChars) block = smartTruncate(block, capChars);
  return [head, block, ...keptBlocks].filter(Boolean).join('\n\n');
}
