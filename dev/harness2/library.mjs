// dev/harness2/library.mjs: Skill & Prompt Lineage Archive for Loop A evolutionary generations.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Default local path inside `os.tmpdir()` for persisting evolutionary generation logs
 * and Pareto frontier state without polluting the tracked repository tree.
 */
export const DEFAULT_ARCHIVE_PATH = 'paraclete-h2/lineage-archive.json';

/**
 * Create an in-memory or disk-backed lineage archive for tracking harness candidates,
 * their 3D score vectors, touched surface components, and parent-child lineage.
 *
 * @param {object} [opts]
 * @param {string} [opts.archivePath]
 * @param {object} [opts.deps]
 */
export function createLineageLibrary(opts = {}) {
  const archivePath = opts.archivePath || join(tmpdir(), DEFAULT_ARCHIVE_PATH);
  const fsDeps = {
    existsSync: opts.deps?.existsSync || existsSync,
    readFileSync: opts.deps?.readFileSync || readFileSync,
    writeFileSync: opts.deps?.writeFileSync || writeFileSync,
    mkdirSync: opts.deps?.mkdirSync || mkdirSync,
  };

  function load() {
    if (!fsDeps.existsSync(archivePath)) {
      return { generations: [], candidates: [] };
    }
    try {
      return JSON.parse(fsDeps.readFileSync(archivePath, 'utf8'));
    } catch {
      return { generations: [], candidates: [] };
    }
  }

  function save(state) {
    fsDeps.mkdirSync(dirname(archivePath), { recursive: true });
    fsDeps.writeFileSync(archivePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  function recordCandidate(entry) {
    const state = load();
    const record = {
      id: entry.id,
      parentId: entry.parentId || null,
      generation: entry.generation ?? 0,
      lens: entry.lens || null,
      stage: entry.stage || 'stage1',
      touchedPaths: entry.touchedPaths || [],
      hypothesis: entry.hypothesis || '',
      scores: entry.scores || { capability: 0, reliability: 0, efficiency: 0, fitness: 0 },
      promoted: Boolean(entry.promoted),
      createdAt: entry.createdAt || new Date().toISOString(),
    };
    state.candidates.push(record);
    save(state);
    return record;
  }

  function recordGeneration(genSummary) {
    const state = load();
    const record = {
      generation: genSummary.generation,
      stage: genSummary.stage || 'stage1',
      winnerId: genSummary.winnerId || null,
      synthesized: Boolean(genSummary.synthesized),
      frontierIds: genSummary.frontierIds || [],
      scores: genSummary.scores || null,
      completedAt: genSummary.completedAt || new Date().toISOString(),
    };
    state.generations.push(record);
    save(state);
    return record;
  }

  function getLineage(candidateId) {
    const state = load();
    const byId = new Map(state.candidates.map((c) => [c.id, c]));
    const chain = [];
    let cursor = byId.get(candidateId);
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
    return chain.reverse();
  }

  return {
    archivePath,
    load,
    save,
    recordCandidate,
    recordGeneration,
    getLineage,
  };
}
