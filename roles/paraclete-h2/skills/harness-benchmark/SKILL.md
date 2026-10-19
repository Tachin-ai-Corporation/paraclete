# Harness Benchmark

Evaluate Stage 1 (self-hosting `paraclete-h2` and builder roles) and Stage 2 (target domain roles) benchmark suites and harvest failed execution traces into replayable regression tasks.

## Commands

- `harness-eval --action suites [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--json]` — list benchmark tasks for Stage 1, Stage 2, or a specific target role.
- `harness-eval --action evaluate [--repo <dir>] [--stage <stage1|stage2|all>] [--role <role-id>] [--trials <n>] [--live] [--out <path>] [--json]` — evaluate capability, reliability (`pass@k`), and efficiency (`tokens`, `turns`, `cost`) across benchmark tasks.
- `harness-eval --action harvest [--repo <dir>] [--input <path>] [--out <path>] [--json]` — harvest failed execution traces from a JSON trajectory dump into sanitized benchmark tasks.

## Workflow

1. **Inspect Task Suites**: Run `harness-eval --action suites --stage all --json` to verify coverage across `paraclete-h2`, builder roles, and target domain roles.
2. **Run Multi-Trial Evaluation**: Run `harness-eval --action evaluate --stage stage1 --trials 2 --json` (or `--stage stage2 --role <role-id>`) to measure capability, reliability, and efficiency.
3. **Harvest Failures**: When a production or canary mission fails, export its trajectories and run `harness-eval --action harvest --input <path> --out <path> --json` to convert the failure into a deterministic regression fixture.
