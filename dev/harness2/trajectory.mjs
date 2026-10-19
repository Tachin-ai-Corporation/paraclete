// dev/harness2/trajectory.mjs: Rich multi-organ trajectory extraction and vector scoring for Paraclete-H².

/**
 * Default normalizing budgets for computing scalar Fitness(H) from a 3D score vector.
 */
export const DEFAULT_SCORE_BUDGETS = Object.freeze({
  tokenBudget: 120_000,
  latencyBudgetMs: 180_000,
  weights: Object.freeze({
    capability: 0.55,
    reliability: 0.30,
    efficiency: 0.15,
  }),
});

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sumTokens(usageRecords = []) {
  let promptTokens = 0;
  let candidateTokens = 0;
  let cachedTokens = 0;
  let totalTokens = 0;

  for (const u of usageRecords) {
    const p = Number(u?.promptTokenCount ?? u?.inputTokens ?? 0) || 0;
    const c = Number(u?.candidatesTokenCount ?? u?.outputTokens ?? 0) || 0;
    const cached = Number(u?.cachedContentTokenCount ?? u?.cachedTokens ?? 0) || 0;
    const tot = Number(u?.totalTokenCount ?? p + c) || p + c;
    promptTokens += p;
    candidateTokens += c;
    cachedTokens += cached;
    totalTokens += tot;
  }

  return { promptTokens, candidateTokens, cachedTokens, totalTokens };
}

/**
 * Extract a structured `ParacleteTrajectory` from Firestore mission/checkpoint/task
 * documents and optional gateway/brain telemetry events.
 *
 * @param {object} input
 * @param {object} input.envelope  Mission envelope from `missions/<id>`
 * @param {object[]} [input.checkpoints]  Subcollection docs from `missions/<id>/checkpoints`
 * @param {object[]} [input.tasks]  Subcollection docs from `missions/<id>/tasks`
 * @param {object[]} [input.usageRecords]  Optional token usage records across organ turns
 * @param {object[]} [input.telemetry]  Optional parsed telemetry events
 * @param {object} [input.evalCritique]  Optional external rubric evaluation `{ passed, rubricScore, failureReasons }`
 * @returns {object} ParacleteTrajectory
 */
export function extractTrajectory({
  envelope = {},
  checkpoints = [],
  tasks = [],
  usageRecords = [],
  telemetry = [],
  evalCritique = null,
} = {}) {
  const missionId = envelope.id || envelope.mission_id || 'unknown';
  const status = envelope.status || 'unknown';
  const spine = Array.isArray(envelope.checkpoint_spine) ? envelope.checkpoint_spine : [];

  const sortedCheckpoints = [...checkpoints].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const sortedTasks = [...tasks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let replanCount = 0;
  let firstAttemptVerifiedCount = 0;
  let verifiedCheckpointsCount = 0;
  let adversarialFailureCount = 0;
  let probeExecutionCount = 0;
  let evidenceFloorFailureCount = 0;
  let idRuleViolationCount = 0;

  const checkpointSummaries = spine.map((cp, idx) => {
    const cpN = cp.n ?? cp.index ?? idx + 1;
    const cpDoc = sortedCheckpoints.find((d) => (d.n ?? d.index) === cpN) || {};
    const replans = Number(cp.replan_count ?? cp.replan_attempts ?? cpDoc.replan_count ?? 0) || 0;
    replanCount += replans;

    const cpStatus = cp.status || cpDoc.status || 'pending';
    const verified =
      cpStatus === 'done' ||
      cpStatus === 'passed' ||
      cpStatus === 'completed' ||
      Boolean(cp.result_summary || cp.summary || cpDoc.result_summary);
    if (verified) {
      verifiedCheckpointsCount += 1;
      if (replans === 0) firstAttemptVerifiedCount += 1;
    }

    const verifyNote = String(cpDoc.verification_note || cp.verification_note || cpDoc.failure_note || '');
    if (/adversarial/i.test(verifyNote)) adversarialFailureCount += 1;
    if (/evidence floor|no tool evidence/i.test(verifyNote)) evidenceFloorFailureCount += 1;
    if (/unverified resource|id rule|invented id/i.test(verifyNote)) idRuleViolationCount += 1;

    return {
      index: idx,
      n: cpN,
      goal: cp.goal || cp.instruction || '',
      skill: cp.skill || null,
      status: cpStatus,
      replanCount: replans,
      replanLens: cp.replan_lens || cpDoc.replan_lens || null,
      resultSummary: cp.result_summary || cp.summary || cpDoc.result_summary || null,
      verificationNote: verifyNote || null,
    };
  });

  let totalToolCalls = 0;
  let errorToolCalls = 0;
  let shellCalls = 0;

  const taskSummaries = sortedTasks.map((t) => {
    const records = Array.isArray(t.tool_records) ? t.tool_records : [];
    totalToolCalls += records.length;
    for (const r of records) {
      if (r?.tool === 'shell') shellCalls += 1;
      if (r?.error || r?.isError || (typeof r?.exitCode === 'number' && r.exitCode !== 0)) {
        errorToolCalls += 1;
      }
      if (r?.probe) probeExecutionCount += 1;
    }
    const resultText = typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '');
    if (/\[ERROR\]|Command failed|timedOut/i.test(resultText) && records.length === 0) {
      errorToolCalls += 1;
      totalToolCalls += 1;
    }
    return {
      id: t.id || `task-${t.index ?? 0}`,
      checkpointN: t.checkpoint_n ?? t.checkpoint_index ?? null,
      goal: t.goal || t.instruction || '',
      status: t.status || 'unknown',
      toolCallCount: records.length,
    };
  });

  for (const ev of telemetry) {
    if (ev?.type === 'probe_executed') probeExecutionCount += 1;
    if (ev?.type === 'adversarial_failed') adversarialFailureCount += 1;
    if (ev?.type === 'evidence_floor_failed') evidenceFloorFailureCount += 1;
    if (ev?.type === 'id_rule_violation') idRuleViolationCount += 1;
  }

  const tokenStats = sumTokens(usageRecords);
  const createdMs = envelope.created_at ? Date.parse(envelope.created_at) : NaN;
  const updatedMs = envelope.updated_at ? Date.parse(envelope.updated_at) : NaN;
  const durationMs =
    Number.isFinite(createdMs) && Number.isFinite(updatedMs) && updatedMs >= createdMs
      ? updatedMs - createdMs
      : Number(envelope.duration_ms ?? 0) || 0;

  const missionCompleted = status === 'completed' || status === 'complete' || status === 'done';
  const rubricScore =
    evalCritique && typeof evalCritique.rubricScore === 'number'
      ? clamp01(evalCritique.rubricScore)
      : missionCompleted
        ? 1.0
        : spine.length > 0
          ? clamp01(verifiedCheckpointsCount / spine.length)
          : 0.0;

  return {
    missionId,
    role: envelope.role || null,
    platformVersion: envelope.platform_version || null,
    status,
    missionCompleted,
    durationMs,
    checkpointCount: spine.length,
    verifiedCheckpointsCount,
    firstAttemptVerifiedCount,
    replanCount,
    adversarialFailureCount,
    probeExecutionCount,
    evidenceFloorFailureCount,
    idRuleViolationCount,
    totalToolCalls,
    errorToolCalls,
    shellCalls,
    tokens: tokenStats,
    checkpoints: checkpointSummaries,
    tasks: taskSummaries,
    knownResources: Array.isArray(envelope.known_resources) ? envelope.known_resources : [],
    blackboard: envelope.blackboard || {},
    evalCritique: evalCritique || {
      passed: missionCompleted,
      rubricScore,
      failureReasons: missionCompleted ? [] : [envelope.failure_reason || `mission ended with status=${status}`],
    },
  };
}

/**
 * Score a single `ParacleteTrajectory` across capability, reliability, and efficiency,
 * returning both the 3D vector and scalar fitness.
 *
 * @param {object} trajectory  Output of `extractTrajectory()`
 * @param {object} [budgets]   Normalizing budgets and weights
 * @returns {{ capability: number, reliability: number, efficiency: number, fitness: number, metrics: object }}
 */
export function scoreTrajectory(trajectory, budgets = DEFAULT_SCORE_BUDGETS) {
  const tokenBudget = budgets.tokenBudget ?? DEFAULT_SCORE_BUDGETS.tokenBudget;
  const latencyBudgetMs = budgets.latencyBudgetMs ?? DEFAULT_SCORE_BUDGETS.latencyBudgetMs;
  const weights = budgets.weights ?? DEFAULT_SCORE_BUDGETS.weights;

  const cpCount = Math.max(1, Number(trajectory.checkpointCount) || 1);
  const cpCompletionRate = clamp01((Number(trajectory.verifiedCheckpointsCount) || 0) / cpCount);
  const rubricScore = clamp01(Number(trajectory.evalCritique?.rubricScore ?? (trajectory.missionCompleted ? 1 : 0)));
  const capability = clamp01(0.7 * rubricScore + 0.3 * cpCompletionRate);

  const firstAttemptPassRate =
    trajectory.checkpointCount > 0
      ? clamp01((Number(trajectory.firstAttemptVerifiedCount) || 0) / cpCount)
      : trajectory.missionCompleted
        ? 1.0
        : 0.0;

  const totalTools = Number(trajectory.totalToolCalls) || 0;
  const errorTools = Number(trajectory.errorToolCalls) || 0;
  const toolErrorFreeRate = totalTools > 0 ? clamp01(1 - errorTools / totalTools) : 1.0;

  const replanPenalty = clamp01(1 - 0.2 * (Number(trajectory.replanCount) || 0));
  const violationPenalty = clamp01(
    1 -
      0.25 * (Number(trajectory.evidenceFloorFailureCount) || 0) -
      0.25 * (Number(trajectory.idRuleViolationCount) || 0),
  );

  const reliability = clamp01(
    0.45 * firstAttemptPassRate +
      0.25 * toolErrorFreeRate +
      0.15 * replanPenalty +
      0.15 * violationPenalty,
  );

  const totalTokens = Number(trajectory.tokens?.totalTokens) || 0;
  const cachedTokens = Number(trajectory.tokens?.cachedTokens) || 0;
  const effectiveTokens = Math.max(0, totalTokens - 0.75 * cachedTokens);
  const tokenEfficiency = clamp01(1 - effectiveTokens / Math.max(1, tokenBudget));
  const latencyEfficiency = clamp01(1 - (Number(trajectory.durationMs) || 0) / Math.max(1, latencyBudgetMs));
  const efficiency = clamp01(0.65 * tokenEfficiency + 0.35 * latencyEfficiency);

  const fitness = clamp01(
    weights.capability * capability +
      weights.reliability * reliability +
      weights.efficiency * efficiency,
  );

  return {
    capability: Number(capability.toFixed(4)),
    reliability: Number(reliability.toFixed(4)),
    efficiency: Number(efficiency.toFixed(4)),
    fitness: Number(fitness.toFixed(4)),
    metrics: {
      cpCompletionRate: Number(cpCompletionRate.toFixed(4)),
      firstAttemptPassRate: Number(firstAttemptPassRate.toFixed(4)),
      toolErrorFreeRate: Number(toolErrorFreeRate.toFixed(4)),
      effectiveTokens: Math.round(effectiveTokens),
      durationMs: Number(trajectory.durationMs) || 0,
      replanCount: Number(trajectory.replanCount) || 0,
    },
  };
}

/**
 * Aggregate a batch of scored trajectories into a summary score vector.
 *
 * @param {object[]} trajectories
 * @param {object} [budgets]
 */
export function aggregateTrajectoryScores(trajectories = [], budgets = DEFAULT_SCORE_BUDGETS) {
  if (!Array.isArray(trajectories) || trajectories.length === 0) {
    return {
      count: 0,
      capability: 0,
      reliability: 0,
      efficiency: 0,
      fitness: 0,
      perTrajectory: [],
    };
  }

  const perTrajectory = trajectories.map((t) => ({
    missionId: t.missionId,
    role: t.role,
    ...scoreTrajectory(t, budgets),
  }));

  const mean = (key) =>
    Number((perTrajectory.reduce((acc, item) => acc + item[key], 0) / perTrajectory.length).toFixed(4));

  return {
    count: perTrajectory.length,
    capability: mean('capability'),
    reliability: mean('reliability'),
    efficiency: mean('efficiency'),
    fitness: mean('fitness'),
    perTrajectory,
  };
}
