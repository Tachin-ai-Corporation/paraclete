// dev/harness2/surface.mjs: the evolvable surface of the Paraclete harness (c1..c7), the Stage 1
// builder roles (software-engineer, qa-engineer, devops-engineer) and Stage 2 role catalog, and the
// immutable spine boundaries that no harness candidate may cross. The surface holds prompts, skill
// playbooks, role playbooks and contract tunables only: no executable code (a skill's command `.mjs`)
// and no grants (a role's `role.json`). Pure: no I/O except optional role directory discovery when a
// caller asks for the installed roles on disk.

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
 * The 7 evolvable component families (`c1..c7`) of the Paraclete harness surface.
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
    description: 'Temporal memory prompt and the consolidation skill playbook in prompts/temporal-memory.md and skills/memory-consolidate/',
    patterns: [
      'prompts/temporal-memory.md',
      'skills/memory-consolidate/SKILL.md',
      'skills/memory-consolidate/skill.json',
    ],
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
    description: 'Base and role skill playbooks and manifests in skills/ and roles/<role>/skills/ (never their command code)',
    patterns: [
      'skills/<skill>/SKILL.md',
      'skills/<skill>/skill.json',
      'roles/<role>/skills/<skill>/SKILL.md',
      'roles/<role>/skills/<skill>/skill.json',
    ],
  }),
  c7_role_manifests: Object.freeze({
    id: 'c7_role_manifests',
    name: 'role-manifests',
    description: 'Role README, processes, and responsibilities in roles/<role>/ (never role.json, which holds the role\'s grants)',
    patterns: [
      'roles/<role>/README.md',
      'roles/<role>/processes/<id>.json',
      'roles/<role>/responsibilities.json',
    ],
  }),
});

/** The files of a skill package that the surface holds: its playbook and its manifest. */
const SKILL_PLAYBOOK_FILES = Object.freeze(['SKILL.md', 'skill.json']);

/** Why a skill's command code is outside the surface: it runs on the VM, so a change to it is a code change. */
const SKILL_COMMAND_REFUSAL = 'is a skill command: executable code is outside the mutable surface (a promotion changes a skill\'s SKILL.md and skill.json only)';

/** Why `role.json` is outside the surface: the installer reads the role's grants from it. */
const ROLE_JSON_REFUSAL = 'holds the role\'s grants (gcp_roles, resource_roles, apis), setup and listing, which a promotion never changes; a person commits role.json';

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

  // c4_memory_consolidation / c6_skill_playbooks in skills/<skill>/(SKILL.md | skill.json)
  const mSkill = /^skills\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(norm);
  if (mSkill) {
    const [, skillName, file] = mSkill;
    if (SKILL_PLAYBOOK_FILES.includes(file)) {
      const comp = skillName === 'memory-consolidate' ? 'c4_memory_consolidation' : 'c6_skill_playbooks';
      return { allowed: true, component: comp, family: comp };
    }
    if (file.endsWith('.mjs')) {
      return { allowed: false, component: null, family: null, reason: `'${norm}' ${SKILL_COMMAND_REFUSAL}` };
    }
    return { allowed: false, component: null, family: null, reason: `unsupported file '${file}' in base skill directory` };
  }

  // Role-scoped families (c5_role_overlays, c6_skill_playbooks, c7_role_manifests)
  if (norm.startsWith('roles/')) {
    const parts = norm.split('/');
    const role = parts[1];
    if (!role) return { allowed: false, component: null, family: null, reason: 'missing role name' };
    const effectiveAllowedRoles =
      opts.allowNewRoles === true
        ? null
        : Array.isArray(opts.allowedRoles) && opts.allowedRoles.length > 0
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

    // c6_skill_playbooks: roles/<role>/skills/<skill>/(SKILL.md | skill.json)
    const mC6 = /^roles\/([a-z0-9-]+)\/skills\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(norm);
    if (mC6) {
      const file = mC6[3];
      if (SKILL_PLAYBOOK_FILES.includes(file)) {
        return { allowed: true, component: 'c6_skill_playbooks', family: 'c6_skill_playbooks', role };
      }
      if (file.endsWith('.mjs')) {
        return { allowed: false, component: null, family: null, role, reason: `'${norm}' ${SKILL_COMMAND_REFUSAL}` };
      }
      return { allowed: false, component: null, family: null, role, reason: `unsupported file '${file}' in role skill directory` };
    }

    if (/^roles\/([a-z0-9-]+)\/role\.json$/.test(norm)) {
      return { allowed: false, component: null, family: null, role, reason: `'${norm}' ${ROLE_JSON_REFUSAL}` };
    }

    // c7_role_manifests: processes, responsibilities, README.md
    if (
      /^roles\/([a-z0-9-]+)\/processes\/([a-z0-9-]+)\.json$/.test(norm) ||
      /^roles\/([a-z0-9-]+)\/responsibilities\.json$/.test(norm) ||
      /^roles\/([a-z0-9-]+)\/README\.md$/.test(norm)
    ) {
      return { allowed: true, component: 'c7_role_manifests', family: 'c7_role_manifests', role };
    }

    return { allowed: false, component: null, family: null, role, reason: `path '${norm}' is not an evolvable role file` };
  }

  return { allowed: false, component: null, family: null, reason: `path '${norm}' is outside the Paraclete evolvable surface (c1..c7)` };
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

/**
 * Build a compliant file-patch map (`{ [relPath]: content }`) for a new or updated
 * skill package (either shared in `skills/<skillId>/` or role-scoped in `roles/<role>/skills/<skillId>/`).
 * The command stub it writes is executable code, outside the mutable surface: a person commits it,
 * and a promotion carrying it is refused.
 *
 * @param {object} opts
 * @param {string} opts.skillId       Kebab-case skill ID
 * @param {string} [opts.role]        Optional role ID (omit for shared `skills/<skillId>`)
 * @param {string} [opts.name]        Human-readable skill title
 * @param {string} [opts.whenToUse]   Routing description (>= 20 chars)
 * @param {string[]} [opts.organs]    Organs allowlist (default: `['prefrontal', 'motor', 'cerebellum']`)
 * @param {string} [opts.commandName] Executable CLI command name (kebab-case)
 * @param {string[]} [opts.steps]     Ordered procedure steps for `SKILL.md`
 * @returns {{ baseDir: string, touchedPaths: string[], filePatches: Record<string, string> }}
 */
export function buildSkillScaffold(opts = {}) {
  const skillId = String(opts.skillId || 'custom-skill').trim();
  const role = opts.role ? String(opts.role).trim() : null;
  const baseDir = role ? `roles/${role}/skills/${skillId}` : `skills/${skillId}`;
  const name = opts.name || `Skill ${skillId}`;
  const whenToUse =
    opts.whenToUse && opts.whenToUse.trim().length >= 20
      ? opts.whenToUse.trim()
      : `Executing structured ${skillId} workflows and verifying outputs with deterministic read-back checks.`;
  const organs =
    Array.isArray(opts.organs) && opts.organs.length > 0
      ? opts.organs.filter((o) => ORGANS_ALLOWLIST.includes(o))
      : ['prefrontal', 'motor', 'cerebellum'];
  const commandName = opts.commandName ? String(opts.commandName).trim() : `${skillId}-cli`;
  const steps =
    Array.isArray(opts.steps) && opts.steps.length > 0
      ? opts.steps
      : [
          `Run \`${commandName} --action check --json\` to inspect current workspace state.`,
          `Run \`${commandName} --action execute --json\` and verify the resulting output artifact.`,
        ];

  const skillJson = {
    id: skillId,
    name,
    version: 1,
    when_to_use: whenToUse,
    organs,
    commands: [commandName],
  };

  const skillMd = [
    `# ${name}`,
    '',
    whenToUse,
    '',
    '## Commands',
    '',
    `- \`${commandName} --action <check|execute> [--input <path>] [--out <path>] [--json]\` — run ${name} operations with deterministic JSON output.`,
    '',
    '## Workflow',
    '',
    ...steps.map((s, idx) => `${idx + 1}. ${s}`),
    '',
  ].join('\n');

  const cmdMjs = [
    '#!/usr/bin/env node',
    `// ${baseDir}/${commandName}.mjs: CLI helper for ${name}.`,
    '',
    "import { pathToFileURL } from 'node:url';",
    '',
    `export const USAGE = '${commandName} --action <check|execute> [--input <path>] [--out <path>] [--json]';`,
    '',
    'export async function main(argv = [], deps = {}) {',
    '  const stdout = deps.stdout || process.stdout;',
    '  if (argv.includes("--help") || argv.includes("-h")) {',
    '    stdout.write(`Usage: ${USAGE}\\n`);',
    '    return 0;',
    '  }',
    '  const payload = { ok: true, skill: ' + JSON.stringify(skillId) + ', command: ' + JSON.stringify(commandName) + ', argv };',
    '  stdout.write(`${JSON.stringify(payload, null, 2)}\\n`);',
    '  return 0;',
    '}',
    '',
    'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
    '  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });',
    '}',
    '',
  ].join('\n');

  const filePatches = {
    [`${baseDir}/skill.json`]: `${JSON.stringify(skillJson, null, 2)}\n`,
    [`${baseDir}/SKILL.md`]: skillMd,
    [`${baseDir}/${commandName}.mjs`]: cmdMjs,
  };

  return {
    baseDir,
    touchedPaths: Object.keys(filePatches),
    filePatches,
  };
}

/**
 * Build a compliant file-patch map (`{ [relPath]: content }`) for a complete new role package
 * (`roles/<roleId>/role.json`, `README.md`, `prompts/*.md`, `processes/*.json`, `responsibilities.json`).
 * Its `role.json` holds the role's grants, outside the mutable surface: a person commits it, and a
 * promotion carrying it is refused.
 *
 * @param {object} opts
 * @param {string} opts.roleId
 * @param {string} opts.title
 * @param {string} opts.summary
 * @param {string[]} [opts.skills]
 * @param {string[]} [opts.gcpRoles]
 * @param {Record<string, string>} [opts.prompts]
 * @returns {{ roleDir: string, touchedPaths: string[], filePatches: Record<string, string> }}
 */
export function buildRoleScaffold(opts = {}) {
  const roleId = String(opts.roleId || 'specialist-role').trim();
  const title = opts.title || `Paraclete ${roleId}`;
  const summary =
    opts.summary ||
    `Specialist Paraclete role (${title}) evolved by the Paraclete-H2 autonomous harness loop with domain verification and grounded execution.`;
  const roleDir = `roles/${roleId}`;

  const roleJson = {
    id: roleId,
    title,
    summary,
    version: 1,
    workspace: false,
    skills: Array.isArray(opts.skills) ? opts.skills : [],
    gcp_roles: Array.isArray(opts.gcpRoles) ? opts.gcpRoles : ['roles/logging.viewer'],
    setup: {
      apt: [],
      pip: [],
      npm: [],
    },
  };

  const readmeMd = [
    `# roles/${roleId}/`,
    '',
    `${title} — ${summary}`,
    '',
  ].join('\n');

  const defaultPrompts = {
    cortex: `# ${title} — Cortex Overlay\n\nDecompose missions into verifiable domain checkpoints with explicit read-back artifacts.\n`,
    prefrontal: `# ${title} — Prefrontal Overlay\n\nPlan concrete tool steps and verification probes before mutating state.\n`,
    motor: `# ${title} — Motor Overlay\n\nExecute grounded commands, inspect real outputs, and record verified resource identifiers.\n`,
    cerebellum: `# ${title} — Cerebellum Overlay\n\nVerify every checkpoint claim against tool read-back evidence before marking done.\n`,
    'temporal-memory': `# ${title} — Temporal Memory Overlay\n\nRetain durable domain patterns and verified resource identifiers.\n`,
    'temporal-research': `# ${title} — Temporal Research Overlay\n\nGather primary documentation and ground every synthesis claim in cited sources.\n`,
    ...(opts.prompts || {}),
  };

  const filePatches = {
    [`${roleDir}/role.json`]: `${JSON.stringify(roleJson, null, 2)}\n`,
    [`${roleDir}/README.md`]: readmeMd,
    [`${roleDir}/responsibilities.json`]: `${JSON.stringify({ version: 1, responsibilities: [] }, null, 2)}\n`,
  };

  for (const organ of ORGANS_ALLOWLIST) {
    if (defaultPrompts[organ]) {
      filePatches[`${roleDir}/prompts/${organ}.md`] = defaultPrompts[organ];
    }
  }

  return {
    roleDir,
    touchedPaths: Object.keys(filePatches),
    filePatches,
  };
}
