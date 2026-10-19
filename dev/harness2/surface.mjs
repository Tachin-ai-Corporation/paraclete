// dev/harness2/surface.mjs: the evolvable surface of the Paraclete harness (c1..c8), the Stage 1
// builder roles (software-engineer, qa-engineer, devops-engineer) and Stage 2 role catalog, and the
// immutable spine boundaries that no harness candidate may cross. Pure: no I/O except optional role
// directory discovery when a caller asks for the installed roles on disk.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The six brain organs whose prompts and budgets the harness governs. */
export const ORGANS_ALLOWLIST = Object.freeze([
  'cortex',
  'prefrontal',
  'motor',
  'cerebellum',
  'temporal-memory',
  'temporal-research',
]);

/** Base prompt files allowed in `prompts/`. */
export const BASE_PROMPT_FILES = Object.freeze([
  ...ORGANS_ALLOWLIST.map((o) => `${o}.md`),
  'identity.md',
]);

/**
 * Stage 1 Builder Roles: led by `paraclete-h2` (the unified self-improving harness engineer role)
 * alongside the builder trio (`software-engineer`, `qa-engineer`, `devops-engineer`).
 */
export const STAGE1_BUILDER_ROLES = Object.freeze([
  'paraclete-h2',
  'software-engineer',
  'qa-engineer',
  'devops-engineer',
]);

/** Default full role catalog across Stage 1 and Stage 2. */
export const DEFAULT_ROLES = Object.freeze([
  'generic',
  'paraclete-h2',
  'chief-of-staff',
  'customer-ops',
  'data-analyst',
  'data-engineer',
  'designer',
  'devops-engineer',
  'executive-assistant',
  'finance-analyst',
  'finance-ops',
  'it-admin',
  'legal-advisor',
  'marketing-ops',
  'project-manager',
  'qa-engineer',
  'research-analyst',
  'sales-ops',
  'security-engineer',
  'software-engineer',
  'web-master',
]);

/**
 * Assembled organ prompt character budget: keeps the stable prefix compact so cache breakpoints and
 * reasoning token headroom stay healthy.
 */
export const ORGAN_PROMPT_MAX_CHARS = 32000;

/**
 * Hard ceilings from `config/contracts.json` that no candidate mutation may violate.
 */
export const CONTRACTS_HARD_CEILINGS = Object.freeze({
  'brain.context_token_budget': Object.freeze({ min: 10000, max: 125000 }),
  'brain.max_criteria_revisions': Object.freeze({ min: 0, max: 3 }),
  'organs.max_steps': Object.freeze({ min: 5, max: 60 }),
  'compaction.working_budget_tokens': Object.freeze({ min: 5000, max: 125000 }),
  'gateway.duplicate_terminate_threshold': Object.freeze({ min: 2, max: 20 }),
});

/**
 * Dot-paths in `config/contracts.json` that a harness candidate may tune within hard ceilings.
 */
export const CONTRACTS_TUNABLE_PATHS = Object.freeze([
  'vertex.gemini_explicit_cache',
  'gateway.duplicate_nudge_threshold',
  'gateway.duplicate_terminate_threshold',
  'gateway.identical_result_nudge_threshold',
  'gateway.identical_result_terminate_threshold',
  'gateway.semantic_nudge_threshold',
  'gateway.semantic_terminate_threshold',
  'organs.max_steps',
  'tools.output_chars',
  'tools.output_head_chars',
  'tools.output_tail_chars',
  'tools.record.verbatim_chars',
  'tools.record.digest_target_chars',
  'tools.record.digest_max_chars',
  'brain.context_token_budget',
  'brain.result_preview_chars',
  'brain.context_slice_chars',
  'brain.ctx_verify_input',
  'brain.ctx_verify_prior',
  'brain.verify_prompt_max_chars',
  'brain.verify_full_evidence_max_chars',
  'brain.synth_verify_min_chars',
  'brain.attack_duty_stakes_min',
  'brain.max_criteria_revisions',
  'compaction.checkpoint_digest_chars',
  'compaction.trigger_pct',
  'compaction.working_budget_tokens',
  'compaction.min_compactable_tokens',
  'compaction.keep_recent_iterations',
  'compaction.max_compactions_per_mission',
  'compaction.digest_max_chars',
  'compaction.learnings_max_entries',
  'organ_context.packet_summary_chars',
  'organ_context.list_summary_top_k',
  'organ_context.tool_answer_min_prose_chars',
  'organ_context.hydrate_max_chars',
  'organ_context.hydrate_max_refs_per_mission',
  'organ_context.blackboard_max_chars',
  'memory.working_memory_target_chars',
  'memory.working_memory_hard_cap_chars',
  'memory.resource_ledger.max_entries',
  'memory.resource_ledger.recall_limit',
]);

/**
 * Immutable spine prefixes: deterministic safety and state-machine modules that a harness candidate
 * is forbidden to modify.
 */
export const IMMUTABLE_SPINE_PREFIXES = Object.freeze([
  'agent/work/work-transitions.mjs',
  'agent/work/checkpoint-spine.mjs',
  'agent/work/step-ledger.mjs',
  'agent/work/memory-scope.mjs',
  'agent/work/approvals.mjs',
  'agent/work/platform-version.mjs',
  'agent/gateway/tools.mjs',
  'agent/gateway/loop-guard.mjs',
  'agent/release/',
  'agent/auth/',
  'install/',
  'dashboard/',
  '.github/',
]);

/**
 * The 8 evolvable component families (`c1..c8`) of the Paraclete harness surface.
 */
export const PARACLETE_SURFACE = Object.freeze({
  c1_contracts: Object.freeze({
    id: 'c1_contracts',
    name: 'contracts-tunables',
    description: 'Bounded numerical and threshold parameters in config/contracts.json',
    patterns: ['config/contracts.json'],
  }),
  c2_base_prompts: Object.freeze({
    id: 'c2_base_prompts',
    name: 'organ-prompts',
    description: 'Base organ system prompts and identity in prompts/*.md',
    patterns: ['prompts/<organ>.md', 'prompts/identity.md'],
  }),
  c3_cerebellum_verifier: Object.freeze({
    id: 'c3_cerebellum_verifier',
    name: 'cerebellum-verifier',
    description: 'Verification rules and adversarial challenge rubric in prompts/cerebellum.md',
    patterns: ['prompts/cerebellum.md'],
  }),
  c4_memory_consolidation: Object.freeze({
    id: 'c4_memory_consolidation',
    name: 'memory-consolidation',
    description: 'Temporal memory prompt and consolidation skill in prompts/temporal-memory.md and skills/memory-consolidate/',
    patterns: ['prompts/temporal-memory.md', 'skills/memory-consolidate/**'],
  }),
  c5_role_overlays: Object.freeze({
    id: 'c5_role_overlays',
    name: 'role-prompts',
    description: 'Role-specific organ prompt appends in roles/<role>/prompts/<organ>.md',
    patterns: ['roles/<role>/prompts/<organ>.md'],
  }),
  c6_skill_playbooks: Object.freeze({
    id: 'c6_skill_playbooks',
    name: 'skill-playbooks',
    description: 'Base and role skill playbooks, manifests, and CLI helpers in skills/ and roles/<role>/skills/',
    patterns: [
      'skills/<skill>/SKILL.md',
      'skills/<skill>/skill.json',
      'skills/<skill>/<cmd>.mjs',
      'roles/<role>/skills/<skill>/SKILL.md',
      'roles/<role>/skills/<skill>/skill.json',
      'roles/<role>/skills/<skill>/<cmd>.mjs',
    ],
  }),
  c7_role_manifests: Object.freeze({
    id: 'c7_role_manifests',
    name: 'role-manifests',
    description: 'Role metadata, processes, and responsibilities in roles/<role>/',
    patterns: [
      'roles/<role>/role.json',
      'roles/<role>/processes/<id>.json',
      'roles/<role>/responsibilities.json',
    ],
  }),
  c8_shell_ergonomics: Object.freeze({
    id: 'c8_shell_ergonomics',
    name: 'shell-ergonomics',
    description: 'Non-security shell diagnostic formatting and output ergonomics',
    patterns: ['agent/gateway/shell-exec.mjs'],
  }),
});

/**
 * Classify a repo-relative path (forward slashes) against the Paraclete evolvable surface.
 *
 * @param {string} relPath
 * @param {object} [opts]
 * @param {string} [opts.stage] - optional stage ('stage1' restricts role edits to STAGE1_BUILDER_ROLES)
 * @param {string[]} [opts.allowedRoles] - optional explicit role allowlist
 * @returns {{allowed: boolean, component: string|null, family: string|null, role?: string, reason?: string}}
 */
export function classifySurfacePath(relPath, opts = {}) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm) return { allowed: false, component: null, family: null, reason: 'empty path' };

  for (const prefix of IMMUTABLE_SPINE_PREFIXES) {
    if (norm === prefix || norm.startsWith(prefix)) {
      return {
        allowed: false,
        component: null,
        family: null,
        reason: `path '${norm}' is part of the immutable spine (${prefix})`,
      };
    }
  }

  // c1_contracts: config/contracts.json
  if (norm === 'config/contracts.json') {
    return { allowed: true, component: 'c1_contracts', family: 'c1_contracts' };
  }

  // c2_base_prompts / c3_cerebellum_verifier / c4_memory_consolidation in prompts/*.md
  const mPrompt = /^prompts\/([a-z0-9-]+)\.md$/.exec(norm);
  if (mPrompt) {
    const file = `${mPrompt[1]}.md`;
    if (!BASE_PROMPT_FILES.includes(file)) {
      return {
        allowed: false,
        component: null,
        family: null,
        reason: `prompt '${norm}' is not an allowed base prompt (${BASE_PROMPT_FILES.join(', ')})`,
      };
    }
    if (file === 'cerebellum.md') {
      return { allowed: true, component: 'c3_cerebellum_verifier', family: 'c3_cerebellum_verifier' };
    }
    if (file === 'temporal-memory.md') {
      return { allowed: true, component: 'c4_memory_consolidation', family: 'c4_memory_consolidation' };
    }
    return { allowed: true, component: 'c2_base_prompts', family: 'c2_base_prompts' };
  }

  // c4_memory_consolidation / c6_skill_playbooks in skills/<skill>/(SKILL.md | skill.json | <cmd>.mjs)
  const mSkill = /^skills\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(norm);
  if (mSkill) {
    const [, skillName, file] = mSkill;
    if (file === 'SKILL.md' || file === 'skill.json' || /^[a-z0-9-]+\.mjs$/.test(file)) {
      const comp = skillName === 'memory-consolidate' ? 'c4_memory_consolidation' : 'c6_skill_playbooks';
      return { allowed: true, component: comp, family: comp };
    }
    return { allowed: false, component: null, family: null, reason: `unsupported file '${file}' in base skill directory` };
  }

  // c8_shell_ergonomics
  if (norm === 'agent/gateway/shell-exec.mjs') {
    return { allowed: true, component: 'c8_shell_ergonomics', family: 'c8_shell_ergonomics' };
  }

  // Role-scoped families (c5_role_overlays, c6_skill_playbooks, c7_role_manifests)
  if (norm.startsWith('roles/')) {
    const parts = norm.split('/');
    const role = parts[1];
    if (!role) return { allowed: false, component: null, family: null, reason: 'missing role name' };
    const effectiveAllowedRoles =
      Array.isArray(opts.allowedRoles) && opts.allowedRoles.length > 0
        ? opts.allowedRoles
        : opts.stage === 'stage1' || opts.stage === 'builder'
          ? STAGE1_BUILDER_ROLES
          : null;
    if (effectiveAllowedRoles && !effectiveAllowedRoles.includes(role)) {
      return {
        allowed: false,
        component: null,
        family: null,
        role,
        reason: `role '${role}' is not in the active role allowlist (${effectiveAllowedRoles.join(', ')})`,
      };
    }

    // c5_role_overlays: roles/<role>/prompts/<organ>.md
    const mC5 = /^roles\/([a-z0-9-]+)\/prompts\/([a-z0-9-]+)\.md$/.exec(norm);
    if (mC5) {
      const organ = mC5[2];
      if (!ORGANS_ALLOWLIST.includes(organ)) {
        return {
          allowed: false,
          component: null,
          family: null,
          role,
          reason: `role prompt '${norm}' targets unknown organ '${organ}'`,
        };
      }
      return { allowed: true, component: 'c5_role_overlays', family: 'c5_role_overlays', role };
    }

    // c6_skill_playbooks: roles/<role>/skills/<skill>/(SKILL.md | skill.json | <cmd>.mjs)
    const mC6 = /^roles\/([a-z0-9-]+)\/skills\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(norm);
    if (mC6) {
      const file = mC6[3];
      if (file === 'SKILL.md' || file === 'skill.json' || /^[a-z0-9-]+\.mjs$/.test(file)) {
        return { allowed: true, component: 'c6_skill_playbooks', family: 'c6_skill_playbooks', role };
      }
      return { allowed: false, component: null, family: null, role, reason: `unsupported file '${file}' in role skill directory` };
    }

    // c7_role_manifests: processes, responsibilities, role.json
    if (
      /^roles\/([a-z0-9-]+)\/processes\/([a-z0-9-]+)\.json$/.test(norm) ||
      /^roles\/([a-z0-9-]+)\/responsibilities\.json$/.test(norm) ||
      /^roles\/([a-z0-9-]+)\/role\.json$/.test(norm)
    ) {
      return { allowed: true, component: 'c7_role_manifests', family: 'c7_role_manifests', role };
    }

    return { allowed: false, component: null, family: null, role, reason: `path '${norm}' is not an evolvable role file` };
  }

  return { allowed: false, component: null, family: null, reason: `path '${norm}' is outside the Paraclete evolvable surface (c1..c8)` };
}

/**
 * True when a dot-separated key path in `config/contracts.json` is on the tunable surface.
 *
 * @param {string} dotPath
 * @returns {boolean}
 */
export function isContractKeyTunable(dotPath) {
  return CONTRACTS_TUNABLE_PATHS.includes(String(dotPath || '').trim());
}

/**
 * Returns the role list for a target stage ('stage1' for the builder trio, 'stage2' or 'all' for all roles).
 *
 * @param {'stage1'|'builder'|'stage2'|'all'} [stage='stage1']
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {Function} [opts.listDir]
 * @returns {string[]}
 */
export function rolesForStage(stage = 'stage1', opts = {}) {
  if (stage === 'stage1' || stage === 'builder') return [...STAGE1_BUILDER_ROLES];
  if (opts.repoRoot) {
    const listDir = opts.listDir || ((d) => readdirSync(d, { withFileTypes: true }));
    try {
      const entries = listDir(join(opts.repoRoot, 'roles'));
      const dirs = entries
        .filter((e) => (typeof e === 'string' ? !e.endsWith('.md') : e.isDirectory()))
        .map((e) => (typeof e === 'string' ? e : e.name))
        .filter((name) => !name.startsWith('.'))
        .sort();
      if (dirs.length > 0) return dirs;
    } catch { /* fall back to DEFAULT_ROLES */ }
  }
  return [...DEFAULT_ROLES];
}
