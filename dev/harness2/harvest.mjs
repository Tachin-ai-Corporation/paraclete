// dev/harness2/harvest.mjs: Version-aware Loop B → Loop A trajectory harvester.

import fs from 'node:fs';
import path from 'node:path';
import { extractTrajectory, scoreTrajectory } from './trajectory.mjs';

function readJsonSafe(filePath, readFile) {
  try {
    return JSON.parse(readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeParsedPayload(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.trajectories)) return parsed.trajectories;
  if (Array.isArray(parsed.missions)) return parsed.missions;
  if (Array.isArray(parsed.documents)) return parsed.documents;
  if (parsed.envelope || parsed.id || parsed.missionId) return [parsed];
  return [];
}

/**
 * Load raw mission rollout records from a JSON file or a directory of mission
 * folders / JSON files (`missions/<id>/envelope.json`, etc.).
 *
 * @param {string} inputPath
 * @param {object} [deps]
 * @returns {object[]}
 */
export function loadMissionsFromInput(inputPath, deps = {}) {
  if (!inputPath) return [];
  const exists = deps.existsSync || fs.existsSync;
  const stat = deps.statSync || fs.statSync;
  const readDir = deps.readdirSync || fs.readdirSync;
  const readFile = deps.readFileSync || fs.readFileSync;

  if (!exists(inputPath)) return [];
  const st = stat(inputPath);
  if (st.isFile()) {
    return normalizeParsedPayload(readJsonSafe(inputPath, readFile));
  }
  if (!st.isDirectory()) return [];

  const results = [];
  const entries = readDir(inputPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const fullPath = path.join(inputPath, entryName);
    const isDir = typeof entry === 'string' ? stat(fullPath).isDirectory() : entry.isDirectory();

    if (!isDir && entryName.endsWith('.json')) {
      results.push(...normalizeParsedPayload(readJsonSafe(fullPath, readFile)));
    } else if (isDir) {
      const envPath = path.join(fullPath, 'envelope.json');
      if (exists(envPath)) {
        const envelope = readJsonSafe(envPath, readFile);
        if (envelope) {
          const checkpoints = normalizeParsedPayload(readJsonSafe(path.join(fullPath, 'checkpoints.json'), readFile));
          const tasks = normalizeParsedPayload(readJsonSafe(path.join(fullPath, 'tasks.json'), readFile));
          const usageRecords = normalizeParsedPayload(readJsonSafe(path.join(fullPath, 'usage.json'), readFile));
          results.push({ envelope, checkpoints, tasks, usageRecords });
        }
      }
    }
  }
  return results;
}

/**
 * Filter and group harvested production/canary mission rollouts by `(platform_version, role)`.
 * Only missions matching `minPlatformVersion` (or exact `targetVersion` when specified)
 * are eligible to enter Loop A's benchmark synthesis queue, preventing stale failures
 * from older releases from polluting current harness evolution.
 *
 * @param {object[]} rawMissions  Array of `{ envelope, checkpoints, tasks, usageRecords }`
 * @param {object} [opts]
 * @param {string} [opts.targetVersion]       Exact `platform_version` filter (e.g. `v2026.10.19.3.1`)
 * @param {string} [opts.minPlatformVersion]  Minimum `platform_version` lexicographical floor
 * @param {string} [opts.role]                Optional role filter
 */
export function harvestMissionTrajectories(rawMissions = [], opts = {}) {
  const accepted = [];
  const skippedStale = [];
  const byRoleAndVersion = {};

  for (const item of rawMissions) {
    const env = item?.envelope || item || {};
    const version = env.platform_version || 'unknown';
    const role = env.role || 'unknown';

    if (opts.role && role !== opts.role) continue;

    if (opts.targetVersion && version !== opts.targetVersion) {
      skippedStale.push({ missionId: env.id || 'unknown', version, reason: 'version_mismatch' });
      continue;
    }

    if (opts.minPlatformVersion && (version === 'unknown' || version < opts.minPlatformVersion)) {
      skippedStale.push({ missionId: env.id || 'unknown', version, reason: 'below_min_version' });
      continue;
    }

    const trajectory = extractTrajectory({
      envelope: env,
      checkpoints: item.checkpoints || [],
      tasks: item.tasks || [],
      usageRecords: item.usageRecords || [],
      telemetry: item.telemetry || [],
    });
    const scores = scoreTrajectory(trajectory);
    const enriched = { ...trajectory, scores };
    accepted.push(enriched);

    const groupKey = `${version}::${role}`;
    if (!byRoleAndVersion[groupKey]) {
      byRoleAndVersion[groupKey] = {
        platformVersion: version,
        role,
        count: 0,
        replanMissions: 0,
        failedMissions: 0,
        trajectories: [],
      };
    }
    const bucket = byRoleAndVersion[groupKey];
    bucket.count += 1;
    if (trajectory.replanCount > 0) bucket.replanMissions += 1;
    if (!trajectory.missionCompleted) bucket.failedMissions += 1;
    bucket.trajectories.push(enriched);
  }

  return {
    acceptedCount: accepted.length,
    skippedStaleCount: skippedStale.length,
    skippedStale,
    accepted,
    groups: Object.values(byRoleAndVersion),
  };
}

/**
 * Distill high-value failure or high-replan trajectories from harvested Loop B
 * missions into anonymized regression benchmark task definitions for Loop A.
 *
 * @param {object[]} trajectories  Array of extracted trajectories
 * @param {object} [opts]
 * @param {number} [opts.maxTasks]
 */
export function synthesizeBenchmarkCandidatesFromHarvest(trajectories = [], opts = {}) {
  const maxTasks = opts.maxTasks ?? 10;
  const interesting = trajectories.filter(
    (t) => !t.missionCompleted || (t.replanCount || 0) > 0 || (t.adversarialFailureCount || 0) > 0,
  );

  return interesting.slice(0, maxTasks).map((t, idx) => {
    const clauses = (t.checkpoints || []).map((cp) => cp.goal).filter(Boolean);
    return {
      id: `harvest-${t.role || 'agent'}-${idx + 1}-${String(t.missionId).slice(0, 8)}`,
      role: t.role || 'software-engineer',
      sourceMissionId: t.missionId,
      platformVersion: t.platformVersion,
      goal: clauses.length > 0 ? clauses.join(' -> ') : `Regression scenario from mission ${t.missionId}`,
      expectedClauses: clauses.length > 0 ? clauses : ['complete mission without replanning'],
      dominantReplanLens:
        (t.checkpoints || []).find((cp) => cp.replanLens)?.replanLens ||
        ((t.errorToolCalls || 0) > 0 ? 'INV' : 'DOM'),
      tier: 'tier1',
    };
  });
}
