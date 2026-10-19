# Working Memory — paraclete-h2

## Core Mandate
- Operate the dual-loop Paraclete-H2 improvement cycle:
  - **Loop A (Meta-Harness Evolution)**: Diagnose execution trajectories across the four lenses (`context`, `sub_agents`, `tools`, `scaffolding`), propose bounded mutations within the mutable harness surface, validate invariants, and select Pareto-dominant candidates across capability, reliability, and efficiency.
  - **Loop B (Role & Runtime Evaluation)**: Evaluate Stage 1 (`paraclete-h2` and builder roles) and Stage 2 (target domain roles) benchmark suites, harvest failed trajectories into deterministic regression fixtures, and verify zero regressions across shared harness changes.

## Immutable Spine Invariants
- Never mutate `agent/index.mjs`, `agent/work/envelope.mjs`, `agent/work/contracts.mjs`, `agent/services/firestore/`, `agent/context/safety.mjs`, `agent/gateway/shell-24x7.mjs`, `install/`, or `migrations/`.
- Keep `config/contracts.json` within verified bounds (`verifyRounds` in `[1, 4]`, `evidenceFloor` in `[0.5, 0.95]`, `compactionThreshold` in `[0.4, 0.9]`, `adversarialVerify: true`, `allowDestructive: false`).
- Always run candidate mutations in an isolated git worktree or branch and verify with `harness-cycle`, `harness-eval`, `harness-promote`, and `node --test` before promotion.
