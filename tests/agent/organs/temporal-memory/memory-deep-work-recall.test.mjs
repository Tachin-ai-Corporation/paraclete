// Tests for agent/organs/temporal-memory/work-recall.mjs and agent/organs/temporal-memory/memory.mjs:
// multi-word and capitalized cues match across intervening stopwords or reversed word order, fenced
// escalation replies parse cleanly, deep work recall merges escalation cues with request cues and
// checks 180-day history when the 30-day search had no hits, and recall preserves operational commands,
// parameters, and conditions from matching past work.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { start as startFirestore } from '../../../fakes/firestore-server.mjs';
import { createClient } from '../../../../agent/storage/firestore.mjs';
import { COLLECTIONS } from '../../../../agent/storage/collections.mjs';
import { cueMatches, extractCues, scoreRelevance, searchWork } from '../../../../agent/organs/temporal-memory/work-recall.mjs';
import { PRELOADED_END, PRELOADED_START, createMemory, createMemoryFiles, parseEscalation } from '../../../../agent/organs/temporal-memory/memory.mjs';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

let firestore;
let db;
let scratch;

before(async () => {
  firestore = await startFirestore();
  db = createClient({
    projectId: firestore.projectId,
    firestoreHost: firestore.origin,
    getAccessToken: async () => 't',
    logger: () => {},
  });
  scratch = mkdtempSync(join(tmpdir(), 'memory-deep-work-recall-'));
});

after(async () => {
  await firestore.stop();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => firestore.reset());

test('cueMatches and scoreRelevance match multi-word and capitalized cues across stopwords and word order', () => {
  const blob = 'migrate the analytics warehouse from the staging archive';
  assert.equal(cueMatches(blob, 'migrate analytics'), true, 'matches across intervening stopword');
  assert.equal(cueMatches(blob, 'analytics archive'), true, 'matches non-adjacent content tokens');
  assert.equal(cueMatches(blob, 'warehouse migrate'), true, 'matches regardless of token order');
  assert.equal(cueMatches(blob, 'Analytics'), true, 'matches case-insensitively');
  assert.equal(cueMatches(blob, 'migrate billing'), false, 'requires every content token to appear');

  const env = {
    id: 'w-mig',
    type: 'M',
    status: 'complete',
    title: 'Migrate the analytics warehouse from the staging archive',
    instruction: 'Migrate the analytics warehouse from the staging archive',
    output: 'Enabled the read-only window, then ran schema-migrate --verify against analytics-staging-archive.',
    created_at: daysAgo(100),
    completed_at: daysAgo(100),
  };
  const cues = extractCues('Migrate the analytics warehouse from this week archive');
  assert.ok(cues.includes('migrate analytics'));
  assert.ok(scoreRelevance(env, ['migrate analytics', 'analytics archive', 'Analytics'], NOW) > 0.5);
});

test('parseEscalation accepts raw JSON and markdown-fenced JSON escalation replies', () => {
  const fenced = [
    '```json',
    '{"recall_escalate": true, "cues": ["analytics", "warehouse"], "reason": "older history"}',
    '```',
  ].join('\n');
  assert.deepEqual(parseEscalation(fenced), {
    cues: ['analytics', 'warehouse'],
    reason: 'older history',
  });
});

test('escalated recall merges escalation cues with request cues and surfaces 180-day work', async () => {
  const dir = mkdtempSync(join(scratch, 'esc-'));
  const files = createMemoryFiles({ workingMemoryFile: join(dir, 'MEMORY.md'), deepTruthsFile: join(dir, 'DEEP_TRUTHS.md') });
  await db.write(`${COLLECTIONS.work}/w-analytics`, {
    id: 'w-analytics',
    type: 'M',
    status: 'complete',
    title: 'Migrate the analytics warehouse from the staging archive',
    instruction: 'Migrate the analytics warehouse from the staging archive',
    output: 'Enabled the read-only window, then ran schema-migrate --verify against analytics-staging-archive.',
    created_at: daysAgo(100),
    completed_at: daysAgo(100),
  });
  await db.write(`${COLLECTIONS.work}/w-cache`, {
    id: 'w-cache',
    type: 'M',
    status: 'complete',
    title: 'Flush the edge cache',
    instruction: 'Flush the edge cache',
    output: 'Cleared the CDN edge cache with cdn-purge --all.',
    created_at: daysAgo(4),
    completed_at: daysAgo(4),
  });

  const calls = [];
  const callAgent = async (name, payload) => {
    calls.push({ name, payload });
    if (calls.length === 1) {
      return {
        success: true,
        output: [
          '```json',
          '{"recall_escalate": true, "cues": ["analytics warehouse migrate", "unmatched-synonym-one", "unmatched-synonym-two", "unmatched-synonym-three", "unmatched-synonym-four"], "reason": "need older migration"}',
          '```',
        ].join('\n'),
      };
    }
    return {
      success: true,
      output: 'Enable the read-only window first, then run schema-migrate --verify against analytics-staging-archive (w-analytics).',
    };
  };

  const memory = createMemory({ db, callAgent, files, clock: () => NOW });
  const res = await memory.recall('Migrate the analytics warehouse from the staging archive the way we did before');

  assert.equal(calls.length, 2);
  const secondData = calls[1].payload.instruction.slice(
    calls[1].payload.instruction.indexOf(PRELOADED_START),
    calls[1].payload.instruction.indexOf(PRELOADED_END),
  );
  assert.match(secondData, /## Deep Work History \(180d, 1 hits\)/);
  assert.match(secondData, /schema-migrate --verify/);
  assert.match(secondData, /read-only window/);
  assert.match(calls[1].payload.accept_criteria, /keeping exact commands, parameters, and operational conditions from matching work/);
  assert.match(res.recalled, /schema-migrate --verify/);
});

test('recall checks 180-day work history when 30-day search had no hits and the first pass returned no context', async () => {
  const dir = mkdtempSync(join(scratch, 'fallback-'));
  const files = createMemoryFiles({ workingMemoryFile: join(dir, 'MEMORY.md'), deepTruthsFile: join(dir, 'DEEP_TRUTHS.md') });
  await db.write(`${COLLECTIONS.work}/w-analytics`, {
    id: 'w-analytics',
    type: 'M',
    status: 'complete',
    title: 'Migrate the analytics warehouse from the staging archive',
    instruction: 'Migrate the analytics warehouse from the staging archive',
    output: 'Enabled the read-only window, then ran schema-migrate --verify against analytics-staging-archive.',
    created_at: daysAgo(100),
    completed_at: daysAgo(100),
  });

  const calls = [];
  const callAgent = async (name, payload) => {
    calls.push({ name, payload });
    if (calls.length === 1) return { success: true, output: 'No relevant context found.' };
    return {
      success: true,
      output: 'Enable the read-only window and run schema-migrate --verify (w-analytics).',
    };
  };

  const memory = createMemory({ db, callAgent, files, clock: () => NOW });
  const res = await memory.recall('Migrate the analytics warehouse from the staging archive');
  assert.equal(calls.length, 2);
  assert.match(calls[1].payload.instruction, /schema-migrate --verify/);
  assert.match(res.recalled, /schema-migrate --verify/);
});

test('temporal-memory prompt and memory-recall skill instruct keeping commands, parameters, and conditions from matching past work', () => {
  const prompt = readFileSync(join(REPO, 'prompts', 'temporal-memory.md'), 'utf8');
  const skill = readFileSync(join(REPO, 'skills', 'memory-recall', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(prompt, /never the tools, commands or step sequences a past task used/);
  assert.match(prompt, /Keep operational details and conditions from matching past work/);
  assert.match(skill, /Keep operational details and conditions from matching past work/);
});
