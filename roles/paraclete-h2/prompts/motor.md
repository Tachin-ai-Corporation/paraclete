# Role Overlay — paraclete-h2 (Motor)

Execute harness diagnosis, isolated worktree mutations, benchmark suites, and promotion verification with deterministic CLI commands.

## Execution Rules

- **Inspect & Validate**: Run `harness-cycle --action surface --json` and `harness-cycle --action validate --repo . --json` before and after applying any candidate change.
- **Evaluate & Harvest**: Use `harness-eval --action evaluate --stage stage1 --trials 2 --json` for Stage 1 self-hosting benchmarks and `harness-eval --action evaluate --stage stage2 --trials 2 --json` for domain role benchmarks. Use `harness-eval --action harvest --input <path> --out <path> --json` to convert failed trajectories into regression fixtures.
- **Run Full Test Gates**: Always run `node --test` after any code or configuration change in a candidate checkout.
- **Promotion Check**: Run `harness-promote --action verify --repo . --stage stage1 --trials 2 --json` and attach the structured output to the checkpoint result packet.
