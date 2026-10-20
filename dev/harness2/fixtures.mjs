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
 * Seeded workspace fixtures keyed by Stage 2 specialist role task ID.
 */
export const STAGE2_FIXTURES = Object.freeze({
  'gen-01-grounded-synthesis': Object.freeze({
    id: 'gen-01-grounded-synthesis',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'sources/primary-a.json',
        JSON.stringify({ engine: 'alpha', p95Ms: 42, costPer1k: 0.12 }, null, 2),
      );
      writeFile(
        workspaceDir,
        'sources/primary-b.json',
        JSON.stringify({ engine: 'beta', p95Ms: 68, costPer1k: 0.08 }, null, 2),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const a = readJson(workspaceDir, 'sources/primary-a.json') || {};
      const b = readJson(workspaceDir, 'sources/primary-b.json') || {};
      writeFile(
        workspaceDir,
        'synthesis.json',
        `${JSON.stringify(
          {
            fasterEngine: (a.p95Ms ?? 999) < (b.p95Ms ?? 999) ? a.engine : b.engine,
            lowerCostEngine: (a.costPer1k ?? 999) < (b.costPer1k ?? 999) ? a.engine : b.engine,
            p95DeltaMs: Math.abs((b.p95Ms ?? 0) - (a.p95Ms ?? 0)),
            citations: ['sources/primary-a.json', 'sources/primary-b.json'],
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const syn = readJson(workspaceDir, 'synthesis.json');
      if (!syn) return { verified: false, reason: 'missing synthesis.json' };
      if (syn.fasterEngine !== 'alpha' || syn.lowerCostEngine !== 'beta' || syn.p95DeltaMs !== 26) {
        return { verified: false, reason: `unexpected synthesis metrics: ${JSON.stringify(syn)}` };
      }
      return { verified: true, reason: 'synthesis.json verified against primary-a.json and primary-b.json' };
    },
  }),

  'da-01-cohort-variance': Object.freeze({
    id: 'da-01-cohort-variance',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'data/cohorts.json',
        JSON.stringify(
          {
            baselineRetentionPct: 78.0,
            cohorts: [
              { id: 'cohort-2026-01', retentionPct: 77.5 },
              { id: 'cohort-2026-02', retentionPct: 41.5 },
              { id: 'cohort-2026-03', retentionPct: 79.0 },
            ],
          },
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const data = readJson(workspaceDir, 'data/cohorts.json') || { baselineRetentionPct: 78, cohorts: [] };
      const anomaly = (data.cohorts || []).find((c) => data.baselineRetentionPct - c.retentionPct > 20);
      writeFile(
        workspaceDir,
        'variance-report.json',
        `${JSON.stringify(
          {
            anomalousCohort: anomaly?.id || null,
            deltaPct: anomaly ? Number((anomaly.retentionPct - data.baselineRetentionPct).toFixed(1)) : 0,
            checkedCount: (data.cohorts || []).length,
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const rep = readJson(workspaceDir, 'variance-report.json');
      if (!rep) return { verified: false, reason: 'missing variance-report.json' };
      if (rep.anomalousCohort !== 'cohort-2026-02' || rep.deltaPct !== -36.5) {
        return { verified: false, reason: `expected cohort-2026-02 (-36.5%), got ${JSON.stringify(rep)}` };
      }
      return { verified: true, reason: 'variance-report.json isolated cohort-2026-02 anomaly accurately' };
    },
  }),

  'de-01-pipeline-schema-audit': Object.freeze({
    id: 'de-01-pipeline-schema-audit',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'schemas/expected.json',
        JSON.stringify({ partitionBy: 'DAY(ingestion_ts)', columns: { event_id: 'STRING', ingestion_ts: 'TIMESTAMP' } }, null, 2),
      );
      writeFile(
        workspaceDir,
        'schemas/live-bq.json',
        JSON.stringify({ partitionBy: null, rowCount: 14200, columns: { event_id: 'STRING', ingestion_ts: 'STRING' } }, null, 2),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const exp = readJson(workspaceDir, 'schemas/expected.json') || { columns: {} };
      const live = readJson(workspaceDir, 'schemas/live-bq.json') || { columns: {} };
      const drifted = Object.keys(exp.columns || {}).filter((k) => exp.columns[k] !== live.columns?.[k]);
      writeFile(
        workspaceDir,
        'schema-drift-report.json',
        `${JSON.stringify(
          {
            driftedColumns: drifted,
            partitionValid: exp.partitionBy === live.partitionBy,
            rowCount: live.rowCount ?? 0,
            tableMutated: false,
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const rep = readJson(workspaceDir, 'schema-drift-report.json');
      if (!rep) return { verified: false, reason: 'missing schema-drift-report.json' };
      if (!Array.isArray(rep.driftedColumns) || !rep.driftedColumns.includes('ingestion_ts') || rep.partitionValid !== false) {
        return { verified: false, reason: `invalid schema drift report: ${JSON.stringify(rep)}` };
      }
      return { verified: true, reason: 'schema-drift-report.json flagged ingestion_ts type drift and missing partition' };
    },
  }),

  'sec-01-iam-least-privilege': Object.freeze({
    id: 'sec-01-iam-least-privilege',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'iam/policy.json',
        JSON.stringify(
          {
            bindings: [
              { role: 'roles/owner', members: ['serviceAccount:ci-runner@example.com'] },
              { role: 'roles/viewer', members: ['user:auditor@example.com'] },
            ],
            serviceAccountKeys: [{ id: 'key-old-01', ageDays: 185, principal: 'serviceAccount:ci-runner@example.com' }],
          },
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const pol = readJson(workspaceDir, 'iam/policy.json') || { bindings: [], serviceAccountKeys: [] };
      const owners = (pol.bindings || []).find((b) => b.role === 'roles/owner')?.members || [];
      const agedKeys = (pol.serviceAccountKeys || []).filter((k) => k.ageDays > 90).map((k) => k.id);
      writeFile(
        workspaceDir,
        'iam/remediation-plan.json',
        `${JSON.stringify(
          {
            overPrivilegedPrincipals: owners,
            recommendedRole: 'roles/storage.objectViewer',
            rotateKeyIds: agedKeys,
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const plan = readJson(workspaceDir, 'iam/remediation-plan.json');
      if (!plan) return { verified: false, reason: 'missing iam/remediation-plan.json' };
      if (
        !Array.isArray(plan.overPrivilegedPrincipals) ||
        !plan.overPrivilegedPrincipals.includes('serviceAccount:ci-runner@example.com') ||
        !Array.isArray(plan.rotateKeyIds) ||
        !plan.rotateKeyIds.includes('key-old-01')
      ) {
        return { verified: false, reason: `incomplete IAM remediation plan: ${JSON.stringify(plan)}` };
      }
      return { verified: true, reason: 'iam/remediation-plan.json identified over-privileged SA and aged key' };
    },
  }),

  'web-01-endpoint-vitals': Object.freeze({
    id: 'web-01-endpoint-vitals',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'probes/endpoints.json',
        JSON.stringify(
          [
            { url: 'https://app.example.com/healthz', status: 200, tlsDaysRemaining: 9, hsts: false },
            { url: 'https://api.example.com/v1/ping', status: 200, tlsDaysRemaining: 64, hsts: true },
          ],
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const endpoints = readJson(workspaceDir, 'probes/endpoints.json') || [];
      writeFile(
        workspaceDir,
        'site-health-report.json',
        `${JSON.stringify(
          {
            expiringTlsUrls: endpoints.filter((e) => e.tlsDaysRemaining < 14).map((e) => e.url),
            missingHstsUrls: endpoints.filter((e) => !e.hsts).map((e) => e.url),
            allStatus200: endpoints.every((e) => e.status === 200),
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const rep = readJson(workspaceDir, 'site-health-report.json');
      if (!rep) return { verified: false, reason: 'missing site-health-report.json' };
      if (
        !Array.isArray(rep.expiringTlsUrls) ||
        !rep.expiringTlsUrls.includes('https://app.example.com/healthz') ||
        rep.allStatus200 !== true
      ) {
        return { verified: false, reason: `invalid site-health-report.json: ${JSON.stringify(rep)}` };
      }
      return { verified: true, reason: 'site-health-report.json flagged expiring TLS and missing HSTS' };
    },
  }),

  'exec-01-triage-brief': Object.freeze({
    id: 'exec-01-triage-brief',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'inbox/threads.json',
        JSON.stringify(
          [
            { id: 'thread-101', priority: 'normal', requestedSlot: '2026-10-21T14:00:00Z' },
            { id: 'thread-104', priority: 'urgent', requestedSlot: '2026-10-21T14:00:00Z' },
          ],
          null,
          2,
        ),
      );
      writeFile(
        workspaceDir,
        'calendar/slots.json',
        JSON.stringify({ busy: ['2026-10-21T14:00:00Z'], open: ['2026-10-21T15:00:00Z'] }, null, 2),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const threads = readJson(workspaceDir, 'inbox/threads.json') || [];
      const cal = readJson(workspaceDir, 'calendar/slots.json') || { open: [] };
      const urgent = threads.find((t) => t.priority === 'urgent');
      writeFile(
        workspaceDir,
        'decision-brief.json',
        `${JSON.stringify(
          {
            triagedThreadIds: threads.map((t) => t.id),
            conflictThreadId: urgent?.id || null,
            proposedSlot: cal.open?.[0] || null,
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const brief = readJson(workspaceDir, 'decision-brief.json');
      if (!brief) return { verified: false, reason: 'missing decision-brief.json' };
      if (brief.conflictThreadId !== 'thread-104' || brief.proposedSlot !== '2026-10-21T15:00:00Z') {
        return { verified: false, reason: `unexpected decision-brief.json: ${JSON.stringify(brief)}` };
      }
      return { verified: true, reason: 'decision-brief.json triaged authentic thread IDs and resolved slot conflict' };
    },
  }),

  'pm-01-milestone-audit': Object.freeze({
    id: 'pm-01-milestone-audit',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'workstreams/milestones.json',
        JSON.stringify(
          [
            { id: 'ms-01', reportedStatus: 'on_track', blockedBy: [] },
            { id: 'ms-02', reportedStatus: 'on_track', blockedBy: ['dep-auth-migration'] },
          ],
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const list = readJson(workspaceDir, 'workstreams/milestones.json') || [];
      const discrepant = list.filter((m) => m.reportedStatus === 'on_track' && (m.blockedBy || []).length > 0);
      writeFile(
        workspaceDir,
        'risk-register.json',
        `${JSON.stringify(
          {
            discrepantMilestones: discrepant.map((m) => m.id),
            criticalBlocker: discrepant[0]?.blockedBy?.[0] || null,
            reconciledStatus: 'at_risk',
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const reg = readJson(workspaceDir, 'risk-register.json');
      if (!reg) return { verified: false, reason: 'missing risk-register.json' };
      if (
        !Array.isArray(reg.discrepantMilestones) ||
        !reg.discrepantMilestones.includes('ms-02') ||
        reg.criticalBlocker !== 'dep-auth-migration'
      ) {
        return { verified: false, reason: `unexpected risk-register.json: ${JSON.stringify(reg)}` };
      }
      return { verified: true, reason: 'risk-register.json reconciled ms-02 status and blocker dep-auth-migration' };
    },
  }),

  'fin-01-budget-variance': Object.freeze({
    id: 'fin-01-budget-variance',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'finance/q3-ledger.json',
        JSON.stringify(
          {
            budgetTotal: 50000,
            lineItems: [
              { category: 'cloud-compute', budgeted: 20000, actual: 24250 },
              { category: 'saas-licenses', budgeted: 15000, actual: 15000 },
              { category: 'contractors', budgeted: 15000, actual: 15000 },
            ],
          },
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const ledger = readJson(workspaceDir, 'finance/q3-ledger.json') || { budgetTotal: 0, lineItems: [] };
      const actualTotal = (ledger.lineItems || []).reduce((acc, item) => acc + (item.actual || 0), 0);
      const driver = [...(ledger.lineItems || [])].sort(
        (a, b) => (b.actual - b.budgeted) - (a.actual - a.budgeted),
      )[0];
      writeFile(
        workspaceDir,
        'budget-reconciliation.json',
        `${JSON.stringify(
          {
            actualTotal,
            budgetTotal: ledger.budgetTotal,
            variance: actualTotal - ledger.budgetTotal,
            primaryDriver: driver?.category || null,
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const rec = readJson(workspaceDir, 'budget-reconciliation.json');
      if (!rec) return { verified: false, reason: 'missing budget-reconciliation.json' };
      if (rec.actualTotal !== 54250 || rec.variance !== 4250 || rec.primaryDriver !== 'cloud-compute') {
        return { verified: false, reason: `incorrect budget reconciliation: ${JSON.stringify(rec)}` };
      }
      return { verified: true, reason: 'budget-reconciliation.json verified exact totals and variance driver' };
    },
  }),

  'leg-01-clause-redline': Object.freeze({
    id: 'leg-01-clause-redline',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'contracts/vendor-msa.json',
        JSON.stringify(
          {
            clauses: [
              { section: 'section-5.1', topic: 'confidentiality', compliant: true },
              { section: 'section-8.2', topic: 'liability_cap', value: 'uncapped', compliant: false },
              { section: 'section-11.4', topic: 'breach_notice_hours', value: 2160, compliant: false },
            ],
          },
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const doc = readJson(workspaceDir, 'contracts/vendor-msa.json') || { clauses: [] };
      const bad = (doc.clauses || []).filter((c) => !c.compliant).map((c) => c.section);
      writeFile(
        workspaceDir,
        'redline-guidance.json',
        `${JSON.stringify(
          {
            nonCompliantSections: bad,
            liabilityCap: '12x_annual_fees',
            breachNoticeHours: 72,
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const red = readJson(workspaceDir, 'redline-guidance.json');
      if (!red) return { verified: false, reason: 'missing redline-guidance.json' };
      if (
        !Array.isArray(red.nonCompliantSections) ||
        !red.nonCompliantSections.includes('section-8.2') ||
        !red.nonCompliantSections.includes('section-11.4')
      ) {
        return { verified: false, reason: `incomplete redline-guidance.json: ${JSON.stringify(red)}` };
      }
      return { verified: true, reason: 'redline-guidance.json cited section-8.2 and section-11.4 with policy redlines' };
    },
  }),

  'des-01-layout-hierarchy-audit': Object.freeze({
    id: 'des-01-layout-hierarchy-audit',
    seedWorkspace(workspaceDir) {
      writeFile(
        workspaceDir,
        'design/components.json',
        JSON.stringify(
          [
            { id: 'hero-title', contrastRatio: 7.2, spacingPx: 24 },
            { id: 'hero-subtitle', contrastRatio: 3.1, spacingPx: 13 },
          ],
          null,
          2,
        ),
      );
    },
    applyReferenceSolution(workspaceDir) {
      const comps = readJson(workspaceDir, 'design/components.json') || [];
      const failing = comps.filter((c) => c.contrastRatio < 4.5 || c.spacingPx % 8 !== 0).map((c) => c.id);
      writeFile(
        workspaceDir,
        'layout-fixes.json',
        `${JSON.stringify(
          {
            failingComponents: failing,
            fixedContrastRatio: 4.8,
            fixedSpacingPx: 16,
          },
          null,
          2,
        )}\n`,
      );
    },
    verifyWorkspace(workspaceDir) {
      const fixes = readJson(workspaceDir, 'layout-fixes.json');
      if (!fixes) return { verified: false, reason: 'missing layout-fixes.json' };
      if (
        !Array.isArray(fixes.failingComponents) ||
        !fixes.failingComponents.includes('hero-subtitle') ||
        fixes.fixedContrastRatio < 4.5 ||
        fixes.fixedSpacingPx !== 16
      ) {
        return { verified: false, reason: `invalid layout-fixes.json: ${JSON.stringify(fixes)}` };
      }
      return { verified: true, reason: 'layout-fixes.json remediated hero-subtitle contrast and 8px spacing grid' };
    },
  }),
});

/** Combined catalog of all Stage 1 + Stage 2 workspace fixtures. */
export const ALL_FIXTURES = Object.freeze({
  ...STAGE1_FIXTURES,
  ...STAGE2_FIXTURES,
});

/**
 * Look up a Stage 1 or Stage 2 fixture definition by task ID, normalizing `verifyWorkspace`
 * so callers can read either `{ verified, reason }` or `{ passed, summary, toolRecords }`.
 *
 * @param {string} taskId
 * @returns {object|null}
 */
export function getTaskFixture(taskId) {
  const raw = ALL_FIXTURES[taskId];
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

