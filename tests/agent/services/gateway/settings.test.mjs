// Tests for agent/services/gateway/settings.mjs: every contract key lands on the gateway setting the
// README names (so none silently falls back to its default), the Claude switch moves exactly the cortex
// and the strong tier, and the memory boundary is the closed set the memory organ may touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadContracts } from '../../../../config/contracts.mjs';
import { resolveSettings } from '../../../../agent/gateway/turn-loop.mjs';
import { checkMemoryCommand } from '../../../../agent/gateway/tools.mjs';
import {
  isClaudeEnabled, organModels, gatewaySettings, toolLimits, sessionLimits, memoryPolicy, MEMORY_COMMANDS,
} from '../../../../agent/services/gateway/settings.mjs';

const contracts = loadContracts();

function pathsFor(role) {
  const installRoot = '/opt/paraclete';
  return {
    installRoot,
    prompts: join(installRoot, 'prompts'),
    skills: join(installRoot, 'skills'),
    roles: join(installRoot, 'roles'),
    genericRole: join(installRoot, 'roles', 'generic'),
    role: join(installRoot, 'roles', role),
    data: {
      root: '/var/lib/paraclete',
      memory: join('/var/lib/paraclete', 'memory'),
      workingMemoryFile: join('/var/lib/paraclete', 'memory', 'MEMORY.md'),
      workspace: join('/var/lib/paraclete', 'workspace'),
      skills: join('/var/lib/paraclete', 'skills'),
    },
  };
}

test('the contracts map onto every gateway setting, and the turn loop keeps each value', () => {
  const s = gatewaySettings(contracts);
  const v = contracts.vertex;
  const g = contracts.gateway;
  const resolved = resolveSettings(s);
  assert.deepEqual(resolved.anthropic, {
    promptCaching: v.anthropic_prompt_caching,
    messageBreakpoints: v.anthropic_cache_message_breakpoints,
    sessionAffinity: v.anthropic_session_affinity,
    cacheTtlStable: v.anthropic_cache_ttl_stable,
    cacheTtlMission: v.anthropic_cache_ttl_mission,
  });
  assert.deepEqual(resolved.gemini, { explicitCache: v.gemini_explicit_cache, explicitCacheTtlSeconds: v.gemini_explicit_cache_ttl_seconds });
  assert.deepEqual(resolved.retry, { maxRetries: g.retry_max, baseDelayMs: g.retry_base_delay_ms });
  assert.equal(resolved.loopGuard.identicalNudge, g.identical_result_nudge_threshold);
  assert.equal(resolved.loopGuard.identicalTerminate, g.identical_result_terminate_threshold);
  assert.equal(resolved.loopGuard.duplicateNudge, g.duplicate_nudge_threshold);
  assert.equal(resolved.loopGuard.duplicateTerminate, g.duplicate_terminate_threshold);
  assert.equal(resolved.loopGuard.semanticNudge, g.semantic_nudge_threshold);
  assert.equal(resolved.loopGuard.semanticTerminate, g.semantic_terminate_threshold);
  assert.equal(resolved.loopGuard.synthesize, true);
  for (const key of ['verbatim_chars', 'digest_target_chars', 'digest_max_chars', 'store_ttl_days', 'arg_chars', 'terminal_arg_chars']) {
    assert.equal(resolved.toolRecord[key], contracts.tools.record[key], key);
  }
  assert.deepEqual(resolved.images, { kept: contracts.tools.images_kept, geminiPlacement: contracts.vertex.gemini_tool_image_placement });
  assert.deepEqual(s.session, { enabled: contracts.session.enabled, excludedOrgans: contracts.session.excluded_organs });
  assert.equal(s.maxBodyBytes, g.max_body_bytes);
});

test('Claude is on only when the admin setting is exactly true', () => {
  assert.equal(isClaudeEnabled({ claude_enabled: true }), true);
  for (const off of [null, undefined, {}, { claude_enabled: false }, { claude_enabled: 'true' }, { claude_enabled: 1 }]) {
    assert.equal(isClaudeEnabled(off), false, JSON.stringify(off));
  }
});

test('the Claude switch moves the cortex and the strong tier to Claude and the fallback to claude_fallback', () => {
  const m = contracts.vertex.models;
  assert.deepEqual(organModels(m, { claudeEnabled: false }), { cortex: m.cortex, strong: m.strong, fast: m.fast, fallback: m.fallback });
  assert.deepEqual(organModels(m), organModels(m, { claudeEnabled: false }));
  assert.deepEqual(organModels(m, { claudeEnabled: true }), { cortex: m.claude, strong: m.claude, fast: m.fast, fallback: m.claude_fallback });
  assert.match(organModels(m, { claudeEnabled: true }).fallback, /^vertex-google\//, 'Gemini stays the fallback');
});

test('tool and session limits come from the contracts', () => {
  assert.deepEqual(toolLimits(contracts.tools), {
    outputChars: contracts.tools.output_chars,
    outputHeadChars: contracts.tools.output_head_chars,
    outputTailChars: contracts.tools.output_tail_chars,
    timeoutMs: contracts.tools.timeout_ms,
    maxBufferBytes: contracts.tools.max_buffer_bytes,
    binaryGuard: true,
    imageMaxBytes: contracts.tools.image_max_bytes,
    imageMaxSide: contracts.tools.image_max_side,
  });
  assert.equal(toolLimits({ ...contracts.tools, binary_guard: false }).binaryGuard, false);
  assert.deepEqual(sessionLimits(contracts), {
    idleTtlMs: contracts.session.idle_ttl_minutes * 60_000,
    maxSessions: contracts.session.max_sessions,
    turnContentCap: contracts.utility.context_budgets.agent_step,
  });
});

test('the memory boundary: its own two files, the memory commands, and read-only definition views', () => {
  const policy = memoryPolicy(pathsFor('generic'), contracts.memory);
  assert.equal(policy.home.replace(/\\/g, '/'), '/var/lib/paraclete/memory');
  assert.deepEqual(policy.files, ['MEMORY.md', 'consolidation_report.md']);
  assert.equal(policy.workingMemoryFile, 'MEMORY.md');
  assert.equal(policy.targetChars, contracts.memory.working_memory_target_chars);
  assert.equal(policy.hardCapChars, contracts.memory.working_memory_hard_cap_chars);
  assert.deepEqual(policy.clis, [...MEMORY_COMMANDS]);

  const check = (line) => checkMemoryCommand(line.split(' '), { binDir: '/opt/paraclete/bin', ...policy });
  for (const ok of ['core-memory-write --stdin', 'update-deep-truths --stdin', 'process-ops list', 'project-manage get p-1']) {
    assert.equal(check(ok).ok, true, ok);
  }
  for (const refused of ['process-ops write p', 'project-manage add-context p', 'project-manage team-list', 'project-manage get-artifacts-root', 'responsibility-manage list', 'git-store push']) {
    assert.equal(check(refused).ok, false, refused);
  }
});
