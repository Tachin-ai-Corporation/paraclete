// agent/organs/temporal-memory/core-memory-rank.mjs: how Core Memory entries rank against a search. Firestore has no
// substring search, so a reader fetches the entries its filters allow and ranks them here: by value
// (importance x confidence), multiplied by how many search terms each matches. Pure: it reads nothing
// and renders nothing. Called by the brain's recall (agent/organs/temporal-memory/memory.mjs), which picks the
// candidates it hands the memory organ, and by the core-memory-read command, which prints them in this
// order.

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Distinct lowercased search terms from `terms`. */
function uniqueTerms(terms = []) {
  return [...new Set((terms || []).map((t) => String(t || '').toLowerCase()).filter(Boolean))];
}

/**
 * How many distinct terms from `terms` appear in `entry`'s fact or tags.
 *
 * @param {object} entry - Core Memory entry: {fact?, tags?}
 * @param {string[]} [terms] - search terms
 * @returns {number}
 */
export function countTermMatches(entry, terms = []) {
  const list = uniqueTerms(terms);
  if (!entry || !list.length) return 0;
  const tags = Array.isArray(entry.tags) ? entry.tags.join(' ') : '';
  const searchable = `${String(entry.fact || '')} ${tags}`.toLowerCase();
  return list.filter((t) => searchable.includes(t)).length;
}

/**
 * Ranks Core Memory entries by value, surfacing the useful ones first: importance x confidence x
 * (1 + matched terms), newest first on a tie. A term matches when it appears in the entry's fact or
 * tags. Entries written before importance and confidence existed rank as importance 0.5 and
 * confidence 0.9. With terms, an entry that matches none is dropped; with none, every entry ranks.
 *
 * @param {object[]} entries - Core Memory entries: {fact, tags?, importance?, confidence?, createdAt?}
 * @param {string[]} [terms] - lowercased search terms
 * @returns {object[]} the entries, best first
 */
export function rankCoreMemory(entries, terms = []) {
  const list = uniqueTerms(terms);
  const scored = [];
  for (const e of entries || []) {
    const matches = countTermMatches(e, list);
    if (list.length && matches === 0) continue;
    scored.push({ entry: e, score: num(e.importance, 0.5) * num(e.confidence, 0.9) * (1 + matches) });
  }
  scored.sort((a, b) => (b.score - a.score) || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || '')));
  return scored.map((s) => s.entry);
}

/**
 * The Core Memory entries that specifically match `terms`, ranked best first. When at least one entry
 * matches two or more distinct query terms, entries that match only one term (sharing only an entity
 * name or a generic word) are left out of the targeted query block so they fall through to the recent
 * background scan instead of appearing alongside specific matches.
 *
 * @param {object[]} entries - Core Memory entries
 * @param {string[]} [terms] - search terms
 * @returns {object[]}
 */
export function selectQueryMatches(entries, terms = []) {
  const list = uniqueTerms(terms);
  if (!list.length) return [];
  const ranked = rankCoreMemory(entries, list);
  const maxMatches = ranked.reduce((max, e) => Math.max(max, countTermMatches(e, list)), 0);
  const minMatches = maxMatches >= 2 ? 2 : 1;
  return ranked.filter((e) => countTermMatches(e, list) >= minMatches);
}
