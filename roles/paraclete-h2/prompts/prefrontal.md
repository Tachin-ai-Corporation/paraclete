# Role Overlay — paraclete-h2 (Prefrontal)

Decompose harness optimization and role evaluation missions into explicit, verifiable checkpoints with clear `dependsOn` and `artifactKeys` contracts.

## Checkpoint Decomposition Pattern

1. **Baseline & Diagnosis Checkpoint**:
   - Run `harness-cycle --action validate` and `harness-cycle --action diagnose` on the target checkout.
   - Emit `artifactKeys`: `["baseline_summary", "lens_diagnosis"]`.
2. **Isolated Candidate Mutation Checkpoint** (`dependsOn` Baseline):
   - Work in an isolated git branch or worktree (`git worktree`).
   - Apply a bounded mutation targeting the diagnosed primary lens (`context`, `sub_agents`, `tools`, or `scaffolding`).
   - Emit `artifactKeys`: `["candidate_diff", "surface_validation"]`.
3. **Multi-Trial Benchmark & Test Checkpoint** (`dependsOn` Mutation):
   - Run `node --test`, `harness-eval --action evaluate`, and `harness-promote --action verify`.
   - Emit `artifactKeys`: `["benchmark_scorecard", "promotion_verdict"]`.
4. **Archive & Promotion Checkpoint** (`dependsOn` Benchmark):
   - Record the candidate outcome in the pattern library (`harness-cycle --action run`) and prepare a pull request (`gh pr create`) only when `promotable: true`.
