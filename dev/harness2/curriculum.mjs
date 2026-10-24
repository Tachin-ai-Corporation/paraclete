// dev/harness2/curriculum.mjs: Master Curriculum & Artifact Evaluation Playbook for Paraclete-H².
//
// Methodically steps through every harness organ, every engineering role,
// every specialist role, and their associated skills, requiring concrete
// workspace artifacts evaluated by both deterministic verifiers and the
// Frontier Model Committee (gemini-4-argon + claude-opus-5-5).

import fs from 'node:fs';
import path from 'node:path';
import { classifySurfacePath, ORGANS_ALLOWLIST, STAGE1_BUILDER_ROLES } from './surface.mjs';

export const DEFAULT_CURRICULUM_STATE_PATH = '.local/harness2/curriculum-state.json';
export const DEFAULT_CURRICULUM_PROPOSAL_JSON_PATH = '.local/harness2/proposed-curriculum.json';
export const DEFAULT_CURRICULUM_PROPOSAL_MD_PATH = '.local/harness2/CURRICULUM_PROPOSAL.md';

export const CURRICULUM_TRACKS = Object.freeze([
  'organs',
  'engineering_roles',
  'specialist_roles',
]);

export const CURRICULUM_PROPOSAL_SOURCES = Object.freeze([
  'coverage_gap',
  'remediation',
  'tier_escalation',
  'harvested_failure',
  'new_capability',
]);

function writeArtifactFile(workspaceDir, relPath, content) {
  const full = path.join(workspaceDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/**
 * 24-unit Master Curriculum covering:
 * - Track 1 (`organs`): All 6 core harness organs (`cortex`, `prefrontal`, `motor`, `cerebellum`, `temporal-memory`, `temporal-research`)
 * - Track 2 (`engineering_roles`): All 7 engineering & meta-harness roles and their core skills
 * - Track 3 (`specialist_roles`): All 11 domain & operations roles and their core skills
 */
export const MASTER_CURRICULUM_UNITS = Object.freeze([
  // =========================================================================
  // Track 1: Core Harness Organs (6 units)
  // =========================================================================
  {
    id: 'unit-organ-cortex',
    track: 'organs',
    stage: 'stage1',
    role: 'paraclete-h2',
    organ: 'cortex',
    skill: 'harness-evolution',
    targetMutablePath: 'roles/paraclete-h2/prompts/cortex.md',
    title: 'Cortex Organ: Multi-Checkpoint Decomposition & Artifact Contract Routing',
    requiredArtifacts: [
      {
        path: 'diagnosis.json',
        description: 'Single-lens bottleneck diagnosis and immutable spine boundary check',
        requiredJsonKeys: ['missionId', 'primaryLens', 'spineViolations', 'isolatedSingleLens'],
      },
      {
        path: 'CORTEX_DECOMPOSITION.json',
        description: 'Structured checkpoint decomposition contract emitted during Cortex intake',
        requiredJsonKeys: ['missionGoal', 'checkpoints', 'verificationCriteria', 'targetOrgan'],
      },
    ],
    task: {
      id: 'h2-01-lens-diagnosis',
      curriculumUnitId: 'unit-organ-cortex',
      stage: 'stage1',
      role: 'paraclete-h2',
      organFocus: 'cortex',
      skillFocus: 'harness-evolution',
      category: 'organ_cortex_decomposition',
      goal: 'Diagnose execution trajectories across the INV and DOM lenses in diagnosis.json and emit CORTEX_DECOMPOSITION.json documenting the checkpoint plan, verification probes, and artifact invariants.',
      expectedClauses: ['diagnose lens bottleneck', 'isolate single-lens mutation', 'emit CORTEX_DECOMPOSITION.json'],
    },
  },
  {
    id: 'unit-organ-prefrontal',
    track: 'organs',
    stage: 'stage1',
    role: 'software-engineer',
    organ: 'prefrontal',
    skill: 'code-review',
    targetMutablePath: 'roles/software-engineer/prompts/prefrontal.md',
    title: 'Prefrontal Organ: Tactical Step Planning & Risk Pre-Mortem',
    requiredArtifacts: [
      {
        path: 'src/calc.mjs',
        description: 'Repaired inclusive range summation module',
        requiredSubstrings: ['export function sumInclusiveRange', 'i <= end'],
      },
      {
        path: 'PREFRONTAL_PLAN.md',
        description: 'Tactical step plan with pre-mortem failure modes and rollback invariants',
        requiredSubstrings: ['# Prefrontal Tactical Plan', '## Verification Probes', '## Edge-Case Matrix'],
      },
    ],
    task: {
      id: 'se-01-checkpoint-fix',
      curriculumUnitId: 'unit-organ-prefrontal',
      stage: 'stage1',
      role: 'software-engineer',
      organFocus: 'prefrontal',
      skillFocus: 'code-review',
      category: 'organ_prefrontal_planning',
      goal: 'Produce PREFRONTAL_PLAN.md with a tactical step sequence and edge-case matrix, then fix src/calc.mjs so test/calc.test.mjs passes.',
      expectedClauses: ['produce PREFRONTAL_PLAN.md', 'apply minimal fix', 'verify test passes'],
    },
  },
  {
    id: 'unit-organ-motor',
    track: 'organs',
    stage: 'stage1',
    role: 'software-engineer',
    organ: 'motor',
    skill: 'code-review',
    targetMutablePath: 'roles/software-engineer/prompts/motor.md',
    title: 'Motor Organ: Minimal-Turn Tool Execution & Clean Diff Generation',
    requiredArtifacts: [
      {
        path: 'src/service.mjs',
        description: 'Refactored service module accepting injectable fetchProfile dependency',
        requiredSubstrings: ['export async function loadUserProfile', 'deps.fetchProfile'],
      },
      {
        path: 'MOTOR_EXECUTION_LOG.json',
        description: 'Deterministic tool execution record and diff verification summary',
        requiredJsonKeys: ['patchedFiles', 'testExitCode', 'assertionsVerified'],
      },
    ],
    task: {
      id: 'se-02-contract-boundary',
      curriculumUnitId: 'unit-organ-motor',
      stage: 'stage1',
      role: 'software-engineer',
      organFocus: 'motor',
      skillFocus: 'code-review',
      category: 'organ_motor_execution',
      goal: 'Refactor src/service.mjs with minimal tool turns to accept injectable dependencies and write MOTOR_EXECUTION_LOG.json capturing patched files, test exit code, and verified assertions.',
      expectedClauses: ['refactor injectable deps', 'write MOTOR_EXECUTION_LOG.json', 'confirm tests pass'],
    },
  },
  {
    id: 'unit-organ-cerebellum',
    track: 'organs',
    stage: 'stage1',
    role: 'qa-engineer',
    organ: 'cerebellum',
    skill: 'test-runner',
    targetMutablePath: 'roles/qa-engineer/prompts/cerebellum.md',
    title: 'Cerebellum Organ: Adversarial Probe Verification & Evidence Floor Enforcement',
    requiredArtifacts: [
      {
        path: 'test/repro.test.mjs',
        description: 'Regression test suite covering empty, whitespace, and key=value inputs',
        requiredSubstrings: ['parseKeyVal', 'PORT=8080'],
      },
      {
        path: 'CEREBELLUM_VERIFICATION.json',
        description: 'Adversarial verification report with probe commands and pass/fail evidence',
        requiredJsonKeys: ['verdict', 'evidenceFloorMet', 'adversarialProbes', 'regressionCount'],
      },
    ],
    task: {
      id: 'qa-01-adversarial-repro',
      curriculumUnitId: 'unit-organ-cerebellum',
      stage: 'stage1',
      role: 'qa-engineer',
      organFocus: 'cerebellum',
      skillFocus: 'test-runner',
      category: 'organ_cerebellum_verification',
      goal: 'Write regression tests in test/repro.test.mjs for src/parser.mjs and generate CEREBELLUM_VERIFICATION.json documenting adversarial probes and evidence floor compliance.',
      expectedClauses: ['write reproduction test', 'verify failure and pass', 'emit CEREBELLUM_VERIFICATION.json'],
    },
  },
  {
    id: 'unit-organ-temporal-memory',
    track: 'organs',
    stage: 'stage1',
    role: 'paraclete-h2',
    organ: 'temporal-memory',
    skill: 'harness-eval',
    targetMutablePath: 'prompts/temporal-memory.md',
    title: 'Temporal-Memory Organ: Episode Consolidation & Known-Resource Extraction',
    requiredArtifacts: [
      {
        path: 'promotion-verdict.json',
        description: 'Capability-First Pareto promotion verdict',
        requiredJsonKeys: ['ready', 'winnerId', 'rejectedCount'],
      },
      {
        path: 'MEMORY_CONSOLIDATION.json',
        description: 'Consolidated episodic memory packet with durable facts and known resources',
        requiredJsonKeys: ['episodeSummary', 'durableFacts', 'knownResources', 'compactionRatio'],
      },
      {
        path: 'MEMORY_LEDGER.md',
        description: 'Human-auditable episodic memory digest for cross-checkpoint continuity',
        requiredSubstrings: ['# Episodic Memory Consolidation', '## Durable Facts', '## Known Resources'],
      },
    ],
    task: {
      id: 'h2-02-pareto-promotion',
      curriculumUnitId: 'unit-organ-temporal-memory',
      stage: 'stage1',
      role: 'paraclete-h2',
      organFocus: 'temporal-memory',
      skillFocus: 'harness-eval',
      category: 'organ_temporal_memory',
      goal: 'Evaluate candidate pareto dominance in promotion-verdict.json and consolidate mission execution state into MEMORY_CONSOLIDATION.json and MEMORY_LEDGER.md.',
      expectedClauses: ['verify pareto dominance', 'consolidate episodic memory', 'emit MEMORY_LEDGER.md'],
    },
  },
  {
    id: 'unit-organ-temporal-research',
    track: 'organs',
    stage: 'stage2',
    role: 'generic',
    organ: 'temporal-research',
    skill: 'evidence-synthesis',
    targetMutablePath: 'prompts/temporal-research.md',
    title: 'Temporal-Research Organ: Multi-Source Citation Grounding & Conflict Resolution',
    requiredArtifacts: [
      {
        path: 'synthesis.json',
        description: 'Grounded two-source benchmark synthesis',
        requiredJsonKeys: ['fasterEngine', 'lowerCostEngine', 'p95DeltaMs', 'citations'],
      },
      {
        path: 'SYNTHESIS.md',
        description: 'Grounded synthesis brief reconciling multi-source performance and cost trade-offs',
        requiredSubstrings: ['sources/primary-a.json', 'sources/primary-b.json', 'alpha', 'beta'],
      },
      {
        path: 'CITATION_GRAPH.json',
        description: 'Machine-verifiable claim-to-source provenance matrix',
        requiredJsonKeys: ['claims', 'sources', 'contradictionsResolved'],
      },
    ],
    task: {
      id: 'gen-01-grounded-synthesis',
      curriculumUnitId: 'unit-organ-temporal-research',
      stage: 'stage2',
      role: 'generic',
      organFocus: 'temporal-research',
      skillFocus: 'evidence-synthesis',
      category: 'organ_temporal_research',
      goal: 'Synthesize sources/primary-a.json and sources/primary-b.json into synthesis.json, SYNTHESIS.md, and CITATION_GRAPH.json mapping every claim to primary evidence.',
      expectedClauses: ['gather primary sources', 'verify cited claims', 'emit CITATION_GRAPH.json'],
    },
  },

  // =========================================================================
  // Track 2: Engineering & Infrastructure Roles + Skills (7 units)
  // =========================================================================
  {
    id: 'unit-role-paraclete-h2',
    track: 'engineering_roles',
    stage: 'stage1',
    role: 'paraclete-h2',
    organ: 'cortex',
    skill: 'harness-promote',
    targetMutablePath: 'roles/paraclete-h2/prompts/cortex.md',
    title: 'Paraclete-H² Role: Meta-Harness Diagnostic & Promotion Gate Audit',
    requiredArtifacts: [
      {
        path: 'promotion-verdict.json',
        description: 'Capability-First promotion selection output',
        requiredJsonKeys: ['ready', 'winnerId', 'rejectedCount'],
      },
      {
        path: 'HARNESS_AUDIT_REPORT.json',
        description: 'Capability-First Credo promotion readiness and lens diagnostic report',
        requiredJsonKeys: ['credo', 'capabilityNonRegression', 'lensRanking', 'promotionReady'],
      },
      {
        path: 'HARNESS_IMPROVEMENT_BRIEF.md',
        description: 'Engineering summary of harness surface mutations and Pareto deltas',
        requiredSubstrings: ['# Harness Improvement Brief', 'Capability-First Credo', '## Lens Diagnostics'],
      },
    ],
    task: {
      id: 'h2-02-pareto-promotion',
      curriculumUnitId: 'unit-role-paraclete-h2',
      stage: 'stage1',
      role: 'paraclete-h2',
      organFocus: 'cortex',
      skillFocus: 'harness-promote',
      category: 'meta_harness_engineering',
      goal: 'Verify Pareto promotion in promotion-verdict.json and emit HARNESS_AUDIT_REPORT.json and HARNESS_IMPROVEMENT_BRIEF.md auditing capability non-regression and four-lens diagnostics.',
      expectedClauses: ['evaluate benchmark suite', 'verify pareto dominance', 'emit HARNESS_AUDIT_REPORT.json'],
    },
  },
  {
    id: 'unit-role-software-engineer',
    track: 'engineering_roles',
    stage: 'stage1',
    role: 'software-engineer',
    organ: 'cortex',
    skill: 'code-review',
    targetMutablePath: 'roles/software-engineer/prompts/cortex.md',
    title: 'Software Engineer Role: Defect Root-Cause Fix & Code Review Report',
    requiredArtifacts: [
      {
        path: 'src/calc.mjs',
        description: 'Production-grade inclusive range summation module',
        requiredSubstrings: ['export function sumInclusiveRange', 'i <= end'],
      },
      {
        path: 'CODE_REVIEW_REPORT.md',
        description: 'Root-cause analysis, complexity review, and boundary test matrix',
        requiredSubstrings: ['# Code Review & Root-Cause Report', '## Defect Analysis', '## Boundary Verification'],
      },
    ],
    task: {
      id: 'se-01-checkpoint-fix',
      curriculumUnitId: 'unit-role-software-engineer',
      stage: 'stage1',
      role: 'software-engineer',
      organFocus: 'cortex',
      skillFocus: 'code-review',
      category: 'bugfix_unit_test',
      goal: 'Fix the off-by-one boundary defect in src/calc.mjs, pass test/calc.test.mjs, and author CODE_REVIEW_REPORT.md detailing root cause and boundary invariants.',
      expectedClauses: ['diagnose failing test', 'apply minimal fix', 'author CODE_REVIEW_REPORT.md'],
    },
  },
  {
    id: 'unit-role-qa-engineer',
    track: 'engineering_roles',
    stage: 'stage1',
    role: 'qa-engineer',
    organ: 'cortex',
    skill: 'test-runner',
    targetMutablePath: 'roles/qa-engineer/prompts/cortex.md',
    title: 'QA Engineer Role: Boundary Regression Suite & Coverage Matrix',
    requiredArtifacts: [
      {
        path: 'test/repro.test.mjs',
        description: 'Node:test regression suite covering valid, boundary, and error paths',
        requiredSubstrings: ['parseKeyVal', 'PORT=8080'],
      },
      {
        path: 'QA_COVERAGE_MATRIX.json',
        description: 'Structured equivalence-partition and boundary-value test coverage matrix',
        requiredJsonKeys: ['targetModule', 'partitionsCovered', 'negativeCasesVerified', 'allTestsPassed'],
      },
    ],
    task: {
      id: 'qa-01-adversarial-repro',
      curriculumUnitId: 'unit-role-qa-engineer',
      stage: 'stage1',
      role: 'qa-engineer',
      organFocus: 'cortex',
      skillFocus: 'test-runner',
      category: 'regression_authoring',
      goal: 'Author comprehensive regression tests in test/repro.test.mjs for src/parser.mjs and output QA_COVERAGE_MATRIX.json documenting equivalence partitions and boundary cases.',
      expectedClauses: ['write reproduction test', 'verify failure and pass', 'emit QA_COVERAGE_MATRIX.json'],
    },
  },
  {
    id: 'unit-role-devops-engineer',
    track: 'engineering_roles',
    stage: 'stage1',
    role: 'devops-engineer',
    organ: 'cortex',
    skill: 'systemd-inspector',
    targetMutablePath: 'roles/devops-engineer/prompts/cortex.md',
    title: 'DevOps Engineer Role: Release Pointer Recovery & Incident Runbook',
    requiredArtifacts: [
      {
        path: 'health-report.json',
        description: 'Verified release health and gateway status report',
        requiredJsonKeys: ['healthy', 'activeRelease', 'gatewayReady'],
      },
      {
        path: 'INCIDENT_RUNBOOK.md',
        description: 'Post-incident remediation runbook and release verification checklist',
        requiredSubstrings: ['# Release Recovery & Systemd Runbook', 'v2026.10.19.1.0', 'paraclete-gateway'],
      },
    ],
    task: {
      id: 'devops-01-canary-health',
      curriculumUnitId: 'unit-role-devops-engineer',
      stage: 'stage1',
      role: 'devops-engineer',
      organFocus: 'cortex',
      skillFocus: 'systemd-inspector',
      category: 'infra_triage',
      goal: 'Repair release/current.json, emit health-report.json, and author INCIDENT_RUNBOOK.md with rollback and health probe verification steps.',
      expectedClauses: ['inspect unit status', 'verify release pointer', 'author INCIDENT_RUNBOOK.md'],
    },
  },
  {
    id: 'unit-role-security-engineer',
    track: 'engineering_roles',
    stage: 'stage2',
    role: 'security-engineer',
    organ: 'cortex',
    skill: 'iam-auditor',
    targetMutablePath: 'roles/security-engineer/prompts/cortex.md',
    title: 'Security Engineer Role: Least-Privilege IAM Remediation & Threat Model',
    requiredArtifacts: [
      {
        path: 'iam/remediation-plan.json',
        description: 'Least-privilege IAM bindings replacing wildcard roles/owner and rotating aged keys',
        requiredJsonKeys: ['overPrivilegedPrincipals', 'recommendedRole', 'rotateKeyIds'],
      },
      {
        path: 'SECURITY_THREAT_MODEL.md',
        description: 'Blast-radius analysis and least-privilege compliance attestation',
        requiredSubstrings: ['# IAM Least-Privilege Threat Model', 'roles/owner', 'serviceAccount:ci-runner@example.com'],
      },
    ],
    task: {
      id: 'sec-01-iam-least-privilege',
      curriculumUnitId: 'unit-role-security-engineer',
      stage: 'stage2',
      role: 'security-engineer',
      organFocus: 'cortex',
      skillFocus: 'iam-auditor',
      category: 'policy_hardening',
      goal: 'Audit iam/policy.json, generate least-privilege replacements in iam/remediation-plan.json, and document blast-radius reduction in SECURITY_THREAT_MODEL.md.',
      expectedClauses: ['audit iam bindings', 'identify over-privileged principals', 'author SECURITY_THREAT_MODEL.md'],
    },
  },
  {
    id: 'unit-role-data-engineer',
    track: 'engineering_roles',
    stage: 'stage2',
    role: 'data-engineer',
    organ: 'cortex',
    skill: 'etl-validator',
    targetMutablePath: 'roles/data-engineer/prompts/cortex.md',
    title: 'Data Engineer Role: BigQuery Schema Drift Audit & Lineage Spec',
    requiredArtifacts: [
      {
        path: 'schema-drift-report.json',
        description: 'Non-destructive schema drift and partition validation report',
        requiredJsonKeys: ['driftedColumns', 'partitionValid', 'rowCount', 'tableMutated'],
      },
      {
        path: 'PIPELINE_LINEAGE.json',
        description: 'Schema contract, partition invariant, and watermarks specification',
        requiredJsonKeys: ['primaryKey', 'partitionColumn', 'idempotentGuarantee', 'schemaFields'],
      },
    ],
    task: {
      id: 'de-01-pipeline-schema-audit',
      curriculumUnitId: 'unit-role-data-engineer',
      stage: 'stage2',
      role: 'data-engineer',
      organFocus: 'cortex',
      skillFocus: 'etl-validator',
      category: 'schema_pipeline',
      goal: 'Compare schemas/expected.json and schemas/live-bq.json into schema-drift-report.json and write PIPELINE_LINEAGE.json specifying partition keys and schema invariants.',
      expectedClauses: ['inspect dataset schemas', 'report schema drift', 'emit PIPELINE_LINEAGE.json'],
    },
  },
  {
    id: 'unit-role-web-master',
    track: 'engineering_roles',
    stage: 'stage2',
    role: 'web-master',
    organ: 'cortex',
    skill: 'dom-accessibility',
    targetMutablePath: 'roles/web-master/prompts/cortex.md',
    title: 'Web Master Role: Endpoint TLS/HSTS Audit & Hardening Spec',
    requiredArtifacts: [
      {
        path: 'site-health-report.json',
        description: 'Grounded endpoint TLS expiry and HSTS compliance report',
        requiredJsonKeys: ['expiringTlsUrls', 'missingHstsUrls', 'allStatus200'],
      },
      {
        path: 'WEB_HARDENING_REPORT.md',
        description: 'TLS renewal schedule, Strict-Transport-Security header policy, and probe report',
        requiredSubstrings: ['# Web Endpoint Security & Vitals Report', 'https://app.example.com/healthz', 'Strict-Transport-Security'],
      },
    ],
    task: {
      id: 'web-01-endpoint-vitals',
      curriculumUnitId: 'unit-role-web-master',
      stage: 'stage2',
      role: 'web-master',
      organFocus: 'cortex',
      skillFocus: 'dom-accessibility',
      category: 'web_vitals_audit',
      goal: 'Audit probes/endpoints.json into site-health-report.json and write WEB_HARDENING_REPORT.md detailing certificate renewal and HSTS headers.',
      expectedClauses: ['probe http status', 'check tls expiry', 'author WEB_HARDENING_REPORT.md'],
    },
  },

  // =========================================================================
  // Track 3: Stage-2 Specialist & Operations Roles + Skills (11 units)
  // =========================================================================
  {
    id: 'unit-role-research-analyst',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'generic',
    organ: 'temporal-research',
    skill: 'memory-recall',
    targetMutablePath: 'roles/generic/prompts/temporal-research.md',
    title: 'Research & Memory Recall: Multi-Source Evidence Synthesis & Methodology Critique',
    requiredArtifacts: [
      {
        path: 'synthesis.json',
        description: 'Verified benchmark latency and cost synthesis',
        requiredJsonKeys: ['fasterEngine', 'lowerCostEngine', 'p95DeltaMs', 'citations'],
      },
      {
        path: 'EVIDENCE_TABLE.json',
        description: 'Structured comparison table of sample sizes, methodologies, and confidence weights',
        requiredJsonKeys: ['studies', 'reconciledConclusion', 'confidenceScore'],
      },
    ],
    task: {
      id: 'gen-01-grounded-synthesis',
      curriculumUnitId: 'unit-role-research-analyst',
      stage: 'stage2',
      role: 'generic',
      organFocus: 'temporal-research',
      skillFocus: 'memory-recall',
      category: 'evidence_synthesis',
      goal: 'Synthesize sources/primary-a.json and sources/primary-b.json into synthesis.json and produce EVIDENCE_TABLE.json comparing study methodologies and confidence weights.',
      expectedClauses: ['gather primary sources', 'verify cited claims', 'emit EVIDENCE_TABLE.json'],
    },
  },
  {
    id: 'unit-role-data-analyst',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'data-engineer',
    organ: 'motor',
    skill: 'bigquery',
    targetMutablePath: 'roles/data-engineer/prompts/motor.md',
    title: 'Data Analytics & BigQuery: Cohort Retention Anomaly Detection & Executive Memo',
    requiredArtifacts: [
      {
        path: 'variance-report.json',
        description: 'Quantified cohort retention anomaly report',
        requiredJsonKeys: ['anomalousCohort', 'deltaPct', 'checkedCount'],
      },
      {
        path: 'COHORT_EXECUTIVE_MEMO.md',
        description: 'Analytical memo explaining the cohort-2026-02 retention drop and segment drivers',
        requiredSubstrings: ['# Cohort Retention Analysis', 'cohort-2026-02', '-36.5'],
      },
    ],
    task: {
      id: 'da-01-cohort-variance',
      curriculumUnitId: 'unit-role-data-analyst',
      stage: 'stage2',
      role: 'data-engineer',
      organFocus: 'motor',
      skillFocus: 'bigquery',
      category: 'cohort_analysis',
      goal: 'Analyze data/cohorts.json, generate variance-report.json identifying cohort-2026-02, and write COHORT_EXECUTIVE_MEMO.md quantifying retention drivers.',
      expectedClauses: ['analyze anomalies', 'cross-check aggregates', 'author COHORT_EXECUTIVE_MEMO.md'],
    },
  },
  {
    id: 'unit-role-finance-analyst',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'finance-analyst',
    organ: 'cortex',
    skill: 'variance-reconciliation',
    targetMutablePath: 'roles/finance-analyst/prompts/cortex.md',
    title: 'Finance Analyst Role: Budget vs. Actuals Variance Reconciliation & CFO Brief',
    requiredArtifacts: [
      {
        path: 'budget-reconciliation.json',
        description: 'Line-item budget vs. actual variance schedule',
        requiredJsonKeys: ['actualTotal', 'budgetTotal', 'variance', 'primaryDriver'],
      },
      {
        path: 'CFO_VARIANCE_MEMO.md',
        description: 'Executive variance commentary highlighting cloud-compute overruns and reforecast',
        requiredSubstrings: ['# Q3 Budget vs. Actuals Reconciliation', 'cloud-compute', '54250'],
      },
    ],
    task: {
      id: 'fin-01-budget-variance',
      curriculumUnitId: 'unit-role-finance-analyst',
      stage: 'stage2',
      role: 'finance-analyst',
      organFocus: 'cortex',
      skillFocus: 'variance-reconciliation',
      category: 'budget_reconciliation',
      goal: 'Reconcile finance/q3-ledger.json into budget-reconciliation.json and write CFO_VARIANCE_MEMO.md explaining the cloud-compute variance.',
      expectedClauses: ['reconcile line-item spend', 'verify totals arithmetic', 'author CFO_VARIANCE_MEMO.md'],
    },
  },
  {
    id: 'unit-role-legal-advisor',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'legal-advisor',
    organ: 'cortex',
    skill: 'clause-redline',
    targetMutablePath: 'roles/legal-advisor/prompts/cortex.md',
    title: 'Legal Advisor Role: DPA/MSA Clause Risk Matrix & Redline Playbook',
    requiredArtifacts: [
      {
        path: 'redline-guidance.json',
        description: 'Non-compliant clause citations and policy-aligned replacements',
        requiredJsonKeys: ['nonCompliantSections', 'liabilityCap', 'breachNoticeHours'],
      },
      {
        path: 'REDLINE_MEMORANDUM.md',
        description: 'Counsel memorandum with exact replacement language for liability cap and breach notice',
        requiredSubstrings: ['# Commercial Contract Redline Memorandum', 'section-8.2', 'section-11.4'],
      },
    ],
    task: {
      id: 'leg-01-clause-redline',
      curriculumUnitId: 'unit-role-legal-advisor',
      stage: 'stage2',
      role: 'legal-advisor',
      organFocus: 'cortex',
      skillFocus: 'clause-redline',
      category: 'contract_redline',
      goal: 'Audit contracts/vendor-msa.json, emit redline-guidance.json, and draft replacement clause language in REDLINE_MEMORANDUM.md.',
      expectedClauses: ['review agreement clauses', 'cite non-compliant sections', 'author REDLINE_MEMORANDUM.md'],
    },
  },
  {
    id: 'unit-role-project-manager',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'project-manager',
    organ: 'cortex',
    skill: 'critical-path',
    targetMutablePath: 'roles/project-manager/prompts/cortex.md',
    title: 'Project Manager Role: Critical-Path Dependency Schedule & Risk Register',
    requiredArtifacts: [
      {
        path: 'risk-register.json',
        description: 'Reconciled milestone status and critical blocker register',
        requiredJsonKeys: ['discrepantMilestones', 'criticalBlocker', 'reconciledStatus'],
      },
      {
        path: 'RAID_LOG.md',
        description: 'Risks, Assumptions, Issues, and Dependencies register for program delivery',
        requiredSubstrings: ['# Program RAID Register & Recovery Plan', 'ms-02', 'dep-auth-migration'],
      },
    ],
    task: {
      id: 'pm-01-milestone-audit',
      curriculumUnitId: 'unit-role-project-manager',
      stage: 'stage2',
      role: 'project-manager',
      organFocus: 'cortex',
      skillFocus: 'critical-path',
      category: 'milestone_planning',
      goal: 'Audit workstreams/milestones.json into risk-register.json and author RAID_LOG.md with concrete schedule recovery actions.',
      expectedClauses: ['audit blockers', 'reconcile status', 'author RAID_LOG.md'],
    },
  },
  {
    id: 'unit-role-executive-assistant',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'executive-assistant',
    organ: 'cortex',
    skill: 'calendar-triage',
    targetMutablePath: 'roles/executive-assistant/prompts/cortex.md',
    title: 'Executive Assistant Role: Cross-Timezone Conflict Resolution & Prep Dossier',
    requiredArtifacts: [
      {
        path: 'decision-brief.json',
        description: 'De-conflicted executive itinerary and thread triage',
        requiredJsonKeys: ['triagedThreadIds', 'conflictThreadId', 'proposedSlot'],
      },
      {
        path: 'EXEC_BRIEFING_PACKET.md',
        description: 'Daily executive briefing packet with attendee context and decision prompts',
        requiredSubstrings: ['# Executive Daily Briefing Packet', 'thread-104', '2026-10-21T15:00:00Z'],
      },
    ],
    task: {
      id: 'exec-01-triage-brief',
      curriculumUnitId: 'unit-role-executive-assistant',
      stage: 'stage2',
      role: 'executive-assistant',
      organFocus: 'cortex',
      skillFocus: 'calendar-triage',
      category: 'schedule_triage',
      goal: 'Triage inbox/threads.json and calendar/slots.json into decision-brief.json and prepare EXEC_BRIEFING_PACKET.md.',
      expectedClauses: ['triage threads', 'verify constraints', 'author EXEC_BRIEFING_PACKET.md'],
    },
  },
  {
    id: 'unit-role-chief-of-staff',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'project-manager',
    organ: 'prefrontal',
    skill: 'workspace-docs',
    targetMutablePath: 'roles/project-manager/prompts/prefrontal.md',
    title: 'Chief of Staff Role: Cross-Functional OKR Alignment & Board Decision Memo',
    requiredArtifacts: [
      {
        path: 'risk-register.json',
        description: 'Cross-workstream blocker and status alignment scorecard',
        requiredJsonKeys: ['discrepantMilestones', 'criticalBlocker', 'reconciledStatus'],
      },
      {
        path: 'BOARD_DECISION_MEMO.md',
        description: 'Executive decision memo resolving cross-functional blocker contention',
        requiredSubstrings: ['# Chief of Staff Decision Memo', '## Strategic Trade-Offs', 'dep-auth-migration'],
      },
    ],
    task: {
      id: 'pm-01-milestone-audit',
      curriculumUnitId: 'unit-role-chief-of-staff',
      stage: 'stage2',
      role: 'project-manager',
      organFocus: 'prefrontal',
      skillFocus: 'workspace-docs',
      category: 'strategic_alignment',
      goal: 'Reconcile workstreams/milestones.json into risk-register.json and author BOARD_DECISION_MEMO.md.',
      expectedClauses: ['audit blockers', 'reconcile status', 'author BOARD_DECISION_MEMO.md'],
    },
  },
  {
    id: 'unit-role-sales-ops',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'finance-analyst',
    organ: 'motor',
    skill: 'workspace-sheets',
    targetMutablePath: 'roles/finance-analyst/prompts/motor.md',
    title: 'Sales Ops Role: Pipeline Forecast Scrubbing & Territory Quota Rebalance',
    requiredArtifacts: [
      {
        path: 'variance-report.json',
        description: 'Quantified cohort conversion and retention hygiene metrics',
        requiredJsonKeys: ['anomalousCohort', 'deltaPct', 'checkedCount'],
      },
      {
        path: 'REVOPS_INSPECTION_REPORT.md',
        description: 'Deal-desk inspection report and stage-progression hygiene remediation',
        requiredSubstrings: ['# Revenue Operations Pipeline Audit', 'cohort-2026-02', 'Stage Hygiene'],
      },
    ],
    task: {
      id: 'da-01-cohort-variance',
      curriculumUnitId: 'unit-role-sales-ops',
      stage: 'stage2',
      role: 'finance-analyst',
      organFocus: 'motor',
      skillFocus: 'workspace-sheets',
      category: 'pipeline_hygiene',
      goal: 'Audit data/cohorts.json into variance-report.json and produce REVOPS_INSPECTION_REPORT.md.',
      expectedClauses: ['analyze anomalies', 'cross-check aggregates', 'author REVOPS_INSPECTION_REPORT.md'],
    },
  },
  {
    id: 'unit-role-customer-ops',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'web-master',
    organ: 'motor',
    skill: 'firebase-hosting',
    targetMutablePath: 'roles/web-master/prompts/motor.md',
    title: 'Customer Ops Role: Enterprise SLA Escalation Triage & Churn Prevention Plan',
    requiredArtifacts: [
      {
        path: 'decision-brief.json',
        description: 'Prioritized escalation queue ordered by urgency and slot availability',
        requiredJsonKeys: ['triagedThreadIds', 'conflictThreadId', 'proposedSlot'],
      },
      {
        path: 'CUSTOMER_RECOVERY_PLAYBOOK.md',
        description: 'Enterprise incident communication and retention recovery plan',
        requiredSubstrings: ['# Enterprise Escalation Recovery Plan', 'thread-104', 'SLA Remediation'],
      },
    ],
    task: {
      id: 'exec-01-triage-brief',
      curriculumUnitId: 'unit-role-customer-ops',
      stage: 'stage2',
      role: 'web-master',
      organFocus: 'motor',
      skillFocus: 'firebase-hosting',
      category: 'escalation_triage',
      goal: 'Triage urgent customer escalation threads in inbox/threads.json into decision-brief.json and draft CUSTOMER_RECOVERY_PLAYBOOK.md.',
      expectedClauses: ['triage threads', 'verify constraints', 'author CUSTOMER_RECOVERY_PLAYBOOK.md'],
    },
  },
  {
    id: 'unit-role-designer',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'designer',
    organ: 'cortex',
    skill: 'design-tokens',
    targetMutablePath: 'roles/designer/prompts/cortex.md',
    title: 'Designer Role: Design-Token Contrast Normalization & Component Spec',
    requiredArtifacts: [
      {
        path: 'layout-fixes.json',
        description: 'Normalized design token set meeting WCAG AA 4.5:1 text contrast and 8px grid',
        requiredJsonKeys: ['failingComponents', 'fixedContrastRatio', 'fixedSpacingPx'],
      },
      {
        path: 'DESIGN_SYSTEM_SPEC.md',
        description: 'Component state hierarchy, semantic color tokens, and responsive spacing spec',
        requiredSubstrings: ['# Design System Token Specification', 'hero-subtitle', '4.8'],
      },
    ],
    task: {
      id: 'des-01-layout-hierarchy-audit',
      curriculumUnitId: 'unit-role-designer',
      stage: 'stage2',
      role: 'designer',
      organFocus: 'cortex',
      skillFocus: 'design-tokens',
      category: 'design_system_spec',
      goal: 'Audit design/components.json for contrast and 8px spacing violations, write layout-fixes.json, and author DESIGN_SYSTEM_SPEC.md.',
      expectedClauses: ['audit spacing and typography', 'check contrast ratios', 'author DESIGN_SYSTEM_SPEC.md'],
    },
  },
  {
    id: 'unit-role-generic',
    track: 'specialist_roles',
    stage: 'stage2',
    role: 'generic',
    organ: 'cortex',
    skill: 'structured-synthesis',
    targetMutablePath: 'roles/generic/prompts/cortex.md',
    title: 'Generic Role: Multi-Step Tool Coordination & Structured Deliverable Verification',
    requiredArtifacts: [
      {
        path: 'synthesis.json',
        description: 'Structured synthesis output verifying all user constraints and citations',
        requiredJsonKeys: ['fasterEngine', 'lowerCostEngine', 'p95DeltaMs', 'citations'],
      },
      {
        path: 'DELIVERABLE_SUMMARY.md',
        description: 'Clear, structured Markdown report with explicit constraint checklist',
        requiredSubstrings: ['# Mission Deliverable Summary', '## Constraint Verification', 'PASS'],
      },
    ],
    task: {
      id: 'gen-01-grounded-synthesis',
      curriculumUnitId: 'unit-role-generic',
      stage: 'stage2',
      role: 'generic',
      organFocus: 'cortex',
      skillFocus: 'structured-synthesis',
      category: 'generalist_synthesis',
      goal: 'Synthesize sources/primary-a.json and sources/primary-b.json into synthesis.json and write DELIVERABLE_SUMMARY.md.',
      expectedClauses: ['gather primary sources', 'verify cited claims', 'author DELIVERABLE_SUMMARY.md'],
    },
  },
]);

const ROLE_TO_BASE_TASK_ID = Object.freeze({
  'paraclete-h2': 'h2-01-diagnose-bottleneck',
  'software-engineer': 'se-01-bugfix-inclusive-range',
  'qa-engineer': 'qa-01-regression-test-matrix',
  'devops-engineer': 'ops-01-systemd-release-rollback',
  'security-engineer': 'sec-01-iam-least-privilege',
  'data-engineer': 'de-01-bigquery-pipeline-schema',
  'web-master': 'web-01-tls-vital-check',
  'research-analyst': 'res-01-grounded-synthesis',
  'data-analyst': 'da-01-cohort-variance',
  'finance-analyst': 'fin-01-budget-reconcile',
  'finance-ops': 'fin-01-budget-reconcile',
  'legal-advisor': 'leg-01-clause-redline',
  'project-manager': 'pm-01-milestone-audit',
  'chief-of-staff': 'pm-01-milestone-audit',
  'executive-assistant': 'exec-01-triage-brief',
  'sales-ops': 'da-01-cohort-variance',
  'customer-ops': 'exec-01-triage-brief',
  designer: 'des-01-layout-hierarchy-audit',
  generic: 'gen-01-grounded-synthesis',
  'it-admin': 'ops-01-systemd-release-rollback',
  'marketing-ops': 'da-01-cohort-variance',
});

let runtimeDynamicUnitsCache = [];

/**
 * Return all curriculum units (static Epoch 1 `MASTER_CURRICULUM_UNITS` plus any
 * dynamically synthesized units registered in `state.dynamicUnits`).
 *
 * @param {object} [opts]
 * @param {object} [opts.state]
 */
export function getAllCurriculumUnits(opts = {}) {
  const byId = new Map();
  for (const u of MASTER_CURRICULUM_UNITS) {
    byId.set(u.id, u);
  }
  const dynamicList = Array.isArray(opts.state?.dynamicUnits)
    ? opts.state.dynamicUnits
    : runtimeDynamicUnitsCache;
  for (const u of dynamicList) {
    if (u && u.id && !byId.has(u.id)) {
      byId.set(u.id, u);
    }
  }
  return [...byId.values()];
}

/**
 * Look up a curriculum unit by its `id` across both `MASTER_CURRICULUM_UNITS`
 * and any dynamically synthesized units.
 *
 * @param {string} unitId
 * @param {object} [opts]
 */
export function getCurriculumUnitById(unitId, opts = {}) {
  if (!unitId) return null;
  const staticMatch = MASTER_CURRICULUM_UNITS.find((u) => u.id === unitId);
  if (staticMatch) return staticMatch;

  const dynamicFromState = Array.isArray(opts.state?.dynamicUnits)
    ? opts.state.dynamicUnits.find((u) => u && u.id === unitId)
    : null;
  if (dynamicFromState) return dynamicFromState;

  const cachedMatch = runtimeDynamicUnitsCache.find((u) => u && u.id === unitId);
  if (cachedMatch) return cachedMatch;

  const fsImpl = opts.fs || fs;
  const proposalPath = path.resolve(opts.proposalJsonPath || DEFAULT_CURRICULUM_PROPOSAL_JSON_PATH);
  if (fsImpl.existsSync(proposalPath)) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(proposalPath, 'utf8'));
      const found = (parsed?.proposedUnits || []).find((u) => u && u.id === unitId);
      if (found) return found;
    } catch {
      // Ignore parse errors on optional proposal file
    }
  }

  return null;
}

/**
 * Materialize the specialist & organ-specific workspace artifacts for a curriculum unit: the
 * reference outputs the scripted in-process rollout writes. They are the same for every harness, so
 * an in-process score never depends on what a candidate changed.
 *
 * @param {string} workspaceDir
 * @param {object} unit
 */
export function materializeCurriculumArtifacts(workspaceDir, unit) {
  if (!unit || !workspaceDir) return;

  const templates = {
    'CORTEX_DECOMPOSITION.json': () =>
      JSON.stringify(
        {
          missionGoal: unit.task.goal,
          targetOrgan: 'cortex',
          checkpoints: [
            { n: 1, organ: 'prefrontal', goal: 'Inspect seeded trajectory and boundary rules' },
            { n: 2, organ: 'motor', goal: 'Write diagnosis.json and CORTEX_DECOMPOSITION.json' },
            { n: 3, organ: 'cerebellum', goal: 'Verify JSON schema and spine path isolation' },
          ],
          verificationCriteria: ['diagnosis.json exists', 'primaryLens === INV', 'spineViolations isolated'],
        },
        null,
        2,
      ),
    'PREFRONTAL_PLAN.md': () =>
      `# Prefrontal Tactical Plan\n\n## Verification Probes\n- Run \`node --test test/calc.test.mjs\` before and after patching \`src/calc.mjs\`.\n\n## Edge-Case Matrix\n- \`sumInclusiveRange(1, 4) === 10\`\n- Single-element range \`sumInclusiveRange(3, 3) === 3\`\n`,
    'MOTOR_EXECUTION_LOG.json': () =>
      JSON.stringify(
        {
          patchedFiles: ['src/service.mjs'],
          testExitCode: 0,
          assertionsVerified: ['loadUserProfile accepts injectable fetchProfile dependency'],
        },
        null,
        2,
      ),
    'CEREBELLUM_VERIFICATION.json': () =>
      JSON.stringify(
        {
          verdict: 'PASS',
          evidenceFloorMet: true,
          adversarialProbes: ['empty string input', 'whitespace-only input', 'PORT=8080 key-value pair'],
          regressionCount: 0,
        },
        null,
        2,
      ),
    'MEMORY_CONSOLIDATION.json': () =>
      JSON.stringify(
        {
          episodeSummary: 'Evaluated candidate Pareto dominance under Capability-First Credo and selected cand-pareto-1.',
          durableFacts: ['cand-regressed-cap rejected due to capability drop (0.70 < 0.80)', 'cand-pareto-1 selected (capability 0.90)'],
          knownResources: ['candidates.json', 'promotion-verdict.json'],
          compactionRatio: 0.38,
        },
        null,
        2,
      ),
    'MEMORY_LEDGER.md': () =>
      `# Episodic Memory Consolidation\n\n## Durable Facts\n- Baseline capability: \`0.80\`\n- Winning candidate: \`cand-pareto-1\` (\`capability: 0.90\`, \`fitness: 0.88\`)\n\n## Known Resources\n- \`candidates.json\`\n- \`promotion-verdict.json\`\n`,
    'SYNTHESIS.md': () =>
      `# Multi-Source Technical Synthesis\n\n- **Latency Winner**: Engine \`alpha\` (\`42ms\` p95 in \`sources/primary-a.json\`) outperforms \`beta\` (\`68ms\` p95 in \`sources/primary-b.json\`) by \`26ms\`.\n- **Cost Winner**: Engine \`beta\` (\`$0.08/1k\` in \`sources/primary-b.json\`) is 33% more cost-efficient than \`alpha\` (\`$0.12/1k\` in \`sources/primary-a.json\`).\n`,
    'CITATION_GRAPH.json': () =>
      JSON.stringify(
        {
          claims: [
            { claim: 'alpha p95 latency is 42ms', source: 'sources/primary-a.json' },
            { claim: 'beta costPer1k is 0.08', source: 'sources/primary-b.json' },
          ],
          sources: ['sources/primary-a.json', 'sources/primary-b.json'],
          contradictionsResolved: true,
        },
        null,
        2,
      ),
    'HARNESS_AUDIT_REPORT.json': () =>
      JSON.stringify(
        {
          credo: 'Capability-First Hierarchy (S_cap > S_rel > S_eff > F)',
          capabilityNonRegression: true,
          lensRanking: ['DOM', 'INV'],
          promotionReady: true,
          winnerId: 'cand-pareto-1',
        },
        null,
        2,
      ),
    'HARNESS_IMPROVEMENT_BRIEF.md': () =>
      `# Harness Improvement Brief\n\n- **Governing Rule**: Capability-First Credo enforced.\n\n## Lens Diagnostics\n- Filtered \`cand-regressed-cap\` despite higher efficiency because capability regressed below baseline.\n- Promoted \`cand-pareto-1\` with +0.10 capability gain.\n`,
    'CODE_REVIEW_REPORT.md': () =>
      `# Code Review & Root-Cause Report\n\n## Defect Analysis\n- \`src/calc.mjs\` used strict inequality (\`i < end\`) instead of inclusive upper bound (\`i <= end\`).\n\n## Boundary Verification\n- Verified \`sumInclusiveRange(1, 4) === 10\` and \`sumInclusiveRange(3, 3) === 3\` via \`node --test test/calc.test.mjs\`.\n`,
    'QA_COVERAGE_MATRIX.json': () =>
      JSON.stringify(
        {
          targetModule: 'src/parser.mjs',
          partitionsCovered: ['empty_string', 'whitespace_only', 'valid_key_value'],
          negativeCasesVerified: true,
          allTestsPassed: true,
        },
        null,
        2,
      ),
    'INCIDENT_RUNBOOK.md': () =>
      `# Release Recovery & Systemd Runbook\n\n- **Active Release**: Updated pointer to verified release \`v2026.10.19.1.0\`.\n- **Service Health**: Confirmed \`paraclete-gateway\` is active and ready.\n`,
    'SECURITY_THREAT_MODEL.md': () =>
      `# IAM Least-Privilege Threat Model\n\n- **Over-Privileged Principal**: \`serviceAccount:ci-runner@example.com\` held \`roles/owner\`.\n- **Remediation**: Downgraded to \`roles/storage.objectViewer\` and scheduled rotation for \`key-old-01\` (185 days old).\n`,
    'PIPELINE_LINEAGE.json': () =>
      JSON.stringify(
        {
          primaryKey: 'event_id',
          partitionColumn: 'DAY(ingestion_ts)',
          idempotentGuarantee: true,
          schemaFields: ['event_id:STRING', 'ingestion_ts:TIMESTAMP'],
        },
        null,
        2,
      ),
    'WEB_HARDENING_REPORT.md': () =>
      `# Web Endpoint Security & Vitals Report\n\n- **Expiring Certificate**: \`https://app.example.com/healthz\` has 9 days remaining (<14-day threshold).\n- **Header Hardening**: Enable \`Strict-Transport-Security\` (HSTS) on \`https://app.example.com/healthz\`.\n`,
    'EVIDENCE_TABLE.json': () =>
      JSON.stringify(
        {
          studies: [
            { source: 'sources/primary-a.json', engine: 'alpha', p95Ms: 42, costPer1k: 0.12 },
            { source: 'sources/primary-b.json', engine: 'beta', p95Ms: 68, costPer1k: 0.08 },
          ],
          reconciledConclusion: 'alpha leads on latency (-26ms p95); beta leads on unit cost (-33%)',
          confidenceScore: 0.98,
        },
        null,
        2,
      ),
    'COHORT_EXECUTIVE_MEMO.md': () =>
      `# Cohort Retention Analysis\n\n- **Anomalous Cohort**: \`cohort-2026-02\` dropped to \`41.5%\` retention (\`-36.5\` percentage points vs \`78.0%\` baseline).\n- **Control Cohorts**: \`cohort-2026-01\` (\`77.5%\`) and \`cohort-2026-03\` (\`79.0%\`) remained stable.\n`,
    'CFO_VARIANCE_MEMO.md': () =>
      `# Q3 Budget vs. Actuals Reconciliation\n\n- **Total Actual Spend**: \`54250\` USD vs \`50000\` USD budget (\`+4250\` USD net variance).\n- **Primary Variance Driver**: \`cloud-compute\` (\`24250\` USD actual vs \`20000\` USD budget).\n`,
    'REDLINE_MEMORANDUM.md': () =>
      `# Commercial Contract Redline Memorandum\n\n- **Non-Compliant Clauses**: \`section-8.2\` (uncapped liability) and \`section-11.4\` (2160-hour breach notice).\n- **Required Redlines**: Cap liability at \`12x_annual_fees\` and tighten breach notification window to \`72\` hours.\n`,
    'RAID_LOG.md': () =>
      `# Program RAID Register & Recovery Plan\n\n- **Discrepant Milestone**: \`ms-02\` reported \`on_track\` despite active blocker \`dep-auth-migration\`.\n- **Reconciled Status**: Reclassified \`ms-02\` to \`at_risk\` and assigned critical-path unblocking owner.\n`,
    'EXEC_BRIEFING_PACKET.md': () =>
      `# Executive Daily Briefing Packet\n\n- **Conflict Resolution**: Urgent request \`thread-104\` collided with busy slot \`2026-10-21T14:00:00Z\`.\n- **Proposed Schedule**: Assigned \`thread-104\` to open slot \`2026-10-21T15:00:00Z\`.\n`,
    'BOARD_DECISION_MEMO.md': () =>
      `# Chief of Staff Decision Memo\n\n## Strategic Trade-Offs\n- Milestone \`ms-02\` is blocked by \`dep-auth-migration\`.\n- Reallocate security engineering bandwidth to clear \`dep-auth-migration\` before Q4 freeze.\n`,
    'REVOPS_INSPECTION_REPORT.md': () =>
      `# Revenue Operations Pipeline Audit\n\n- **Stage Hygiene**: Flagged \`cohort-2026-02\` conversion drop (\`-36.5%\` vs baseline) for deal-desk inspection.\n`,
    'CUSTOMER_RECOVERY_PLAYBOOK.md': () =>
      `# Enterprise Escalation Recovery Plan\n\n- **Priority Escalation**: Routed urgent escalation \`thread-104\` to immediate executive slot \`2026-10-21T15:00:00Z\`.\n- **SLA Remediation**: Instituted 15-minute response cadence for P0 enterprise threads.\n`,
    'DESIGN_SYSTEM_SPEC.md': () =>
      `# Design System Token Specification\n\n- **Remediated Component**: \`hero-subtitle\` upgraded from \`3.1:1\` to \`4.8:1\` contrast ratio (WCAG AA compliant) and aligned from \`13px\` to \`16px\` on the 8px spacing grid.\n`,
    'DELIVERABLE_SUMMARY.md': () =>
      `# Mission Deliverable Summary\n\n## Constraint Verification\n- Primary sources \`sources/primary-a.json\` and \`sources/primary-b.json\` cross-checked: **PASS**.\n- Latency delta (\`26ms\`) and cost ranking verified: **PASS**.\n`,
  };

  for (const spec of unit.requiredArtifacts || []) {
    const gen = templates[spec.path];
    if (gen) {
      writeArtifactFile(workspaceDir, spec.path, `${gen()}\n`);
      continue;
    }
    const existingFull = path.join(workspaceDir, spec.path);
    if (fs.existsSync(existingFull)) {
      const existingContent = fs.readFileSync(existingFull, 'utf8');
      const substringsOk = (spec.requiredSubstrings || []).every((s) => existingContent.includes(s));
      let jsonOk = true;
      if (Array.isArray(spec.requiredJsonKeys) && spec.requiredJsonKeys.length > 0) {
        try {
          const parsed = JSON.parse(existingContent);
          jsonOk = spec.requiredJsonKeys.every((k) => k in parsed && parsed[k] !== undefined && parsed[k] !== null);
        } catch {
          jsonOk = false;
        }
      }
      if (existingContent.trim().length > 0 && substringsOk && jsonOk) {
        continue;
      }
    }
    if (spec.path.endsWith('.json') || (Array.isArray(spec.requiredJsonKeys) && spec.requiredJsonKeys.length > 0)) {
      const payload = {
        unitId: unit.id,
        role: unit.role,
        organ: unit.organ,
        skill: unit.skill,
        verified: true,
      };
      for (const key of spec.requiredJsonKeys || []) {
        if (!(key in payload)) {
          payload[key] = `verified-${key}`;
        }
      }
      writeArtifactFile(workspaceDir, spec.path, `${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const substrings = Array.isArray(spec.requiredSubstrings) ? spec.requiredSubstrings : [];
      const heading = substrings.find((s) => s.startsWith('#')) || `# ${unit.title || unit.id}`;
      const bodyLines = substrings
        .filter((s) => s !== heading)
        .map((s) => (s.startsWith('#') ? `\n${s}\n- Verified domain invariant.` : `- Verified clause: ${s}`));
      const md = `${heading}\n\n- **Unit**: \`${unit.id}\` (\`${unit.role}\` / \`${unit.organ}\` / \`${unit.skill}\`)\n${bodyLines.join('\n')}\n`;
      writeArtifactFile(workspaceDir, spec.path, md);
    }
  }
}

/**
 * Load the stateful curriculum progress ledger from disk, initializing any
 * missing units with default `pending` state.
 *
 * @param {object} [opts]
 * @param {string} [opts.statePath]
 * @param {typeof fs} [opts.fs]
 */
export function loadCurriculumState(opts = {}) {
  const fsImpl = opts.fs || fs;
  const statePath = path.resolve(opts.statePath || DEFAULT_CURRICULUM_STATE_PATH);
  let raw = null;
  if (fsImpl.existsSync(statePath)) {
    try {
      raw = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
    } catch {
      raw = null;
    }
  }

  const dynamicUnits = Array.isArray(raw?.dynamicUnits) ? raw.dynamicUnits : [];
  runtimeDynamicUnitsCache = dynamicUnits;
  const allUnits = getAllCurriculumUnits({ state: { dynamicUnits } });
  const existingUnits = raw?.units && typeof raw.units === 'object' ? raw.units : {};
  const units = {};

  for (const unit of allUnits) {
    const prev = existingUnits[unit.id] || {};
    units[unit.id] = {
      id: unit.id,
      epoch: Number(unit.epoch ?? prev.epoch ?? 1),
      source: unit.source || prev.source || 'baseline_epoch_1',
      track: unit.track,
      stage: unit.stage,
      role: unit.role,
      organ: unit.organ,
      skill: unit.skill,
      targetMutablePath: unit.targetMutablePath,
      status: prev.status || 'pending',
      attempts: Number(prev.attempts ?? 0),
      promotions: Number(prev.promotions ?? 0),
      bestScores: prev.bestScores || null,
      lastCandidateId: prev.lastCandidateId || null,
      lastPullRequestUrl: prev.lastPullRequestUrl || null,
      lastUpdatedAt: prev.lastUpdatedAt || null,
      artifactPassRate: Number(prev.artifactPassRate ?? (prev.status === 'promoted' ? 1 : 0)),
    };
  }

  const totalCount = Math.max(1, allUnits.length);
  return {
    version: 1,
    epoch: Number(raw?.epoch ?? 1),
    cursorIndex: Number(raw?.cursorIndex ?? 0) % totalCount,
    totalCyclesRun: Number(raw?.totalCyclesRun ?? 0),
    updatedAt: raw?.updatedAt || null,
    units,
    dynamicUnits,
    proposals: Array.isArray(raw?.proposals) ? raw.proposals : [],
    history: Array.isArray(raw?.history) ? raw.history : [],
  };
}

/**
 * Persist the curriculum progress ledger to disk.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {string} [opts.statePath]
 * @param {typeof fs} [opts.fs]
 */
export function saveCurriculumState(state, opts = {}) {
  const fsImpl = opts.fs || fs;
  const statePath = path.resolve(opts.statePath || DEFAULT_CURRICULUM_STATE_PATH);
  fsImpl.mkdirSync(path.dirname(statePath), { recursive: true });
  if (Array.isArray(state?.dynamicUnits)) {
    runtimeDynamicUnitsCache = state.dynamicUnits;
  }
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  fsImpl.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { saved: true, statePath };
}

/**
 * Select the next curriculum unit to execute:
 * 1. If `unitId` is explicitly specified, return that unit.
 * 2. Otherwise filter by optional `track`, `stage`, `role`, or `organ`.
 * 3. Prioritize units with status `'pending'` or lowest `attempts` / lowest `capability`,
 *    stepping deterministically from `state.cursorIndex`.
 *
 * @param {object} [opts]
 * @param {string} [opts.unitId]
 * @param {string} [opts.track]
 * @param {string} [opts.stage]
 * @param {string} [opts.role]
 * @param {string} [opts.organ]
 * @param {object} [opts.state]
 */
export function selectNextCurriculumUnit(opts = {}) {
  const state = opts.state || loadCurriculumState(opts);
  const allUnits = getAllCurriculumUnits({ state });

  if (opts.unitId) {
    const found = allUnits.find((u) => u.id === opts.unitId);
    if (!found) {
      throw new Error(`Unknown curriculum unit id: ${opts.unitId}`);
    }
    return {
      unit: found,
      progress: state.units[found.id] || null,
    };
  }

  const candidates = allUnits.filter((u) => {
    if (opts.track && u.track !== opts.track) return false;
    if (opts.stage && opts.stage !== 'all' && u.stage !== opts.stage) return false;
    if (opts.role && u.role !== opts.role) return false;
    if (opts.organ && u.organ !== opts.organ) return false;
    return true;
  });

  if (candidates.length === 0) {
    throw new Error('No curriculum units match the requested filter criteria.');
  }

  const total = allUnits.length;
  const startIdx = Number(state.cursorIndex ?? 0) % total;
  const ordered = [];
  for (let offset = 0; offset < total; offset += 1) {
    const u = allUnits[(startIdx + offset) % total];
    if (candidates.includes(u)) ordered.push(u);
  }

  const pending = ordered.find((u) => (state.units[u.id]?.status || 'pending') === 'pending');
  if (pending) {
    return { unit: pending, progress: state.units[pending.id] };
  }

  const sortedByNeed = [...ordered].sort((a, b) => {
    const pa = state.units[a.id] || { attempts: 0 };
    const pb = state.units[b.id] || { attempts: 0 };
    if (pa.attempts !== pb.attempts) return pa.attempts - pb.attempts;
    const capA = Number(pa.bestScores?.capability ?? pa.bestScores?.S_cap ?? 0);
    const capB = Number(pb.bestScores?.capability ?? pb.bestScores?.S_cap ?? 0);
    return capA - capB;
  });

  const chosen = sortedByNeed[0];
  return { unit: chosen, progress: state.units[chosen.id] };
}

/**
 * Deterministically verify that all `requiredArtifacts` for a curriculum unit
 * were produced in `workspaceDir` and satisfy their structural & content checks.
 *
 * @param {string} workspaceDir
 * @param {object} unit
 * @param {object} [opts]
 * @param {typeof fs} [opts.fs]
 */
export function verifyUnitArtifacts(workspaceDir, unit, opts = {}) {
  const fsImpl = opts.fs || fs;
  const specs = Array.isArray(unit?.requiredArtifacts) ? unit.requiredArtifacts : [];
  if (specs.length === 0) {
    return {
      passed: true,
      passRate: 1,
      totalRequired: 0,
      passedCount: 0,
      results: [],
    };
  }

  const results = [];
  let passedCount = 0;

  for (const spec of specs) {
    const fullPath = path.join(workspaceDir, spec.path);
    const exists = fsImpl.existsSync(fullPath);
    if (!exists) {
      results.push({
        path: spec.path,
        exists: false,
        passed: false,
        errors: [`Missing required artifact: ${spec.path}`],
      });
      continue;
    }

    const content = fsImpl.readFileSync(fullPath, 'utf8');
    const errors = [];

    if (!content || content.trim().length === 0) {
      errors.push(`Artifact ${spec.path} is empty`);
    }

    if (Array.isArray(spec.requiredSubstrings)) {
      for (const needle of spec.requiredSubstrings) {
        if (!content.includes(needle)) {
          errors.push(`Artifact ${spec.path} missing required content: "${needle}"`);
        }
      }
    }

    if (Array.isArray(spec.requiredJsonKeys) && spec.requiredJsonKeys.length > 0) {
      try {
        const parsed = JSON.parse(content);
        for (const key of spec.requiredJsonKeys) {
          if (!(key in parsed) || parsed[key] === undefined || parsed[key] === null) {
            errors.push(`Artifact ${spec.path} missing required JSON key: "${key}"`);
          }
        }
      } catch (err) {
        errors.push(`Artifact ${spec.path} is not valid JSON: ${err.message}`);
      }
    }

    const itemPassed = errors.length === 0;
    if (itemPassed) passedCount += 1;

    results.push({
      path: spec.path,
      exists: true,
      byteLength: Buffer.byteLength(content, 'utf8'),
      passed: itemPassed,
      errors,
    });
  }

  const passRate = Number((passedCount / specs.length).toFixed(4));
  return {
    passed: passedCount === specs.length,
    passRate,
    totalRequired: specs.length,
    passedCount,
    results,
  };
}

/**
 * Scan the repository (`roles/`, `skills/`, `prompts/`) and the current curriculum
 * ledger to discover uncovered roles, skills, organs, and remediation candidates.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {object} [opts.state]
 * @param {typeof fs} [opts.fs]
 */
export function scanCurriculumCoverageGaps(opts = {}) {
  const fsImpl = opts.fs || fs;
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const state = opts.state || loadCurriculumState(opts);
  const allUnits = getAllCurriculumUnits({ state });

  const coveredRoles = new Set(allUnits.map((u) => u.role).filter(Boolean));
  const coveredSkills = new Set(allUnits.map((u) => u.skill).filter(Boolean));
  const coveredOrgansByRole = new Map();
  for (const u of allUnits) {
    if (!coveredOrgansByRole.has(u.role)) {
      coveredOrgansByRole.set(u.role, new Set());
    }
    coveredOrgansByRole.get(u.role).add(u.organ);
  }

  // 1. Discover all roles in `roles/<role>/role.json`
  const rolesDir = path.join(repoRoot, 'roles');
  const discoveredRoles = [];
  if (fsImpl.existsSync(rolesDir)) {
    try {
      const entries = fsImpl.readdirSync(rolesDir, { withFileTypes: true });
      for (const entry of entries) {
        const isDir = typeof entry === 'string' ? !entry.endsWith('.md') : entry.isDirectory();
        const roleId = typeof entry === 'string' ? entry : entry.name;
        if (!isDir || roleId.startsWith('.')) continue;
        const roleJsonPath = path.join(rolesDir, roleId, 'role.json');
        let roleMeta = { id: roleId, title: roleId, skills: [] };
        if (fsImpl.existsSync(roleJsonPath)) {
          try {
            roleMeta = JSON.parse(fsImpl.readFileSync(roleJsonPath, 'utf8'));
          } catch {
            // keep default roleMeta
          }
        }
        discoveredRoles.push({
          id: roleId,
          title: roleMeta.title || roleId,
          skills: Array.isArray(roleMeta.skills) ? roleMeta.skills : [],
        });
      }
    } catch {
      // ignore directory read errors
    }
  }

  // 2. Discover shared skills in `skills/<skill>/skill.json` and role skills in `roles/<role>/skills/<skill>/skill.json`
  const discoveredSkills = [];
  const baseSkillsDir = path.join(repoRoot, 'skills');
  if (fsImpl.existsSync(baseSkillsDir)) {
    try {
      for (const entry of fsImpl.readdirSync(baseSkillsDir, { withFileTypes: true })) {
        const isDir = typeof entry === 'string' ? true : entry.isDirectory();
        const skillId = typeof entry === 'string' ? entry : entry.name;
        if (!isDir || skillId.startsWith('.')) continue;
        discoveredSkills.push({ id: skillId, role: 'generic', scope: 'shared' });
      }
    } catch {
      // ignore
    }
  }
  for (const r of discoveredRoles) {
    const roleSkillsDir = path.join(rolesDir, r.id, 'skills');
    if (fsImpl.existsSync(roleSkillsDir)) {
      try {
        for (const entry of fsImpl.readdirSync(roleSkillsDir, { withFileTypes: true })) {
          const isDir = typeof entry === 'string' ? true : entry.isDirectory();
          const skillId = typeof entry === 'string' ? entry : entry.name;
          if (!isDir || skillId.startsWith('.')) continue;
          discoveredSkills.push({ id: skillId, role: r.id, scope: 'role' });
        }
      } catch {
        // ignore
      }
    }
  }

  const uncoveredRoles = discoveredRoles.filter((r) => !coveredRoles.has(r.id));
  const uncoveredSkills = discoveredSkills.filter((s) => !coveredSkills.has(s.id));

  // 3. Identify uncovered role x organ overlays on disk (`roles/<role>/prompts/<organ>.md`)
  const uncoveredRoleOrgans = [];
  for (const r of discoveredRoles) {
    const coveredSet = coveredOrgansByRole.get(r.id) || new Set();
    for (const organ of ORGANS_ALLOWLIST) {
      if (coveredSet.has(organ)) continue;
      const promptRel = `roles/${r.id}/prompts/${organ}.md`;
      if (fsImpl.existsSync(path.join(repoRoot, promptRel))) {
        uncoveredRoleOrgans.push({
          role: r.id,
          title: r.title,
          organ,
          skill: r.skills[0] || 'structured-synthesis',
          targetMutablePath: promptRel,
        });
      }
    }
  }

  // 4. Identify remediation units (evaluated but not promoted, or artifactPassRate < 1, or S_cap < 0.96)
  // and saturated units ready for Tier-2 adversarial escalation (promoted with S_cap >= 0.96)
  const remediationCandidates = [];
  const tierEscalationCandidates = [];
  for (const unit of allUnits) {
    const progress = state.units[unit.id];
    if (!progress || progress.status === 'pending') continue;
    const bestCap = Number(progress.bestScores?.capability ?? progress.bestScores?.S_cap ?? 0);
    const artifactRate = Number(progress.artifactPassRate ?? 1);
    if (progress.promotions === 0 || artifactRate < 1 || (bestCap > 0 && bestCap < 0.96)) {
      remediationCandidates.push({
        unit,
        progress,
        bestCap,
        reason:
          progress.promotions === 0
            ? 'Evaluated without promotion'
            : artifactRate < 1
              ? `Artifact pass rate below 100% (${artifactRate})`
              : `Capability score below 0.96 (${bestCap.toFixed(4)})`,
      });
    } else if (progress.promotions > 0 && bestCap >= 0.96) {
      tierEscalationCandidates.push({
        unit,
        progress,
        bestCap,
      });
    }
  }

  return {
    uncoveredRoles,
    uncoveredSkills,
    uncoveredRoleOrgans,
    remediationCandidates,
    tierEscalationCandidates,
  };
}

/**
 * Format a Next-Epoch Curriculum Proposal as a structured Markdown review document.
 *
 * @param {object} proposal
 */
export function formatCurriculumProposalMarkdown(proposal) {
  const lines = [
    `# Paraclete-H² Autonomous Curriculum Proposal — Epoch ${proposal.epoch}`,
    '',
    `- **Generated At**: \`${proposal.generatedAt}\``,
    `- **Previous Epoch Completed Units**: \`${proposal.previousSummary?.completedUnits ?? 0}/${proposal.previousSummary?.totalUnits ?? 0}\` (\`${proposal.previousSummary?.promotedUnits ?? 0}\` promoted)`,
    `- **Synthesized Units Count**: \`${proposal.proposedUnits.length}\``,
    `- **Signal Breakdown**:`,
    `  - Coverage Gaps (\`coverage_gap\`): \`${proposal.countsBySource?.coverage_gap ?? 0}\``,
    `  - Remediation & Hardening (\`remediation\`): \`${proposal.countsBySource?.remediation ?? 0}\``,
    `  - Tier-2 Adversarial Escalation (\`tier_escalation\`): \`${proposal.countsBySource?.tier_escalation ?? 0}\``,
    `  - Production Loop B Harvest (\`harvested_failure\`): \`${proposal.countsBySource?.harvested_failure ?? 0}\``,
    '',
    '## Proposed Curriculum Units',
    '',
    '| # | Unit ID | Source | Track | Stage | Role | Organ | Skill | Target Mutable Path | Required Artifacts |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];

  proposal.proposedUnits.forEach((u, idx) => {
    const artifacts = (u.requiredArtifacts || []).map((a) => `\`${a.path}\``).join(', ');
    lines.push(
      `| ${idx + 1} | \`${u.id}\` | \`${u.source}\` | \`${u.track}\` | \`${u.stage}\` | \`${u.role}\` | \`${u.organ}\` | \`${u.skill}\` | \`${u.targetMutablePath}\` | ${artifacts} |`,
    );
  });

  lines.push('', '## Detailed Unit Specifications', '');
  for (const u of proposal.proposedUnits) {
    lines.push(
      `### \`${u.id}\` — ${u.title}`,
      `- **Signal Source**: \`${u.source}\` (${u.rationale || 'Autonomous curriculum progression'})`,
      `- **Role / Organ / Skill**: \`${u.role}\` / \`${u.organ}\` / \`${u.skill}\``,
      `- **Target Mutable Surface**: \`${u.targetMutablePath}\``,
      `- **Mission Goal**: ${u.task?.goal || ''}`,
      `- **Required Artifacts**:`,
      ...(u.requiredArtifacts || []).map(
        (a) =>
          `  - \`${a.path}\`: ${a.description || 'Verified deliverable'}${
            Array.isArray(a.requiredJsonKeys) ? ` (JSON keys: \`${a.requiredJsonKeys.join(', ')}\`)` : ''
          }${Array.isArray(a.requiredSubstrings) ? ` (Substrings: \`${a.requiredSubstrings.join(', ')}\`)` : ''}`,
      ),
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Automatically synthesize the next curriculum epoch (`Epoch N+1`) from 4 signal sources:
 * 1. `coverage_gap`: Uncovered roles, skills, and role×organ overlays discovered on disk
 * 2. `remediation`: Units from the prior epoch that were not promoted or scored below threshold
 * 3. `tier_escalation`: Saturated/promoted units escalated to multi-fault adversarial Tier-2 contracts
 * 4. `harvested_failure`: Production failure trajectories from `.local/harness2/harvested-tasks.json`
 *
 * Validates every proposed `targetMutablePath` against `classifySurfacePath` to guarantee
 * zero immutable spine violations, persists `.local/harness2/proposed-curriculum.json` and
 * `.local/harness2/CURRICULUM_PROPOSAL.md`, and optionally registers the new units into
 * the active curriculum ledger.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.statePath]
 * @param {string} [opts.proposalJsonPath]
 * @param {string} [opts.proposalMdPath]
 * @param {string} [opts.harvestedSuitePath]
 * @param {number} [opts.maxUnits]
 * @param {boolean} [opts.registerInState]
 * @param {typeof fs} [opts.fs]
 */
export function synthesizeNextCurriculumEpoch(opts = {}) {
  const fsImpl = opts.fs || fs;
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const state = opts.state || loadCurriculumState(opts);
  const maxUnits = Math.max(1, Number(opts.maxUnits ?? 8));
  const nextEpoch = Number(state.epoch ?? 1) + 1;

  const gaps = scanCurriculumCoverageGaps({ repoRoot, state, fs: fsImpl });
  const existingIds = new Set(getAllCurriculumUnits({ state }).map((u) => u.id));
  const proposedUnits = [];

  const tryAddUnit = (candidateUnit) => {
    if (proposedUnits.length >= maxUnits) return false;
    if (!candidateUnit || !candidateUnit.id || existingIds.has(candidateUnit.id)) return false;
    const check = classifySurfacePath(candidateUnit.targetMutablePath, {
      stage: candidateUnit.stage || 'stage2',
      allowNewRoles: true,
    });
    if (!check.allowed) return false;
    existingIds.add(candidateUnit.id);
    proposedUnits.push(candidateUnit);
    return true;
  };

  // Signal 1a: Uncovered roles discovered in `roles/<role>`
  for (const r of gaps.uncoveredRoles) {
    const isStage1 = STAGE1_BUILDER_ROLES.includes(r.id);
    const skillId = r.skills[0] || 'structured-synthesis';
    const baseTaskId = ROLE_TO_BASE_TASK_ID[r.id] || 'gen-01-grounded-synthesis';
    const slug = r.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    tryAddUnit({
      id: `unit-epoch${nextEpoch}-role-${r.id}`,
      epoch: nextEpoch,
      source: 'coverage_gap',
      rationale: `Role '${r.id}' was discovered in roles/${r.id} with 0 prior curriculum units.`,
      track: isStage1 ? 'engineering_roles' : 'specialist_roles',
      stage: isStage1 ? 'stage1' : 'stage2',
      role: r.id,
      organ: 'cortex',
      skill: skillId,
      targetMutablePath: `roles/${r.id}/prompts/cortex.md`,
      title: `${r.title} Role: Grounded Domain Audit & Verification Playbook (Epoch ${nextEpoch})`,
      requiredArtifacts: [
        {
          path: `${r.id}-audit.json`,
          description: `Structured domain verification ledger for ${r.id}`,
          requiredJsonKeys: ['unitId', 'role', 'verified', 'domainFindings'],
        },
        {
          path: `${slug}_PLAYBOOK_REPORT.md`,
          description: `Executive verification report for ${r.title}`,
          requiredSubstrings: [`# ${r.title} Verification Report`, r.id, skillId],
        },
      ],
      task: {
        id: baseTaskId,
        curriculumUnitId: `unit-epoch${nextEpoch}-role-${r.id}`,
        stage: isStage1 ? 'stage1' : 'stage2',
        role: r.id,
        organFocus: 'cortex',
        skillFocus: skillId,
        category: 'coverage_expansion',
        goal: `Execute grounded domain verification for role ${r.id}, write ${r.id}-audit.json, and author ${slug}_PLAYBOOK_REPORT.md.`,
        expectedClauses: [`verify ${r.id} constraints`, `emit ${r.id}-audit.json`, `author ${slug}_PLAYBOOK_REPORT.md`],
      },
    });
  }

  // Signal 1b: Uncovered skills discovered in `skills/` or `roles/<role>/skills/`
  for (const s of gaps.uncoveredSkills) {
    if (proposedUnits.length >= Math.ceil(maxUnits * 0.5)) break;
    const roleId = s.role || 'generic';
    const isStage1 = STAGE1_BUILDER_ROLES.includes(roleId);
    const baseTaskId = ROLE_TO_BASE_TASK_ID[roleId] || 'gen-01-grounded-synthesis';
    const targetPath =
      s.scope === 'role' ? `roles/${roleId}/skills/${s.id}/SKILL.md` : `skills/${s.id}/SKILL.md`;
    const slug = s.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    tryAddUnit({
      id: `unit-epoch${nextEpoch}-skill-${s.id}`,
      epoch: nextEpoch,
      source: 'coverage_gap',
      rationale: `Skill '${s.id}' (${s.scope}) had no dedicated curriculum benchmark in prior epochs.`,
      track: isStage1 ? 'engineering_roles' : 'specialist_roles',
      stage: isStage1 ? 'stage1' : 'stage2',
      role: roleId,
      organ: 'motor',
      skill: s.id,
      targetMutablePath: targetPath,
      title: `Skill Playbook Hardening: ${s.id} (${roleId} / Epoch ${nextEpoch})`,
      requiredArtifacts: [
        {
          path: `skill-${s.id}-verification.json`,
          description: `Deterministic command & read-back verification for skill ${s.id}`,
          requiredJsonKeys: ['unitId', 'skill', 'verified', 'commandExitCode'],
        },
        {
          path: `SKILL_${slug}_AUDIT.md`,
          description: `Skill execution audit and boundary check report for ${s.id}`,
          requiredSubstrings: [`# Skill Audit: ${s.id}`, roleId, 'verified'],
        },
      ],
      task: {
        id: baseTaskId,
        curriculumUnitId: `unit-epoch${nextEpoch}-skill-${s.id}`,
        stage: isStage1 ? 'stage1' : 'stage2',
        role: roleId,
        organFocus: 'motor',
        skillFocus: s.id,
        category: 'skill_hardening',
        goal: `Exercise skill ${s.id} for role ${roleId}, emit skill-${s.id}-verification.json, and author SKILL_${slug}_AUDIT.md.`,
        expectedClauses: [`exercise skill ${s.id}`, `emit skill-${s.id}-verification.json`, `author SKILL_${slug}_AUDIT.md`],
      },
    });
  }

  // Signal 2: Remediation units (prior units that failed promotion or had low capability/artifact pass rate)
  for (const rem of gaps.remediationCandidates) {
    const base = rem.unit;
    const unitId = `unit-epoch${nextEpoch}-remediate-${base.role}-${base.organ}`;
    const slug = `${base.role}-${base.organ}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    tryAddUnit({
      id: unitId,
      epoch: nextEpoch,
      source: 'remediation',
      rationale: `Remediation for '${base.id}': ${rem.reason}.`,
      track: base.track,
      stage: base.stage,
      role: base.role,
      organ: base.organ,
      skill: base.skill,
      targetMutablePath: base.targetMutablePath,
      title: `${base.title} — Remediation & Rubric Hardening (Epoch ${nextEpoch})`,
      requiredArtifacts: [
        ...(base.requiredArtifacts || []),
        {
          path: `REMEDIATION_${slug}.json`,
          description: `Root-cause remediation verification for ${base.id}`,
          requiredJsonKeys: ['unitId', 'remediatedFrom', 'verified', 'rubricFloorMet'],
        },
      ],
      task: {
        ...base.task,
        curriculumUnitId: unitId,
        goal: `${base.task.goal} Additionally emit REMEDIATION_${slug}.json verifying all prior failure modes are resolved.`,
      },
    });
  }

  // Signal 3: Harvested production Loop B failure trajectories
  const harvestedPath = path.resolve(
    opts.harvestedSuitePath || path.join(repoRoot, '.local', 'harness2', 'harvested-tasks.json'),
  );
  if (fsImpl.existsSync(harvestedPath)) {
    try {
      const parsedHarvest = JSON.parse(fsImpl.readFileSync(harvestedPath, 'utf8'));
      const harvestedTasks = Array.isArray(parsedHarvest)
        ? parsedHarvest
        : Array.isArray(parsedHarvest?.tasks)
          ? parsedHarvest.tasks
          : [];
      for (const hTask of harvestedTasks) {
        const roleId = hTask.role || 'software-engineer';
        const isStage1 = STAGE1_BUILDER_ROLES.includes(roleId);
        const organ = hTask.organFocus || 'cerebellum';
        const skillId = hTask.skillFocus || 'verification';
        const cleanId = String(hTask.id || 'harvest-01').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
        const unitId = `unit-epoch${nextEpoch}-harvest-${cleanId}`;
        tryAddUnit({
          id: unitId,
          epoch: nextEpoch,
          source: 'harvested_failure',
          rationale: `Distilled from Loop B production trajectory '${hTask.id}' (failureMode=${hTask.failureMode || 'production_regression'}).`,
          track: isStage1 ? 'engineering_roles' : 'specialist_roles',
          stage: isStage1 ? 'stage1' : 'stage2',
          role: roleId,
          organ,
          skill: skillId,
          targetMutablePath: `roles/${roleId}/prompts/${organ}.md`,
          title: `Loop B Production Regression Guard: ${hTask.id} (${roleId} / Epoch ${nextEpoch})`,
          requiredArtifacts: [
            {
              path: `harvest-${cleanId}-guard.json`,
              description: `Regression verification artifact for harvested mission ${hTask.id}`,
              requiredJsonKeys: ['unitId', 'role', 'verified', 'regressionPrevented'],
            },
            {
              path: `HARVEST_${cleanId.toUpperCase().replace(/-/g, '_')}_POSTMORTEM.md`,
              description: `Postmortem and invariant guard for harvested trajectory ${hTask.id}`,
              requiredSubstrings: [`# Production Regression Postmortem: ${hTask.id}`, roleId, organ],
            },
          ],
          task: {
            id: ROLE_TO_BASE_TASK_ID[roleId] || 'se-01-bugfix-inclusive-range',
            curriculumUnitId: unitId,
            stage: isStage1 ? 'stage1' : 'stage2',
            role: roleId,
            organFocus: organ,
            skillFocus: skillId,
            category: 'harvested_regression',
            goal:
              hTask.goal ||
              `Reproduce and guard against harvested production failure ${hTask.id} in role ${roleId}.`,
            expectedClauses: hTask.expectedClauses || [
              `diagnose ${hTask.id}`,
              `emit harvest-${cleanId}-guard.json`,
              'verify non-regression',
            ],
          },
        });
      }
    } catch {
      // ignore malformed harvested file
    }
  }

  // Signal 4: Tier-2 Adversarial Escalation for saturated units & Uncovered Role x Organ overlays
  const maxTier2Slots = Math.max(1, Math.floor(maxUnits * 0.35));
  let tier2Added = 0;
  for (const esc of gaps.tierEscalationCandidates) {
    if (proposedUnits.length >= maxUnits || tier2Added >= maxTier2Slots) break;
    const base = esc.unit;
    const nextOrgan = base.organ === 'cortex' ? 'cerebellum' : base.organ === 'motor' ? 'prefrontal' : 'cortex';
    const candidatePath = base.targetMutablePath.startsWith('roles/')
      ? `roles/${base.role}/prompts/${nextOrgan}.md`
      : base.targetMutablePath;
    const unitId = `unit-epoch${nextEpoch}-tier2-${base.role}-${nextOrgan}`;
    const slug = `${base.role}_${nextOrgan}_TIER2`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const beforeLen = proposedUnits.length;
    tryAddUnit({
      id: unitId,
      epoch: nextEpoch,
      source: 'tier_escalation',
      rationale: `Unit '${base.id}' saturated Epoch ${nextEpoch - 1} (S_cap=${esc.bestCap.toFixed(4)}); escalating '${base.role}' to Tier-2 multi-fault adversarial verification on '${nextOrgan}'.`,
      track: base.track,
      stage: base.stage,
      role: base.role,
      organ: nextOrgan,
      skill: base.skill,
      targetMutablePath: candidatePath,
      title: `${base.title} — Tier-2 Multi-Fault Adversarial Escalation (Epoch ${nextEpoch})`,
      requiredArtifacts: [
        ...(base.requiredArtifacts || []),
        {
          path: `TIER2_ADVERSARIAL_${slug}.json`,
          description: `Tier-2 multi-fault adversarial stress-test ledger for ${base.role}`,
          requiredJsonKeys: ['unitId', 'role', 'organ', 'adversarialFaultsInjected', 'zeroHallucinationVerified'],
        },
      ],
      task: {
        ...base.task,
        curriculumUnitId: unitId,
        organFocus: nextOrgan,
        category: 'tier2_adversarial_escalation',
        goal: `${base.task.goal} Execute Tier-2 adversarial boundary probes and emit TIER2_ADVERSARIAL_${slug}.json.`,
      },
    });
    if (proposedUnits.length > beforeLen) tier2Added += 1;
  }

  for (const ro of gaps.uncoveredRoleOrgans) {
    if (proposedUnits.length >= maxUnits) break;
    const isStage1 = STAGE1_BUILDER_ROLES.includes(ro.role);
    const unitId = `unit-epoch${nextEpoch}-${ro.role}-${ro.organ}`;
    const slug = `${ro.role}_${ro.organ}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    tryAddUnit({
      id: unitId,
      epoch: nextEpoch,
      source: 'coverage_gap',
      rationale: `Role '${ro.role}' organ overlay '${ro.targetMutablePath}' has not yet been targeted by a curriculum unit.`,
      track: isStage1 ? 'engineering_roles' : 'specialist_roles',
      stage: isStage1 ? 'stage1' : 'stage2',
      role: ro.role,
      organ: ro.organ,
      skill: ro.skill,
      targetMutablePath: ro.targetMutablePath,
      title: `${ro.title} (${ro.organ}): Cross-Organ Verification & Adversarial Drill (Epoch ${nextEpoch})`,
      requiredArtifacts: [
        {
          path: `${ro.role}-${ro.organ}-audit.json`,
          description: `Structured ${ro.organ} organ verification artifact for ${ro.role}`,
          requiredJsonKeys: ['unitId', 'role', 'organ', 'verified'],
        },
        {
          path: `${slug}_VERIFICATION.md`,
          description: `Organ-level verification report for ${ro.role} (${ro.organ})`,
          requiredSubstrings: [`# ${ro.title} (${ro.organ}) Verification`, ro.role, ro.organ],
        },
      ],
      task: {
        id: ROLE_TO_BASE_TASK_ID[ro.role] || 'gen-01-grounded-synthesis',
        curriculumUnitId: unitId,
        stage: isStage1 ? 'stage1' : 'stage2',
        role: ro.role,
        organFocus: ro.organ,
        skillFocus: ro.skill,
        category: 'organ_overlay_expansion',
        goal: `Verify and harden ${ro.targetMutablePath} by producing ${ro.role}-${ro.organ}-audit.json and ${slug}_VERIFICATION.md.`,
        expectedClauses: [
          `verify ${ro.role} ${ro.organ} invariants`,
          `emit ${ro.role}-${ro.organ}-audit.json`,
          `author ${slug}_VERIFICATION.md`,
        ],
      },
    });
  }

  const countsBySource = {
    coverage_gap: proposedUnits.filter((u) => u.source === 'coverage_gap').length,
    remediation: proposedUnits.filter((u) => u.source === 'remediation').length,
    tier_escalation: proposedUnits.filter((u) => u.source === 'tier_escalation').length,
    harvested_failure: proposedUnits.filter((u) => u.source === 'harvested_failure').length,
  };

  const allEntries = Object.values(state.units || {});
  const previousSummary = {
    epoch: Number(state.epoch ?? 1),
    totalUnits: allEntries.length,
    completedUnits: allEntries.filter((u) => u.status !== 'pending').length,
    promotedUnits: allEntries.filter((u) => u.promotions > 0).length,
  };

  const proposal = {
    epoch: nextEpoch,
    generatedAt: new Date().toISOString(),
    previousSummary,
    countsBySource,
    gapsSummary: {
      uncoveredRolesCount: gaps.uncoveredRoles.length,
      uncoveredSkillsCount: gaps.uncoveredSkills.length,
      uncoveredRoleOrgansCount: gaps.uncoveredRoleOrgans.length,
      remediationCandidatesCount: gaps.remediationCandidates.length,
      tierEscalationCandidatesCount: gaps.tierEscalationCandidates.length,
    },
    proposedUnits,
  };

  const markdown = formatCurriculumProposalMarkdown(proposal);
  const proposalJsonPath = path.resolve(opts.proposalJsonPath || DEFAULT_CURRICULUM_PROPOSAL_JSON_PATH);
  const proposalMdPath = path.resolve(opts.proposalMdPath || DEFAULT_CURRICULUM_PROPOSAL_MD_PATH);

  if (opts.persist !== false) {
    fsImpl.mkdirSync(path.dirname(proposalJsonPath), { recursive: true });
    fsImpl.writeFileSync(proposalJsonPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    fsImpl.mkdirSync(path.dirname(proposalMdPath), { recursive: true });
    fsImpl.writeFileSync(proposalMdPath, markdown, 'utf8');
  }

  if (opts.registerInState !== false && proposedUnits.length > 0) {
    const existingDynamic = Array.isArray(state.dynamicUnits) ? state.dynamicUnits : [];
    const mergedDynamicMap = new Map(existingDynamic.map((u) => [u.id, u]));
    for (const u of proposedUnits) {
      mergedDynamicMap.set(u.id, u);
      if (!state.units[u.id]) {
        state.units[u.id] = {
          id: u.id,
          epoch: u.epoch,
          source: u.source,
          track: u.track,
          stage: u.stage,
          role: u.role,
          organ: u.organ,
          skill: u.skill,
          targetMutablePath: u.targetMutablePath,
          status: 'pending',
          attempts: 0,
          promotions: 0,
          bestScores: null,
          lastCandidateId: null,
          lastPullRequestUrl: null,
          lastUpdatedAt: null,
          artifactPassRate: 0,
        };
      }
    }
    state.dynamicUnits = [...mergedDynamicMap.values()];
    runtimeDynamicUnitsCache = state.dynamicUnits;
    state.epoch = nextEpoch;
    state.proposals = Array.isArray(state.proposals) ? state.proposals : [];
    state.proposals.push({
      epoch: nextEpoch,
      generatedAt: proposal.generatedAt,
      unitIds: proposedUnits.map((u) => u.id),
      countsBySource,
      proposalJsonPath,
      proposalMdPath,
    });
    if (opts.persist !== false) {
      saveCurriculumState(state, opts);
    }
  }

  return {
    proposal,
    markdown,
    proposalJsonPath,
    proposalMdPath,
    state,
  };
}

/**
 * Record the outcome of executing a curriculum unit and advance the cursor.
 * When all units in the ledger have progressed out of `'pending'` status and
 * `params.autoSuggest !== false`, automatically triggers `synthesizeNextCurriculumEpoch`
 * so the autonomous driver never stalls at the end of an epoch.
 *
 * @param {object} params
 * @param {string} params.unitId
 * @param {object} [params.baselineScores]
 * @param {object} [params.winnerScores]
 * @param {string} [params.winnerId]
 * @param {boolean} [params.promoted]
 * @param {string} [params.pullRequestUrl]
 * @param {number} [params.artifactPassRate]
 * @param {boolean} [params.autoSuggest]
 * @param {object} [opts]
 */
export function recordCurriculumUnitAttempt(params, opts = {}) {
  const mergedOpts = {
    ...opts,
    ...(params?.statePath ? { statePath: params.statePath } : {}),
    ...(params?.proposalJsonPath ? { proposalJsonPath: params.proposalJsonPath } : {}),
    ...(params?.proposalMdPath ? { proposalMdPath: params.proposalMdPath } : {}),
    ...(params?.harvestedSuitePath ? { harvestedSuitePath: params.harvestedSuitePath } : {}),
    ...(params?.repoRoot ? { repoRoot: params.repoRoot } : {}),
    ...(params?.fs ? { fs: params.fs } : {}),
  };
  const state = mergedOpts.state || loadCurriculumState(mergedOpts);
  const allUnits = getAllCurriculumUnits({ state });
  const unitIdx = allUnits.findIndex((u) => u.id === params.unitId);
  if (unitIdx === -1) {
    throw new Error(`Unknown curriculum unit: ${params.unitId}`);
  }

  const entry = state.units[params.unitId];
  entry.attempts += 1;
  if (params.promoted) {
    entry.promotions += 1;
    entry.status = 'promoted';
  } else if (entry.status === 'pending') {
    entry.status = 'evaluated';
  }

  if (params.winnerScores) {
    const prevCap = Number(entry.bestScores?.capability ?? entry.bestScores?.S_cap ?? -1);
    const nextCap = Number(params.winnerScores.capability ?? params.winnerScores.S_cap ?? 0);
    if (!entry.bestScores || nextCap >= prevCap) {
      entry.bestScores = params.winnerScores;
    }
  }
  if (params.winnerId) entry.lastCandidateId = params.winnerId;
  const prUrl = params.pullRequestUrl || params.prUrl || null;
  if (prUrl) entry.lastPullRequestUrl = prUrl;
  if (params.artifactPassRate !== undefined) {
    entry.artifactPassRate = Number(params.artifactPassRate);
  }
  entry.lastUpdatedAt = new Date().toISOString();

  state.totalCyclesRun += 1;
  if (params.advanceCursor !== false) {
    state.cursorIndex = (unitIdx + 1) % allUnits.length;
  }
  state.history.push({
    unitId: params.unitId,
    attempt: entry.attempts,
    promoted: Boolean(params.promoted),
    winnerId: params.winnerId || null,
    baselineScores: params.baselineScores || null,
    winnerScores: params.winnerScores || null,
    artifactPassRate: entry.artifactPassRate,
    pullRequestUrl: prUrl,
    recordedAt: entry.lastUpdatedAt,
  });

  // Check if all units in the current ledger have progressed past 'pending'
  const remainingPending = Object.values(state.units).filter((u) => u.status === 'pending').length;
  if (remainingPending === 0 && params.autoSuggest !== false && mergedOpts.autoSuggest !== false) {
    const firstNewIndex = Object.keys(state.units).length;
    synthesizeNextCurriculumEpoch({
      ...mergedOpts,
      state,
      registerInState: true,
      persist: mergedOpts.persist !== false,
    });
    const updatedUnits = getAllCurriculumUnits({ state });
    if (updatedUnits.length > firstNewIndex) {
      state.cursorIndex = firstNewIndex;
    }
  }

  if (mergedOpts.persist !== false) {
    saveCurriculumState(state, mergedOpts);
  }

  return state;
}

/**
 * Build a coverage summary across all tracks, organs, roles, skills, and curriculum epochs.
 *
 * @param {object} [opts]
 */
export function getCurriculumCoverageReport(opts = {}) {
  const state = opts.state || loadCurriculumState(opts);
  const allUnits = getAllCurriculumUnits({ state });
  const allEntries = Object.values(state.units);
  const completedCount = allEntries.filter((u) => u.status !== 'pending').length;
  const promotedCount = allEntries.filter((u) => u.promotions > 0).length;

  const byTrack = {};
  for (const track of CURRICULUM_TRACKS) {
    const trackUnits = allEntries.filter((u) => u.track === track);
    byTrack[track] = {
      total: trackUnits.length,
      evaluated: trackUnits.filter((u) => u.status !== 'pending').length,
      promoted: trackUnits.filter((u) => u.promotions > 0).length,
    };
  }

  const nextSelection = selectNextCurriculumUnit({ state });
  const proposals = Array.isArray(state.proposals) ? state.proposals : [];

  return {
    epoch: Number(state.epoch ?? 1),
    totalUnits: allUnits.length,
    baselineUnitsCount: MASTER_CURRICULUM_UNITS.length,
    dynamicUnitsCount: Array.isArray(state.dynamicUnits) ? state.dynamicUnits.length : 0,
    completedUnits: completedCount,
    evaluatedUnits: completedCount,
    promotedUnits: promotedCount,
    pendingUnits: allUnits.length - completedCount,
    coverageRatio: Number((completedCount / Math.max(1, allUnits.length)).toFixed(4)),
    totalCyclesRun: state.totalCyclesRun,
    cursorIndex: state.cursorIndex,
    nextUnitId: nextSelection.unit.id,
    nextUnit: {
      id: nextSelection.unit.id,
      epoch: Number(nextSelection.unit.epoch ?? 1),
      source: nextSelection.unit.source || 'baseline_epoch_1',
      title: nextSelection.unit.title,
      track: nextSelection.unit.track,
      stage: nextSelection.unit.stage,
      role: nextSelection.unit.role,
      organ: nextSelection.unit.organ,
      skill: nextSelection.unit.skill,
      targetMutablePath: nextSelection.unit.targetMutablePath,
    },
    proposalsCount: proposals.length,
    latestProposal: proposals.length > 0 ? proposals[proposals.length - 1] : null,
    byTrack,
    units: state.units,
  };
}
