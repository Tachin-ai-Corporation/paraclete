# Harness Release

Verify that a candidate harness mutation satisfies all structural, unit, integration, and Pareto dominance gates before branch promotion or canary deployment.

## Commands

- `harness-promote --action verify [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--trials <n>] [--live] [--real-model] [--max-rollouts <n>] [--max-tokens <n>] [--judge-committee] [--out <path>] [--json]` — run structural validation, baseline-vs-candidate evaluation, and Capability-First promotion gate checks.
- `harness-promote --action report [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--trials <n>] [--live] [--real-model] [--max-rollouts <n>] [--max-tokens <n>] [--vertex] [--judge-committee] [--apply] [--branch <branch>] [--push-pr] [--dry-run] [--out <path>] [--json]` — generate a formatted markdown and JSON promotion report, optionally applying patches and opening a GitHub PR.

- `harness-promote --action release-check [--repo <dir>] [--dry-run] [--json]` — when main's head is newer than the newest release and its CI passed, run the repository's `dev/release-check.mjs --vm-only` against the instance in the checkout's `.local/instance.env` (the lab canary): it moves the canary to main's head, checks its status and a smoke mission, and tags the release only if every check passes. `--dry-run` checks without tagging. Every instance's automatic update installs the newest release, so never tag one another way when the check fails, and never repair the canary by hand to make it pass.

## Workflow

1. **Verify Promotion Gates**: Run `harness-promote --action verify --repo . --stage stage1 --trials 3 --json` to ensure all 5 promotion gates pass (structural validity, unit tests, integration tests, Pareto dominance, and zero capability regressions).
2. **Generate Promotion Report**: Run `harness-promote --action report --repo . --stage stage1 --trials 3 --out <path> --json` to produce the PR body and canary rollout checklist.
3. **Canary Rollout**: Open a pull request with `gh pr create` and roll out verified harness updates to canary agents before broader promotion.

A promotion pull request opens only with measured evidence: the candidate against the current version
on the same tasks, every task run at least 3 times on both sides, a capability gain larger than the
run-to-run noise with no task worse and the held-out tasks no worse, a change a model proposed, and a
passing calibration of the measurement. Only a `--real-model` run is evidence: it sends each side's own
prompts to the model and scores the model suite's checked tasks. The template fallback's fixed edits,
the synthetic dry run, runs the scripted in-process gateway answered (a `--live` run without
`--real-model`), and runs through a `--gateway-url` gateway never qualify. When the evidence falls short,
`--push-pr` opens nothing and its report names each rule that failed; report that, and do not open the
pull request another way.

A `--real-model` run costs model calls. It stops before it passes its cap (`--max-rollouts`, default 120;
`--max-tokens`, default 30,000,000) and reports `spendCapReached`; report that rather than raising the
cap. While `dev/harness2/PAUSED` exists in the checkout, every cycle refuses to start and says why;
report the reason and stop.
