# Harness Evolution

Drive Loop A of the Paraclete-H2 architecture across the four harness lenses (`context`, `sub_agents`, `tools`, and `scaffolding`).

## Commands

- `harness-cycle --action surface [--repo <dir>] [--json]` — inspect the mutable harness surface and immutable spine boundaries in a target checkout.
- `harness-cycle --action validate [--repo <dir>] [--json]` — validate candidate mutations against immutable spine paths, `config/contracts.json` bounds, and role package invariants.
- `harness-cycle --action diagnose [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--trials <n>] [--lens <context|sub_agents|tools|scaffolding>] [--live] [--judge-committee] [--json]` — evaluate trajectories with the Frontier Model Committee and rank four-lens bottlenecks (`context`, `sub_agents`, `tools`, `scaffolding`).
- `harness-cycle --action run [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--iterations <n>] [--candidates <n>] [--trials <n>] [--lens <context|sub_agents|tools|scaffolding>] [--live] [--vertex] [--judge-committee] [--include-harvested] [--expand-curriculum] [--library <path>] [--out <path>] [--json]` — run the outer `diagnose -> propose -> validate -> evaluate -> select -> archive` loop under the Capability-First Credo.
- `harness-cycle --action curriculum [--repo <dir>] [--unit <unit-id>] [--track <organs|engineering_roles|specialist_roles>] [--status] [--state-path <path>] [--live] [--vertex] [--judge-committee] [--apply] [--push-pr] [--out <path>] [--json]` — step through the 24-unit Master Curriculum Playbook (covering all 6 organs, 7 engineering roles, and 11 specialist roles), producing and verifying concrete workspace artifacts with the Frontier Model Committee.
- `harness-cycle --action scaffold-skill --id <skill-id> [--role <role-id>] [--json]` — generate a compliant new skill package (`skill.json`, `SKILL.md`, `<cmd>.mjs`).
- `harness-cycle --action scaffold-role --id <role-id> [--json]` — generate a compliant new specialist role package (`role.json`, `README.md`, `prompts/*.md`, `responsibilities.json`).

## Workflow

1. **Inspect & Validate Surface**: Run `harness-cycle --action validate --repo . --json` before and after any candidate mutation in an isolated git branch or worktree.
2. **Diagnose Bottlenecks**: Run `harness-cycle --action diagnose --stage stage1 --trials 2 --json` to rank bottlenecks across the four lenses before proposing changes.
3. **Single-Lens Mutation Discipline**: Target one primary lens per candidate iteration (`--lens context`, `--lens sub_agents`, `--lens tools`, or `--lens scaffolding`) so Pareto improvements can be cleanly attributed.
4. **Execute Full Loop**: Run `harness-cycle --action run --stage stage1 --iterations 3 --candidates 2 --trials 2 --json` to score candidates, update the pattern library, and emit the winning candidate report.
