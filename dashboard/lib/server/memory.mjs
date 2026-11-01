// dashboard/lib/server/memory.mjs: the agent's Core Memory as the dashboard shows it. Core Memory is
// the root `core_memory` collection, one document per durable fact, written only by the agent's own
// commands: core-memory-write creates an entry (and marks the one it replaces superseded),
// core-memory-retire retires one. The dashboard only reads it. The working-memory files (MEMORY.md,
// DEEP_TRUTHS.md) are files on the VM and come through the `workspace` command instead.
//
// An entry, as agent/cli/core-memory-write.mjs writes it:
//   { id, fact, category, tags[], confidence 0..1, importance 0..1, source, sourceDetail?,
//     supersedes?, supersededBy, createdAt, lastRecalledAt, recallCount,
//     status: 'active' | 'superseded' | 'retired', retiredAt?, retireReason? }
// Field names stay the agent's, so what the dashboard shows matches what the agent reads.
//
// Firestore has no text search, so the browser searches and filters what this returns. Entries come
// most valuable first, the agent's own order with no search terms (agent/organs/temporal-memory/core-memory-rank.mjs,
// which the dashboard may not import): importance x confidence, an entry without them counting as 0.5
// and 0.9, newest first on a tie.

import { HttpError } from './errors.mjs';

/** The statuses an entry moves through; `all` reads every one of them. */
export const CORE_MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'retired']);

/** The most entries one read returns. Core Memory is pruned nightly and stays far below this. */
export const CORE_MEMORY_LIMIT = 500;

const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_CONFIDENCE = 0.9;

const unit = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const instant = (v) => {
  const at = Date.parse(v);
  return Number.isFinite(at) ? at : -Infinity;
};

function shapeEntry(doc) {
  const importance = unit(doc.importance);
  const confidence = unit(doc.confidence);
  return {
    id: doc.id,
    fact: text(doc.fact),
    category: text(doc.category) || null,
    tags: Array.isArray(doc.tags) ? doc.tags.map(text).filter(Boolean) : [],
    importance,
    confidence,
    value: (importance ?? DEFAULT_IMPORTANCE) * (confidence ?? DEFAULT_CONFIDENCE),
    source: text(doc.source) || null,
    sourceDetail: text(doc.sourceDetail) || null,
    status: text(doc.status) || null,
    supersedes: text(doc.supersedes) || null,
    supersededBy: text(doc.supersededBy) || null,
    createdAt: doc.createdAt ?? null,
    lastRecalledAt: doc.lastRecalledAt ?? null,
    recallCount: typeof doc.recallCount === 'number' ? doc.recallCount : null,
    retiredAt: doc.retiredAt ?? null,
    retireReason: text(doc.retireReason) || null,
  };
}

/** Most valuable first, newest first on a tie. Dates compare as instants, never as strings. */
function byValue(a, b) {
  return (b.value - a.value) || (instant(b.createdAt) - instant(a.createdAt));
}

/**
 * Core Memory entries in one status (or every status), most valuable first, with the categories
 * they use. Read strictly: an outage is an error, never an empty memory.
 *
 * @param {object} runtime
 * @param {object} [o]
 * @param {string} [o.status] 'active' (default), 'superseded', 'retired' or 'all'
 * @returns {Promise<{status: string, entries: object[], categories: string[], limited: boolean, limit: number}>}
 */
export async function listCoreMemory(runtime, { status = 'active' } = {}) {
  if (status !== 'all' && !CORE_MEMORY_STATUSES.includes(status)) {
    throw new HttpError(400, `the status must be one of ${[...CORE_MEMORY_STATUSES, 'all'].join(', ')}`);
  }
  const filters = status === 'all' ? [] : [{ field: 'status', op: 'EQUAL', value: { stringValue: status } }];
  const docs = await runtime.db.query('', runtime.collections.coreMemory, filters, {
    noOrderBy: true, limit: CORE_MEMORY_LIMIT, strict: true,
  });
  const entries = docs.map(shapeEntry).sort(byValue);
  const categories = [...new Set(entries.map((e) => e.category).filter(Boolean))].sort();
  return { status, entries, categories, limited: docs.length >= CORE_MEMORY_LIMIT, limit: CORE_MEMORY_LIMIT };
}
