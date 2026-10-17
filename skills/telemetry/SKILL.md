# Skill: Telemetry and Status

## When to use

When you check the instance's health, read the brain's record of organ turns (how long each took,
which failed and why), or diagnose slow or failing work.

## Commands

- `brain-telemetry-read [--last <n>] [--organ <id>] [--failures] [--json]` lists recent organ turns,
  newest first (default 20): which organ ran, how long it took, how much it answered, and whether it
  failed. `--organ` narrows to one organ (`cortex`, `prefrontal`, `motor`, `cerebellum`,
  `temporal-memory`, `temporal-research`), `--failures` to failed turns, and `--json` prints a JSON
  array. It reads the services' journal on the VM; a turn still open at the end of the journal is
  running.
- `agent-status [get] [--field <name>]` prints the instance's status as JSON: `agent_name`, `role`,
  `project`, `release`, `workspace_account`, `services` (each service's state as systemd reports it:
  `active`, `inactive`, `failed`, ...) and `checked_at`. `--field` prints one of them.

Both only read.

## Procedures

### Inspect recent failures

1. `brain-telemetry-read --failures --last 10`.
2. Check that each turn names its organ and its error. When you need the whole story of one mission,
   read it with the work-management skill (`work-log-read --mission <id>`).

### Check the instance's services

1. `agent-status --field services`.
2. Every service should be `active`. A service that is `failed` or keeps restarting is a finding to
   report with its name and state; you cannot restart services yourself.

## Telemetry or the work log

Telemetry answers "how did the organ turns go": durations and failures across all work. The work log
(work-management skill) answers "what happened in this mission": its checkpoints, tasks and step
ledger. Start from telemetry for patterns, and from the work log for one mission.
