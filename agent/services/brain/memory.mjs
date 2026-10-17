// agent/services/brain/memory.mjs: the brain's half of memory. Recall: the brain gathers the raw
// candidates deterministically (working memory, Core Memory, the last week's work, work matching the
// request's cues, and the known resources) and hands them to the temporal-memory organ (the organ that
// maintains the agent's memory), which builds the one packet every other organ sees, and may ask once
// for deeper history. Recording: the one-line working-memory entry for each finished mission, and the
// lessons a finished mission taught about its project and the playbooks it drew on. Memory is three
// layers (working memory, Core Memory, Deep Truths); nothing here writes a project, a playbook or any
// other definition, and Core Memory is written only by the memory organ's own commands.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { COLLECTIONS } from '../../storage/collections.mjs';
import { toStr } from '../../providers/to-str.mjs';
import { extractCues, recentWorkDigest, searchWork } from '../../context/work-recall.mjs';
import { rankCoreMemory } from '../../context/core-memory-rank.mjs';
import {
  buildMaintenancePrompt, buildProcessMaintenancePrompt, lessonLine, parseMaintenanceResponse,
  shouldMaintainContext, shouldMaintainProcesses,
} from '../../context/context-maintenance.mjs';
import { renderResources, resourceKey } from '../../work/resource-ledger.mjs';
import { isMemoryScoped } from '../../work/memory-scope.mjs';

/** The markers around the candidates recall hands the memory organ; its prompt and skill name them. */
export const PRELOADED_START = '--- PRE-LOADED MEMORY DATA ---';
export const PRELOADED_END = '--- END PRE-LOADED DATA ---';

/** How much candidate material one recall hands the memory organ. */
const CANDIDATE_BUDGET_CHARS = 8000;
/** How much of the organ's packet the brain keeps. */
const RECALLED_MAX_CHARS = 3000;
/** How many Core Memory entries one recall searches. Core Memory is pruned nightly and stays far below. */
const CORE_MEMORY_FETCH = 300;
const DAY_MS = 86_400_000;

/** Core Memory entries as candidate lines, each with its id so recall can cite it. */
export function renderCoreMemory(entries) {
  return (entries || []).map((e) => `- [${e.category || '?'}] (${e.id}) ${e.fact || ''}`).join('\n');
}

/**
 * A promoted identifier, stored in Core Memory's resources category as `kind: "name" = id`, back in
 * the resource ledger's shape.
 *
 * @param {string} fact
 * @returns {{kind: string, name: string, id: string}|null}
 */
export function parseResourceFact(fact) {
  const m = /([a-z_]+):\s*"([^"]+)"\s*=\s*([A-Za-z0-9_\-/.]{10,})/.exec(String(fact || ''));
  return m ? { kind: m[1], name: m[2], id: m[3] } : null;
}

/**
 * The memory organ's request for deeper history, or null when its reply is a packet.
 *
 * @param {string} text
 * @returns {{cues: string[], reason: string}|null}
 */
export function parseEscalation(text) {
  try {
    const parsed = JSON.parse(String(text || '').trim());
    if (parsed && parsed.recall_escalate === true) {
      return { cues: Array.isArray(parsed.cues) ? parsed.cues.filter((c) => typeof c === 'string' && c) : [], reason: String(parsed.reason || '') };
    }
  } catch { /* a packet, not an escalation */ }
  return null;
}

/**
 * The memory files under the data root: working memory (MEMORY.md) and the Deep Truths.
 *
 * @param {object} p
 * @param {string} p.workingMemoryFile
 * @param {string} p.deepTruthsFile
 * @param {number} [p.hardCapChars] - working memory never grows past this; a line waits for the nightly consolidation
 * @param {Function} [p.log]
 * @param {object} [p.io] - { readText, appendText } for tests
 */
export function createMemoryFiles({ workingMemoryFile, deepTruthsFile, hardCapChars = 8000, log = () => {}, io = {} }) {
  const readText = io.readText || ((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''));
  const appendText = io.appendText || ((path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, text);
  });
  const safeRead = (path, what) => {
    try { return readText(path) || ''; } catch (e) {
      log('WARN', `${what} could not be read: ${e.message}`);
      return '';
    }
  };

  return {
    workingMemory: () => safeRead(workingMemoryFile, 'working memory'),
    deepTruths: () => safeRead(deepTruthsFile, 'the Deep Truths'),
    /**
     * Appends one line to working memory, unless it is at its hard cap: past that, the line waits for
     * the nightly consolidation instead of growing every cortex prompt.
     *
     * @returns {boolean} whether it was written
     */
    append(line, what = 'line') {
      if (!line) return false;
      const size = safeRead(workingMemoryFile, 'working memory').length;
      if (size + line.length > hardCapChars) {
        log('INFO', `working memory is at ${size} chars; not appending the ${what} (the nightly consolidation prunes it)`);
        return false;
      }
      try {
        appendText(workingMemoryFile, line);
      } catch (e) {
        log('WARN', `working memory append failed: ${e.message}`);
        return false;
      }
      log('INFO', `working memory: appended the ${what} (${size + line.length} chars)`);
      return true;
    },
  };
}

/**
 * Creates the brain's memory: recall and the records a finished mission leaves.
 *
 * @param {object}   deps
 * @param {object}   deps.db             a client from agent/storage/firestore.mjs
 * @param {Function} deps.callAgent      (organ, payload) => result; the gateway client's
 * @param {object}   deps.files          from createMemoryFiles()
 * @param {Function} [deps.getProject]   (id) => project; the project registry's
 * @param {object}   [deps.processes]    the process registry: ensureLoaded(), getProcess(id)
 * @param {number}   [deps.recallLimit]  how many known resources recall offers
 * @param {Function} [deps.log]
 * @param {Function} [deps.clock]
 */
export function createMemory({
  db, callAgent, files, getProject = () => null, processes = null,
  recallLimit = 40, // default; callers pass the contracts value (memory.resource_ledger.recall_limit)
  log = () => {}, clock = Date.now,
}) {
  const firestoreQuery = (collection, filters, opts) => db.query('', collection, filters, opts);

  /** The active Core Memory entries, or [] when they cannot be read (recall then goes on without them). */
  async function coreMemory() {
    try {
      return await db.query('', COLLECTIONS.coreMemory, [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'active' } },
      ], { noOrderBy: true, limit: CORE_MEMORY_FETCH });
    } catch (e) {
      log('WARN', `recall: Core Memory could not be read: ${e.message}`);
      return [];
    }
  }

  /**
   * Recalls what is relevant to `query`, as one packet from the memory organ.
   *
   * @param {string} query
   * @param {object} [context]
   * @param {string} [context.lastAgentReply]
   * @param {string} [context.conversationHint]
   * @param {string} [context.instruction]
   * @param {string} [context.contextSummary]
   * @param {string[]} [context.cues]
   * @param {object} [context.resources] - this mission's resource ledger
   * @param {'targeted'|'deep'} [context.scope]
   * @returns {Promise<{recalled?: string}>} {} when nothing could be recalled
   */
  async function recall(query, context = {}) {
    try {
      const parts = [toStr(query)];
      if (context.lastAgentReply) parts.push(`Previous agent reply: ${context.lastAgentReply}`);
      if (context.conversationHint) parts.push(`Recent conversation: ${String(context.conversationHint).substring(0, 800)}`);
      if (context.instruction) parts.push(`Task: ${context.instruction}`);
      if (context.contextSummary) parts.push(`Context: ${context.contextSummary}`);
      const enriched = parts.join('\n');
      const scope = context.scope || 'targeted';
      const cues = context.cues || extractCues(enriched);
      const terms = cues.slice(0, 4).join(' ').toLowerCase().split(/\s+/).filter(Boolean);
      const now = clock();

      const blocks = [];
      const wm = files.workingMemory().trim();
      if (wm) blocks.push(`## Working Memory (MEMORY.md)\n${wm}`);

      const entries = await coreMemory();
      const matched = terms.length ? rankCoreMemory(entries, terms).slice(0, 10) : [];
      if (matched.length) blocks.push(`## Core Memory (query: ${terms.join(' ')})\n${renderCoreMemory(matched)}`);
      const seen = new Set(matched.map((e) => e.id));
      const since = now - 30 * DAY_MS;
      const recent = rankCoreMemory(entries.filter((e) => Date.parse(e.createdAt || '') >= since && e.category !== 'resources'))
        .filter((e) => !seen.has(e.id)).slice(0, 8);
      if (recent.length) blocks.push(`## Core Memory (recent 30d)\n${renderCoreMemory(recent)}`);

      let digestHits = 0;
      try {
        const digest = await recentWorkDigest({ firestoreQuery, sinceDays: 7, limit: 50, now });
        if (digest) {
          blocks.push(digest);
          digestHits = (digest.match(/^- /gm) || []).length;
        }
      } catch (e) {
        log('WARN', `recall: the recent work digest failed: ${e.message}`);
      }

      const sinceDays = scope === 'deep' ? 180 : 30;
      let workHits = 0;
      if (cues.length > 0) {
        try {
          const hits = await searchWork({ firestoreQuery, cues, sinceDays, limit: scope === 'deep' ? 12 : 6, now });
          workHits = hits.length;
          if (hits.length) blocks.push(`## Episodic Work History (${sinceDays}d, ${hits.length} hits)\n${renderHits(hits)}`);
        } catch (e) {
          log('WARN', `recall: the work search failed: ${e.message}`);
        }
      }

      // Known resources lead, not trail: the candidates are cut from the end, and these lines are
      // small, deterministic and the costliest to lose (an id re-derived is an id searched for again).
      const ledger = { ...(context.resources || {}) };
      const resourceEntries = rankCoreMemory(entries.filter((e) => e.category === 'resources'), terms).slice(0, 25);
      for (const e of resourceEntries) {
        const r = parseResourceFact(e.fact);
        if (!r) continue;
        const key = resourceKey(r.kind, r.name);
        if (!ledger[key]) ledger[key] = { ...r, source: 'core-memory' };
      }
      const known = renderResources(ledger, { limit: recallLimit, cues });
      if (known) blocks.unshift(known);

      log('INFO', `[TELEMETRY] recall_layers scope=${scope} cues=${cues.length} core=${matched.length + recent.length} digestHits=${digestHits} workHits=${workHits} resourceHits=${Object.keys(ledger).length}`);

      let candidates = blocks.join('\n\n');
      if (candidates.length > CANDIDATE_BUDGET_CHARS) candidates = `${candidates.substring(0, CANDIDATE_BUDGET_CHARS)}\n[...trimmed to budget]`;
      const preloaded = candidates ? `\n\n${PRELOADED_START}\n${candidates}\n${PRELOADED_END}` : '';

      const first = await callAgent('temporal-memory', {
        instruction: scope === 'deep'
          ? `Construct a focused recall package for:\n${enriched}${preloaded}`
          : `Recall all relevant context for:\n${enriched}\n\nIf answering requires work history older or broader than the candidates below, emit exactly {"recall_escalate": true, "cues": [...], "reason": "..."} and nothing else.${preloaded}`,
        accept_criteria: 'Return relevant memory context, "No relevant context found", or an escalation object',
      });
      if (!first?.success || !first.output) {
        log('INFO', 'recall: no context');
        return {};
      }
      const firstText = toStr(first.output);

      const escalation = scope === 'deep' ? null : parseEscalation(firstText);
      if (escalation) {
        log('INFO', `recall: escalation requested (${escalation.reason}), cues [${escalation.cues.join(', ')}]`);
        const deepCues = escalation.cues.length ? escalation.cues : cues;
        let deep = [];
        try {
          deep = await searchWork({ firestoreQuery, cues: deepCues, sinceDays: 180, limit: 12, now });
        } catch (e) {
          log('WARN', `recall: the deep work search failed: ${e.message}`);
        }
        // The second pass constructs only, from the candidates plus whatever the deeper search found.
        // It runs even when that search found nothing: the escalation is a request, not a packet, and
        // must never be handed on as recalled context.
        const deepBlock = deep.length > 0
          ? `## Deep Work History (180d, ${deep.length} hits)\n${renderHits(deep)}`
          : '## Deep Work History (180d)\nNo older work matched.';
        const second = await callAgent('temporal-memory', {
          instruction: `Construct a focused recall package (no further escalation) for:\n${enriched}\n\n${PRELOADED_START}\n${candidates}\n\n${deepBlock}\n${PRELOADED_END}`,
          accept_criteria: 'Return relevant memory context or "No relevant context found"',
        });
        if (second?.success && second.output && !parseEscalation(toStr(second.output))) {
          return { recalled: toStr(second.output).substring(0, RECALLED_MAX_CHARS) };
        }
        return {};
      }
      return { recalled: firstText.substring(0, RECALLED_MAX_CHARS) };
    } catch (e) {
      log('WARN', `recall failed: ${e.message}`);
      return {};
    }
  }

  /**
   * Appends a finished envelope's one-line record to working memory and marks it written, which the
   * archival sweep waits for. The nightly consolidation is skipped: its record is its own report, and a
   * line about it in the memory it just pruned would pollute it.
   *
   * @param {object} envelope
   */
  async function writeMissionLine(envelope) {
    try {
      const meta = envelope.source_meta || {};
      const origin = `${meta.process_ref || ''} ${meta.responsibility_id || ''}`.toLowerCase();
      if (isMemoryScoped(envelope) || origin.includes('memory-consolidat') || /\bmemory consolidation\b|\bnightly memory\b/i.test(toStr(envelope.instruction))) {
        log('INFO', 'working memory: not recording a memory consolidation in the memory it maintains');
        return;
      }
      const instruction = toStr(envelope.instruction).replace(/\s+/g, ' ').trim().substring(0, 120);
      const outcome = toStr(envelope.output || envelope.context_summary || '').replace(/\s+/g, ' ').trim().substring(0, 120);
      const day = new Date(clock()).toISOString().substring(0, 10);
      files.append(`- [${day}] ${envelope.type}: ${instruction}${outcome ? ` -> ${outcome}` : ''}\n`, 'mission line');
      await db.patch(`${COLLECTIONS.work}/${envelope.id}`, ['memory_written'], { memory_written: { booleanValue: true } });
    } catch (e) {
      log('WARN', `working memory write failed: ${e.message}`);
    }
  }

  /**
   * What a finished mission taught, as working-memory lessons: one about the project it worked in, and
   * one for each playbook it drew on. The memory organ writes the lesson; this appends it. The project
   * and the playbooks are read, never written. Best effort: it never blocks completion.
   *
   * @param {object} mission
   */
  async function recordLessons(mission) {
    if (isMemoryScoped(mission)) return; // a memory mission's record is its consolidation report
    try {
      const plan = shouldMaintainContext(mission, { enabled: true });
      const project = plan.run ? getProject(plan.projectId) : null;
      if (project) {
        const r = await callAgent('temporal-memory', {
          instruction: buildMaintenancePrompt(mission, project),
          accept_criteria: 'Return exactly one JSON object {"lesson":"<durable lesson, or empty string if nothing durable was learned>"}.',
        });
        const { lesson } = r?.success ? parseMaintenanceResponse(toStr(r.output)) : { lesson: '' };
        if (lesson) files.append(lessonLine({ scope: 'project', id: plan.projectId, lesson, date: today() }), `project lesson (${plan.projectId}, from ${mission.id})`);
      }
    } catch (e) {
      log('WARN', `project lesson failed (not fatal): ${e.message}`);
    }
    try {
      const plan = shouldMaintainProcesses(mission, { enabled: true });
      if (!plan.run || !processes) return;
      await processes.ensureLoaded();
      for (const pid of plan.processIds) {
        const proc = processes.getProcess(pid);
        if (!proc || proc.status === 'deprecated') continue;
        const r = await callAgent('temporal-memory', {
          instruction: buildProcessMaintenancePrompt(proc, mission),
          accept_criteria: 'Return exactly one JSON object {"lesson":"<durable lesson, or empty string if the run revealed nothing new>"}.',
        });
        const { lesson } = r?.success ? parseMaintenanceResponse(toStr(r.output)) : { lesson: '' };
        if (lesson) files.append(lessonLine({ scope: 'playbook', id: pid, lesson, date: today() }), `playbook lesson (${pid}, from ${mission.id})`);
      }
    } catch (e) {
      log('WARN', `playbook lessons failed (not fatal): ${e.message}`);
    }
  }

  function today() {
    return new Date(clock()).toISOString().slice(0, 10);
  }

  return { recall, writeMissionLine, recordLessons };
}

function renderHits(hits) {
  return hits.map((h) => `- [${h.type}] ${h.title || h.instruction_blurb} (id:${h.id}, ${h.completed_at || h.created_at}, score:${Number(h.score || 0).toFixed(2)})\n  ${h.output_blurb || ''}`.trim()).join('\n');
}
