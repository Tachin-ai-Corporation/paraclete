// agent/services/gateway/settings.mjs: turns the contracts, the instance's paths and the admin's Claude
// switch into what agent/gateway/ is built from: the turn and server settings, the organ models, and
// the tool, memory and session limits. Pure: main.mjs reads the files and Firestore and passes the
// values in. The admin settings reader and the skill directories, which the brain shares, are in
// service-runtime.mjs. The settings keys are documented in agent/gateway/README.md.

import { basename } from 'node:path';

/**
 * The commands the memory organ may run when it consolidates: working memory, Core Memory and the
 * Deep Truths, nothing else. Installed as /opt/paraclete/bin/<name>.
 */
export const MEMORY_COMMANDS = Object.freeze([
  'core-memory-read', 'core-memory-write', 'core-memory-retire', 'session-summary', 'update-deep-truths',
]);

/**
 * Definitions memory reconciles against, and the subcommands that only read them. Memory may list
 * and get a playbook or a project, to see what the agent already has and to retire a memory that
 * merely restates one; it never writes, retires or adds context to one.
 */
export const MEMORY_READ_VIEWS = Object.freeze({
  'process-ops': Object.freeze(['list', 'get']),
  'project-manage': Object.freeze(['list', 'get', 'canon-list']),
});

/** The report a consolidation pass writes beside working memory: its verifiable record. */
export const CONSOLIDATION_REPORT = 'consolidation_report.md';

/**
 * Whether an admin turned Claude on. Only a stored `true` counts: Claude is billed and needs the
 * owner to have accepted Anthropic's terms, so anything else (no document, no field, a string) is off.
 *
 * @param {object|null} settings the admin settings, from readAdminSettings() in service-runtime.mjs ({}
 *   when there are none)
 * @returns {boolean}
 */
export function isClaudeEnabled(settings) {
  return settings?.claude_enabled === true;
}

/**
 * The organ models for createOrganRegistry(). With Claude on, the cortex and the strong tier move to
 * the contracts' Claude model and every organ falls back to `claude_fallback`; the temporal organs
 * stay on the fast model either way.
 *
 * @param {object} models the contracts' vertex.models
 * @param {{claudeEnabled?: boolean}} [o]
 * @returns {{cortex: string, strong: string, fast: string, fallback: string}}
 */
export function organModels(models, { claudeEnabled = false } = {}) {
  if (!claudeEnabled) {
    return { cortex: models.cortex, strong: models.strong, fast: models.fast, fallback: models.fallback };
  }
  return { cortex: models.claude, strong: models.claude, fast: models.fast, fallback: models.claude_fallback };
}

/**
 * The settings object createGatewayServer() takes: the turn settings plus `session` and
 * `maxBodyBytes`. The loop guard's error thresholds have no contract key and keep their defaults.
 *
 * @param {object} contracts the loaded contracts
 * @returns {object}
 */
export function gatewaySettings(contracts) {
  const v = contracts.vertex;
  const g = contracts.gateway;
  return {
    anthropic: {
      promptCaching: v.anthropic_prompt_caching,
      messageBreakpoints: v.anthropic_cache_message_breakpoints,
      sessionAffinity: v.anthropic_session_affinity,
      cacheTtlStable: v.anthropic_cache_ttl_stable,
      cacheTtlMission: v.anthropic_cache_ttl_mission,
    },
    gemini: {
      explicitCache: v.gemini_explicit_cache,
      explicitCacheTtlSeconds: v.gemini_explicit_cache_ttl_seconds,
    },
    toolRecord: contracts.tools.record,
    loopGuard: {
      identicalNudge: g.identical_result_nudge_threshold,
      identicalTerminate: g.identical_result_terminate_threshold,
      duplicateNudge: g.duplicate_nudge_threshold,
      duplicateTerminate: g.duplicate_terminate_threshold,
      semanticNudge: g.semantic_nudge_threshold,
      semanticTerminate: g.semantic_terminate_threshold,
    },
    retry: { maxRetries: g.retry_max, baseDelayMs: g.retry_base_delay_ms },
    session: { enabled: contracts.session.enabled, excludedOrgans: contracts.session.excluded_organs },
    maxBodyBytes: g.max_body_bytes,
  };
}

/**
 * The result and process limits for createToolRegistry().
 *
 * @param {object} tools the contracts' tools section
 * @returns {object}
 */
export function toolLimits(tools) {
  return {
    outputChars: tools.output_chars,
    outputHeadChars: tools.output_head_chars,
    outputTailChars: tools.output_tail_chars,
    timeoutMs: tools.timeout_ms,
    maxBufferBytes: tools.max_buffer_bytes,
    binaryGuard: tools.binary_guard !== false,
  };
}

/**
 * The limits for createSessionStore(). A stored user or tool message is capped at the brain's own
 * per-step context budget, so a session never replays more than the stateless path would send.
 *
 * @param {object} contracts the loaded contracts
 * @returns {{idleTtlMs: number, maxSessions: number, turnContentCap: number}}
 */
export function sessionLimits(contracts) {
  return {
    idleTtlMs: contracts.session.idle_ttl_minutes * 60_000,
    maxSessions: contracts.session.max_sessions,
    turnContentCap: contracts.utility.context_budgets.agent_step,
  };
}

/**
 * The memory organ's boundary for createToolRegistry(): where its files live, the only files it may
 * write, the commands it may run, and the size limits on working memory.
 *
 * @param {object} paths  the service runtime's paths
 * @param {object} memory the contracts' memory section
 * @returns {object}
 */
export function memoryPolicy(paths, memory) {
  const workingMemoryFile = basename(paths.data.workingMemoryFile);
  return {
    home: paths.data.memory,
    files: [workingMemoryFile, CONSOLIDATION_REPORT],
    workingMemoryFile,
    targetChars: memory.working_memory_target_chars,
    hardCapChars: memory.working_memory_hard_cap_chars,
    clis: [...MEMORY_COMMANDS],
    readViews: Object.fromEntries(Object.entries(MEMORY_READ_VIEWS).map(([name, reads]) => [name, [...reads]])),
  };
}
