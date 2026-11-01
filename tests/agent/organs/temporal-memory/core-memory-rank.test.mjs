// Tests for agent/organs/temporal-memory/core-memory-rank.mjs: Core Memory ranked by value and matched search terms,
// entries matching no term dropped, ties newest first, and the defaults for unweighted entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCoreMemory } from '../../../../agent/organs/temporal-memory/core-memory-rank.mjs';

test('Core Memory ranks by value and matched terms; with terms, an entry that matches none is dropped', () => {
  const entries = [
    { id: 'a', fact: 'The site deploys from main', importance: 0.5, confidence: 0.9, createdAt: '2026-10-01' },
    { id: 'b', fact: 'Reports go to the finance folder', importance: 0.9, confidence: 0.9, createdAt: '2026-10-02', tags: ['reports'] },
    { id: 'c', fact: 'unrelated', createdAt: '2026-10-03' },
  ];
  assert.deepEqual(rankCoreMemory(entries, ['reports']).map((e) => e.id), ['b']);
  assert.deepEqual(rankCoreMemory(entries).map((e) => e.id), ['b', 'c', 'a']);
});

test('ties rank newest first; missing weights default to importance 0.5 and confidence 0.9', () => {
  const ranked = rankCoreMemory([
    { id: 'old', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'new', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'weighted', importance: 0.5, confidence: 0.9, createdAt: '2025-01-01T00:00:00Z' },
  ], []);
  assert.deepEqual(ranked.map((e) => e.id), ['new', 'old', 'weighted']);
});
