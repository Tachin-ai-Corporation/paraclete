// agent/services/brain/settings.mjs: the brain's configuration. Maps config/contracts.json onto the
// parameters each library takes (the checkpoint executor, the cerebellum's verification, the archival
// sweep, compaction, sessions),
// takes the effort level from the admin settings (read by readAdminSettings in service-runtime.mjs),
// and scales an organ's sampling temperature by the effort setting. Pure. The libraries never read
// configuration; main.mjs calls these and passes the values down.

import { applyEffort, normalizeEffort } from '../../work/effort.mjs';

/**
 * The gateway's default sampling temperature for each organ (agent/gateway/organs.mjs ORGANS). The
 * brain reaches the gateway over HTTP and cannot import it, so the bases are mirrored here; a test
 * keeps the two equal. At the default effort the brain sends no temperature at all and the gateway's
 * own value stands.
 */
export const ORGAN_BASE_TEMPERATURE = Object.freeze({
  cortex: 0.4,
  prefrontal: 0.6,
  motor: 0.3,
  cerebellum: 0.1,
  'temporal-memory': 0.3,
  'temporal-research': 0.5,
});

/**
 * The temperature the brain sends for one organ turn at an effort level, or undefined at the default
 * level (medium), so the gateway's organ default applies.
 *
 * @param {string} organ
 * @param {string} effort - low, medium, high or max
 * @returns {number|undefined}
 */
export function organTemperature(organ, effort) {
  const level = normalizeEffort(effort);
  if (level === 'medium') return undefined;
  const base = ORGAN_BASE_TEMPERATURE[organ];
  return typeof base === 'number' ? applyEffort(base, level) : undefined;
}

/**
 * The effort level an admin chose: the settings' `effort`, else the contracts' default, either one
 * normalized to a known level (an unknown one is medium).
 *
 * @param {object|null} settings - the admin settings, from readAdminSettings() in service-runtime.mjs
 * @param {string} [defaultEffort='medium'] - contracts.effort.default
 * @returns {string} low, medium, high or max
 */
export function adminEffort(settings, defaultEffort = 'medium') {
  return normalizeEffort(typeof settings?.effort === 'string' ? settings.effort : defaultEffort);
}

/**
 * The cerebellum's verification budgets (VERIFY_DEFAULTS in agent/organs/cerebellum/verify.mjs), each
 * mapped from its contracts key.
 *
 * @param {object} c - the contracts
 * @returns {object}
 */
export function verifySettings(c) {
  return {
    ctxVerifyInput: c.brain.ctx_verify_input,
    ctxVerifyPrior: c.brain.ctx_verify_prior,
    verifyPromptMaxChars: c.brain.verify_prompt_max_chars,
    verifyFullEvidenceMaxChars: c.brain.verify_full_evidence_max_chars,
    attackStakesMin: c.brain.attack_duty_stakes_min,
  };
}

/**
 * The checkpoint executor's settings (EXECUTOR_DEFAULTS in agent/work/checkpoint-executor.mjs), each
 * mapped from its contracts key.
 *
 * @param {object} c - the contracts
 * @returns {object}
 */
export function executorSettings(c) {
  return {
    ctxAgentStep: c.utility.context_budgets.agent_step,
    ctxDispatchFailure: c.utility.context_budgets.dispatch_failure,
    checkpointDigestChars: c.compaction.checkpoint_digest_chars,
    packetSummaryChars: c.organ_context.packet_summary_chars,
    listSummaryTopK: c.organ_context.list_summary_top_k,
    toolAnswerMinProseChars: c.organ_context.tool_answer_min_prose_chars,
    resourceLedgerMax: c.memory.resource_ledger.max_entries,
    resourceLedgerRecallLimit: c.memory.resource_ledger.recall_limit,
    defaultBranch: c.git.default_branch,
    transitionGuard: c.brain.transition_guard,
  };
}

/**
 * The archival sweep's thresholds (DEFAULT_ARCHIVAL_CONFIG in agent/work/archival.mjs).
 *
 * @param {object} c - the contracts
 * @returns {object}
 */
export function archivalConfig(c) {
  return {
    staleCleanupHours: c.archival.stale_cleanup_hours,
    archiveAgeDays: c.archival.archive_age_days,
    needsInputTimeoutHours: c.archival.needs_input_timeout_hours,
    waitingTimeoutHours: c.archival.waiting_timeout_hours,
    activeTimeoutHours: c.archival.active_timeout_hours,
  };
}

/**
 * Everything else the brain reads from the contracts, in one object.
 *
 * @param {object} c - the contracts
 * @returns {object}
 */
export function brainSettings(c) {
  return {
    pollIntervalMs: c.brain.poll_interval_ms,
    maxIterations: c.brain.max_iterations,
    gatewayTimeoutMs: c.brain.gateway_timeout_ms,
    claimStaleMs: c.brain.claim_stale_ms,
    contextTokenBudget: c.brain.context_token_budget,
    resultPreviewChars: c.brain.result_preview_chars,
    contextSliceChars: c.brain.context_slice_chars,
    respondReads: [...(c.brain.respond_reads || [])],
    synthVerifyMinChars: c.brain.synth_verify_min_chars,
    attackStakesMin: c.brain.attack_duty_stakes_min,
    minDeliverableChars: c.brain.min_deliverable_chars,
    maxCriteriaRevisions: c.brain.max_criteria_revisions,
    transitionGuard: c.brain.transition_guard,
    wait: {
      minMinutes: c.brain.wait_min_minutes,
      maxMinutes: c.brain.wait_max_minutes,
      defaultMinutes: c.brain.wait_default_minutes,
    },
    effortDefault: c.effort.default,
    archivalIntervalMs: c.archival.interval_ms,
    hydrate: {
      maxChars: c.organ_context.hydrate_max_chars,
      maxRefs: c.organ_context.hydrate_max_refs_per_mission,
    },
    blackboardMaxChars: c.organ_context.blackboard_max_chars,
    resourceLedger: {
      max: c.memory.resource_ledger.max_entries,
      recallLimit: c.memory.resource_ledger.recall_limit,
    },
    workingMemoryHardCapChars: c.memory.working_memory_hard_cap_chars,
    compaction: { ...c.compaction },
    session: {
      enabled: c.session.enabled === true,
      breaker: c.session.miss_circuit_breaker,
    },
    conversation: { ...c.conversation },
    toolRecord: { ...c.tools.record },
    promotionAuto: c.projects.promotion_auto === true,
    executor: executorSettings(c),
    verify: verifySettings(c),
    archival: archivalConfig(c),
  };
}
