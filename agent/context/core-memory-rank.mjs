// agent/context/core-memory-rank.mjs: how Core Memory entries rank against a search. Firestore has no
// substring search, so a reader fetches the entries its filters allow and ranks them here: by value
// (importance x confidence), multiplied by how many search terms each matches. Pure: it reads nothing
// and renders nothing. Called by the brain's recall (agent/services/brain/memory.mjs), which picks the
// candidates it hands the memory organ, and by the core-memory-read command, which prints them in this
// order.

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

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
  const scored = [];
  for (const e of entries || []) {
    const tags = Array.isArray(e.tags) ? e.tags.join(' ') : '';
    const searchable = `${String(e.fact || '')} ${tags}`.toLowerCase();
    const matches = terms.filter((t) => searchable.includes(t)).length;
    if (terms.length && matches === 0) continue;
    scored.push({ entry: e, score: num(e.importance, 0.5) * num(e.confidence, 0.9) * (1 + matches) });
  }
  scored.sort((a, b) => (b.score - a.score) || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || '')));
  return scored.map((s) => s.entry);
}
