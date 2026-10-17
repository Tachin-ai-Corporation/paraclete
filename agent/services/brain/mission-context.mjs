// agent/services/brain/mission-context.mjs: what a mission carries from one decision to the next. The
// accumulated context (one block per decide iteration, kept on the envelope so it survives a restart)
// and its rolling compaction into a validated digest when it nears its budget; the bound on the
// results list; fetching a result's full content when the cortex asks for it by ref; and the mission
// blackboard written into the mission tree. The decide loop in envelope-runner.mjs calls these.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from '../../storage/collections.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { smartTruncate } from '../../providers/vertex-text.mjs';
import { parseJsonResponse } from '../../providers/json-repair.mjs';
import {
  missionDigestInstruction, shouldCompact, spliceCompacted, splitIterationBlocks, validateMissionDigest,
} from '../../context/compaction.mjs';
import { expandToolResults, TOOL_RESULTS_COLLECTION } from '../../context/tool-record.mjs';
import { renderBlackboard } from '../../work/blackboard.mjs';

/** Most results a decide loop holds before the oldest are folded into one summary line each. */
export const PRIOR_RESULTS_MAX = 25;
/** Rough characters per token, for budgets only. */
const CHARS_PER_TOKEN = 4;

/**
 * Appends this iteration's block to the accumulated context and prunes the true middle when it is
 * over budget, keeping the mission's framing (the first tenth) and the recent half.
 *
 * @param {object} p
 * @param {string} [p.accumulated]
 * @param {Array}  [p.priorResults]
 * @param {object} [p.memory]
 * @param {number} p.iteration
 * @param {string} p.timestamp
 * @param {number} p.tokenBudget       - brain.context_token_budget
 * @param {number} p.sliceChars        - brain.context_slice_chars
 * @returns {{text: string, pruned: number}} pruned is how many blocks were dropped
 */
export function accumulateContext({ accumulated = '', priorResults = [], memory = null, iteration, timestamp, tokenBudget, sliceChars }) {
  let text = accumulated || '';
  const parts = [`--- Iteration ${iteration} (${timestamp}) ---`];
  const latest = priorResults.length > 0 ? priorResults[priorResults.length - 1] : null;
  if (latest && latest.agent && latest.agent !== 'system' && latest.agent !== 'human') {
    parts.push(`Decision: dispatch to ${latest.agent}`);
    if (latest.task) parts.push(`Task: ${latest.task}`);
    parts.push(`Result: ${toStr(latest.summary || latest.result).substring(0, 2000)}`);
  } else if (latest && latest.agent === 'human') {
    parts.push(`Human input: ${smartTruncate(toStr(latest.result), sliceChars)}`);
  }
  if (memory?.recalled && iteration === 1) parts.push(`Memory: ${toStr(memory.recalled).substring(0, 1000)}`);
  if (parts.length > 1) text = text ? `${text}\n\n${parts.join('\n')}` : parts.join('\n');

  let pruned = 0;
  const budgetChars = tokenBudget * CHARS_PER_TOKEN;
  if (text.length > budgetChars) {
    const blocks = text.split(/\n\n(?=--- Iteration )/);
    if (blocks.length > 2) {
      const keepFirst = Math.max(1, Math.floor(blocks.length * 0.1));
      const keepLast = Math.max(1, Math.floor(blocks.length * 0.5));
      pruned = blocks.length - keepFirst - keepLast;
      text = [
        ...blocks.slice(0, keepFirst),
        `\n--- [${pruned} iterations pruned for context budget] ---\n`,
        ...blocks.slice(blocks.length - keepLast),
      ].join('\n\n');
    }
  }
  return { text, pruned };
}

/**
 * Bounds a decide loop's results: past the maximum, the oldest are folded into one summary entry and
 * the most recent 60% kept. Changes the array in place.
 *
 * @param {Array} priorResults
 * @param {number} [max]
 * @returns {boolean} whether it was folded (the cortex's session must then be closed: its delta
 *   watermark no longer points at the same entries)
 */
export function boundPriorResults(priorResults, max = PRIOR_RESULTS_MAX) {
  if (priorResults.length <= max) return false;
  const keepCount = Math.floor(max * 0.6);
  const keep = priorResults.slice(-keepCount);
  const older = priorResults.slice(0, -keepCount);
  const summary = older.map((r) => `${r.agent || 'system'}: ${toStr(r.result).substring(0, 100)}`).join('\n');
  priorResults.length = 0;
  priorResults.push({ agent: 'system', result: `[PRIOR WORK SUMMARY]\n${summary}`, success: true }, ...keep);
  return true;
}

/**
 * Creates the mission context helpers bound to the brain's services.
 *
 * @param {object} deps
 * @param {object}   deps.store         from envelope-store.mjs
 * @param {object}   deps.vertexText    the utility model client (agent/providers/vertex-text.mjs)
 * @param {object}   deps.settings      brainSettings()
 * @param {Function} [deps.missionDir]  (missionId) => the mission tree's path
 * @param {Function} [deps.log]
 */
export function createMissionContext({ store, vertexText, settings, missionDir = null, log = () => {} }) {
  /**
   * Rolling compaction: when the context nears its working budget, the middle iterations are folded
   * into a digest whose every claim carries its epistemic bin, the instruction and criteria are copied
   * by code word for word, and the splice is written field-masked so a concurrent writer of other
   * fields is never overwritten. A digest that fails validation is never spliced in; the
   * deterministic prune stays the bound.
   *
   * @param {object} envelope
   * @param {object} [opts]
   * @param {number} [opts.lastPromptTokens]
   * @param {string} [opts.trigger]
   * @param {number} [opts.triggerPct] - overrides compaction.trigger_pct (compacting on suspend uses 0.5)
   * @returns {Promise<number>} the new compaction's sequence number, or 0 when none happened
   */
  async function compact(envelope, { lastPromptTokens = 0, trigger = 'tokens', triggerPct = null } = {}) {
    const cfg = { ...settings.compaction, ...(triggerPct ? { trigger_pct: triggerPct } : {}) };
    const acc = envelope._accumulated_context || '';
    const check = shouldCompact({ lastRealPromptTokens: lastPromptTokens, accumulatedChars: acc.length, compactionsSoFar: envelope._compaction?.seq || 0, cfg });
    if (!check.compact) return 0;
    const keepRecent = cfg.keep_recent_iterations || 5;
    const { head, blocks } = splitIterationBlocks(acc);
    if (blocks.length <= keepRecent + 2) return 0;

    const seq = (envelope._compaction?.seq || 0) + 1;
    const kept = blocks.slice(-keepRecent);
    const windowText = blocks.slice(0, blocks.length - keepRecent).join('\n\n');
    let digest = null;
    for (let attempt = 1; attempt <= 2 && !digest; attempt++) {
      const raw = await vertexText.transform(windowText.substring(0, 120_000), missionDigestInstruction(), { maxTokens: 4096, temperature: 0.1, timeoutMs: 60_000 });
      if (!raw) continue;
      const parsed = parseJsonResponse(raw);
      const shape = validateMissionDigest(parsed);
      if (shape.valid) digest = parsed;
      else log('WARN', `compaction digest invalid (attempt ${attempt}): ${shape.reason}`);
    }
    if (!digest) {
      log('WARN', `[TELEMETRY] compaction_fallback mission=${envelope.id} seq=${seq} trigger=${trigger}: the digest failed; the deterministic prune stays the bound`);
      return 0;
    }
    envelope._accumulated_context = spliceCompacted({
      head, keptBlocks: kept, digest, seq,
      instruction: envelope.instruction, acceptCriteria: envelope.accept_criteria,
      coveredLabel: digest.covered_iterations || '', capChars: cfg.digest_max_chars || 6000,
    });
    envelope._compaction = {
      seq,
      at_iteration: envelope.iteration || 0,
      covered: digest.covered_iterations || '',
      dropped_chars: windowText.length,
      trigger,
      at: store.iso(),
      durable_learnings: (digest.durable_learnings || []).slice(0, 5),
    };
    await store.patch(envelope.id, {
      _accumulated_context: envelope._accumulated_context,
      _compaction: envelope._compaction,
      updated_at: store.iso(),
    });
    await store.writeHistory(envelope.id, envelope.status, envelope.status, 'brain',
      `Context compacted (seq ${seq}): iterations ${digest.covered_iterations || '?'} folded (${windowText.length} chars into a digest)`,
      `compact-${envelope.id}-${seq}`);
    log('INFO', `[TELEMETRY] compaction mission=${envelope.id} seq=${seq} trigger=${trigger} dropped_chars=${windowText.length} kept_blocks=${kept.length} chars_after=${envelope._accumulated_context.length}`);
    return seq;
  }

  /**
   * The full content of the refs the cortex named in request_context, appended to the results. Each
   * ref is fetched at most once per mission, at most hydrate.maxRefs per mission, each cut to
   * hydrate.maxChars. A task's output comes back with its stored tool results restored in place of
   * their digests: a digested read-back read as "truncated" once sent a mission that had passed every
   * checkpoint back to planning four times.
   *
   * @param {object} envelope
   * @param {string[]} refs
   * @param {Array} priorResults - appended to in place
   * @returns {Promise<'fetched'|'nothing_new'|'none'>}
   */
  async function hydrate(envelope, refs, priorResults) {
    const { maxRefs, maxChars } = settings.hydrate;
    envelope._hydrated_refs = Array.isArray(envelope._hydrated_refs) ? envelope._hydrated_refs : [];
    const fresh = (refs || []).filter((r) => typeof r === 'string' && r && !envelope._hydrated_refs.includes(r));
    const room = Math.max(0, maxRefs - envelope._hydrated_refs.length);
    const toFetch = fresh.slice(0, room);
    const readStored = async (ref) => {
      const doc = await store.firestoreRead(TOOL_RESULTS_COLLECTION, ref.slice(TOOL_RESULTS_COLLECTION.length + 1));
      return doc?.result ? String(doc.result) : null;
    };
    for (const ref of toFetch) {
      let full = '';
      try {
        if (ref.startsWith(`${TOOL_RESULTS_COLLECTION}/`)) {
          full = (await readStored(ref)) || '';
        } else {
          const doc = await store.firestoreRead(COLLECTIONS.work, ref);
          full = await expandToolResults(toStr(doc?.output || doc?.error || ''), { read: readStored, budget: maxChars });
        }
      } catch (e) {
        full = `[the content of ${ref} could not be read: ${e.message}]`;
      }
      envelope._hydrated_refs.push(ref);
      priorResults.push({ agent: 'system', task: `full content (ref=${ref})`, result: `[FULL CONTENT ref=${ref}]\n${full.slice(0, maxChars)}`, success: true });
      log('INFO', `[TELEMETRY] context_hydrated mission=${envelope.id} ref=${ref} bytes=${full.length}`);
    }
    if (toFetch.length > 0) return 'fetched';
    if (fresh.length > 0 || (refs || []).length > 0) {
      priorResults.push({ agent: 'system', result: `[SYSTEM] The requested content was already provided, or the limit of ${maxRefs} fetches per mission is reached. Decide from what you have.` });
      return 'nothing_new';
    }
    return 'none';
  }

  /**
   * Writes the mission blackboard (MISSION.md) into the mission tree: the goal, the criteria, every
   * result and open failure in one place any organ can read. Never fatal.
   */
  function writeBlackboard(envelope, priorResults, iteration) {
    if (envelope.type !== 'M' || typeof missionDir !== 'function') return;
    try {
      const dir = missionDir(envelope.id);
      mkdirSync(dir, { recursive: true });
      const text = renderBlackboard(envelope, priorResults, { maxChars: settings.blackboardMaxChars, iteration });
      writeFileSync(join(dir, 'MISSION.md'), text);
      log('INFO', `[TELEMETRY] blackboard_written mission=${envelope.id} iter=${iteration} bytes=${text.length}`);
    } catch (e) {
      log('WARN', `[blackboard] write failed (not fatal): ${e.message}`);
    }
  }

  return { compact, hydrate, writeBlackboard };
}
