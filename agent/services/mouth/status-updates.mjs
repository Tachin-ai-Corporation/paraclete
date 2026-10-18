// agent/services/mouth/status-updates.mjs: short notes to a person whose request is taking a while.
// For each mission still under way that a person asked for, a note is due each time the mission's
// age crosses a step of mouth.status_updates.schedule_ms; the first reads as an acknowledgment,
// later ones as progress. Each is written by the utility model from status-prompts.md, with a plain
// fallback. A note is skipped when the agent already spoke to that Address since the previous step,
// so a person who just heard from the agent is not told again. Used by the mouth's main.mjs.
//
// What the mouth remembers per mission lives in memory only. A mission first seen past some steps
// starts after them, so a restart never sends a burst of overdue notes.

import { IN_PROGRESS_STATUSES, resolveAddress } from './delivery.mjs';

const POLL_LIMIT = 50;
const MAX_NOTE_CHARS = 300;
const FALLBACK = Object.freeze({
  ack: 'Working on it, one moment.',
  update: "Still on it: this one's taking a bit longer.",
});

/**
 * The two note templates out of status-prompts.md: the "## Initial Ack" and "## Progress Update"
 * sections, without their headings.
 *
 * @param {string} raw
 * @returns {{ack: string, update: string}}
 */
export function parseStatusPrompts(raw) {
  const prompts = { ack: '', update: '' };
  for (const section of String(raw || '').split(/^## /m)) {
    const body = section.replace(/^[^\n]*\n+/, '').trim();
    if (section.startsWith('Initial Ack')) prompts.ack = body;
    else if (section.startsWith('Progress Update')) prompts.update = body;
  }
  return prompts;
}

/** Replaces each {name} in a template with its value. */
export function fillTemplate(template, vars) {
  let text = template;
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, value || '');
  return text;
}

/**
 * Where a mission stands, in plain words, from its checkpoint spine when it has one.
 *
 * @param {object} mission a decoded mission envelope
 * @returns {string}
 */
export function activitySummary(mission) {
  const spine = Array.isArray(mission._cp_spine) ? mission._cp_spine : [];
  if (spine.length > 0) {
    const done = spine.filter((s) => s?.status === 'complete').length;
    const current = spine.find((s) => s?.status !== 'complete');
    const now = current?.outcome ? `; now on: ${String(current.outcome).slice(0, 120)}` : '';
    return `finished ${done} of ${spine.length} steps${now}`;
  }
  return mission.status === 'active' ? 'thinking it through' : 'about to start';
}

/**
 * The Address of the person waiting on a mission, or null when nobody is: work a responsibility
 * started, or an address with no thread or space to put a note in.
 *
 * @param {object} mission
 * @returns {object|null}
 */
export function waitingAddress(mission) {
  if (mission.source_channel !== 'dashboard' && mission.source_channel !== 'gchat') return null;
  const addr = resolveAddress(mission);
  if (addr.channel === 'gchat' ? !addr.space : !addr.thread) return null;
  return addr;
}

/**
 * Advances a mission's place in the schedule. Pure.
 *
 * @param {number}   index     the next step not yet passed
 * @param {number}   elapsedMs the mission's age
 * @param {number[]} schedule  ascending milliseconds
 * @returns {{index: number, due: number}} due is the latest step just passed, or -1
 */
export function advance(index, elapsedMs, schedule) {
  let due = -1;
  let next = index;
  while (next < schedule.length && elapsedMs >= schedule[next]) {
    due = next;
    next += 1;
  }
  return { index: next, due };
}

/**
 * Creates the status notes pass.
 *
 * @param {object}   deps
 * @param {object}   deps.db            a client from agent/storage/firestore.mjs
 * @param {{work: string}} deps.collections
 * @param {object}   deps.outbound      from outbound.mjs
 * @param {Function} [deps.transform]   vertex-text transform(text, instruction, opts) => string|null
 * @param {{ack: string, update: string}} deps.prompts from parseStatusPrompts()
 * @param {string}   deps.agentName
 * @param {number[]} deps.schedule      mouth.status_updates.schedule_ms
 * @param {boolean}  [deps.enabled=true] mouth.status_updates.enabled
 * @param {boolean}  [deps.llmEnabled=true] mouth.llm_enabled
 * @param {object}   [deps.callOptions] maxTokens, temperature, disableThinking
 * @param {Function} [deps.log]         (level, message, fields) logger
 * @param {Function} [deps.now]         clock in milliseconds (injectable for tests)
 * @returns {{pass: () => Promise<number>}} pass resolves to the number of notes sent
 */
export function createStatusUpdates({
  db, collections, outbound, transform, prompts, agentName, schedule = [], enabled = true, llmEnabled = true,
  callOptions = {}, log = () => {}, now = Date.now,
}) {
  const steps = [...schedule].filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  const tracked = new Map(); // mission id -> next schedule index

  async function compose(kind, mission) {
    const template = prompts[kind];
    const question = String(mission.source_meta?.raw_text || mission.instruction || mission.title || '').slice(0, 300);
    if (llmEnabled && template && transform) {
      const vars = { agent_name: agentName, activity_summary: activitySummary(mission), original_question: question };
      const out = await transform(`Question: "${question}"`, fillTemplate(template, vars), callOptions);
      const text = String(out || '').trim().replace(/^["']|["']$/g, '').trim();
      if (text) return text.slice(0, MAX_NOTE_CHARS);
    }
    return FALLBACK[kind];
  }

  async function pass() {
    if (!enabled || steps.length === 0) return 0;
    const missions = await db.query('', collections.work, [
      { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
      { field: 'status', op: 'IN', value: { arrayValue: { values: IN_PROGRESS_STATUSES.map((s) => ({ stringValue: s })) } } },
    ], { noOrderBy: true, limit: POLL_LIMIT, strict: true });

    const live = new Set();
    let sent = 0;
    for (const mission of missions) {
      const addr = waitingAddress(mission);
      const created = Date.parse(mission.created_at || '');
      if (!addr || !Number.isFinite(created)) continue;
      live.add(mission.id);
      const elapsed = now() - created;

      if (!tracked.has(mission.id)) {
        tracked.set(mission.id, advance(0, elapsed, steps).index);
        continue;
      }
      const { index, due } = advance(tracked.get(mission.id), elapsed, steps);
      tracked.set(mission.id, index);
      if (due < 0) continue;

      const since = created + (due === 0 ? 0 : steps[due - 1]);
      if (outbound.lastSpokenAt(addr) > since) continue;
      const kind = due === 0 ? 'ack' : 'update';
      try {
        if (await outbound.send(addr, await compose(kind, mission), { key: `status:${mission.id}:${due}` })) {
          sent += 1;
          log('INFO', 'status note sent', { mission: mission.id, kind, step: due });
        } else {
          log('WARN', 'status note refused by the channel', { mission: mission.id, channel: addr.channel });
        }
      } catch (err) {
        log('WARN', 'status note could not be sent', { mission: mission.id, error: err.message });
      }
    }
    for (const id of tracked.keys()) if (!live.has(id)) tracked.delete(id);
    return sent;
  }

  return { pass };
}
