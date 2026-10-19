# Paraclete-H2 (`roles/paraclete-h2`)

`paraclete-h2` is the self-improving harness engineer role for Paraclete. It equips a single harnessed agent with the skills, organ overlays, processes, and recurring responsibilities required to run both **Loop A** (Harness2-inspired evolutionary harness refinement across the four lenses: Context, Sub-Agents, Tools, and Scaffolding) and **Loop B** (target role evaluation, runtime diagnostics, and cross-role benchmark validation).

## Capabilities

- **Loop A Harness Evolution (`harness-evolution` -> `harness-cycle`)**: Diagnoses normalized trajectory ensembles across the four lenses (`context`, `sub_agents`, `tools`, `scaffolding`), validates candidate mutations against deterministic spine boundaries (`dev/harness2/surface.mjs` and `dev/harness2/validate.mjs`), and records candidate lineage in the reusable pattern library.
- **Loop B Benchmark & Failure Harvesting (`harness-benchmark` -> `harness-eval`)**: Evaluates `stage1` (self-hosting `paraclete-h2` and builder tasks) and `stage2` (domain role tasks) benchmark suites, scores capability, reliability, and efficiency, and harvests failed production or canary runs into replayable regression fixtures.
- **Canary & Promotion Gate (`harness-release` -> `harness-promote`)**: Verifies all structural, unit, integration, and Pareto dominance gates before preparing a branch, pull request, or canary release.

## Package Layout

- `roles/paraclete-h2/role.json` — role manifest, IAM bindings, and skill list.
- `roles/paraclete-h2/prompts/` — organ overlays (`cortex.md`, `prefrontal.md`, `motor.md`, `cerebellum.md`, `temporal-memory.md`).
- `roles/paraclete-h2/skills/harness-evolution/` — `harness-cycle` CLI for Loop A diagnosis, validation, and cycle execution.
- `roles/paraclete-h2/skills/harness-benchmark/` — `harness-eval` CLI for Stage 1 and Stage 2 benchmark evaluation and failure harvesting.
- `roles/paraclete-h2/skills/harness-release/` — `harness-promote` CLI for Pareto gate verification and promotion readiness.
- `roles/paraclete-h2/processes/` — reusable processes (`p-harness-evolve.json`, `p-harness-benchmark.json`, `p-harness-promote.json`).
- `roles/paraclete-h2/responsibilities.json` — recurring responsibilities (`r-harness-evolution-cycle`, `r-failure-harvest`).
- `roles/paraclete-h2/memory.md` — initial working memory for the `paraclete-h2` role.
