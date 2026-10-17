// agent/context/work-recall.mjs: recall of the agent's past work for its prompts. Extracts cues from
// a request, scores past envelopes against them (term overlap, recency, outcome, type), and renders
// a digest of recent work grouped by day with each outcome marked. One project holds one agent, so
// all work in the collection is the agent's own. It only reads: the caller injects firestoreQuery
// and firestoreRead. Used by the brain when it assembles context.

import { COLLECTIONS } from '../storage/collections.mjs';

const MAX_CUES = 8;
const HALF_LIFE_DAYS = 30;
const RELEVANCE_FLOOR = 0.15;
const DAY_MS = 86_400_000;
const STOPWORDS = new Set(['the','and','for','are','but','not','you','all','can','had','her','was','one','our','out','has','its','let','say','she','too','use','way','who','how','now','old','see','get','did','may','new','any','few','got','own','man','big','end','put','run','try','his','him','ask','ago','off','yet','set','yes','sir','mrs','per','cup','bit','art','arm','bag','bed','bet','box','bus','cut','due','ear','eat','egg','era','etc','eye','far','fat','fee','fit','fly','fun','gap','gas','gut','hat','hey','hip','hit','ice','ill','jam','jet','joy','key','kid','lab','lap','law','lay','led','leg','lip','log','lot','map','mix','net','nor','nut','odd','oil','pad','pan','pay','pen','pet','pie','pin','pit','pot','pub','raw','ray','red','rid','rod','row','rub','rug','sad','mud','tea','ten','tie','tin','tip','toe','top','toy','van','via','war','wet','win','won','zoo','also','been','come','does','done','each','even','fact','find','from','give','good','have','help','here','high','just','keep','know','last','left','life','like','line','long','look','made','make','many','more','most','much','must','name','need','next','only','over','part','plan','play','said','same','show','side','some','such','sure','take','tell','than','that','them','then','they','this','time','turn','upon','used','very','want','well','went','were','what','when','will','with','word','work','year','your']);

// Newest first. A status holds envelopes for as long as the agent runs, and the query returns at
// most one page: oldest first, a busy agent's page held only work from before the recall window,
// and recall found nothing at all.
const NEWEST_FIRST = { orderBy: 'created_at', orderDirection: 'DESCENDING' };

/**
 * The recall cues in a text: distinct lowercase words of three or more characters that are not
 * stopwords, plus adjacent pairs, at most eight.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractCues(text) {
  if (!text) return [];
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const cues = new Set(tokens);
  for (let i = 0; i < tokens.length - 1; i++) cues.add(`${tokens[i]} ${tokens[i + 1]}`);
  return [...cues].slice(0, MAX_CUES);
}

/**
 * How relevant an envelope is to the cues: term score x (0.6 + 0.4 x recency) x status weight x
 * type weight. Recency halves every 30 days.
 *
 * @param {object} envelope
 * @param {string[]} cues
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function scoreRelevance(envelope, cues, now = Date.now()) {
  if (!cues || cues.length === 0) return 0;
  const blob = `${envelope.title || ''} ${envelope.instruction || ''} ${envelope.output || ''}`.toLowerCase();
  const termScore = cues.filter((c) => blob.includes(c)).length / cues.length;

  const created = envelope.created_at ? new Date(envelope.created_at).getTime() : now;
  const ageDays = Math.max(0, (now - created) / DAY_MS);
  const recencyScore = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);

  const statusWeight = { complete: 1.0, queued: 0.8, blocked: 0.6, failed: 0.6 }[envelope.status] ?? 0.4;
  const typeWeight = { M: 1.0, R: 0.8, C: 0.7 }[envelope.type] ?? 0.5;

  return termScore * (0.6 + 0.4 * recencyScore) * statusWeight * typeWeight;
}

const byStatus = (status) => [{ field: 'status', op: 'EQUAL', value: { stringValue: status } }];

/**
 * The past work most relevant to the cues: queried by status, filtered to the window and types,
 * scored, ranked, and cut to `limit`.
 *
 * @param {object}   p
 * @param {Function} p.firestoreQuery - async (collection, filters, opts) => docs[]
 * @param {string[]} p.cues
 * @param {number}   [p.sinceDays=30]
 * @param {string[]} [p.statuses]
 * @param {string[]} [p.types]        - envelope types to keep; all when absent
 * @param {number}   [p.limit=6]
 * @param {number}   [p.now=Date.now()]
 * @returns {Promise<object[]>} hits with id, type, title, blurbs, status, dates, score, matched_cues
 */
export async function searchWork({
  firestoreQuery, cues, sinceDays = 30,
  statuses = ['complete', 'active', 'queued', 'failed', 'blocked', 'needs_input'],
  types, limit = 6, now = Date.now(),
}) {
  const cutoff = now - sinceDays * DAY_MS;
  const allDocs = [];
  for (const status of statuses) {
    const docs = await firestoreQuery(COLLECTIONS.work, byStatus(status), NEWEST_FIRST);
    if (docs) allDocs.push(...docs);
  }

  const hits = [];
  for (const d of allDocs) {
    if (d.created_at && new Date(d.created_at).getTime() < cutoff) continue;
    if (types && !types.includes(d.type)) continue;
    const score = scoreRelevance(d, cues, now);
    if (score < RELEVANCE_FLOOR) continue;
    const blob = `${d.title || ''} ${d.instruction || ''} ${d.output || ''}`.toLowerCase();
    hits.push({
      id: d.id,
      type: d.type,
      title: d.title,
      instruction_blurb: (d.instruction || '').substring(0, 200),
      output_blurb: (d.output || '').substring(0, 200),
      status: d.status,
      created_at: d.created_at,
      completed_at: d.completed_at,
      score,
      matched_cues: cues.filter((c) => blob.includes(c)),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// The digest spans every outcome, not just success: failures and blocks carry the most learning,
// so each row carries an outcome marker and a why-blurb (output or error), and cites its id so the
// agent can point at a specific mission.
const DIGEST_STATUSES = ['complete', 'failed', 'blocked', 'needs_input', 'cancelled'];
const OUTCOME_MARK = { complete: '[done]', failed: '[FAILED]', blocked: '[blocked]', needs_input: '[needs-input]', cancelled: '[cancelled]' };
const digestTs = (d) => d.completed_at || d.updated_at || d.created_at || '';

/**
 * Recent work as a digest grouped by day, newest day first. Only top-level units (missions and
 * responsibilities) by default: their output or error is the outcome, and checkpoint and task
 * detail is for deliberate investigation, not ambient recall.
 *
 * @param {object}   p
 * @param {Function} p.firestoreQuery - async (collection, filters, opts) => docs[]
 * @param {number}   [p.sinceDays=7]
 * @param {number}   [p.limit=50]
 * @param {string[]} [p.statuses]
 * @param {string[]} [p.types=['M','R']]
 * @param {number}   [p.now=Date.now()]
 * @returns {Promise<string>}
 */
export async function recentWorkDigest({
  firestoreQuery, sinceDays = 7, limit = 50, statuses = DIGEST_STATUSES, types = ['M', 'R'], now = Date.now(),
}) {
  const seen = new Map();
  for (const status of statuses) {
    const docs = await firestoreQuery(COLLECTIONS.work, byStatus(status), NEWEST_FIRST);
    if (docs) for (const d of docs) if (d && d.id) seen.set(d.id, d);
  }
  const header = `## Recent Work (Last ${sinceDays} Days) — includes outcomes`;
  const empty = `${header}\n\nNo recent work found.`;
  if (seen.size === 0) return empty;

  const cutoff = now - sinceDays * DAY_MS;
  const recent = [...seen.values()]
    .filter((d) => types.includes(d.type))
    .filter((d) => { const t = digestTs(d); return t && new Date(t).getTime() >= cutoff; })
    .sort((a, b) => new Date(digestTs(b)) - new Date(digestTs(a)))
    .slice(0, limit);
  if (recent.length === 0) return empty;

  const groups = {};
  for (const d of recent) {
    const day = new Date(digestTs(d)).toISOString().slice(0, 10);
    const mark = OUTCOME_MARK[d.status] || `[${d.status || '?'}]`;
    const blurb = (d.output || d.error || '').substring(0, 220).replace(/\s+/g, ' ').trim();
    (groups[day] ||= []).push(`- ${mark} [${d.type || '?'}] ${d.title || 'Untitled'} (id:${d.id})${blurb ? ` — ${blurb}` : ''}`);
  }

  const lines = [header];
  for (const day of Object.keys(groups).sort().reverse()) {
    lines.push(`### ${day}`);
    lines.push(...groups[day]);
  }
  return lines.join('\n');
}

/**
 * One envelope's full output, read directly, to recover an output that was truncated elsewhere.
 *
 * @param {string} id
 * @param {{firestoreRead: Function}} deps - async (collection, docId) => doc|null
 * @returns {Promise<object|null>}
 */
export async function getWorkOutput(id, { firestoreRead }) {
  if (!id || !firestoreRead) return null;
  const doc = await firestoreRead(COLLECTIONS.work, id);
  if (!doc) return null;
  return {
    id: doc.id,
    status: doc.status,
    type: doc.type,
    title: doc.title || null,
    output: doc.output || null,
    output_chars: (doc.output || '').length,
    accept_criteria: doc.accept_criteria || null,
    created_at: doc.created_at || null,
    completed_at: doc.completed_at || null,
    project_id: doc.project_id || null,
  };
}
