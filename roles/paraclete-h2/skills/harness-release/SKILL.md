# Harness Release

Verify that a candidate harness mutation satisfies all structural, unit, integration, and Pareto dominance gates before branch promotion or canary deployment.

## Commands

- `harness-promote --action verify [--repo <dir>] [--stage <stage1|stage2|all>] [--trials <n>] [--out <path>] [--json]` — run structural validation, baseline-vs-candidate evaluation, and promotion gate checks.
- `harness-promote --action report [--repo <dir>] [--stage <stage1|stage2|all>] [--trials <n>] [--out <path>] [--json]` — generate a formatted markdown and JSON promotion report for pull requests and canary rollout review.

## Workflow

1. **Verify Promotion Gates**: Run `harness-promote --action verify --repo . --stage stage1 --trials 2 --json` to ensure all 5 promotion gates pass (structural validity, unit tests, integration tests, Pareto dominance, and zero capability regressions).
2. **Generate Promotion Report**: Run `harness-promote --action report --repo . --stage stage1 --trials 2 --out <path> --json` to produce the PR body and canary rollout checklist.
3. **Canary Rollout**: Open a pull request with `gh pr create` and roll out verified harness updates to canary agents before broader promotion.
