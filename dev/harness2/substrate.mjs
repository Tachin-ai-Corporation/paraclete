// dev/harness2/substrate.mjs: Two-Tier Evaluation Substrate (Tier-1 hermetic fakes + Tier-2 live GCP canary) for Loop A.

import { start as startFirestoreFake } from '../../tests/fakes/firestore-server.mjs';
import { start as startGcsFake } from '../../tests/fakes/gcs-server.mjs';
import { loadPersistedBenchmarkTasks } from './harvest.mjs';
import { extractTrajectory, scoreTrajectory, aggregateTrajectoryScores } from './trajectory.mjs';

/**
 * Default benchmark task catalog organized by stage and role.
 * Stage 1 targets builder roles (`software-engineer`, `qa-engineer`, `devops-engineer`);
 * Stage 2 expands to specialist domain roles.
 */
export const BENCHMARK_TASK_SUITES = Object.freeze({
  stage1: Object.freeze([
    {
      id: 'h2-01-lens-diagnosis',
      role: 'paraclete-h2',
      goal: 'Diagnose execution trajectories across the INV and DOM lenses, isolate a single-lens mutation in a candidate worktree, and validate immutable spine boundaries.',
      expectedClauses: ['diagnose lens bottleneck', 'isolate single-lens mutation', 'validate spine boundaries'],
      tier: 'tier1',
    },
    {
      id: 'h2-02-pareto-promotion',
      role: 'paraclete-h2',
      goal: 'Evaluate a candidate harness across Stage 1 benchmark tasks, verify zero capability regressions and Pareto dominance, and emit a promotion readiness report.',
      expectedClauses: ['evaluate benchmark suite', 'verify pareto dominance', 'emit promotion report'],
      tier: 'tier1',
    },
    {
      id: 'se-01-checkpoint-fix',
      role: 'software-engineer',
      goal: 'Diagnose a failing unit test in a Node.js ESM module, apply a minimal pure-function fix, and verify `node --test` passes with read-back evidence.',
      expectedClauses: ['diagnose failing test', 'apply minimal fix', 'verify test passes'],
      tier: 'tier1',
    },
    {
      id: 'se-02-contract-boundary',
      role: 'software-engineer',
      goal: 'Inspect module import boundaries, refactor a helper to accept injectable dependencies, and confirm repo boundary tests pass.',
      expectedClauses: ['inspect boundaries', 'refactor injectable deps', 'confirm tests pass'],
      tier: 'tier1',
    },
    {
      id: 'qa-01-adversarial-repro',
      role: 'qa-engineer',
      goal: 'Write a deterministic reproduction test for an edge-case bug, verify it fails before the fix and passes after the fix, and record exact test output.',
      expectedClauses: ['write reproduction test', 'verify failure and pass', 'record output'],
      tier: 'tier1',
    },
    {
      id: 'devops-01-canary-health',
      role: 'devops-engineer',
      goal: 'Inspect systemd unit status, gateway health endpoint, and release pointer integrity, then produce a grounded diagnostic summary.',
      expectedClauses: ['inspect unit status', 'check gateway health', 'verify release pointer'],
      tier: 'tier1',
    },
  ]),
  stage2: Object.freeze([
    {
      id: 'gen-01-grounded-synthesis',
      role: 'generic',
      goal: 'Synthesize a two-source technical comparison, verify every cited claim against primary outputs, and deliver a concise summary.',
      expectedClauses: ['gather primary sources', 'verify cited claims', 'deliver concise summary'],
      tier: 'tier1',
    },
    {
      id: 'da-01-cohort-variance',
      role: 'data-analyst',
      goal: 'Analyze dataset anomalies, cross-check aggregates before reporting, and produce a cited variance breakdown.',
      expectedClauses: ['analyze anomalies', 'cross-check aggregates', 'cited breakdown'],
      tier: 'tier1',
    },
    {
      id: 'de-01-pipeline-schema-audit',
      role: 'data-engineer',
      goal: 'Inspect BigQuery dataset schemas and partition settings, validate ingestion row counts, and report schema drift without mutating tables.',
      expectedClauses: ['inspect dataset schemas', 'validate row counts', 'report schema drift'],
      tier: 'tier1',
    },
    {
      id: 'sec-01-iam-least-privilege',
      role: 'security-engineer',
      goal: 'Audit project IAM bindings and service account keys, identify over-privileged principals, and produce a least-privilege remediation plan.',
      expectedClauses: ['audit iam bindings', 'identify over-privileged principals', 'produce remediation plan'],
      tier: 'tier1',
    },
    {
      id: 'web-01-endpoint-vitals',
      role: 'web-master',
      goal: 'Probe HTTP status, TLS certificate expiry, and response headers across target endpoints, then compile a grounded site health report.',
      expectedClauses: ['probe http status', 'check tls expiry', 'compile health report'],
      tier: 'tier1',
    },
    {
      id: 'exec-01-triage-brief',
      role: 'executive-assistant',
      goal: 'Triage incoming threads, verify calendar constraints, and draft a concise decision brief with zero fabricated IDs.',
      expectedClauses: ['triage threads', 'verify constraints', 'draft decision brief'],
      tier: 'tier1',
    },
    {
      id: 'pm-01-milestone-audit',
      role: 'project-manager',
      goal: 'Audit milestone blockers across active workstreams, reconcile status discrepancies, and publish an updated risk register.',
      expectedClauses: ['audit blockers', 'reconcile status', 'publish risk register'],
      tier: 'tier1',
    },
    {
      id: 'fin-01-budget-variance',
      role: 'finance-analyst',
      goal: 'Reconcile line-item spend against quarterly budget tables, verify totals arithmetic, and flag variance drivers with exact figures.',
      expectedClauses: ['reconcile line-item spend', 'verify totals arithmetic', 'flag variance drivers'],
      tier: 'tier1',
    },
    {
      id: 'leg-01-clause-redline',
      role: 'legal-advisor',
      goal: 'Review vendor agreement clauses against standard liability and data-processing policies, cite non-compliant sections, and draft redline guidance.',
      expectedClauses: ['review agreement clauses', 'cite non-compliant sections', 'draft redline guidance'],
      tier: 'tier1',
    },
    {
      id: 'des-01-layout-hierarchy-audit',
      role: 'designer',
      goal: 'Audit component spacing, typography hierarchy, and contrast ratios against design tokens, and produce actionable layout fixes.',
      expectedClauses: ['audit spacing and typography', 'check contrast ratios', 'produce layout fixes'],
      tier: 'tier1',
    },
  ]),
});

/**
 * Select benchmark tasks for a given stage, optional role filter, and optional
 * persisted Loop B harvested benchmark suite.
 *
 * @param {object} [opts]
 * @param {'stage1' | 'stage2'} [opts.stage]
 * @param {string} [opts.role]
 * @param {boolean} [opts.includeHarvested]
 * @param {string} [opts.suitePath]
 * @returns {object[]}
 */
export function selectBenchmarkTasks(opts = {}) {
  const stage = opts.stage || 'stage1';
  const pool =
    stage === 'stage2'
      ? [...BENCHMARK_TASK_SUITES.stage1, ...BENCHMARK_TASK_SUITES.stage2]
      : [...BENCHMARK_TASK_SUITES.stage1];

  if (opts.includeHarvested || opts.suitePath) {
    const existingIds = new Set(pool.map((t) => t.id));
    const harvested = loadPersistedBenchmarkTasks({
      suitePath: opts.suitePath,
      role: opts.role,
    });
    for (const h of harvested) {
      if (h?.id && !existingIds.has(h.id)) {
        pool.push(h);
        existingIds.add(h.id);
      }
    }
  }

  if (opts.role) {
    return pool.filter((t) => t.role === opts.role);
  }
  return pool;
}

/**
 * Boot a Tier-1 hermetic fake environment (`firestore-server` + `gcs-server`)
 * for fast inner-loop candidate evaluation without cloud side effects.
 *
 * @param {object} [deps]
 * @returns {Promise<{ firestoreUrl: string, gcsUrl: string, firestore: object, gcs: object, close: () => Promise<void> }>}
 */
export async function startTier1Substrate(deps = {}) {
  const startFs = deps.startFirestoreFake || startFirestoreFake;
  const startGcs = deps.startGcsFake || startGcsFake;

  const firestore = await startFs();
  const gcs = await startGcs();

  return {
    firestoreUrl: firestore.url || firestore.origin,
    gcsUrl: gcs.url || gcs.origin,
    firestore,
    gcs,
    async close() {
      const stopFs = firestore.stop || firestore.close;
      const stopGcs = gcs.stop || gcs.close;
      await Promise.allSettled([
        typeof stopFs === 'function' ? stopFs.call(firestore) : Promise.resolve(),
        typeof stopGcs === 'function' ? stopGcs.call(gcs) : Promise.resolve(),
      ]);
    },
  };
}

/**
 * How a rollout that throws is treated. A network failure (the metadata server, a model endpoint, a
 * local fake) is no fault of the side, so the rollout runs again, up to `attempts` times in all, after
 * `backoffMs` times the attempt; one that still fails is not evaluated, and left out of the run's
 * results rather than ending the run, as one such error once ended a baseline 3.4 hours in. A run with
 * more than `maxNotEvaluatedShare` of its rollouts not evaluated is incomplete, and measures nothing.
 * Any other error is most likely the side's own code failing, so it is a failed run: capability 0, and
 * one failed check, `the rollout ran`, that says what threw.
 */
export const ROLLOUT_RETRY = Object.freeze({ attempts: 3, backoffMs: 5000, maxNotEvaluatedShare: 0.25 });

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED',
]);
const NETWORK_MESSAGE = /\b(fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/;

/**
 * Whether a rollout's error is a failure of what the rollout runs on, not of the side: a network error
 * (by its code or message, or its cause's), or a git command that failed while a side was being made.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isInfrastructureError(err) {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause, depth += 1) {
    if (NETWORK_CODES.has(e.code)) return true;
    const message = String(e.message || '');
    if (NETWORK_MESSAGE.test(message) || /^Command failed: git /.test(message)) return true;
  }
  return false;
}

/** The result of a rollout that threw for a reason of the side's own: it ran, and passed nothing. */
function failedRollout(err, measured) {
  const detail = String(err?.message || err).slice(0, 240);
  return {
    measured,
    scripted: false,
    error: detail,
    checkScore: 0,
    fixtureVerification: { ok: false, summary: `the rollout failed: ${detail}`, checks: [{ name: 'the rollout ran', ok: false, detail }] },
  };
}

/**
 * One rollout, run again on an infrastructure error. Returns `{ rollout }` or `{ notEvaluated }`; a
 * run that reached its spend cap (SpendCapReached, model-runs.mjs) still stops the whole run.
 */
async function attemptRollout(run, { task, trial, retry, failedRunsMeasured, sleep, log }) {
  const label = `${task.id} (trial ${trial})`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { rollout: await run() };
    } catch (err) {
      if (err?.name === 'SpendCapReached') throw err;
      const message = String(err?.message || err);
      if (!isInfrastructureError(err)) {
        log(`[WARN] ${label} failed: ${message}; it counts as a failed run`);
        return { rollout: failedRollout(err, failedRunsMeasured) };
      }
      if (attempt >= retry.attempts) {
        log(`[WARN] ${label} failed ${attempt} time(s) on infrastructure (${message}); it is not evaluated`);
        return { notEvaluated: { taskId: task.id, trial, attempts: attempt, reason: message.slice(0, 300) } };
      }
      log(`[WARN] ${label} failed on infrastructure (${message}); running it again (attempt ${attempt + 1} of ${retry.attempts})`);
      await sleep(retry.backoffMs * attempt);
    }
  }
}

/**
 * Evaluate a candidate harness on Tier-1 hermetic benchmark tasks.
 * Accepts an injectable `runTaskRollout(task, ctx)` executor so tests can run
 * deterministically and live runs can wire the local gateway + brain loop. A rollout that throws is
 * run again or counted as ROLLOUT_RETRY says; the result lists the runs not evaluated, and says the
 * run is `incomplete` when too many were.
 *
 * @param {object} opts
 * @param {object[]} [opts.tasks]
 * @param {'stage1' | 'stage2'} [opts.stage]
 * @param {string} [opts.role]
 * @param {(task: object, ctx: object) => Promise<object>} [opts.runTaskRollout]
 * @param {number} [opts.trials]  How many times each task runs (default 1)
 * @param {boolean} [opts.failedRunsMeasured]  a real-model run: a rollout that fails counts as measured
 * @param {object} [opts.retry]   ROLLOUT_RETRY, or others
 * @param {Function} [opts.sleep] (ms) => Promise; a fake in tests
 * @param {Function} [opts.log]   (line) => void; default the deps' stderr
 * @param {object} [opts.deps]
 */
export async function runTier1Evaluation(opts = {}) {
  const tasks = opts.tasks || selectBenchmarkTasks({ stage: opts.stage, role: opts.role });
  const trials = Math.max(1, Math.floor(Number(opts.trials) || 1));
  const synthetic = typeof opts.runTaskRollout !== 'function';
  const retry = { ...ROLLOUT_RETRY, ...(opts.retry || {}) };
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = opts.log || ((line) => (opts.deps?.stderr || process.stderr).write(`${line}\n`));
  const substrate = await startTier1Substrate(opts.deps);

  try {
    const trajectories = [];
    const notEvaluated = [];
    const runs = Array.from({ length: trials }, (_, i) => tasks.map((task) => ({ task, trial: i + 1 }))).flat();
    for (const { task, trial } of runs) {
      let rollout;
      if (typeof opts.runTaskRollout === 'function') {
        const outcome = await attemptRollout(() => opts.runTaskRollout(task, {
          firestoreUrl: substrate.firestoreUrl,
          gcsUrl: substrate.gcsUrl,
          firestore: substrate.firestore,
          gcs: substrate.gcs,
        }), { task, trial, retry, failedRunsMeasured: Boolean(opts.failedRunsMeasured), sleep, log });
        if (outcome.notEvaluated) {
          notEvaluated.push(outcome.notEvaluated);
          continue;
        }
        rollout = outcome.rollout;
      } else {
        // Default dry-run synthetic rollout when no live LLM executor is supplied.
        rollout = {
          envelope: {
            id: `dryrun-${task.id}`,
            role: task.role,
            status: 'completed',
            duration_ms: 1200,
            checkpoint_spine: task.expectedClauses.map((clause, i) => ({
              n: i + 1,
              goal: clause,
              status: 'done',
              replan_count: 0,
              result_summary: `Verified: ${clause}`,
            })),
          },
          checkpoints: [],
          tasks: task.expectedClauses.map((clause, i) => ({
            id: `task-${i + 1}`,
            index: i,
            checkpoint_n: i + 1,
            goal: clause,
            status: 'completed',
            tool_records: [{ tool: 'shell', exitCode: 0 }],
          })),
          usageRecords: [{ promptTokenCount: 1500, candidatesTokenCount: 400, cachedContentTokenCount: 800 }],
        };
      }

      // Each run is tagged with its task and trial, whether it was the synthetic dry run (which always
      // completes), whether a scripted gateway answered for the organs (the same answers for any
      // harness), and whether a real model answered from the side's own files (`measured`, the only
      // runs that measure a candidate). Promotion evidence (evidence.mjs) groups by task and trial and
      // refuses the others. A model-suite task's split and check score come along too, and its checks
      // (each one's name and whether it passed, with a short detail of a failed one), which a loop
      // baseline (dev/loop/baseline.mjs) reads.
      const trajectory = {
        ...extractTrajectory(rollout),
        taskId: task.id,
        trial,
        synthetic,
        scripted: Boolean(rollout?.scripted),
        measured: Boolean(rollout?.measured),
        ...(task.split ? { split: task.split } : {}),
        ...(typeof rollout?.checkScore === 'number' ? { checkScore: rollout.checkScore } : {}),
        ...(typeof rollout?.checkScore === 'number' && Array.isArray(rollout?.fixtureVerification?.checks)
          ? {
              checks: rollout.fixtureVerification.checks.map((c) => ({
                name: String(c.name),
                ok: Boolean(c.ok),
                ...(!c.ok && c.detail ? { detail: String(c.detail).slice(0, 300) } : {}),
              })),
            }
          : {}),
      };
      trajectories.push(trajectory);
    }

    // With held-out tasks, the summary that steers selection is the training tasks' alone; the
    // held-out ones are scored apart and reach only the promotion evidence.
    const holdout = trajectories.filter((t) => t.split === 'holdout');
    const train = trajectories.filter((t) => t.split !== 'holdout');
    const summary = aggregateTrajectoryScores(holdout.length && train.length ? train : trajectories, opts.budgets);
    const share = runs.length ? notEvaluated.length / runs.length : 0;
    return {
      tier: 'tier1',
      trials,
      trajectories,
      notEvaluated,
      ...(share > retry.maxNotEvaluatedShare
        ? { incomplete: `${notEvaluated.length} of ${runs.length} runs failed on infrastructure and were not evaluated (more than ${Math.round(retry.maxNotEvaluatedShare * 100)}%): ${notEvaluated[0].reason}` }
        : {}),
      summary,
      ...(holdout.length ? { holdoutSummary: aggregateTrajectoryScores(holdout, opts.budgets) } : {}),
    };
  } finally {
    await substrate.close();
  }
}

/**
 * Evaluate a top Pareto candidate on a Tier-2 live GCP canary instance.
 * Uses an injectable `canaryRunner` (which wraps `dev/deploy.mjs`, `dev/say.mjs`,
 * and `dev/smoke.mjs` in live GCP runs) and checks that the candidate passes
 * smoke checks and does not regress on capability or reliability.
 *
 * @param {object} opts
 * @param {string} opts.canaryAgent  Name of the canary VM (e.g. `canary-se-01`)
 * @param {object[]} [opts.tasks]
 * @param {(args: { canaryAgent: string, tasks: object[] }) => Promise<{ smokePassed: boolean, rollouts: object[] }>} opts.canaryRunner
 * @param {object} [opts.budgets]
 */
export async function runTier2CanaryEvaluation(opts = {}) {
  const canaryAgent = opts.canaryAgent || 'canary-se-01';
  const tasks = opts.tasks || selectBenchmarkTasks({ stage: 'stage1' }).slice(0, 2);

  if (typeof opts.canaryRunner !== 'function') {
    throw new Error('runTier2CanaryEvaluation requires an explicit canaryRunner function');
  }

  const { smokePassed, rollouts = [] } = await opts.canaryRunner({ canaryAgent, tasks });
  const trajectories = rollouts.map((r) => extractTrajectory(r));
  const summary = aggregateTrajectoryScores(trajectories, opts.budgets);

  return {
    tier: 'tier2',
    canaryAgent,
    smokePassed: Boolean(smokePassed),
    trajectories,
    summary,
  };
}
