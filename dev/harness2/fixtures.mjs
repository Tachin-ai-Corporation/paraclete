// dev/harness2/fixtures.mjs: Concrete, reproducible workspace fixtures and deterministic post-mission
// verifiers for Stage 1 benchmark tasks (paraclete-h2, software-engineer, qa-engineer, devops-engineer).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function readJson(root, relPath) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

function runNodeTest(workspaceDir, relTestFile) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const stdout = execFileSync(process.execPath, ['--test', relTestFile], {
      cwd: workspaceDir,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { pass: true, stdout };
  } catch (err) {
    return {
      pass: false,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
    };
  }
}

/**
 * Seeded workspace fixtures keyed by Stage 1 task ID.
 * Each fixture provides:
 * - `seedWorkspace(workspaceDir)`: writes the initial broken/seeded files into the task workspace
 * - `applyReferenceSolution(workspaceDir)`: applies the reference repair (used by in-process motor turns)
 * - `verifyWorkspace(workspaceDir)`: runs deterministic post-mission assertions (including `node --test`)
 */
export const STAGE1_FIXTURES = Object.freeze({
  'h2-01-lens-diagnosis': Object.freeze({
    id: 'h2-01-lens-diagnosis',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'trajectories/failed-rollout.json',
        JSON.stringify(
          {
            missionId: 'm-seed-inv-01',
            role: 'software-engineer',
            missionCompleted: false,
            errorToolCalls: 3,
            loopGuardTriggerCount: 1,
            adversarialFailureCount: 0,
            proposedTouchedPaths: ['agent/work/checkpoint-spine.mjs', 'config/contracts.json'],
          },
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const traj = readJson(workspaceDir, 'trajectories/failed-rollout.json') || {};
      const diagnosis = {
        missionId: traj.missionId || 'm-seed-inv-01',
        primaryLens: (traj.errorToolCalls || 0) > 0 ? 'INV' : 'DOM',
        spineViolations: (traj.proposedTouchedPaths || []).filter((p) => p.startsWith('agent/work/')),
        allowedPaths: (traj.proposedTouchedPaths || []).filter((p) => !p.startsWith('agent/work/')),
        isolatedSingleLens: true,
      };
      writeFile(workspaceDir, 'diagnosis.json', `${JSON.stringify(diagnosis, null, 2)}\n`);
    },
    verifyWorkspace(workspaceDir) {
      const diag = readJson(workspaceDir, 'diagnosis.json');
      if (!diag) return { verified: false, reason: 'missing diagnosis.json' };
      if (diag.primaryLens !== 'INV') {
        return { verified: false, reason: `expected primaryLens='INV', got '${diag.primaryLens}'` };
      }
      if (!Array.isArray(diag.spineViolations) || !diag.spineViolations.includes('agent/work/checkpoint-spine.mjs')) {
        return { verified: false, reason: 'diagnosis.json did not flag immutable spine path agent/work/checkpoint-spine.mjs' };
      }
      return { verified: true, reason: 'diagnosis.json accurately routed INV lens and rejected spine violation' };
    },
  }),

  'h2-02-pareto-promotion': Object.freeze({
    id: 'h2-02-pareto-promotion',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'candidates.json',
        JSON.stringify(
          {
            baseline: { id: 'gen0-base', scores: { capability: 0.8, reliability: 0.75, efficiency: 0.7, fitness: 0.76 } },
            candidates: [
              { id: 'cand-regressed-cap', scores: { capability: 0.7, reliability: 0.95, efficiency: 0.9, fitness: 0.82 } },
              { id: 'cand-pareto-1', scores: { capability: 0.9, reliability: 0.88, efficiency: 0.82, fitness: 0.88 } },
            ],
          },
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const data = readJson(workspaceDir, 'candidates.json') || { baseline: {}, candidates: [] };
      const baseCap = data.baseline?.scores?.capability ?? 0;
      const valid = (data.candidates || []).filter((c) => (c.scores?.capability ?? 0) >= baseCap);
      valid.sort((a, b) => (b.scores?.fitness ?? 0) - (a.scores?.fitness ?? 0));
      const winner = valid[0] || null;
      writeFile(
        workspaceDir,
        'promotion-verdict.json',
        `${JSON.stringify({ ready: Boolean(winner), winnerId: winner?.id || null, rejectedCount: (data.candidates || []).length - valid.length }, null, 2)}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const verdict = readJson(workspaceDir, 'promotion-verdict.json');
      if (!verdict) return { verified: false, reason: 'missing promotion-verdict.json' };
      if (verdict.ready !== true || verdict.winnerId !== 'cand-pareto-1') {
        return { verified: false, reason: `expected winnerId='cand-pareto-1' with ready=true, got ${JSON.stringify(verdict)}` };
      }
      return { verified: true, reason: 'promotion-verdict.json selected cand-pareto-1 and filtered capability regression' };
    },
  }),

  'se-01-checkpoint-fix': Object.freeze({
    id: 'se-01-checkpoint-fix',
    seedWorkspace(workspaceDir) {
      writeFile(workspaceDir, 'package.json', JSON.stringify({ name: 'se-01-fixture', type: 'module' }, null, 2));
      writeFile(
        workspaceDir,
        'src/calc.mjs',
        [
          '// Bug: off-by-one upper bound excludes `end`',
          'export function sumInclusiveRange(start, end) {',
          '  let total = 0;',
          '  for (let i = start; i < end; i += 1) {',
          '    total += i;',
          '  }',
          '  return total;',
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        workspaceDir,
        'test/calc.test.mjs',
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { sumInclusiveRange } from '../src/calc.mjs';",
          '',
          "test('sums inclusive integer range accurately', () => {",
          '  assert.equal(sumInclusiveRange(1, 4), 10);',
          '  assert.equal(sumInclusiveRange(3, 3), 3);',
          '});',
          '',
        ].join('\n'),
      );
    },
    applyReferenceSolution(workspaceDir) {
      writeFile(
        workspaceDir,
        'src/calc.mjs',
        [
          'export function sumInclusiveRange(start, end) {',
          '  let total = 0;',
          '  for (let i = start; i <= end; i += 1) {',
          '    total += i;',
          '  }',
          '  return total;',
          '}',
          '',
        ].join('\n'),
      );
    },
    verifyWorkspace(workspaceDir) {
      const res = runNodeTest(workspaceDir, 'test/calc.test.mjs');
      return {
        verified: res.pass,
        reason: res.pass ? 'test/calc.test.mjs passed' : `test/calc.test.mjs failed: ${res.stderr}`,
      };
    },
  }),

  'se-02-contract-boundary': Object.freeze({
    id: 'se-02-contract-boundary',
    seedWorkspace(workspaceDir) {
      writeFile(workspaceDir, 'package.json', JSON.stringify({ name: 'se-02-fixture', type: 'module' }, null, 2));
      writeFile(
        workspaceDir,
        'src/service.mjs',
        [
          '// Hardcoded dependency without injectable deps parameter',
          'export async function loadUserProfile(userId) {',
          '  throw new Error(`network disabled for ${userId}`);',
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        workspaceDir,
        'test/service.test.mjs',
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { loadUserProfile } from '../src/service.mjs';",
          '',
          "test('accepts injectable fetchProfile dependency', async () => {",
          '  const profile = await loadUserProfile("u-42", {',
          '    fetchProfile: async (id) => ({ id, role: "builder" }),',
          '  });',
          '  assert.deepEqual(profile, { id: "u-42", role: "builder" });',
          '});',
          '',
        ].join('\n'),
      );
    },
    applyReferenceSolution(workspaceDir) {
      writeFile(
        workspaceDir,
        'src/service.mjs',
        [
          'export async function loadUserProfile(userId, deps = {}) {',
          '  const fetchProfile = deps.fetchProfile || (async (id) => { throw new Error(`network disabled for ${id}`); });',
          '  return fetchProfile(userId);',
          '}',
          '',
        ].join('\n'),
      );
    },
    verifyWorkspace(workspaceDir) {
      const res = runNodeTest(workspaceDir, 'test/service.test.mjs');
      return {
        verified: res.pass,
        reason: res.pass ? 'test/service.test.mjs passed with injectable deps' : `test/service.test.mjs failed: ${res.stderr}`,
      };
    },
  }),

  'qa-01-adversarial-repro': Object.freeze({
    id: 'qa-01-adversarial-repro',
    seedWorkspace(workspaceDir) {
      writeFile(workspaceDir, 'package.json', JSON.stringify({ name: 'qa-01-fixture', type: 'module' }, null, 2));
      writeFile(
        workspaceDir,
        'src/parser.mjs',
        [
          'export function parseKeyVal(line) {',
          '  if (typeof line !== "string" || !line.trim()) return null;',
          '  const idx = line.indexOf("=");',
          '  if (idx <= 0) return null;',
          '  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };',
          '}',
          '',
        ].join('\n'),
      );
    },
    applyReferenceSolution(workspaceDir) {
      writeFile(
        workspaceDir,
        'test/repro.test.mjs',
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { parseKeyVal } from '../src/parser.mjs';",
          '',
          "test('handles empty input and key=value pairs deterministically', () => {",
          '  assert.equal(parseKeyVal(""), null);',
          '  assert.equal(parseKeyVal("   "), null);',
          '  assert.deepEqual(parseKeyVal("PORT=8080"), { key: "PORT", value: "8080" });',
          '});',
          '',
        ].join('\n'),
      );
    },
    verifyWorkspace(workspaceDir) {
      if (!fs.existsSync(path.join(workspaceDir, 'test/repro.test.mjs'))) {
        return { verified: false, reason: 'missing reproduction test file test/repro.test.mjs' };
      }
      const res = runNodeTest(workspaceDir, 'test/repro.test.mjs');
      return {
        verified: res.pass,
        reason: res.pass ? 'test/repro.test.mjs exists and passes' : `test/repro.test.mjs failed: ${res.stderr}`,
      };
    },
  }),

  'devops-01-canary-health': Object.freeze({
    id: 'devops-01-canary-health',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'release/current.json',
        JSON.stringify({ version: 'v2026.10.18.1.0', path: 'releases/v2026.10.18.1.0' }, null, 2),
      );
      writeFile(
        workspaceDir,
        'releases/v2026.10.19.1.0/manifest.json',
        JSON.stringify({ version: 'v2026.10.19.1.0', status: 'verified' }, null, 2),
      );
      writeFile(
        workspaceDir,
        'health/gateway-status.json',
        JSON.stringify({ service: 'paraclete-gateway', active: true, ready: true }, null, 2),
      );
    },
    applyReferenceSolution(workspaceDir) {
      writeFile(
        workspaceDir,
        'release/current.json',
        `${JSON.stringify({ version: 'v2026.10.19.1.0', path: 'releases/v2026.10.19.1.0' }, null, 2)}\n`,
      );
      writeFile(
        workspaceDir,
        'health-report.json',
        `${JSON.stringify({ healthy: true, activeRelease: 'v2026.10.19.1.0', gatewayReady: true }, null, 2)}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const current = readJson(workspaceDir, 'release/current.json');
      const report = readJson(workspaceDir, 'health-report.json');
      if (!current || current.version !== 'v2026.10.19.1.0') {
        return { verified: false, reason: 'release/current.json was not updated to healthy release v2026.10.19.1.0' };
      }
      if (!report || report.healthy !== true) {
        return { verified: false, reason: 'missing or unhealthy health-report.json' };
      }
      return { verified: true, reason: 'release pointer repaired and health-report.json verified' };
    },
  }),
});

/**
 * Look up a Stage 1 fixture definition by task ID, normalizing `verifyWorkspace`
 * so callers can read either `{ verified, reason }` or `{ passed, summary, toolRecords }`.
 *
 * @param {string} taskId
 * @returns {object|null}
 */
export function getTaskFixture(taskId) {
  const raw = STAGE1_FIXTURES[taskId];
  if (!raw) return null;
  return {
    ...raw,
    verifyWorkspace(workspaceDir) {
      const res = raw.verifyWorkspace(workspaceDir);
      const passed = Boolean(res.passed ?? res.verified);
      const summary = res.summary || res.reason || '';
      const toolRecords = res.toolRecords || [
        { tool: 'shell', command: `verify ${taskId}`, exitCode: passed ? 0 : 1 },
      ];
      return {
        ...res,
        verified: passed,
        passed,
        reason: summary,
        summary,
        toolRecords,
      };
    },
  };
}

