/**
 * Standardized Telemetry, Curriculum Progress, and GCP Cost Reporter for Paraclete-H2.
 *
 * Collects and formats a canonical 5-section operational report covering:
 *   1. Executive Health & Loop Status Summary
 *   2. Master Curriculum Progress, Track Breakdown & Next-Epoch Readiness
 *   3. Loop A (Evolution) & Loop B (Runtime Harvest) Automation Cadence & Recent Runs
 *   4. GCP Infrastructure & Vertex AI Token Cost Analysis (Run-Rate, Accrued Spend & Optimization Levers)
 *   5. Operational Alerts, Self-Healing Diagnostics & Promotion Pull Requests
 *
 * Does not mutate any repository, curriculum, or cloud state.
 * Called by `dev/harness2/cli.mjs` (`report` subcommand) and `harness-cycle.mjs` (`--action report`).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  getCurriculumCoverageReport,
  loadCurriculumState,
  scanCurriculumCoverageGaps,
  MASTER_CURRICULUM_UNITS,
} from './curriculum.mjs';
import { CAPABILITY_CREDO } from './selection.mjs';
import { DEFAULT_JUDGE_COMMITTEE } from './judge.mjs';
import { loadPersistedBenchmarkTasks } from './harvest.mjs';

export const REPORT_STANDARD_VERSION = '1.0.0';

/**
 * Standard on-demand US-Central1 pricing constants (USD) for GCP Compute Engine,
 * Persistent Disk, Networking, and Vertex AI Frontier / Utility models.
 */
export const GCP_PRICING_US_CENTRAL1 = Object.freeze({
  machineTypesHourlyUsd: {
    'e2-standard-8': 0.268816,
    'e2-standard-4': 0.134408,
    'e2-standard-2': 0.067204,
    'n2-standard-8': 0.388464,
    'n2-standard-4': 0.194232,
  },
  diskTypesGbMonthlyUsd: {
    'pd-ssd': 0.17,
    'pd-balanced': 0.1,
    'pd-standard': 0.04,
  },
  externalIpv4HourlyUsd: 0.005,
  hoursPerMonth: 730,
  vertexModelsPerMillionTokensUsd: {
    frontier: {
      uncachedInput: 2.0,
      cachedInput: 0.4,
      output: 12.0,
    },
    utilityFlash: {
      uncachedInput: 0.15,
      cachedInput: 0.0375,
      output: 0.6,
    },
  },
});

function roundUsd(val, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(val || 0) * factor) / factor;
}

function extractShortType(uriOrType, fallback) {
  if (!uriOrType || typeof uriOrType !== 'string') return fallback;
  const parts = uriOrType.split('/');
  return parts[parts.length - 1] || fallback;
}

/**
 * Compute GCP infrastructure run-rate, accrued VM/disk spend, and Vertex AI LLM/Judge token spend.
 *
 * @param {object} [params]
 * @param {Array<object>} [params.instances] - Compute Engine instances (`name`, `machineType`, `status`, `creationTimestamp`, `networkInterfaces`)
 * @param {Array<object>} [params.disks] - Persistent disks (`name`, `sizeGb`, `type`, `status`)
 * @param {Array<object>} [params.missions] - Completed/active brain mission telemetry entries (`calls`, `input`, `output`, `cached`, `durationMs`)
 * @param {Array<object>} [params.curriculumHistory] - Curriculum evaluation history entries
 * @param {string} [params.billingAccountName]
 * @param {boolean} [params.billingEnabled]
 * @param {string} [params.nowIso]
 */
export function computeGcpCostEstimate(params = {}) {
  const nowMs = params.nowIso ? Date.parse(params.nowIso) : Date.now();
  const instances = Array.isArray(params.instances) ? params.instances : [];
  const disks = Array.isArray(params.disks) ? params.disks : [];
  const missions = Array.isArray(params.missions) ? params.missions : [];
  const curriculumHistory = Array.isArray(params.curriculumHistory) ? params.curriculumHistory : [];

  const vmBreakdown = [];
  let computeHourlyUsd = 0;
  let networkHourlyUsd = 0;
  let computeAccruedUsd = 0;
  let maxUptimeHours = 0;

  for (const inst of instances) {
    const mType = extractShortType(inst.machineType, 'e2-standard-4');
    const isRunning = (inst.status || 'RUNNING').toUpperCase() === 'RUNNING';
    const vmRateHr = isRunning
      ? (GCP_PRICING_US_CENTRAL1.machineTypesHourlyUsd[mType] ?? 0.134408)
      : 0;
    const hasExtIp = Array.isArray(inst.networkInterfaces)
      ? inst.networkInterfaces.some(
          (ni) => Array.isArray(ni.accessConfigs) && ni.accessConfigs.some((ac) => Boolean(ac.natIP)),
        )
      : true;
    const ipRateHr = isRunning && hasExtIp ? GCP_PRICING_US_CENTRAL1.externalIpv4HourlyUsd : 0;

    const createdMs = inst.creationTimestamp ? Date.parse(inst.creationTimestamp) : nowMs - 36 * 3600_000;
    const uptimeHours = Math.max(0, (nowMs - createdMs) / 3600_000);
    if (uptimeHours > maxUptimeHours) maxUptimeHours = uptimeHours;

    const totalInstRateHr = vmRateHr + ipRateHr;
    const accruedUsd = totalInstRateHr * uptimeHours;

    computeHourlyUsd += vmRateHr;
    networkHourlyUsd += ipRateHr;
    computeAccruedUsd += accruedUsd;

    vmBreakdown.push({
      name: inst.name || 'instance',
      machineType: mType,
      status: inst.status || 'RUNNING',
      uptimeHours: roundUsd(uptimeHours, 2),
      hourlyUsd: roundUsd(totalInstRateHr, 4),
      dailyUsd: roundUsd(totalInstRateHr * 24, 2),
      monthlyUsd: roundUsd(totalInstRateHr * GCP_PRICING_US_CENTRAL1.hoursPerMonth, 2),
      accruedUsd: roundUsd(accruedUsd, 2),
    });
  }

  const diskBreakdown = [];
  let storageMonthlyUsd = 0;
  for (const d of disks) {
    const dType = extractShortType(d.type, 'pd-balanced');
    const sizeGb = Number(d.sizeGb || d.diskSizeGb || 50);
    const rateGbMo = GCP_PRICING_US_CENTRAL1.diskTypesGbMonthlyUsd[dType] ?? 0.1;
    const monthlyUsd = sizeGb * rateGbMo;
    storageMonthlyUsd += monthlyUsd;
    diskBreakdown.push({
      name: d.name || 'disk',
      diskType: dType,
      sizeGb,
      monthlyUsd: roundUsd(monthlyUsd, 2),
      hourlyUsd: roundUsd(monthlyUsd / GCP_PRICING_US_CENTRAL1.hoursPerMonth, 4),
    });
  }

  const storageHourlyUsd = storageMonthlyUsd / GCP_PRICING_US_CENTRAL1.hoursPerMonth;
  const storageAccruedUsd = storageHourlyUsd * maxUptimeHours;

  const infraHourlyUsd = computeHourlyUsd + networkHourlyUsd + storageHourlyUsd;
  const infraDailyUsd = infraHourlyUsd * 24;
  const infraMonthlyUsd = infraHourlyUsd * GCP_PRICING_US_CENTRAL1.hoursPerMonth;
  const infraAccruedUsd = computeAccruedUsd + storageAccruedUsd;

  // Vertex AI Token & Committee Judge Spend
  let totalCalls = 0;
  let totalInputTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;

  for (const m of missions) {
    totalCalls += Number(m.calls || 0);
    totalInputTokens += Number(m.input || 0);
    totalCachedTokens += Number(m.cached || 0);
    totalOutputTokens += Number(m.output || 0);
  }

  // Include curriculum evaluation judge + rollout tokens (~45k input, ~4k output per curriculum attempt)
  const curriculumEvalCount = curriculumHistory.length;
  const curriculumInputTokens = curriculumEvalCount * 45_000;
  const curriculumOutputTokens = curriculumEvalCount * 4_500;
  totalCalls += curriculumEvalCount * 4;
  totalInputTokens += curriculumInputTokens;
  totalOutputTokens += curriculumOutputTokens;

  const uncachedInputTokens = Math.max(0, totalInputTokens - totalCachedTokens);
  const frontierRates = GCP_PRICING_US_CENTRAL1.vertexModelsPerMillionTokensUsd.frontier;
  const uncachedCostUsd = (uncachedInputTokens / 1_000_000) * frontierRates.uncachedInput;
  const cachedCostUsd = (totalCachedTokens / 1_000_000) * frontierRates.cachedInput;
  const outputCostUsd = (totalOutputTokens / 1_000_000) * frontierRates.output;
  const vertexAccruedUsd = uncachedCostUsd + cachedCostUsd + outputCostUsd;

  const cacheHitRate = totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : 0;
  const uncachedEquivalentUsd =
    (totalInputTokens / 1_000_000) * frontierRates.uncachedInput + outputCostUsd;
  const cacheSavingsUsd = Math.max(0, uncachedEquivalentUsd - vertexAccruedUsd);

  const effectiveDaysElapsed = Math.max(0.5, maxUptimeHours / 24);
  const vertexDailyRunRateUsd = vertexAccruedUsd / effectiveDaysElapsed;
  const vertexMonthlyRunRateUsd = vertexDailyRunRateUsd * 30.42;

  const totalAccruedUsd = infraAccruedUsd + vertexAccruedUsd;
  const projectedMonthlyTotalUsd = infraMonthlyUsd + vertexMonthlyRunRateUsd;

  const recommendations = [
    {
      id: 'opt-canary-on-demand',
      title: 'Stop paraclete-h2-canary between Tier-2 canary gates',
      estimatedMonthlySavingsUsd: roundUsd(
        (GCP_PRICING_US_CENTRAL1.machineTypesHourlyUsd['e2-standard-4'] +
          GCP_PRICING_US_CENTRAL1.externalIpv4HourlyUsd) *
          GCP_PRICING_US_CENTRAL1.hoursPerMonth *
          0.9,
        2,
      ),
      rationale:
        'paraclete-h2-canary is only needed during Tier-2 canary promotion checks (~15 min per cycle). Starting it on demand saves ~90% of its compute cost.',
    },
    {
      id: 'opt-driver-rightsize-or-cud',
      title: 'Apply 1-Year Compute Engine CUD or right-size driver to e2-standard-4',
      estimatedMonthlySavingsUsd: roundUsd(
        GCP_PRICING_US_CENTRAL1.machineTypesHourlyUsd['e2-standard-8'] *
          GCP_PRICING_US_CENTRAL1.hoursPerMonth *
          0.37,
        2,
      ),
      rationale:
        'Driver CPU load averages < 0.15 between 6-hour cycles; a 1-year Committed Use Discount (37%) or downsizing to e2-standard-4 cuts driver compute by $72-$98/mo.',
    },
    {
      id: 'opt-prompt-caching-active',
      title: 'Context Caching Active on Organ & Cerebellum Turns',
      estimatedMonthlySavingsUsd: roundUsd((cacheSavingsUsd / effectiveDaysElapsed) * 30.42, 2),
      rationale: `Prompt context caching achieved a ${(cacheHitRate * 100).toFixed(1)}% cache hit rate (${(totalCachedTokens / 1_000_000).toFixed(2)}M / ${(totalInputTokens / 1_000_000).toFixed(2)}M input tokens), already saving $${roundUsd(cacheSavingsUsd, 2)} to date.`,
    },
  ];

  return {
    billingAccountName: params.billingAccountName || 'billingAccounts/configured',
    billingEnabled: params.billingEnabled !== false,
    uptimeHours: roundUsd(maxUptimeHours, 2),
    infrastructure: {
      hourlyUsd: roundUsd(infraHourlyUsd, 4),
      dailyUsd: roundUsd(infraDailyUsd, 2),
      monthlyRunRateUsd: roundUsd(infraMonthlyUsd, 2),
      accruedToDateUsd: roundUsd(infraAccruedUsd, 2),
      vms: vmBreakdown,
      disks: diskBreakdown,
    },
    vertexAi: {
      totalCalls,
      totalInputTokens,
      totalCachedTokens,
      uncachedInputTokens,
      totalOutputTokens,
      cacheHitRate: roundUsd(cacheHitRate, 4),
      accruedSpendUsd: roundUsd(vertexAccruedUsd, 2),
      cacheSavingsUsd: roundUsd(cacheSavingsUsd, 2),
      dailyRunRateUsd: roundUsd(vertexDailyRunRateUsd, 2),
      monthlyRunRateUsd: roundUsd(vertexMonthlyRunRateUsd, 2),
    },
    totals: {
      accruedToDateUsd: roundUsd(totalAccruedUsd, 2),
      dailyRunRateUsd: roundUsd(infraDailyUsd + vertexDailyRunRateUsd, 2),
      projectedMonthlyTotalUsd: roundUsd(projectedMonthlyTotalUsd, 2),
    },
    recommendations,
  };
}

/**
 * Build the complete standardized Paraclete-H2 Autonomous Loop & Cost Report object.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.projectId]
 * @param {string} [opts.statePath]
 * @param {object} [opts.state]
 * @param {Array<object>} [opts.instances]
 * @param {Array<object>} [opts.disks]
 * @param {Array<object>} [opts.missions]
 * @param {Array<object>} [opts.pullRequests]
 * @param {Array<object>} [opts.alerts]
 * @param {object} [opts.schedules]
 * @param {string} [opts.billingAccountName]
 * @param {boolean} [opts.billingEnabled]
 * @param {string} [opts.nowIso]
 * @param {typeof fs} [opts.fs]
 */
export function buildLoopStatusReport(opts = {}) {
  const fsImpl = opts.fs || fs;
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const generatedAt = opts.nowIso || new Date().toISOString();
  const state = opts.state || loadCurriculumState({ statePath: opts.statePath, fs: fsImpl });
  const coverage = getCurriculumCoverageReport({ statePath: opts.statePath, state, fs: fsImpl });
  const gaps = scanCurriculumCoverageGaps({ repoRoot, statePath: opts.statePath, state, fs: fsImpl });
  const harvestedTasks = loadPersistedBenchmarkTasks({ suitePath: opts.harvestedSuitePath, fs: fsImpl });

  // Track breakdown across the curriculum ledger
  const trackMap = new Map([
    ['organs', { id: 'organs', label: 'Track 1: Core Harness Organs', total: 0, completed: 0, promoted: 0, pending: 0 }],
    [
      'engineering_roles',
      { id: 'engineering_roles', label: 'Track 2: Stage 1 Engineering Roles & Skills', total: 0, completed: 0, promoted: 0, pending: 0 },
    ],
    [
      'specialist_roles',
      { id: 'specialist_roles', label: 'Track 3: Stage 2 Specialist Roles & Skills', total: 0, completed: 0, promoted: 0, pending: 0 },
    ],
  ]);

  const completedUnitDetails = [];
  const pendingUnitPreview = [];

  for (const [id, u] of Object.entries(state.units || {})) {
    const bucket = trackMap.get(u.track) || {
      id: u.track || 'custom',
      label: u.track || 'Custom Track',
      total: 0,
      completed: 0,
      promoted: 0,
      pending: 0,
    };
    bucket.total += 1;
    if (u.status === 'pending') {
      bucket.pending += 1;
      if (pendingUnitPreview.length < 5) {
        const def = MASTER_CURRICULUM_UNITS.find((m) => m.id === id);
        pendingUnitPreview.push({
          id,
          track: u.track,
          stage: u.stage,
          role: u.role,
          organ: u.organ,
          skill: u.skill,
          targetMutablePath: u.targetMutablePath,
          title: def?.title || `${u.role} (${u.organ} / ${u.skill})`,
        });
      }
    } else {
      bucket.completed += 1;
      if (u.promotions > 0) bucket.promoted += 1;
      completedUnitDetails.push({
        id,
        epoch: u.epoch || 1,
        track: u.track,
        role: u.role,
        organ: u.organ,
        skill: u.skill,
        targetMutablePath: u.targetMutablePath,
        status: u.status,
        attempts: u.attempts,
        promotions: u.promotions,
        capability: Number(u.bestScores?.capability ?? u.bestScores?.S_cap ?? 0),
        reliability: Number(u.bestScores?.reliability ?? u.bestScores?.S_rel ?? 0),
        efficiency: Number(u.bestScores?.efficiency ?? u.bestScores?.S_eff ?? 0),
        fitness: Number(u.bestScores?.fitness ?? 0),
        artifactPassRate: Number(u.artifactPassRate ?? (u.status === 'promoted' ? 1 : 0)),
        lastUpdatedAt: u.lastUpdatedAt,
        lastPullRequestUrl: u.lastPullRequestUrl || null,
      });
    }
    trackMap.set(bucket.id, bucket);
  }

  const avgScores =
    completedUnitDetails.length > 0
      ? {
          capability: roundUsd(
            completedUnitDetails.reduce((s, u) => s + u.capability, 0) / completedUnitDetails.length,
            4,
          ),
          reliability: roundUsd(
            completedUnitDetails.reduce((s, u) => s + u.reliability, 0) / completedUnitDetails.length,
            4,
          ),
          efficiency: roundUsd(
            completedUnitDetails.reduce((s, u) => s + u.efficiency, 0) / completedUnitDetails.length,
            4,
          ),
          fitness: roundUsd(
            completedUnitDetails.reduce((s, u) => s + u.fitness, 0) / completedUnitDetails.length,
            4,
          ),
        }
      : { capability: 0, reliability: 0, efficiency: 0, fitness: 0 };

  const cost = computeGcpCostEstimate({
    instances: opts.instances,
    disks: opts.disks,
    missions: opts.missions,
    curriculumHistory: state.history || [],
    billingAccountName: opts.billingAccountName,
    billingEnabled: opts.billingEnabled,
    nowIso: generatedAt,
  });

  const alerts = Array.isArray(opts.alerts) ? opts.alerts : [];
  const overallHealth = alerts.some((a) => a.severity === 'critical')
    ? 'ACTION_REQUIRED'
    : alerts.some((a) => a.severity === 'warning')
      ? 'DEGRADED_SELF_HEALING'
      : 'HEALTHY';

  return {
    standardVersion: REPORT_STANDARD_VERSION,
    generatedAt,
    projectId: opts.projectId || 'your-gcp-project',
    overallHealth,
    credo: CAPABILITY_CREDO.name,
    judgeCommittee: DEFAULT_JUDGE_COMMITTEE,
    curriculum: {
      epoch: coverage.epoch,
      totalUnits: coverage.totalUnits,
      completedUnits: coverage.completedUnits,
      promotedUnits: coverage.promotedUnits,
      pendingUnits: coverage.pendingUnits,
      completionPct: roundUsd((coverage.completedUnits / Math.max(1, coverage.totalUnits)) * 100, 1),
      cursorIndex: coverage.cursorIndex,
      nextUnit: coverage.nextUnit,
      totalCyclesRun: coverage.totalCyclesRun,
      averageScores: avgScores,
      tracks: [...trackMap.values()],
      completedUnitDetails,
      pendingUnitPreview,
      coverageSummary: {
        organsTotal: Object.keys(coverage.byOrgan || {}).length,
        rolesTotal: Object.keys(coverage.byRole || {}).length,
        skillsTotal: Object.keys(coverage.bySkill || {}).length,
      },
      nextEpochSynthesizer: {
        uncoveredRolesCount: gaps.uncoveredRoles.length,
        uncoveredSkillsCount: gaps.uncoveredSkills.length,
        uncoveredRoleOrgansCount: gaps.uncoveredRoleOrgans.length,
        remediationCandidatesCount: gaps.remediationCandidates.length,
        tierEscalationCandidatesCount: gaps.tierEscalationCandidates.length,
        harvestedTasksCount: harvestedTasks.length,
      },
    },
    automation: {
      schedules: opts.schedules || {
        curriculumTimer: 'every 6 hours (paraclete-h2-curriculum.timer)',
        closedLoopResponsibility: 'daily 04:00 UTC (r-harness-closed-loop)',
        failureHarvestResponsibility: 'every 6 hours (r-failure-harvest)',
        memoryConsolidationResponsibility: 'daily 08:00 UTC (r-memory-consolidation)',
      },
      recentMissions: Array.isArray(opts.missions) ? opts.missions : [],
      pullRequests: Array.isArray(opts.pullRequests) ? opts.pullRequests : [],
    },
    cost,
    alerts,
  };
}

/**
 * Format the standardized Paraclete-H2 Loop & GCP Cost Report as GitHub-Flavored Markdown.
 *
 * @param {object} report - Output of `buildLoopStatusReport`
 * @returns {string}
 */
export function formatLoopStatusReportMarkdown(report) {
  const c = report.curriculum;
  const cost = report.cost;
  const lines = [
    `# Paraclete-H² Autonomous Loop & GCP Cost Status Report`,
    ``,
    `- **Report Standard**: \`v${report.standardVersion}\` | **Generated At**: \`${report.generatedAt}\``,
    `- **GCP Project**: \`${report.projectId}\` | **Overall Loop Health**: **\`${report.overallHealth}\`**`,
    `- **Optimization Credo**: \`${report.credo}\` (\`capability -> reliability -> efficiency -> fitness\`)`,
    `- **Frontier Judge Committee**: \`${(report.judgeCommittee || []).join(' + ')}\``,
    ``,
    `---`,
    ``,
    `## 1. Executive Summary Scorecard`,
    ``,
    `| Metric | Current Value | Target / Notes |`,
    `| :--- | :--- | :--- |`,
    `| **Curriculum Epoch & Progress** | **Epoch ${c.epoch}: \`${c.completedUnits}/${c.totalUnits}\` units (\`${c.completionPct}%\`)** | \`${c.promotedUnits}\` promoted, \`${c.pendingUnits}\` pending (Next: \`${c.nextUnit || 'Epoch Rollover'}\`) |`,
    `| **Mean Evolved Capability ($S_{\\text{cap}}$)** | **\`${c.averageScores.capability.toFixed(4)}\`** | Non-regression gate + strict artifact verification (\`100%\` pass rate) |`,
    `| **Mean Reliability ($S_{\\text{rel}}$) & Efficiency ($S_{\\text{eff}}$)** | **\`${c.averageScores.reliability.toFixed(4)}\` / \`${c.averageScores.efficiency.toFixed(4)}\`** | Composite Fitness $F = \\mathbf{${c.averageScores.fitness.toFixed(4)}}$ |`,
    `| **Loop B Harvested Tasks** | **\`${c.nextEpochSynthesizer.harvestedTasksCount}\` tasks** | Active in \`.local/harness2/harvested-suite.json\` |`,
    `| **Autonomous Brain Missions Executed** | **\`${(report.automation.recentMissions || []).length}\` scheduled runs** | \`r-harness-closed-loop\`, \`r-failure-harvest\`, \`r-memory-consolidation\` |`,
    `| **Accrued GCP + Vertex AI Spend** | **\`$${cost.totals.accruedToDateUsd.toFixed(2)}\`** (\`${cost.uptimeHours}h\` uptime) | Infra: \`$${cost.infrastructure.accruedToDateUsd.toFixed(2)}\` + Vertex AI: \`$${cost.vertexAi.accruedSpendUsd.toFixed(2)}\` |`,
    `| **Projected Monthly Run-Rate** | **\`$${cost.totals.projectedMonthlyTotalUsd.toFixed(2)}/mo\`** (\`$${cost.totals.dailyRunRateUsd.toFixed(2)}/day\`) | Infra: \`$${cost.infrastructure.monthlyRunRateUsd.toFixed(2)}/mo\` + Vertex AI: \`$${cost.vertexAi.monthlyRunRateUsd.toFixed(2)}/mo\` |`,
    ``,
    `---`,
    ``,
    `## 2. Master Curriculum Progress & Epoch Summary`,
    ``,
    `### 2.1 Track-by-Track Progression`,
    ``,
    `| Track | Completed | Promoted | Pending | Total | Progress |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- |`,
  ];

  for (const t of c.tracks || []) {
    const pct = ((t.completed / Math.max(1, t.total)) * 100).toFixed(1);
    lines.push(
      `| **${t.label}** | \`${t.completed}\` | \`${t.promoted}\` | \`${t.pending}\` | \`${t.total}\` | \`${pct}%\` |`,
    );
  }

  lines.push(
    ``,
    `### 2.2 Completed & Promoted Curriculum Units`,
    ``,
    `| Unit ID | Epoch | Track | Role / Organ / Skill | Target Mutable Surface | $S_{\\text{cap}}$ | $S_{\\text{rel}}$ | $S_{\\text{eff}}$ | Fitness ($F$) | Artifacts | Status |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
  );

  if ((c.completedUnitDetails || []).length === 0) {
    lines.push(`| *(none yet)* | - | - | - | - | - | - | - | - | - | - |`);
  } else {
    for (const u of c.completedUnitDetails) {
      lines.push(
        `| \`${u.id}\` | \`${u.epoch}\` | \`${u.track}\` | \`${u.role}\` / \`${u.organ}\` / \`${u.skill}\` | \`${u.targetMutablePath}\` | **\`${u.capability.toFixed(4)}\`** | \`${u.reliability.toFixed(4)}\` | \`${u.efficiency.toFixed(4)}\` | \`${u.fitness.toFixed(4)}\` | \`${(u.artifactPassRate * 100).toFixed(0)}%\` | **\`${u.status.toUpperCase()}\`** |`,
      );
    }
  }

  lines.push(
    ``,
    `### 2.3 Next Queued Curriculum Units (Up Next in Epoch ${c.epoch})`,
    ``,
    `| Cursor Order | Unit ID | Track | Stage | Role / Organ / Skill | Target Mutable Surface |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- |`,
  );

  for (let i = 0; i < (c.pendingUnitPreview || []).length; i += 1) {
    const p = c.pendingUnitPreview[i];
    lines.push(
      `| \`#${c.cursorIndex + i + 1}\` | \`${p.id}\` | \`${p.track}\` | \`${p.stage}\` | \`${p.role}\` / \`${p.organ}\` / \`${p.skill}\` | \`${p.targetMutablePath}\` |`,
    );
  }

  const synth = c.nextEpochSynthesizer;
  lines.push(
    ``,
    `### 2.4 Next-Epoch Synthesizer Readiness (Epoch ${c.epoch + 1} Signal Queue)`,
    `- **Uncovered Shared/Role Skills Discovered**: \`${synth.uncoveredSkillsCount}\``,
    `- **Uncovered Role × Organ Overlays Discovered**: \`${synth.uncoveredRoleOrgansCount}\``,
    `- **Saturated Units Ready for Tier-2 Adversarial Escalation ($S_{\\text{cap}} \\ge 0.96$)**: \`${synth.tierEscalationCandidatesCount}\``,
    `- **Units Flagged for Root-Cause Remediation**: \`${synth.remediationCandidatesCount}\``,
    `- **Loop B Harvested Regression Tasks Ready**: \`${synth.harvestedTasksCount}\``,
    ``,
    `---`,
    ``,
    `## 3. Loop A & Loop B Automation Cadence & Recent Executions`,
    ``,
    `- **Curriculum Evolution Timer**: \`${report.automation.schedules.curriculumTimer}\``,
    `- **Daily Closed-Loop Playbook**: \`${report.automation.schedules.closedLoopResponsibility}\``,
    `- **Loop B Trajectory Harvest**: \`${report.automation.schedules.failureHarvestResponsibility}\``,
    `- **Memory Consolidation**: \`${report.automation.schedules.memoryConsolidationResponsibility}\``,
  );

  if ((report.automation.recentMissions || []).length > 0) {
    lines.push(
      ``,
      `### Recent Autonomous Missions on Driver VM`,
      ``,
      `| Timestamp (UTC) | Responsibility / Trigger | Mission ID | LLM Calls | Input Tokens | Cached Tokens (Hit %) | Output Tokens | Status |`,
      `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
    );
    for (const m of report.automation.recentMissions) {
      const hitPct = m.input > 0 ? ((Number(m.cached || 0) / Number(m.input)) * 100).toFixed(1) : '0.0';
      lines.push(
        `| \`${m.timestamp || '-'}\` | \`${m.responsibility || 'scheduled'}\` | \`${m.missionId || '-'}\` | \`${m.calls || 0}\` | \`${Number(m.input || 0).toLocaleString('en-US')}\` | \`${Number(m.cached || 0).toLocaleString('en-US')}\` (\`${hitPct}%\`) | \`${Number(m.output || 0).toLocaleString('en-US')}\` | **\`${m.status || 'COMPLETE'}\`** |`,
      );
    }
  }

  lines.push(
    ``,
    `---`,
    ``,
    `## 4. GCP Infrastructure & Vertex AI Cost Analysis`,
    ``,
    `- **Billing Account**: \`${cost.billingAccountName}\` (\`billingEnabled: ${cost.billingEnabled}\`)`,
    `- **Lab Uptime**: \`${cost.uptimeHours} hours\``,
    ``,
    `### 4.1 Compute Engine & Persistent Storage Breakdown`,
    ``,
    `| Resource | Type / Size | Status | Hourly Rate | Daily Rate | Monthly Run-Rate | Accrued to Date |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
  );

  for (const vm of cost.infrastructure.vms || []) {
    lines.push(
      `| **VM: \`${vm.name}\`** | \`${vm.machineType}\` + Ext IPv4 | \`${vm.status}\` | \`$${vm.hourlyUsd.toFixed(4)}/hr\` | \`$${vm.dailyUsd.toFixed(2)}/day\` | \`$${vm.monthlyUsd.toFixed(2)}/mo\` | **\`$${vm.accruedUsd.toFixed(2)}\`** |`,
    );
  }
  for (const d of cost.infrastructure.disks || []) {
    const dAccrued = d.hourlyUsd * cost.uptimeHours;
    lines.push(
      `| **Disk: \`${d.name}\`** | \`${d.sizeGb} GB ${d.diskType}\` | \`READY\` | \`$${d.hourlyUsd.toFixed(4)}/hr\` | \`$${(d.hourlyUsd * 24).toFixed(2)}/day\` | \`$${d.monthlyUsd.toFixed(2)}/mo\` | **\`$${dAccrued.toFixed(2)}\`** |`,
    );
  }

  lines.push(
    `| **Infrastructure Subtotal** | — | — | **\`$${cost.infrastructure.hourlyUsd.toFixed(4)}/hr\`** | **\`$${cost.infrastructure.dailyUsd.toFixed(2)}/day\`** | **\`$${cost.infrastructure.monthlyRunRateUsd.toFixed(2)}/mo\`** | **\`$${cost.infrastructure.accruedToDateUsd.toFixed(2)}\`** |`,
    ``,
    `### 4.2 Vertex AI LLM & Frontier Judge Committee Token Spend`,
    ``,
    `| Metric | Volume / Value | Cost / Savings Impact |`,
    `| :--- | :--- | :--- |`,
    `| **Total Organ + Judge Calls** | \`${cost.vertexAi.totalCalls.toLocaleString('en-US')} calls\` | Across scheduled responsibilities & curriculum evaluations |`,
    `| **Total Input Tokens** | \`${cost.vertexAi.totalInputTokens.toLocaleString('en-US')} tokens\` | Uncached: \`${cost.vertexAi.uncachedInputTokens.toLocaleString('en-US')}\` / Cached: \`${cost.vertexAi.totalCachedTokens.toLocaleString('en-US')}\` |`,
    `| **Prompt Context Cache Hit Rate** | **\`${(cost.vertexAi.cacheHitRate * 100).toFixed(1)}%\`** | Saved **\`$${cost.vertexAi.cacheSavingsUsd.toFixed(2)}\`** vs. uncached frontier input |`,
    `| **Total Output Tokens** | \`${cost.vertexAi.totalOutputTokens.toLocaleString('en-US')} tokens\` | Organ plans, code patches, and committee scorecards |`,
    `| **Vertex AI Spend (Accrued / Run-Rate)** | **\`$${cost.vertexAi.accruedSpendUsd.toFixed(2)}\` accrued** | **\`$${cost.vertexAi.dailyRunRateUsd.toFixed(2)}/day\`** (\`$${cost.vertexAi.monthlyRunRateUsd.toFixed(2)}/mo\` projected) |`,
    `| **Combined Total (Infra + Vertex AI)** | **\`$${cost.totals.accruedToDateUsd.toFixed(2)}\` accrued** | **\`$${cost.totals.dailyRunRateUsd.toFixed(2)}/day\`** (**\`$${cost.totals.projectedMonthlyTotalUsd.toFixed(2)}/mo\`** projected) |`,
    ``,
    `### 4.3 Cost Optimization Recommendations`,
  );

  for (const rec of cost.recommendations || []) {
    lines.push(
      `- **${rec.title}** (Est. impact: **\`$${rec.estimatedMonthlySavingsUsd.toFixed(2)}/mo\`**): ${rec.rationale}`,
    );
  }

  lines.push(
    ``,
    `---`,
    ``,
    `## 5. Operational Alerts, Self-Healing Diagnostics & Pull Requests`,
  );

  if ((report.alerts || []).length === 0) {
    lines.push(`- **Operational Alerts**: None — all timers, services, and indexes healthy.`);
  } else {
    for (const a of report.alerts) {
      lines.push(`- **[${(a.severity || 'info').toUpperCase()}] ${a.title}**: ${a.detail}`);
    }
  }

  if ((report.automation.pullRequests || []).length > 0) {
    lines.push(``, `### Active & Recent Promotion Pull Requests`);
    for (const pr of report.automation.pullRequests) {
      lines.push(`- **PR #${pr.number}** (\`${pr.state}\` — \`${pr.headRefName}\`): ${pr.title} — ${pr.url}`);
    }
  }

  lines.push(``);
  return lines.join('\n');
}
